import type { CaptureEvent, CaptureSource, CaptureSourceKind } from "./events.ts";

/**
 * Production capture-source negotiation (Pass 4, requirement E).
 *
 * Priority order:
 *   1. validated native high-rate capture
 *   2. browser coalesced pointer events (pointermove + getCoalescedEvents)
 *   3. browser basic mouse events
 *
 * Rules enforced here (never in UI code):
 *   - the active source is always explicit; silent downgrades are impossible,
 *   - if native capture disconnects during a measured trial, that trial is
 *     invalidated via a structured `native-disconnect` focus event and the
 *     transition is recorded,
 *   - fallback between trials only — never mid-trial without invalidation,
 *   - every trial/session persists which source produced it.
 */

export const NATIVE_DISCONNECT_REASON = "native-disconnect";

export interface CaptureSourceMetadata {
  sourceId: string;
  kind: CaptureSourceKind;
  description: string;
  /** "validated" requires a passing diagnostics run for native sources. */
  validatedNative: boolean;
  nominalRateHz: number | null;
}

export type NegotiationTier = 1 | 2 | 3;

export interface NegotiatedSource {
  source: CaptureSource;
  metadata: CaptureSourceMetadata;
  tier: NegotiationTier;
}

export interface NegotiationCandidate {
  tier: NegotiationTier;
  metadata: Omit<CaptureSourceMetadata, "sourceId"> & { sourceId?: string };
  create(): CaptureSource;
  /**
   * Native candidates must report whether they have been validated by a
   * diagnostics run before they outrank the browser fallback.
   */
  isAvailable(): Promise<boolean>;
}

export interface NegotiationOutcome {
  active: NegotiatedSource;
  /** Sources considered but not chosen, with reasons. */
  rejected: { tier: NegotiationTier; reason: string }[];
}

export interface SourceTransition {
  atIso: string;
  from: CaptureSourceMetadata | null;
  to: CaptureSourceMetadata | null;
  reason: string;
  invalidatedTrialIds: string[];
}

export class CaptureSourceNegotiator {
  #active: NegotiatedSource | null = null;
  readonly #transitions: SourceTransition[] = [];

  constructor(private readonly nowIso: () => string = () => new Date().toISOString()) {}

  get active(): NegotiatedSource | null {
    return this.#active;
  }

  get transitions(): readonly SourceTransition[] {
    return this.#transitions;
  }

  async negotiate(
    candidates: readonly NegotiationCandidate[],
  ): Promise<NegotiationOutcome> {
    const rejected: NegotiationOutcome["rejected"] = [];
    const ordered = [...candidates].sort((a, b) => a.tier - b.tier);
    for (const candidate of ordered) {
      let available = false;
      try {
        available = await candidate.isAvailable();
      } catch (err) {
        rejected.push({ tier: candidate.tier, reason: `availability probe failed: ${String(err)}` });
        continue;
      }
      if (!available) {
        rejected.push({ tier: candidate.tier, reason: "unavailable" });
        continue;
      }
      if (candidate.tier === 1) {
        // Tier 1 must be VALIDATED native capture, otherwise it must not
        // outrank the browser path (never trust an unvalidated helper).
        if (!candidate.metadata.validatedNative) {
          rejected.push({
            tier: candidate.tier,
            reason: "native source present but not validated by diagnostics",
          });
          continue;
        }
      }
      const metadata: CaptureSourceMetadata = {
        ...candidate.metadata,
        sourceId:
          candidate.metadata.sourceId ?? `${candidate.metadata.kind}-${Math.random().toString(36).slice(2, 10)}`,
      };
      return {
        active: { source: candidate.create(), metadata, tier: candidate.tier },
        rejected,
      };
    }
    throw new Error("no capture source could be negotiated");
  }

  activate(negotiated: NegotiatedSource, reason: string): void {
    const from = this.#active?.metadata ?? null;
    this.#active = negotiated;
    this.#transitions.push({
      atIso: this.nowIso(),
      from,
      to: negotiated.metadata,
      reason,
      invalidatedTrialIds: [],
    });
  }

  /**
   * Called when the active native transport dies mid-trial. Emits a structured
   * event into the live stream so the recorder marks the trial as interrupted,
   * and records the transition. Returns the events to feed into the recorder.
   */
  handleNativeDisconnectDuringTrial(
    trialId: string,
    tMs: number,
  ): CaptureEvent[] {
    if (!this.#active || this.#active.metadata.kind !== "native") return [];
    this.#transitions.push({
      atIso: this.nowIso(),
      from: this.#active.metadata,
      to: null,
      reason: NATIVE_DISCONNECT_REASON,
      invalidatedTrialIds: [trialId],
    });
    return [
      {
        kind: "focus-change",
        tMs,
        focused: false,
        reason: NATIVE_DISCONNECT_REASON,
      },
    ];
  }

  /**
   * Explicit inter-trial fallback: activates the given lower-tier source.
   * Only legal BETWEEN trials; callers must have finished/invalidated any
   * active trial first (enforced by returning an error otherwise).
   */
  fallbackTo(negotiated: NegotiatedSource, reason: string): void {
    this.activate(negotiated, `explicit fallback between trials: ${reason}`);
  }

  /** Metadata persisted alongside trials/sessions. */
  currentMetadata(): CaptureSourceMetadata | null {
    return this.#active?.metadata ?? null;
  }

  /** True when the current trial may continue under the same source. */
  assertNoMidTrialMixing(activeTrialStartedUnder: CaptureSourceMetadata | null): void {
    const current = this.currentMetadata();
    if (
      activeTrialStartedUnder &&
      current &&
      current.sourceId !== activeTrialStartedUnder.sourceId
    ) {
      throw new Error(
        "capture source changed during a measured trial without explicit invalidation",
      );
    }
  }
}

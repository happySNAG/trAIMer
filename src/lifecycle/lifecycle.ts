/**
 * App lifecycle hardening (Pass 5, requirement N).
 *
 * Covers: PC sleep/wake time jumps, duplicate Aim Lab instances, orphan or
 * duplicate native helpers, display changes, and mouse disconnect/reconnect
 * semantics. Every rule exists so lifecycle transitions cannot silently
 * corrupt an experiment: they either abort the active trial loudly (which the
 * existing validation/fatigue machinery already handles) or are surfaced as
 * explicit status for the UI.
 */

export const MAX_SANE_MONOTONIC_JUMP_MS = 2_000;

/**
 * Sleep/wake detection: `performance.now()` is monotonic per page but may
 * pause during OS sleep on some platforms, so a resume can appear as a large
 * forward jump. A jump larger than MAX_SANE_MONOTONIC_JUMP_MS while a trial
 * is active MUST invalidate that trial (huge sample gap / impossible timing).
 */
export interface TimeJumpAssessment {
  jumped: boolean;
  jumpMs: number;
}

export function assessTimeJump(
  previousNowMs: number,
  currentNowMs: number,
  maxJumpMs: number = MAX_SANE_MONOTONIC_JUMP_MS,
): TimeJumpAssessment {
  const jumpMs = currentNowMs - previousNowMs;
  return { jumped: jumpMs > maxJumpMs || jumpMs < -maxJumpMs, jumpMs };
}

/**
 * Duplicate-instance guard over BroadcastChannel. Each app instance announces
 * itself and answers others' announcements; seeing a peer means two instances
 * share one IndexedDB origin — experiments could interleave writes.
 * Graceful no-op where BroadcastChannel is unavailable (very old browsers).
 */
export class InstanceGuard {
  readonly #channel: BroadcastChannel | null;
  #peerSeen = false;
  readonly #peers = new Set<string>();

  constructor(
    readonly instanceId: string,
    channelName: string = "traimer-instances",
  ) {
    this.#channel =
      typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;
    this.#channel?.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data as { from?: string } | null;
      if (data && typeof data.from === "string" && data.from !== this.instanceId) {
        const isNewPeer = !this.#peers.has(data.from);
        this.#peers.add(data.from);
        this.#peerSeen = true;
        // Answer exactly ONCE per new peer so the other side learns about us.
        // Replying unconditionally would make two guards ping-pong forever.
        if (isNewPeer) {
          this.#channel?.postMessage({ from: this.instanceId });
        }
      }
    });
    this.announce();
  }

  announce(): void {
    this.#channel?.postMessage({ from: this.instanceId });
  }

  get duplicateInstanceDetected(): boolean {
    return this.#peerSeen;
  }

  /** Stable ids of peers observed this session (diagnostics only). */
  peerIds(): string[] {
    return [...this.#peers].sort();
  }

  dispose(): void {
    this.#channel?.close();
  }
}

/**
 * Native-helper lifecycle policy, expressed as data for UI/docs consumption:
 * the DESKTOP LAUNCHER owns helper start/stop; the browser app never starts
 * or kills processes. An "orphan" helper (app closed, helper resident) is
 * harmless by design: it serves loopback only and exits when the launcher's
 * stop routine runs or the machine shuts down. A DUPLICATE helper fails to
 * bind the port and exits immediately; the running one keeps serving.
 */
export interface LifecyclePolicyStep {
  event: string;
  appAction: string;
  rationale: string;
}

export const LIFECYCLE_POLICY: readonly LifecyclePolicyStep[] = [
  {
    event: "app startup",
    appAction:
      "run preflight; detect duplicate instances via InstanceGuard; list unfinished checkpoints",
    rationale: "a broken environment must be visible before any experiment",
  },
  {
    event: "native helper present at preflight",
    appAction: "probe handshake, then run capture self-test before trusting tier-1",
    rationale: "unvalidated helpers never outrank browser capture",
  },
  {
    event: "helper disconnect mid-trial",
    appAction:
      "emit structured native-disconnect focus event → trial invalidated; fallback negotiated between trials only",
    rationale: "no silent downgrades, no mid-trial source mixing",
  },
  {
    event: "PC sleep/wake during trial",
    appAction:
      "assessTimeJump on visibilitychange; jump > 2 s invalidates the active trial exactly like lock loss",
    rationale: "timestamps across sleep are not trustworthy measurement data",
  },
  {
    event: "display change / resize",
    appAction:
      "resize events carry dimensions; area change >10 % mid-trial flags RESIZE_DURING_TRIAL",
    rationale: "geometry-dependent metrics need a stable viewport",
  },
  {
    event: "mouse disconnect/reconnect",
    appAction:
      "device arrival/removal lifecycle events stream through; reconnect resets sequence epoch after welcome",
    rationale: "drop accounting stays honest across device swaps",
  },
  {
    event: "DPI/profile change between sessions",
    appAction: "calibration staleness fingerprint flags DPI/device/settings changes",
    rationale: "old physical units must not silently apply to new hardware context",
  },
  {
    event: "app close",
    appAction:
      "runner cancel/persist path writes final checkpoint state; launcher stop routine terminates the helper",
    rationale: "checkpoint-before-trial guarantees at most one ambiguous trial",
  },
];

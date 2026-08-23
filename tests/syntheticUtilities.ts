import type { TrialRecord } from "../src/domain/trial.ts";

/**
 * Deterministic synthetic-utility trial builder used by statistics tests.
 * Each trial carries its intended utility in `seedTag` so an injected
 * `utilityOf` function can read it back exactly — no physics scoring noise.
 */
export interface SyntheticTrialSpec {
  candidateId: string;
  scenarioId: string;
  repIndex: number;
  indexInSession: number;
  utility: number;
  validity?: "valid" | "invalid" | "suspect";
}

export function buildUtilityTrials(
  specs: readonly SyntheticTrialSpec[],
): Map<string, TrialRecord[]> {
  const out = new Map<string, TrialRecord[]>();
  for (const spec of specs) {
    const list = out.get(spec.candidateId) ?? [];
    list.push({
      id: `trial-${spec.candidateId}-${spec.scenarioId}-${spec.repIndex}` as never,
      sessionId: "session-syn" as never,
      experimentId: null,
      candidateId: spec.candidateId as never,
      indexInSession: spec.indexInSession,
      phase: "measured",
      scenarioId: spec.scenarioId,
      scenarioKind: "flick-static",
      captureContext: {
        scenarioKind: "flick-static",
        viewport: { widthPx: 1280, heightPx: 720 },
        sensitivity: { sensX: 7, sensY: 7 },
        dpi: 800,
        expectedSampleIntervalMs: null,
      },
      startedAtMonotonicMs: 0,
      endedAtMonotonicMs: 1000,
      samples: [],
      targets: [],
      shots: [],
      focusInterruptions: [],
      viewportResizes: [],
      outcome: "hit",
      validity: { status: spec.validity ?? "valid", reasons: [] },
      seedTag: `u:${spec.utility}`,
      scenarioRepIndex: spec.repIndex,
      abortedMs: null,
    } as unknown as TrialRecord);
    out.set(spec.candidateId, list);
  }
  return out;
}

/** Reads the injected utility from seedTag (see buildUtilityTrials). */
export function utilityFromSeedTag(trial: TrialRecord): number | null {
  if (!trial.seedTag?.startsWith("u:")) return null;
  const v = Number(trial.seedTag.slice(2));
  return Number.isFinite(v) ? v : null;
}

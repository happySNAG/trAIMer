import type { PersistedKind } from "../domain/schema.ts";
import { SCHEMA_VERSION } from "../domain/schema.ts";
import { unwrapEnvelope, wrapEnvelope } from "./migrations.ts";
import type { LocalJsonStore } from "./store.ts";
import { sha256Hex, stableStringify } from "./backup.ts";

export interface BundleIntegrity {
  algorithm: "sha256";
  checksumHex: string;
}

export interface SessionBundle {
  schemaVersion: number;
  kind: "session-bundle";
  exportedAtIso: string;
  integrity?: BundleIntegrity;
  payload: {
    experimentDefinition: unknown;
    session: unknown | null;
    trials: unknown[];
    recommendation: unknown | null;
    humanSession?: unknown | null;
    auditTrail?: unknown[] | null;
    inputQualityByTrialId?: Record<string, unknown> | null;
    reliabilitySummary?: unknown | null;
    optimizerMetadata?: unknown | null;
  };
}

export async function exportExperimentBundle(
  store: LocalJsonStore,
  experimentId: string,
): Promise<SessionBundle> {
  const definition = await store.loadExperiment(experimentId);
  if (!definition) throw new Error(`experiment ${experimentId} not found`);
  const trials = await store.loadAllTrials(experimentId);
  const recommendation = await store.loadRecommendation(experimentId);
  const payload: SessionBundle["payload"] = {
    experimentDefinition: definition,
    session: null,
    trials,
    recommendation,
    humanSession: null,
    auditTrail: null,
    inputQualityByTrialId: null,
    reliabilitySummary: null,
    optimizerMetadata: null,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "session-bundle",
    exportedAtIso: new Date().toISOString(),
    integrity: {
      algorithm: "sha256",
      checksumHex: await sha256Hex(stableStringify(payload)),
    },
    payload,
  };
}

export interface ImportResult {
  experimentId: string;
  trialsImported: number;
  recommendationImported: boolean;
}

export async function importExperimentBundle(
  store: LocalJsonStore,
  bundle: unknown,
): Promise<ImportResult> {
  const b = bundle as Partial<SessionBundle> | null;
  if (
    !b ||
    b.kind !== "session-bundle" ||
    typeof b.schemaVersion !== "number" ||
    !Number.isSafeInteger(b.schemaVersion) ||
    b.schemaVersion < 0 ||
    !b.payload ||
    typeof b.payload !== "object"
  ) {
    throw new Error("invalid session bundle envelope");
  }
  if (b.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `bundle schemaVersion ${b.schemaVersion} is newer than supported ${SCHEMA_VERSION}`,
    );
  }
  if (b.integrity) {
    const actual = await sha256Hex(stableStringify(b.payload));
    if (actual !== b.integrity.checksumHex) {
      throw new Error("bundle integrity checksum mismatch — file is corrupted");
    }
  }
  const definition = b.payload.experimentDefinition as { id?: string } | undefined;
  if (!definition || typeof definition.id !== "string") {
    throw new Error("bundle missing experiment definition");
  }
  const experimentId = definition.id;

  // ---- FULL validation pass BEFORE any mutation (zero partial state) ----
  unwrapOrThrow("experiment-definition", b.payload.experimentDefinition);
  for (const trial of (b.payload.trials ?? []) as unknown[]) {
    unwrapOrThrow("trial-record", trial);
    const t = trial as { id?: string };
    if (!t.id) throw new Error("bundle trial missing id");
    void t;
  }
  if (b.payload.recommendation != null) unwrapOrThrow("recommendation", b.payload.recommendation);
  if (b.payload.humanSession != null) unwrapOrThrow("human-session", b.payload.humanSession);

  // ---- mutation pass ----
  await store.saveExperiment(b.payload.experimentDefinition as never);

  let trialsImported = 0;
  for (const trial of (b.payload.trials ?? []) as unknown[]) {
    await store.saveTrial(experimentId, trial as never);
    trialsImported++;
  }

  let recommendationImported = false;
  if (b.payload.recommendation != null) {
    await store.saveRecommendation(b.payload.recommendation as never);
    recommendationImported = true;
  }
  if (b.payload.humanSession != null) {
    const hs = b.payload.humanSession as { sessionId?: string };
    if (hs.sessionId) {
      await store.saveRaw("human-session", `human-sessions/${hs.sessionId}.json`, b.payload.humanSession);
    }
  }

  return { experimentId, trialsImported, recommendationImported };
}

function unwrapOrThrow(kind: PersistedKind, payload: unknown): void {
  const probe = wrapEnvelope(kind, payload, "1970-01-01T00:00:00.000Z");
  unwrapEnvelope(kind, probe);
}

export interface CompactAnalysisSummary {
  bundleKind: "session-bundle";
  experimentId: string | null;
  exportedAtIso: string;
  session: {
    startedAtIso: string | null;
    durationMin: number | null;
    measuredTrials: number;
    invalidTrials: number;
    scenarioOrder: string[] | null;
  } | null;
  recommendation: {
    recommendedEdpi: number | null;
    confidence: number | null;
    confidenceBasis: string | null;
    rangeEdpi: [number, number] | null;
    unresolvedBoundary: boolean | null;
    furtherTestingSuggested: boolean | null;
  } | null;
  inputQualityWorstScore: number | null;
  adaptationDetected: boolean | null;
  retestOfExperimentId: string | null;
}

export function compactAnalysisSummary(bundle: SessionBundle): CompactAnalysisSummary {
  const rec = bundle.payload.recommendation as
    | {
        recommendedEdpi: number;
        confidence: number;
        confidenceCalibration?: { basis: string };
        edpiRange: { min: number; max: number };
        unresolvedBoundary: boolean;
        furtherTestingSuggested: boolean;
        adaptationEffects?: { anySignificantImprovement: boolean };
      }
    | null
    | undefined;
  const hs = bundle.payload.humanSession as
    | {
        startedAtIso: string;
        endedAtIso: string | null;
        wallClockMs: number;
        measuredCount: number;
        scenarioOrder: string[];
        retestOfExperimentId: string | null;
      }
    | null
    | undefined;
  const trials = (bundle.payload.trials ?? []) as { validity?: { status?: string } }[];
  const invalidTrials = trials.filter((t) => t.validity?.status !== "valid").length;
  const iqScores = Object.values(
    (bundle.payload.inputQualityByTrialId ?? {}) as Record<string, { score?: number }>,
  )
    .map((r) => r.score)
    .filter((s): s is number => typeof s === "number");

  return {
    bundleKind: "session-bundle",
    experimentId:
      (bundle.payload.experimentDefinition as { id?: string } | undefined)?.id ?? null,
    exportedAtIso: bundle.exportedAtIso,
    session: hs
      ? {
          startedAtIso: hs.startedAtIso,
          durationMin:
            hs.wallClockMs > 0 ? Math.round(hs.wallClockMs / 600) / 100 : null,
          measuredTrials: hs.measuredCount,
          invalidTrials,
          scenarioOrder: hs.scenarioOrder ?? null,
        }
      : null,
    recommendation: rec
      ? {
          recommendedEdpi: rec.recommendedEdpi ?? null,
          confidence: rec.confidence ?? null,
          confidenceBasis: rec.confidenceCalibration?.basis ?? null,
          rangeEdpi: [rec.edpiRange.min, rec.edpiRange.max],
          unresolvedBoundary: rec.unresolvedBoundary ?? null,
          furtherTestingSuggested: rec.furtherTestingSuggested ?? null,
        }
      : null,
    inputQualityWorstScore:
      iqScores.length > 0 ? Math.min(...iqScores) : null,
    adaptationDetected: rec?.adaptationEffects?.anySignificantImprovement ?? null,
    retestOfExperimentId: hs?.retestOfExperimentId ?? null,
  };
}

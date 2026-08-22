import type { PersistedKind } from "../domain/schema.ts";
import { SCHEMA_VERSION } from "../domain/schema.ts";
import { unwrapEnvelope, wrapEnvelope } from "./migrations.ts";
import type { LocalJsonStore } from "./store.ts";

export interface SessionBundle {
  schemaVersion: number;
  kind: "session-bundle";
  exportedAtIso: string;
  payload: {
    experimentDefinition: unknown;
    session: unknown | null;
    trials: unknown[];
    recommendation: unknown | null;
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
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "session-bundle",
    exportedAtIso: new Date().toISOString(),
    payload: {
      experimentDefinition: definition,
      session: null,
      trials,
      recommendation,
    },
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
  const definition = b.payload.experimentDefinition as { id?: string } | undefined;
  if (!definition || typeof definition.id !== "string") {
    throw new Error("bundle missing experiment definition");
  }
  const experimentId = definition.id;

  unwrapOrThrow("experiment-definition", b.payload.experimentDefinition);
  await store.saveExperiment(b.payload.experimentDefinition as never);

  let trialsImported = 0;
  for (const trial of (b.payload.trials ?? []) as unknown[]) {
    unwrapOrThrow("trial-record", trial);
    const t = trial as { id?: string };
    if (!t.id) throw new Error("bundle trial missing id");
    await store.saveTrial(experimentId, trial as never);
    trialsImported++;
  }

  let recommendationImported = false;
  if (b.payload.recommendation != null) {
    unwrapOrThrow("recommendation", b.payload.recommendation);
    await store.saveRecommendation(b.payload.recommendation as never);
    recommendationImported = true;
  }

  return { experimentId, trialsImported, recommendationImported };
}

function unwrapOrThrow(kind: PersistedKind, payload: unknown): void {
  const probe = wrapEnvelope(kind, payload, "1970-01-01T00:00:00.000Z");
  unwrapEnvelope(kind, probe);
}

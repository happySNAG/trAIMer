import type {
  AimSession,
  ExperimentDefinition,
} from "../domain/experiment.ts";
import { SCHEMA_VERSION, type PersistedKind } from "../domain/schema.ts";
import type { PlayerProfile } from "../domain/player.ts";
import type { Recommendation } from "../domain/recommendation.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { unwrapEnvelope, wrapEnvelope } from "./migrations.ts";
import type { StoreBackend } from "./backends.ts";

export const OPTIMIZER_VERSION = "optimizer-v2";

export interface OptimizerRunMetadata {
  experimentId: string;
  optimizerVersion: string;
  schemaVersion: number;
  utilityWeights: Record<string, number>;
  config: Record<string, unknown>;
}

function safeFileSegment(segment: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
    throw new Error(`unsafe path segment: ${segment}`);
  }
  return segment;
}

export class LocalJsonStore {
  readonly #backend: StoreBackend;

  constructor(backend: StoreBackend) {
    this.#backend = backend;
  }

  async saveRaw(kind: PersistedKind, relPath: string, payload: unknown): Promise<void> {
    const envelope = wrapEnvelope(kind, payload, new Date().toISOString());
    await this.#backend.writeFile(relPath, JSON.stringify(envelope, null, 2));
  }

  /** Lists full relative paths of JSON artifacts stored under a directory. */
  async listByPrefix(dir: string): Promise<string[]> {
    const files = await this.#backend.listFiles(dir);
    return files.map((f) => joinPath(dir, f)).sort();
  }

  async loadRawAt<T>(
    kind: PersistedKind,
    relPath: string,
  ): Promise<{ payload: T; migratedFrom: number | null } | null> {
    return this.loadRaw<T>(kind, relPath);
  }

  async loadRaw<T>(
    kind: PersistedKind,
    relPath: string,
  ): Promise<{ payload: T; migratedFrom: number | null } | null> {
    const raw = await this.#backend.readFile(relPath);
    if (raw === null) return null;
    return unwrapEnvelope<T>(kind, JSON.parse(raw));
  }

  saveProfile(profile: PlayerProfile): Promise<void> {
    return this.saveRaw("player-profile", joinPath("profiles", safeFileSegment(profile.id) + ".json"), profile);
  }

  loadProfile(id: string): Promise<PlayerProfile | null> {
    return this.loadRaw<PlayerProfile>("player-profile", joinPath("profiles", safeFileSegment(id) + ".json")).then((r) => r?.payload ?? null);
  }

  saveSession(session: AimSession): Promise<void> {
    return this.saveRaw("aim-session", joinPath("sessions", safeFileSegment(session.id) + ".json"), session);
  }

  loadSession(id: string): Promise<AimSession | null> {
    return this.loadRaw<AimSession>("aim-session", joinPath("sessions", safeFileSegment(id) + ".json")).then((r) => r?.payload ?? null);
  }

  async listSessionIds(): Promise<string[]> {
    const files = await this.#backend.listFiles(joinPath("sessions"));
    return files.map((f) => f.slice(0, -".json".length));
  }

  saveExperiment(definition: ExperimentDefinition): Promise<void> {
    return this.saveRaw("experiment-definition", joinPath("experiments", safeFileSegment(definition.id) + ".json"), definition);
  }

  loadExperiment(id: string): Promise<ExperimentDefinition | null> {
    return this.loadRaw<ExperimentDefinition>("experiment-definition", joinPath("experiments", safeFileSegment(id) + ".json")).then((r) => r?.payload ?? null);
  }

  saveTrial(experimentId: string, trial: TrialRecord): Promise<void> {
    return this.saveRaw(
      "trial-record",
      joinPath("trials", safeFileSegment(experimentId), safeFileSegment(trial.id) + ".json"),
      trial,
    );
  }

  async listTrialIds(experimentId: string): Promise<string[]> {
    const files = await this.#backend.listFiles(
      joinPath("trials", safeFileSegment(experimentId)),
    );
    return files.map((f) => f.slice(0, -".json".length));
  }

  loadTrial(experimentId: string, trialId: string): Promise<TrialRecord | null> {
    return this.loadRaw<TrialRecord>(
      "trial-record",
      joinPath("trials", safeFileSegment(experimentId), safeFileSegment(trialId) + ".json"),
    ).then((r) => r?.payload ?? null);
  }

  loadAllTrials(experimentId: string): Promise<TrialRecord[]> {
    return this.listTrialIds(experimentId).then((ids) =>
      Promise.all(ids.map((id) => this.loadTrial(experimentId, id))).then((list) =>
        list.filter((t): t is TrialRecord => t !== null),
      ),
    );
  }

  saveRecommendation(recommendation: Recommendation): Promise<void> {
    return this.saveRaw(
      "recommendation",
      joinPath("recommendations", safeFileSegment(recommendation.experimentId) + ".json"),
      recommendation,
    );
  }

  loadRecommendation(experimentId: string): Promise<Recommendation | null> {
    return this.loadRaw<Recommendation>(
      "recommendation",
      joinPath("recommendations", safeFileSegment(experimentId) + ".json"),
    ).then((r) => r?.payload ?? null);
  }

  async saveOptimizerRun(meta: OptimizerRunMetadata): Promise<void> {
    await this.saveRaw(
      "optimizer-run",
      joinPath("optimizer-runs", safeFileSegment(meta.experimentId) + ".json"),
      meta,
    );
  }

  static currentSchemaVersion(): number {
    return SCHEMA_VERSION;
  }
}

function joinPath(...segments: string[]): string {
  let out = segments[0]!;
  for (let i = 1; i < segments.length; i++) out = `${out}/${segments[i]!}`;
  return out;
}

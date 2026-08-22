import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AimSession,
  ExperimentDefinition,
} from "../domain/experiment.ts";
import { SCHEMA_VERSION, type PersistedKind } from "../domain/schema.ts";
import type { PlayerProfile } from "../domain/player.ts";
import type { Recommendation } from "../domain/recommendation.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { unwrapEnvelope, wrapEnvelope } from "./migrations.ts";

export const OPTIMIZER_VERSION = "optimizer-v1";

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
  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  async #ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  async #writeJson(path: string, data: unknown): Promise<void> {
    await this.#ensureDir(join(this.#rootDir, path, ".."));
    await writeFile(
      join(this.#rootDir, path),
      JSON.stringify(data, null, 2),
      "utf8",
    );
  }

  async #readJson<T>(path: string): Promise<T | null> {
    try {
      const text = await readFile(join(this.#rootDir, path), "utf8");
      return JSON.parse(text) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async saveRaw(kind: PersistedKind, relPath: string, payload: unknown): Promise<void> {
    const envelope = wrapEnvelope(kind, payload, new Date().toISOString());
    await this.#writeJson(relPath, envelope);
  }

  async loadRaw<T>(
    kind: PersistedKind,
    relPath: string,
  ): Promise<{ payload: T; migratedFrom: number | null } | null> {
    const raw = await this.#readJson<unknown>(relPath);
    if (raw === null) return null;
    return unwrapEnvelope<T>(kind, raw);
  }

  saveProfile(profile: PlayerProfile): Promise<void> {
    return this.saveRaw("player-profile", join("profiles", safeFileSegment(profile.id) + ".json"), profile);
  }

  loadProfile(id: string): Promise<PlayerProfile | null> {
    return this.loadRaw<PlayerProfile>("player-profile", join("profiles", safeFileSegment(id) + ".json")).then((r) => r?.payload ?? null);
  }

  saveSession(session: AimSession): Promise<void> {
    return this.saveRaw("aim-session", join("sessions", safeFileSegment(session.id) + ".json"), session);
  }

  loadSession(id: string): Promise<AimSession | null> {
    return this.loadRaw<AimSession>("aim-session", join("sessions", safeFileSegment(id) + ".json")).then((r) => r?.payload ?? null);
  }

  saveExperiment(definition: ExperimentDefinition): Promise<void> {
    return this.saveRaw("experiment-definition", join("experiments", safeFileSegment(definition.id) + ".json"), definition);
  }

  loadExperiment(id: string): Promise<ExperimentDefinition | null> {
    return this.loadRaw<ExperimentDefinition>("experiment-definition", join("experiments", safeFileSegment(id) + ".json")).then((r) => r?.payload ?? null);
  }

  saveTrial(experimentId: string, trial: TrialRecord): Promise<void> {
    return this.saveRaw(
      "trial-record",
      join("trials", safeFileSegment(experimentId), safeFileSegment(trial.id) + ".json"),
      trial,
    );
  }

  async listTrialIds(experimentId: string): Promise<string[]> {
    const dir = join(this.#rootDir, "trials", safeFileSegment(experimentId));
    try {
      const files = await readdir(dir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  loadTrial(experimentId: string, trialId: string): Promise<TrialRecord | null> {
    return this.loadRaw<TrialRecord>(
      "trial-record",
      join("trials", safeFileSegment(experimentId), safeFileSegment(trialId) + ".json"),
    ).then((r) => r?.payload ?? null);
  }

  saveRecommendation(recommendation: Recommendation): Promise<void> {
    return this.saveRaw(
      "recommendation",
      join("recommendations", safeFileSegment(recommendation.experimentId) + ".json"),
      recommendation,
    );
  }

  loadRecommendation(experimentId: string): Promise<Recommendation | null> {
    return this.loadRaw<Recommendation>(
      "recommendation",
      join("recommendations", safeFileSegment(experimentId) + ".json"),
    ).then((r) => r?.payload ?? null);
  }

  async saveOptimizerRun(meta: OptimizerRunMetadata): Promise<void> {
    await this.saveRaw(
      "optimizer-run",
      join("optimizer-runs", safeFileSegment(meta.experimentId) + ".json"),
      meta,
    );
  }

  static currentSchemaVersion(): number {
    return SCHEMA_VERSION;
  }
}

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreBackend } from "../src/persistence/backends.ts";
import {
  createLocalJsonStore,
  IndexedDbBackend,
  InMemoryBackend,
  LocalJsonStore,
  buildExperimentDefinition,
  SyntheticExperimentRunner,
  playerPreset,
  equalXy,
  exportExperimentBundle,
  importExperimentBundle,
  SCHEMA_VERSION,
} from "../src/index.ts";

const fsRoot = await mkdtemp(join(tmpdir(), "aldo-pass2-"));
afterAll(async () => {
  await rm(fsRoot, { recursive: true, force: true });
});

async function seedTrials(storeBackend: StoreBackend | string): Promise<string> {
  const store =
    typeof storeBackend === "string"
      ? createLocalJsonStore(storeBackend)
      : new LocalJsonStore(storeBackend);
  const definition = buildExperimentDefinition({
    id: "experiment-backend",
    name: "backend test",
    baselineSensitivity: equalXy(7),
    dpi: 800,
    measuredRepsPerCandidatePerRound: 3,
  });
  const runner = new SyntheticExperimentRunner(definition, {
    ...playerPreset("consistent-medium"),
    trueOptimalEdpi: 5600,
  });
  const trials = runner.runRound(0, 4242, "session-b", definition.id);
  await store.saveExperiment(definition);
  for (const trial of trials) await store.saveTrial(definition.id, trial);
  return definition.id;
}

describe("persistence backends", () => {
  it("round-trips through the in-memory backend", async () => {
    const backend = new InMemoryBackend();
    const experimentId = await seedTrials(backend);
    const store = new LocalJsonStore(backend);
    const loaded = await store.loadExperiment(experimentId);
    expect(loaded?.id).toBe(experimentId);
    const trials = await store.loadAllTrials(experimentId);
    expect(trials.length).toBeGreaterThan(10);
  });

  it("round-trips through the Node filesystem backend", async () => {
    const experimentId = await seedTrials(fsRoot);
    const store = createLocalJsonStore(fsRoot);
    const trials = await store.loadAllTrials(experimentId);
    expect(trials.length).toBeGreaterThan(10);
  });

  it("round-trips through an IndexedDB facade backend", async () => {
    const backing = new Map<string, string>();
    const fakeDb = {
      async get(key: string) {
        return backing.get(key);
      },
      async put(key: string, value: string) {
        backing.set(key, value);
      },
      async getAllKeys() {
        return [...backing.keys()];
      },
    };
    const backend = new IndexedDbBackend(fakeDb);
    const experimentId = await seedTrials(backend);
    const store = new LocalJsonStore(backend);
    const trials = await store.loadAllTrials(experimentId);
    expect(trials.length).toBeGreaterThan(10);
  });
});

describe("session bundle export/import", () => {
  it("exports and re-imports a complete experiment with raw trials", async () => {
    const sourceBackend = new InMemoryBackend();
    const sourceStore = new LocalJsonStore(sourceBackend);
    const definition = buildExperimentDefinition({
      id: "experiment-bundle",
      name: "bundle",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 4,
    });
    await sourceStore.saveExperiment(definition);
    const runner = new SyntheticExperimentRunner(definition, {
      ...playerPreset("consistent-medium"),
      trueOptimalEdpi: 5600,
    });
    for (const trial of runner.runRound(0, 77, "session-x", definition.id)) {
      await sourceStore.saveTrial(definition.id, trial);
    }

    const bundle = await exportExperimentBundle(sourceStore, definition.id);
    expect(bundle.kind).toBe("session-bundle");
    expect(bundle.schemaVersion).toBe(SCHEMA_VERSION);

    const targetBackend = new InMemoryBackend();
    const targetStore = new LocalJsonStore(targetBackend);
    const result = await importExperimentBundle(targetStore, JSON.parse(JSON.stringify(bundle)));
    expect(result.experimentId).toBe("experiment-bundle");
    expect(result.trialsImported).toBe(
      (await sourceStore.listTrialIds(definition.id)).length,
    );
    const reloaded = await targetStore.loadAllTrials(definition.id);
    expect(reloaded.length).toBe(result.trialsImported);
  });

  it("rejects bundles with wrong kind or future schema version", async () => {
    const store = new LocalJsonStore(new InMemoryBackend());
    await expect(
      importExperimentBundle(store, { kind: "nope", schemaVersion: 1, payload: {} }),
    ).rejects.toThrow(/invalid session bundle/);
    await expect(
      importExperimentBundle(store, {
        kind: "session-bundle",
        schemaVersion: SCHEMA_VERSION + 9,
        payload: {},
      }),
    ).rejects.toThrow(/newer than supported/);
  });
});

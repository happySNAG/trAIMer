import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalJsonStore,
  SCHEMA_VERSION,
  buildExperimentDefinition,
  playerPreset,
  SyntheticExperimentRunner,
  unwrapEnvelope,
  wrapEnvelope,
} from "../src/index.ts";
import { equalXy } from "../src/domain/settings.ts";
import type { TrialRecord } from "../src/domain/trial.ts";

const storeRoot = await mkdtemp(join(tmpdir(), "aldo-store-"));
afterAll(async () => {
  await rm(storeRoot, { recursive: true, force: true });
});

const store = new LocalJsonStore(storeRoot);

describe("persistence round trips", () => {
  it("stores and loads a player profile", async () => {
    const profile = {
      id: "player-roundtrip" as const,
      displayName: "Round Trip",
      game: "fortnite" as const,
      mouseConfigurationId: "mouse-x" as const,
      sensitivityPreference: "medium" as const,
    };
    await store.saveProfile(profile);
    const loaded = await store.loadProfile("player-roundtrip");
    expect(loaded).toEqual(profile);
  });

  it("stores and loads an experiment definition with candidates", async () => {
    const def = buildExperimentDefinition({
      id: "experiment-roundtrip",
      name: "roundtrip",
      baselineSensitivity: equalXy(7),
      dpi: 800,
    });
    await store.saveExperiment(def);
    const loaded = await store.loadExperiment("experiment-roundtrip");
    expect(loaded).not.toBeNull();
    expect(JSON.stringify(loaded)).toEqual(JSON.stringify(def));
  });

  it("stores and reloads raw trial samples byte-for-byte", async () => {
    const def = buildExperimentDefinition({
      id: "experiment-trials",
      name: "trials",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 3,
    });
    const runner = new SyntheticExperimentRunner(
      def,
      playerPreset("consistent-medium"),
    );
    const trials = runner.runRound(0, 314, "session-persist", def.id);
    for (const trial of trials) {
      await store.saveTrial(def.id, trial);
    }
    const ids = await store.listTrialIds(def.id);
    expect(ids.length).toBe(trials.length);

    const original = trials[4] as TrialRecord;
    const loaded = await store.loadTrial(def.id, original.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.samples.length).toBe(original.samples.length);
    for (let i = 0; i < original.samples.length; i++) {
      expect(loaded!.samples[i]!.tMs).toBe(original.samples[i]!.tMs);
      expect(loaded!.samples[i]!.cursor.x).toBeCloseTo(original.samples[i]!.cursor.x, 12);
      expect(loaded!.samples[i]!.cursor.y).toBeCloseTo(original.samples[i]!.cursor.y, 12);
    }
    expect(loaded!.outcome).toBe(original.outcome);
    expect(loaded!.targets).toEqual(original.targets);
  });

  it("wraps and unwraps envelopes at the current schema version", () => {
    const envelope = wrapEnvelope("player-profile", { id: "x" }, "2026-01-01T00:00:00Z");
    expect(envelope.schemaVersion).toBe(SCHEMA_VERSION);
    const { payload, migratedFrom } = unwrapEnvelope<{ id: string }>(
      "player-profile",
      JSON.parse(JSON.stringify(envelope)),
    );
    expect(payload.id).toBe("x");
    expect(migratedFrom).toBeNull();
  });

  it("migrates a legacy v0 trial record to v1", () => {
    const legacyEnvelope = {
      schemaVersion: 0,
      kind: "trial-record",
      savedAtIso: "2025-06-01T00:00:00Z",
      payload: {
        id: "trial-legacy",
        scenarioId: "flick-static-medium",
        samples: [
          { t: 0, pos: { x: 640, y: 360 } },
          { t: 8, pos: { x: 650, y: 360 } },
          { t: 16, pos: { x: 664, y: 361 } },
        ],
      },
    };
    const { payload, migratedFrom } = unwrapEnvelope<TrialRecord>(
      "trial-record",
      legacyEnvelope,
    );
    expect(migratedFrom).toBe(0);
    expect(payload.samples).toHaveLength(3);
    expect(payload.samples[0]).toEqual({
      tMs: 0,
      cursor: { x: 640, y: 360 },
      dx: 0,
      dy: 0,
    });
    expect(payload.samples[1]!.dx).toBe(10);
    expect(payload.samples[2]!.dy).toBe(1);
  });

  it("rejects envelopes of the wrong kind", () => {
    const envelope = wrapEnvelope("player-profile", {}, "2026-01-01T00:00:00Z");
    expect(() =>
      unwrapEnvelope("trial-record", JSON.parse(JSON.stringify(envelope))),
    ).toThrow(/invalid envelope/);
  });

  it("rejects data newer than the supported schema version", () => {
    const future = {
      schemaVersion: SCHEMA_VERSION + 5,
      kind: "trial-record",
      savedAtIso: "2030-01-01T00:00:00Z",
      payload: {},
    };
    expect(() => unwrapEnvelope("trial-record", future)).toThrow(/newer than supported/);
  });

  it("returns null for missing records instead of throwing", async () => {
    expect(await store.loadProfile("player-does-not-exist")).toBeNull();
    expect(await store.loadTrial("experiment-none", "trial-none")).toBeNull();
  });
});

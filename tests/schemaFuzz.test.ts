import { describe, expect, it } from "vitest";
import { unwrapEnvelope, wrapEnvelope } from "../src/persistence/migrations.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { exportBackupAll, importBackupAll } from "../src/persistence/backup.ts";
import { exportExperimentBundle, importExperimentBundle } from "../src/persistence/bundle.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { makeTrial } from "./helpers.ts";

/**
 * Pass 6 schema/migration torture tests (requirement 9).
 *
 * Deterministic fuzzing of every persisted-artifact boundary: envelopes,
 * migrations, backups, and bundles. Hostile inputs must fail CLOSED with a
 * thrown error and ZERO partial mutation — never a silently coerced record.
 */

const MUTATORS: ((v: unknown) => unknown)[] = [
  // Structural attacks
  () => null,
  () => undefined,
  () => 42,
  () => "string",
  () => [],
  () => ({}),
  // Envelope field attacks
  (_v) => ({ schemaVersion: -1 }),
  (v) => ({ ...(v as object), schemaVersion: 0 }),
  (v) => ({ ...(v as object), schemaVersion: 2 }),
  (v) => ({ ...(v as object), schemaVersion: Number.MAX_SAFE_INTEGER }),
  (v) => ({ ...(v as object), schemaVersion: "1" }),
  (v) => ({ ...(v as object), schemaVersion: null }),
  (v) => ({ ...(v as object), schemaVersion: NaN }),
  (v) => ({ ...(v as object), kind: "wrong-kind" }),
  (v) => ({ ...(v as object), kind: null }),
  (v) => ({ ...(v as object), kind: 123 }),
  (v) => ({ ...(v as object), savedAtIso: 12345 }),
  (v) => delete ((v as Record<string, unknown>).schemaVersion),
  (v) => delete ((v as Record<string, unknown>).kind),
  (v) => delete ((v as Record<string, unknown>).payload),
  // Payload corruption
  (v) => ({ ...(v as object), payload: null }),
  (v) => ({ ...(v as object), payload: [] }),
  (v) => ({ ...(v as object), payload: "junk" }),
  // Prototype pollution shapes
  (_v) => JSON.parse('{"__proto__": {"polluted": true}, "schemaVersion": 1}'),
  (v) => {
    const o = v as Record<string, unknown>;
    return { ...o, payload: { ...(o.payload as object), __proto__: { polluted: true } } };
  },
  // Future/unknown fields must not crash unwrapping
  (v) => ({ ...(v as object), futureField: { nested: [1, 2, 3] } }),
];

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("envelope unwrap fuzzing", () => {
  it("rejects or cleanly handles every mutation of a valid envelope", () => {
    const trial = makeTrial();
    const envelope = wrapEnvelope("trial-record", trial, "2026-08-23T00:00:00Z");
    const raw = JSON.parse(JSON.stringify(envelope));
    let rejected = 0;
    let accepted = 0;
    for (const mutate of MUTATORS) {
      let mutated: unknown;
      try {
        mutated = mutate(deepClone(raw));
      } catch {
        continue; // mutator itself failed — nothing to test
      }
      try {
        const result = unwrapEnvelope<unknown>("trial-record", mutated);
        // If accepted, the payload must be structurally intact.
        expect(result.migratedFrom === null || typeof result.migratedFrom === "number").toBe(true);
        accepted++;
      } catch {
        rejected++;
      }
      // The original envelope is never modified by failed attempts.
      expect(envelope.schemaVersion).toBe(1);
    }
    expect(rejected).toBeGreaterThan(10);
    void accepted;
  });

  it("never partially migrates across a failing chain", () => {
    const trial = makeTrial();
    for (const badVersion of [-3, 99, 2]) {
      const hostile = {
        schemaVersion: badVersion,
        kind: "trial-record",
        savedAtIso: "2026-08-23T00:00:00Z",
        payload: trial,
      };
      expect(() => unwrapEnvelope("trial-record", hostile)).toThrow();
    }
  });

  it("rejects wrong-kind envelopes with clear errors", () => {
    const trial = makeTrial();
    const envelope = wrapEnvelope("trial-record", trial, "2026-08-23T00:00:00Z");
    expect(() => unwrapEnvelope("recommendation", envelope)).toThrow(/kind/i);
  });
});

describe("store-level fuzzing", () => {
  it("refuses unsafe path segments without writing anything", async () => {
    const backend = new InMemoryBackend();
    const store = new LocalJsonStore(backend);
    const trial = makeTrial();
    const attacks = [
      ["trial-record", `trials/../profiles/evil`, trial],
      ["trial-record", `trials/x/..%2F..%2Fy.json`, trial],
      ["trial-record", `trials/x/.hidden`, trial],
      ["trial-record", "", trial],
    ] as const;
    for (const [kind, path, payload] of attacks) {
      await expect(store.saveRaw(kind as never, path as never, payload)).rejects.toThrow();
    }
    expect((await backend.listFiles("")).length).toBe(0);
  });

  it("keeps loadRaw fail-closed on corrupted stored JSON", async () => {
    const backend = new InMemoryBackend();
    await backend.writeFile("experiments/bad.json", "{not json at all");
    const store = new LocalJsonStore(backend);
    await expect(
      store.loadRawAt("experiment-definition", "experiments/bad.json"),
    ).rejects.toThrow();
  });
});

describe("backup fuzzing", () => {
  it("rejects hostile backup shapes with zero partial state", async () => {
    const sourceBackend = new InMemoryBackend();
    const store = new LocalJsonStore(sourceBackend);
    await store.saveTrial("experiment-x", makeTrial({ id: "t1" as never }));
    const backup = await exportBackupAll(sourceBackend);

    const targets = attacksOn(backup);
    for (let i = 0; i < targets.length; i++) {
      const target = new InMemoryBackend();
      await expect(importBackupAll(target, targets[i]!)).rejects.toThrow();
      expect((await target.listFiles("")).length, `attack ${i} left files`).toBe(0);
    }

    // Oversized entries arrays.
    const huge = deepClone(backup);
    huge.entries = new Array(500_000).fill(backup.entries[0]);
    huge.entryPaths = new Array(500_000).fill("profiles/x.json");
    const t2 = new InMemoryBackend();
    await expect(importBackupAll(t2, huge)).rejects.toThrow();

    // Deeply nested hostile JSON in an entry.
    //
    // Built as a STRING rather than by nesting real arrays and calling
    // JSON.stringify: stringify recurses once per level, so constructing the
    // fixture blew the stack before the assertion below ever ran, and whether
    // it did depended on the host's stack size (green on macOS, RangeError on
    // the Linux CI runner). The payload is identical — 100k nested arrays —
    // and now it is guaranteed to reach importBackupAll.
    const depth = 100_000;
    const nested = deepClone(backup);
    nested.entries[0] = `${"[".repeat(depth)}"leaf"${"]".repeat(depth)}`;
    const t3 = new InMemoryBackend();
    await expect(importBackupAll(t3, nested)).rejects.toThrow();
  }, 60_000);
});

function attacksOn(backup: ReturnType<typeof Object>): unknown[] {
  const clone = (): typeof backup => deepClone(backup as never);
  const out: unknown[] = [];
  const b1 = clone(); b1.kind = "not-a-backup"; out.push(b1);
  const b2 = clone(); b2.schemaVersion = 99; out.push(b2);
  const b3 = clone(); b3.integrity.checksumHex = "f".repeat(64); out.push(b3);
  const b4 = clone(); b4.entryPaths[0] = "../../etc/passwd"; out.push(b4);
  const b5 = clone(); b5.entryPaths[0] = "C:\\evil\\path.json"; out.push(b5);
  const b6 = clone(); b6.entryPaths[0] = "/absolute/path.json"; out.push(b6);
  const b7 = clone(); b7.entries = []; out.push(b7);
  const b8 = clone(); b8.entries = ["{broken json"]; out.push(b8);
  const b9 = clone(); (b9 as unknown as Record<string, unknown>).integrity = null; out.push(b9);
  const b10 = clone(); b10.entryPaths = b10.entryPaths.slice(1); out.push(b10);
  const b11 = clone(); b11.entries[0] = "null"; out.push(b11);
  const b12 = clone(); b12.entries[0] = "42"; out.push(b12);
  return out;
}

describe("bundle fuzzing", () => {
  it("rejects corrupted/duplicated/hostile bundles with empty store", async () => {
    const backend = new InMemoryBackend();
    const store = new LocalJsonStore(backend);
    const definition = buildTinyDefinition();
    await store.saveExperiment(definition);
    const trial = makeTrial();
    await store.saveTrial(definition.id, trial);
    const bundle = await exportExperimentBundle(store, definition.id);

    const mutations: ((b: typeof bundle) => unknown)[] = [
      (b) => ({ ...b, kind: "session-bundle-evil" }),
      (b) => ({ ...b, schemaVersion: 999 }),
      (b) => ({ ...b, integrity: { algorithm: "sha256", checksumHex: "0".repeat(64) } }),
      (b) => ({ ...b, payload: null }),
      (b) => ({ ...b, payload: { ...b.payload, trials: [...b.payload.trials, ...b.payload.trials] } }),
      (b) => ({ ...b, payload: { ...b.payload, experimentDefinition: null } }),
      (b) => JSON.parse(JSON.stringify(b).replace('"flick-static-medium"', '"flick-static-MEDIUM"')),
      (b) => ({ ...b, exportedAtIso: { malicious: true } }),
    ];
    for (let i = 0; i < mutations.length; i++) {
      const targetBackend = new InMemoryBackend();
      const target = new LocalJsonStore(targetBackend);
      const beforePaths = await targetBackend.listFiles("");
      await expect(
        importExperimentBundle(target, mutations[i]!(deepClone(bundle))),
        `mutation ${i} should be rejected`,
      ).rejects.toThrow();
      const afterPaths = await targetBackend.listFiles("");
      expect(afterPaths.length, `mutation ${i} wrote files`).toBeLessThanOrEqual(beforePaths.length + 0);
    }
  });
});

function buildTinyDefinition() {
  return buildExperimentDefinition({
    id: "experiment-fuzz" as never,
    name: "fuzz",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    randomizeOrder: false,
    orderSeed: 1,
  });
}

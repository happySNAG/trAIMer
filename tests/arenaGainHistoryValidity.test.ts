import { describe, expect, it } from "vitest";
import { HistoryApi } from "../src/history/api.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import {
  buildHumanSessionRecord,
  finalizeHumanSessionRecord,
} from "../src/session/humanSession.ts";
import {
  buildSessionArenaGainRecord,
  PRE_GAIN_SESSION_WARNING,
  readSessionArenaGainRecord,
  sessionAppliedCandidateGain,
} from "../src/session/arenaGainRecord.ts";
import {
  ARENA_GAIN_MODEL_VERSION,
  ARTIFACT_COMPATIBILITY_MATRIX,
  fullReleaseMetadata,
} from "../src/version.ts";
import {
  ARENA_PX_PER_DEGREE,
  arenaCmPer360,
  arenaGainPxPerCount,
  baselineReferenceAnchor,
} from "../src/sensmath/arenaGain.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import {
  makeExperimentId,
  makePlayerId,
  makeSessionId,
} from "../src/domain/ids.ts";

/**
 * A pre-fix session must never be read back as the same kind of evidence as a
 * post-fix one (Pass 15, requirements H and I).
 *
 * Every real-hardware calibration completed on rc.5–rc.8 ran on an arena that
 * moved the crosshair one logical pixel per mouse count for every candidate.
 * Those sessions are kept — the drills happened, the trials are valid records
 * of what the player did — but their RECOMMENDED SENSITIVITY answers a
 * question the session never asked. This file pins the distinction into the
 * History API so no presentation layer has to re-derive it, and so a future
 * change that starts trusting those numbers again fails here.
 */

const definition = buildExperimentDefinition({
  id: makeExperimentId("history-validity"),
  name: "history validity",
  baselineSensitivity: { sensX: 7, sensY: 7 },
  dpi: 800,
  orderSeed: 7,
});

const anchor = baselineReferenceAnchor(definition.baselineSensitivity, definition.dpi);

function gainRecord() {
  return buildSessionArenaGainRecord({
    modelVersion: ARENA_GAIN_MODEL_VERSION,
    anchorSource: anchor.source,
    anchorBasis: anchor.basis,
    referenceSensX: anchor.referenceSensX,
    referenceSensY: anchor.referenceSensY,
    referenceDegreesPerCmX: anchor.referenceDegreesPerCmX,
    referenceDegreesPerCmY: anchor.referenceDegreesPerCmY,
    pxPerDegree: ARENA_PX_PER_DEGREE,
    dpi: definition.dpi,
    candidates: definition.candidates.map((c) => ({
      id: c.id,
      sensitivity: c.sensitivity,
      gain: arenaGainPxPerCount(anchor, c.sensitivity, definition.dpi),
      cmPer360X: arenaCmPer360(anchor, c.sensitivity, definition.dpi).x,
    })),
  });
}

function sessionRecord(id: string) {
  return buildHumanSessionRecord({
    sessionId: makeSessionId(id),
    experimentId: makeExperimentId(id),
    playerId: makePlayerId("aldo"),
    displayName: "Aldo",
    dpi: 800,
    startingSensitivity: { sensX: 7, sensY: 7 },
    device: {
      userAgent: "test",
      platform: "test",
      screenPx: { width: 1920, height: 1080 },
      pointerCoalescingSupported: true,
    },
    startedAtIso: "2026-09-01T10:00:00.000Z",
    scenarioOrder: ["flick-static-medium"],
    candidateOrderBlinded: ["A", "B"],
    candidateReveal: { A: "cand-baseline" },
    warmupCount: 2,
    measuredCount: 40,
    invalidTrialCount: 0,
    pausePeriods: [],
    fatigueIndicators: { forcedRests: 0, degradationDetected: false, degradationRatio: null },
    optimizerVersion: "optimizer-v3",
    scoringWeights: {},
    calibrationAdequateX: null,
    calibrationAdequateY: null,
    sessionIndexForPlayer: 1,
  });
}

async function storeWith(records: unknown[]): Promise<LocalJsonStore> {
  const store = new LocalJsonStore(new InMemoryBackend());
  for (const [i, rec] of records.entries()) {
    await store.saveRaw("human-session", `human-sessions/s${i}.json`, rec);
  }
  return store;
}

describe("the gain record marks what a session actually compared", () => {
  it("writes the applied gain for every candidate, with a spread greater than 1", () => {
    const record = gainRecord();
    expect(record.appliedGains).toHaveLength(definition.candidates.length);
    expect(record.gainSpreadRatio).toBeCloseTo(1.35 * 1.35, 6);
    expect(sessionAppliedCandidateGain(record)).toBe(true);
  });

  it("treats a record whose candidates all felt the same as NOT a comparison", () => {
    const degenerate = buildSessionArenaGainRecord({
      modelVersion: ARENA_GAIN_MODEL_VERSION,
      anchorSource: "baseline-reference",
      anchorBasis: "x",
      referenceSensX: 7,
      referenceSensY: 7,
      referenceDegreesPerCmX: 12,
      referenceDegreesPerCmY: 12,
      pxPerDegree: ARENA_PX_PER_DEGREE,
      dpi: 800,
      candidates: definition.candidates.map((c) => ({
        id: c.id,
        sensitivity: c.sensitivity,
        // The rc.8 arena: 1 px/count whatever the candidate.
        gain: { x: 1, y: 1 },
        cmPer360X: 30,
      })),
    });
    expect(degenerate.gainSpreadRatio).toBe(1);
    expect(sessionAppliedCandidateGain(degenerate)).toBe(false);
  });

  it("reads back nothing rather than throwing on junk", () => {
    for (const junk of [null, undefined, 42, "x", {}, { recordVersion: 99 }]) {
      expect(readSessionArenaGainRecord(junk)).toBeNull();
    }
    expect(sessionAppliedCandidateGain(null)).toBe(false);
  });
});

describe("History distinguishes pre-fix sessions from post-fix ones", () => {
  it("flags a session recorded before the arena applied candidate gain", async () => {
    const legacy = finalizeHumanSessionRecord(
      sessionRecord("legacy-rc8"),
      "2026-09-01T10:30:00.000Z",
      null,
      0,
    );
    // The marker is the ABSENCE of the field: nothing was rewritten.
    expect("arenaGain" in legacy).toBe(false);

    const api = new HistoryApi(await storeWith([legacy]));
    const [summary] = await api.listSessions();
    expect(summary!.candidateGainApplied).toBe(false);
    expect(summary!.arenaGain).toBeNull();
    expect(summary!.candidateGainWarning).toBe(PRE_GAIN_SESSION_WARNING);
  });

  it("accepts a session this build recorded", async () => {
    const current = finalizeHumanSessionRecord(
      sessionRecord("current-rc9"),
      "2026-09-01T10:30:00.000Z",
      null,
      0,
      null,
      gainRecord(),
    );
    const api = new HistoryApi(await storeWith([current]));
    const [summary] = await api.listSessions();
    expect(summary!.candidateGainApplied).toBe(true);
    expect(summary!.candidateGainWarning).toBeNull();
    expect(summary!.arenaGain?.modelVersion).toBe(ARENA_GAIN_MODEL_VERSION);
    expect(summary!.arenaGain?.appliedGains.length).toBe(definition.candidates.length);
  });

  it("keeps a pre-fix session fully readable — nothing is deleted or hidden", async () => {
    const legacy = finalizeHumanSessionRecord(
      sessionRecord("legacy-keep"),
      "2026-09-01T10:30:00.000Z",
      null,
      0,
    );
    const api = new HistoryApi(await storeWith([legacy]));
    const [summary] = await api.listSessions();
    expect(summary!.measuredTrials).toBe(40);
    expect(summary!.playerName).toBe("Aldo");
    expect(summary!.startedAtIso).toBe("2026-09-01T10:00:00.000Z");
  });

  it("does not assume validity for an experiment with no session artifact", async () => {
    // A bundle import or CLI run has no human session, so it cannot testify
    // that its arena applied candidate gain. Unproven is not the same as good.
    const store = new LocalJsonStore(new InMemoryBackend());
    await store.saveRecommendation({
      experimentId: makeExperimentId("imported"),
      recommendedEdpi: 5600,
      confidence: 0.7,
      confidenceLabel: "moderate",
      edpiRange: { min: 5000, max: 6200 },
      unresolvedBoundary: false,
      primarySensitivity: { sensX: 7, sensY: 7 },
      evidence: { validTrialsPerCandidate: {}, bestCandidateId: "cand-baseline" },
    } as never);
    const api = new HistoryApi(store);
    const summaries = await api.listSessions();
    const imported = summaries.find(
      (s) => s.experimentId === makeExperimentId("imported"),
    );
    expect(imported?.candidateGainApplied).toBe(false);
    expect(imported?.candidateGainWarning).toBe(PRE_GAIN_SESSION_WARNING);
  });
});

describe("the release metadata makes the two generations distinguishable", () => {
  it("publishes the arena gain model version", () => {
    expect(fullReleaseMetadata().arenaGainModelVersion).toBe(ARENA_GAIN_MODEL_VERSION);
  });

  it("documents the compatibility rule in the artifact matrix", () => {
    const row = ARTIFACT_COMPATIBILITY_MATRIX.find((r) =>
      r.artifact.includes("arena gain"),
    );
    expect(row).toBeDefined();
    expect(row!.readableVersions).toContain(ARENA_GAIN_MODEL_VERSION);
    expect(row!.readableVersions).toContain("ABSENT");
  });

  it("states plainly what a pre-fix recommendation is not", () => {
    expect(PRE_GAIN_SESSION_WARNING).toContain("not evidence about sensitivity");
    expect(PRE_GAIN_SESSION_WARNING).toContain("kept in full");
  });
});

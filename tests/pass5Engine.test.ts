import { describe, expect, it } from "vitest";
import {
  runPreflightChecks,
  PREFLIGHT_THRESHOLDS,
  type PreflightEnvironment,
} from "../src/preflight/preflight.ts";
import {
  analyzeCaptureSelfTest,
  type CaptureSelfTestMeta,
} from "../src/diagnostics/captureSelfTest.ts";
import {
  V1_RC_PROTOCOL_DEFAULTS,
  RC_BUILDER_DEFAULTS,
} from "../src/experiments/rcDefaults.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import {
  planNextTest,
  detectRetestTriggers,
  planRetestSession,
} from "../src/session/retest.ts";
import {
  buildFinalResult,
  type FinalResultInput,
} from "../src/results/finalResult.ts";
import {
  exportBackupAll,
  importBackupAll,
  BackupError,
  stableStringify,
  sha256Hex,
} from "../src/persistence/backup.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import {
  exportExperimentBundle,
  importExperimentBundle,
} from "../src/persistence/bundle.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import {
  assessTimeJump,
  InstanceGuard,
  LIFECYCLE_POLICY,
} from "../src/lifecycle/lifecycle.ts";
import {
  emptyState,
  loadingState,
  errorState,
  loadHistoryContract,
  loadResultsContract,
} from "../src/contracts/states.ts";
import {
  NativeTransportCaptureSource,
  assertLoopbackUrl,
  createLoopbackSocketPair,
  NATIVE_TRANSPORT_LIMITS,
} from "../src/capture/nativeClient.ts";
import {
  APP_VERSION,
  ENGINE_VERSION,
  OPTIMIZER_VERSION,
  NATIVE_PROTOCOL_VERSION,
  EXPECTED_HELPER_VERSION,
  ARTIFACT_COMPATIBILITY_MATRIX,
} from "../src/version.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function baseEnv(overrides: Partial<PreflightEnvironment> = {}): PreflightEnvironment {
  return {
    runtime: {
      browserName: "Chrome",
      isSupportedChromiumRuntime: true,
      pointer: { capturePath: "pointermove-coalesced", pointerLockSupported: true },
    },
    nativeHelper: null,
    activeCaptureTier: 2,
    captureQuality: {
      observedRateHz: 120,
      timestampsMonotonic: true,
      dropFraction: 0,
      jitterCv: 0.1,
      selfTestVerdict: "pass",
    },
    dpi: 800,
    sensXPercent: 7,
    sensYPercent: 7,
    calibration: { hasAdequateCalibration: true, stale: false },
    storage: { availableBytes: 1024 * 1024 * 1024 },
    viewport: { widthPx: 1280, heightPx: 720 },
    unfinishedCheckpoints: [],
    storedArtifactEngineVersions: [ENGINE_VERSION],
    nowIso: "2026-08-23T12:00:00.000Z",
    ...overrides,
  };
}

function selfTestMeta(overrides: Partial<CaptureSelfTestMeta> = {}): CaptureSelfTestMeta {
  return {
    startedAtIso: "2026-08-23T10:00:00Z",
    endedAtIso: "2026-08-23T10:00:05Z",
    durationMs: 5000,
    sourceKind: "native",
    deviceId: "mouse-abcd1234",
    deviceDescription: "Logitech Lightspeed",
    nominalRateHz: 1000,
    // A native stream is only usable once its clock has been put on the
    // renderer's timeline; the self-test now checks that explicitly.
    clockSync: {
      state: "established",
      detail: "offset 123.000 ms ±0.100 ms from 6 exchanges",
      estimate: {
        offsetMs: 123,
        uncertaintyHalfWidthMs: 0.1,
        minRoundTripMs: 0.2,
        samples: 6,
        driftPpm: null,
        lastSyncedAtMs: 1000,
      },
      maxUncertaintyMs: 2,
    },
    transportCounters: {
      framesReceived: 1000,
      duplicateSequences: 0,
      missingSequences: 0,
      nonMonotonicTimestamps: 0,
      reconnects: 0,
    },
    ...overrides,
  };
}


function recommendationFixture(overrides: Record<string, unknown> = {}) {
  const evidence = {
    trialsAnalyzed: 60,
    trialsExcluded: 2,
    exclusionReasonCounts: { INSUFFICIENT_SAMPLES: 2 },
    candidatesEvaluated: 5,
    validTrialsPerCandidate: { a: 12, b: 12, c: 11, d: 12, e: 11 },
    bestCandidateId: "cand-b",
    runnerUpCandidateId: "cand-c",
    utilityGapBestVsRunnerUp: 0.08,
    utilityGapZScore: 2.4,
    separation: "clear",
    searchRoundsRun: 2,
    notes: [],
  };
  return {
    experimentId: "experiment-fixture",
    primarySensitivity: { sensX: 7.4, sensY: 7.4 },
    recommendedEdpi: 5920,
    sensXRange: { min: 6.1, max: 8.9 },
    edpiRange: { min: 4880, max: 7120 },
    confidence: 0.72,
    confidenceLabel: "moderate",
    dimensionEstimates: {},
    utilityWeights: {},
    evidence,
    warnings: ["statistically tied candidates span a wide range"],
    refusedHighConfidence: false,
    rationaleLines: ["best candidate cand-b leads by 0.08 utility"],
    unresolvedBoundary: false,
    furtherTestingSuggested: false,
    explanation: {
      whyThisX: ["best paired contrast vs every other candidate"],
      whyThisY: ["Y matched to X pending joint exploration"],
      candidatesTested: [
        { candidateId: "cand-b", edpiX: 5920, utilityMean: 0.62, utilityStandardError: 0.04, validTrials: 12, tiedWithBest: true },
        { candidateId: "cand-c", edpiX: 5440, utilityMean: 0.54, utilityStandardError: 0.05, validTrials: 11, tiedWithBest: false },
      ],
      scenarioContributions: [
        { scenarioId: "flick-static-medium", difficultyTier: "core", validTrials: 12, meanUtilityBest: 0.66, meanUtilityRunnerUp: 0.55 },
      ],
      evidenceForWinner: ["clear separation"],
      evidenceAgainstWinner: ["range is wide"],
      uncertaintyRemaining: ["wide plateau"],
      furtherTestingActions: ["run one more session"],
      boundaryReached: false,
      captureQualityAdequate: true,
    },
    confidenceCalibration: {
      basis: "heuristic",
      heuristicVersion: "heuristic-v2",
      diagnostics: {},
      empiricalModelVersion: null,
      notes: [],
    },
    sensitivityChangePlan: {
      policyApplied: true,
      currentSensX: 7,
      recommendedNowSensX: 7.35,
      recommendedNowEdpi: 5880,
      fullInferredSensX: 7.4,
      stepOctavesAllowed: 0.322,
      rationaleLines: ["bounded first step toward inferred optimum"],
      retestAfterSessions: 1,
    },
    ...overrides,
  } as never;
}

// ---------------------------------------------------------------------------
// A — version metadata
// ---------------------------------------------------------------------------

describe("V1 RC version metadata", () => {
  it("freezes the RC identifier and component versions", () => {
    expect(APP_VERSION).toBe("1.0.0-rc.10");
    expect(OPTIMIZER_VERSION).toBe("optimizer-v3");
    expect(NATIVE_PROTOCOL_VERSION).toBe(1);
    expect(EXPECTED_HELPER_VERSION).toMatch(/^helper-/);
  });

  it("documents an artifact compatibility matrix", () => {
    expect(ARTIFACT_COMPATIBILITY_MATRIX.length).toBeGreaterThanOrEqual(5);
    for (const row of ARTIFACT_COMPATIBILITY_MATRIX) {
      expect(row.readableVersions.length).toBeGreaterThan(0);
      expect(["migrated", "rejected", "flagged-stale"]).toContain(row.olderPolicy);
      expect(["rejected", "flagged"]).toContain(row.newerPolicy);
    }
  });
});

// ---------------------------------------------------------------------------
// E — preflight
// ---------------------------------------------------------------------------

describe("preflight verdicts", () => {
  it("READY when everything passes (validated native helper included)", () => {
    const report = runPreflightChecks(
      baseEnv({
        nativeHelper: { present: true, protocolCompatible: true, helperVersionOk: true },
        activeCaptureTier: 1,
        captureQuality: {
          observedRateHz: 950,
          timestampsMonotonic: true,
          dropFraction: 0,
          jitterCv: 0.05,
          selfTestVerdict: "pass",
        },
      }),
    );
    expect(report.overall).toBe("READY");
    expect(report.reasonCodes).toEqual([]);
  });

  it("absent native helper is a WARNING (browser fallback remains usable)", () => {
    const report = runPreflightChecks(baseEnv());
    expect(report.overall).toBe("READY_WITH_WARNINGS");
    expect(report.reasonCodes).toContain("NATIVE_HELPER_ABSENT");
  });

  it("READY_WITH_WARNINGS for advisory-only problems", () => {
    const report = runPreflightChecks(
      baseEnv({
        calibration: { hasAdequateCalibration: false, stale: false },
        nativeHelper: null,
      }),
    );
    expect(report.overall).toBe("READY_WITH_WARNINGS");
    expect(report.reasonCodes).toContain("CALIBRATION_MISSING");
  });

  it("NOT_READY_FOR_HIGH_CONFIDENCE on measurement-quality failures", () => {
    const report = runPreflightChecks(
      baseEnv({ captureQuality: { observedRateHz: 10, timestampsMonotonic: true, dropFraction: 0, jitterCv: 0.1, selfTestVerdict: "fail" } }),
    );
    expect(report.overall).toBe("NOT_READY_FOR_HIGH_CONFIDENCE");
    expect(report.reasonCodes).toContain("INPUT_RATE_TOO_LOW");
  });

  it("BLOCKED on unsupported Pointer Lock", () => {
    const report = runPreflightChecks(
      baseEnv({
        runtime: {
          browserName: "Unknown",
          isSupportedChromiumRuntime: false,
          pointer: { capturePath: "mousemove", pointerLockSupported: false },
        },
      }),
    );
    expect(report.overall).toBe("BLOCKED");
    expect(report.reasonCodes).toContain("POINTER_LOCK_UNSUPPORTED");
  });

  it("BLOCKED when stored artifacts come from another engine generation", () => {
    const report = runPreflightChecks(baseEnv({ storedArtifactEngineVersions: ["engine-v1"] }));
    expect(report.overall).toBe("BLOCKED");
    expect(report.reasonCodes).toContain("STORED_ARTIFACT_VERSION_MISMATCH");
  });

  it("BLOCKED on protocol mismatch with the helper", () => {
    const report = runPreflightChecks(
      baseEnv({
        nativeHelper: { present: true, protocolCompatible: false, helperVersionOk: true },
        activeCaptureTier: 1,
        captureQuality: { observedRateHz: 950, timestampsMonotonic: true, dropFraction: 0, jitterCv: 0.05, selfTestVerdict: "pass" },
      }),
    );
    expect(report.overall).toBe("BLOCKED");
    expect(report.reasonCodes).toContain("PROTOCOL_MISMATCH");
  });

  it("flags implausible DPI and unconfigured X/Y as NOT READY", () => {
    const bad = runPreflightChecks(baseEnv({ dpi: 999999, sensXPercent: null, sensYPercent: 7 }));
    expect(bad.overall).toBe("NOT_READY_FOR_HIGH_CONFIDENCE");
    expect(bad.reasonCodes).toEqual(
      expect.arrayContaining(["DPI_IMPLAUSIBLE", "SENSITIVITY_NOT_CONFIGURED"]),
    );
  });

  it("warns on stale checkpoints but stays usable", () => {
    const report = runPreflightChecks(
      baseEnv({ unfinishedCheckpoints: [{ ageMs: PREFLIGHT_THRESHOLDS.staleCheckpointAgeMs + 1000 }] }),
    );
    expect(report.overall).toBe("READY_WITH_WARNINGS");
    expect(report.reasonCodes).toContain("STALE_CHECKPOINTS_PRESENT");
  });

  it("every non-passing check carries a machine-readable reason code", () => {
    const report = runPreflightChecks(
      baseEnv({
        viewport: { widthPx: 300, heightPx: 200 },
        captureQuality: { observedRateHz: 20, timestampsMonotonic: false, dropFraction: 0.5, jitterCv: 2, selfTestVerdict: "fail" },
      }),
    );
    for (const check of report.checks) {
      if (check.status !== "pass") expect(check.reasonCode).toBeTruthy();
      else expect(check.reasonCode).toBeNull();
    }
    expect(report.summaryLines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F — capture self-test
// ---------------------------------------------------------------------------

describe("capture self-test", () => {
  function eventsAt(rateHz: number, durationMs: number) {
    const out: unknown[] = [];
    const dt = 1000 / rateHz;
    let t = 0;
    while (t < durationMs) {
      out.push({ kind: "pointer-sample", tMs: Number(t.toFixed(3)), dx: 4, dy: -1 });
      if (t >= 400 && Math.abs(t - 400) < dt / 2) {
        out.push({ kind: "button", tMs: t, action: "press" });
        out.push({ kind: "button", tMs: t + 30, action: "release" });
      }
      t += dt;
    }
    return out as never[];
  }

  it("validates a stream that actually delivers the claimed rate", () => {
    const result = analyzeCaptureSelfTest(eventsAt(1000, 3000), selfTestMeta(), APP_VERSION, ENGINE_VERSION);
    expect(result.verdict).toBe("pass");
    expect(result.activeMotionRateHz!).toBeGreaterThan(900);
    expect(result.clickPresses).toBeGreaterThanOrEqual(1);
    expect(result.movementSamples).toBeGreaterThan(2500);
  });

  it("REFUSES to validate a native stream whose clock was never synchronized", () => {
    const result = analyzeCaptureSelfTest(
      eventsAt(1000, 3000),
      selfTestMeta({ clockSync: null }),
      APP_VERSION,
      ENGINE_VERSION,
    );
    expect(result.verdict).toBe("fail");
    expect(result.checks.find((c) => c.name === "clock-sync")?.status).toBe("fail");
  });

  it("REFUSES to validate '1000 Hz' hardware that only delivers ~125 Hz", () => {
    const result = analyzeCaptureSelfTest(eventsAt(125, 3000), selfTestMeta({ nominalRateHz: 1000 }), APP_VERSION, ENGINE_VERSION);
    expect(result.verdict).toBe("fail");
    const rateCheck = result.checks.find((c) => c.name === "effective-rate")!;
    expect(rateCheck.status).toBe("fail");
    expect(rateCheck.detail).toMatch(/NOT validated/);
    expect(result.activeMotionRateHz!).toBeLessThan(200);
  });

  it("warns when delivered rate is somewhat below nominal", () => {
    const result = analyzeCaptureSelfTest(eventsAt(700, 2000), selfTestMeta({ nominalRateHz: 1000 }), APP_VERSION, ENGINE_VERSION);
    const rateCheck = result.checks.find((c) => c.name === "effective-rate")!;
    expect(result.verdict === "warn" || rateCheck.status === "warn").toBe(true);
  });

  it("fails without movement (user did not move)", () => {
    const still = [{ kind: "pointer-sample", tMs: 0, dx: 0, dy: 0 }];
    const result = analyzeCaptureSelfTest(still as never, selfTestMeta(), APP_VERSION, ENGINE_VERSION);
    expect(result.checks.find((c) => c.name === "movement")!.status).toBe("fail");
    expect(result.verdict).toBe("fail");
  });

  it("fails on duplicate sequences and counts reconnects", () => {
    const result = analyzeCaptureSelfTest(
      eventsAt(500, 1500),
      selfTestMeta({
        transportCounters: { framesReceived: 500, duplicateSequences: 1, missingSequences: 0, nonMonotonicTimestamps: 0, reconnects: 3 },
      }),
      APP_VERSION,
      ENGINE_VERSION,
    );
    expect(result.checks.find((c) => c.name === "sequence-integrity")!.status).toBe("fail");
    expect(result.reconnects).toBe(3);
  });

  it("records source identity and version stamps", () => {
    const result = analyzeCaptureSelfTest(eventsAt(500, 800), selfTestMeta(), APP_VERSION, ENGINE_VERSION);
    expect(result.kind).toBe("capture-self-test");
    expect(result.appVersion).toBe(APP_VERSION);
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(result.deviceId).toBe("mouse-abcd1234");
  });
});

// ---------------------------------------------------------------------------
// G — canonical RC defaults
// ---------------------------------------------------------------------------

describe("canonical V1 RC defaults", () => {
  it("documents a rationale for EVERY default", () => {
    for (const [key, entry] of Object.entries(V1_RC_PROTOCOL_DEFAULTS)) {
      if (key === "meta") continue;
      const doc = entry as { rationale?: string };
      expect(typeof doc.rationale, `missing rationale for ${key}`).toBe("string");
      expect(doc.rationale!.length, `empty rationale for ${key}`).toBeGreaterThan(30);
    }
    expect(V1_RC_PROTOCOL_DEFAULTS.meta.honestyNote).toMatch(/simulation/i);
  });

  it("builder consumes exactly the RC defaults", () => {
    const def = buildExperimentDefinition({
      id: "experiment-rc" as never,
      name: "rc defaults",
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
    });
    expect(def.warmupTrialsPerCandidateBlock).toBe(RC_BUILDER_DEFAULTS.warmupTrialsPerCandidateBlock);
    expect(def.measuredRepsPerCandidatePerRound).toBe(RC_BUILDER_DEFAULTS.measuredRepsPerCandidatePerRound);
    expect(def.stoppingCriteria.maxTotalMeasuredTrials).toBe(RC_BUILDER_DEFAULTS.stoppingCriteria.maxTotalMeasuredTrials);
    expect(def.stoppingCriteria.minValidTrialsPerCandidate).toBe(RC_BUILDER_DEFAULTS.stoppingCriteria.minValidTrialsPerCandidate);
    expect(def.adaptiveAllocation.enabled).toBe(true);
    expect(def.fatigueProtocol.maxContinuousTestingMs).toBe(RC_BUILDER_DEFAULTS.fatigueProtocol.maxContinuousTestingMs);
    expect(def.scenarioCatalog.map((s) => s.id)).toEqual([...RC_BUILDER_DEFAULTS.scenarioIds]);
    const ratios = def.candidates.map((c) => c.sensitivity.sensX / 7);
    expect(ratios.length).toBe(5);
    // Ladder leads with the baseline, then ±15 % inner arms, then ±35 % outer arms.
    for (const [i, expected] of [1, 1 / 1.35, 1 / 1.15, 1.15, 1.35].entries()) {
      expect(ratios[i]).toBeCloseTo(expected, 6);
    }
  });

  it("defaults remain conservative and configurable", () => {
    const tuned = buildExperimentDefinition({
      id: "experiment-tuned" as never,
      name: "tuned",
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      measuredRepsPerCandidatePerRound: 3,
      stoppingCriteria: { maxSearchRounds: 1 },
    });
    expect(tuned.measuredRepsPerCandidatePerRound).toBe(3);
    expect(tuned.stoppingCriteria.maxSearchRounds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H — complete retest loop
// ---------------------------------------------------------------------------

describe("complete retest loop", () => {
  const priorDefinition = buildExperimentDefinition({
    id: "experiment-prior-h" as never,
    name: "prior H",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    measuredRepsPerCandidatePerRound: 6,
  });

  it("detects triggers from recommendation fields plus context", () => {
    const triggers = detectRetestTriggers(recommendationFixture({ unresolvedBoundary: true }), {
      calibrationStale: true,
    });
    expect(triggers).toEqual(expect.arrayContaining(["unresolved-boundary", "stale-calibration"]));
  });

  it("no triggers → no forced retest", () => {
    expect(detectRetestTriggers(recommendationFixture(), {})).toEqual([]);
    expect(planNextTest(priorDefinition, recommendationFixture(), {})).toBeNull();
  });

  it("unresolved boundary → targeted retest preserving lineage and blinding", () => {
    const rec = recommendationFixture({ unresolvedBoundary: true }) as Parameters<typeof planNextTest>[1];
    const plan = planNextTest(priorDefinition, rec, { orderSeed: 42 });
    expect(plan!.kind).toBe("targeted-retest");
    expect(plan!.definition!.id).not.toBe(priorDefinition.id);
    expect(plan!.definition!.notes).toContain(priorDefinition.id);
    // Fresh deterministic seed.
    expect(plan!.definition!.orderSeed).toBe(42);
    // Blinding preserved: all-new candidate ids.
    const priorIds = new Set(priorDefinition.candidates.map((c) => c.id));
    for (const c of plan!.definition!.candidates) {
      expect(priorIds.has(c.id)).toBe(false);
    }
    // No dominated candidates repeated: all inside the plausible range band.
    for (const c of plan!.definition!.candidates) {
      const edpi = 800 * c.sensitivity.sensX;
      expect(edpi).toBeGreaterThanOrEqual(rec.edpiRange.min * 0.92 - 1e-9);
      expect(edpi).toBeLessThanOrEqual(rec.edpiRange.max * 1.08 + 1e-9);
    }
    expect(plan!.uncertaintyToResolve).toMatch(/beyond|edge/i);
  });

  it("capture-quality weakness → clean repeat, not narrowing", () => {
    const rec = recommendationFixture({
      captureQualitySession: { grade: "poor", score: 0.3, retestingNecessary: true },
    }) as Parameters<typeof planNextTest>[1];
    const plan = planNextTest(priorDefinition, rec, {});
    expect(plan!.kind).toBe("repeat-session");
    expect(plan!.uncertaintyToResolve).toMatch(/degraded/i);
  });

  it("adaptation contamination → repeat session", () => {
    const rec = recommendationFixture({
      changePointAnalysis: { contaminationDetected: true },
    }) as Parameters<typeof planNextTest>[1];
    expect(planNextTest(priorDefinition, rec, {})!.kind).toBe("repeat-session");
  });

  it("enforces rest between sessions and supports continue-another-day", () => {
    const rec = recommendationFixture({ unresolvedBoundary: true }) as Parameters<typeof planNextTest>[1];
    const plan = planNextTest(priorDefinition, rec, {
      priorSessionEndedAtIso: "2026-08-23T12:00:00Z",
      nowIso: "2026-08-23T12:10:00Z",
    });
    expect(plan!.canStartNow).toBe(false);
    expect(plan!.earliestStartIso).toBe(new Date(Date.parse("2026-08-23T12:00:00Z") + 30 * 60 * 1000).toISOString());
    const later = planNextTest(priorDefinition, rec, {
      priorSessionEndedAtIso: "2026-08-23T12:00:00Z",
      nowIso: "2026-08-23T13:00:00Z",
    });
    expect(later!.canStartNow).toBe(true);
  });

  it("stale calibration ALONE → recalibrate, do not retest aim", () => {
    const rec = recommendationFixture() as Parameters<typeof planNextTest>[1];
    const plan = planNextTest(priorDefinition, rec, { calibrationStale: true });
    expect(plan!.triggers).toEqual(["stale-calibration"]);
    expect(plan!.definition).toBeNull();
    expect(plan!.rationaleLines.join(" ")).toMatch(/recalibrate/i);
  });

  it("suspicious asymmetry → follow-up with Y exploration enabled", () => {
    const rec = recommendationFixture({
      jointXY: { outcome: "asymmetry-unresolved" },
    }) as Parameters<typeof planNextTest>[1];
    const plan = planNextTest(priorDefinition, rec, {});
    expect(plan!.triggers).toContain("suspicious-asymmetry");
    expect(plan!.definition!.yExploration.enabled).toBe(true);
  });

  it("legacy planRetestSession API remains available and honest", () => {
    const rec = {
      experimentId: priorDefinition.id,
      recommendedEdpi: 5600,
      edpiRange: { min: 4870, max: 6440 },
      evidence: { bestCandidateId: "cand-baseline" },
    } as never as Parameters<typeof planRetestSession>[1];
    const plan = planRetestSession(priorDefinition, rec, { orderSeed: 5 });
    expect(plan).not.toBeNull();
    expect(plan!.priorExperimentId).toBe(priorDefinition.id);
  });
});

// ---------------------------------------------------------------------------
// L — final results contract
// ---------------------------------------------------------------------------

describe("final results contract", () => {
  const input: FinalResultInput = {
    recommendation: recommendationFixture(),
    dpi: 800,
    currentSensXPercent: 7,
    currentSensYPercent: 7,
    calibration: { adequate: true, stale: false, detailLine: "calibrated 2026-08-01 at 800 DPI" },
    retestPlan: null,
  };

  it("exposes every required field without recomputation in UI code", () => {
    const r = buildFinalResult(input);
    expect(r.contractVersion).toBe("final-result-v1");
    expect(r.currentSensitivity.edpi).toBe(800 * 7);
    // Staged-change safety applies → immediate step bounded below full inference.
    expect(r.immediateRecommended.sensXPercent).toBeCloseTo(7.35, 5);
    expect(r.fullInferredSensitivity!.sensXPercent).toBeCloseTo(7.4, 5);
    expect(r.immediateRecommended.edpi).toBe(Math.round(800 * 7.35));
    expect(r.plausibleXRangePercent).toEqual({ min: 6.1, max: 8.9 });
    expect(r.plausibleYRangePercent).toEqual({ min: 6.1, max: 8.9 });
    expect(r.plausibleEdpiRange).toEqual({ min: 4880, max: 7120 });
    expect(r.confidenceBasis).toContain("heuristic");
    expect(r.captureQualityGrade).toBeNull();
    expect(r.searchAdequacyClassification).toBeNull();
    expect(r.boundaryStatus).toBe("resolved");
    expect(r.adaptationContamination).toBe(false);
    expect(r.rationaleLines.length).toBeGreaterThan(0);
    expect(r.contradictoryEvidence).toEqual(["range is wide"]);
    expect(r.candidateComparisons[0]).toMatchObject({ candidateId: "cand-b", isBest: true });
    expect(r.scenarioContributions[0]!.scenarioId).toBe("flick-static-medium");
    expect(r.excludedTrials.count).toBe(2);
    expect(r.excludedTrials.reasonsByCode).toEqual({ INSUFFICIENT_SAMPLES: 2 });
    expect(r.calibrationState!.adequate).toBe(true);
  });

  it("decides ONE next action with rationale", () => {
    const staged = buildFinalResult(input);
    expect(staged.recommendedNextAction).toBe("apply-staged-change");
    expect(staged.nextActionRationale.length).toBeGreaterThan(0);

    const lowConfidence = buildFinalResult({
      ...input,
      recommendation: recommendationFixture({ confidence: 0.3, confidenceLabel: "low", refusedHighConfidence: true, sensitivityChangePlan: undefined }),
    });
    expect(lowConfidence.recommendedNextAction).toBe("collect-more-sessions");

    const staleCal = buildFinalResult({
      ...input,
      calibration: { adequate: false, stale: true, detailLine: "DPI changed" },
    });
    expect(staleCal.recommendedNextAction).toBe("recalibrate-first");

    const keepCurrent = buildFinalResult({
      ...input,
      recommendation: recommendationFixture({ primarySensitivity: { sensX: 7, sensY: 7 }, sensitivityChangePlan: undefined }),
    });
    expect(keepCurrent.recommendedNextAction).toBe("keep-current-settings");

    const retest = buildFinalResult({
      ...input,
      retestPlan: {
        kind: "targeted-retest",
        definition: null,
        triggers: ["unresolved-boundary"],
        uncertaintyToResolve: "boundary",
        rationaleLines: ["narrow"],
        canStartNow: true,
        earliestStartIso: "",
      },
    });
    expect(retest.recommendedNextAction).toBe("run-targeted-retest");
    expect(retest.retestProtocol).not.toBeNull();
  });

  it("jointXY asymmetry widens the plausible Y range independently", () => {
    const r = buildFinalResult({
      ...input,
      recommendation: recommendationFixture({
        jointXY: { plausibleYRatioRange: { min: 0.85, max: 1.18 }, outcome: "slightly-asymmetric" },
      }),
    });
    expect(r.plausibleYRangePercent.min).toBeCloseTo(6.1 * 0.85, 3);
    expect(r.plausibleYRangePercent.max).toBeCloseTo(8.9 * 1.18, 3);
    expect(r.plausibleXRangePercent).toEqual({ min: 6.1, max: 8.9 });
  });
});

// ---------------------------------------------------------------------------
// J — data safety: backup & restore
// ---------------------------------------------------------------------------

describe("backup all data / validated restore", () => {
  async function seededBackend(): Promise<InMemoryBackend> {
    const backend = new InMemoryBackend();
    await backend.writeFile("experiments/experiment-a.json", JSON.stringify({ schemaVersion: 1, kind: "experiment-definition", savedAtIso: "2026-08-23T00:00:00Z", payload: { id: "experiment-a" } }));
    await backend.writeFile("sessions/session-a.json", JSON.stringify({ schemaVersion: 1, kind: "aim-session", savedAtIso: "2026-08-23T00:00:00Z", payload: { id: "session-a" } }));
    await backend.writeFile("self-tests/st-1.json", JSON.stringify({ schemaVersion: 1, kind: "capture-self-test", savedAtIso: "2026-08-23T00:00:00Z", payload: { deviceId: "x" } }));
    return backend;
  }

  it("round-trips a full backup with integrity metadata", async () => {
    const backend = await seededBackend();
    const backup = await exportBackupAll(backend);
    expect(backup.kind).toBe("aldo-backup");
    expect(backup.entryPaths.length).toBe(3);
    expect(backup.integrity.algorithm).toBe("sha256");

    const target = new InMemoryBackend();
    const result = await importBackupAll(target, backup);
    expect(result.restoredCount).toBe(3);
    expect(await target.readFile("experiments/experiment-a.json")).not.toBeNull();
  });

  it("rejects tampered backups WITHOUT mutating anything", async () => {
    const backend = await seededBackend();
    const backup = await exportBackupAll(backend);
    const tampered = { ...backup, entries: [...backup.entries] };
    // entries[0] is sessions/session-a.json in export order.
    tampered.entries[0] = tampered.entries[0]!.replace("session-a", "session-EVIL");
    expect(tampered.entries[0]).not.toBe(backup.entries[0]);
    const target = new InMemoryBackend();
    await expect(importBackupAll(target, tampered)).rejects.toMatchObject({
      reasonCode: "BACKUP_CHECKSUM_MISMATCH",
    });
    expect(await target.listFiles("")).toEqual([]);
  });

  it("rejects corrupted entries before any write", async () => {
    const backend = await seededBackend();
    const backup = await exportBackupAll(backend);
    const corrupt = structuredCloneBackup(backup);
    corrupt.entries[0] = "{not json";
    const target = new InMemoryBackend();
    await expect(importBackupAll(target, corrupt)).rejects.toBeInstanceOf(BackupError);
    expect((await target.listFiles(""))).toEqual([]);
  });

  it("stableStringify + sha256 are deterministic across runs", async () => {
    const obj = { b: 1, a: [3, { z: null, y: 2 }] };
    const s1 = stableStringify(obj);
    const s2 = stableStringify({ a: [3, { y: 2, z: null }], b: 1 });
    expect(s1).toBe(s2);
    expect(await sha256Hex(s1)).toBe(await sha256Hex(s2));
  });

  it("session bundle import validates fully BEFORE writing (zero partial state)", async () => {
    const store = new LocalJsonStore(new InMemoryBackend());
    const goodDef = buildExperimentDefinition({
      id: "experiment-partial" as never,
      name: "partial test",
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
    });
    await store.saveExperiment(goodDef);
    const bundle = await exportExperimentBundle(store, "experiment-partial");
    // Corrupt the SECOND trial so validation must fail mid-list.
    bundle.payload.trials = [
      makeTrialEnvelope("trial-ok"),
      makeTrialEnvelope("trial-bad"),
      makeTrialEnvelope(null),
    ];
    const fresh = new InMemoryBackend();
    const freshStore = new LocalJsonStore(fresh);
    await expect(importExperimentBundle(freshStore, bundle)).rejects.toThrow();
    // Nothing was written: not even the definition.
    expect(await fresh.listFiles("")).toEqual([]);
  });

  function makeTrialEnvelope(id: string | null) {
    return {
      schemaVersion: 1,
      kind: "trial-record",
      savedAtIso: "2026-08-23T00:00:00Z",
      payload: id ? { id } : { broken: true },
    };
  }

  function structuredCloneBackup<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }
});

// ---------------------------------------------------------------------------
// N — lifecycle
// ---------------------------------------------------------------------------

describe("lifecycle hardening", () => {
  it("assesses sleep/wake time jumps against a sane bound", () => {
    expect(assessTimeJump(1000, 1100).jumped).toBe(false);
    expect(assessTimeJump(1000, 60_000).jumped).toBe(true);
    expect(assessTimeJump(60_000, 1000).jumped).toBe(true); // backwards
  });

  it("instance guard detects duplicate app instances via BroadcastChannel", () => {
    if (typeof BroadcastChannel === "undefined") return; // environment lacks support
    const a = new InstanceGuard("instance-a", "aldo-test-guard");
    const b = new InstanceGuard("instance-b", "aldo-test-guard");
    // Allow message delivery (same-event-loop BroadcastChannel delivers async).
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(a.duplicateInstanceDetected).toBe(true);
        expect(b.duplicateInstanceDetected).toBe(true);
        expect(a.peerIds()).toContain("instance-b");
        a.dispose();
        b.dispose();
        resolve();
      }, 50);
    });
  });

  it("documents the lifecycle policy for every risky transition", () => {
    const events = LIFECYCLE_POLICY.map((p) => p.event);
    expect(events).toEqual(
      expect.arrayContaining([
        "PC sleep/wake during trial",
        "helper disconnect mid-trial",
        "mouse disconnect/reconnect",
        "DPI/profile change between sessions",
      ]),
    );
    for (const step of LIFECYCLE_POLICY) {
      expect(step.rationale.length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// K — contract states
// ---------------------------------------------------------------------------

describe("contract states", () => {
  it("history contract surfaces empty/loading/error/ready explicitly", async () => {
    expect(emptyState("none").state).toBe("empty");
    expect(loadingState().state).toBe("loading");
    expect(errorState("CODE", "msg").state).toBe("error");

    const empty = await loadHistoryContract(async () => ({
      sessions: [],
      trends: {
        xSensPercent: [], ySensPercent: [], edpi: [], eDpiTrendIsSameAsEdpi: true,
        confidence: [], captureQualityScore: [],
      },
      rankingHistory: [],
      dimensionTrend: [],
      calibrationHistory: [],
      retestLineage: [],
      deviceHistory: [],
      optimizerVersions: [],
    }));
    expect(empty.state).toBe("empty");

    const failing = await loadHistoryContract(async () => {
      throw new Error("disk exploded");
    });
    expect(failing.state).toBe("error");
    if (failing.state === "error") expect(failing.code).toBe("HISTORY_LOAD_FAILED");
  });

  it("results contract distinguishes missing recommendation from failure", async () => {
    const empty = await loadResultsContract(async () => null);
    expect(empty.state).toBe("empty");
    const failing = await loadResultsContract(async () => {
      throw new Error("bad");
    });
    expect(failing.state).toBe("error");
    if (failing.state === "error") expect(failing.code).toBe("RESULTS_ASSEMBLY_FAILED");
    const ok = await loadResultsContract(async () => ({ contractVersion: "final-result-v1" }) as never);
    expect(ok.state).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// P — transport security limits
// ---------------------------------------------------------------------------

describe("transport security limits", () => {
  it("refuses non-loopback URLs at construction time", () => {
    expect(() => assertLoopbackUrl("ws://192.168.1.5:48765")).toThrow(/loopback-only/);
    expect(() => assertLoopbackUrl("wss://evil.example.com")).toThrow(/loopback-only/);
    expect(() => assertLoopbackUrl("http://127.0.0.1:48765")).toThrow(/ws:/);
    expect(() => assertLoopbackUrl("not a url")).toThrow();
    // Loopback hosts accepted:
    expect(() => assertLoopbackUrl("ws://127.0.0.1:48765")).not.toThrow();
    expect(() => assertLoopbackUrl("ws://localhost:48765")).not.toThrow();
  });

  it("fails closed on oversized messages instead of parsing them", () => {
    const pair = createLoopbackSocketPair();
    const errors: string[] = [];
    const source = new NativeTransportCaptureSource({
      url: "ws://127.0.0.1:48765",
      sessionToken: "tok",
      appVersion: APP_VERSION,
      socketFactory: () => pair.client,
      onError: (e) => errors.push(e.message),
    });
    pair.open();
    source.handleRawMessage("x".repeat(NATIVE_TRANSPORT_LIMITS.maxMessageChars + 1));
    expect(errors.at(-1)).toMatch(/oversized message rejected/);
    source.stop();
  });

  it("fails closed on frames exceeding the per-frame event cap", () => {
    const pair = createLoopbackSocketPair();
    const errors: string[] = [];
    const source = new NativeTransportCaptureSource({
      url: "ws://127.0.0.1:48765",
      sessionToken: "tok",
      appVersion: APP_VERSION,
      socketFactory: () => pair.client,
      onError: (e) => errors.push(e.message),
    });
    pair.open();
    const WELCOME = JSON.stringify({
      type: "welcome",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      sourceKind: "native",
      deviceId: "mouse-x",
      deviceDescription: "d",
      nominalRateHz: 1000,
      timeOriginNote: "n",
      helperVersion: EXPECTED_HELPER_VERSION,
    });
    source.handleRawMessage(WELCOME);
    const hugeFrame = JSON.stringify({
      type: "frame",
      sequence: 0,
      tMonotonicMs: 1,
      events: Array.from({ length: NATIVE_TRANSPORT_LIMITS.maxEventsPerFrame + 1 }, (_, i) => ({
        kind: "pointer-sample",
        tMs: i,
        dx: 1,
        dy: 1,
      })),
    });
    source.handleRawMessage(hugeFrame);
    expect(errors.at(-1)).toMatch(/oversized frame/);
    expect(source.counters.framesReceived).toBe(0);
    source.stop();
  });
});

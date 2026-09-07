import type { LockOutcome } from "../capture/browserSource.ts";
import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { SessionId } from "../domain/ids.ts";
import { makeSessionId } from "../domain/ids.ts";
import { scenarioById } from "../domain/scenario.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { validateTrial, DEFAULT_VALIDATION_CONFIG } from "../validation/validateTrial.ts";
import { planCandidateBlocks, type TrialPlanSpec } from "../experiments/protocol.ts";
import { SensitivityOptimizer } from "../optimizer/optimizer.ts";
import { summarizeCaptureQuality } from "../diagnostics/captureQuality.ts";
import type { Recommendation } from "../domain/recommendation.ts";
import {
  nextSessionState,
  IllegalTransitionError,
} from "./stateMachine.ts";
import type { SessionStateName } from "./types.ts";
import { assessFatigue } from "./fatigue.ts";
import { AuditLog, type AuditEntry } from "./audit.ts";
import { allocateReps, type AllocationDecision } from "./allocation.ts";
import type {
  ReplacementBlockNotice,
  SessionRunnerPorts,
  SessionProgressSnapshot,
} from "./types.ts";
import {
  assessEvidenceShortfall,
  classifyPlan,
  type CalibrationModeId,
} from "../experiments/sessionModes.ts";
import {
  RESUME_CHECKPOINT_SCHEMA_VERSION,
  buildResumePlan,
  parseResumeCheckpoint,
  type ResumeCheckpoint,
} from "./resume.ts";
import { APP_VERSION, ENGINE_VERSION, OPTIMIZER_VERSION_V4 } from "../version.ts";
import {
  assessEvidenceSufficiency,
  buildSessionOutcomeReport,
  type CalibrationProgressSnapshot,
  type SessionEndKind,
  type SessionInstrumentation,
  type SessionOutcomeReport,
} from "../results/sessionOutcome.ts";

const SEQUENCE_KEY = (round: number, seq: number): string => `${round}:${seq}`;

/**
 * What "finished" means for a session, in evidence rather than in drills.
 *
 * A calibration mode declares how many VALID measured drills each candidate
 * should end with. Running the planned drills is how the session tries to get
 * there; it is not the same thing as getting there, because a drill that
 * could not be measured produces no evidence at all.
 */
export interface EvidenceTarget {
  /** The mode this target came from, recorded for the outcome report. */
  modeId: CalibrationModeId;
  targetValidTrialsPerCandidate: number;
  /**
   * Hard ceiling on replacement blocks. The point of the ceiling is that a
   * player whose machine cannot produce valid data must not be trapped in a
   * session that keeps asking for more.
   */
  maxReplacementBlocks: number;
}

/**
 * Replacement work is additionally capped as a fraction of the plan the
 * player agreed to. Two independent limits (blocks and drills) so neither a
 * large per-block deficit nor many small ones can turn a Quick session into a
 * Precision one.
 */
const MAX_REPLACEMENT_FRACTION_OF_PLAN = 0.5;

/**
 * Round index replacement blocks run under. Far above any planned round, so a
 * replacement drill's `round:sequence` key can never collide with a planned
 * one in a resume checkpoint.
 */
const REPLACEMENT_ROUND_BASE = 1000;

/** Machine-readable reason a session ended without reaching a recommendation. */
export interface SessionAbortReason {
  code: string;
  detail: string;
}

export interface SessionRunOutcome {
  status: "complete" | "aborted";
  trials: TrialRecord[];
  auditTrail: readonly AuditEntry[];
  /**
   * Present on EVERY aborted run. rc.6 returned an aborted outcome with no
   * reason whenever the abort came from `cancel()`, so a broken break and a
   * deliberate exit were indistinguishable and both rendered as the generic
   * "Session ended · partial data was saved".
   */
  abortReason?: SessionAbortReason;
  /**
   * Always present: what happened, how far the calibration got, what evidence
   * exists, and whether that evidence supports a recommendation.
   */
  outcomeReport: SessionOutcomeReport;
  /** The optimizer's recommendation, when the run produced one. */
  recommendation: Recommendation | null;
}

export class SessionRunner {
  readonly #definition: ExperimentDefinition;
  readonly #ports: SessionRunnerPorts;
  #state: SessionStateName = "idle";
  #sessionId: SessionId | null = null;
  #completedKeys = new Set<string>();
  #phaseLog: { state: string; tIso: string; detail?: string }[] = [];
  #activeTestingMs = 0;
  #continuousTestingMs = 0;
  #measuredTrialsSinceRest: TrialRecord[] = [];
  #allTrials: TrialRecord[] = [];
  #repCounterByCandidate = new Map<string, number>();
  #blindedLabels = new Map<string, string>();
  #pauseRequested = false;
  #cancelRequested = false;
  /** Resolves the rest currently in progress early (Skip break / Space / Enter). */
  #restSkip: (() => void) | null = null;
  /** True between suspendCapture() and resumeCapture() — a break or a pause. */
  #captureSuspended = false;
  /** Set when the mouse could not be taken back after an interlude. */
  #resumeFailure: SessionAbortReason | null = null;
  readonly #audit = new AuditLog();
  #resumedFrom: ResumeCheckpoint | null = null;
  #startedAtIso = new Date().toISOString();
  #currentRound = -1;
  #pendingTrial: NonNullable<ResumeCheckpoint["interruptedTrial"]> | null = null;
  /**
   * Engine-detected abort reason (capture lost, resume refused). Kept apart
   * from a player cancel on purpose: relabelling an engine failure as "the
   * player ended it" is exactly how rc.6 hid a broken break.
   */
  #engineAbort: SessionAbortReason | null = null;
  /** Steps (warm-up + measured drills) in each round's ACTUAL plan. */
  #plannedStepsByRound = new Map<number, number>();
  /** 1-based candidate block within the current round, for progress display. */
  #blockIndexInRound = 0;
  #lastCandidateIdForProgress: string | null = null;

  /**
   * The evidence this session is trying to end with, and how far it may go to
   * get there. Absent → the historical behaviour: the plan finishes when its
   * drills finish, whatever survived validation.
   */
  readonly #evidenceTarget: EvidenceTarget | null;
  /** Replacement blocks actually run, for the outcome report. */
  #replacementBlocksRun = 0;
  #replacementDrillsRun = 0;

  constructor(
    definition: ExperimentDefinition,
    ports: SessionRunnerPorts,
    config?: { evidenceTarget?: EvidenceTarget | null },
  ) {
    this.#definition = definition;
    this.#ports = ports;
    this.#evidenceTarget = config?.evidenceTarget ?? null;
  }

  /** Bounded replacement work this session actually performed. */
  get replacementSummary(): {
    blocksRun: number;
    drillsRun: number;
    maxBlocks: number;
    maxDrills: number;
  } {
    return {
      blocksRun: this.#replacementBlocksRun,
      drillsRun: this.#replacementDrillsRun,
      maxBlocks: this.#evidenceTarget?.maxReplacementBlocks ?? 0,
      maxDrills: this.#maxReplacementDrills(),
    };
  }

  /**
   * Restores a runner from a persisted checkpoint. Throws (fail closed) on
   * corrupted or incompatible checkpoints. Completed trials are never
   * repeated; an interrupted in-progress trial is invalidated and repeated
   * with explicit audit metadata.
   */
  static resumeFrom(
    rawCheckpoint: unknown,
    definition: ExperimentDefinition,
    ports: SessionRunnerPorts,
    restoredTrials: readonly TrialRecord[],
  ): SessionRunner {
    const checkpoint = parseResumeCheckpoint(rawCheckpoint);
    const plan = buildResumePlan(checkpoint, definition);
    const runner = new SessionRunner(definition, ports);
    runner.#resumedFrom = checkpoint;
    runner.#sessionId = makeSessionId(checkpoint.sessionId.replace(/^session-/, ""));
    runner.#completedKeys = plan.completedKeys;
    runner.#phaseLog = checkpoint.phaseLog.map((e) => ({ ...e }));
    runner.#activeTestingMs = checkpoint.activeTestingMs;
    runner.#continuousTestingMs = checkpoint.continuousTestingMs;
    runner.#currentRound = Math.max(0, checkpoint.currentRound);
    runner.#startedAtIso = checkpoint.createdAtIso;
    runner.#setState("setup");
    for (const [candidateId, label] of Object.entries(checkpoint.blindedLabels)) {
      runner.#blindedLabels.set(candidateId, label);
    }
    for (const [candidateId, count] of Object.entries(checkpoint.repCounterByCandidate)) {
      runner.#repCounterByCandidate.set(candidateId, count);
    }
    for (const entry of checkpoint.auditTrail) {
      runner.#audit.restore(entry);
    }
    for (const trial of restoredTrials) {
      runner.#allTrials.push(trial);
      if (trial.phase === "measured") runner.#measuredTrialsSinceRest.push(trial);
    }

    // Prefer the EXPLICIT pre-trial pending marker written into the
    // checkpoint; fall back to audit-trail inference for older checkpoints
    // that lack it.
    const interrupted =
      checkpoint.interruptedTrial ??
      detectInterruptedTrialFromAudit(checkpoint);
    if (interrupted) {
      runner.#audit.append(runner.#ports.nowIso(), "trial-invalidated", {
        trialId: `interrupted-r${interrupted.round}-${interrupted.sequenceNumber}`,
        reasons: "INTERRUPTED_IN_PROGRESS",
        detail:
          "process ended while this trial was active; it will be repeated once with fresh data",
        candidateId: interrupted.candidateId,
        scenarioId: interrupted.scenarioId,
        round: interrupted.round,
        sequenceNumber: interrupted.sequenceNumber,
      });
    }
    runner.#audit.append(runner.#ports.nowIso(), "session-resumed", {
      sessionId: checkpoint.sessionId,
      skippedSteps: checkpoint.completedSequenceKeys.length,
      invalidatedInterruptedTrial: interrupted ? 1 : 0,
    });
    return runner;
  }
  get state(): SessionStateName {
    return this.#state;
  }

  get sessionId(): SessionId | null {
    return this.#sessionId;
  }

  get blindedLabels(): ReadonlyMap<string, string> {
    return this.#blindedLabels;
  }

  auditEntries(): readonly AuditEntry[] {
    return this.#audit.entries();
  }

  #setState(next: SessionStateName, detail?: string): void {
    const event = safeEvent(this.#state, next);
    const transitioned = nextSessionState(this.#state, event);
    if (transitioned === null && next !== this.#state) {
      throw new IllegalTransitionError(this.#state, event);
    }
    this.#state = next;
    const entry: { state: string; tIso: string; detail?: string } = {
      state: next,
      tIso: this.#ports.nowIso(),
    };
    if (detail !== undefined) entry.detail = detail;
    this.#phaseLog.push(entry);
    this.#ports.onStateChange?.(next, detail);
  }

  async run(): Promise<SessionRunOutcome> {
    if (this.#state !== "idle" && this.#state !== "setup") {
      throw new Error("runner already used");
    }
    if (this.#state === "idle") this.#setState("setup");
    if (!this.#resumedFrom) {
      this.#audit.append(this.#ports.nowIso(), "experiment-created", {
        experimentId: String(this.#definition.id),
        candidateCount: this.#definition.candidates.length,
        rounds: this.#definition.stoppingCriteria.maxSearchRounds,
      });
      this.#sessionId = makeSessionId(
        `${this.#definition.id}-${Date.now()}`.replace(/[^a-zA-Z0-9-]/g, "-"),
      );
    }

    await this.#ports.store.saveExperiment({
      ...this.#definition,
      candidates: [...this.#definition.candidates],
    });
    await this.#persistCheckpoint(this.#resumedFrom ? "running" : "running");

    const lock = await this.#executionGate();
    if (!lock.granted) {
      // Fail closed, but never silently: the reason travels into the audit
      // trail, the checkpoint phase log, and the returned abortReason so the
      // UI can show the player something actionable.
      this.#audit.append(this.#ports.nowIso(), "capture-unavailable", {
        reasonCode: lock.reasonCode,
        detail: lock.detail,
      });
      return this.#abortRun(
        `pointer lock ${lock.reasonCode}: ${lock.detail}`,
        { code: lock.reasonCode, detail: lock.detail },
        lock.reasonCode === "cancelled" ? "ended-by-player" : "capture-unavailable",
      );
    }
    this.#setState("candidate-transition", "lock acquired");

    const maxRounds = Math.max(1, this.#definition.stoppingCriteria.maxSearchRounds);
    let firstRound = this.#resumedFrom ? Math.max(0, this.#resumedFrom.currentRound) : 0;
    for (let round = firstRound; round < maxRounds; round++) {
      this.#currentRound = round;
      if (this.#cancelRequested) break;
      const allocation = this.#allocationForRound(round);
      const plan = planCandidateBlocks(this.#definition, round, undefined, allocation);
      // The plan for a round is only knowable once adaptive allocation has
      // run, so the denominator is refined round by round. Recording the
      // ACTUAL length (rather than a constant guess) is what keeps the
      // "Calibration NN %" readout truthful.
      this.#plannedStepsByRound.set(round, plan.length);
      this.#blockIndexInRound = 0;
      this.#lastCandidateIdForProgress = null;
      this.#emitCalibrationProgress();
      const remaining = plan.filter(
        (spec) => !this.#completedKeys.has(SEQUENCE_KEY(round, spec.sequenceNumber)),
      );
      if (plan.length === 0 && round > 0) break;
      await this.#runPlan(remaining, round);

      const measuredTotal = this.#allTrials.filter((t) => t.phase === "measured").length;
      if (
        measuredTotal >= this.#definition.stoppingCriteria.maxTotalMeasuredTrials ||
        this.#cancelRequested
      ) {
        break;
      }
      firstRound = round + 1;
    }

    if (this.#cancelRequested) {
      if (this.#resumeFailure) {
        return this.#abortRun(
          `capture could not be resumed: ${this.#resumeFailure.detail}`,
          this.#resumeFailure,
          "resume-failed",
        );
      }
      if (this.#engineAbort) {
        return this.#abortRun(
          `session aborted: ${this.#engineAbort.detail}`,
          this.#engineAbort,
          "capture-lost",
        );
      }
      // A player cancel is still an explicit outcome, and it still carries a
      // reason. An aborted run with no reason at all is what let rc.6 render
      // a broken session as an ordinary finish.
      return this.#abortRun(
        "cancelled by user",
        {
          code: "cancelled",
          detail: "you ended the session from the arena controls",
        },
        "ended-by-player",
      );
    }

    // Evidence, not drill count, decides whether the session is finished.
    // A plan that ran to its end but lost measurements to unusable data gets
    // a BOUNDED top-up rather than either shipping short evidence or asking
    // the player to start over.
    await this.#runReplacementBlocks();

    this.#setState("analyzing");
    const { recommendation } = await this.#analyze();
    this.#setState("complete");
    await this.#persistCheckpoint("complete");
    await this.#ports.execution.releaseCapture();
    return {
      status: "complete",
      trials: this.#allTrials,
      auditTrail: this.auditEntries(),
      recommendation,
      outcomeReport: buildSessionOutcomeReport({
        definition: this.#definition,
        trials: this.#allTrials,
        endKind: "completed",
        progress: this.calibrationProgress(),
        recommendation,
        instrumentation: this.#instrumentation(),
      }),
    };
  }

  #maxReplacementDrills(): number {
    const target = this.#evidenceTarget;
    if (!target) return 0;
    const plannedMeasured =
      this.#definition.candidates.length *
      this.#definition.measuredRepsPerCandidatePerRound *
      Math.max(1, this.#definition.stoppingCriteria.maxSearchRounds);
    return Math.ceil(plannedMeasured * MAX_REPLACEMENT_FRACTION_OF_PLAN);
  }

  /**
   * Tops the session up to its mode's evidence target, within hard bounds.
   *
   * Four independent stops, so this can never become an open-ended chase:
   *
   *  1. the mode's `maxReplacementBlocks`;
   *  2. a drill budget of half the plan the player agreed to;
   *  3. the experiment's own `maxTotalMeasuredTrials`;
   *  4. PROGRESS — a block that produces no new valid measurement ends the
   *     phase immediately. If the machine cannot produce usable data, running
   *     the same drills again will not change that, and the results screen is
   *     a better place to say so than another five minutes of drills.
   *
   * A cancel, an engine abort or a failed resume during a replacement block
   * ends the phase like any other; nothing here can keep a session alive that
   * the player or the hardware has ended.
   */
  async #runReplacementBlocks(): Promise<void> {
    const target = this.#evidenceTarget;
    if (!target || this.#cancelRequested) return;
    const drillBudget = this.#maxReplacementDrills();

    for (let block = 0; block < target.maxReplacementBlocks; block++) {
      if (this.#cancelRequested) return;
      const shortfall = assessEvidenceShortfall(
        this.#definition,
        this.#allTrials,
        target.targetValidTrialsPerCandidate,
      );
      if (shortfall.satisfied) return;

      const measuredSoFar = this.#allTrials.filter((t) => t.phase === "measured").length;
      const remainingByExperiment = Math.max(
        0,
        this.#definition.stoppingCriteria.maxTotalMeasuredTrials - measuredSoFar,
      );
      const remainingByBudget = Math.max(0, drillBudget - this.#replacementDrillsRun);
      const allowance = Math.min(
        shortfall.totalDeficit,
        remainingByBudget,
        remainingByExperiment,
      );
      if (allowance <= 0) return;

      // Deficits are honoured largest-first so a candidate that lost the most
      // measurements is refilled first when the allowance cannot cover
      // everything — the alternative (proportional shaving) leaves every
      // candidate short and the comparison still unpowered.
      const ordered = [...shortfall.deficits.entries()].sort((a, b) => b[1] - a[1]);
      const allocation = new Map<string, number>();
      let assigned = 0;
      for (const [candidateId, needed] of ordered) {
        if (assigned >= allowance) break;
        const take = Math.min(needed, allowance - assigned);
        allocation.set(candidateId, take);
        assigned += take;
      }
      if (assigned === 0) return;

      const notice: ReplacementBlockNotice = {
        blockIndex: this.#replacementBlocksRun + 1,
        maxBlocks: target.maxReplacementBlocks,
        drills: assigned,
        perCandidate: [...allocation.entries()].map(([candidateId, needed]) => ({
          candidateId,
          blindedLabel: this.#blindLabelFor(candidateId),
          needed,
        })),
        reason:
          assigned === 1
            ? "1 additional drill needed because a measurement could not be used"
            : `${assigned} additional drills needed because some measurements could not be used`,
      };
      this.#audit.append(this.#ports.nowIso(), "replacement-block-started", {
        blockIndex: notice.blockIndex,
        maxBlocks: notice.maxBlocks,
        drills: assigned,
        targetValidPerCandidate: target.targetValidTrialsPerCandidate,
        mode: target.modeId,
      });
      this.#ports.onReplacementBlock?.(notice);

      // Replacement drills run under a distinct round index so their sequence
      // keys can never collide with the planned rounds' — a resumed session
      // must not mistake a replacement drill for a planned one.
      const round = REPLACEMENT_ROUND_BASE + this.#replacementBlocksRun;
      this.#currentRound = round;
      const validBefore = this.#validMeasuredCount();
      const plan = planCandidateBlocks(
        this.#definition,
        round,
        [...allocation.keys()],
        allocation,
      ).filter((spec) => spec.phase === "measured");
      this.#plannedStepsByRound.set(round, plan.length);
      this.#blockIndexInRound = 0;
      this.#lastCandidateIdForProgress = null;
      this.#emitCalibrationProgress();
      await this.#runPlan(plan, round);

      this.#replacementBlocksRun++;
      this.#replacementDrillsRun += plan.length;
      const gained = this.#validMeasuredCount() - validBefore;
      this.#audit.append(this.#ports.nowIso(), "replacement-block-finished", {
        blockIndex: notice.blockIndex,
        drillsRun: plan.length,
        validGained: gained,
      });
      if (gained <= 0) {
        // Nothing usable came back. Another identical block cannot help.
        this.#audit.append(this.#ports.nowIso(), "replacement-stopped", {
          reason: "a replacement block produced no usable measurement",
        });
        return;
      }
    }
  }

  /**
   * The capture source that produced these trials, keyed per trial so the
   * quality summary can report (and flag) a mid-session source change. One
   * source per session today; the map is the shape the summary expects.
   */
  #captureSourceKindMap(): {
    captureSourceKindsByTrialId?: ReadonlyMap<string, string>;
  } {
    const kind = this.#ports.captureSourceMetadata?.()?.kind;
    if (!kind) return {};
    return {
      captureSourceKindsByTrialId: new Map(
        this.#allTrials.map((t) => [t.id as string, kind]),
      ),
    };
  }

  #validMeasuredCount(): number {
    return this.#allTrials.filter(
      (t) => t.phase === "measured" && t.validity.status === "valid",
    ).length;
  }

  /**
   * Runs the optimizer over everything measured so far and persists a
   * recommendation ONLY when the evidence supports one.
   *
   * A session that stopped short still gets analysed — the player must be able
   * to see what their partial data says — but an under-powered run must not
   * leave a bogus eDPI sitting in History as if it were a finding.
   */
  async #analyze(): Promise<{
    recommendation: Recommendation | null;
    sufficient: boolean;
  }> {
    const measured = this.#allTrials.filter((t) => t.phase === "measured");
    if (measured.length === 0) {
      this.#audit.append(this.#ports.nowIso(), "evidence-insufficient", {
        reason: "no measured trials were completed",
        measuredTrials: 0,
      });
      return { recommendation: null, sufficient: false };
    }
    // Capture quality is GRADED FROM THIS SESSION'S OWN RECORDED STREAM.
    //
    // The engine has always been able to do this; nothing ever asked it to,
    // so every live session reached the results page saying "Capture quality:
    // Not graded for this session — run the capture check in Diagnostics
    // before your next test". That told a player to prepare for a session
    // that had already happened, and left the optimizer's capture-quality
    // confidence cap permanently disarmed.
    const captureQualitySession = summarizeCaptureQuality({
      trials: this.#allTrials,
      ...this.#captureSourceKindMap(),
    });
    const optimizer = new SensitivityOptimizer(this.#definition, {
      captureQualitySession,
    });
    for (const trial of this.#allTrials) optimizer.addTrials([trial]);
    const recommendation = optimizer.recommend();
    const sufficiency = assessEvidenceSufficiency(
      this.#definition,
      this.#allTrials,
      recommendation,
    );
    if (!sufficiency.sufficient) {
      this.#audit.append(this.#ports.nowIso(), "evidence-insufficient", {
        reason: sufficiency.reasons.join(" | ").slice(0, 400),
        measuredTrials: measured.length,
        moreMeasuredTrialsNeeded: sufficiency.additionalMeasuredTrialsNeeded,
      });
      return { recommendation, sufficient: false };
    }
    for (const line of recommendation.rationaleLines.slice(0, 3)) {
      this.#audit.append(this.#ports.nowIso(), "recommendation-created", {
        edpi: Math.round(recommendation.recommendedEdpi),
        confidence: Number(recommendation.confidence.toFixed(3)),
        note: line,
      });
    }
    await this.#ports.store.saveRecommendation(recommendation);
    await this.#ports.store.saveOptimizerRun({
      experimentId: this.#definition.id,
      optimizerVersion: OPTIMIZER_VERSION_V4,
      schemaVersion: 1,
      utilityWeights: recommendation.utilityWeights as unknown as Record<string, number>,
      config: {},
    });
    return { recommendation, sufficient: true };
  }

  /**
   * Where this session sits in its own plan. Rounds that have not been planned
   * yet are estimated from the first round's actual length — the only honest
   * estimate available before adaptive allocation runs — and the estimate is
   * replaced with the real number the moment that round is planned.
   */
  calibrationProgress(): CalibrationProgressSnapshot {
    const d = this.#definition;
    const roundsPlanned = Math.max(1, d.stoppingCriteria.maxSearchRounds);
    const perRoundFallback =
      this.#plannedStepsByRound.get(0) ??
      d.candidates.length *
        (d.warmupTrialsPerCandidateBlock + d.measuredRepsPerCandidatePerRound);
    let stepsPlanned = 0;
    for (let round = 0; round < roundsPlanned; round++) {
      stepsPlanned += this.#plannedStepsByRound.get(round) ?? perRoundFallback;
    }
    // Replacement blocks are real planned work; leaving them out of the
    // denominator would show "Calibration 100 %" while drills were still
    // running.
    for (const [round, steps] of this.#plannedStepsByRound) {
      if (round >= REPLACEMENT_ROUND_BASE) stepsPlanned += steps;
    }
    const stepsCompleted = this.#allTrials.length;
    const measuredCompleted = this.#allTrials.filter(
      (t) => t.phase === "measured",
    ).length;
    const measuredPlanned = Math.min(
      d.candidates.length * d.measuredRepsPerCandidatePerRound * roundsPlanned +
        this.#replacementDrillsRun,
      d.stoppingCriteria.maxTotalMeasuredTrials,
    );
    return {
      stepsCompleted,
      stepsPlanned: Math.max(stepsPlanned, stepsCompleted),
      fraction:
        stepsPlanned > 0 ? Math.min(1, stepsCompleted / stepsPlanned) : 0,
      roundIndex: Math.min(roundsPlanned, Math.max(1, this.#currentRound + 1)),
      roundsPlanned,
      blockIndex: Math.max(1, this.#blockIndexInRound),
      blocksPerRound: d.candidates.length,
      measuredCompleted,
      measuredPlanned,
    };
  }

  #emitCalibrationProgress(): void {
    this.#ports.onCalibrationProgress?.(this.calibrationProgress());
  }

  async #executionGate(): Promise<LockOutcome> {
    // A cancel that arrived during setup must be honoured before the player
    // is asked for the mouse at all.
    if (this.#cancelRequested) {
      return {
        granted: false,
        reasonCode: "cancelled",
        detail: "the session was ended before capture was requested",
      };
    }
    this.#setState("awaiting-lock");
    const outcome = await this.#ports.execution.requestLock();
    if (this.#cancelRequested) {
      return {
        granted: false,
        reasonCode: "cancelled",
        detail: "the session was ended while capture was being requested",
      };
    }
    return outcome;
  }

  async #runPlan(plan: readonly TrialPlanSpec[], round: number): Promise<void> {
    let lastCandidateId: string | null = null;
    for (const spec of plan) {
      if (this.#cancelRequested) return;
      await this.#awaitIfPaused();

      if (lastCandidateId !== null && spec.candidateId !== lastCandidateId) {
        // A zero-length break (auto breaks off) is not a break: no rest state,
        // no overlay, straight to the next block.
        if (this.#definition.restBetweenCandidatesMs > 0) {
          this.#setState("rest", "between candidate blocks");
          await this.#rest(this.#definition.restBetweenCandidatesMs, "candidate-transition");
        }
        this.#continuousTestingMs = 0;
        this.#measuredTrialsSinceRest = [];
        this.#setState("candidate-transition");
      }
      lastCandidateId = spec.candidateId;
      if (spec.candidateId !== this.#lastCandidateIdForProgress) {
        this.#lastCandidateIdForProgress = spec.candidateId;
        this.#blockIndexInRound++;
      }

      const scenario = scenarioById(spec.scenarioId);
      const label = this.#blindLabelFor(spec.candidateId);

      if (spec.phase === "warmup") {
        this.#setState("warmup", `${label} · ${scenario.label}`);
      } else {
        const fatigue = assessFatigue(
          this.#definition.fatigueProtocol,
          this.#measuredTrialsSinceRest,
          this.#continuousTestingMs,
        );
        if (fatigue.shouldRest) {
          this.#setState("rest", fatigue.reason ?? "fatigue protocol");
          await this.#rest(
            this.#definition.fatigueProtocol.restDurationMs,
            fatigue.reason ?? "fatigue",
          );
          this.#continuousTestingMs = 0;
          this.#measuredTrialsSinceRest = [];
          this.#setState("inter-trial", "fatigue rest finished");
        }
        this.#setState("trial-ready", `${label} · ${scenario.label}`);
      }

      // The PAIRING index, not a per-candidate running counter: it is what
      // makes two candidates' comparable drills land in the same paired cell
      // and receive the same target layout (src/experiments/protocol.ts).
      // The running counter survives only so existing checkpoints keep
      // restoring, and so a plan built before pairIndex existed still runs.
      const counterIndex =
        spec.phase === "measured" ? this.#nextRepIndex(spec.candidateId) : null;
      const repIndex =
        spec.phase === "measured" ? (spec.pairIndex ?? counterIndex) : null;

      // Pre-trial checkpoint WITH the pending-trial marker: if the process
      // dies mid-trial, the persisted state names exactly which trial was in
      // flight so resume can invalidate-and-repeat it explicitly.
      this.#pendingTrial = {
        candidateId: spec.candidateId,
        scenarioId: spec.scenarioId,
        phase: spec.phase,
        round,
        sequenceNumber: spec.sequenceNumber,
      };
      await this.#persistCheckpoint("running");

      const startedAt = this.#ports.clock.nowMs();
      this.#setState("trial-active");
      this.#audit.append(this.#ports.nowIso(), "trial-started", {
        candidateId: spec.candidateId,
        scenarioId: spec.scenarioId,
        phase: spec.phase,
        round,
        repIndex: repIndex ?? -1,
        sequenceNumber: spec.sequenceNumber,
      });
      const record = await this.#ports.execution.executeTrial(spec, round, repIndex);
      record.scenarioRepIndex = repIndex;
      this.#audit.append(this.#ports.nowIso(), "trial-ended", {
        trialId: record.id,
        outcome: record.outcome,
        validityStatus: record.validity.status,
      });
      if (record.validity.status !== "valid") {
        this.#audit.append(this.#ports.nowIso(), "trial-invalidated", {
          trialId: record.id,
          reasons: record.validity.reasons.map((r) => r.code).join("+"),
        });
      }
      const elapsed = this.#ports.clock.nowMs() - startedAt;
      this.#activeTestingMs += Math.max(0, Math.min(elapsed, scenario.timeoutMs * 3));
      if (spec.phase === "measured") {
        this.#continuousTestingMs += Math.max(0, Math.min(elapsed, scenario.timeoutMs * 3));
      }

      validateTrial(record, DEFAULT_VALIDATION_CONFIG, {
        sensitivity: this.#sensitivityFor(record.candidateId),
        dpi: this.#definition.dpi,
      });

      await this.#ports.store.saveTrial(this.#definition.id, record);
      this.#allTrials.push(record);
      this.#completedKeys.add(SEQUENCE_KEY(round, spec.sequenceNumber));
      this.#pendingTrial = null;
      await this.#persistCheckpoint("running");
      this.#ports.onTrialPersisted?.(record);
      this.#emitCalibrationProgress();

      this.#setState("inter-trial", outcomeDetail(record));
      await this.#ports.sleep(this.#interTrialDelayMs(scenario));
      if (spec.phase === "measured") {
        this.#measuredTrialsSinceRest.push(record);
      }
    }
  }

  #interTrialDelayMs(scenario: ReturnType<typeof scenarioById>): number {
    return scenario.kind === "tracking" ? 1200 : 700;
  }

  #sensitivityFor(candidateId: string | null) {
    if (!candidateId) return undefined;
    return this.#definition.candidates.find((c) => c.id === candidateId)?.sensitivity;
  }

  #blindLabelFor(candidateId: string): string {
    if (!this.#blindedLabels.has(candidateId)) {
      const index = this.#blindedLabels.size;
      this.#blindedLabels.set(candidateId, `Candidate ${String.fromCharCode(65 + index)}`);
    }
    return this.#blindedLabels.get(candidateId)!;
  }

  #nextRepIndex(candidateId: string): number {
    const index = this.#repCounterByCandidate.get(candidateId) ?? 0;
    this.#repCounterByCandidate.set(candidateId, index + 1);
    return index;
  }

  #allocationForRound(round: number): Map<string, number> | undefined {
    const config = this.#definition.adaptiveAllocation;
    if (!config.enabled || round === 0) return undefined;
    const byCandidate = new Map<string, TrialRecord[]>();
    for (const trial of this.#allTrials) {
      if (trial.phase !== "measured" || !trial.candidateId) continue;
      const list = byCandidate.get(trial.candidateId) ?? [];
      list.push(trial);
      byCandidate.set(trial.candidateId, list);
    }
    const allHaveMinimum = this.#definition.candidates.every(
      (c) => (byCandidate.get(c.id)?.length ?? 0) >= config.minRepsBeforeAdaptive,
    );
    if (!allHaveMinimum) return undefined;

    // Allocation only reads per-candidate evaluations and paired
    // comparisons, so it deliberately does NOT pass a capture-quality
    // summary: allocation must not change because the stream was noisy.
    const optimizer = new SensitivityOptimizer(this.#definition);
    for (const trial of this.#allTrials) optimizer.addTrials([trial]);
    const decisions: AllocationDecision[] = allocateReps({
      candidates: this.#definition.candidates,
      evaluations: optimizer.evaluations(),
      pairedComparisons: optimizer.pairedComparisons(),
      minRepsBeforeAdaptive: config.minRepsBeforeAdaptive,
      repsThisRound: this.#definition.measuredRepsPerCandidatePerRound,
      trialsSoFarPerCandidate: new Map(
        [...byCandidate.entries()].map(([id, trials]) => [id, trials.length]),
      ),
      maxTotalMeasuredTrials: this.#definition.stoppingCriteria.maxTotalMeasuredTrials,
      controlRefreshEveryRounds: config.controlRefreshEveryRounds,
      roundIndex: round,
    });
    const allocation = new Map<string, number>();
    for (const decision of decisions) {
      allocation.set(decision.candidateId, decision.reps);
      this.#audit.append(this.#ports.nowIso(), "adaptive-allocation-decision", {
        candidateId: decision.candidateId,
        reps: decision.reps,
        reason: decision.reason,
      });
    }
    return allocation;
  }

  pause(): void {
    this.#pauseRequested = true;
  }

  resume(): void {
    this.#pauseRequested = false;
  }

  /** The player asked to leave. Always an honest, named outcome. */
  cancel(): void {
    this.#cancelRequested = true;
    this.#pauseRequested = false;
    // Never make the player wait out a break to leave.
    this.#restSkip?.();
  }

  /**
   * The ENGINE cannot continue: capture was lost mid-session, or something
   * else made further measurement impossible.
   *
   * Separate from `cancel()` on purpose. rc.6 routed every internal failure
   * through `cancel()`, which produced an aborted run with no reason at all —
   * so a break that broke the session and a player pressing "End session"
   * were literally the same outcome object, and both were rendered as
   * "Session ended · partial data was saved".
   */
  abort(reason: SessionAbortReason): void {
    if (this.#engineAbort === null) this.#engineAbort = reason;
    this.#audit.append(this.#ports.nowIso(), "session-aborted", {
      code: reason.code,
      detail: reason.detail,
    });
    this.cancel();
  }

  /** The engine-detected abort reason, if one has been raised. */
  get engineAbortReason(): SessionAbortReason | null {
    return this.#engineAbort;
  }

  /**
   * Ends the break in progress now. Breaks protect measurement quality, but
   * they are the player's to take: a rest the player did not want is idle
   * time, not recovery. The audit trail records that it was skipped and how
   * much of it was used.
   */
  skipRest(): void {
    this.#restSkip?.();
  }

  /** True while a rest is in progress and can be skipped. */
  get resting(): boolean {
    return this.#restSkip !== null;
  }

  /**
   * A skippable wait. Resolves when `durationMs` elapses, when skipRest() is
   * called, or when the session is cancelled — whichever comes first.
   */
  async #rest(durationMs: number, reason: string): Promise<void> {
    // THE MOUSE COMES BACK FIRST. The break screen offers "Skip break" and the
    // bottom bar offers Pause / End session; every one of them is unreachable
    // while the arena still owns the pointer. Releasing before the overlay is
    // shown — not after, not on a timer — is what makes the break skippable
    // with a mouse at all.
    await this.#suspendCapture(`rest:${reason}`);
    this.#audit.append(this.#ports.nowIso(), "rest-started", { reason, durationMs });
    this.#ports.onRest?.({ durationMs, reason, skippable: true });
    const startedAt = this.#ports.clock.nowMs();
    let skipped = false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (viaSkip: boolean): void => {
        if (settled) return;
        settled = true;
        skipped = viaSkip;
        this.#restSkip = null;
        resolve();
      };
      this.#restSkip = () => finish(true);
      void this.#ports.sleep(durationMs).then(() => finish(false));
    });
    const usedMs = Math.max(0, this.#ports.clock.nowMs() - startedAt);
    this.#audit.append(this.#ports.nowIso(), "rest-ended", {
      skipped: skipped ? 1 : 0,
      usedMs: Math.round(usedMs),
      plannedMs: durationMs,
    });
    this.#ports.onRest?.(null);
    await this.#resumeCapture(`rest:${reason}`);
  }

  async #awaitIfPaused(): Promise<void> {
    if (!this.#pauseRequested) return;
    const resumeState = this.#state;
    // A pause is an interlude too: the Resume control lives in the bottom bar,
    // which the player cannot reach while the arena holds the pointer. Same
    // cleanup as a break, deliberately — one path, one guarantee.
    await this.#suspendCapture("pause");
    this.#setState("paused");
    while (this.#pauseRequested && !this.#cancelRequested) {
      await this.#ports.sleep(50);
    }
    if (!this.#cancelRequested) {
      await this.#resumeCapture("pause");
      this.#forceState(resumeState === "paused" ? "inter-trial" : resumeState);
    }
  }

  /**
   * Hands the mouse back for an interlude. Recorded in the audit trail so a
   * session's transcript shows exactly when the player had the cursor.
   */
  async #suspendCapture(reason: string): Promise<void> {
    if (this.#captureSuspended) return;
    this.#captureSuspended = true;
    await this.#ports.execution.suspendCapture(reason);
    this.#audit.append(this.#ports.nowIso(), "capture-suspended", { reason });
  }

  /**
   * Takes the mouse back after an interlude. A refusal ends the session with a
   * named reason rather than dropping the player into drills that cannot
   * record anything — but a cancel is not a refusal, it is the player leaving.
   */
  async #resumeCapture(reason: string): Promise<void> {
    if (!this.#captureSuspended) return;
    // Ending the session during a break: there is nothing to take back, and
    // asking would turn a deliberate exit into a "capture failed" report.
    if (this.#cancelRequested) {
      this.#captureSuspended = false;
      return;
    }
    const outcome = await this.#ports.execution.resumeCapture(reason);
    this.#captureSuspended = false;
    this.#audit.append(this.#ports.nowIso(), "capture-resumed", {
      reason,
      reasonCode: outcome.reasonCode,
      granted: outcome.granted ? 1 : 0,
    });
    if (!outcome.granted && !this.#cancelRequested) {
      this.#audit.append(this.#ports.nowIso(), "capture-unavailable", {
        reasonCode: outcome.reasonCode,
        detail: outcome.detail,
      });
      this.#cancelRequested = true;
      this.#resumeFailure = {
        code: outcome.reasonCode,
        detail: outcome.detail,
      };
    }
  }

  #forceState(state: SessionStateName): void {
    this.#state = state;
    this.#phaseLog.push({ state, tIso: this.#ports.nowIso() });
    this.#ports.onStateChange?.(state);
  }

  async #abortRun(
    reason: string,
    abortReason: SessionAbortReason,
    endKind: SessionEndKind,
  ): Promise<SessionRunOutcome> {
    this.#cancelRequested = true;
    // Everything measured before the abort is still evidence, and the player
    // is entitled to see what it says. Analysis persists a recommendation
    // only when the evidence actually supports one.
    let recommendation: Recommendation | null = null;
    try {
      recommendation = (await this.#analyze()).recommendation;
    } catch {
      // A failed analysis must never turn an explained abort into a crash;
      // the outcome report simply reports no recommendation.
      recommendation = null;
    }
    this.#forceState("aborted");
    this.#phaseLog.push({ state: "aborted-detail", tIso: this.#ports.nowIso(), detail: reason });
    await this.#persistCheckpoint("aborted");
    await this.#ports.execution.releaseCapture().catch(() => undefined);
    return {
      status: "aborted",
      trials: this.#allTrials,
      auditTrail: this.auditEntries(),
      abortReason,
      recommendation,
      outcomeReport: buildSessionOutcomeReport({
        definition: this.#definition,
        trials: this.#allTrials,
        endKind,
        abortReason,
        progress: this.calibrationProgress(),
        recommendation,
        instrumentation: this.#instrumentation(),
      }),
    };
  }

  /** Shell-supplied diagnostics, plus the plan facts only the runner knows. */
  #instrumentation(): Partial<SessionInstrumentation> {
    const target = this.#evidenceTarget;
    return {
      ...(this.#ports.sessionInstrumentation?.() ?? {}),
      modeId: target?.modeId ?? classifyPlan({
        rounds: Math.max(1, this.#definition.stoppingCriteria.maxSearchRounds),
        measuredRepsPerCandidatePerRound:
          this.#definition.measuredRepsPerCandidatePerRound,
        warmupTrialsPerCandidateBlock:
          this.#definition.warmupTrialsPerCandidateBlock,
      }),
      targetValidTrialsPerCandidate: target?.targetValidTrialsPerCandidate ?? null,
      replacement: target ? this.replacementSummary : null,
    };
  }

  async #persistCheckpoint(status: "running" | "complete" | "aborted"): Promise<void> {
    if (!this.#sessionId) return;
    const checkpoint: ResumeCheckpoint = {
      schemaVersion: RESUME_CHECKPOINT_SCHEMA_VERSION,
      kind: "session-resume",
      sessionId: this.#sessionId,
      experimentId: this.#definition.id,
      status,
      updatedAtIso: this.#ports.nowIso(),
      createdAtIso: this.#startedAtIso,
      completedSequenceKeys: [...this.#completedKeys].sort(),
      currentRound: this.#currentRound,
      phaseLog: [...this.#phaseLog],
      activeTestingMs: this.#activeTestingMs,
      continuousTestingMs: this.#continuousTestingMs,
      restCount: 0,
      blindedLabels: Object.fromEntries(this.#blindedLabels),
      repCounterByCandidate: Object.fromEntries(this.#repCounterByCandidate),
      completedTrialIds: this.#allTrials.map((t) => t.id),
      auditTrail: [...this.#audit.entries()],
      captureSource: this.#ports.captureSourceMetadata?.() ?? null,
      playerId: this.#ports.playerIdentity?.().playerId ?? null,
      playerName: this.#ports.playerIdentity?.().playerName ?? null,
      dpi: this.#definition.dpi,
      retestOfExperimentId: this.#definition.notes?.match(/retest of (\S+)/)?.[1] ?? null,
      calibrationRecordIdsX: [],
      calibrationRecordIdsY: [],
      appVersion: APP_VERSION,
      engineVersion: ENGINE_VERSION,
      optimizerVersion: OPTIMIZER_VERSION_V4,
      interruptedTrial:
        this.#pendingTrial ??
        detectInterruptedTrialFromAudit({
          auditTrail: [...this.#audit.entries()],
        }),
      lastValidState: this.#state,
    };
    await this.#ports.store.saveRaw(
      "session-checkpoint",
      `sessions/checkpoints/${this.#sessionId}.json`,
      checkpoint,
    );
  }

  progressSnapshot(round: number, detail: string | null): SessionProgressSnapshot {
    const totalPlanned = this.#definition.stoppingCriteria.maxTotalMeasuredTrials;
    return {
      state: this.#state,
      round,
      blindedCandidateLabel:
        this.#blindedLabels.get([...this.#blindedLabels.keys()].at(-1) ?? "") ?? "—",
      scenarioInstruction: detail ?? "",
      measuredCompleted: this.#allTrials.filter((t) => t.phase === "measured").length,
      measuredPlannedUpperBound: totalPlanned,
      lastEventDetail: detail,
    };
  }
}

/**
 * A trial whose "trial-started" audit entry has no matching "trial-ended"
 * indicates the process died mid-trial. Deterministic pure function so the
 * UI preview and the runner agree exactly.
 */
export function detectInterruptedTrialFromAudit(
  checkpoint: Pick<ResumeCheckpoint, "auditTrail">,
): ResumeCheckpoint["interruptedTrial"] {
  const started = [...checkpoint.auditTrail]
    .filter((e) => e.category === "trial-started")
    .map((e) => ({
      seq: e.seq,
      candidateId: String(e.detail.candidateId ?? ""),
      scenarioId: String(e.detail.scenarioId ?? ""),
      phase: String(e.detail.phase ?? ""),
      round: Number(e.detail.round ?? -1),
      sequenceNumber: Number(e.detail.sequenceNumber ?? -1),
    }));
  if (started.length === 0) return null;
  const lastStarted = started[started.length - 1]!;
  const endedSeqs = new Set(
    checkpoint.auditTrail
      .filter((e) => e.category === "trial-ended")
      .map((e) => e.seq),
  );
  // A trial-ended always follows its trial-started directly in our runner.
  // If ANY trial-ended exists at a seq greater than lastStarted.seq, nothing
  // is pending; otherwise the last started trial never finished.
  const anyEndAfterLastStart = [...endedSeqs].some((seq) => seq > lastStarted.seq);
  if (anyEndAfterLastStart || endedSeqs.size >= started.length) return null;
  return {
    candidateId: lastStarted.candidateId,
    scenarioId: lastStarted.scenarioId,
    phase: lastStarted.phase,
    round: lastStarted.round,
    sequenceNumber: lastStarted.sequenceNumber,
  };
}

function outcomeDetail(record: TrialRecord): string {
  switch (record.outcome) {
    case "hit":
      return "hit";
    case "miss-shot-fired":
      return "missed";
    case "timeout-no-shot":
      return "target expired";
    case "tracking-complete":
      return "tracking complete";
    case "aborted":
      return "aborted";
  }
}

function safeEvent(from: SessionStateName, to: SessionStateName): Parameters<typeof nextSessionState>[1] {
  try {
    return guessEvent(from, to);
  } catch {
    return "CANCEL";
  }
}

function guessEvent(
  from: SessionStateName,
  to: SessionStateName,
): Parameters<typeof nextSessionState>[1] {
  const table: Record<string, Parameters<typeof nextSessionState>[1]> = {
    "idle→setup": "CONFIGURE",
    "setup→awaiting-lock": "REQUEST_LOCK",
    "awaiting-lock→candidate-transition": "LOCK_ACQUIRED",
    "awaiting-lock→setup": "LOCK_LOST",
    "candidate-transition→warmup": "BEGIN_WARMUP",
    "candidate-transition→trial-ready": "TRIAL_ANNOUNCED",
    "candidate-transition→analyzing": "ALL_TRIALS_DONE",
    "warmup→trial-ready": "WARMUP_ENDED",
    "warmup→trial-active": "TRIAL_STARTED",
    "trial-ready→trial-active": "TRIAL_STARTED",
    "trial-active→inter-trial": "TRIAL_COMPLETED",
    "inter-trial→rest": "REST_STARTED",
    "rest→inter-trial": "REST_ENDED",
    "inter-trial→trial-ready": "NEXT_TRIAL_READY",
    "inter-trial→candidate-transition": "CANDIDATE_BLOCK_DONE",
    "inter-trial→analyzing": "ALL_TRIALS_DONE",
    "analyzing→complete": "ANALYSIS_COMPLETE",
    "*→paused": "PAUSE",
    "paused→inter-trial": "RESUME",
    "*→aborted": "CANCEL",
  };
  const direct = table[`${from}→${to}`];
  if (direct) return direct;
  if (to === "aborted") return "CANCEL";
  if (to === "paused") return "PAUSE";
  if (to === from) return "CONFIGURE";
  throw new Error(`no event mapping for ${from}→${to}`);
}

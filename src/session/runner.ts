import type { LockOutcome } from "../capture/browserSource.ts";
import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { SessionId } from "../domain/ids.ts";
import { makeSessionId } from "../domain/ids.ts";
import { scenarioById } from "../domain/scenario.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { validateTrial, DEFAULT_VALIDATION_CONFIG } from "../validation/validateTrial.ts";
import { planCandidateBlocks, type TrialPlanSpec } from "../experiments/protocol.ts";
import { SensitivityOptimizer } from "../optimizer/optimizer.ts";
import {
  nextSessionState,
  IllegalTransitionError,
} from "./stateMachine.ts";
import type { SessionStateName } from "./types.ts";
import { assessFatigue } from "./fatigue.ts";
import { AuditLog, type AuditEntry } from "./audit.ts";
import { allocateReps, type AllocationDecision } from "./allocation.ts";
import type {
  SessionRunnerPorts,
  SessionProgressSnapshot,
} from "./types.ts";
import {
  RESUME_CHECKPOINT_SCHEMA_VERSION,
  buildResumePlan,
  parseResumeCheckpoint,
  type ResumeCheckpoint,
} from "./resume.ts";
import { APP_VERSION, ENGINE_VERSION, OPTIMIZER_VERSION_V4 } from "../version.ts";

const SEQUENCE_KEY = (round: number, seq: number): string => `${round}:${seq}`;

/** Machine-readable reason a session ended without reaching a recommendation. */
export interface SessionAbortReason {
  code: string;
  detail: string;
}

export interface SessionRunOutcome {
  status: "complete" | "aborted";
  trials: TrialRecord[];
  auditTrail: readonly AuditEntry[];
  /** Present only when the run aborted for a reason the UI must explain. */
  abortReason?: SessionAbortReason;
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
  readonly #audit = new AuditLog();
  #resumedFrom: ResumeCheckpoint | null = null;
  #startedAtIso = new Date().toISOString();
  #currentRound = -1;
  #pendingTrial: NonNullable<ResumeCheckpoint["interruptedTrial"]> | null = null;

  constructor(definition: ExperimentDefinition, ports: SessionRunnerPorts) {
    this.#definition = definition;
    this.#ports = ports;
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
      return this.#abortRun(`pointer lock ${lock.reasonCode}: ${lock.detail}`, {
        code: lock.reasonCode,
        detail: lock.detail,
      });
    }
    this.#setState("candidate-transition", "lock acquired");

    const maxRounds = Math.max(1, this.#definition.stoppingCriteria.maxSearchRounds);
    let firstRound = this.#resumedFrom ? Math.max(0, this.#resumedFrom.currentRound) : 0;
    for (let round = firstRound; round < maxRounds; round++) {
      this.#currentRound = round;
      if (this.#cancelRequested) break;
      const allocation = this.#allocationForRound(round);
      const plan = planCandidateBlocks(this.#definition, round, undefined, allocation);
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
      return this.#abortRun("cancelled by user");
    }

    this.#setState("analyzing");
    const optimizer = new SensitivityOptimizer(this.#definition);
    for (const trial of this.#allTrials) optimizer.addTrials([trial]);
    const recommendation = optimizer.recommend();
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
    this.#setState("complete");
    await this.#persistCheckpoint("complete");
    await this.#ports.execution.releaseCapture();
    return { status: "complete", trials: this.#allTrials, auditTrail: this.auditEntries() };
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
        this.#setState("rest", "between candidate blocks");
        this.#audit.append(this.#ports.nowIso(), "rest-started", { reason: "candidate-transition" });
        await this.#ports.sleep(this.#definition.restBetweenCandidatesMs);
        this.#audit.append(this.#ports.nowIso(), "rest-ended", {});
        this.#continuousTestingMs = 0;
        this.#measuredTrialsSinceRest = [];
        this.#setState("candidate-transition");
      }
      lastCandidateId = spec.candidateId;

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
          this.#audit.append(this.#ports.nowIso(), "rest-started", { reason: fatigue.reason ?? "fatigue" });
          await this.#ports.sleep(this.#definition.fatigueProtocol.restDurationMs);
          this.#continuousTestingMs = 0;
          this.#measuredTrialsSinceRest = [];
          this.#setState("inter-trial", "fatigue rest finished");
          this.#audit.append(this.#ports.nowIso(), "rest-ended", {});
        }
        this.#setState("trial-ready", `${label} · ${scenario.label}`);
      }

      const repIndex =
        spec.phase === "measured" ? this.#nextRepIndex(spec.candidateId) : null;

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

  cancel(): void {
    this.#cancelRequested = true;
    this.#pauseRequested = false;
  }

  async #awaitIfPaused(): Promise<void> {
    if (!this.#pauseRequested) return;
    const resumeState = this.#state;
    this.#setState("paused");
    while (this.#pauseRequested && !this.#cancelRequested) {
      await this.#ports.sleep(50);
    }
    if (!this.#cancelRequested) {
      this.#forceState(resumeState === "paused" ? "inter-trial" : resumeState);
    }
  }

  #forceState(state: SessionStateName): void {
    this.#state = state;
    this.#phaseLog.push({ state, tIso: this.#ports.nowIso() });
    this.#ports.onStateChange?.(state);
  }

  async #abortRun(
    reason: string,
    abortReason?: SessionAbortReason,
  ): Promise<SessionRunOutcome> {
    this.#cancelRequested = true;
    this.#forceState("aborted");
    this.#phaseLog.push({ state: "aborted-detail", tIso: this.#ports.nowIso(), detail: reason });
    await this.#persistCheckpoint("aborted");
    await this.#ports.execution.releaseCapture().catch(() => undefined);
    return {
      status: "aborted",
      trials: this.#allTrials,
      auditTrail: this.auditEntries(),
      ...(abortReason ? { abortReason } : {}),
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

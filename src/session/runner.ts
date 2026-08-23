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
  SessionCheckpoint,
  SessionRunnerPorts,
  SessionProgressSnapshot,
} from "./types.ts";

const SEQUENCE_KEY = (round: number, seq: number): string => `${round}:${seq}`;

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

  constructor(definition: ExperimentDefinition, ports: SessionRunnerPorts) {
    this.#definition = definition;
    this.#ports = ports;
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

  async run(): Promise<{
    status: "complete" | "aborted";
    trials: TrialRecord[];
    auditTrail: readonly AuditEntry[];
  }> {
    if (this.#state !== "idle") throw new Error("runner already used");
    this.#setState("setup");
    this.#audit.append(this.#ports.nowIso(), "experiment-created", {
      experimentId: String(this.#definition.id),
      candidateCount: this.#definition.candidates.length,
      rounds: this.#definition.stoppingCriteria.maxSearchRounds,
    });
    this.#sessionId = makeSessionId(
      `${this.#definition.id}-${Date.now()}`.replace(/[^a-zA-Z0-9-]/g, "-"),
    );

    await this.#ports.store.saveExperiment({
      ...this.#definition,
      candidates: [...this.#definition.candidates],
    });
    await this.#persistCheckpoint("running");

    const locked = await this.#executionGate();
    if (!locked) {
      return this.#abortRun("pointer lock denied");
    }
    this.#setState("candidate-transition", "lock acquired");

    const maxRounds = Math.max(1, this.#definition.stoppingCriteria.maxSearchRounds);
    for (let round = 0; round < maxRounds; round++) {
      if (this.#cancelRequested) break;
      const allocation = this.#allocationForRound(round);
      const plan = planCandidateBlocks(this.#definition, round, undefined, allocation);
      if (plan.length === 0) break;
      await this.#runPlan(plan, round);

      const measuredTotal = this.#allTrials.filter((t) => t.phase === "measured").length;
      if (
        measuredTotal >= this.#definition.stoppingCriteria.maxTotalMeasuredTrials ||
        this.#cancelRequested
      ) {
        break;
      }
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
      optimizerVersion: "optimizer-v2",
      schemaVersion: 1,
      utilityWeights: recommendation.utilityWeights as unknown as Record<string, number>,
      config: {},
    });
    this.#setState("complete");
    await this.#persistCheckpoint("complete");
    await this.#ports.execution.releaseCapture();
    return { status: "complete", trials: this.#allTrials, auditTrail: this.auditEntries() };
  }

  async #executionGate(): Promise<boolean> {
    this.#setState("awaiting-lock");
    return this.#ports.execution.requestLock();
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

  async #abortRun(reason: string): Promise<{ status: "aborted"; trials: TrialRecord[]; auditTrail: readonly AuditEntry[] }> {
    this.#cancelRequested = true;
    this.#forceState("aborted");
    this.#phaseLog.push({ state: "aborted-detail", tIso: this.#ports.nowIso(), detail: reason });
    await this.#persistCheckpoint("aborted");
    await this.#ports.execution.releaseCapture().catch(() => undefined);
    return { status: "aborted", trials: this.#allTrials, auditTrail: this.auditEntries() };
  }

  async #persistCheckpoint(status: SessionCheckpoint["status"]): Promise<void> {
    if (!this.#sessionId) return;
    const checkpoint: SessionCheckpoint = {
      sessionId: this.#sessionId,
      experimentId: this.#definition.id,
      status,
      completedSequenceKeys: [...this.#completedKeys].sort(),
      phaseLog: [...this.#phaseLog],
      activeTestingMs: this.#activeTestingMs,
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

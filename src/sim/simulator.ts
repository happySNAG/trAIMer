import type { Viewport } from "../domain/geometry.ts";
import type {
  ExperimentDefinition,
} from "../domain/experiment.ts";
import { scenarioById, type ScenarioDefinition } from "../domain/scenario.ts";
import {
  TrialRecorder,
  type TrialRecordingRequest,
} from "../capture/recorder.ts";
import type {
  SessionId,
  ExperimentId,
  CandidateId,
  TargetId,
} from "../domain/ids.ts";
import type { TrialOutcome, TrialRecord } from "../domain/trial.ts";
import type { SyntheticPlayerConfig } from "./player.ts";
import { Rng, combineSeeds } from "../util/rng.ts";
import { emitSubmovement } from "./submovement.ts";
import { planCandidateBlocks, type TrialPlanSpec } from "../experiments/protocol.ts";
import {
  createInstanceRng,
  hashString,
  planScenarioInstance,
  plannedTargetPositionAt,
  type PlannedScenarioInstance,
} from "../scenarios/planner.ts";

export interface SimulatorOptions {
  viewport?: Viewport;
  sampleHz?: number;
}

export interface SimulatedSessionResult {
  sessionId: SessionId;
  trials: TrialRecord[];
  planRounds: TrialPlanSpec[][];
}

interface SensitivityEffect {
  ratioX: number;
  log2RatioX: number;
  ratioY: number;
}

type TargetCenterFn = (tMs: number) => { x: number; y: number };

export class SyntheticExperimentRunner {
  readonly #definition: ExperimentDefinition;
  readonly #player: SyntheticPlayerConfig;
  readonly #viewport: Viewport;
  readonly #sampleDtMs: number;
  #virtualClockMs = 0;
  readonly #repCounterByCandidate = new Map<string, number>();

  constructor(
    definition: ExperimentDefinition,
    player: SyntheticPlayerConfig,
    options: SimulatorOptions = {},
  ) {
    this.#definition = definition;
    this.#player = player;
    this.#viewport = options.viewport ?? { widthPx: 1280, heightPx: 720 };
    this.#sampleDtMs = 1000 / (options.sampleHz ?? 240);
  }

  runRound(
    round: number,
    sessionSeed: number,
    sessionId: SessionId,
    experimentId: ExperimentId,
    candidateIdFilter?: readonly string[],
  ): TrialRecord[] {
    const plan = planCandidateBlocks(this.#definition, round, candidateIdFilter);
    const trials: TrialRecord[] = [];
    let lastCandidateId: string | null = null;
    for (const spec of plan) {
      if (lastCandidateId !== null && spec.candidateId !== lastCandidateId) {
        this.#virtualClockMs += this.#definition.restBetweenCandidatesMs;
      }
      lastCandidateId = spec.candidateId;
      const scenario = scenarioById(spec.scenarioId);
      let repIndex: number;
      if (spec.phase === "measured") {
        repIndex = this.#repCounterByCandidate.get(spec.candidateId) ?? 0;
        this.#repCounterByCandidate.set(spec.candidateId, repIndex + 1);
      } else {
        repIndex = spec.sequenceNumber;
      }
      const instanceSeed =
        spec.phase === "measured"
          ? { experimentSeed: sessionSeed, round, scenarioId: spec.scenarioId, repIndex }
          : { experimentSeed: sessionSeed + 7777, round, scenarioId: spec.scenarioId, repIndex };
      const geometryRng = createInstanceRng(instanceSeed);
      const playerRng = new Rng(combineSeeds(sessionSeed, round, hashString(spec.scenarioId) ^ (spec.sequenceNumber * 2654435761)));
      const candidate = this.#definition.candidates.find(
        (c) => c.id === (spec.candidateId as CandidateId),
      );
      if (!candidate) throw new Error(`Unknown candidate ${spec.candidateId}`);
      const request: TrialRecordingRequest = {
        id: `trial-${sessionId}-r${round}-${spec.sequenceNumber}`,
        sessionId,
        experimentId,
        candidateId: candidate.id,
        indexInSession: trials.length,
        phase: spec.phase,
        scenarioId: scenario.id,
        scenarioKind: scenario.kind,
        scenarioRepIndex: spec.phase === "measured" ? repIndex : null,
        viewport: this.#viewport,
        sensitivity: candidate.sensitivity,
        dpi: this.#definition.dpi,
        expectedSampleIntervalMs: this.#sampleDtMs,
        startedAtMonotonicMs: this.#virtualClockMs,
        seedTag: `${sessionSeed}:${round}:${spec.sequenceNumber}`,
      };
      const trial =
        scenario.kind === "tracking"
          ? this.#simulateTrackingTrial(request, scenario, geometryRng, playerRng)
          : this.#simulateFlickTrial(request, scenario, geometryRng, playerRng);
      this.#virtualClockMs = trial.endedAtMonotonicMs + 800 + playerRng.range(0, 700);
      trials.push(trial);
    }
    return trials;
  }

  #effectFor(candidateId: CandidateId): SensitivityEffect {
    const candidate = this.#definition.candidates.find((c) => c.id === candidateId)!;
    const candEdpiX = this.#definition.dpi * candidate.sensitivity.sensX;
    const candEdpiY = this.#definition.dpi * candidate.sensitivity.sensY;
    return {
      ratioX: candEdpiX / this.#player.trueOptimalEdpi,
      log2RatioX: Math.log2(candEdpiX / this.#player.trueOptimalEdpi),
      ratioY: candEdpiY / this.#player.trueOptimalEdpiY,
    };
  }

  #fatigueOffset(indexInSession: number): number {
    // Pass 6 numerical hardening: the offset is bounded so extreme session
    // lengths or signed fatigue models can never drive an effective median
    // (reaction/trigger delay) negative — a negative lognormal median
    // produces NaN timings that would poison every downstream trial via the
    // virtual clock.
    const raw = this.#player.fatiguePerTrialMs * indexInSession;
    return Math.min(150, Math.max(-100, raw));
  }

  #spawnPlannedTargets(
    recorder: TrialRecorder,
    request: TrialRecordingRequest,
    instance: PlannedScenarioInstance,
  ): void {
    instance.targets.forEach((target, ti) => {
      const targetId: TargetId = `target-${request.id}-${ti}`;
      recorder.add({
        kind: "target-spawn",
        tMs: request.startedAtMonotonicMs + target.spawnDelayMs,
        targetId,
        radiusPx: target.radiusPx,
        motion:
          target.kind === "static"
            ? { kind: "static", position: target.position }
            : {
                kind: "path",
                keyframes: target.keyframes.map((k) => ({
                  tMs: request.startedAtMonotonicMs + k.tMs,
                  position: k.position,
                })),
              },
      });
    });
  }

  #simulateFlickTrial(
    request: TrialRecordingRequest,
    scenario: ScenarioDefinition,
    geometryRng: Rng,
    playerRng: Rng,
  ): TrialRecord {
    const recorder = new TrialRecorder(request);
    const effect = this.#effectFor(request.candidateId!);
    const fatigue = this.#fatigueOffset(request.indexInSession);

    let t = request.startedAtMonotonicMs;
    for (let i = 0; i < 5; i++) {
      recorder.add({ kind: "pointer-sample", tMs: t, dx: 0, dy: 0 });
      t += this.#sampleDtMs * 2;
    }

    const perTargetBudgetMs =
      scenario.kind === "target-switch"
        ? Math.floor(scenario.timeoutMs / (scenario.targetsPerTrial ?? 3))
        : scenario.timeoutMs;

    const targetsCount =
      scenario.kind === "target-switch"
        ? (scenario.targetsPerTrial ?? 3)
        : 1;

    const instance = planScenarioInstance(scenario, this.#viewport, geometryRng);
    this.#spawnPlannedTargets(recorder, request, instance);

    let shotsFired = 0;
    let hitsCount = 0;

    for (let ti = 0; ti < targetsCount; ti++) {
      const planned = instance.targets[Math.min(ti, instance.targets.length - 1)]!;
      const scheduledSpawnT = request.startedAtMonotonicMs + planned.spawnDelayMs;
      const spawnT = Math.max(scheduledSpawnT, t + playerRng.range(20, 50));
      const centerAt: TargetCenterFn = (tMs) => {
        const pos = plannedTargetPositionAt(planned, tMs - request.startedAtMonotonicMs);
        return pos ?? plannedTargetPositionAt(planned, planned.spawnDelayMs)!;
      };

      const result = this.#flickToTarget(
        recorder,
        playerRng,
        effect,
        `target-${request.id}-${ti}` as TargetId,
        spawnT,
        centerAt(spawnT),
        centerAt,
        planned.radiusPx,
        fatigue,
        perTargetBudgetMs,
      );
      shotsFired += result.shotsFired;
      hitsCount += result.hits;
      t = result.currentTimeMs;

      if (!result.completed) break;
    }

    const outcome: TrialOutcome =
      hitsCount === targetsCount
        ? "hit"
        : shotsFired > 0
          ? "miss-shot-fired"
          : "timeout-no-shot";

    return recorder.finish(outcome, t);
  }

  #flickToTarget(
    recorder: TrialRecorder,
    rng: Rng,
    effect: SensitivityEffect,
    targetId: TargetId,
    spawnT: number,
    initialTargetCenter: { x: number; y: number },
    centerAt: TargetCenterFn,
    radiusPx: number,
    fatigueMs: number,
    budgetFromSpawnMs: number,
  ): { currentTimeMs: number; completed: boolean; shotsFired: number; hits: number } {
    const p = this.#player;
    const start = recorder.cursorPosition;

    // Effective medians stay in physically plausible ranges regardless of
    // signed fatigue (Pass 6 numerical hardening; lognormal requires a
    // strictly positive median).
    const reactionMedian = Math.max(80, p.reactionMedianMs + fatigueMs);
    const reactionMs = clampNumber(
      rng.lognormal(reactionMedian, p.reactionLognormalSigma * p.trialNoiseScale),
      80,
      650,
    );

    const dxT0 = initialTargetCenter.x - start.x;
    const dyT0 = initialTargetCenter.y - start.y;
    const d0 = Math.hypot(dxT0, dyT0);

    const dirCos = d0 > 0 ? dxT0 / d0 : 1;
    const dirSin = d0 > 0 ? dyT0 / d0 : 0;
    const effRatio =
      Math.pow(Math.max(effect.ratioX, 0.05), Math.abs(dirCos)) *
      Math.pow(Math.max(effect.ratioY, 0.05), Math.abs(dirSin));
    const xEff = Math.log2(effRatio);

    const vEff = clampNumber(
      p.referenceFlickSpeedPxPerMs * Math.pow(Math.max(effRatio, 0.05), p.velocityAlpha),
      0.35,
      14,
    );

    let ampFactor: number;
    if (xEff < 0) {
      ampFactor = 1 - p.undershootGain * Math.pow(-xEff, p.amplitudeExponent);
    } else {
      ampFactor = 1 + p.overshootGain * Math.pow(xEff, p.amplitudeExponent);
    }
    ampFactor = clampNumber(ampFactor, 0.5, 1.9);
    ampFactor *= Math.exp(
      rng.normal(
        0,
        (p.amplitudeNoiseBase +
          0.09 * (1 - p.flickSkill) +
          0.03 * Math.abs(xEff)) * p.trialNoiseScale,
      ),
    );

    const interceptT =
      spawnT + reactionMs + clampNumber(d0 / vEff, 40, 900);
    const aimCenter = centerAt(interceptT);
    const dxAim = aimCenter.x - start.x;
    const dyAim = aimCenter.y - start.y;
    const dAim = Math.max(Math.hypot(dxAim, dyAim), 1);
    const uxAim = dxAim / dAim;
    const uyAim = dyAim / dAim;

    const perpJitter =
      rng.normal(0, p.motorNoisePx * (1 + Math.abs(xEff)) * p.trialNoiseScale) * dAim * 0.03;
    const executedDistance = dAim * ampFactor;
    const primaryDestination = {
      x: start.x + uxAim * executedDistance - uyAim * perpJitter,
      y: start.y + uyAim * executedDistance + uxAim * perpJitter,
    };

    const primaryDurationMs = clampNumber(executedDistance / vEff, 40, 900);
    const tremor =
      p.motorNoisePx *
      p.trialNoiseScale *
      (1 + 2.5 * Math.pow(Math.max(0, xEff), 2));
    let point = emitSubmovement(
      {
        from: start,
        to: primaryDestination,
        startMs: spawnT + reactionMs,
        durationMs: primaryDurationMs,
        sampleDtMs: this.#sampleDtMs,
        tremorSigmaPx: tremor,
      },
      rng,
      (tMs, dx, dy) => recorder.add({ kind: "pointer-sample", tMs, dx, dy }),
    );

    const maxCorrections = 1 + Math.round(3 * (1 - p.correctionSkill));
    const reduceFactor =
      (0.55 + 0.42 * p.correctionSkill) * Math.max(0.25, 1 - 0.5 * xEff * xEff);
    const correctionNoise =
      p.motorNoisePx *
      (1.7 - 1.15 * p.correctionSkill) *
      p.trialNoiseScale *
      (1 + 2.5 * xEff * xEff);
    let correctionsUsed = 0;
    while (correctionsUsed < maxCorrections) {
      correctionsUsed++;
      const tc = centerAt(point.tMs);
      const errVec = { x: tc.x - point.position.x, y: tc.y - point.position.y };
      const errLen = Math.hypot(errVec.x, errVec.y);
      if (errLen <= radiusPx * 0.7) break;
      const corrDurationMs = clampNumber(45 + 70 * (errLen / Math.max(d0, 1)), 30, 260);
      const gapBeforeShotMs = rng.range(20, 60) + 70;
      if (point.tMs + corrDurationMs + gapBeforeShotMs - spawnT > budgetFromSpawnMs) {
        return { currentTimeMs: point.tMs, completed: false, shotsFired: 0, hits: 0 };
      }
      const dest = {
        x:
          point.position.x +
          errVec.x * reduceFactor +
          rng.normal(0, correctionNoise),
        y:
          point.position.y +
          errVec.y * reduceFactor +
          rng.normal(0, correctionNoise),
      };
      point = emitSubmovement(
        {
          from: point.position,
          to: dest,
          startMs: point.tMs + rng.range(20, 60),
          durationMs: corrDurationMs,
          sampleDtMs: this.#sampleDtMs,
          tremorSigmaPx: tremor,
        },
        rng,
        (tMs, dx, dy) => recorder.add({ kind: "pointer-sample", tMs, dx, dy }),
      );
    }

    const settleMs = rng.range(20, 60);
    const triggerMedian = Math.max(30, p.triggerDelayMedianMs + fatigueMs * 0.5);
    const triggerMs = clampNumber(
      rng.lognormal(triggerMedian, p.triggerDelayLognormalSigma),
      30,
      400,
    );
    const shotT = point.tMs + settleMs + triggerMs;
    if (shotT - spawnT > budgetFromSpawnMs) {
      return { currentTimeMs: point.tMs, completed: false, shotsFired: 0, hits: 0 };
    }

    while (point.tMs < shotT) {
      const nextT = Math.min(point.tMs + this.#sampleDtMs, shotT);
      const nx = point.position.x + rng.normal(0, tremor * 0.5);
      const ny = point.position.y + rng.normal(0, tremor * 0.5);
      recorder.add({
        kind: "pointer-sample",
        tMs: nextT,
        dx: nx - point.position.x,
        dy: ny - point.position.y,
      });
      point = { position: { x: nx, y: ny }, tMs: nextT };
    }

    recorder.add({ kind: "button", tMs: shotT, action: "press" });
    const tcAtShot = centerAt(shotT);
    const hit =
      Math.hypot(point.position.x - tcAtShot.x, point.position.y - tcAtShot.y) <=
      radiusPx;
    if (hit) {
      recorder.add({
        kind: "target-remove",
        tMs: shotT + 1,
        targetId,
        reason: "hit",
      });
    }
    return {
      currentTimeMs: shotT + 40,
      completed: true,
      shotsFired: 1,
      hits: hit ? 1 : 0,
    };
  }

  #simulateTrackingTrial(
    request: TrialRecordingRequest,
    scenario: ScenarioDefinition,
    geometryRng: Rng,
    playerRng: Rng,
  ): TrialRecord {
    const recorder = new TrialRecorder(request);
    const effect = this.#effectFor(request.candidateId!);
    const p = this.#player;
    const x = effect.log2RatioX;

    const durationMs = scenario.trackingDurationMs ?? scenario.timeoutMs;
    const instance = planScenarioInstance(scenario, this.#viewport, geometryRng);
    const keyframes = instance.targets[0]!.kind === "path" ? instance.targets[0]!.keyframes : [];
    const absoluteKeyframes = keyframes.map((k) => ({
      tMs: request.startedAtMonotonicMs + k.tMs,
      position: k.position,
    }));

    const targetId: TargetId = `target-${request.id}`;
    recorder.add({
      kind: "target-spawn",
      tMs: request.startedAtMonotonicMs,
      targetId,
      radiusPx: scenario.targetRadiusPx,
      motion: { kind: "path", keyframes: absoluteKeyframes },
    });

    const kpBase = clampNumber(16 * Math.pow(Math.max(effect.ratioX, 0.05), 0.45), 2, 26);
    const noiseSigma =
      6 *
      (2.2 - 1.65 * p.trackingSkill) *
      p.trialNoiseScale *
      (1 + 2.2 * Math.pow(Math.max(0, x), 2) + 1.6 * Math.pow(Math.max(0, -x), 2));

    let cursor = { ...absoluteKeyframes[0]!.position };
    cursor = { x: this.#viewport.widthPx / 2, y: this.#viewport.heightPx / 2 };
    let offset = { x: 0, y: 0 };
    let nextDistractionT = request.startedAtMonotonicMs + playerRng.range(1200, 2400);

    let t = request.startedAtMonotonicMs;
    for (let kt = 0; kt <= durationMs; kt += this.#sampleDtMs) {
      t = request.startedAtMonotonicMs + kt;
      const idx = Math.min(absoluteKeyframes.length - 1, Math.round(kt / 50));
      const targetPos = absoluteKeyframes[idx]!.position;

      const gain = 1 - Math.exp(-kpBase * (this.#sampleDtMs / 1000));
      const desired = {
        x: targetPos.x - offset.x,
        y: targetPos.y - offset.y,
      };
      const step = {
        x: (desired.x - cursor.x) * gain + playerRng.normal(0, noiseSigma),
        y: (desired.y - cursor.y) * gain + playerRng.normal(0, noiseSigma),
      };
      recorder.add({ kind: "pointer-sample", tMs: t, dx: step.x, dy: step.y });
      cursor = { x: cursor.x + step.x, y: cursor.y + step.y };

      if (t >= nextDistractionT) {
        if ((1 - p.trackingSkill) * 0.45 > playerRng.next()) {
          const mag = playerRng.range(50, 130);
          const ang = playerRng.range(-Math.PI, Math.PI);
          offset = { x: Math.cos(ang) * mag, y: Math.sin(ang) * mag };
        }
        nextDistractionT = t + playerRng.range(1400, 2600);
      }
      offset = { x: offset.x * 0.92, y: offset.y * 0.92 };
    }

    return recorder.finish("tracking-complete", t);
  }
}

function clampNumber(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

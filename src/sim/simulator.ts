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
  ratio: number;
  log2Ratio: number;
}

type TargetCenterFn = (tMs: number) => { x: number; y: number };

export class SyntheticExperimentRunner {
  readonly #definition: ExperimentDefinition;
  readonly #player: SyntheticPlayerConfig;
  readonly #viewport: Viewport;
  readonly #sampleDtMs: number;
  #virtualClockMs = 0;

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
    let measuredIdxWithinBlock = 0;
    for (const spec of plan) {
      if (lastCandidateId !== null && spec.candidateId !== lastCandidateId) {
        this.#virtualClockMs += this.#definition.restBetweenCandidatesMs;
        measuredIdxWithinBlock = 0;
      }
      lastCandidateId = spec.candidateId;
      const scenario = scenarioById(spec.scenarioId);
      const rng =
        spec.phase === "measured"
          ? new Rng(
              combineSeeds(
                sessionSeed,
                round,
                hashString(spec.scenarioId),
                measuredIdxWithinBlock,
              ),
            )
          : new Rng(combineSeeds(sessionSeed, round, spec.sequenceNumber));
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
        viewport: this.#viewport,
        sensitivity: candidate.sensitivity,
        dpi: this.#definition.dpi,
        expectedSampleIntervalMs: this.#sampleDtMs,
        startedAtMonotonicMs: this.#virtualClockMs,
        seedTag: `${sessionSeed}:${round}:${spec.sequenceNumber}`,
      };
      const trial =
        scenario.kind === "tracking"
          ? this.#simulateTrackingTrial(request, scenario, rng)
          : this.#simulateFlickTrial(request, scenario, rng);
      this.#virtualClockMs = trial.endedAtMonotonicMs + 800 + rng.range(0, 700);
      if (spec.phase === "measured") measuredIdxWithinBlock++;
      trials.push(trial);
    }
    return trials;
  }

  #effectFor(candidateId: CandidateId): SensitivityEffect {
    const candidate = this.#definition.candidates.find((c) => c.id === candidateId)!;
    const candEdpi = this.#definition.dpi * candidate.sensitivity.sensX;
    const trueEdpi = this.#player.trueOptimalEdpi;
    const ratio = candEdpi / trueEdpi;
    return { ratio, log2Ratio: Math.log2(ratio) };
  }

  #fatigueOffset(indexInSession: number): number {
    return Math.min(150, this.#player.fatiguePerTrialMs * indexInSession);
  }

  #simulateFlickTrial(
    request: TrialRecordingRequest,
    scenario: ScenarioDefinition,
    rng: Rng,
  ): TrialRecord {
    const recorder = new TrialRecorder(request);
    const effect = this.#effectFor(request.candidateId!);
    const fatigue = this.#fatigueOffset(request.indexInSession);

    let t = request.startedAtMonotonicMs;
    for (let i = 0; i < 5; i++) {
      recorder.add({ kind: "pointer-sample", tMs: t, dx: 0, dy: 0 });
      t += this.#sampleDtMs * 2;
    }

    const targetsCount =
      scenario.kind === "target-switch" ? (scenario.targetsPerTrial ?? 3) : 1;
    const perTargetBudgetMs =
      scenario.kind === "target-switch"
        ? Math.floor(scenario.timeoutMs / targetsCount)
        : scenario.timeoutMs;

    let shotsFired = 0;
    let hitsCount = 0;

    for (let ti = 0; ti < targetsCount; ti++) {
      const spawnT = t + rng.range(30, 90);
      const center = {
        x: this.#viewport.widthPx / 2,
        y: this.#viewport.heightPx / 2,
      };
      const distance = rng.range(scenario.distanceRangePx.min, scenario.distanceRangePx.max);
      const angle = this.#pickAngle(scenario, rng, ti);
      const targetCenter = {
        x: clampToViewport(center.x + Math.cos(angle) * distance, this.#viewport.widthPx),
        y: clampToViewport(center.y + Math.sin(angle) * distance, this.#viewport.heightPx),
      };

      const targetId: TargetId = `target-${request.id}-${ti}`;
      let centerAt: TargetCenterFn;
      if (scenario.kind === "flick-dynamic") {
        const speed = rng.range(
          scenario.targetSpeedPxPerSec?.min ?? 240,
          scenario.targetSpeedPxPerSec?.max ?? 480,
        );
        const dirX = targetCenter.x > center.x ? -1 : 1;
        const keyframes: { tMs: number; position: { x: number; y: number } }[] = [];
        for (let kt = 0; kt <= perTargetBudgetMs; kt += 50) {
          keyframes.push({
            tMs: spawnT + kt,
            position: {
              x: clampToViewport(targetCenter.x + (dirX * (speed * kt)) / 1000, this.#viewport.widthPx),
              y: targetCenter.y,
            },
          });
        }
        recorder.add({
          kind: "target-spawn",
          tMs: spawnT,
          targetId,
          radiusPx: scenario.targetRadiusPx,
          motion: { kind: "path", keyframes },
        });
        centerAt = (tMs) => {
          const clamped = Math.min(Math.max(tMs, spawnT), spawnT + perTargetBudgetMs);
          const idx = Math.min(
            keyframes.length - 1,
            Math.max(0, Math.round((clamped - spawnT) / 50)),
          );
          return keyframes[idx]!.position;
        };
      } else {
        recorder.add({
          kind: "target-spawn",
          tMs: spawnT,
          targetId,
          radiusPx: scenario.targetRadiusPx,
          motion: { kind: "static", position: targetCenter },
        });
        centerAt = () => targetCenter;
      }

      const result = this.#flickToTarget(
        recorder,
        rng,
        effect,
        targetId,
        spawnT,
        centerAt(spawnT),
        centerAt,
        scenario.targetRadiusPx,
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

  #pickAngle(scenario: ScenarioDefinition, rng: Rng, index: number): number {
    if (scenario.angleMode === "horizontal-biased") {
      const side = rng.bernoulli(0.5) ? 1 : -1;
      return side * rng.range(-0.35, 0.35) + (rng.bernoulli(0.5) ? Math.PI : 0);
    }
    if (scenario.kind === "target-switch") {
      return (index * 2.1 + rng.range(-0.6, 0.6)) % (2 * Math.PI);
    }
    return rng.range(-Math.PI, Math.PI);
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
    const x = effect.log2Ratio;
    const start = recorder.cursorPosition;

    const reactionMedian = p.reactionMedianMs + fatigueMs;
    const reactionMs = clampNumber(
      rng.lognormal(reactionMedian, p.reactionLognormalSigma * p.trialNoiseScale),
      80,
      650,
    );

    const dxT0 = initialTargetCenter.x - start.x;
    const dyT0 = initialTargetCenter.y - start.y;
    const d0 = Math.hypot(dxT0, dyT0);

    const vEff = clampNumber(
      p.referenceFlickSpeedPxPerMs * Math.pow(Math.max(effect.ratio, 0.05), p.velocityAlpha),
      0.35,
      14,
    );

    let ampFactor: number;
    if (x < 0) {
      ampFactor = 1 - p.undershootGain * Math.pow(-x, p.amplitudeExponent);
    } else {
      ampFactor = 1 + p.overshootGain * Math.pow(x, p.amplitudeExponent);
    }
    ampFactor = clampNumber(ampFactor, 0.5, 1.9);
    ampFactor *= Math.exp(
      rng.normal(
        0,
        (p.amplitudeNoiseBase +
          0.09 * (1 - p.flickSkill) +
          0.03 * Math.abs(x)) * p.trialNoiseScale,
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
      rng.normal(0, p.motorNoisePx * (1 + Math.abs(x)) * p.trialNoiseScale) * dAim * 0.03;
    const executedDistance = dAim * ampFactor;
    const primaryDestination = {
      x: start.x + uxAim * executedDistance - uyAim * perpJitter,
      y: start.y + uyAim * executedDistance + uxAim * perpJitter,
    };

    const primaryDurationMs = clampNumber(executedDistance / vEff, 40, 900);
    const tremor =
      p.motorNoisePx *
      p.trialNoiseScale *
      (1 + 2.5 * Math.pow(Math.max(0, x), 2));
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
      (0.55 + 0.42 * p.correctionSkill) * Math.max(0.25, 1 - 0.5 * x * x);
    const correctionNoise =
      p.motorNoisePx *
      (1.7 - 1.15 * p.correctionSkill) *
      p.trialNoiseScale *
      (1 + 2.5 * x * x);
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
    const triggerMs = clampNumber(
      rng.lognormal(p.triggerDelayMedianMs + fatigueMs * 0.5, p.triggerDelayLognormalSigma),
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
    rng: Rng,
  ): TrialRecord {
    const recorder = new TrialRecorder(request);
    const effect = this.#effectFor(request.candidateId!);
    const p = this.#player;
    const x = effect.log2Ratio;

    const durationMs = scenario.trackingDurationMs ?? scenario.timeoutMs;
    const center = {
      x: this.#viewport.widthPx / 2,
      y: this.#viewport.heightPx / 2,
    };
    const ax = this.#viewport.widthPx * 0.28;
    const ay = this.#viewport.heightPx * 0.22;
    const periodXms = 2100 + rng.range(-300, 300);
    const periodYms = 3400 + rng.range(-500, 500);
    const phase1 = rng.range(0, 2 * Math.PI);
    const phase2 = rng.range(0, 2 * Math.PI);

    const targetId: TargetId = `target-${request.id}`;
    const keyframes: { tMs: number; position: { x: number; y: number } }[] = [];
    for (let kt = 0; kt <= durationMs; kt += 50) {
      keyframes.push({
        tMs: request.startedAtMonotonicMs + kt,
        position: {
          x: center.x + ax * Math.sin((2 * Math.PI * kt) / periodXms + phase1),
          y: center.y + ay * Math.sin((2 * Math.PI * kt) / periodYms + phase2),
        },
      });
    }
    recorder.add({
      kind: "target-spawn",
      tMs: request.startedAtMonotonicMs,
      targetId,
      radiusPx: scenario.targetRadiusPx,
      motion: { kind: "path", keyframes },
    });

    const kpBase = clampNumber(16 * Math.pow(Math.max(effect.ratio, 0.05), 0.45), 2, 26);
    const noiseSigma =
      6 *
      (2.2 - 1.65 * p.trackingSkill) *
      p.trialNoiseScale *
      (1 + 2.2 * Math.pow(Math.max(0, x), 2) + 1.6 * Math.pow(Math.max(0, -x), 2));

    let cursor = { ...center };
    let offset = { x: 0, y: 0 };
    let nextDistractionT = request.startedAtMonotonicMs + rng.range(1200, 2400);

    let t = request.startedAtMonotonicMs;
    for (let kt = 0; kt <= durationMs; kt += this.#sampleDtMs) {
      t = request.startedAtMonotonicMs + kt;
      const idx = Math.min(keyframes.length - 1, Math.round(kt / 50));
      const targetPos = keyframes[idx]!.position;

      const gain = 1 - Math.exp(-kpBase * (this.#sampleDtMs / 1000));
      const desired = {
        x: targetPos.x - offset.x,
        y: targetPos.y - offset.y,
      };
      const step = {
        x: (desired.x - cursor.x) * gain + rng.normal(0, noiseSigma),
        y: (desired.y - cursor.y) * gain + rng.normal(0, noiseSigma),
      };
      recorder.add({ kind: "pointer-sample", tMs: t, dx: step.x, dy: step.y });
      cursor = { x: cursor.x + step.x, y: cursor.y + step.y };

      if (t >= nextDistractionT) {
        if ((1 - p.trackingSkill) * 0.45 > rng.next()) {
          const mag = rng.range(50, 130);
          const ang = rng.range(-Math.PI, Math.PI);
          offset = { x: Math.cos(ang) * mag, y: Math.sin(ang) * mag };
        }
        nextDistractionT = t + rng.range(1400, 2600);
      }
      offset = { x: offset.x * 0.92, y: offset.y * 0.92 };
    }

    return recorder.finish("tracking-complete", t);
  }
}

function hashString(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function clampNumber(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampToViewport(v: number, max: number): number {
  const margin = 24;
  return Math.min(max - margin, Math.max(margin, v));
}

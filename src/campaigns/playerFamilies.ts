import type { SyntheticPlayerConfig } from "../sim/player.ts";
import { DEFAULT_PLAYER_CONFIG } from "../sim/player.ts";
import { Rng, combineSeeds } from "../util/rng.ts";

/**
 * Deterministic synthetic-player families for Pass 6 Monte Carlo campaigns.
 *
 * Each family is a FUNCTION of an integer seed: the same seed always produces
 * byte-identical player parameters (documented determinism contract). Families
 * cover the geometries listed in the Pass 6 mandate: clean unimodal optima,
 * plateaus, asymmetric/skewed curves, boundary and out-of-ladder optima,
 * high/low motor noise, reaction/precision/tracking-dominant players, fatigue,
 * warming, collapse-like degradation, inconsistent days, and real vs false X/Y
 * asymmetry.
 *
 * HONESTY NOTE: the physics simulator produces a unimodal sensitivity
 * response by construction (utility degrades smoothly away from the hidden
 * optimum through amplitude/velocity/noise terms). True bimodal/multimodal
 * sensitivity RESPONSE is therefore NOT physically representable here;
 * multimodal refusal correctness is instead exercised by constructed-evidence
 * suites (tests/curveAdequacy.test.ts) and by noisy families that can produce
 * inconsistent observed geometry. This limitation is documented in
 * docs/PASS6-MONTE-CARLO.md rather than papered over.
 */

export type PlayerFamilyId =
  | "clean-unimodal"
  | "broad-plateau"
  | "asymmetric-curve"
  | "skewed-optimum"
  | "boundary-optimum"
  | "outside-ladder"
  | "high-motor-noise"
  | "low-motor-noise"
  | "reaction-heavy"
  | "precision-heavy"
  | "tracking-heavy"
  | "fatigue"
  | "warming"
  | "collapse-drift"
  | "inconsistent-day"
  | "false-xy-asymmetry"
  | "real-xy-asymmetry";

export const ALL_PLAYER_FAMILIES: readonly PlayerFamilyId[] = [
  "clean-unimodal",
  "broad-plateau",
  "asymmetric-curve",
  "skewed-optimum",
  "boundary-optimum",
  "outside-ladder",
  "high-motor-noise",
  "low-motor-noise",
  "reaction-heavy",
  "precision-heavy",
  "tracking-heavy",
  "fatigue",
  "warming",
  "collapse-drift",
  "inconsistent-day",
  "false-xy-asymmetry",
  "real-xy-asymmetry",
];

/** What the campaign expects the engine to conclude, for scoring verdicts. */
export interface FamilyExpectations {
  /** True when the family is engineered so several candidates stay tied. */
  plateauLikely: boolean;
  /** True when the hidden optimum lies at/outside the standard ladder edges. */
  boundaryLikely: boolean;
  /** True when the family has a genuinely unequal optimal Y/X ratio. */
  realAsymmetry: boolean;
}

export interface PlayerFamilySpec {
  id: PlayerFamilyId;
  description: string;
  expectations: FamilyExpectations;
  build(seed: number): SyntheticPlayerConfig;
}

const BASELINE_EDPI = 5600;

function jitter(rng: Rng, fraction: number): number {
  return 1 + rng.range(-fraction, fraction);
}

function base(overrides: Partial<SyntheticPlayerConfig>): SyntheticPlayerConfig {
  return { ...DEFAULT_PLAYER_CONFIG, ...overrides };
}

export const PLAYER_FAMILIES: Record<PlayerFamilyId, PlayerFamilySpec> = {
  "clean-unimodal": {
    id: "clean-unimodal",
    description:
      "Default skill profile with a well-separated interior optimum near the ladder center.",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 101));
      return base({
        displayName: `clean-unimodal-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.12),
        trueOptimalEdpiY: BASELINE_EDPI * jitter(rng, 0.02),
      });
    },
  },

  "broad-plateau": {
    id: "broad-plateau",
    description:
      "High correction skill with heavy trial noise: many candidates remain statistically tied.",
    expectations: { plateauLikely: true, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 102));
      return base({
        displayName: `broad-plateau-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.08),
        trueOptimalEdpiY: BASELINE_EDPI,
        flickSkill: 0.55,
        correctionSkill: 0.85,
        trackingSkill: 0.65,
        trialNoiseScale: 1.9 + rng.range(0, 0.5),
        amplitudeNoiseBase: 0.05,
      });
    },
  },

  "asymmetric-curve": {
    id: "asymmetric-curve",
    description:
      "Different overshoot vs undershoot gains produce a left/right-skewed response curve.",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 103));
      const skewHigh = rng.bernoulli(0.5);
      return base({
        displayName: `asymmetric-curve-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.1),
        trueOptimalEdpiY: BASELINE_EDPI,
        undershootGain: skewHigh ? 0.62 : 0.3,
        overshootGain: skewHigh ? 0.28 : 0.6,
        amplitudeExponent: 1.25,
      });
    },
  },

  "skewed-optimum": {
    id: "skewed-optimum",
    description:
      "Velocity alpha far from 1 skews effective difficulty around the optimum.",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 104));
      return base({
        displayName: `skewed-optimum-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.1),
        trueOptimalEdpiY: BASELINE_EDPI,
        velocityAlpha: rng.range(0.72, 1.05),
        referenceFlickSpeedPxPerMs: rng.range(3.0, 5.4),
      });
    },
  },

  "boundary-optimum": {
    id: "boundary-optimum",
    description:
      "Hidden optimum sits at (or just beyond) one edge of the standard ±35 % ladder.",
    expectations: { plateauLikely: false, boundaryLikely: true, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 105));
      const lowSide = rng.bernoulli(0.5);
      const edpi = lowSide
        ? BASELINE_EDPI / 1.35 * jitter(rng, 0.04)
        : BASELINE_EDPI * 1.35 * jitter(rng, 0.04);
      return base({
        displayName: `boundary-optimum-${seed}`,
        trueOptimalEdpi: edpi,
        trueOptimalEdpiY: edpi,
      });
    },
  },

  "outside-ladder": {
    id: "outside-ladder",
    description:
      "Hidden optimum clearly beyond one expansion step from the standard ladder.",
    expectations: { plateauLikely: false, boundaryLikely: true, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 106));
      const lowSide = rng.bernoulli(0.5);
      const edpi = lowSide
        ? BASELINE_EDPI / 2.1 * jitter(rng, 0.08)
        : BASELINE_EDPI * 2.0 * jitter(rng, 0.08);
      return base({
        displayName: `outside-ladder-${seed}`,
        trueOptimalEdpi: edpi,
        trueOptimalEdpiY: edpi,
      });
    },
  },

  "high-motor-noise": {
    id: "high-motor-noise",
    description: "Large motor/amplitude noise; weak per-trial signal.",
    expectations: { plateauLikely: true, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 107));
      return base({
        displayName: `high-motor-noise-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.1),
        trueOptimalEdpiY: BASELINE_EDPI,
        motorNoisePx: 2.6 + rng.range(0, 0.8),
        amplitudeNoiseBase: 0.09,
        trialNoiseScale: 1.7,
        flickSkill: 0.35,
      });
    },
  },

  "low-motor-noise": {
    id: "low-motor-noise",
    description: "Very consistent executor; sharp, well-identified optimum.",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 108));
      return base({
        displayName: `low-motor-noise-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.1),
        trueOptimalEdpiY: BASELINE_EDPI,
        motorNoisePx: 0.45,
        amplitudeNoiseBase: 0.015,
        trialNoiseScale: 0.45,
        flickSkill: 0.85,
        correctionSkill: 0.8,
      });
    },
  },

  "reaction-heavy": {
    id: "reaction-heavy",
    description:
      "Slow reactions dominate error; sensitivity signal arrives mostly through movement time.",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 109));
      return base({
        displayName: `reaction-heavy-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.1),
        trueOptimalEdpiY: BASELINE_EDPI,
        reactionMedianMs: 380 + rng.range(0, 80),
        reactionLognormalSigma: 0.32,
        flickSkill: 0.6,
      });
    },
  },

  "precision-heavy": {
    id: "precision-heavy",
    description:
      "Excellent fine control; differences between nearby candidates are resolvable.",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 110));
      return base({
        displayName: `precision-heavy-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.12),
        trueOptimalEdpiY: BASELINE_EDPI,
        motorNoisePx: 0.55,
        flickSkill: 0.9,
        correctionSkill: 0.9,
        trialNoiseScale: 0.55,
      });
    },
  },

  "tracking-heavy": {
    id: "tracking-heavy",
    description:
      "Tracking-dominant profile; flick discrimination weaker than pursuit precision.",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 111));
      return base({
        displayName: `tracking-heavy-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.1),
        trueOptimalEdpiY: BASELINE_EDPI,
        trackingSkill: 0.92,
        flickSkill: 0.45,
        correctionSkill: 0.5,
        motorNoisePx: 1.6,
      });
    },
  },

  "fatigue": {
    id: "fatigue",
    description: "Per-trial reaction cost accumulates within the session.",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 112));
      return base({
        displayName: `fatigue-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.1),
        trueOptimalEdpiY: BASELINE_EDPI,
        fatiguePerTrialMs: 3.5 + rng.range(0, 3),
      });
    },
  },

  "warming": {
    id: "warming",
    description:
      "Negative fatigue slope: the player gets faster through the session (adaptation risk).",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 113));
      return base({
        displayName: `warming-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.1),
        trueOptimalEdpiY: BASELINE_EDPI,
        fatiguePerTrialMs: -(1.5 + rng.range(0, 2)),
      });
    },
  },

  "collapse-drift": {
    id: "collapse-drift",
    description:
      "Steep late-session degradation drift (physics-simulator approximation of a sudden collapse).",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 114));
      return base({
        displayName: `collapse-drift-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.1),
        trueOptimalEdpiY: BASELINE_EDPI,
        fatiguePerTrialMs: 8 + rng.range(0, 4),
        trialNoiseScale: 1.4,
      });
    },
  },

  "inconsistent-day": {
    id: "inconsistent-day",
    description:
      "Day-level inconsistency: inflated reaction spread and amplitude noise on top of medium skill.",
    expectations: { plateauLikely: true, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 115));
      return base({
        displayName: `inconsistent-day-${seed}`,
        trueOptimalEdpi: BASELINE_EDPI * jitter(rng, 0.1),
        trueOptimalEdpiY: BASELINE_EDPI,
        reactionLognormalSigma: 0.42,
        triggerDelayLognormalSigma: 0.4,
        trialNoiseScale: 1.5 + rng.range(0, 0.6),
        amplitudeNoiseBase: 0.08,
      });
    },
  },

  "false-xy-asymmetry": {
    id: "false-xy-asymmetry",
    description:
      "Symmetric optimum (Y = X); any asymmetry the engine reports is noise, never signal.",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: false },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 116));
      const shared = BASELINE_EDPI * jitter(rng, 0.12);
      return base({
        displayName: `false-xy-asymmetry-${seed}`,
        trueOptimalEdpi: shared,
        trueOptimalEdpiY: shared,
        trialNoiseScale: 1.25,
      });
    },
  },

  "real-xy-asymmetry": {
    id: "real-xy-asymmetry",
    description:
      "Genuinely unequal vertical optimum (Y/X ratio drawn from 0.66–0.82).",
    expectations: { plateauLikely: false, boundaryLikely: false, realAsymmetry: true },
    build(seed) {
      const rng = new Rng(combineSeeds(seed, 117));
      const x = BASELINE_EDPI * jitter(rng, 0.1);
      return base({
        displayName: `real-xy-asymmetry-${seed}`,
        trueOptimalEdpi: x,
        trueOptimalEdpiY: x * rng.range(0.66, 0.82),
      });
    },
  },
};

export function isPlayerFamilyId(value: string): value is PlayerFamilyId {
  return Object.prototype.hasOwnProperty.call(PLAYER_FAMILIES, value);
}

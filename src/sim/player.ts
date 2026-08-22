export interface SyntheticPlayerConfig {
  displayName: string;
  trueOptimalEdpi: number;
  trueOptimalEdpiY: number;
  reactionMedianMs: number;
  reactionLognormalSigma: number;
  referenceFlickSpeedPxPerMs: number;
  velocityAlpha: number;
  undershootGain: number;
  overshootGain: number;
  amplitudeExponent: number;
  amplitudeNoiseBase: number;
  motorNoisePx: number;
  flickSkill: number;
  correctionSkill: number;
  trackingSkill: number;
  triggerDelayMedianMs: number;
  triggerDelayLognormalSigma: number;
  fatiguePerTrialMs: number;
  trialNoiseScale: number;
}

export const DEFAULT_PLAYER_CONFIG: SyntheticPlayerConfig = {
  displayName: "synthetic-medium",
  trueOptimalEdpi: 5600,
  trueOptimalEdpiY: 5600,
  reactionMedianMs: 210,
  reactionLognormalSigma: 0.2,
  referenceFlickSpeedPxPerMs: 4.2,
  velocityAlpha: 0.88,
  undershootGain: 0.46,
  overshootGain: 0.45,
  amplitudeExponent: 1.0,
  amplitudeNoiseBase: 0.035,
  motorNoisePx: 1.2,
  flickSkill: 0.65,
  correctionSkill: 0.6,
  trackingSkill: 0.6,
  triggerDelayMedianMs: 70,
  triggerDelayLognormalSigma: 0.22,
  fatiguePerTrialMs: 0,
  trialNoiseScale: 1,
};

export function playerPreset(
  name: "consistent-medium" | "jittery-fast" | "deliberate-slow" | "noisy-beginner",
  overrides: Partial<SyntheticPlayerConfig> = {},
): SyntheticPlayerConfig {
  const base: Record<string, SyntheticPlayerConfig> = {
    "consistent-medium": { ...DEFAULT_PLAYER_CONFIG },
    "jittery-fast": {
      ...DEFAULT_PLAYER_CONFIG,
      displayName: "jittery-fast",
      flickSkill: 0.85,
      correctionSkill: 0.45,
      trackingSkill: 0.4,
      reactionMedianMs: 180,
      motorNoisePx: 1.8,
      amplitudeNoiseBase: 0.06,
      overshootGain: 0.42,
    },
    "deliberate-slow": {
      ...DEFAULT_PLAYER_CONFIG,
      displayName: "deliberate-slow",
      flickSkill: 0.5,
      correctionSkill: 0.75,
      trackingSkill: 0.7,
      reactionMedianMs: 260,
      referenceFlickSpeedPxPerMs: 3.2,
      undershootGain: 0.44,
      motorNoisePx: 0.9,
    },
    "noisy-beginner": {
      ...DEFAULT_PLAYER_CONFIG,
      displayName: "noisy-beginner",
      flickSkill: 0.3,
      correctionSkill: 0.3,
      trackingSkill: 0.35,
      reactionMedianMs: 250,
      reactionLognormalSigma: 0.3,
      amplitudeNoiseBase: 0.09,
      motorNoisePx: 2.4,
      trialNoiseScale: 1.6,
    },
  };
  return { ...base[name]!, ...overrides };
}

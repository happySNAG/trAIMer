import type {
  AdaptiveAllocationConfig,
  ExclusionRules,
  FatigueProtocolConfig,
  StoppingCriteria,
  YExplorationConfig,
} from "../domain/experiment.ts";

/**
 * Canonical V1 release-candidate experiment configuration (Pass 5, requirement G).
 *
 * ONE source of truth for every default that shapes a V1 session. Every value
 * carries a documented rationale grounded in Passes 1–4 evidence (blind
 * recovery campaigns, duration-policy campaigns, capture-quality gating) and
 * an explicit honesty note: these are ENGINEERING defaults chosen to be
 * conservative WITHOUT human data. They are configurable per-session; nothing
 * here pretends simulation established human optimality.
 */

export interface DocumentedDefault<T> {
  value: T;
  rationale: string;
}

export const V1_RC_PROTOCOL_DEFAULTS = {
  meta: {
    id: "v1-rc-protocol",
    version: "rc-defaults-v1",
    honestyNote:
      "Chosen conservatively from simulation campaigns only. First real Aldo sessions may justify tuning; until then these stay fixed so results remain comparable.",
  },

  warmupTrialsPerCandidateBlock: {
    value: 2,
    rationale:
      "Two unscored trials per candidate block let the player re-calibrate to a sensitivity without letting adaptation leak into scored data; change-point analysis (Pass 4) additionally flags warmup-learning curves when they still occur.",
  } as DocumentedDefault<number>,

  measuredRepsPerCandidatePerRound: {
    value: 8,
    rationale:
      "Duration campaigns (~20 → ~78 measured trials) halve median error and range width up to this point while fatigue risk stays low; 8 reps × 5 candidates × 2 rounds lands in the productive band.",
  } as DocumentedDefault<number>,

  minValidTrialsPerCandidate: {
    value: 4,
    rationale:
      "Below four valid trials per candidate, SEs explode and confidence is capped hard (optimizer floor); candidates with fewer are marked incomplete and cap session confidence at ≤0.45.",
  } as DocumentedDefault<number>,

  adaptiveAllocation: {
    value: {
      enabled: true,
      minRepsBeforeAdaptive: 8,
      contenderZThreshold: 2,
      controlRefreshEveryRounds: 2,
    } satisfies AdaptiveAllocationConfig,
    rationale:
      "Adaptive allocation starts only after every candidate has its balanced minimum (8), keeping round-1 estimates unbiased; contenders (paired z ≥ 2 with best) get full reps, dominated ladder-neighbors get half as controls, far-dominated candidates refresh once every two rounds so no candidate silently disappears.",
  } as DocumentedDefault<AdaptiveAllocationConfig>,

  candidateLadderFactors: {
    value: [1 / 1.35, 1 / 1.15, 1, 1.15, 1.35] as readonly number[],
    rationale:
      "±15 % inner arms resolve fine differences; ±35 % outer arms bound the search. Blind campaigns showed this width brackets typical optima while remaining testable within one session; boundary expansion (+0.35 octaves) handles optima outside.",
  } as DocumentedDefault<readonly number[]>,

  boundaryExpansionOctaves: {
    value: 0.35,
    rationale:
      "Half of the outer-ladder spacing in log2 space — wide enough to escape a boundary in one expansion step, narrow enough not to overshoot into implausible sensitivities; expansions always set unresolvedBoundary warnings.",
  } as DocumentedDefault<number>,

  maxTotalMeasuredTrials: {
    value: 160,
    rationale:
      "Duration policy: beyond ~160 measured trials marginal accuracy gain flattens while wall-clock and fatigue risk keep rising (Pass 4 campaign summarization); early stop usually ends sessions well before.",
  } as DocumentedDefault<number>,

  maxSearchRounds: {
    value: 2,
    rationale:
      "Stage 1 plus one refinement round covers interior optima; more rounds mostly add fatigue. Unresolved boundaries defer to a targeted retest instead of grinding on.",
  } as DocumentedDefault<number>,

  maxContinuousActiveTimeMs: {
    value: 12 * 60 * 1000,
    rationale:
      "Forced rest every 12 minutes of active testing predates measurable degradation in simulated fatigue models; conservative until real fatigue data exists.",
  } as DocumentedDefault<number>,

  restDurationMs: {
    value: 45 * 1000,
    rationale: "Long enough for grip/arm relaxation between blocks without breaking session momentum.",
  } as DocumentedDefault<number>,

  restBetweenCandidatesMs: {
    value: 15_000,
    rationale: "Short mental reset between blinded candidate blocks; candidates change but scenarios continue.",
  } as DocumentedDefault<number>,

  degradationWindowTrials: {
    value: 6,
    rationale: "Rolling window large enough to smooth single bad trials, small enough to catch real degradation within one block.",
  } as DocumentedDefault<number>,

  degradationRatioThreshold: {
    value: 1.25,
    rationale: "A ≥25 % utility-ratio increase over the rolling window forces a rest; below that, noise dominates.",
  } as DocumentedDefault<number>,

  targetScenarioMix: {
    value: [
      "flick-static-medium",
      "flick-static-small",
      "flick-dynamic-horizontal",
      "target-switch-triple",
      "tracking-smooth-sine",
    ] as readonly string[],
    rationale:
      "Equal-weight mix across all five families: small-target flick is the strongest sensitivity discriminator (Pass 3 difficulty metadata), tracking exposes jitter/lag, target-switch exposes consistency; equal weights keep the composite utility interpretable across sessions.",
  } as DocumentedDefault<readonly string[]>,

  trackingDurationSeconds: {
    value: 6,
    rationale: "Six seconds balances Lissajous coverage (≈2 periods of both axes) against session length; shorter windows destabilize lag estimation.",
  } as DocumentedDefault<number>,

  candidateReExposure: {
    value: "interleaved-block-randomized",
    rationale:
      "Every round re-exposes all live candidates in block-randomized order with identical paired scenario instances per rep index — the pairing that cancels scenario/instance effects exactly (docs/STATISTICS.md).",
  } as DocumentedDefault<string>,

  jointXY: {
    value: { enabled: false, yFactors: [0.85, 1, 1.18], minImprovementZ: 2 } satisfies YExplorationConfig,
    rationale:
      "Independent Y exploration is OFF by default: most players' optimal X/Y coincide, unequal-Y pays off only with measurable vertical asymmetry, and the staged narrow search (±15/18 % around winning X, recommend-equal unless z ≥ 2) avoids combinatorial explosion and false asymmetry claims.",
  } as DocumentedDefault<YExplorationConfig>,

  exclusionRules: {
    value: {
      fatalReasons: [
        "IMPOSSIBLE_TIMESTAMPS",
        "MISSING_TARGET_APPEARANCE",
        "INSUFFICIENT_SAMPLES",
        "IMPOSSIBLE_MOVEMENT",
        "CONFIG_MISMATCH",
      ],
      suspectPolicy: "exclude",
    } satisfies ExclusionRules,
    rationale:
      "Fatal validation failures and suspect-severity issues are both excluded from scoring by default (counted and reported, never silently dropped). Conservative because V1 has no human data proving suspects are safe to keep.",
  } as DocumentedDefault<ExclusionRules>,

  earlyStopFloorMeasuredTrials: {
    value: 24,
    rationale:
      "Early stop requires clear separation AND honest curve shape AND nothing open, but never before 24 measured trials — enough for the paired model to have power (Pass 4 budget tests).",
  } as DocumentedDefault<number>,

  maxSessionWallClockMs: {
    value: 55 * 60 * 1000,
    rationale:
      "55-minute hard cap from duration campaigns: past it, fatigue contaminates late rounds; the runner defers remaining work to a follow-up session instead.",
  } as DocumentedDefault<number>,

  stagedChangeStepFraction: {
    value: 0.25,
    rationale:
      "Immediate sensitivity changes are bounded to ±25 % toward the inferred optimum unless confidence ≥ 0.8 AND the boundary is resolved; larger jumps wait for retest confirmation (adaptation safety, Pass 3).",
  } as DocumentedDefault<number>,
} as const;

/** Flattened runtime view consumed by the protocol builder. */
export const RC_BUILDER_DEFAULTS = {
  warmupTrialsPerCandidateBlock: V1_RC_PROTOCOL_DEFAULTS.warmupTrialsPerCandidateBlock.value,
  measuredRepsPerCandidatePerRound: V1_RC_PROTOCOL_DEFAULTS.measuredRepsPerCandidatePerRound.value,
  ladderFactors: V1_RC_PROTOCOL_DEFAULTS.candidateLadderFactors.value,
  scenarioIds: V1_RC_PROTOCOL_DEFAULTS.targetScenarioMix.value,
  stoppingCriteria: {
    maxTotalMeasuredTrials: V1_RC_PROTOCOL_DEFAULTS.maxTotalMeasuredTrials.value,
    minValidTrialsPerCandidate: V1_RC_PROTOCOL_DEFAULTS.minValidTrialsPerCandidate.value,
    maxSearchRounds: V1_RC_PROTOCOL_DEFAULTS.maxSearchRounds.value,
    targetUtilityCiHalfWidth: null,
  } satisfies StoppingCriteria,
  adaptiveAllocation: V1_RC_PROTOCOL_DEFAULTS.adaptiveAllocation.value,
  fatigueProtocol: {
    maxContinuousTestingMs: V1_RC_PROTOCOL_DEFAULTS.maxContinuousActiveTimeMs.value,
    restDurationMs: V1_RC_PROTOCOL_DEFAULTS.restDurationMs.value,
    degradationWindowTrials: V1_RC_PROTOCOL_DEFAULTS.degradationWindowTrials.value,
    degradationRatioThreshold: V1_RC_PROTOCOL_DEFAULTS.degradationRatioThreshold.value,
  } satisfies FatigueProtocolConfig,
  yExploration: V1_RC_PROTOCOL_DEFAULTS.jointXY.value,
  exclusionRules: V1_RC_PROTOCOL_DEFAULTS.exclusionRules.value,
  restBetweenCandidatesMs: V1_RC_PROTOCOL_DEFAULTS.restBetweenCandidatesMs.value,
} as const;

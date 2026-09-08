import type { AimDimension, Recommendation } from "../../src/domain/recommendation.ts";
import type { FinalResult } from "../../src/results/finalResult.ts";
import type {
  SessionInstrumentation,
  SessionOutcomeReport,
} from "../../src/results/sessionOutcome.ts";
import {
  explainExclusions,
  summarizeExclusions,
} from "../../src/results/sessionOutcome.ts";
import {
  classifyRecommendation,
  describeAimTendency,
  type RecommendationPresentation,
} from "../../src/results/recommendationState.ts";
import { CALIBRATION_MODES } from "../../src/experiments/sessionModes.ts";
import type { GameRecommendationOutcome } from "./gameConversionBridge.ts";
import { profileStatusBadge } from "./gameProfileView.ts";
import { el, clear } from "./dom.ts";
import {
  badge,
  barChart,
  button,
  card,
  codeChip,
  detailsBlock,
  emptyState,
  grid,
  icon,
  inlineAlert,
  jsonBlock,
  kvList,
  meter,
  pageHeader,
  rangeBar,
  sectionLabel,
  statTile,
  table,
  type StatOptions,
  type Tone,
} from "./ui.ts";

export interface ResultsInput {
  recommendation: Recommendation | null;
  trialsAnalyzed: number;
  /** Pass 5 frozen results contract; rendered as the headline when present. */
  finalResult?: FinalResult | null | undefined;
  /**
   * What the session did and what it proved. Present for every session run in
   * this launch; absent only when the screen is showing a stored result from
   * an earlier launch.
   */
  outcome?: SessionOutcomeReport | null | undefined;
  /** Navigates to the Test tab (empty-state CTA). */
  onStartTest?: (() => void) | undefined;
  /** Resumes the unfinished calibration this report belongs to. */
  onContinueCalibration?: (() => void) | null | undefined;
  /** Opens Diagnostics on the capture check. */
  onRunCaptureCheck?: (() => void) | null | undefined;
  /**
   * The selected game's conversion of this recommendation, built by the
   * engine's game-profile layer (Game Profile Pass 1, requirement 19).
   * Absent or `no-profile-selected` simply means no game section is drawn.
   */
  gameRecommendation?: GameRecommendationOutcome | null | undefined;
  /** Opens the Aim Test screen, where a game profile is chosen. */
  onChooseGameProfile?: (() => void) | null | undefined;
}

const NEXT_ACTION_LABELS: Record<string, string> = {
  "apply-recommended-change": "Apply the recommended change",
  "apply-staged-change": "Apply the first step now",
  "run-targeted-retest": "Run the targeted retest",
  "run-clean-repeat": "Run one clean repeat session",
  "recalibrate-first": "Recalibrate before trusting results",
  "collect-more-sessions": "Collect more sessions first",
  "keep-current-settings": "Keep your current settings",
};

const DIMENSION_LABELS: Record<AimDimension, string> = {
  speed: "Speed",
  accuracy: "Accuracy",
  overshootControl: "Overshoot control",
  undershootControl: "Undershoot control",
  correctionEfficiency: "Correction efficiency",
  trackingPrecision: "Tracking",
  consistency: "Consistency",
};

/**
 * Presentation tone for confidence, derived from the ENGINE-owned
 * `confidenceLabel` (low / moderate / high, thresholds live in the engine's
 * CONFIDENCE_LABEL_THRESHOLDS) — never re-derived from the raw number here,
 * so UI color and engine wording can never disagree.
 */
function confidenceLabelTone(label: string): Tone {
  if (label === "high") return "ok";
  if (label === "moderate") return "warn";
  return "danger";
}

/**
 * The results screen, in the order a player asks the questions.
 *
 * 1. What sensitivity should I use?
 * 2. How confident is trAIMer?
 * 3. What is my main aiming tendency?
 * 4. How did I perform?
 * 5. What should I do next?
 *
 * rc.7 answered those in roughly the reverse order, interleaved with
 * candidate utility scores, standard errors, scenario contribution tables,
 * search coverage and two raw JSON dumps — all on the first screen. None of
 * that information is gone: it moved, whole, into **Advanced results**.
 */
export function renderResultsView(
  container: HTMLElement,
  input: ResultsInput,
): void {
  clear(container);
  container.append(
    pageHeader("Results", "What the evidence says about your sensitivity."),
  );

  const outcome = input.outcome ?? null;

  // An early ending is the FIRST thing a player needs to know, because it
  // changes what every number below means. A completed session says so in one
  // line and gets out of the way; the full breakdown lives in Advanced.
  if (outcome) container.append(renderEndingBanner(outcome));

  if (!input.recommendation) {
    if (outcome) {
      container.append(renderMoreDataNeeded(outcome));
      const nextWhenShort = renderNextSteps(outcome, null, null, input);
      if (nextWhenShort) container.append(nextWhenShort);
      container.append(renderPerformanceCards(outcome, null));
      if (outcome.performance.excludedTrials > 0) {
        container.append(renderExclusions(outcome));
      }
      container.append(renderAdvancedResults(outcome, null, null, input));
      return;
    }
    const startBtn = input.onStartTest
      ? button("Start an aim test", { variant: "primary", icon: "play", onClick: () => input.onStartTest?.() })
      : undefined;
    container.append(
      emptyState(
        "results",
        "No results yet",
        "Complete an aim test session and your recommendation — with the evidence behind it — will appear here.",
        startBtn,
      ),
    );
    return;
  }

  const rec = input.recommendation;
  const fr = input.finalResult ?? null;

  if (fr) {
    renderFinalResult(container, fr, rec, input);
  } else {
    renderLegacyRecommendation(container, rec, input);
  }
}

// ---------------------------------------------------------------------------
// 1–2. The headline: what to use, and how much trAIMer will stand behind it
// ---------------------------------------------------------------------------

/**
 * One line about how the session ended.
 *
 * Full progress, block/round position and reason codes moved into Advanced
 * results: a player who finished normally does not need a progress meter that
 * reads 100 %, and a player who did not needs one sentence, not a table.
 */
function renderEndingBanner(outcome: SessionOutcomeReport): HTMLElement {
  if (!outcome.endedEarly) {
    return inlineAlert(
      "ok",
      "Calibration complete",
      `${outcome.performance.measuredTrials} measured drills · ${outcome.performance.validMeasuredTrials} usable for scoring`,
    );
  }
  return inlineAlert(
    "warn",
    END_TITLES[outcome.endKind],
    `${outcome.endReasonText} Every drill you finished was saved the moment it finished.`,
  );
}

function renderHeadline(
  fr: FinalResult,
  presentation: RecommendationPresentation,
  outcome: SessionOutcomeReport | null,
): HTMLElement {
  const rangeFirst = presentation.emphasizeRange;
  const body: (Node | string)[] = [];

  const status = el("div", { class: `result-status tone-${presentation.tone}` });
  status.append(
    icon(presentation.tone === "ok" ? "check" : "warn", 16),
    el("span", { class: "result-status-title", text: presentation.title }),
    el("span", {
      class: "result-status-strength",
      text: `${(presentation.confidence * 100).toFixed(0)}% evidence strength`,
    }),
  );
  body.push(status);

  // A number the engine will not stand behind must not be typeset like one it
  // will. When the evidence is weak the RANGE is the result and gets the
  // large treatment; the point estimate shrinks to a caption inside it.
  const sens = el("div", {
    class: `sens-headline${rangeFirst ? " range-first" : ""}`,
  });
  sens.append(
    el("div", { class: "sens-values" }, [
      el("span", { class: "sens-big", text: fr.immediateRecommended.sensXPercent.toFixed(2) }),
      el("span", { class: "sens-axis", text: "X %" }),
      el("span", { class: "sens-big", text: fr.immediateRecommended.sensYPercent.toFixed(2) }),
      el("span", { class: "sens-axis", text: "Y %" }),
    ]),
    el("span", {
      class: "sens-edpi",
      text: `${fr.immediateRecommended.edpi.toFixed(0)} eDPI · you are on ${fr.currentSensitivity.sensXPercent.toFixed(2)}% (${fr.currentSensitivity.edpi.toFixed(0)} eDPI)`,
    }),
  );
  body.push(sens);

  body.push(
    el("p", {
      class: rangeFirst ? "range-lead" : "muted",
      text: rangeFirst
        ? "The evidence supports this RANGE. Anywhere inside it is consistent with what this session measured — treat the single number as its midpoint, not as a verdict."
        : "Plausible range for your optimum, from this session's evidence:",
    }),
  );
  body.push(
    rangeBar(
      fr.plausibleEdpiRange,
      [
        { value: fr.currentSensitivity.edpi, label: "current", tone: "neutral" },
        {
          value: fr.immediateRecommended.edpi,
          label: rangeFirst ? "midpoint" : "use now",
          tone: rangeFirst ? "warn" : "accent",
        },
      ],
      (v) => `${v.toFixed(0)} eDPI`,
    ),
  );

  body.push(el("p", { class: "result-summary", text: presentation.summary }));

  if (outcome) {
    const tendency = describeAimTendency({
      overshootTendency: outcome.performance.overshootTendency,
      undershootTendency: outcome.performance.undershootTendency,
      validTrials: outcome.performance.validMeasuredTrials,
    });
    if (tendency.claimSupported) {
      body.push(el("p", { class: "result-summary", text: tendency.detail }));
    }
  }

  if (fr.fullInferredSensitivity) {
    body.push(
      el("p", { class: "muted" }, [
        el("strong", { text: "Why not the full change? " }),
        `Large sensitivity jumps disrupt trained aim, so this is a staged step toward ${fr.fullInferredSensitivity.sensXPercent.toFixed(2)}% (${fr.fullInferredSensitivity.edpi.toFixed(0)} eDPI). Play on the value above, retest, then step further only if the evidence holds.`,
      ]),
    );
  }

  return card(
    {
      title: "Recommended sensitivity",
      icon: "target",
      tone: presentation.tone === "ok" ? "accent" : presentation.tone,
      class: `hero result-headline${rangeFirst ? " tentative" : ""}`,
    },
    ...body,
  );
}

// ---------------------------------------------------------------------------
// 3–4. Performance cards — a small number of understandable numbers
// ---------------------------------------------------------------------------

/**
 * The four cards on the first screen.
 *
 * Reaction time is deliberately NOT here. It is measured from the moment the
 * app decides a target exists to the first movement past a displacement
 * threshold, which includes display latency the app cannot see and can fire
 * on a hand that was still moving from the previous drill — this session
 * reported a 85 ms median, well below human simple reaction time. It stays in
 * Advanced results with that caveat attached rather than being presented to a
 * player as their reflexes.
 */
function renderPerformanceCards(
  outcome: SessionOutcomeReport,
  presentation: RecommendationPresentation | null,
): HTMLElement {
  const m = outcome.performance;
  const cards = el("div", { class: "player-cards", id: "results-player-cards" });

  cards.append(
    playerCard(
      "Accuracy",
      m.hitAccuracy === null ? "—" : `${Math.round(m.hitAccuracy * 100)}%`,
      m.hitAccuracy === null
        ? "No shots recorded yet"
        : `${m.shotsFired} shots across the drills that ask for one`,
      m.hitAccuracy === null ? "neutral" : m.hitAccuracy >= 0.7 ? "ok" : "warn",
    ),
  );

  const tendency = describeAimTendency({
    overshootTendency: m.overshootTendency,
    undershootTendency: m.undershootTendency,
    validTrials: m.validMeasuredTrials,
  });
  cards.append(
    playerCard(
      "Aim control",
      m.overshootTendency === null || m.undershootTendency === null
        ? "—"
        : `${Math.round(m.overshootTendency * 100)}% / ${Math.round(m.undershootTendency * 100)}%`,
      `overshoot / undershoot — ${tendency.headline}`,
      tendency.claimSupported ? "info" : "neutral",
    ),
  );

  cards.append(
    playerCard(
      "Tracking",
      m.trackingTimeOnTarget === null
        ? "—"
        : `${Math.round(m.trackingTimeOnTarget * 100)}%`,
      m.trackingRmsErrorPx === null
        ? `${m.trackingTrials} tracking drill(s)`
        : `time on target · ${Math.round(m.trackingRmsErrorPx)} px average miss`,
      m.trackingTimeOnTarget === null ? "neutral" : "info",
    ),
  );

  const confidenceWord = presentation
    ? presentation.title.replace(" recommendation", "")
    : "Not enough to rank";
  cards.append(
    playerCard(
      "Evidence quality",
      String(m.validMeasuredTrials),
      `usable drills of ${m.measuredTrials} measured · ${confidenceWord.toLowerCase()}`,
      m.excludedTrials === 0 ? "ok" : "warn",
    ),
  );

  return card(
    {
      title: "How you performed",
      subtitle: "Measured from the drills that produced usable data.",
      icon: "pulse",
    },
    cards,
  );
}

function playerCard(
  label: string,
  value: string,
  sub: string,
  tone: Tone | "neutral",
): HTMLElement {
  const opts: StatOptions = { sub };
  if (tone !== "neutral") opts.tone = tone as Tone;
  return statTile(label, value, opts);
}

// ---------------------------------------------------------------------------
// 5. What to do next — the ACTUAL next step for this session's state
// ---------------------------------------------------------------------------

function renderNextSteps(
  outcome: SessionOutcomeReport | null,
  fr: FinalResult | null,
  presentation: RecommendationPresentation | null,
  input: ResultsInput,
): HTMLElement | null {
  const actions = el("div", { class: "next-actions" });
  const lines: string[] = [];
  const instrumentation = outcome?.instrumentation ?? null;
  const captureImprovable =
    instrumentation?.captureTier != null &&
    instrumentation.captureTier > 1 &&
    instrumentation.nativeRejectedBecause != null &&
    /unvalidated|capture check|not synchronized/i.test(
      instrumentation.nativeRejectedBecause,
    );

  // A software fault that has since been fixed must NEVER be turned into
  // homework for the player. If the only reason drills were lost is one the
  // app owns, the remedy is not "retest harder".
  const explanations = outcome
    ? explainExclusions(outcome.performance.exclusionsByReason)
    : [];
  const onlySoftwareFaults =
    explanations.length > 0 && explanations.every((e) => e.softwareFault);
  const playerActionable = explanations.filter((e) => e.action !== null);

  if (captureImprovable && input.onRunCaptureCheck) {
    lines.push(
      "Run the capture check once. It measures what your mouse actually delivers and lets trAIMer say how much of the range is your aim and how much is the capture path.",
    );
    actions.append(
      button("Run capture check", {
        variant: presentation ? "secondary" : "primary",
        icon: "pulse",
        onClick: () => input.onRunCaptureCheck?.(),
      }),
    );
  }

  if (!presentation || presentation.state === "insufficient") {
    if (input.onContinueCalibration) {
      lines.push(
        "Continue this calibration. It picks up exactly where the session stopped — nothing already measured is measured again.",
      );
      actions.append(
        button("Continue calibration", {
          variant: "primary",
          icon: "play",
          large: true,
          onClick: () => input.onContinueCalibration?.(),
        }),
      );
    }
  } else if (
    presentation.state === "directional-estimate" ||
    presentation.state === "preliminary"
  ) {
    if (input.onContinueCalibration) {
      lines.push(
        "Add more drills to the same calibration. More evidence narrows the range; starting over throws away what this session already proved.",
      );
      actions.append(
        button("Continue calibration", {
          variant: "primary",
          icon: "play",
          large: true,
          onClick: () => input.onContinueCalibration?.(),
        }),
      );
    }
    lines.push(
      `Meanwhile, playing anywhere inside ${fr ? `${fr.plausibleEdpiRange.min.toFixed(0)}–${fr.plausibleEdpiRange.max.toFixed(0)} eDPI` : "the range above"} is consistent with what was measured.`,
    );
  } else if (fr) {
    lines.push(
      NEXT_ACTION_LABELS[fr.recommendedNextAction] ?? fr.recommendedNextAction,
    );
    if (fr.nextActionRationale.length > 0) {
      lines.push(...fr.nextActionRationale.slice(0, 2));
    }
    if (input.onStartTest) {
      actions.append(
        button("Run a clean repeat", {
          variant: "secondary",
          icon: "play",
          onClick: () => input.onStartTest?.(),
        }),
      );
    }
  }

  if (onlySoftwareFaults) {
    lines.push(
      "The drills that could not be scored were lost to a measurement fault in the app, not to anything you did — there is nothing to change on your side.",
    );
  } else if (playerActionable.length > 0) {
    for (const e of playerActionable.slice(0, 2)) {
      if (e.action) lines.push(e.action);
    }
  }

  if (input.onStartTest && actions.childElementCount === 0) {
    actions.append(
      button("Start a new calibration", {
        variant: "secondary",
        icon: "play",
        onClick: () => input.onStartTest?.(),
      }),
    );
  }
  if (lines.length === 0 && actions.childElementCount === 0) return null;

  return card(
    { title: "What to do next", icon: "flag", tone: "info", class: "next-steps" },
    el("ul", { class: "next-action-list" }, lines.map((l) => el("li", { text: l }))),
    actions,
  );
}

// ---------------------------------------------------------------------------
// Exclusions, in words a player can act on
// ---------------------------------------------------------------------------

function renderExclusions(outcome: SessionOutcomeReport): HTMLElement {
  const m = outcome.performance;
  const explanations = explainExclusions(m.exclusionsByReason);
  const technical = el("div", {});
  for (const e of explanations) {
    const row = el("div", { class: "exclusion-row" });
    row.append(
      el("div", { class: "exclusion-head" }, [
        el("span", { class: "exclusion-count", text: `${e.count}×` }),
        el("span", { class: "exclusion-label", text: e.label }),
        codeChip(e.code),
      ]),
      el("p", { class: "muted", text: e.plain }),
    );
    if (e.action) row.append(el("p", { class: "exclusion-action", text: e.action }));
    technical.append(row);
  }

  return card(
    {
      title: "Drills that could not be scored",
      icon: "warn",
      tone: "warn",
      class: "exclusion-card",
    },
    el("p", {
      class: "exclusion-summary",
      text: summarizeExclusions(m.excludedTrials, m.measuredTrials, m.exclusionsByReason),
    }),
    detailsBlock("Learn more — exactly what happened", technical),
  );
}

// ---------------------------------------------------------------------------
// Advanced results — everything the engine knows, one click away
// ---------------------------------------------------------------------------

/**
 * NOTHING is discarded to simplify the first screen.
 *
 * Every table, standard error, coverage classification, contribution row and
 * raw contract that rc.7 printed at the top of the results page is rendered
 * here, plus the session instrumentation this pass added. The default view is
 * shorter because this section exists, not because the engine says less.
 */
function renderAdvancedResults(
  outcome: SessionOutcomeReport | null,
  fr: FinalResult | null,
  rec: Recommendation | null,
  input: ResultsInput,
): HTMLElement {
  const body = el("div", { class: "advanced-body" });

  if (outcome) {
    body.append(sectionLabel("Session"));
    const p = outcome.progress;
    const modeId = outcome.instrumentation?.modeId ?? null;
    const modeLabel =
      modeId && modeId !== "custom" ? CALIBRATION_MODES[modeId].label : "Custom plan";
    body.append(
      kvList([
        ["Calibration length", modeLabel],
        // The ending SENTENCE is on the banner at the top of the screen and
        // is deliberately not repeated here: rc.6 shipped a results page that
        // said "You ended the session from the arena controls. You ended the
        // session from the arena controls."
        ["Ending", `${END_TITLES[outcome.endKind]} (${outcome.endReasonCode ?? "no code"})`],
        ["Progress", `${Math.round(p.fraction * 100)}% · ${p.stepsCompleted} of ${p.stepsPlanned} drills`],
        ["Reached", `round ${p.roundIndex} of ${p.roundsPlanned}, block ${p.blockIndex} of ${p.blocksPerRound}`],
        ["Measured drills", `${p.measuredCompleted} of ${p.measuredPlanned} planned`],
      ]),
    );
    body.append(meter(p.fraction, { tone: outcome.endedEarly ? "warn" : "ok", label: "calibration progress" }));

    body.append(sectionLabel("Every measurement this session produced"));
    body.append(renderEvidenceSoFar(outcome));

    const instrumentation = outcome.instrumentation ?? null;
    if (instrumentation) {
      body.append(sectionLabel("Capture and timing diagnostics"));
      body.append(renderInstrumentation(instrumentation));
    }
  }

  if (fr && rec) {
    body.append(sectionLabel("Candidate comparison"));
    body.append(renderCandidateComparison(fr));
    body.append(sectionLabel("Performance dimensions"));
    body.append(renderDimensionBreakdown(rec));
    if (fr.scenarioContributions.length > 0) {
      body.append(sectionLabel("Scenario contributions"));
      body.append(
        table({
          head: ["Scenario", "Difficulty", "Valid trials", "Best candidate", "Runner-up"],
          rows: fr.scenarioContributions.map((sc) => [
            sc.scenarioId,
            sc.difficultyTier,
            String(sc.validTrials),
            sc.meanUtilityBest !== null ? sc.meanUtilityBest.toFixed(3) : "—",
            sc.meanUtilityRunnerUp !== null ? sc.meanUtilityRunnerUp.toFixed(3) : "—",
          ]),
        }),
      );
    }
    body.append(sectionLabel("Search coverage and quality"));
    body.append(
      kvList([
        ["Curve shape", fr.searchAdequacyClassification ?? "—"],
        ["Boundary", fr.boundaryStatus],
        ["Adaptation detected", fr.adaptationContamination ? "yes" : "no"],
        [
          "Capture quality",
          fr.captureQualityGrade
            ? `${fr.captureQualityGrade}${fr.captureQualityScore !== null ? ` (score ${fr.captureQualityScore.toFixed(2)})` : ""}`
            : "not graded",
        ],
        ["Confidence basis", fr.confidenceBasis],
        ["Engine declined high confidence", fr.refusedHighConfidence ? "yes" : "no"],
      ]),
    );
    if (fr.uncertaintyRemaining.length > 0) {
      body.append(sectionLabel("Open questions"));
      body.append(
        el("ul", { class: "list-plain" },
          fr.uncertaintyRemaining
            .filter((l) => l !== "warnings:")
            .map((l) => el("li", { text: l }))),
      );
    }
    body.append(
      detailsBlock(
        "Full rationale",
        el("ul", { class: "list-plain" }, fr.rationaleLines.map((l) => el("li", { text: l }))),
      ),
    );
    const why = [...fr.whyThisX, ...fr.whyThisY];
    if (why.length > 0) {
      body.append(
        detailsBlock(
          "Why this candidate won",
          el("ul", { class: "list-plain" }, why.map((l) => el("li", { text: l }))),
          ...(fr.contradictoryEvidence.length > 0
            ? [
                sectionLabel("Evidence against the winner"),
                el("ul", { class: "list-plain" },
                  fr.contradictoryEvidence.map((l) => el("li", { text: l }))),
              ]
            : []),
        ),
      );
    }
    body.append(detailsBlock("Final result JSON (frozen contract)", jsonBlock(fr)));
    body.append(detailsBlock("Raw recommendation JSON", jsonBlock(rec)));
  }

  if (outcome) {
    body.append(detailsBlock("Session outcome JSON", jsonBlock(outcome)));
  }
  void input;

  return card(
    {
      title: "Advanced results",
      subtitle:
        "Every number the engine produced, including the statistics behind the recommendation. Nothing here is hidden from the summary above — it is the same session, in full.",
      icon: "results",
      class: "advanced-results",
    },
    detailsBlock("Open advanced results", body),
  );
}

function renderCandidateComparison(fr: FinalResult): HTMLElement {
  if (fr.candidateComparisons.length === 0) {
    return el("p", { class: "muted", text: "No candidate produced usable data." });
  }
  const rows = fr.candidateComparisons.map((c) => ({
    label: c.candidateId,
    value: c.utilityMean,
    se: c.utilityStandardError,
    highlight: c.isBest,
    sub: `${c.edpiX.toFixed(0)} eDPI · ${c.validTrials} trials${c.tiedWithBest && !c.isBest ? " · tied" : ""}`,
  }));
  return el("div", { id: "advanced-candidate-table" }, [
    barChart(rows, (v) => v.toFixed(3)),
    table({
      head: ["Candidate", "eDPI", "Utility", "±SE", "Valid trials", "Result"],
      rows: fr.candidateComparisons.map((c) => [
        c.candidateId,
        c.edpiX.toFixed(0),
        c.utilityMean !== null ? c.utilityMean.toFixed(4) : "—",
        c.utilityStandardError !== null ? c.utilityStandardError.toFixed(4) : "—",
        String(c.validTrials),
        c.isBest ? badge("accent", "best") : c.tiedWithBest ? badge("neutral", "tied") : "",
      ]),
    }),
  ]);
}

function renderDimensionBreakdown(rec: Recommendation): HTMLElement {
  const dims = Object.entries(rec.dimensionEstimates) as [
    AimDimension,
    { mean: number; standardError: number; sampleCount: number } | undefined,
  ][];
  const rows = dims
    .filter((entry): entry is [AimDimension, { mean: number; standardError: number; sampleCount: number }] => entry[1] !== undefined)
    .map(([dim, est]) => [
      DIMENSION_LABELS[dim] ?? dim,
      est.mean.toFixed(3),
      est.standardError.toFixed(3),
      String(est.sampleCount),
    ]);
  if (rows.length === 0) {
    return el("p", { class: "muted", text: "No dimension estimates." });
  }
  return table({ head: ["Dimension", "Mean", "±SE", "n"], rows });
}

/**
 * The local-only instrumentation this pass added, so a second real-hardware
 * session can be diagnosed from the saved result rather than from a guess.
 */
function renderInstrumentation(inst: SessionInstrumentation): HTMLElement {
  const rows: [string, string][] = [
    [
      "Capture path",
      inst.captureTierCaption
        ? `tier ${inst.captureTier ?? "?"} · ${inst.captureTierCaption}`
        : "not recorded",
    ],
  ];
  if (inst.nativeRejectedBecause) {
    rows.push(["Native capture not used because", inst.nativeRejectedBecause]);
  }
  if (inst.clockSyncState) {
    rows.push([
      "Helper clock sync",
      inst.clockOffsetMs !== null
        ? `${inst.clockSyncState} · offset ${inst.clockOffsetMs.toFixed(3)} ms ±${(inst.clockSyncUncertaintyMs ?? 0).toFixed(3)} ms`
        : inst.clockSyncState,
    ]);
  }
  if (inst.timestampLead) {
    const l = inst.timestampLead;
    rows.push([
      "Input timestamp lead",
      `${l.samples} events · worst ${l.maxLeadMs.toFixed(2)} ms · mean ${l.meanLeadMs === null ? "—" : `${l.meanLeadMs.toFixed(2)} ms`} · tolerance ${l.toleranceMs} ms`,
    ]);
    if (l.aheadOfNow > 0 || l.foreignDomain > 0 || l.missing > 0) {
      rows.push([
        "Timestamp corrections",
        `${l.aheadOfNow} ahead of clock · ${l.foreignDomain} foreign domain · ${l.missing} missing`,
      ]);
    }
  }
  if (inst.modeId) {
    rows.push([
      "Calibration mode",
      inst.modeId === "custom" ? "custom plan" : CALIBRATION_MODES[inst.modeId].label,
    ]);
  }
  if (inst.targetValidTrialsPerCandidate !== null) {
    rows.push([
      "Evidence target",
      `${inst.targetValidTrialsPerCandidate} usable drills per candidate`,
    ]);
  }
  if (inst.replacement) {
    const r = inst.replacement;
    rows.push([
      "Replacement drills",
      `${r.drillsRun} drill(s) in ${r.blocksRun} of at most ${r.maxBlocks} block(s) (cap ${r.maxDrills} drills)`,
    ]);
  }
  const block = el("div", {}, [kvList(rows)]);
  if (inst.validTrialsByCandidateEdpi.length > 0) {
    block.append(
      table({
        head: ["Candidate eDPI", "Valid measured drills"],
        rows: inst.validTrialsByCandidateEdpi.map((c) => [
          String(c.edpi),
          String(c.valid),
        ]),
      }),
    );
  }
  return block;
}

// ---------------------------------------------------------------------------
// Session outcome — what happened, how far it got, and what it proves
// ---------------------------------------------------------------------------

const END_TITLES: Record<SessionOutcomeReport["endKind"], string> = {
  completed: "Calibration complete",
  "ended-by-player": "You ended this calibration early",
  "capture-lost": "This calibration stopped early — the mouse was lost",
  "resume-failed": "This calibration stopped early — the mouse could not be taken back",
  "capture-unavailable": "This calibration never started",
  error: "This calibration stopped because of an error",
};

/**
 * One evidence tile. A measurement with no data renders as an em dash and no
 * unit — never as zero, which would read as a real (and terrible) score.
 */
function evidenceTile(
  label: string,
  value: number | null,
  format: (v: number) => string,
  unit: string,
  sub: string,
  tone?: Tone,
): HTMLElement {
  const opts: StatOptions = { sub };
  if (value !== null && unit !== "") opts.unit = unit;
  if (tone) opts.tone = tone;
  return statTile(label, value === null ? "\u2014" : format(value), opts);
}

const asPercent = (v: number): string => String(Math.round(v * 100));
const asWhole = (v: number): string => String(Math.round(v));

/** The measurements the session actually produced, however far it got. */
function renderEvidenceSoFar(outcome: SessionOutcomeReport): HTMLElement {
  const m = outcome.performance;
  const tiles = grid(
    4,
    statTile("Drills completed", String(m.trialsCompleted), {
      sub: `${m.measuredTrials} measured \u00b7 ${m.warmupTrials} warm-up`,
    }),
    statTile("Valid for scoring", String(m.validMeasuredTrials), {
      sub: m.excludedTrials > 0 ? `${m.excludedTrials} excluded` : "none excluded",
      tone: m.excludedTrials > 0 ? "warn" : "ok",
    }),
    evidenceTile("Hit accuracy", m.hitAccuracy, asPercent, "%", `${m.shotsFired} shots fired`),
    evidenceTile("Reaction time", m.reactionTimeMs, asWhole, "ms", "median, to target appearing"),
    evidenceTile("Overshoot", m.overshootTendency, asPercent, "%", "mean past the centre"),
    evidenceTile("Undershoot", m.undershootTendency, asPercent, "%", "mean short of the centre"),
    evidenceTile(
      "Corrections",
      m.correctionsPerShot,
      (v) => v.toFixed(1),
      "",
      "extra sub-movements per shot",
    ),
    evidenceTile(
      "Consistency",
      m.acquisitionTimeCv,
      asPercent,
      "%",
      "spread of acquisition time \u2014 lower is steadier",
    ),
    evidenceTile(
      "Tracking on target",
      m.trackingTimeOnTarget,
      asPercent,
      "%",
      `${m.trackingTrials} tracking drill(s)`,
    ),
    evidenceTile(
      "Tracking error",
      m.trackingRmsErrorPx,
      asWhole,
      "px",
      "median RMS distance off centre",
    ),
  );
  return card(
    {
      title: "The evidence so far",
      subtitle:
        "Measured from your completed drills. A dash means that measurement has no data yet.",
      icon: "results",
    },
    tiles,
  );
}

/**
 * The honest alternative to a recommendation.
 *
 * Shown whenever the evidence does not support a defensible sensitivity call:
 * WHY it is not enough, HOW MUCH more is needed, and the one action that
 * actually helps — continuing the same calibration rather than starting over.
 */
function renderMoreDataNeeded(outcome: SessionOutcomeReport): HTMLElement {
  const s = outcome.sufficiency;
  const body: (Node | string)[] = [];
  body.push(
    el("p", {
      class: "more-data-lead",
      text: "trAIMer will not guess a sensitivity for you. Here is exactly what is missing.",
    }),
  );

  body.push(sectionLabel("Why this is not enough yet"));
  const reasons = el("ul", { class: "reason-list" });
  for (const reason of s.reasons.length > 0
    ? s.reasons
    : ["No measured drills were completed."]) {
    reasons.append(el("li", { text: reason }));
  }
  body.push(reasons);

  body.push(sectionLabel("How much more testing"));
  body.push(
    kvList([
      [
        "Measured drills still needed",
        `about ${s.additionalMeasuredTrialsNeeded}`,
      ],
      ["Rough time", `about ${s.estimatedAdditionalMinutes} minute(s) of drills`],
      [
        "Completed so far",
        `${outcome.performance.validMeasuredTrials} valid measured drills`,
      ],
    ]),
  );

  body.push(
    detailsBlock(
      "The engine's own next steps",
      el("ol", { class: "next-step-list" }, s.nextSteps.map((step) => el("li", { text: step }))),
    ),
  );

  return card(
    {
      title: "More data needed",
      subtitle: "Not enough evidence yet for a sensitivity recommendation.",
      icon: "warn",
      tone: "warn",
      class: "more-data-card",
    },
    ...body,
  );
}

// ---------------------------------------------------------------------------
// FinalResult (frozen results contract) — the headline experience
// ---------------------------------------------------------------------------

/**
 * "Recommended for [Game]" (Game Profile Pass 1, requirement 19).
 *
 * Three numbers, in the order a player asks for them — what they are on now,
 * what to set, and the physical sensitivity underneath both — plus every
 * consequence of the game's own precision limits. Nothing here is computed in
 * the view: it renders `GameRecommendationExport` fields verbatim.
 *
 * The section deliberately claims no more certainty than the calibration
 * above it: it converts the recommendation, it does not strengthen it.
 */
function renderGameRecommendation(input: ResultsInput): HTMLElement | null {
  const outcome = input.gameRecommendation ?? null;
  if (!outcome || outcome.kind === "no-profile-selected") return null;

  if (outcome.kind === "unavailable") {
    const actions: (Node | string)[] = [
      el("p", { class: "note", text: outcome.reason }),
    ];
    if (input.onChooseGameProfile) {
      actions.push(
        el("div", {}, [
          button("Choose a game", {
            variant: "secondary",
            icon: "target",
            onClick: () => input.onChooseGameProfile?.(),
          }),
        ]),
      );
    }
    return card(
      { title: "Recommended for your game", icon: "target" },
      ...actions,
    );
  }

  const g = outcome.exported;
  const body: (Node | string)[] = [];

  const statusBadge = profileStatusBadge({ status: g.profileStatus });
  if (statusBadge) body.push(el("div", {}, [statusBadge]));

  body.push(
    grid(
      3,
      statTile(
        "Current",
        g.current ? g.current.hipfire.toFixed(2) : "\u2014",
        {
          sub: g.current
            ? `${g.current.cmPer360X.toFixed(1)} cm/360`
            : "not entered",
        },
      ),
      statTile("Recommended", g.recommended.hipfire.value.ui.toFixed(2), {
        tone: "accent",
        sub: `${g.recommended.achievedCmPer360.x.toFixed(1)} cm/360`,
      }),
      statTile("Physical equivalent", g.physicalEquivalent.cmPer360X.toFixed(1), {
        unit: "cm/360",
        sub: "How far your hand moves for a full turn",
      }),
    ),
  );

  body.push(sectionLabel(`What to set in ${g.profileDisplayName}`));
  body.push(
    kvList(
      g.entryLines.map((line): [string, string] => {
        const split = line.indexOf(": ");
        return [line.slice(0, split), line.slice(split + 2)];
      }),
    ),
  );

  if (g.changeFromCurrentPercent) {
    const change = g.changeFromCurrentPercent.x;
    body.push(
      el("p", {
        class: "result-summary",
        text:
          Math.abs(change) < 0.5
            ? "That is the sensitivity you already run, within what this game can express."
            : `That is ${Math.abs(change).toFixed(1)}% ${change > 0 ? "faster" : "slower"} than what you use today.`,
      }),
    );
  }

  // Rounding loss is never hidden (requirement 15).
  for (const note of g.precisionNotes) {
    body.push(el("p", { class: "note", text: note }));
  }
  for (const warning of g.warnings) {
    body.push(inlineAlert("warn", "Worth knowing", warning));
  }
  if (g.calibrationConfidenceLine) {
    body.push(el("p", { class: "note", text: g.calibrationConfidenceLine }));
  }
  body.push(
    el("p", {
      class: "note",
      text: "Converting a recommendation cannot make it more certain than the measurement above.",
    }),
  );

  const provenance: [string, string][] = [
    ["Scoped aim matched by", g.matchingLabel],
    ["Based on", g.physicalEquivalent.basis],
    ["What 1.00 means", g.unitDefinition],
    ["Profile source", g.provenance.sourceTitle],
    ["Checked against", g.provenance.gameVersion ?? "not tied to a game build"],
    ["Last verified", g.provenance.verifiedAtIso],
    ["Conversion definition", `v${g.profileVersion}`],
    ["DPI used", String(g.dpi)],
  ];
  if (g.provenance.sourceUrl) provenance.push(["Reference", g.provenance.sourceUrl]);
  body.push(detailsBlock("How this conversion was made", kvList(provenance)));

  return card(
    {
      title: `Recommended for ${g.profileDisplayName}`,
      subtitle: g.matchingDetail,
      icon: "target",
    },
    ...body,
  );
}

function renderFinalResult(
  outerContainer: HTMLElement,
  fr: FinalResult,
  rec: Recommendation,
  input: ResultsInput,
): void {
  const outcome = input.outcome ?? null;
  const presentation = classifyRecommendation({
    recommendation: rec,
    evidenceSufficient: outcome ? outcome.sufficiency.sufficient : true,
    refusedHighConfidence: fr.refusedHighConfidence,
  });

  const container = el("div", {
    class: `result-reveal${presentation.emphasizeRange ? " results-tentative" : ""}`,
  });
  outerContainer.append(container);

  // 1–2. What to use, and how much trAIMer will stand behind it.
  container.append(renderHeadline(fr, presentation, outcome));

  // 1b. The same answer, in the numbers the player's game accepts.
  const gameSection = renderGameRecommendation(input);
  if (gameSection) container.append(gameSection);

  // 3–4. How you performed.
  if (outcome) container.append(renderPerformanceCards(outcome, presentation));

  // 5. What to do next.
  const next = renderNextSteps(outcome, fr, presentation, input);
  if (next) container.append(next);

  // Why some drills were not scored, in plain language.
  if (outcome && outcome.performance.excludedTrials > 0) {
    container.append(renderExclusions(outcome));
  }

  // Everything else, one click away.
  container.append(renderAdvancedResults(outcome, fr, rec, input));
}

// ---------------------------------------------------------------------------
// Legacy path: a recommendation without the FinalResult contract
// ---------------------------------------------------------------------------

function renderLegacyRecommendation(
  container: HTMLElement,
  rec: Recommendation,
  input: ResultsInput,
): void {
  const confTone = confidenceLabelTone(rec.confidenceLabel);
  container.append(
    grid(
      2,
      card(
        { title: "Recommended sensitivity", icon: "target", tone: "accent", class: "hero" },
        el("div", { class: "sens-values" }, [
          el("span", { class: "sens-big", text: rec.primarySensitivity.sensX.toFixed(2) }),
          el("span", { class: "sens-axis", text: "X %" }),
          el("span", { class: "sens-big", text: rec.primarySensitivity.sensY.toFixed(2) }),
          el("span", { class: "sens-axis", text: "Y %" }),
        ]),
        el("p", { class: "sens-edpi", text: `${rec.recommendedEdpi.toFixed(0)} eDPI · plausible ${rec.edpiRange.min.toFixed(0)}–${rec.edpiRange.max.toFixed(0)}` }),
      ),
      card(
        { title: "Evidence strength", icon: "shield" },
        el("div", { class: "confidence-row" }, [
          meter(rec.confidence, { tone: confTone, label: "confidence" }),
          el("span", { class: `confidence-pct tone-${confTone}`, text: `${(rec.confidence * 100).toFixed(0)}%` }),
        ]),
        el("p", { class: "muted", text: rec.confidenceLabel }),
        kvList([
          ["Trials analyzed / excluded", `${input.trialsAnalyzed} / ${rec.evidence.trialsExcluded}`],
          ["Separation", rec.evidence.separation],
          ["Search rounds", String(rec.evidence.searchRoundsRun)],
          ["Further testing suggested", rec.furtherTestingSuggested ? "yes" : "no"],
        ]),
      ),
    ),
  );

  if (rec.warnings.length > 0) {
    container.append(
      card(
        { title: "Warnings", icon: "warn", tone: "warn" },
        el("ul", { class: "list-plain" }, rec.warnings.map((w) => el("li", { text: w }))),
      ),
    );
  }
  container.append(
    detailsBlock(
      "Rationale",
      el("ul", { class: "list-plain" }, rec.rationaleLines.map((l) => el("li", { text: l }))),
    ),
    detailsBlock("Raw recommendation JSON", jsonBlock(rec)),
  );

  if (rec.yExploration?.explored) {
    container.append(
      card(
        { title: "Independent-Y exploration", icon: "calibration" },
        el("ul", { class: "list-plain" }, rec.yExploration.rationaleLines.map((l) => el("li", { text: l }))),
      ),
    );
  }

  container.append(
    el("p", {
      class: "note",
      text: rec.confidenceCalibration
        ? `Confidence basis: ${rec.confidenceCalibration.basis} (${rec.confidenceCalibration.heuristicVersion}) — not an empirically validated probability.`
        : "Confidence basis: heuristic.",
    }),
  );

  if (rec.inputQuality) {
    container.append(
      card(
        { title: "Input quality", icon: "mouse" },
        el("p", { text: `score ${rec.inputQuality.score.toFixed(2)} · ~${rec.inputQuality.metrics.observedRateHz.toFixed(0)} Hz` }),
        rec.inputQuality.warningLines.length > 0
          ? el("ul", { class: "list-plain" }, rec.inputQuality.warningLines.map((l) => el("li", { text: l })))
          : el("p", { class: "muted", text: "No capture-quality warnings." }),
      ),
    );
  }

  if (rec.sensitivityChangePlan?.policyApplied) {
    const plan = rec.sensitivityChangePlan;
    container.append(
      card(
        { title: "Staged change plan", icon: "flag", tone: "info" },
        el("p", {
          text: `Change to ${plan.recommendedNowSensX.toFixed(2)}% X now (full inferred optimum ${plan.fullInferredSensX.toFixed(2)}%); retest after ${plan.retestAfterSessions} session(s).`,
        }),
      ),
    );
  }

  if (rec.explanation) {
    container.append(
      detailsBlock(
        "Why this recommendation",
        el("ul", { class: "list-plain" }, [
          ...rec.explanation.whyThisX,
          ...rec.explanation.whyThisY,
          ...rec.explanation.furtherTestingActions,
        ].map((l) => el("li", { text: l }))),
      ),
    );
  }

  if (rec.adaptationEffects && rec.adaptationEffects.effects.length > 0) {
    container.append(
      el("p", {
        class: "note",
        text: rec.adaptationEffects.anySignificantImprovement
          ? "Late-session improvement detected for at least one candidate — first encounters were likely still adaptation."
          : "No significant early-vs-late adaptation detected.",
      }),
    );
  }

  // Per-candidate valid trials with best/runner-up flags.
  const bestId = rec.evidence.bestCandidateId;
  const runnerId = rec.evidence.runnerUpCandidateId;
  container.append(
    card(
      { title: "Candidates", icon: "results" },
      table({
        head: ["Candidate", "Valid trials", "Result"],
        rows: Object.entries(rec.evidence.validTrialsPerCandidate).map(([candidateId, count]) => [
          candidateId,
          String(count),
          candidateId === bestId
            ? badge("accent", "best")
            : candidateId === runnerId
              ? badge("neutral", "runner-up")
              : "",
        ]),
      }),
    ),
  );

  // Pooled dimension estimates.
  const dims = Object.entries(rec.dimensionEstimates);
  if (dims.length > 0) {
    container.append(
      card(
        { title: "Performance breakdown", subtitle: "All candidates pooled", icon: "pulse" },
        table({
          head: ["Dimension", "Mean", "±SE", "n"],
          rows: dims.map(([dim, est]) => [
            DIMENSION_LABELS[dim as AimDimension] ?? dim,
            est!.mean.toFixed(3),
            est!.standardError.toFixed(3),
            String(est!.sampleCount),
          ]),
        }),
      ),
    );
  }
}

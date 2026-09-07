import type { AimDimension, Recommendation } from "../../src/domain/recommendation.ts";
import type { FinalResult } from "../../src/results/finalResult.ts";
import type { SessionOutcomeReport } from "../../src/results/sessionOutcome.ts";
import { el, clear } from "./dom.ts";
import {
  badge,
  barChart,
  button,
  card,
  detailsBlock,
  emptyState,
  formatDateTime,
  grid,
  icon,
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

/** Player-facing labels for engine exclusion reason codes (codes stay visible). */
const EXCLUSION_LABELS: Record<string, string> = {
  IMPOSSIBLE_MOVEMENT: "Impossible movement",
  LARGE_SAMPLE_GAP: "Sample gaps",
  INSUFFICIENT_SAMPLES: "Too few samples",
  PRE_APPEARANCE_CLICK: "Click before target",
  FOCUS_LOST: "Focus lost",
  POINTER_LOCK_LOST: "Pointer lock lost",
  TIMEOUT_NO_SHOT: "No shot before timeout",
  IMPOSSIBLE_TIMESTAMPS: "Broken timestamps",
  CONFIG_MISMATCH: "Configuration mismatch",
};

function exclusionLabel(code: string): string {
  const known = EXCLUSION_LABELS[code];
  if (known) return known;
  const words = code.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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

export function renderResultsView(
  container: HTMLElement,
  input: ResultsInput,
): void {
  clear(container);
  container.append(
    pageHeader("Results", "What the evidence says about your sensitivity."),
  );

  const outcome = input.outcome ?? null;

  // A session that ran ALWAYS explains itself first — before any
  // recommendation, and whether or not one exists. rc.6 had exactly one thing
  // to render (a recommendation), so a session killed by its own first break
  // arrived here as the "No results yet" empty state.
  if (outcome) {
    container.append(renderSessionOutcome(outcome));
    container.append(renderEvidenceSoFar(outcome));
  }

  if (!input.recommendation) {
    if (outcome) {
      container.append(renderMoreDataNeeded(outcome, input));
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

function renderSessionOutcome(outcome: SessionOutcomeReport): HTMLElement {
  const p = outcome.progress;
  const percent = Math.round(p.fraction * 100);
  const tone: Tone = outcome.endedEarly ? "warn" : "ok";
  const body: (Node | string)[] = [
    el("p", { class: "outcome-reason", text: outcome.endReasonText }),
  ];

  const bar = meter(p.fraction, { tone, label: "calibration progress" });
  const progressRow = el("div", { class: "outcome-progress" }, [
    el("span", { class: "outcome-progress-value", text: `Calibration ${percent}%` }),
    bar,
  ]);
  body.push(progressRow);

  body.push(
    kvList([
      ["Drills completed", `${p.stepsCompleted} of ${p.stepsPlanned} planned`],
      ["Measured drills", `${p.measuredCompleted} of ${p.measuredPlanned} planned`],
      ["Reached", `round ${p.roundIndex} of ${p.roundsPlanned}, block ${p.blockIndex} of ${p.blocksPerRound}`],
    ]),
  );

  if (outcome.endReasonCode) {
    body.push(
      el("p", {
        class: "muted mono",
        text: `reason code: ${outcome.endReasonCode}`,
      }),
    );
  }
  if (outcome.endedEarly) {
    body.push(
      el("p", {
        class: "muted",
        text: "Every drill you finished was saved the moment it finished. Nothing measured has been lost.",
      }),
    );
  }

  return card(
    {
      title: END_TITLES[outcome.endKind],
      icon: outcome.endedEarly ? "flag" : "check",
      tone,
      class: "outcome-card",
    },
    ...body,
  );
}

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
function renderMoreDataNeeded(
  outcome: SessionOutcomeReport,
  input: ResultsInput,
): HTMLElement {
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

  body.push(sectionLabel("What to do next"));
  const steps = el("ol", { class: "next-step-list" });
  for (const step of s.nextSteps) steps.append(el("li", { text: step }));
  body.push(steps);

  const actions = el("div", { class: "more-data-actions" });
  if (input.onContinueCalibration) {
    actions.append(
      button("Continue calibration", {
        variant: "primary",
        icon: "play",
        large: true,
        onClick: () => input.onContinueCalibration?.(),
      }),
    );
  }
  if (input.onStartTest) {
    actions.append(
      button("Start a new calibration", {
        variant: "secondary",
        onClick: () => input.onStartTest?.(),
      }),
    );
  }
  body.push(actions);

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

function sensBlock(
  label: string,
  sens: { sensXPercent: number; sensYPercent: number; edpi: number },
  recommended: boolean,
): HTMLElement {
  const block = el("div", { class: `sens-block${recommended ? " recommended" : ""}` });
  block.append(el("span", { class: "sens-block-label", text: label }));
  const values = el("div", { class: "sens-values" });
  values.append(
    el("span", { class: "sens-big", text: sens.sensXPercent.toFixed(2) }),
    el("span", { class: "sens-axis", text: "X %" }),
    el("span", { class: "sens-big", text: sens.sensYPercent.toFixed(2) }),
    el("span", { class: "sens-axis", text: "Y %" }),
  );
  block.append(values);
  block.append(el("span", { class: "sens-edpi", text: `${sens.edpi.toFixed(0)} eDPI` }));
  return block;
}

function renderFinalResult(
  outerContainer: HTMLElement,
  fr: FinalResult,
  rec: Recommendation,
  input: ResultsInput,
): void {
  // The engine's own refusal flag drives the tentative treatment: a result
  // the engine declined to back must not look like a confident verdict.
  const tentative = fr.refusedHighConfidence;
  const container = el("div", {
    class: `result-reveal${tentative ? " results-tentative" : ""}`,
  });
  outerContainer.append(container);

  // ---- hero ----
  const compare = el("div", { class: "sens-compare" });
  compare.append(
    sensBlock("Current", fr.currentSensitivity, false),
    el("span", { class: "sens-arrow" }, [icon("arrow-right", 20)]),
    sensBlock(tentative ? "Preliminary" : "Use now", fr.immediateRecommended, true),
  );
  if (fr.fullInferredSensitivity) {
    compare.append(
      el("span", { class: "sens-arrow" }, [icon("arrow-right", 20)]),
      sensBlock("Full target", fr.fullInferredSensitivity, false),
    );
  }

  const heroBody: (Node | string)[] = [compare];

  if (tentative) {
    const note = el("p", { class: "tentative-note" });
    note.append(
      icon("warn", 14),
      el("span", {
        text: "Preliminary — the engine wants more evidence before you commit. Treat the range below, not the point, as the result.",
      }),
    );
    heroBody.push(note);
  }

  if (fr.fullInferredSensitivity) {
    const staged = el("div", {}, [
      el("p", { class: "muted" }, [
        el("strong", { text: "Why two numbers? " }),
        "Large sensitivity jumps disrupt trained aim, so the change is staged: " +
          `play on the "use now" value, retest, and step toward the full target only as the evidence holds up.`,
      ]),
    ]);
    heroBody.push(staged);
  }

  heroBody.push(
    rangeBar(
      fr.plausibleEdpiRange,
      [
        { value: fr.currentSensitivity.edpi, label: "current", tone: "neutral" },
        {
          value: fr.immediateRecommended.edpi,
          label: tentative ? "preliminary" : "use now",
          tone: tentative ? "warn" : "accent",
        },
        ...(fr.fullInferredSensitivity
          ? [{ value: fr.fullInferredSensitivity.edpi, label: "full target", tone: "info" as Tone }]
          : []),
      ],
      (v) => `${v.toFixed(0)} eDPI`,
    ),
  );

  const heroCard = card(
    {
      title: "Recommended sensitivity",
      subtitle: `DPI ${fr.dpi} · ${fr.experimentId}`,
      icon: "target",
      tone: "accent",
      class: "hero",
    },
    ...heroBody,
  );

  // ---- next action + confidence ----
  const actionLabel = NEXT_ACTION_LABELS[fr.recommendedNextAction] ?? fr.recommendedNextAction;
  const conf = fr.confidence;
  const confTone = confidenceLabelTone(fr.confidenceLabel);

  // Retest plan folds into the action card — one place answers "what next,
  // why, and when can I start".
  const plan = fr.retestProtocol && fr.retestProtocol.kind !== "none" ? fr.retestProtocol : null;
  const planBlock: HTMLElement[] = [];
  if (plan) {
    const restLine = el("div", { class: `inline-alert ${plan.canStartNow ? "tone-bg-ok" : "tone-bg-info"}` });
    restLine.append(
      el("span", { class: plan.canStartNow ? "tone-ok" : "tone-info" }, [
        icon(plan.canStartNow ? "check" : "clock", 14),
      ]),
      el("div", { class: "inline-alert-text" }, [
        el("p", {
          text: plan.canStartNow
            ? "Rest requirement met — the next session is ready whenever you are."
            : `Rest first: the next session unlocks at ${formatDateTime(plan.earliestStartIso)}.`,
        }),
        el("p", {
          class: "inline-alert-detail",
          text:
            plan.kind === "targeted-retest"
              ? `A shorter, focused session is already designed to resolve: ${plan.uncertaintyToResolve}`
              : `A clean repeat with fresh randomization will confirm what this session saw.`,
        }),
      ]),
    );
    planBlock.push(restLine);
  }

  // Lead with the most useful rationale; the full engine narrative stays one
  // click away rather than dominating the card.
  const leadRationale = fr.nextActionRationale.slice(0, 3);
  const moreRationale = fr.nextActionRationale.slice(3);
  const actionCard = card(
    { title: "What to do next", icon: "flag", tone: "info" },
    el("p", { style: "font-size:16px;font-weight:700", text: actionLabel }),
    el("ul", { class: "next-action-list" },
      leadRationale.map((l) => el("li", { text: l }))),
    ...(moreRationale.length > 0
      ? [detailsBlock(
          `Full reasoning (${fr.nextActionRationale.length} points)`,
          el("ul", { class: "next-action-list" },
            moreRationale.map((l) => el("li", { text: l }))),
        )]
      : []),
    ...planBlock,
    el("div", {}, [
      sectionLabel("Evidence strength"),
      el("div", { class: "confidence-row" }, [
        meter(conf, { tone: confTone, label: "confidence" }),
        el("span", { class: `confidence-pct tone-${confTone}`, text: `${(conf * 100).toFixed(0)}%` }),
      ]),
      el("p", { class: "muted", text: `${fr.confidenceLabel} · ${fr.confidenceBasis}` }),
    ]),
  );

  container.append(el("div", { class: "result-hero" }, [heroCard, actionCard]));

  // ---- evidence ----
  const evidenceGrid = grid(2);

  // Candidate comparison.
  if (fr.candidateComparisons.length > 0) {
    const rows = fr.candidateComparisons.map((c) => ({
      label: c.candidateId,
      value: c.utilityMean,
      se: c.utilityStandardError,
      highlight: c.isBest,
      sub: `${c.edpiX.toFixed(0)} eDPI · ${c.validTrials} trials${c.tiedWithBest && !c.isBest ? " · tied" : ""}`,
    }));
    const why: HTMLElement[] = [];
    const whyLines = [...fr.whyThisX, ...fr.whyThisY];
    if (whyLines.length > 0) {
      why.push(
        detailsBlock(
          "Why this candidate won",
          el("ul", { class: "list-plain" }, whyLines.map((l) => el("li", { text: l }))),
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
    evidenceGrid.append(
      card(
        {
          title: "Candidate comparison",
          subtitle: "Higher utility = better overall aim performance",
          icon: "results",
        },
        barChart(rows, (v) => v.toFixed(3)),
        ...why,
      ),
    );
  }

  // Performance dimensions.
  const dims = Object.entries(rec.dimensionEstimates) as [
    AimDimension,
    { mean: number; standardError: number; sampleCount: number } | undefined,
  ][];
  if (dims.length > 0) {
    const dimGrid = el("div", { class: "grid cols-2" });
    for (const [dim, est] of dims) {
      if (!est) continue;
      dimGrid.append(
        statTile(DIMENSION_LABELS[dim] ?? dim, est.mean.toFixed(3), {
          sub: `± ${est.standardError.toFixed(3)} SE · n=${est.sampleCount}`,
        }),
      );
    }
    evidenceGrid.append(
      card(
        {
          title: "Performance breakdown",
          subtitle: "All candidates pooled · 0–1 scale per dimension",
          icon: "pulse",
        },
        dimGrid,
      ),
    );
  }

  if (evidenceGrid.childElementCount > 0 || fr.scenarioContributions.length > 0) {
    container.append(sectionLabel("Evidence"));
  }
  if (evidenceGrid.childElementCount > 0) container.append(evidenceGrid);

  // Scenario contributions.
  if (fr.scenarioContributions.length > 0) {
    container.append(
      card(
        { title: "Scenario contributions", subtitle: "How each drill fed the comparison", icon: "target" },
        table({
          head: ["Scenario", "Difficulty", "Valid trials", "Best candidate", "Runner-up"],
          rows: fr.scenarioContributions.map((s) => [
            s.scenarioId,
            s.difficultyTier,
            String(s.validTrials),
            s.meanUtilityBest !== null ? s.meanUtilityBest.toFixed(3) : "—",
            s.meanUtilityRunnerUp !== null ? s.meanUtilityRunnerUp.toFixed(3) : "—",
          ]),
        }),
      ),
    );
  }

  // ---- session quality (one surface, three zones) ----
  container.append(sectionLabel("Session quality"));
  const qualityCard = card({});
  const qualityBody = qualityCard.querySelector<HTMLElement>(".card-body");
  if (qualityBody) {
    qualityBody.style.padding = "0";
    const cells = el("div", { class: "cell-grid-3" });

    const captureCell = el("div", {});
    captureCell.append(
      el("div", { class: "home-cell-head" }, [
        el("span", { class: "home-cell-title", text: "Capture quality" }),
      ]),
      fr.captureQualityGrade
        ? statTile("Grade", fr.captureQualityGrade, {
            sub: fr.captureQualityScore !== null ? `score ${fr.captureQualityScore.toFixed(2)}` : "",
            tone: fr.captureQualityGrade === "A" || fr.captureQualityGrade === "B" ? "ok" : "warn",
          })
        : el("p", { class: "muted", text: "Not graded for this session — run the capture check in Diagnostics before your next test." }),
    );

    const searchCell = el("div", {});
    searchCell.append(
      el("div", { class: "home-cell-head" }, [
        el("span", { class: "home-cell-title", text: "Search coverage" }),
      ]),
      kvList([
        ["Curve shape", fr.searchAdequacyClassification ?? "—"],
        ["Boundary", fr.boundaryStatus],
        ["Adaptation detected", fr.adaptationContamination ? "yes" : "no"],
      ]),
    );

    const trialsCell = el("div", {});
    trialsCell.append(
      el("div", { class: "home-cell-head" }, [
        el("span", { class: "home-cell-title", text: "Trials" }),
      ]),
      kvList([
        ["Measured", String(input.trialsAnalyzed)],
        ["Excluded", String(fr.excludedTrials.count)],
      ]),
    );
    if (Object.keys(fr.excludedTrials.reasonsByCode).length > 0) {
      const reasons = el("div", { class: "dim-chips" });
      for (const [code, n] of Object.entries(fr.excludedTrials.reasonsByCode)) {
        const chip = el("div", { class: "dim-chip" });
        chip.append(
          el("span", { class: "dim-chip-name", text: exclusionLabel(code) }),
          el("span", { class: "dim-chip-value", text: String(n) }),
        );
        chip.title = code;
        reasons.append(chip);
      }
      trialsCell.append(reasons);
    }

    cells.append(captureCell, searchCell, trialsCell);
    qualityBody.append(cells);
  }
  container.append(qualityCard);

  // Warnings / open uncertainty.
  if (fr.uncertaintyRemaining.length > 0 || fr.warnings.length > 0) {
    const lines = fr.uncertaintyRemaining.filter((l) => l !== "warnings:");
    container.append(
      card(
        { title: "Open questions", subtitle: "What this session could not settle", icon: "warn", tone: "warn" },
        el("ul", { class: "list-plain" }, lines.map((l) => el("li", { text: l }))),
      ),
    );
  }

  // ---- technical details ----
  container.append(
    sectionLabel("Technical details"),
    detailsBlock(
      "Full rationale",
      el("ul", { class: "list-plain" }, fr.rationaleLines.map((l) => el("li", { text: l }))),
    ),
    detailsBlock("Final result JSON (frozen contract)", jsonBlock(fr)),
    detailsBlock("Raw recommendation JSON", jsonBlock(rec)),
  );
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

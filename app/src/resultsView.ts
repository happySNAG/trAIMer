import type { AimDimension, Recommendation } from "../../src/domain/recommendation.ts";
import type { FinalResult } from "../../src/results/finalResult.ts";
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
  type Tone,
} from "./ui.ts";

export interface ResultsInput {
  recommendation: Recommendation | null;
  trialsAnalyzed: number;
  /** Pass 5 frozen results contract; rendered as the headline when present. */
  finalResult?: FinalResult | null | undefined;
  /** Navigates to the Test tab (empty-state CTA). */
  onStartTest?: (() => void) | undefined;
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

function confidenceTone(confidence: number): Tone {
  if (confidence >= 0.7) return "ok";
  if (confidence >= 0.4) return "warn";
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

  if (!input.recommendation) {
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
  container: HTMLElement,
  fr: FinalResult,
  rec: Recommendation,
  input: ResultsInput,
): void {
  // ---- hero ----
  const compare = el("div", { class: "sens-compare" });
  compare.append(
    sensBlock("Current", fr.currentSensitivity, false),
    el("span", { class: "sens-arrow" }, [icon("arrow-right", 20)]),
    sensBlock("Use now", fr.immediateRecommended, true),
  );

  const heroBody: (Node | string)[] = [compare];

  if (fr.fullInferredSensitivity) {
    const staged = el("div", {}, [
      el("p", { class: "muted" }, [
        el("strong", { text: "Staged change: " }),
        `the full estimated target is ${fr.fullInferredSensitivity.sensXPercent.toFixed(2)}% X ` +
          `(${fr.fullInferredSensitivity.edpi.toFixed(0)} eDPI). Large jumps disrupt trained aim, ` +
          `so the recommendation moves you there in bounded steps — play on the "use now" value and retest before moving further.`,
      ]),
    ]);
    heroBody.push(staged);
  }

  heroBody.push(
    rangeBar(
      fr.plausibleEdpiRange,
      [
        { value: fr.currentSensitivity.edpi, label: "current", tone: "neutral" },
        { value: fr.immediateRecommended.edpi, label: "use now", tone: "accent" },
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
  const confTone = confidenceTone(conf);

  const actionCard = card(
    { title: "What to do next", icon: "flag", tone: "info" },
    el("p", { style: "font-size:16px;font-weight:700", text: actionLabel }),
    el("ul", { class: "next-action-list" },
      fr.nextActionRationale.map((l) => el("li", { text: l }))),
    el("div", {}, [
      sectionLabel("Evidence strength"),
      el("div", { class: "confidence-row" }, [
        meter(conf, { tone: confTone, label: "confidence" }),
        el("span", { class: `confidence-pct tone-${confTone}`, text: `${(conf * 100).toFixed(0)}%` }),
      ]),
      el("p", { class: "muted", text: `${fr.confidenceLabel} · ${fr.confidenceBasis}` }),
      ...(fr.refusedHighConfidence
        ? [el("p", { class: "tone-warn", style: "font-size:12.5px", text: "The engine declined to claim high confidence for this session — treat the range, not the point, as the result." })]
        : []),
    ]),
  );

  container.append(el("div", { class: "result-hero" }, [heroCard, actionCard]));

  // ---- retest plan (when the next test is already designed) ----
  // Rationale lines already appear in "What to do next"; this card carries
  // the plan itself: what it resolves and when it can start.
  if (fr.retestProtocol && fr.retestProtocol.kind !== "none") {
    const plan = fr.retestProtocol;
    container.append(
      card(
        {
          title: plan.kind === "targeted-retest" ? "Your next session is ready" : "A clean repeat session is recommended",
          subtitle: plan.kind === "targeted-retest"
            ? "A shorter, focused session designed by the engine from this result"
            : "Same protocol, fresh randomization — to confirm what this session saw",
          icon: "clock",
          tone: "info",
        },
        el("p", { class: "muted", text: `Designed to resolve: ${plan.uncertaintyToResolve}` }),
        el("p", {
          class: plan.canStartNow ? "tone-ok" : "muted",
          text: plan.canStartNow
            ? "Rest requirement met — you can start whenever you're ready."
            : `Enforced rest between sessions: you can start from ${formatDateTime(plan.earliestStartIso)}.`,
        }),
      ),
    );
  }

  // ---- evidence ----
  container.append(sectionLabel("Evidence"));

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

  container.append(evidenceGrid);

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

  // ---- session quality ----
  container.append(sectionLabel("Session quality"));
  const qualityGrid = grid(3);

  qualityGrid.append(
    card(
      { title: "Capture quality", icon: "mouse" },
      fr.captureQualityGrade
        ? statTile("Grade", fr.captureQualityGrade, {
            sub: fr.captureQualityScore !== null ? `score ${fr.captureQualityScore.toFixed(2)}` : "",
            tone: fr.captureQualityGrade === "A" || fr.captureQualityGrade === "B" ? "ok" : "warn",
          })
        : el("p", { class: "muted", text: "No capture-quality summary for this session." }),
    ),
    card(
      { title: "Search coverage", icon: "results" },
      kvList([
        ["Curve shape", fr.searchAdequacyClassification ?? "—"],
        ["Boundary", fr.boundaryStatus],
        ["Adaptation detected", fr.adaptationContamination ? "yes" : "no"],
      ]),
    ),
    card(
      { title: "Trials", icon: "shield" },
      kvList([
        ["Analyzed", String(input.trialsAnalyzed)],
        ["Excluded", String(fr.excludedTrials.count)],
        ...Object.entries(fr.excludedTrials.reasonsByCode).map(
          ([code, n]) => [code, String(n)] as [string, string],
        ),
      ]),
    ),
  );
  container.append(qualityGrid);

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
  const confTone = confidenceTone(rec.confidence);
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

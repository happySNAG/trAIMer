import type { Recommendation } from "../../src/domain/recommendation.ts";
import type { FinalResult } from "../../src/results/finalResult.ts";
import { el, clear } from "./dom.ts";
import { loadSettings } from "./state.ts";

export interface ResultsInput {
  recommendation: Recommendation | null;
  trialsAnalyzed: number;
  /** Pass 5 frozen results contract; rendered as the headline when present. */
  finalResult?: FinalResult | null | undefined;
}

export function renderResultsView(
  container: HTMLElement,
  input: ResultsInput,
): void {
  clear(container);
  const settings = loadSettings();
  container.append(el("h2", { text: "Results" }));

  if (!input.recommendation) {
    container.append(
      el("p", {
        text:
          "No recommendation stored yet. Complete a session on the Run tab, then return here.",
      }),
    );
    return;
  }

  const rec = input.recommendation;

  if (input.finalResult) {
    const fr = input.finalResult;
    const headline = el("table", {});
    const nextActionLabels: Record<string, string> = {
      "apply-recommended-change": "Apply the recommended change",
      "apply-staged-change": "Apply the bounded first step",
      "run-targeted-retest": "Run the targeted retest",
      "run-clean-repeat": "Run one clean repeat session",
      "recalibrate-first": "Recalibrate before trusting results",
      "collect-more-sessions": "Collect more sessions first",
      "keep-current-settings": "Keep your current settings",
    };
    for (const [label, value] of [
      ["Next action", nextActionLabels[fr.recommendedNextAction] ?? fr.recommendedNextAction],
      ["Current X / Y", `${fr.currentSensitivity.sensXPercent.toFixed(2)} % · ${fr.currentSensitivity.sensYPercent.toFixed(2)} %`],
      ["Apply now", `${fr.immediateRecommended.sensXPercent.toFixed(2)} % · ${fr.immediateRecommended.sensYPercent.toFixed(2)} % (${fr.immediateRecommended.edpi.toFixed(0)} eDPI)`],
      ...(fr.fullInferredSensitivity
        ? [["Full inferred", `${fr.fullInferredSensitivity.sensXPercent.toFixed(2)} % — retest before moving further`] as [string, string]]
        : []),
      ["Plausible eDPI range", `${fr.plausibleEdpiRange.min.toFixed(0)} – ${fr.plausibleEdpiRange.max.toFixed(0)}`],
      ["Confidence", `${(fr.confidence * 100).toFixed(0)} % (${fr.confidenceLabel}, ${fr.confidenceBasis})`],
      ["Boundary", fr.boundaryStatus],
      ["Capture quality", fr.captureQualityGrade ? `${fr.captureQualityGrade} (${fr.captureQualityScore?.toFixed(2)})` : "—"],
      ["Search shape", fr.searchAdequacyClassification ?? "—"],
    ] as [string, string][]) {
      headline.append(el("tr", {}, [el("th", { text: label }), el("td", { text: value })]));
    }
    container.append(
      el("h3", { text: "What to do next" }),
      headline,
      el("h4", { text: "Why" }),
      el("ul", {}, fr.nextActionRationale.map((l) => el("li", { text: l }))),
    );
  }

  const rows: [string, string][] = [
    ["Player", settings.playerName],
    ["DPI", String(settings.dpi)],
    ["Recommended X", `${rec.primarySensitivity.sensX.toFixed(2)} %`],
    ["Recommended Y", `${rec.primarySensitivity.sensY.toFixed(2)} %`],
    ["eDPI (X)", rec.recommendedEdpi.toFixed(0)],
    ["Plausible X range (%)",
      `${rec.sensXRange.min.toFixed(2)} – ${rec.sensXRange.max.toFixed(2)}`],
    ["eDPI range", `${rec.edpiRange.min.toFixed(0)} – ${rec.edpiRange.max.toFixed(0)}`],
    ["Confidence", `${(rec.confidence * 100).toFixed(0)} % (${rec.confidenceLabel})`],
    ["High confidence refused", rec.refusedHighConfidence ? "yes" : "no"],
    ["Unresolved boundary", rec.unresolvedBoundary ? "yes" : "no"],
    ["Further testing suggested", rec.furtherTestingSuggested ? "yes" : "no"],
    ["Trials analyzed / excluded",
      `${input.trialsAnalyzed} / ${rec.evidence.trialsExcluded}`],
    ["Separation", rec.evidence.separation],
    ["Search rounds", String(rec.evidence.searchRoundsRun)],
  ];

  const table = el("table", {});
  for (const [label, value] of rows) {
    table.append(
      el("tr", {}, [el("th", { text: label }), el("td", { text: value })]),
    );
  }
  container.append(table);

  const dims = el("table", {});
  dims.append(el("tr", {}, [el("th", { text: "Dimension" }), el("th", { text: "Mean" }), el("th", { text: "±SE" }), el("th", { text: "n" })]));
  for (const [dim, estimate] of Object.entries(rec.dimensionEstimates)) {
    dims.append(
      el("tr", {}, [
        el("td", { text: dim }),
        el("td", { text: estimate!.mean.toFixed(3) }),
        el("td", { text: estimate!.standardError.toFixed(3) }),
        el("td", { text: String(estimate!.sampleCount) }),
      ]),
    );
  }
  container.append(el("h3", { text: "Dimension estimates (all candidates pooled)" }), dims);

  const perCandidate = el("table", {});
  perCandidate.append(
    el("tr", {}, [
      el("th", { text: "Candidate" }),
      el("th", { text: "Valid trials" }),
      el("th", { text: "Best?" }),
      el("th", { text: "Runner-up?" }),
    ]),
  );
  const bestId = rec.evidence.bestCandidateId;
  const runnerId = rec.evidence.runnerUpCandidateId;
  for (const [candidateId, count] of Object.entries(rec.evidence.validTrialsPerCandidate)) {
    perCandidate.append(
      el("tr", {}, [
        el("td", { text: candidateId }),
        el("td", { text: String(count) }),
        el("td", { text: candidateId === bestId ? "★" : "" }),
        el("td", { text: candidateId === runnerId ? "☆" : "" }),
      ]),
    );
  }
  container.append(el("h3", { text: "Candidates" }), perCandidate);

  container.append(el("h3", { text: "Warnings" }));
  const warningsList = el("ul", {});
  for (const warning of rec.warnings) warningsList.append(el("li", { text: warning }));
  if (rec.warnings.length === 0) {
    warningsList.append(el("li", { text: "(none)" }));
  }
  container.append(warningsList);

  container.append(el("h3", { text: "Rationale" }));
  const rationaleList = el("ul", {});
  for (const line of rec.rationaleLines) rationaleList.append(el("li", { text: line }));
  container.append(rationaleList);

  if (rec.yExploration?.explored) {
    container.append(el("h3", { text: "Independent-Y exploration" }));
    for (const line of rec.yExploration.rationaleLines) {
      container.append(el("p", { text: line }));
    }
  }

  container.append(el("h3", { text: "Confidence basis" }));
  container.append(
    el("p", {
      class: "note",
      text:
        rec.confidenceCalibration
          ? `basis: ${rec.confidenceCalibration.basis} (${rec.confidenceCalibration.heuristicVersion}) — not an empirically validated probability`
          : "basis: heuristic",
    }),
  );

  if (rec.inputQuality) {
    container.append(el("h3", { text: "Input quality" }));
    container.append(
      el("p", {
        text: `score ${rec.inputQuality.score.toFixed(2)} · ~${rec.inputQuality.metrics.observedRateHz.toFixed(0)} Hz`,
      }),
    );
    const iqList = el("ul", {});
    for (const line of rec.inputQuality.warningLines) iqList.append(el("li", { text: line }));
    if (rec.inputQuality.warningLines.length === 0) {
      iqList.append(el("li", { text: "(no capture-quality warnings)" }));
    }
    container.append(iqList);
  }

  if (rec.sensitivityChangePlan?.policyApplied) {
    container.append(el("h3", { text: "Staged change plan" }));
    const plan = rec.sensitivityChangePlan;
    container.append(
      el("p", {
        text: `change to ${plan.recommendedNowSensX.toFixed(2)}% X now (full inferred optimum ${plan.fullInferredSensX.toFixed(2)}%); retest after ${plan.retestAfterSessions} session(s)`,
      }),
    );
  }

  if (rec.explanation) {
    container.append(el("h3", { text: "Why this recommendation" }));
    const why = el("ul", {});
    for (const line of [
      ...rec.explanation.whyThisX,
      ...rec.explanation.whyThisY,
      ...rec.explanation.furtherTestingActions,
    ]) {
      why.append(el("li", { text: line }));
    }
    container.append(why);
  }

  if (rec.adaptationEffects && rec.adaptationEffects.effects.length > 0) {
    container.append(el("h3", { text: "Adaptation effects" }));
    container.append(
      el("p", {
        class: "note",
        text: rec.adaptationEffects.anySignificantImprovement
          ? "late-session improvement detected for at least one candidate — first encounters were likely still adaptation"
          : "no significant early-vs-late adaptation detected",
      }),
    );
  }

  const details = el("details", {});
  details.append(
    el("summary", { text: "Raw recommendation JSON" }),
    el("pre", { class: "json", text: JSON.stringify(rec, null, 2) }),
  );
  container.append(details);
}

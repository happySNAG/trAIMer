import type { Recommendation } from "../../src/domain/recommendation.ts";
import { el, clear } from "./dom.ts";
import { loadSettings } from "./state.ts";

export interface ResultsInput {
  recommendation: Recommendation | null;
  trialsAnalyzed: number;
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

  const details = el("details", {});
  details.append(
    el("summary", { text: "Raw recommendation JSON" }),
    el("pre", { class: "json", text: JSON.stringify(rec, null, 2) }),
  );
  container.append(details);
}

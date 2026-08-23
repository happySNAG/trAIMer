import { HistoryApi, type HistorySnapshot } from "../../src/history/api.ts";
import type { LocalJsonStore } from "../../src/persistence/store.ts";
import { el, clear } from "./dom.ts";

/**
 * History view (requirement M). Pure rendering of typed view models from the
 * HistoryApi — no calculations here (docs/UI-CONTRACT.md rule).
 */
export async function renderHistoryView(
  container: HTMLElement,
  store: LocalJsonStore,
): Promise<void> {
  clear(container);
  container.append(el("h2", { text: "History" }));
  const api = new HistoryApi(store);
  let snap: HistorySnapshot;
  try {
    snap = await api.snapshot();
  } catch (err) {
    container.append(el("p", { class: "danger", text: `history unavailable: ${String(err)}` }));
    return;
  }

  // Sessions table.
  const sessionsTable = el("table", {});
  sessionsTable.append(
    el("tr", {}, [
      el("th", { text: "Started" }),
      el("th", { text: "Player" }),
      el("th", { text: "eDPI" }),
      el("th", { text: "Range" }),
      el("th", { text: "Confidence" }),
      el("th", { text: "Quality" }),
      el("th", { text: "Optimizer" }),
      el("th", { text: "Retest of" }),
    ]),
  );
  if (snap.sessions.length === 0) {
    sessionsTable.append(
      el("tr", {}, [el("td", { text: "(no completed sessions yet)", colspan: "8" })]),
    );
  }
  for (const s of snap.sessions) {
    sessionsTable.append(
      el("tr", {}, [
        el("td", { text: s.startedAtIso ? new Date(s.startedAtIso).toLocaleDateString() : s.experimentId }),
        el("td", { text: s.playerName ?? "—" }),
        el("td", { text: s.recommendedEdpi?.toFixed(0) ?? "—" }),
        el("td", {
          text: s.edpiRange ? `${s.edpiRange.min.toFixed(0)}–${s.edpiRange.max.toFixed(0)}` : "—",
        }),
        el("td", {
          text: s.confidence !== null ? `${(s.confidence * 100).toFixed(0)}%` : "—",
        }),
        el("td", { text: s.captureQualityScore?.toFixed(2) ?? "—" }),
        el("td", { text: s.optimizerVersion ?? "—" }),
        el("td", { text: s.retestOfExperimentId ?? "" }),
      ]),
    );
  }
  container.append(el("h3", { text: "Sessions" }), sessionsTable);

  // Trends as simple text series (charts owned by the future design pass).
  const trendBlock = (title: string, points: { atIso: string; value: number | null }[]): HTMLElement => {
    const wrapEl = el("div", {});
    wrapEl.append(el("h4", { text: title }));
    const list = el("ul", {});
    for (const p of points.slice(0, 20)) {
      list.append(
        el("li", {
          text: `${p.atIso.slice(0, 10)} — ${p.value !== null ? p.value.toFixed(p.value < 10 && p.value > -10 && !Number.isInteger(p.value) ? 3 : 0) : "—"}`,
        }),
      );
    }
    if (points.length === 0) list.append(el("li", { text: "(no data)" }));
    wrapEl.append(list);
    return wrapEl;
  };
  const trends = el("div", { class: "trend-grid" }, [
    trendBlock("X sensitivity %", snap.trends.xSensPercent),
    trendBlock("Y sensitivity %", snap.trends.ySensPercent),
    trendBlock("eDPI", snap.trends.edpi),
    trendBlock("Confidence", snap.trends.confidence),
    trendBlock("Capture quality score", snap.trends.captureQualityScore),
  ]);
  container.append(el("h3", { text: "Trends" }), trends);

  // Retest lineage.
  if (snap.retestLineage.length > 0) {
    const lineage = el("ul", {});
    for (const edge of snap.retestLineage) {
      lineage.append(
        el("li", { text: `${edge.priorExperimentId} → ${edge.retestExperimentId}` }),
      );
    }
    container.append(el("h3", { text: "Retest lineage" }), lineage);
  }

  // Calibration history.
  if (snap.calibrationHistory.length > 0) {
    const calibTable = el("table", {});
    calibTable.append(
      el("tr", {}, [
        el("th", { text: "Date" }),
        el("th", { text: "Axis" }),
        el("th", { text: "deg/count @100%" }),
        el("th", { text: "DPI" }),
        el("th", { text: "Adequate" }),
      ]),
    );
    for (const c of snap.calibrationHistory) {
      calibTable.append(
        el("tr", {}, [
          el("td", { text: c.createdAtIso.slice(0, 10) }),
          el("td", { text: c.axis.toUpperCase() }),
          el("td", { text: c.degreesPerCountAt100?.toExponential(3) ?? "—" }),
          el("td", { text: c.dpi?.toFixed(0) ?? "—" }),
          el("td", { text: c.adequate ? "yes" : "NO" }),
        ]),
      );
    }
    container.append(el("h3", { text: "Calibration history" }), calibTable);
  }
}

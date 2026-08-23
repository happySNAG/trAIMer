import { HistoryApi, type HistorySnapshot } from "../../src/history/api.ts";
import type { LocalJsonStore } from "../../src/persistence/store.ts";
import { el, clear } from "./dom.ts";
import {
  badge,
  card,
  emptyState,
  formatDate,
  grid,
  pageHeader,
  sectionLabel,
  statTile,
  table,
  trendChart,
} from "./ui.ts";

/**
 * History view (requirement M). Pure rendering of typed view models from the
 * HistoryApi — no calculations here (docs/UI-CONTRACT.md rule).
 */
export async function renderHistoryView(
  container: HTMLElement,
  store: LocalJsonStore,
): Promise<void> {
  clear(container);
  container.append(
    pageHeader("History", "Every session, trend, and calibration on record — all stored locally."),
  );

  const api = new HistoryApi(store);
  let snap: HistorySnapshot;
  try {
    snap = await api.snapshot();
  } catch (err) {
    container.append(
      card(
        { title: "History unavailable", icon: "warn", tone: "danger" },
        el("p", { class: "muted", text: "Stored sessions could not be read. Your raw data is untouched — export a diagnostic bundle from Diagnostics if this persists." }),
        el("p", { class: "preflight-check-code", text: String(err) }),
      ),
    );
    return;
  }

  if (snap.sessions.length === 0) {
    container.append(
      emptyState(
        "history",
        "No sessions recorded yet",
        "Once you complete aim tests, this page tracks your sensitivity, confidence, and capture quality over time.",
      ),
    );
    renderCalibrationHistory(container, snap);
    return;
  }

  // ---- headline stats ----
  const latest = snap.sessions[0]!;
  container.append(
    grid(
      4,
      card({}, statTile("Sessions", String(snap.sessions.length))),
      card(
        {},
        statTile(
          "Latest eDPI",
          latest.recommendedEdpi !== null ? latest.recommendedEdpi.toFixed(0) : "—",
          { tone: "accent" },
        ),
      ),
      card(
        {},
        statTile(
          "Latest confidence",
          latest.confidence !== null ? `${(latest.confidence * 100).toFixed(0)}` : "—",
          latest.confidence !== null ? { unit: "%" } : {},
        ),
      ),
      card(
        {},
        statTile("Last session", formatDate(latest.startedAtIso)),
      ),
    ),
  );

  // ---- trends ----
  container.append(sectionLabel("Trends"));
  const trendCards = grid(2);
  const trendSpecs: {
    title: string;
    subtitle: string;
    points: { atIso: string; value: number | null }[];
    format: (v: number) => string;
  }[] = [
    {
      title: "eDPI",
      subtitle: "Recommended eDPI per session",
      points: snap.trends.edpi,
      format: (v) => v.toFixed(0),
    },
    {
      title: "Confidence",
      subtitle: "Heuristic evidence strength per session",
      points: snap.trends.confidence,
      format: (v) => `${(v * 100).toFixed(0)}%`,
    },
    {
      title: "X / Y sensitivity",
      subtitle: "Recommended horizontal sensitivity (%)",
      points: snap.trends.xSensPercent,
      format: (v) => v.toFixed(2),
    },
    {
      title: "Capture quality",
      subtitle: "Session capture-quality score",
      points: snap.trends.captureQualityScore,
      format: (v) => v.toFixed(2),
    },
  ];
  for (const spec of trendSpecs) {
    trendCards.append(
      card(
        { title: spec.title, subtitle: spec.subtitle, icon: "results" },
        trendChart(spec.points, { format: spec.format }),
      ),
    );
  }
  container.append(trendCards);

  // ---- sessions table ----
  container.append(sectionLabel("Sessions"));
  container.append(
    card(
      {},
      table({
        head: ["Date", "Player", "eDPI", "Plausible range", "Confidence", "Capture", "Trials", "Lineage"],
        rows: snap.sessions.map((s) => [
          formatDate(s.startedAtIso) === "—" ? s.experimentId : formatDate(s.startedAtIso),
          s.playerName ?? "—",
          s.recommendedEdpi !== null
            ? el("span", { class: "mono", text: s.recommendedEdpi.toFixed(0) })
            : "—",
          s.edpiRange
            ? el("span", { class: "mono", text: `${s.edpiRange.min.toFixed(0)}–${s.edpiRange.max.toFixed(0)}` })
            : "—",
          s.confidence !== null ? `${(s.confidence * 100).toFixed(0)}%` : "—",
          s.captureQualityScore !== null ? s.captureQualityScore.toFixed(2) : "—",
          `${s.measuredTrials}${s.invalidTrials > 0 ? ` (+${s.invalidTrials} excluded)` : ""}`,
          s.retestOfExperimentId ? badge("info", "retest") : "",
        ]),
        emptyText: "No completed sessions yet.",
      }),
    ),
  );

  // ---- retest lineage ----
  if (snap.retestLineage.length > 0) {
    container.append(sectionLabel("Retest lineage"));
    container.append(
      card(
        { subtitle: "", title: "Linked sessions", icon: "history" },
        el(
          "ul",
          { class: "list-plain" },
          snap.retestLineage.map((edge) =>
            el("li", { class: "mono", text: `${edge.priorExperimentId} → ${edge.retestExperimentId}` }),
          ),
        ),
      ),
    );
  }

  renderCalibrationHistory(container, snap);
}

function renderCalibrationHistory(container: HTMLElement, snap: HistorySnapshot): void {
  if (snap.calibrationHistory.length === 0) return;
  container.append(sectionLabel("Calibration history"));
  container.append(
    card(
      {},
      table({
        head: ["Date", "Axis", "deg/count @100%", "DPI", "Status"],
        rows: snap.calibrationHistory.map((c) => [
          formatDate(c.createdAtIso),
          c.axis.toUpperCase(),
          c.degreesPerCountAt100 !== null
            ? el("span", { class: "mono", text: c.degreesPerCountAt100.toExponential(3) })
            : "—",
          c.dpi !== null ? c.dpi.toFixed(0) : "—",
          c.adequate ? badge("ok", "adequate") : badge("danger", "not adequate"),
        ]),
      }),
    ),
  );
}

import { HistoryApi, type HistorySnapshot, type SessionSummaryViewModel } from "../../src/history/api.ts";
import type { LocalJsonStore } from "../../src/persistence/store.ts";
import { el, clear } from "./dom.ts";
import {
  badge,
  button,
  card,
  codeChip,
  emptyState,
  formatDate,
  grid,
  icon,
  inlineAlert,
  pageHeader,
  sectionLabel,
  statTile,
  trendChart,
} from "./ui.ts";

/** Player-facing names for engine aim dimensions (History detail). */
const DIMENSION_LABELS: Record<string, string> = {
  speed: "Speed",
  accuracy: "Accuracy",
  overshootControl: "Overshoot control",
  undershootControl: "Undershoot control",
  correctionEfficiency: "Correction efficiency",
  trackingPrecision: "Tracking",
  consistency: "Consistency",
};

/**
 * History view (requirement M). Pure rendering of typed view models from the
 * HistoryApi — no calculations here (docs/UI-CONTRACT.md rule).
 */
export async function renderHistoryView(
  container: HTMLElement,
  store: LocalJsonStore,
  onStartTest?: () => void,
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
        onStartTest
          ? button("Start an aim test", { variant: "primary", icon: "play", onClick: onStartTest })
          : undefined,
      ),
    );
    renderCalibrationHistory(container, snap);
    return;
  }

  // ---- headline stats: one strip, not four cards ----
  const latest = snap.sessions[0]!;
  const strip = card({});
  const stripBody = strip.querySelector<HTMLElement>(".card-body");
  if (stripBody) {
    stripBody.style.padding = "0";
    const cells = el("div", { class: "stat-strip" });
    cells.append(
      statTile("Sessions", String(snap.sessions.length)),
      statTile(
        "Latest eDPI",
        latest.recommendedEdpi !== null ? latest.recommendedEdpi.toFixed(0) : "—",
        { tone: "accent" },
      ),
      statTile(
        "Latest confidence",
        latest.confidence !== null ? `${(latest.confidence * 100).toFixed(0)}` : "—",
        latest.confidence !== null ? { unit: "%" } : {},
      ),
      statTile("Last session", formatDate(latest.startedAtIso)),
    );
    stripBody.append(cells);
  }
  container.append(strip);

  // Comparability: flag when stored sessions span multiple optimizer versions.
  const versions = new Set(
    snap.optimizerVersions.map((v) => v.optimizerVersion).filter((v): v is string => v !== null),
  );
  if (versions.size > 1) {
    container.append(
      inlineAlert(
        "info",
        `Sessions span ${versions.size} optimizer versions (${[...versions].join(", ")}).`,
        "Recommendations from different optimizer versions are not directly comparable — trends across the boundary are indicative only.",
      ),
    );
  }

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
      title: "X sensitivity",
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
        { title: spec.title, subtitle: spec.subtitle },
        trendChart(spec.points, { format: spec.format }),
      ),
    );
  }
  container.append(trendCards);

  // ---- sessions table with expandable per-session detail ----
  container.append(sectionLabel("Sessions"));
  container.append(buildSessionsTable(snap));

  // ---- retest lineage ----
  if (snap.retestLineage.length > 0) {
    container.append(sectionLabel("Retest lineage"));
    container.append(
      card(
        { title: "Linked sessions", subtitle: "Each retest narrows what its parent left open", icon: "history" },
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

function buildSessionsTable(snap: HistorySnapshot): HTMLElement {
  const wrap = el("div", { class: "table-wrap" });
  const table = el("table", { class: "table" });
  const thead = el("thead", {});
  const headRow = el("tr", {});
  for (const h of ["Date", "Player", "eDPI", "Plausible range", "Confidence", "Capture", "Trials", "", ""]) {
    headRow.append(el("th", { text: h }));
  }
  thead.append(headRow);
  const tbody = el("tbody", {});

  for (const s of snap.sessions) {
    const row = el("tr", { class: "session-row", tabindex: "0", "aria-expanded": "false" });
    const cells: (Node | string)[] = [
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
    ];
    for (const cell of cells) {
      const td = el("td", {});
      td.append(cell);
      row.append(td);
    }
    const chevronTd = el("td", {});
    const chevron = el("span", { class: "row-chevron" }, [icon("chevron-down", 15)]);
    chevronTd.append(chevron);
    row.append(chevronTd);

    const detailRow = el("tr", { class: "session-detail", hidden: true });
    const detailTd = el("td", { colspan: "9" });
    detailTd.append(buildSessionDetail(s, snap));
    detailRow.append(detailTd);

    const toggle = (): void => {
      const open = detailRow.hidden;
      detailRow.hidden = !open;
      row.setAttribute("aria-expanded", String(open));
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggle();
      }
    });

    tbody.append(row, detailRow);
  }

  if (snap.sessions.length === 0) {
    const tr = el("tr", { class: "table-empty" });
    tr.append(el("td", { colspan: "9", text: "No completed sessions yet." }));
    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function buildSessionDetail(s: SessionSummaryViewModel, snap: HistorySnapshot): HTMLElement {
  const detail = el("div", { class: "session-detail-grid" });

  // Candidate ranking for this experiment (engine view model, verbatim).
  const ranking = snap.rankingHistory.find((r) => r.experimentId === s.experimentId);
  const rankingCol = el("div", {});
  rankingCol.append(el("p", { class: "session-detail-title", text: "Candidate ranking" }));
  if (ranking && ranking.rows.length > 0) {
    const list = el("div", { class: "dim-chips" });
    // The stored ranking may carry one shared placeholder eDPI for every row;
    // repeating an identical number per chip reads as data when it isn't.
    const distinctEdpi = new Set(ranking.rows.map((r) => r.edpiX.toFixed(0)));
    for (const row of [...ranking.rows].sort((a, b) => a.rank - b.rank)) {
      const chip = el("div", { class: "dim-chip" });
      const edpiPart = distinctEdpi.size > 1 ? ` · ${row.edpiX.toFixed(0)} eDPI` : "";
      chip.append(
        el("span", { class: "dim-chip-name", text: `#${row.rank}${edpiPart}${row.tiedWithBest && row.rank !== 1 ? " · tied" : ""}` }),
        el("span", {
          class: `dim-chip-value${row.rank === 1 ? " tone-accent" : ""}`,
          text: row.utilityMean !== null ? row.utilityMean.toFixed(3) : "—",
        }),
      );
      chip.title = `${row.candidateId} · ${row.validTrials} valid trials`;
      list.append(chip);
    }
    rankingCol.append(list);
  } else {
    rankingCol.append(el("p", { class: "muted", text: "No ranking stored for this session." }));
  }
  detail.append(rankingCol);

  // Aim dimensions for this experiment.
  const dims = snap.dimensionTrend.find((d) => d.experimentId === s.experimentId);
  const dimCol = el("div", {});
  dimCol.append(el("p", { class: "session-detail-title", text: "Aim dimensions (0–1)" }));
  if (dims && Object.keys(dims.dimensions).length > 0) {
    const list = el("div", { class: "dim-chips" });
    for (const [dim, est] of Object.entries(dims.dimensions)) {
      const chip = el("div", { class: "dim-chip" });
      chip.append(
        el("span", { class: "dim-chip-name", text: DIMENSION_LABELS[dim] ?? dim }),
        el("span", { class: "dim-chip-value", text: est.mean.toFixed(3) }),
      );
      chip.title = `± ${est.standardError.toFixed(3)} SE`;
      list.append(chip);
    }
    dimCol.append(list);
  } else {
    dimCol.append(el("p", { class: "muted", text: "No dimension estimates stored for this session." }));
  }
  const meta = el("p", { class: "muted", style: "margin-top:10px" });
  meta.append(
    el("span", { text: "Experiment " }),
    codeChip(s.experimentId),
    el("span", { text: s.optimizerVersion ? " · " : "" }),
  );
  if (s.optimizerVersion) meta.append(codeChip(s.optimizerVersion));
  dimCol.append(meta);
  detail.append(dimCol);

  return detail;
}

function renderCalibrationHistory(container: HTMLElement, snap: HistorySnapshot): void {
  if (snap.calibrationHistory.length === 0) return;
  container.append(sectionLabel("Calibration history"));
  const rows = snap.calibrationHistory.map((c): (Node | string)[] => [
    formatDate(c.createdAtIso),
    c.axis.toUpperCase(),
    c.degreesPerCountAt100 !== null
      ? el("span", { class: "mono", text: c.degreesPerCountAt100.toExponential(3) })
      : "—",
    c.dpi !== null ? c.dpi.toFixed(0) : "—",
    c.adequate ? badge("ok", "adequate") : badge("danger", "not adequate"),
  ]);
  const wrap = el("div", { class: "table-wrap" });
  const table = el("table", { class: "table" });
  const thead = el("thead", {});
  const headRow = el("tr", {});
  for (const h of ["Date", "Axis", "deg/count @100%", "DPI", "Status"]) {
    headRow.append(el("th", { text: h }));
  }
  thead.append(headRow);
  const tbody = el("tbody", {});
  for (const cells of rows) {
    const tr = el("tr", {});
    for (const cell of cells) {
      const td = el("td", {});
      td.append(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  container.append(wrap);
}

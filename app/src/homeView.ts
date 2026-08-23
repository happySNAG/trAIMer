import type { LocalJsonStore } from "../../src/persistence/store.ts";
import type { PreflightReport } from "../../src/preflight/preflight.ts";
import { HistoryApi, type SessionSummaryViewModel } from "../../src/history/api.ts";
import { edpi } from "../../src/sensmath/sensitivity.ts";
import { el, clear } from "./dom.ts";
import { loadSettings } from "./state.ts";
import {
  badge,
  button,
  card,
  formatDate,
  icon,
  kvList,
  meter,
  pageHeader,
  sectionLabel,
  trendChart,
  type Tone,
} from "./ui.ts";

export interface HomeContext {
  store: LocalJsonStore;
  preflight: Promise<PreflightReport | null>;
  onStartTest(): void;
  onNavigate(tab: string): void;
  /** Mounts the mandated resume list (renderResumeList seam) into a holder. */
  resumeMount(container: HTMLElement): Promise<void>;
}

const VERDICT_PRESENTATION: Record<
  PreflightReport["overall"],
  { tone: Tone; label: string; line: string }
> = {
  READY: {
    tone: "ok",
    label: "System ready",
    line: "All checks passed. Conditions are good for a high-confidence session.",
  },
  READY_WITH_WARNINGS: {
    tone: "warn",
    label: "Ready, with warnings",
    line: "You can test now. Review the warnings on the Test screen for best results.",
  },
  NOT_READY_FOR_HIGH_CONFIDENCE: {
    tone: "warn",
    label: "Limited confidence",
    line: "Testing works, but results carry reduced confidence until the flagged checks are fixed.",
  },
  BLOCKED: {
    tone: "danger",
    label: "Setup needed",
    line: "Something blocks reliable measurement. The Test screen shows exactly what to fix.",
  },
};

export async function renderHomeView(container: HTMLElement, ctx: HomeContext): Promise<void> {
  clear(container);
  const settings = loadSettings();

  container.append(
    pageHeader(
      `Welcome back, ${settings.playerName}`,
      "Find the Fortnite sensitivity the evidence supports — measured, not guessed.",
    ),
  );

  // ---- resume (first-class recovery) ----
  const resumeHolder = el("div", { class: "resume-list" });
  container.append(resumeHolder);
  void ctx.resumeMount(resumeHolder);

  // ---- hero: readiness + primary action + loadout in one surface ----
  const readiness = el("div", { class: "readiness-strip" });
  const readinessLine = el("p", { class: "muted", text: "Running system checks…" });
  const startBtn = button("Start Aim Test", {
    variant: "primary",
    icon: "play",
    large: true,
    onClick: () => ctx.onStartTest(),
  });

  const heroMain = el("div", { class: "home-hero-main" }, [
    readiness,
    readinessLine,
    el("div", {}, [startBtn]),
  ]);

  const loadoutHead = el("div", { class: "home-cell-head" }, [
    el("span", { class: "home-cell-title", text: "Current loadout" }),
    button("Edit", {
      variant: "ghost",
      icon: "arrow-right",
      onClick: () => ctx.onStartTest(),
    }),
  ]);
  const heroSide = el("div", { class: "home-hero-side" }, [
    loadoutHead,
    kvList([
      ["Mouse DPI", el("span", { class: "mono", text: String(settings.dpi) })],
      ["X sensitivity", el("span", { class: "mono", text: `${settings.sensX.toFixed(1)} %` })],
      ["Y sensitivity", el("span", { class: "mono", text: `${settings.sensY.toFixed(1)} %` })],
      ["eDPI", el("span", { class: "mono tone-accent", text: edpi(settings.dpi, settings.sensX).toFixed(0) })],
    ]),
  ]);

  const hero = card({ class: "hero" });
  const heroBody = hero.querySelector<HTMLElement>(".card-body");
  if (heroBody) {
    heroBody.style.padding = "0";
    heroBody.append(el("div", { class: "home-hero-grid" }, [heroMain, heroSide]));
  }
  container.append(hero);

  void ctx.preflight.then((report) => {
    clear(readiness);
    if (!report) {
      readiness.append(badge("danger", "Checks unavailable"));
      readinessLine.textContent =
        "System checks could not run. Open Diagnostics to investigate — testing may still work.";
      return;
    }
    const pres = VERDICT_PRESENTATION[report.overall];
    readiness.append(badge(pres.tone, pres.label, { dot: true }));
    const captureCheck = report.checks.find((c) => c.name === "pointer-capture-mode");
    if (captureCheck) {
      readiness.append(el("span", { class: "muted", text: captureCheck.detail }));
    }
    readinessLine.textContent = pres.line;
  });

  // ---- latest evidence: one surface, three zones ----
  container.append(sectionLabel("Latest results"));
  const latestHolder = el("div", {});
  container.append(latestHolder);
  latestHolder.append(el("p", { class: "muted", text: "Loading history…" }));

  try {
    const api = new HistoryApi(ctx.store);
    const sessions = await api.listSessions();
    const withRec = sessions.filter((s) => s.recommendedEdpi !== null);
    clear(latestHolder);
    if (withRec.length === 0) {
      latestHolder.append(
        card(
          {},
          el("div", { style: "display:flex;align-items:center;gap:16px;flex-wrap:wrap" }, [
            el("span", { class: "card-icon" }, [icon("history", 16)]),
            el("div", { style: "flex:1;min-width:240px" }, [
              el("p", { style: "font-weight:650", text: "No sessions yet" }),
              el("p", {
                class: "muted",
                text: "Your first full session takes roughly 30–50 minutes with enforced rests, and ends with a measured recommendation.",
              }),
            ]),
            button("Start your first test", {
              variant: "secondary",
              icon: "arrow-right",
              onClick: () => ctx.onStartTest(),
            }),
          ]),
        ),
      );
    } else {
      latestHolder.append(buildLatestPanel(withRec[0]!, sessions, api, ctx));
    }
  } catch {
    clear(latestHolder);
    latestHolder.append(
      el("p", { class: "muted", text: "History is unavailable right now — see Diagnostics." }),
    );
  }
}

function buildLatestPanel(
  latest: SessionSummaryViewModel,
  sessions: SessionSummaryViewModel[],
  api: HistoryApi,
  ctx: HomeContext,
): HTMLElement {
  const panel = card({});
  const body = panel.querySelector<HTMLElement>(".card-body");
  if (!body) return panel;
  body.style.padding = "0";

  const wrap = el("div", { class: "cell-grid-3" });

  // Zone 1 — recommendation.
  const recCell = el("div", {});
  recCell.append(
    el("div", { class: "home-cell-head" }, [
      el("span", { class: "home-cell-title", text: `Latest recommendation · ${formatDate(latest.startedAtIso)}` }),
      button("Open", {
        variant: "ghost",
        icon: "arrow-right",
        onClick: () => ctx.onNavigate("results"),
      }),
    ]),
    el("p", { class: "stat-value" }, [
      el("span", { class: "stat-number tone-accent", style: "font-size:34px", text: latest.recommendedEdpi!.toFixed(0) }),
      el("span", { class: "stat-unit", text: "eDPI" }),
    ]),
    el("p", {
      class: "muted mono",
      text: latest.edpiRange
        ? `plausible ${latest.edpiRange.min.toFixed(0)}–${latest.edpiRange.max.toFixed(0)}`
        : "",
    }),
  );
  wrap.append(recCell);

  // Zone 2 — evidence.
  const confidence = latest.confidence;
  const evCell = el("div", {});
  evCell.append(
    el("div", { class: "home-cell-head" }, [
      el("span", { class: "home-cell-title", text: "Evidence" }),
    ]),
  );
  if (confidence !== null) {
    evCell.append(
      el("div", { class: "confidence-row" }, [
        meter(confidence, {
          tone: confidence >= 0.7 ? "ok" : confidence >= 0.4 ? "warn" : "danger",
          label: "confidence",
        }),
        el("span", { class: "confidence-pct", text: `${(confidence * 100).toFixed(0)}%` }),
      ]),
      el("p", { class: "muted", text: "Heuristic confidence — Results has the full basis." }),
    );
  } else {
    evCell.append(el("p", { class: "muted", text: "No confidence value stored." }));
  }
  evCell.append(
    el("p", {
      class: "muted",
      text: `${latest.measuredTrials} measured trials · ${latest.invalidTrials} excluded`,
    }),
  );
  wrap.append(evCell);

  // Zone 3 — trend.
  const trendCell = el("div", {});
  trendCell.append(
    el("div", { class: "home-cell-head" }, [
      el("span", {
        class: "home-cell-title",
        text: `eDPI over time · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
      }),
      button("History", {
        variant: "ghost",
        icon: "arrow-right",
        onClick: () => ctx.onNavigate("history"),
      }),
    ]),
  );
  void api.trends().then((trends) => {
    const usable = trends.edpi.filter((p) => p.value !== null);
    if (usable.length >= 2) {
      trendCell.append(trendChart(trends.edpi, { format: (v) => v.toFixed(0), height: 96 }));
    } else {
      trendCell.append(
        el("p", {
          class: "muted",
          text: "Your trend line starts with the second completed session.",
        }),
      );
    }
  });
  wrap.append(trendCell);

  body.append(wrap);
  return panel;
}

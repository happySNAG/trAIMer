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

// One vocabulary for the preflight verdict everywhere: these labels match the
// Test screen's readiness card exactly.
const VERDICT_PRESENTATION: Record<
  PreflightReport["overall"],
  { tone: Tone; label: string; line: string }
> = {
  READY: {
    tone: "ok",
    label: "Ready",
    line: "All checks passed. Conditions are good for a high-confidence session.",
  },
  READY_WITH_WARNINGS: {
    tone: "warn",
    label: "Ready with warnings",
    line: "You can test now. Review the warnings on the Test screen for best results.",
  },
  NOT_READY_FOR_HIGH_CONFIDENCE: {
    tone: "warn",
    label: "Limited confidence",
    line: "Testing works, but results carry reduced confidence until the flagged checks are fixed.",
  },
  BLOCKED: {
    tone: "danger",
    label: "Blocked",
    line: "Something blocks reliable measurement. The Test screen shows exactly what to fix.",
  },
};

export async function renderHomeView(container: HTMLElement, ctx: HomeContext): Promise<void> {
  clear(container);
  const settings = loadSettings();

  // "Welcome back" only once there is history to come back to.
  const header = pageHeader(
    `Welcome, ${settings.playerName}`,
    "Find the Fortnite sensitivity the evidence supports — measured, not guessed.",
  );
  const headerTitle = header.querySelector<HTMLElement>(".page-title");
  container.append(header);

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
      readiness.append(el("span", { class: "muted", text: `Capture: ${captureCheck.detail}` }));
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
    if (sessions.length > 0 && headerTitle) {
      headerTitle.textContent = `Welcome back, ${settings.playerName}`;
    }
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
      latestHolder.append(buildFirstUseSteps());
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

/** First-use orientation: what a session is, in three quiet steps. */
function buildFirstUseSteps(): HTMLElement {
  const panel = card({ class: "home-steps" });
  const body = panel.querySelector<HTMLElement>(".card-body");
  if (!body) return panel;
  body.style.padding = "0";
  const wrap = el("div", { class: "cell-grid-3" });
  const steps: [string, string, string][] = [
    ["1", "Confirm your setup", "Enter your mouse DPI and current Fortnite sensitivity — that's the starting point of the search."],
    ["2", "Play the blinded test", "Short aim drills across several hidden sensitivities, with rests enforced to protect the data."],
    ["3", "Get a measured answer", "The engine compares the evidence and recommends the sensitivity it actually supports."],
  ];
  for (const [num, title, body_] of steps) {
    const cell = el("div", {});
    cell.append(
      el("div", { class: "home-cell-head" }, [
        el("span", { class: "home-step-num mono", text: num }),
        el("span", { class: "home-cell-title", style: "flex:1", text: title }),
      ]),
      el("p", { class: "muted", text: body_ }),
    );
    wrap.append(cell);
  }
  body.append(wrap);
  return panel;
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
  const recNumber = el("span", {
    class: "stat-number tone-accent",
    style: "font-size:34px",
    text: latest.recommendedEdpi!.toFixed(0),
  });
  const recValueRow = el("p", { class: "stat-value" }, [
    recNumber,
    el("span", { class: "stat-unit", text: "eDPI" }),
  ]);
  recCell.append(
    el("div", { class: "home-cell-head" }, [
      el("span", { class: "home-cell-title", text: `Latest recommendation · ${formatDate(latest.startedAtIso)}` }),
      button("Open", {
        variant: "ghost",
        icon: "arrow-right",
        onClick: () => ctx.onNavigate("results"),
      }),
    ]),
    recValueRow,
    el("p", {
      class: "muted mono",
      text: latest.edpiRange
        ? `plausible ${latest.edpiRange.min.toFixed(0)}–${latest.edpiRange.max.toFixed(0)}`
        : "",
    }),
  );
  // The engine's own refusal flag: a preliminary number must not carry the
  // confident volt treatment on the landing screen either.
  void ctx.store.loadRecommendation(latest.experimentId).then((rec) => {
    if (rec?.refusedHighConfidence) {
      recNumber.classList.remove("tone-accent");
      recValueRow.append(badge("warn", "preliminary", { dot: true }));
    }
  }).catch(() => {});
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
    // Tone follows the ENGINE-owned label (see SessionSummaryViewModel.
    // confidenceLabel); the raw number is never re-interpreted here.
    const tone =
      latest.confidenceLabel === "high"
        ? "ok"
        : latest.confidenceLabel === "moderate"
          ? "warn"
          : latest.confidenceLabel === "low"
            ? "danger"
            : "neutral";
    evCell.append(
      el("div", { class: "confidence-row" }, [
        meter(confidence, { tone, label: "confidence" }),
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
          text: "Your trend begins with your second completed session.",
        }),
      );
    }
  });
  wrap.append(trendCell);

  body.append(wrap);
  return panel;
}

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
  grid,
  meter,
  pageHeader,
  sectionLabel,
  statTile,
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
    line: "Testing works, but results will carry reduced confidence until the flagged checks are fixed.",
  },
  BLOCKED: {
    tone: "danger",
    label: "Setup needed",
    line: "Something blocks reliable measurement. Open the Test screen to see exactly what to fix.",
  },
};

export async function renderHomeView(container: HTMLElement, ctx: HomeContext): Promise<void> {
  clear(container);
  const settings = loadSettings();

  container.append(
    pageHeader(
      `Welcome back, ${settings.playerName}`,
      "Your lab for finding the Fortnite sensitivity you can trust.",
    ),
  );

  // ---- resume (first-class recovery) ----
  const resumeHolder = el("div", { class: "resume-list" });
  container.append(resumeHolder);
  void ctx.resumeMount(resumeHolder);

  // ---- hero: readiness + primary action ----
  const readiness = el("div", { class: "readiness-strip" });
  const readinessLine = el("p", { class: "muted", text: "Running system checks…" });
  const startBtn = button("Start Aim Test", {
    variant: "primary",
    icon: "play",
    large: true,
    onClick: () => ctx.onStartTest(),
  });

  const hero = card(
    { class: "hero" },
    readiness,
    readinessLine,
    el("div", {}, [startBtn]),
  );
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

  // ---- current loadout ----
  container.append(sectionLabel("Current setup"));
  container.append(
    grid(
      4,
      card({}, statTile("Mouse DPI", String(settings.dpi))),
      card({}, statTile("X sensitivity", settings.sensX.toFixed(1), { unit: "%" })),
      card({}, statTile("Y sensitivity", settings.sensY.toFixed(1), { unit: "%" })),
      card(
        {},
        statTile("eDPI", edpi(settings.dpi, settings.sensX).toFixed(0), {
          sub: "DPI × X sensitivity",
        }),
      ),
    ),
  );

  // ---- latest evidence ----
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
          { title: "No sessions yet", icon: "history" },
          el("p", {
            class: "muted",
            text:
              "Run your first aim test to get a measured sensitivity recommendation. A full session takes roughly 30–50 minutes with enforced rests.",
          }),
          el("div", {}, [
            button("Start your first test", {
              variant: "secondary",
              icon: "arrow-right",
              onClick: () => ctx.onStartTest(),
            }),
          ]),
        ),
      );
    } else {
      const latest = withRec[0]!;
      latestHolder.append(buildLatestRow(latest, sessions, api, ctx));
    }
  } catch {
    clear(latestHolder);
    latestHolder.append(
      el("p", { class: "muted", text: "History is unavailable right now — see Diagnostics." }),
    );
  }
}

function buildLatestRow(
  latest: SessionSummaryViewModel,
  sessions: SessionSummaryViewModel[],
  api: HistoryApi,
  ctx: HomeContext,
): HTMLElement {
  const wrap = grid(3);

  // Latest recommendation card.
  const recBody: (Node | string)[] = [
    statTile("Recommended eDPI", latest.recommendedEdpi!.toFixed(0), {
      large: true,
      tone: "accent",
      ...(latest.edpiRange
        ? { sub: `plausible ${latest.edpiRange.min.toFixed(0)} – ${latest.edpiRange.max.toFixed(0)}` }
        : {}),
    }),
  ];
  const recCard = card(
    {
      title: "Latest recommendation",
      subtitle: formatDate(latest.startedAtIso),
      icon: "target",
      tone: "accent",
      actions: [
        button("Open results", {
          variant: "ghost",
          icon: "arrow-right",
          onClick: () => ctx.onNavigate("results"),
        }),
      ],
    },
    ...recBody,
  );
  wrap.append(recCard);

  // Evidence card.
  const confidence = latest.confidence;
  const evidenceCard = card(
    { title: "Evidence", subtitle: "How solid the last session was", icon: "shield" },
    confidence !== null
      ? el("div", {}, [
          el("div", { class: "confidence-row" }, [
            meter(confidence, {
              tone: confidence >= 0.7 ? "ok" : confidence >= 0.4 ? "warn" : "danger",
              label: "confidence",
            }),
            el("span", { class: "confidence-pct", text: `${(confidence * 100).toFixed(0)}%` }),
          ]),
          el("p", {
            class: "muted",
            text: "Heuristic confidence — see Results for the full evidence basis.",
          }),
        ])
      : el("p", { class: "muted", text: "No confidence value stored." }),
    el("p", {
      class: "muted",
      text: `${latest.measuredTrials} measured trials · ${latest.invalidTrials} excluded`,
    }),
  );
  wrap.append(evidenceCard);

  // Trend card (needs ≥2 datapoints to be meaningful).
  const trendCard = card(
    {
      title: "eDPI over time",
      subtitle: `${sessions.length} session${sessions.length === 1 ? "" : "s"} recorded`,
      icon: "results",
      actions: [
        button("History", {
          variant: "ghost",
          icon: "arrow-right",
          onClick: () => ctx.onNavigate("history"),
        }),
      ],
    },
  );
  const trendBody = trendCard.querySelector<HTMLElement>(".card-body");
  void api.trends().then((trends) => {
    if (!trendBody) return;
    const usable = trends.edpi.filter((p) => p.value !== null);
    if (usable.length >= 2) {
      trendBody.append(trendChart(trends.edpi, { format: (v) => v.toFixed(0) }));
    } else {
      trendBody.append(
        el("p", {
          class: "muted",
          text: "Trends appear once you have two or more completed sessions.",
        }),
      );
    }
  });
  wrap.append(trendCard);

  return wrap;
}

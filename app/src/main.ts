import { renderSetupView } from "./setupView.ts";
import { loadSettings } from "./state.ts";
import { BrowserRunController, type RunControllerCallbacks } from "./runController.ts";
import { renderResultsView } from "./resultsView.ts";
import { renderDataView } from "./dataView.ts";
import { renderCalibrationView } from "./calibrationView.ts";
import { renderHistoryView } from "./historyView.ts";
import { renderDiagnosticsView } from "./diagnosticsView.ts";
import { renderResumeList } from "./resumeView.ts";
import { renderHomeView } from "./homeView.ts";
import { el, clear } from "./dom.ts";
import {
  icon,
  button,
  card,
  statusDot,
  meter,
  infoDialog,
  confirmDialog,
  type IconName,
  type Tone,
} from "./ui.ts";
import { LocalJsonStore } from "../../src/persistence/store.ts";
import { IndexedDbBackend } from "../../src/persistence/backends.ts";
import { openAimLabDb } from "./idb.ts";
import type { ResumeCheckpoint } from "../../src/session/resume.ts";
import { APP_VERSION, ENGINE_VERSION } from "../../src/version.ts";
import { toAimLabError } from "../../src/errors/types.ts";
import { LocalDiagnosticLog } from "../../src/diagnostics/localLog.ts";
import { installTestHooks, testModeEnabled } from "./testHooks.ts";
import {
  gatherPreflightEnvironment,
  loadStoredEngineVersions,
} from "./preflightClient.ts";
import { runPreflightChecks, type PreflightReport } from "../../src/preflight/preflight.ts";
import { renderPreflightPanel } from "./preflightView.ts";
import { buildFinalResult, type FinalResult } from "../../src/results/finalResult.ts";
import { planNextTest } from "../../src/session/retest.ts";
import { HistoryApi } from "../../src/history/api.ts";
import type { Recommendation } from "../../src/domain/recommendation.ts";
import type { SessionStateName } from "../../src/session/types.ts";

const view = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

interface AppViews {
  home: HTMLElement;
  setup: HTMLElement;
  run: HTMLElement;
  results: HTMLElement;
  data: HTMLElement;
  history: HTMLElement;
  diagnostics: HTMLElement;
  calibration: HTMLElement;
}

const views: AppViews = {
  home: view("view-home"),
  setup: view("view-setup"),
  run: view("view-run"),
  results: view("view-results"),
  data: view("view-data"),
  history: view("view-history"),
  diagnostics: view("view-diagnostics"),
  calibration: view("view-calibration"),
};

const diagnosticLog = new LocalDiagnosticLog();
diagnosticLog.log("info", "app-boot", {
  appVersion: APP_VERSION,
  engineVersion: ENGINE_VERSION,
});

let controller: BrowserRunController | null = null;
let lastRecommendation: Recommendation | null = null;
let lastFinalResult: FinalResult | null = null;
const lastTrialsAnalyzed = { count: 0 };

async function store(): Promise<LocalJsonStore> {
  return new LocalJsonStore(new IndexedDbBackend(await openAimLabDb()));
}

/**
 * Failure experience contract (WHAT HAPPENED / IS DATA SAFE / WHAT NEXT):
 * rendered whenever local storage cannot be opened so no view ever fails
 * silently into a blank screen.
 */
function renderStorageFailure(container: HTMLElement, err: unknown): void {
  clear(container);
  const cardNode = card(
    { title: "Local storage is not available", icon: "storage", tone: "danger" },
    el("p", { text: "What happened: the app could not open this browser's local database, so saved sessions and settings could not be loaded." }),
    el("p", { text: "Is your data safe: yes — nothing was deleted. Existing sessions stay on disk untouched until storage works again." }),
    el("p", { text: "What to do next: leave private/incognito mode, allow site data for this page, disable content-blocking extensions for it, then reload." }),
    el("p", { class: "muted mono", text: `detail: ${String(err).slice(0, 200)}` }),
  );
  container.append(cardNode);
}

/**
 * Same three-part contract for unexpected session-level failures (a rejected
 * runner, a crashed analysis): always honest that completed trials were saved
 * trial-by-trial as they happened.
 */
function renderSessionFailure(container: HTMLElement, err: unknown): void {
  clear(container);
  container.append(
    card(
      { title: "Something went wrong while running the session", icon: "warn", tone: "danger" },
      el("p", { text: "What happened: the session stopped earlier than planned because of an unexpected error." }),
      el("p", { text: "Is your data safe: yes — every completed trial was saved the moment it finished, so all progress up to this point is already stored on this machine." }),
      el("p", { text: "What to do next: check Results and History — completed trials and any saved checkpoint appear there. You can safely start a new session; if the error repeats, export the diagnostic bundle from Diagnostics." }),
      el("p", { class: "muted mono", text: `detail: ${String(err).slice(0, 200)}` }),
    ),
  );
}

// ---- preflight, shared by Home + Test; recomputable on demand ----

interface PreflightOutcome {
  report: PreflightReport | null;
  errorText: string | null;
}

function computePreflight(): Promise<PreflightOutcome> {
  return (async () => {
    try {
      const s = await store();
      const env = await gatherPreflightEnvironment(s);
      env.storedArtifactEngineVersions = await loadStoredEngineVersions(s);
      return { report: runPreflightChecks(env), errorText: null };
    } catch (err) {
      diagnosticLog.error("PREFLIGHT_FAILED", String(err));
      return { report: null, errorText: String(err) };
    }
  })();
}

let preflightOutcome: Promise<PreflightOutcome> = computePreflight();

/** Renders the Test-tab preflight panel; "Run checks again" recomputes. */
async function renderSetupPreflight(): Promise<void> {
  const holder = views.setup.querySelector<HTMLElement>("#setup-preflight");
  if (!holder) return;
  const outcome = await preflightOutcome;
  renderPreflightPanel(holder, outcome.report, outcome.errorText, () => {
    preflightOutcome = computePreflight();
    void renderSetupPreflight();
  });
}

// ---- navigation ----

const NAV_ICONS: Record<string, IconName> = {
  home: "home",
  setup: "target",
  results: "results",
  history: "history",
  calibration: "calibration",
  diagnostics: "diagnostics",
  data: "data",
};

function activate(tab: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
    const isActive = b.dataset.tab === tab;
    b.classList.toggle("active", isActive);
    if (isActive) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  const nodes: [string, HTMLElement][] = [
    ["home", views.home],
    ["setup", views.setup],
    ["run", views.run],
    ["results", views.results],
    ["data", views.data],
    ["history", views.history],
    ["diagnostics", views.diagnostics],
    ["calibration", views.calibration],
  ];
  for (const [name, node] of nodes) {
    node.hidden = name !== tab;
  }
  if (tab === "home") void renderHome();
  if (tab === "setup") {
    // Keep the recoverable-session list current — a session may have finished
    // or been discarded since the tab was last built.
    const resumeContainer = views.setup.querySelector<HTMLElement>("#setup-resume");
    if (resumeContainer) {
      clear(resumeContainer);
      void mountResumeList(resumeContainer);
    }
  }
  if (tab === "data") {
    void renderDataView(views.data).catch((err) => {
      diagnosticLog.error("DATA_STORE_FAILED", String(err));
      renderStorageFailure(views.data, err);
    });
  }
  if (tab === "calibration") renderCalibrationView(views.calibration);
  if (tab === "history") {
    void store()
      .then((s) => renderHistoryView(views.history, s, () => activate("setup")))
      .catch((err) => {
        diagnosticLog.error("HISTORY_STORE_FAILED", String(err));
        renderStorageFailure(views.history, err);
      });
  }
  if (tab === "diagnostics") renderDiagnosticsView(views.diagnostics, sessionToken(), diagnosticLog, store());
  if (tab === "results") void renderResults();
}

function sessionToken(): string {
  // The Windows launcher passes its freshly generated helper token via
  // ?token= on first open; adopt it once so the Diagnostics capture probe
  // authenticates without manual copying. Shape-checked, never trusted
  // beyond that (it is only ever compared by the loopback helper).
  const params = new URLSearchParams(window.location.search);
  const injected = params.get("token");
  if (injected && /^[0-9a-f]{32}$/.test(injected)) {
    localStorage.setItem("aldo-session-token", injected);
    // Strip the credential from the URL/history immediately: the token lives
    // in localStorage from here on, and the address bar (screenshots, session
    // history, reloads) should not keep advertising it.
    params.delete("token");
    const rest = params.toString();
    const cleanUrl = `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`;
    try {
      window.history.replaceState(null, "", cleanUrl);
    } catch {
      // replaceState can throw on exotic origins (file://); the token in the
      // visible URL is then unavoidable but remains loopback-only.
    }
    return injected;
  }
  let token = localStorage.getItem("aldo-session-token");
  if (!token) {
    token = `tok-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem("aldo-session-token", token);
  }
  return token;
}

// Adopt (and strip) a launcher-passed ?token= eagerly at boot — not lazily
// on the Diagnostics tab — so the credential never lingers in the address
// bar, history, or a reload.
sessionToken();

for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
  const name = NAV_ICONS[b.dataset.tab ?? ""];
  if (name) b.prepend(icon(name, 17));
  b.addEventListener("click", () => activate(b.dataset.tab ?? "home"));
}

// Wordmark sigil + version footer.
{
  const sigil = document.getElementById("wordmark-sigil");
  if (sigil) sigil.append(icon("crosshair", 19));
  const footer = document.getElementById("app-footer");
  if (footer) {
    const l1 = el("div", { class: "foot-line" });
    l1.append(icon("shield", 12), el("span", { text: "local-only · no telemetry" }));
    footer.append(
      l1,
      el("div", { class: "foot-line mono", text: `${APP_VERSION} · ${ENGINE_VERSION}` }),
    );
  }
}

// ---- home ----

async function renderHome(): Promise<void> {
  try {
    const s = await store();
    await renderHomeView(views.home, {
      store: s,
      preflight: preflightOutcome.then((o) => o.report),
      onStartTest: () => activate("setup"),
      onNavigate: (tab) => activate(tab),
      resumeMount: (container) => mountResumeList(container),
    });
  } catch (err) {
    diagnosticLog.error("HOME_STORE_FAILED", String(err));
    renderStorageFailure(views.home, err);
  }
}

// ---- results (in-memory result, or latest persisted recommendation) ----

async function renderResults(): Promise<void> {
  if (lastRecommendation) {
    renderResultsView(views.results, {
      recommendation: lastRecommendation,
      trialsAnalyzed: lastTrialsAnalyzed.count,
      finalResult: lastFinalResult,
      onStartTest: () => activate("setup"),
    });
    return;
  }
  // No session this launch — load the most recent stored recommendation
  // through the History API (already sorted newest-first).
  try {
    const s = await store();
    const api = new HistoryApi(s);
    const sessions = await api.listSessions();
    const latestSession = sessions.find((x) => x.recommendedEdpi !== null);
    const rec = latestSession ? await s.loadRecommendation(latestSession.experimentId) : null;
    if (latestSession && rec) {
      const settingsNow = loadSettings();
      let finalResult: FinalResult | null = null;
      try {
        const definition = await s.loadExperiment(rec.experimentId);
        const retestPlan = definition
          ? planNextTest(definition, rec, {
              priorSessionEndedAtIso:
                latestSession.endedAtIso ?? latestSession.startedAtIso ?? null,
              nowIso: new Date().toISOString(),
              orderSeed: settingsNow.experimentSeed + 1,
            })
          : null;
        finalResult = buildFinalResult({
          recommendation: rec,
          dpi: settingsNow.dpi,
          currentSensXPercent: settingsNow.sensX,
          currentSensYPercent: settingsNow.sensY,
          calibration: null,
          retestPlan,
        });
      } catch (err) {
        const aimErr = toAimLabError(err);
        diagnosticLog.error(aimErr.code, aimErr.message);
      }
      renderResultsView(views.results, {
        recommendation: rec,
        trialsAnalyzed: rec.evidence.trialsAnalyzed,
        finalResult,
        onStartTest: () => activate("setup"),
      });
      return;
    }
  } catch (err) {
    diagnosticLog.error("RESULTS_LOAD_FAILED", String(err));
    renderStorageFailure(views.results, err);
    return;
  }
  renderResultsView(views.results, {
    recommendation: null,
    trialsAnalyzed: 0,
    finalResult: null,
    onStartTest: () => activate("setup"),
  });
}

// ---- run screen ----

interface RunView {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  showOverlay(iconName: IconName, title: string, body: string): void;
  hideOverlay(): void;
  setState(state: SessionStateName, label: string, tone: Tone, detail: string): void;
  setProgress(measured: number, upperBound: number | null): void;
  setPendingStart(fn: () => void): void;
  /** Reflects the engine's paused/running state on the pause control. */
  setPaused(paused: boolean): void;
  /** Optimistic hint while the engine finishes the current safe boundary. */
  setIntentHint(hint: string | null): void;
}

const STATE_PRESENTATION: Record<
  SessionStateName,
  { label: string; tone: Tone }
> = {
  idle: { label: "Idle", tone: "neutral" },
  setup: { label: "Preparing", tone: "neutral" },
  "awaiting-lock": { label: "Awaiting lock", tone: "info" },
  "candidate-transition": { label: "Next candidate", tone: "info" },
  warmup: { label: "Warm-up", tone: "info" },
  "trial-ready": { label: "Get ready", tone: "accent" },
  "trial-active": { label: "Live", tone: "accent" },
  "inter-trial": { label: "Between trials", tone: "neutral" },
  rest: { label: "Rest", tone: "info" },
  paused: { label: "Paused", tone: "warn" },
  analyzing: { label: "Analyzing", tone: "accent" },
  complete: { label: "Complete", tone: "ok" },
  aborted: { label: "Ended", tone: "danger" },
};

function buildRunView(): RunView {
  clear(views.run);
  document.body.classList.add("session-active");

  const screen = el("div", { class: "run-screen" });

  // -- top bar --
  const stateChip = el("span", { class: "run-state-chip" });
  const stateDotHolder = el("span", { class: "tone-neutral" }, [statusDot("neutral")]);
  const stateLabel = el("span", { text: "Preparing" });
  stateChip.append(stateDotHolder, stateLabel);
  const detailEl = el("span", { class: "run-detail", text: "" });
  const brand = el("span", { class: "run-brand" });
  brand.append(icon("crosshair", 14), el("span", { text: "Aldo Aim Lab" }));

  const topLeft = el("div", { class: "run-topbar-left" }, [brand]);
  const topRight = el("div", { class: "run-topbar-right" }, [detailEl, stateChip]);
  const topbar = el("div", { class: "run-topbar" }, [topLeft, topRight]);

  // -- stage --
  const canvas = el("canvas", { id: "run-canvas", tabindex: "0" }) as HTMLCanvasElement;
  const overlayIcon = el("div", { class: "overlay-icon" });
  const overlayTitle = el("div", { class: "overlay-title" });
  const overlayBody = el("div", { class: "overlay-body" });
  const overlay = el("div", { class: "overlay-message" }, [
    overlayIcon,
    overlayTitle,
    overlayBody,
  ]);
  const stageInner = el("div", { class: "run-stage-inner" }, [canvas, overlay]);
  const stage = el("div", { class: "run-stage" }, [stageInner]);

  // -- bottom bar --
  const progressLabel = el("span", { class: "run-progress-label", text: "" });
  const progressMeter = meter(0, { tone: "accent", label: "session progress" });
  progressMeter.style.flex = "1";
  const progressWrap = el("div", { class: "run-progress-wrap" }, [
    progressLabel,
    progressMeter,
  ]);

  const pauseButton = button("Pause", { icon: "pause", variant: "secondary" });
  let engingPaused = false;
  pauseButton.addEventListener("click", () => {
    if (!controller) return;
    if (engingPaused) {
      controller.resume();
      hintEl.textContent = "";
    } else {
      controller.pause();
      // The engine pauses at the next safe boundary; say so immediately.
      hintEl.textContent = "Pausing after this trial…";
    }
  });
  const cancelButton = button("End session", { variant: "danger" });
  cancelButton.addEventListener("click", () => {
    void confirmDialog({
      title: "End this session?",
      body: "Completed trials stay saved and the session can be reviewed, but the search will stop before a recommendation is reached.",
      confirmLabel: "End session",
      danger: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      controller?.cancel();
      hintEl.textContent = "Ending after this trial…";
    });
  });
  const captureNote = el("span", { class: "run-capture-note" });
  captureNote.append(icon("mouse", 13), el("span", { text: "browser capture · pointer lock" }));
  const hintEl = el("span", { class: "run-capture-note", text: "" });
  const controls = el("div", { class: "run-controls" }, [hintEl, pauseButton, cancelButton]);
  const bottombar = el("div", { class: "run-bottombar" }, [progressWrap, captureNote, controls]);

  screen.append(topbar, stage, bottombar);
  views.run.append(screen);

  let pendingStart: (() => void) | null = null;
  canvas.addEventListener("click", () => {
    pendingStart?.();
    pendingStart = null;
  });

  // Measurement-safety side-effect guards: no accidental selection, drag
  // ghosts, or context menus over the stage (print/screenshot hygiene).
  screen.addEventListener("selectstart", (e) => e.preventDefault());
  screen.addEventListener("dragstart", (e) => e.preventDefault());
  screen.addEventListener("contextmenu", (e) => e.preventDefault());

  const fillEl = progressMeter.querySelector<HTMLElement>(".meter-fill");

  return {
    canvas,
    overlay,
    showOverlay(iconName, title, body) {
      overlay.hidden = false;
      clear(overlayIcon);
      overlayIcon.append(icon(iconName, 24));
      overlayTitle.textContent = title;
      overlayBody.textContent = body;
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    setState(state, label, tone, detail) {
      screen.setAttribute("data-session-state", state);
      stateLabel.textContent = label;
      stateDotHolder.className = `tone-${tone}`;
      detailEl.textContent = detail;
    },
    setProgress(measured, upperBound) {
      if (upperBound && upperBound > 0 && fillEl) {
        const frac = Math.max(0, Math.min(1, measured / upperBound));
        fillEl.style.width = `${(frac * 100).toFixed(1)}%`;
      }
      progressLabel.textContent =
        upperBound && upperBound > 0
          ? `${measured} / ≤${upperBound} measured trials`
          : `${measured} measured trials`;
    },
    setPendingStart(fn) {
      pendingStart = fn;
    },
    setPaused(paused) {
      engingPaused = paused;
      const labelSpan = pauseButton.querySelector("span:last-child");
      if (labelSpan) labelSpan.textContent = paused ? "Resume" : "Pause";
    },
    setIntentHint(hint) {
      hintEl.textContent = hint ?? "";
    },
  };
}

function exitSessionChrome(): void {
  document.body.classList.remove("session-active");
}

/**
 * Display-only progress ceiling: the engine's planned measured trials for the
 * configured rounds, capped by its own hard stopping bound. Adaptive
 * allocation can finish earlier — the label says "≤" for exactly that reason.
 */
function plannedTrialBound(c: BrowserRunController | null): number | null {
  if (!c) return null;
  const d = c.definition;
  const planned =
    d.candidates.length *
    d.measuredRepsPerCandidatePerRound *
    Math.max(1, d.stoppingCriteria.maxSearchRounds);
  return Math.min(planned, d.stoppingCriteria.maxTotalMeasuredTrials);
}

function makeCallbacks(run: RunView): RunControllerCallbacks {
  // The candidate/scenario line stays visible through the whole trial, not
  // just on the transition that carried it.
  let stickyDetail = "";
  let previousState = "";
  return {
    onHud(state, detail) {
      const pres = STATE_PRESENTATION[state] ?? { label: state, tone: "neutral" as Tone };
      if (detail && (state === "warmup" || state === "trial-ready")) stickyDetail = detail;
      const shownDetail =
        state === "trial-active" || state === "inter-trial" ? detail || stickyDetail : detail;
      run.setState(state, pres.label, pres.tone, shownDetail);
      run.setPaused(state === "paused");
      if (state === "paused" || state === "analyzing" || state === "complete" || state === "aborted") {
        run.setIntentHint(null);
      }
      diagnosticLog.sessionTransition(previousState, state);
      previousState = state;
      if (state === "awaiting-lock") {
        run.showOverlay(
          "crosshair",
          "Click to lock in",
          "Click the arena to capture your mouse. Press Esc at any time to stop — every completed trial is already saved.",
        );
      } else if (state === "rest") {
        run.showOverlay(
          "clock",
          "Scheduled rest",
          "Short breaks protect measurement quality. The next block starts automatically — hands off the mouse.",
        );
      } else if (state === "paused") {
        run.showOverlay("pause", "Paused", "Your progress is saved. Resume when you're ready.");
      } else if (state === "candidate-transition") {
        run.showOverlay(
          "target",
          "Next candidate",
          "Switching to the next blinded sensitivity. Candidates are revealed only after the session.",
        );
      } else if (state === "analyzing") {
        run.showOverlay("pulse", "Analyzing session", "Scoring every valid trial and comparing candidates…");
      } else {
        run.hideOverlay();
      }
    },
    onTrialPersisted(trial) {
      if (trial.phase === "measured") {
        lastTrialsAnalyzed.count++;
      }
      if (trial.validity.status !== "valid") {
        diagnosticLog.validationFailure(trial.id, trial.validity.reasons.map((r) => r.code));
      }
      run.setProgress(lastTrialsAnalyzed.count, plannedTrialBound(controller));
    },
    async onExperimentFinished(status) {
      run.showOverlay(
        status === "complete" ? "check" : "flag",
        status === "complete" ? "Session complete" : "Session ended",
        status === "complete"
          ? "Opening your results…"
          : "Partial data was saved. You can review what completed or start again.",
      );
      let finalResult = null;
      let resultLoadFailed: unknown = null;
      try {
        const s = await store();
        lastRecommendation = await s.loadRecommendation(controller!.definition.id);
        if (lastRecommendation) {
          const settingsNow = loadSettings();
          const definition = controller!.definition;
          const retestPlan = planNextTest(definition, lastRecommendation, {
            priorSessionEndedAtIso: new Date().toISOString(),
            nowIso: new Date().toISOString(),
            orderSeed: settingsNow.experimentSeed + 1,
          });
          finalResult = buildFinalResult({
            recommendation: lastRecommendation,
            dpi: settingsNow.dpi,
            currentSensXPercent: settingsNow.sensX,
            currentSensYPercent: settingsNow.sensY,
            calibration: null,
            retestPlan,
          });
          diagnosticLog.log("info", "final-result", {
            action: finalResult.recommendedNextAction,
            edpi: Math.round(finalResult.immediateRecommended.edpi),
          });
        }
      } catch (err) {
        const aimErr = toAimLabError(err);
        diagnosticLog.error(aimErr.code, aimErr.message);
        lastRecommendation = null;
        resultLoadFailed = err;
      }
      lastFinalResult = finalResult;
      setTimeout(() => {
        exitSessionChrome();
        if (lastRecommendation) {
          renderResultsView(views.results, {
            recommendation: lastRecommendation,
            trialsAnalyzed: lastTrialsAnalyzed.count,
            finalResult,
            onStartTest: () => activate("setup"),
          });
        } else if (resultLoadFailed !== null) {
          // A completed session whose result could not be loaded must not
          // render the misleading "No results yet" empty state — the trials
          // exist; say what happened and how to get them back.
          renderSessionFailure(views.results, resultLoadFailed);
        } else {
          renderResultsView(views.results, {
            recommendation: null,
            trialsAnalyzed: lastTrialsAnalyzed.count,
            finalResult: null,
            onStartTest: () => activate("setup"),
          });
        }
        activate("results");
      }, 900);
    },
  };
}

renderSetupView(views.setup, {
  onStart(settings) {
    clear(views.run);
    lastTrialsAnalyzed.count = 0; // per-session counter (progress + results)
    const run = buildRunView();
    activate("run");
    run.showOverlay(
      "crosshair",
      "Click to lock in",
      "Candidates are blinded during play. Click the arena to capture your mouse and begin.",
    );

    diagnosticLog.setCaptureMode(`browser ${settings.yExploration ? "+jointXY" : ""} seed=${settings.experimentSeed}`);

    const e2e = testModeEnabled();
    const created = BrowserRunController.create(
      run.canvas,
      settings,
      makeCallbacks(run),
      {
        virtualLock: e2e,
        ...(e2e ? { restBetweenCandidatesMs: 250 } : {}),
      },
    );
    if (e2e) {
      installTestHooks(created, {
        // Result-state torture automation: render through the exact
        // production results path (same view + navigation as a real finish).
        renderResultsForTesting: ({ recommendation, finalResult, trialsAnalyzed }) => {
          lastRecommendation = recommendation;
          lastFinalResult = finalResult;
          lastTrialsAnalyzed.count = trialsAnalyzed;
          exitSessionChrome();
          renderResultsView(views.results, {
            recommendation,
            trialsAnalyzed,
            finalResult,
            onStartTest: () => activate("setup"),
          });
          activate("results");
        },
      });
    }
    void created
      .then((c) => {
        controller = c;
        run.setProgress(0, plannedTrialBound(c));
        run.setPendingStart(() => {
          void c.start().catch((err) => {
            // A rejected run() (e.g. storage died mid-session) must never
            // leave the app trapped behind the session chrome.
            diagnosticLog.error("SESSION_RUN_FAILED", String(err));
            exitSessionChrome();
            renderSessionFailure(views.results, err);
            activate("results");
          });
        });
        // E2E adapter: no real pointer-lock gesture is possible; start directly
        // (unless the spec asked for a hooks-only controller).
        if (e2e && !new URLSearchParams(window.location.search).has("nostart")) {
          void c.start().catch((err) => {
            diagnosticLog.error("SESSION_RUN_FAILED", String(err));
          });
        }
      })
      .catch((err) => {
        // create() opens IndexedDB; in private mode / blocked storage it
        // rejects and the arena would otherwise sit dead with no explanation.
        diagnosticLog.error("CONTROLLER_CREATE_FAILED", String(err));
        exitSessionChrome();
        renderStorageFailure(views.run, err);
      });
  },
});

// ---- shared resume list mount (contract: renderResumeList seam) ----

async function mountResumeList(container: HTMLElement): Promise<void> {
  try {
    const s = await store();
    await renderResumeList(container, s, {
      onResume(checkpoint: ResumeCheckpoint) {
        void infoDialog("Resuming this session", [
          `Session ${checkpoint.sessionId} has ${checkpoint.completedSequenceKeys.length} completed steps saved.`,
          "Resume restores the experiment seed, blinding, completed trials, and search state exactly — nothing is repeated or lost.",
          "The session re-attaches through the engine's recovery path on the next launch of the test runner.",
        ]);
      },
      onDiscard(checkpoint: ResumeCheckpoint) {
        void confirmDialog({
          title: "Discard this saved session?",
          body: "The checkpoint is marked as ended. Raw trial data already recorded stays in your history — nothing is deleted.",
          confirmLabel: "Discard session",
          danger: true,
        }).then((confirmed) => {
          if (!confirmed) return;
          void (async () => {
            const paths = await s.listByPrefix("sessions/checkpoints");
            for (const p of paths) {
              try {
                const loaded = await s.loadRawAt<{ sessionId?: string }>("session-checkpoint", p);
                if (loaded?.payload?.sessionId === checkpoint.sessionId) {
                  // Mark discarded rather than delete history (raw data preserved).
                  await s.saveRaw("session-checkpoint", p, {
                    ...checkpoint,
                    status: "aborted",
                  });
                }
              } catch {
                // One unreadable/mismatched checkpoint must not abort the
                // discard of the others.
              }
            }
            location.reload();
          })().catch((err) => {
            diagnosticLog.error("DISCARD_CHECKPOINT_FAILED", String(err));
            void infoDialog("Could not discard the saved session", [
              "What happened: the saved session could not be updated because of a storage error.",
              "Is your data safe: yes — the checkpoint is untouched and all recorded trials remain in your history.",
              "What to do next: reload the page and try again; if storage keeps failing, leave private mode / allow site data for this page.",
            ]);
          });
        });
      },
      onExport(checkpoint: ResumeCheckpoint) {
        const blob = JSON.stringify(checkpoint, null, 2);
        const url = URL.createObjectURL(new Blob([blob], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${checkpoint.sessionId}-resume-bundle.json`;
        anchor.click();
        URL.revokeObjectURL(url);
      },
    });
  } catch (err) {
    diagnosticLog.error("RESUME_LIST_FAILED", String(err));
  }
}

// ---- startup: preflight panel + resume list on the Test tab ----

void renderSetupPreflight();

void (async () => {
  const resumeContainer = views.setup.querySelector<HTMLElement>("#setup-resume");
  if (resumeContainer) await mountResumeList(resumeContainer);
})();

// ---- initial view ----

void renderHome();

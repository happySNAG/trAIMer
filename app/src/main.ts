import {
  renderSetupCaptureStatus,
  renderSetupView,
  setSetupCalibrationHistory,
} from "./setupView.ts";
import { loadSettings, type AppSettings } from "./state.ts";
import {
  BrowserRunController,
  type ResumeInput,
  type RunControllerCallbacks,
} from "./runController.ts";
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
import { openTraimerDb } from "./idb.ts";
import {
  planContinuation,
  type ResumeCheckpoint,
} from "../../src/session/resume.ts";
import { planCandidateBlocks } from "../../src/experiments/protocol.ts";
import { APP_VERSION, ENGINE_VERSION, PRODUCT_NAME } from "../../src/version.ts";
import { toAimLabError } from "../../src/errors/types.ts";
import { LocalDiagnosticLog } from "../../src/diagnostics/localLog.ts";
import { installGameProfileHook, installTestHooks, testModeEnabled } from "./testHooks.ts";
import {
  gatherPreflightEnvironment,
  loadStoredEngineVersions,
} from "./preflightClient.ts";
import { runPreflightChecks, type PreflightReport } from "../../src/preflight/preflight.ts";
import { renderPreflightPanel } from "./preflightView.ts";
import { buildFinalResult, type FinalResult } from "../../src/results/finalResult.ts";
import type { SessionOutcomeReport } from "../../src/results/sessionOutcome.ts";
import { planNextTest } from "../../src/session/retest.ts";
import { desktopBridge } from "./desktopBridge.ts";
import { HistoryApi } from "../../src/history/api.ts";
import type { Recommendation } from "../../src/domain/recommendation.ts";
import type { SessionStateName } from "../../src/session/types.ts";
import type { CalibrationProgressSnapshot } from "../../src/results/sessionOutcome.ts";
import {
  LOCK_FAILURE_GUIDANCE,
  type LockOutcomeCode,
} from "../../src/capture/browserSource.ts";
import { reportCaptureTier } from "./captureTiers.ts";
import { buildGameRecommendation } from "./gameConversionBridge.ts";

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
/** The most recent session's outcome report — what happened, and what it proves. */
let lastOutcomeReport: SessionOutcomeReport | null = null;
const lastTrialsAnalyzed = { count: 0 };

async function store(): Promise<LocalJsonStore> {
  return new LocalJsonStore(new IndexedDbBackend(await openTraimerDb()));
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
    void mountSetupCaptureStatus();
    // Tells the setup screen how fast the arena will actually turn, using a
    // measured calibration when the player has one (docs/ARENA-SENSITIVITY.md
    // §4). Best-effort: an unreadable store leaves the declared-reference
    // note in place, which is what an uncalibrated player gets anyway.
    void store()
      .then((s) => new HistoryApi(s).calibrationHistory())
      .then((history) => setSetupCalibrationHistory(history))
      .catch(() => undefined);
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

const SESSION_TOKEN_KEY = "traimer-session-token";
/** The key builds up to and including 1.0.0-rc.6 stored the token under. */
const LEGACY_SESSION_TOKEN_KEY = "aldo-session-token";

function sessionToken(): string {
  // Desktop shell (the shipped Windows product): the Electron main process
  // mints one token per launch and hands it to both the helper and this
  // renderer over the context bridge. Nothing is stored, nothing is pasted.
  const bridge = desktopBridge();
  if (bridge && /^[0-9a-f]{32}$/.test(bridge.sessionToken)) {
    return bridge.sessionToken;
  }
  // The legacy portable launcher passes its freshly generated helper token via
  // ?token= on first open; adopt it once so the Diagnostics capture probe
  // authenticates without manual copying. Shape-checked, never trusted
  // beyond that (it is only ever compared by the loopback helper).
  const params = new URLSearchParams(window.location.search);
  const injected = params.get("token");
  if (injected && /^[0-9a-f]{32}$/.test(injected)) {
    localStorage.setItem(SESSION_TOKEN_KEY, injected);
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
  // Current key first, then the pre-rename key, so an upgraded install keeps
  // talking to the same helper session instead of minting a new token.
  let token =
    localStorage.getItem(SESSION_TOKEN_KEY) ??
    localStorage.getItem(LEGACY_SESSION_TOKEN_KEY);
  if (!token) {
    token = `tok-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
  localStorage.setItem(SESSION_TOKEN_KEY, token);
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


/**
 * The game-facing conversion of a recommendation, or the reason there is none.
 *
 * Built here, once, from the ENGINE's game-profile layer and handed to the
 * results view whole. The view formats it; it never converts anything itself
 * (docs/UI-CONTRACT.md §4).
 */
function gameRecommendationFor(
  recommendation: Recommendation | null,
  finalResult: FinalResult | null,
): ReturnType<typeof buildGameRecommendation> {
  return buildGameRecommendation(loadSettings(), recommendation, {
    // The engine's own confidence wording, passed through verbatim so a
    // converted number can never read as more certain than the calibration.
    calibrationConfidenceLine: finalResult
      ? `Confidence in the measurement behind this: ${finalResult.confidenceLabel}.`
      : null,
  });
}

// ---- results (in-memory result, or latest persisted recommendation) ----

async function renderResults(): Promise<void> {
  // A session that ran THIS launch always renders its own outcome report,
  // recommendation or not — including when the player navigates away and back.
  if (lastOutcomeReport) {
    const experimentId = lastOutcomeReport.experimentId;
    renderResultsView(views.results, {
      recommendation: lastOutcomeReport.recommendationAvailable
        ? lastRecommendation
        : null,
      trialsAnalyzed: lastTrialsAnalyzed.count,
      finalResult: lastOutcomeReport.recommendationAvailable ? lastFinalResult : null,
      outcome: lastOutcomeReport,
      onStartTest: () => activate("setup"),
      onRunCaptureCheck: () => activate("diagnostics"),
      onContinueCalibration: lastOutcomeReport.recommendationAvailable
        ? null
        : () => void continueCalibration(experimentId),
      gameRecommendation: gameRecommendationFor(
        lastOutcomeReport.recommendationAvailable ? lastRecommendation : null,
        lastOutcomeReport.recommendationAvailable ? lastFinalResult : null,
      ),
      onChooseGameProfile: () => activate("setup"),
    });
    return;
  }
  if (lastRecommendation) {
    renderResultsView(views.results, {
      recommendation: lastRecommendation,
      trialsAnalyzed: lastTrialsAnalyzed.count,
      finalResult: lastFinalResult,
      onStartTest: () => activate("setup"),
      onRunCaptureCheck: () => activate("diagnostics"),
      gameRecommendation: gameRecommendationFor(lastRecommendation, lastFinalResult),
      onChooseGameProfile: () => activate("setup"),
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
        onRunCaptureCheck: () => activate("diagnostics"),
        gameRecommendation: gameRecommendationFor(rec, finalResult),
        onChooseGameProfile: () => activate("setup"),
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
    onRunCaptureCheck: () => activate("diagnostics"),
  });
}

// ---- run screen ----

interface RunView {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  showOverlay(
    iconName: IconName,
    title: string,
    body: string,
    actions?: { label: string; onClick: () => void; danger?: boolean }[],
  ): void;
  hideOverlay(): void;
  /** Caption for the capture path this session actually runs on. */
  setCaptureNote(caption: string, detail: string): void;
  /** Where the current drill sits in the session (round · block · drill) and what to do. */
  setDrill(
    structure: string,
    instruction: string,
    mode: "shoot" | "track" | null,
  ): void;
  setState(state: SessionStateName, label: string, tone: Tone, detail: string): void;
  setProgress(measured: number, upperBound: number | null): void;
  /** Truthful "Calibration NN %" from the engine's own plan. */
  setCalibrationProgress(progress: CalibrationProgressSnapshot): void;
  /** Arena click handler (start / retry capture). Cleared once consumed. */
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
  brand.append(icon("crosshair", 14), el("span", { text: PRODUCT_NAME }));

  // The single most important word on the screen: is this drill shot at, or
  // followed? rc.6 had no such indicator and a real player shot the tracking
  // drill for its whole six-second window.
  const modeChip = el("span", { class: "run-mode-chip", text: "" });
  modeChip.hidden = true;
  const drillEl = el("span", { class: "run-drill", text: "" });
  const instructionEl = el("span", { class: "run-instruction", text: "" });
  const topLeft = el("div", { class: "run-topbar-left" }, [
    brand,
    modeChip,
    drillEl,
    instructionEl,
  ]);
  const topRight = el("div", { class: "run-topbar-right" }, [detailEl, stateChip]);
  const topbar = el("div", { class: "run-topbar" }, [topLeft, topRight]);

  // -- stage --
  const canvas = el("canvas", { id: "run-canvas", tabindex: "0" }) as HTMLCanvasElement;
  const overlayIcon = el("div", { class: "overlay-icon" });
  const overlayTitle = el("div", { class: "overlay-title" });
  const overlayBody = el("div", { class: "overlay-body" });
  const overlayActions = el("div", { class: "overlay-actions" });
  overlayActions.hidden = true;
  const overlay = el("div", { class: "overlay-message" }, [
    overlayIcon,
    overlayTitle,
    overlayBody,
    overlayActions,
  ]);
  const stageInner = el("div", { class: "run-stage-inner" }, [canvas, overlay]);
  const stage = el("div", { class: "run-stage" }, [stageInner]);

  // -- bottom bar --
  const calibrationLabel = el("span", { class: "run-calibration-label", text: "Calibration 0%" });
  const progressLabel = el("span", { class: "run-progress-label", text: "" });
  const progressMeter = meter(0, { tone: "accent", label: "calibration progress" });
  progressMeter.style.flex = "1";
  const progressWrap = el("div", { class: "run-progress-wrap" }, [
    calibrationLabel,
    progressMeter,
    progressLabel,
  ]);

  const pauseButton = button("Pause", { icon: "pause", variant: "secondary" });
  let engingPaused = false;
  pauseButton.addEventListener("click", () => {
    if (!controller) {
      // Still opening storage. Nothing has been captured, so the honest
      // response is to leave rather than to sit on a dead button.
      exitSessionChrome();
      activate("setup");
      return;
    }
    if (!controller.started) {
      // Preparing: there is no trial boundary to pause at, so Pause withdraws
      // the capture request and hands control back immediately.
      controller.pause();
      hintEl.textContent = "Capture request withdrawn — click the arena to start.";
      return;
    }
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
    // End session must work in EVERY state, including before the controller
    // exists. Its handler therefore never depends on a runner being present.
    const started = controller?.started ?? false;
    void confirmDialog({
      title: "End this session?",
      body: started
        ? "Completed trials stay saved and the session can be reviewed, but the search will stop before a recommendation is reached."
        : "Nothing has been measured yet, so nothing is lost. You will go back to session setup.",
      confirmLabel: "End session",
      danger: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      if (!controller) {
        exitSessionChrome();
        activate("setup");
        return;
      }
      controller.cancel();
      hintEl.textContent = started
        ? "Ending after this trial…"
        : "Ending session…";
    });
  });
  // The caption is filled in from the session's ACTUAL capture path once the
  // controller reports it (app/src/captureTiers.ts) — never hardcoded.
  const captureNote = el("span", { class: "run-capture-note" });
  const captureNoteLabel = el("span", { text: "selecting capture path…" });
  captureNote.append(icon("mouse", 13), captureNoteLabel);
  // While the pointer is locked the arena owns the cursor, so these buttons
  // cannot be reached with the mouse — Esc is the way out and the bar has to
  // say so rather than leave the player clicking at an unreachable control.
  const escHint = el("span", { class: "run-capture-note" });
  escHint.append(el("kbd", { class: "kbd", text: "Esc" }), el("span", { text: "releases the mouse" }));
  const hintEl = el("span", { class: "run-capture-note", text: "" });
  const controls = el("div", { class: "run-controls" }, [hintEl, escHint, pauseButton, cancelButton]);
  const bottombar = el("div", { class: "run-bottombar" }, [progressWrap, captureNote, controls]);

  screen.append(topbar, stage, bottombar);
  views.run.append(screen);

  // The click that starts the test listens on the STAGE, not the canvas: the
  // overlay is a sibling of the canvas, so a canvas-only listener never sees a
  // click aimed at the arena while any overlay text is showing. Combined with
  // `pointer-events: none` on the overlay this makes "click the arena" work
  // wherever inside the arena the player actually clicks.
  //
  // The handler is deliberately synchronous: it runs inside the user gesture
  // so requestPointerLock() is issued with user activation still live.
  let pendingStart: (() => void) | null = null;
  stageInner.addEventListener("click", () => {
    const fn = pendingStart;
    pendingStart = null;
    fn?.();
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
    showOverlay(iconName, title, body, actions) {
      overlay.hidden = false;
      clear(overlayIcon);
      overlayIcon.append(icon(iconName, 24));
      overlayTitle.textContent = title;
      overlayBody.textContent = body;
      clear(overlayActions);
      overlayActions.hidden = !actions || actions.length === 0;
      for (const action of actions ?? []) {
        const b = button(action.label, {
          variant: action.danger ? "danger" : "primary",
        });
        b.addEventListener("click", (event) => {
          // The stage-level start handler must not also fire for a click that
          // was aimed at this button.
          event.stopPropagation();
          action.onClick();
        });
        overlayActions.append(b);
      }
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    setCaptureNote(caption, detail) {
      captureNoteLabel.textContent = caption;
      captureNote.title = detail;
    },
    setDrill(structure, instruction, mode) {
      drillEl.textContent = structure;
      instructionEl.textContent = instruction;
      modeChip.hidden = mode === null;
      if (mode !== null) {
        modeChip.textContent = mode === "track" ? "TRACK" : "SHOOT";
        modeChip.dataset.mode = mode;
      }
    },
    setCalibrationProgress(progress) {
      const percent = Math.round(progress.fraction * 100);
      if (fillEl) fillEl.style.width = `${percent}%`;
      calibrationLabel.textContent = `Calibration ${percent}%`;
      progressLabel.textContent =
        `Round ${progress.roundIndex}/${progress.roundsPlanned} · ` +
        `block ${progress.blockIndex}/${progress.blocksPerRound} · ` +
        `${progress.stepsCompleted}/${progress.stepsPlanned} drills`;
      calibrationLabel.title =
        `${progress.measuredCompleted} of ${progress.measuredPlanned} measured drills done. ` +
        "Adaptive allocation can shorten later rounds, so this can only ever move forward.";
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
      if (progressLabel.textContent === "") {
        progressLabel.textContent =
          upperBound && upperBound > 0
            ? `${measured} / ≤${upperBound} measured drills`
            : `${measured} measured drills`;
      }
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

/**
 * Removed when the run screen goes away: leaving the Esc handler bound would
 * make a later Escape cancel a session that is no longer on screen.
 */
let runScreenTeardown: (() => void) | null = null;

function exitSessionChrome(): void {
  document.body.classList.remove("session-active");
  document.body.classList.remove("capture-suspended");
  document.body.classList.remove("drill-tracking");
  // The arena's audio graph belongs to the session, not the app.
  controller?.disposeAudio();
  runScreenTeardown?.();
  runScreenTeardown = null;
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
  let restTicker: ReturnType<typeof setInterval> | null = null;
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
        // Distinct from the pre-click "Click to lock in" prompt: the request
        // is now in flight, and the player should be able to tell the two
        // apart at a glance if it stalls.
        run.showOverlay(
          "crosshair",
          "Capturing your mouse…",
          "Windows is handing the mouse to the arena. Press Esc to stop — every completed trial is already saved.",
        );
      } else if (state === "rest") {
        // Body and countdown are driven by onRest below.
        run.showOverlay("clock", "Break", "Starting…");
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
    onCaptureSuspended(reason) {
      // The mouse is the player's again: say so, and let the run screen show a
      // cursor over the arena.
      document.body.classList.add("capture-suspended");
      run.setIntentHint("Mouse released — the buttons on this screen work now.");
      diagnosticLog.log("info", "capture-suspended", { reason });
    },
    onCaptureGestureNeeded(retry) {
      // Chromium refused a gesture-less re-lock. Ask for the click instead of
      // ending the session; the handler runs inside the user activation.
      run.showOverlay(
        "crosshair",
        "Click to continue",
        "Click the arena to hand the mouse back to the test and carry on. Nothing is lost — every completed trial is saved.",
      );
      run.setPendingStart(retry);
    },
    onCaptureResumed() {
      document.body.classList.remove("capture-suspended");
      run.setIntentHint(null);
      run.hideOverlay();
      diagnosticLog.log("info", "capture-resumed", {});
    },
    onRest(rest) {
      if (restTicker !== null) {
        clearInterval(restTicker);
        restTicker = null;
      }
      if (!rest) return;
      const startedAt = performance.now();
      const isFatigue = rest.reason !== "candidate-transition";
      const title = isFatigue ? "Rest break" : "Break";
      const render = (): void => {
        const remaining = Math.max(0, rest.durationMs - (performance.now() - startedAt));
        const seconds = Math.ceil(remaining / 1000);
        run.showOverlay(
          "clock",
          title,
          isFatigue
            ? `${seconds}s — you have been testing continuously for a while. A short rest protects measurement quality, but it is yours to take. Your mouse is free: click Skip break, or press Space or Enter.`
            : `${seconds}s — next blinded sensitivity coming up. Your mouse is free: click Skip break, or press Space or Enter.`,
          [
            {
              label: "Skip break",
              onClick: () => {
                diagnosticLog.log("info", "rest-skipped", { via: "button", reason: rest.reason });
                controller?.skipRest();
              },
            },
          ],
        );
      };
      render();
      restTicker = setInterval(render, 250);
    },
    onDrill(info) {
      const structure = `Round ${info.round}/${info.rounds} · Block ${info.block}/${info.blocks} · Drill ${info.drill}/${info.drillsPlanned}${info.phase === "warmup" ? " (warm-up)" : ""}`;
      run.setDrill(structure, info.instruction, info.mode);
      document.body.classList.toggle("drill-tracking", info.mode === "track");
    },
    onCalibrationProgress(progress) {
      run.setCalibrationProgress(progress);
    },
    onReplacementBlock(notice) {
      // The player is told the count and the reason BEFORE the drills start,
      // in their units. A session that silently grew would feel broken.
      diagnosticLog.log("info", "replacement-block", {
        blockIndex: notice.blockIndex,
        maxBlocks: notice.maxBlocks,
        drills: notice.drills,
      });
      run.showOverlay(
        "target",
        notice.drills === 1 ? "One more drill" : `${notice.drills} more drills`,
        `${notice.reason}. This is block ${notice.blockIndex} of at most ${notice.maxBlocks}; the session stops as soon as it has the evidence it planned for.`,
      );
      run.setIntentHint(notice.reason);
      window.setTimeout(() => run.hideOverlay(), 2600);
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
    async onExperimentFinished(outcome) {
      const { status, abortReason, outcomeReport } = outcome;
      lastOutcomeReport = outcomeReport;
      const endedEarly = status === "aborted";

      if (endedEarly && abortReason) {
        diagnosticLog.error(
          "SESSION_ENDED_EARLY",
          `${abortReason.code}: ${abortReason.detail}`,
        );
      }

      // A session that NEVER CAPTURED the mouse measured nothing: sending it
      // to the results screen ("partial data was saved") would be a lie, and
      // leaving it on the arena would be the trap. Explain what happened and
      // offer the two things that always work.
      //
      // This is narrower than "ended early with nothing measured": a session
      // that captured the mouse and then LOST it has a real reason of its own
      // and goes to the results screen with it, rather than being mislabelled
      // as a capture that never worked.
      const captureNeverStarted =
        abortReason !== undefined &&
        Object.prototype.hasOwnProperty.call(LOCK_FAILURE_GUIDANCE, abortReason.code);
      if (endedEarly && abortReason && captureNeverStarted && lastTrialsAnalyzed.count === 0) {
        if (abortReason.code === "cancelled") {
          exitSessionChrome();
          activate("setup");
          return;
        }
        const guidance =
          LOCK_FAILURE_GUIDANCE[
            abortReason.code as Exclude<LockOutcomeCode, "acquired">
          ] ?? abortReason.detail;
        run.setState("aborted", "Capture failed", "danger", abortReason.code);
        run.showOverlay(
          "flag",
          "Could not capture your mouse",
          `${guidance} Nothing was recorded, and no settings were changed.`,
          [
            {
              label: "Try again",
              onClick: () => {
                exitSessionChrome();
                startSession(loadSettings());
              },
            },
            {
              label: "Back to setup",
              danger: true,
              onClick: () => {
                exitSessionChrome();
                activate("setup");
              },
            },
          ],
        );
        return;
      }

      // EVERY other ending — complete or early — goes to the results screen
      // with the exact reason it ended. rc.6 showed one generic sentence for
      // both a finished calibration and a session its own break had killed,
      // which is how a broken session read as a normal one.
      run.showOverlay(
        status === "complete" ? "check" : "flag",
        status === "complete" ? "Calibration complete" : "Calibration stopped early",
        status === "complete"
          ? "Opening your results…"
          : `${outcomeReport.endReasonText} Everything measured so far is saved — opening your results…`,
      );
      let finalResult: FinalResult | null = null;
      let resultLoadFailed: unknown = null;
      lastRecommendation = outcome.recommendation;
      try {
        if (outcomeReport.recommendationAvailable && lastRecommendation) {
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
        } else {
          diagnosticLog.log("info", "evidence-insufficient", {
            measured: outcomeReport.performance.validMeasuredTrials,
            moreNeeded: outcomeReport.sufficiency.additionalMeasuredTrialsNeeded,
            endKind: outcomeReport.endKind,
          });
        }
      } catch (err) {
        const aimErr = toAimLabError(err);
        diagnosticLog.error(aimErr.code, aimErr.message);
        resultLoadFailed = err;
      }
      lastFinalResult = finalResult;
      const continueTarget = controller
        ? { experimentId: String(controller.definition.id) }
        : null;
      setTimeout(() => {
        exitSessionChrome();
        if (resultLoadFailed !== null) {
          renderSessionFailure(views.results, resultLoadFailed);
        } else {
          renderResultsView(views.results, {
            recommendation: outcomeReport.recommendationAvailable
              ? lastRecommendation
              : null,
            trialsAnalyzed: lastTrialsAnalyzed.count,
            finalResult,
            outcome: outcomeReport,
            onStartTest: () => activate("setup"),
            onRunCaptureCheck: () => activate("diagnostics"),
            onContinueCalibration: continueTarget
              ? () => void continueCalibration(continueTarget.experimentId)
              : null,
            gameRecommendation: gameRecommendationFor(
              outcomeReport.recommendationAvailable ? lastRecommendation : null,
              finalResult,
            ),
            onChooseGameProfile: () => activate("setup"),
          });
        }
        activate("results");
      }, 900);
    },
  };
}

/**
 * Starts a live session on the run screen.
 *
 * The order here is load-bearing:
 *
 *  1. the arena shows "Preparing…" and accepts no start click until the
 *     controller (and its capture source) exist — a click that arrives too
 *     early cannot request Pointer Lock inside its own user gesture, and
 *     Chromium refuses gesture-less requests;
 *  2. the arena click then calls requestCaptureFromUserGesture()
 *     SYNCHRONOUSLY, before any await, so the request carries user
 *     activation;
 *  3. start() joins that same in-flight request at its execution gate.
 *
 * Escape and both bottom-bar controls stay live throughout: no state on this
 * screen may be a dead end.
 */
/**
 * Continues an unfinished calibration instead of starting a new one.
 *
 * Reads the newest checkpoint for `experimentId`, the original experiment
 * definition and every trial already recorded against it, then hands all
 * three to the engine's resume path. Completed drills are never repeated and
 * the candidate blinding is preserved, so the continued session is the SAME
 * calibration, not a second one.
 */
async function continueCalibration(experimentId: string): Promise<void> {
  try {
    const s = await store();
    const definition = await s.loadExperiment(experimentId);
    if (!definition) {
      void infoDialog("This calibration cannot be continued", [
        "What happened: the original session plan could not be found in local storage, so there is nothing to continue.",
        "Is your data safe: yes — every completed drill is still in History and Data.",
        "What to do next: start a new calibration from the Test tab.",
      ]);
      return;
    }
    const checkpoint = await newestCheckpointFor(s, experimentId);
    if (!checkpoint) {
      void infoDialog("This calibration cannot be continued", [
        "What happened: no saved checkpoint was found for this session.",
        "Is your data safe: yes — every completed drill is still in History and Data.",
        "What to do next: start a new calibration from the Test tab.",
      ]);
      return;
    }
    const trials = await s.loadAllTrials(experimentId);
    // A plan can be COMPLETE and still short of the evidence a recommendation
    // needs. Continuing then has to add a round, or the button would replay
    // nothing and show the same "more data needed" screen again.
    const continuation = planContinuation(checkpoint, definition, (round) =>
      planCandidateBlocks(definition, round),
    );
    diagnosticLog.log("info", "calibration-continued", {
      experimentId,
      completedSteps: checkpoint.completedSequenceKeys.length,
      restoredTrials: trials.length,
      remainingSteps: continuation.remainingSteps,
      addedRound: continuation.addedRound ? 1 : 0,
    });
    startSession(loadSettings(), {
      definition: continuation.definition,
      checkpoint,
      trials,
    });
  } catch (err) {
    diagnosticLog.error("CONTINUE_CALIBRATION_FAILED", String(err));
    void infoDialog("Could not continue this calibration", [
      "What happened: the saved session could not be read back from local storage.",
      "Is your data safe: yes — nothing was deleted; completed drills remain in History.",
      `Detail: ${String(err).slice(0, 200)}`,
    ]);
  }
}

/** Newest checkpoint written for one experiment, or null. */
async function newestCheckpointFor(
  s: LocalJsonStore,
  experimentId: string,
): Promise<ResumeCheckpoint | null> {
  const paths = await s.listByPrefix("sessions/checkpoints");
  let newest: ResumeCheckpoint | null = null;
  for (const path of paths) {
    try {
      const loaded = await s.loadRawAt<ResumeCheckpoint>("session-checkpoint", path);
      const payload = loaded?.payload;
      if (!payload || payload.experimentId !== experimentId) continue;
      if (newest === null || payload.updatedAtIso > newest.updatedAtIso) {
        newest = payload;
      }
    } catch {
      // One unreadable checkpoint must not hide a readable one.
    }
  }
  return newest;
}

function startSession(settings: AppSettings, resume?: ResumeInput): void {
  clear(views.run);
  lastTrialsAnalyzed.count = 0; // per-session counter (progress + results)
  lastOutcomeReport = null;
  const run = buildRunView();
  activate("run");
  run.showOverlay(
    "clock",
    resume ? "Picking up where you left off" : "Preparing the arena",
    resume
      ? "Restoring your completed drills, candidate order and search state. Nothing already measured is repeated."
      : "Opening local storage and the capture path. This takes a moment.",
  );

  diagnosticLog.setCaptureMode(`browser ${settings.yExploration ? "+jointXY" : ""} seed=${settings.experimentSeed}`);

  const e2e = testModeEnabled();
  const created = BrowserRunController.create(
    run.canvas,
    settings,
    makeCallbacks(run),
    {
      virtualLock: e2e,
      // E2E: short rests so automated sessions finish quickly, unless a spec
      // asks for a long one (?rest=<ms>) to exercise the break UI itself.
      ...(e2e ? { restBetweenCandidatesMs: e2eRestMs() } : {}),
      ...(resume ? { resume } : {}),
    },
  );
  if (e2e) {
    installTestHooks(created, {
      // Result-state torture automation: render through the exact
      // production results path (same view + navigation as a real finish).
      renderResultsForTesting: ({ recommendation, finalResult, trialsAnalyzed, outcome }) => {
        lastRecommendation = recommendation;
        lastFinalResult = finalResult;
        lastTrialsAnalyzed.count = trialsAnalyzed;
        // Store the report too: activate("results") below re-renders from the
        // module state, so a hook that only painted the DOM would be undone
        // by its own navigation.
        lastOutcomeReport = outcome ?? null;
        exitSessionChrome();
        renderResultsView(views.results, {
          recommendation,
          trialsAnalyzed,
          finalResult,
          outcome: outcome ?? null,
          onStartTest: () => activate("setup"),
          onRunCaptureCheck: () => activate("diagnostics"),
          onContinueCalibration: outcome ? () => activate("setup") : null,
          gameRecommendation: gameRecommendationFor(recommendation, finalResult),
          onChooseGameProfile: () => activate("setup"),
        });
        activate("results");
      },
    });
  }

  // Esc is the universal escape hatch. While the pointer is locked the
  // browser consumes Esc itself (which unlocks, and the capture source turns
  // that into a fatal interruption). While a lock is merely PENDING the key
  // reaches us, and it must cancel rather than leave the request hanging.
  const onKeyDown = (event: KeyboardEvent): void => {
    // Space / Enter end a break immediately. Only while a break is actually
    // in progress — during a trial the keyboard must stay inert.
    if ((event.key === " " || event.key === "Enter" || event.key === "Spacebar") && controller?.resting) {
      event.preventDefault();
      diagnosticLog.log("info", "rest-skipped", { via: event.key === "Enter" ? "enter" : "space" });
      controller.skipRest();
      return;
    }
    if (event.key !== "Escape") return;
    if (!controller || controller.started) return;
    event.preventDefault();
    diagnosticLog.log("info", "capture-cancelled", { via: "escape" });
    controller.cancel();
  };
  document.addEventListener("keydown", onKeyDown);
  runScreenTeardown = () => document.removeEventListener("keydown", onKeyDown);

  void created
    .then((c) => {
      controller = c;
      run.setProgress(0, plannedTrialBound(c));
      run.showOverlay(
        "crosshair",
        "Click to lock in",
        "Candidates are blinded during play. Click the arena to capture your mouse and begin. Press Esc at any time to stop.",
      );
      void reportCaptureTier(c.store, run.canvas)
        .then((report) => {
          c.setCaptureTier(report);
          run.setCaptureNote(report.caption, report.detail);
          diagnosticLog.log("info", "capture-tier", {
            activeTier: report.activeTier,
            activeKind: report.activeKind,
            helperState: report.native.helperState,
            nativeRejectedBecause: report.native.rejectedBecause ?? "",
          });
        })
        .catch(() => {
          // The caption is informational; never block a session on it.
          run.setCaptureNote("browser capture · pointer lock", "capture path report unavailable");
        });
      run.setPendingStart(() => {
        // SYNCHRONOUS: inside the click's user activation.
        void c.requestCaptureFromUserGesture();
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
}

function e2eRestMs(): number {
  const raw = Number(new URLSearchParams(window.location.search).get("rest"));
  return Number.isFinite(raw) && raw > 0 ? Math.min(60_000, raw) : 250;
}

renderSetupView(views.setup, {
  onStart: startSession,
  onRunCaptureCheck: () => activate("diagnostics"),
});

/**
 * Tells the player, on the SETUP screen, what capture path a calibration
 * started now would actually be measured on.
 *
 * rc.7 only ever reported this afterwards, on the results page, as "Capture
 * quality: not graded for this session — run the capture check in Diagnostics
 * before your next test". That is advice for a session that has already
 * happened. It is not a gate: a calibration on browser capture is a real
 * calibration, and the banner says how the evidence is affected rather than
 * standing in the way.
 */
async function mountSetupCaptureStatus(): Promise<void> {
  const holder = views.setup.querySelector<HTMLElement>("#setup-capture");
  if (!holder) return;
  try {
    const report = await reportCaptureTier(await store().catch(() => null), null);
    const rejected = report.native.rejectedBecause;
    renderSetupCaptureStatus(
      holder,
      {
        tier: report.activeTier,
        caption: report.caption,
        rejectedBecause: rejected,
        // Only offer the capture check when running it could actually change
        // the tier. Telling a player on a machine with no helper to "run the
        // capture check" is exactly the technically unnecessary setup this
        // pass was told not to force.
        actionable:
          report.native.helperReady && !report.native.validatedByDiagnostics,
      },
      () => activate("diagnostics"),
    );
  } catch {
    clear(holder);
  }
}

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

// The read-only registry hook for the installed-app picker gate. Test mode
// only; it converts nothing and exposes only what the picker already shows.
if (testModeEnabled()) installGameProfileHook();

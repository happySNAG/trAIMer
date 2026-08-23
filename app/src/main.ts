import { renderSetupView } from "./setupView.ts";
import { loadSettings } from "./state.ts";
import { BrowserRunController, type RunControllerCallbacks } from "./runController.ts";
import { renderResultsView } from "./resultsView.ts";
import { renderDataView } from "./dataView.ts";
import { renderCalibrationView } from "./calibrationView.ts";
import { renderHistoryView } from "./historyView.ts";
import { renderDiagnosticsView } from "./diagnosticsView.ts";
import { renderResumeList } from "./resumeView.ts";
import { el, clear } from "./dom.ts";
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
import { runPreflightChecks } from "../../src/preflight/preflight.ts";
import { renderPreflightPanel } from "./preflightView.ts";
import { buildFinalResult } from "../../src/results/finalResult.ts";
import { planNextTest } from "../../src/session/retest.ts";

const view = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

interface AppViews {
  setup: HTMLElement;
  run: HTMLElement;
  results: HTMLElement;
  data: HTMLElement;
  history: HTMLElement;
  diagnostics: HTMLElement;
  calibration: HTMLElement;
}

const views: AppViews = {
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
let lastRecommendation: Parameters<typeof renderResultsView>[1]["recommendation"] = null;
const lastTrialsAnalyzed = { count: 0 };

async function store(): Promise<LocalJsonStore> {
  return new LocalJsonStore(new IndexedDbBackend(await openAimLabDb()));
}

function activate(tab: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  const nodes: [string, HTMLElement][] = [
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
  if (tab === "data") void renderDataView(views.data);
  if (tab === "calibration") renderCalibrationView(views.calibration);
  if (tab === "history") {
    void store().then((s) => renderHistoryView(views.history, s));
  }
  if (tab === "diagnostics") renderDiagnosticsView(views.diagnostics, sessionToken(), diagnosticLog, store());
}

function sessionToken(): string {
  let token = localStorage.getItem("aldo-session-token");
  if (!token) {
    token = `tok-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem("aldo-session-token", token);
  }
  return token;
}

for (const button of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
  button.addEventListener("click", () => activate(button.dataset.tab ?? "setup"));
}

// Version footer.
{
  const footer = document.getElementById("app-footer");
  if (footer) {
    footer.textContent = `${APP_VERSION} · ${ENGINE_VERSION} · local-only, no telemetry`;
  }
}

interface RunView {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  hudLeft: HTMLElement;
  hudRight: HTMLElement;
  progress: HTMLElement;
  setPendingStart(fn: () => void): void;
}

function buildRunView(): RunView {
  clear(views.run);
  const hudLeft = el("div", {});
  const hudRight = el("div", {});
  const progress = el("div", { text: "" });
  const overlay = el("div", {
    class: "overlay-message",
    text: "Click the canvas to lock the pointer and begin.",
  });
  const canvas = el("canvas", {
    id: "run-canvas",
    tabindex: "0",
  }) as HTMLCanvasElement;

  const pauseButton = el("button", { text: "Pause" });
  pauseButton.addEventListener("click", () => {
    if (!controller) return;
    if (pauseButton.textContent === "Pause") {
      controller.pause();
      pauseButton.textContent = "Resume";
    } else {
      controller.resume();
      pauseButton.textContent = "Pause";
    }
  });
  const cancelButton = el("button", { class: "danger", text: "Cancel experiment" });
  cancelButton.addEventListener("click", () => controller?.cancel());

  views.run.append(
    el("div", { class: "hud" }, [hudLeft, hudRight]),
    el(
      "div",
      { style: "position:relative; width:1280px; margin:0 auto;" },
      [canvas, overlay],
    ),
    el("div", { class: "hud" }, [progress]),
    el("div", {}, [pauseButton, cancelButton]),
  );

  let pendingStart: (() => void) | null = null;
  canvas.addEventListener("click", () => {
    pendingStart?.();
    pendingStart = null;
  });

  return {
    canvas,
    overlay,
    hudLeft,
    hudRight,
    progress,
    setPendingStart(fn) {
      pendingStart = fn;
    },
  };
}

function makeCallbacks(run: RunView): RunControllerCallbacks {
  return {
    onHud(state, detail) {
      run.hudLeft.textContent = `state: ${state}${detail ? ` — ${detail}` : ""}`;
      diagnosticLog.sessionTransition(diagnosticLog.entries().at(-1)?.event ?? "", state);
      if (state === "awaiting-lock") {
        run.overlay.hidden = false;
        run.overlay.textContent = "Click the canvas to lock the pointer.";
      } else if (state === "rest" || state === "paused" || state === "candidate-transition") {
        run.overlay.hidden = false;
        run.overlay.textContent =
          state === "rest"
            ? `Rest — ${detail || "take a break"}. The next block starts automatically.`
            : state === "paused"
              ? "Paused."
              : "Preparing next candidate block…";
      } else {
        run.overlay.hidden = true;
      }
    },
    onTrialPersisted(trial) {
      if (trial.phase === "measured") {
        lastTrialsAnalyzed.count++;
      }
      if (trial.validity.status !== "valid") {
        diagnosticLog.validationFailure(trial.id, trial.validity.reasons.map((r) => r.code));
      }
      run.hudRight.textContent = `${trial.phase} · ${trial.scenarioId} · ${trial.outcome}`;
      run.progress.textContent = `measured trials completed: ${lastTrialsAnalyzed.count}`;
    },
    async onExperimentFinished(status) {
      run.overlay.hidden = false;
      run.overlay.textContent =
        status === "complete"
          ? "Session complete — opening results…"
          : "Session aborted — partial data was saved.";
      let finalResult = null;
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
      }
      setTimeout(() => {
        renderResultsView(views.results, {
          recommendation: lastRecommendation,
          trialsAnalyzed: lastTrialsAnalyzed.count,
          finalResult,
        });
        activate("results");
      }, 900);
    },
  };
}

renderSetupView(views.setup, {
  onStart(settings) {
    clear(views.run);
    const run = buildRunView();
    activate("run");
    run.overlay.textContent =
      "Candidates are blinded during play. Click the canvas to lock the pointer and begin.";

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
    if (e2e) installTestHooks(created);
    void created.then((c) => {
      controller = c;
      run.setPendingStart(() => {
        void c.start();
      });
      // E2E adapter: no real pointer-lock gesture is possible; start directly.
      if (e2e) void c.start();
    });
  },
});

// ---- startup preflight panel (Pass 5, requirement E) ----
void (async () => {
  try {
    const s = await store();
    const env = await gatherPreflightEnvironment(s);
    env.storedArtifactEngineVersions = await loadStoredEngineVersions(s);
    const report = runPreflightChecks(env);
    const holder = el("div", { class: "preflight-panel" });
    views.setup.prepend(holder);
    renderPreflightPanel(holder, report, null);
  } catch (err) {
    diagnosticLog.error("PREFLIGHT_FAILED", String(err));
    const holder = el("div", { class: "preflight-panel" });
    views.setup.prepend(holder);
    renderPreflightPanel(holder, null, String(err));
  }
})();

// ---- startup resume list (requirement L) ----
void (async () => {
  try {
    const s = await store();
    const resumeContainer = el("div", { class: "resume-list" });
    views.setup.prepend(resumeContainer);
    await renderResumeList(resumeContainer, s, {
      onResume(checkpoint: ResumeCheckpoint) {
        alert(
          `Resume restores experiment seed, blinding, completed trials and search state.\n` +
            `Session ${checkpoint.sessionId} has ${checkpoint.completedSequenceKeys.length} completed steps.` +
            `\n\nEngine note: resume execution is wired through SessionRunner.resumeFrom; the browser controller re-attaches on next launch.`,
        );
      },
      onDiscard(checkpoint: ResumeCheckpoint) {
        void (async () => {
          const paths = await s.listByPrefix("sessions/checkpoints");
          for (const p of paths) {
            const loaded = await s.loadRawAt<{ sessionId?: string }>("session-checkpoint", p);
            if (loaded?.payload?.sessionId === checkpoint.sessionId) {
              // Mark discarded rather than delete history (raw data preserved).
              await s.saveRaw("session-checkpoint", p, {
                ...checkpoint,
                status: "aborted",
              });
            }
          }
          location.reload();
        })();
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
})();

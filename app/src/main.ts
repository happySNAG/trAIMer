import { renderSetupView } from "./setupView.ts";
import { BrowserRunController } from "./runController.ts";
import { renderResultsView } from "./resultsView.ts";
import { renderDataView } from "./dataView.ts";
import { renderCalibrationView } from "./calibrationView.ts";
import { el, clear } from "./dom.ts";
import { LocalJsonStore } from "../../src/persistence/store.ts";
import { IndexedDbBackend } from "../../src/persistence/backends.ts";
import { openAimLabDb } from "./idb.ts";

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
  calibration: HTMLElement;
}

const views: AppViews = {
  setup: view("view-setup"),
  run: view("view-run"),
  results: view("view-results"),
  data: view("view-data"),
  calibration: view("view-calibration"),
};

let controller: BrowserRunController | null = null;
let lastRecommendation: Parameters<typeof renderResultsView>[1]["recommendation"] = null;
const lastTrialsAnalyzed = { count: 0 };

function activate(tab: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  const nodes: [string, HTMLElement][] = [
    ["setup", views.setup],
    ["run", views.run],
    ["results", views.results],
    ["data", views.data],
    ["calibration", views.calibration],
  ];
  for (const [name, node] of nodes) {
    node.hidden = name !== tab;
  }
  if (tab === "data") void renderDataView(views.data);
  if (tab === "calibration") renderCalibrationView(views.calibration);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
  button.addEventListener("click", () => activate(button.dataset.tab ?? "setup"));
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

renderSetupView(views.setup, {
  onStart(settings) {
    clear(views.run);
    const run = buildRunView();
    activate("run");
    run.overlay.textContent =
      "Candidates are blinded during play. Click the canvas to lock the pointer and begin.";

    let measuredDone = 0;

    void BrowserRunController.create(run.canvas, settings, {
      onHud(state, detail) {
        run.hudLeft.textContent = `state: ${state}${detail ? ` — ${detail}` : ""}`;
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
          measuredDone++;
          lastTrialsAnalyzed.count++;
        }
        run.hudRight.textContent = `${trial.phase} · ${trial.scenarioId} · ${trial.outcome}`;
        run.progress.textContent =
          `measured trials completed: ${measuredDone}`;
      },
      async onExperimentFinished(status) {
        run.overlay.hidden = false;
        run.overlay.textContent =
          status === "complete"
            ? "Session complete — opening results…"
            : "Session aborted — partial data was saved.";
        try {
          const store = new LocalJsonStore(new IndexedDbBackend(await openAimLabDb()));
          lastRecommendation = await store.loadRecommendation(controller!.definition.id);
        } catch {
          lastRecommendation = null;
        }
        setTimeout(() => {
          renderResultsView(views.results, {
            recommendation: lastRecommendation,
            trialsAnalyzed: lastTrialsAnalyzed.count,
          });
          activate("results");
        }, 900);
      },
    }).then((created) => {
      controller = created;
      run.setPendingStart(() => {
        void created.start();
      });
    });
  },
});

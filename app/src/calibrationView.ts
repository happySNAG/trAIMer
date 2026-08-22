import {
  deriveCalibration,
  type CalibrationMeasurement,
} from "../../src/calibration/core.ts";
import {
  PointerLockCaptureSource,
  type LockRequestableElement,
  type BrowserDocumentLike,
  type DomEventTargetLike,
} from "../../src/capture/browserSource.ts";
import { LocalJsonStore } from "../../src/persistence/store.ts";
import { IndexedDbBackend } from "../../src/persistence/backends.ts";
import { openAimLabDb } from "./idb.ts";
import { el, clear } from "./dom.ts";
import { loadSettings } from "./state.ts";

const CANVAS_SIZE = 480;

export function renderCalibrationView(container: HTMLElement): void {
  clear(container);
  const settings = loadSettings();

  container.append(
    el("h2", { text: "Fortnite sensitivity calibration (external, manual)" }),
    el("p", {
      class: "note",
      text:
        "Procedure: in Fortnite, aim at a fixed landmark. Press Start rep, perform EXACTLY the chosen rotation " +
        "(e.g. one full 360° spin returning to the same landmark), then press Stop rep. Repeat several times. " +
        "The app records raw mouse counts only; it never touches the game.",
    }),
  );

  const methodSelect = el("select", {});
  for (const [value, label] of [
    ["full-rotation", "Full rotation(s) back to start landmark"],
    ["landmark-angle", "Two landmarks with known angle"],
  ] as const) {
    const option = el("option", { value, text: label });
    methodSelect.append(option);
  }
  const thetaInput = el("input", { type: "number", value: 360, step: "1" });
  const dpiInput = el("input", { type: "number", value: settings.dpi });
  const sensInput = el("input", { type: "number", step: "0.01", value: settings.sensX });
  const repsTarget = el("input", { type: "number", value: 6, min: "4", max: "20" });
  const canvas = el("canvas", {
    width: String(CANVAS_SIZE),
    height: "160",
  }) as HTMLCanvasElement;
  canvas.style.background = "#000";
  canvas.style.display = "block";

  const startButton = el("button", { class: "primary", text: "Start rep" });
  const stopButton = el("button", { text: "Stop rep" }) as HTMLButtonElement;
  stopButton.disabled = true;
  const computeButton = el("button", { class: "primary", text: "Compute & save calibration" });

  const liveCounts = el("p", { text: "counts this rep: 0" });
  const table = el("table", {});
  const status = el("p", { class: "note", text: "" });

  let capture: PointerLockCaptureSource | null = null;
  let accumulating = false;
  let accX = 0;
  const measurements: Omit<CalibrationMeasurement, "rejected" | "rejectReason">[] = [];

  function redrawMeasurements(): void {
    clear(table);
    table.append(
      el("tr", {}, [
        el("th", { text: "#" }),
        el("th", { text: "counts X" }),
        el("th", { text: "deg/count @100%" }),
        el("th", { text: "rejected" }),
      ]),
    );
    const derived = measurements.map((m) => m.thetaDeg / (m.countsX * (m.sensPercent / 100)));
    for (let i = 0; i < measurements.length; i++) {
      table.append(
        el("tr", {}, [
          el("td", { text: String(i + 1) }),
          el("td", { text: measurements[i]!.countsX.toFixed(0) }),
          el("td", { text: Number.isFinite(derived[i]) ? derived[i]!.toFixed(5) : "—" }),
          el("td", { text: "" }),
        ]),
      );
    }
  }

  async function lock(): Promise<boolean> {
    capture = new PointerLockCaptureSource({
      element: canvas as unknown as LockRequestableElement,
      document: window.document as unknown as BrowserDocumentLike,
      window: window as unknown as DomEventTargetLike,
      viewportProvider: () => ({ widthPx: CANVAS_SIZE, heightPx: 160 }),
    });
    let acc = 0;
    capture.start({
      onEvent(event) {
        if (event.kind === "pointer-sample" && accumulating) {
          acc += event.dx;
          accX = acc;
          liveCounts.textContent = `counts this rep: ${acc.toFixed(0)}`;
          drawAccumulator(canvas, acc);
        }
      },
    });
    return capture.requestLock();
  }

  startButton.addEventListener("click", async () => {
    if (!capture) await lock();
    accX = 0;
    accumulating = true;
    startButton.disabled = true;
    stopButton.disabled = false;
  });

  stopButton.addEventListener("click", () => {
    accumulating = false;
    startButton.disabled = false;
    stopButton.disabled = true;
    measurements.push({
      repIndex: measurements.length,
      countsX: Math.abs(accX),
      countsY: 0,
      thetaDeg: Number(thetaInput.value) || 360,
      dpi: Number(dpiInput.value) || settings.dpi,
      sensPercent: Number(sensInput.value) || settings.sensX,
      capturedAtIso: new Date().toISOString(),
      method: methodSelect.value as CalibrationMeasurement["method"],
    });
    redrawMeasurements();
  });

  computeButton.addEventListener("click", async () => {
    const record = deriveCalibration("x", methodSelect.value as CalibrationMeasurement["method"], measurements);
    const backend = new IndexedDbBackend(await openAimLabDb());
    const store = new LocalJsonStore(backend);
    await store.saveRaw(
      "calibration-record",
      `calibrations/x-${Date.now()}.json`,
      record,
    );
    status.textContent = record.adequate
      ? `saved. degreesPerCountAt100 = ${record.degreesPerCountAt100?.toExponential(4)} ± ${record.standardErrorDegreesPerCountAt100?.toExponential(2)} (95% CI ${record.ci95DegreesPerCountAt100?.min.toExponential(3)}–${record.ci95DegreesPerCountAt100?.max.toExponential(3)})`
      : `NOT adequate — not saved as calibrated. Reasons: ${record.inadequacyReasons.join("; ")}. Raw measurements still stored.`;
  });

  container.append(
    el("label", { text: "Method" }), methodSelect,
    el("label", { text: "Rotation angle θ (degrees)" }), thetaInput,
    el("label", { text: "DPI" }), dpiInput,
    el("label", { text: "In-game X sensitivity used during calibration (%)" }), sensInput,
    el("label", { text: "Target repetitions" }), repsTarget,
    canvas, liveCounts,
    el("div", {}, [startButton, stopButton]),
    table,
    computeButton,
    status,
  );

  redrawMeasurements();
}

function drawAccumulator(canvas: HTMLCanvasElement, acc: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#101418";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#3aa0ff";
  ctx.beginPath();
  ctx.moveTo(10, canvas.height / 2 - Math.min(60, Math.abs(acc) / 8));
  ctx.lineTo(Math.min(canvas.width - 10, 10 + Math.abs(acc) / 6), canvas.height / 2);
  ctx.stroke();
}

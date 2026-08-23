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
import { HistoryApi } from "../../src/history/api.ts";
import { openAimLabDb } from "./idb.ts";
import { el, clear } from "./dom.ts";
import { loadSettings } from "./state.ts";
import {
  badge,
  button,
  card,
  field,
  formatDate,
  grid,
  pageHeader,
  sectionLabel,
  table,
} from "./ui.ts";

const CANVAS_SIZE = 480;

export function renderCalibrationView(container: HTMLElement): void {
  clear(container);
  const settings = loadSettings();

  container.append(
    pageHeader(
      "Calibration",
      "Links raw mouse counts to in-game rotation so recommendations can be expressed physically. Runs alongside Fortnite — the app records mouse counts only and never touches the game.",
    ),
  );

  // ---- current calibration status (engine records, rendered verbatim) ----
  const statusHolder = el("div", {});
  container.append(statusHolder);
  void (async () => {
    try {
      const store = new LocalJsonStore(new IndexedDbBackend(await openAimLabDb()));
      const api = new HistoryApi(store);
      const snap = await api.snapshot();
      const latest = snap.calibrationHistory[snap.calibrationHistory.length - 1];
      if (!latest) {
        statusHolder.append(
          card(
            { title: "No calibration on record", icon: "calibration", tone: "warn" },
            el("p", {
              class: "muted",
              text:
                "The engine treats the mouse-to-rotation transform as UNCALIBRATED until you complete this flow. Testing still works; physical distances (cm/360) stay unavailable.",
            }),
          ),
        );
        return;
      }
      statusHolder.append(
        card(
          {
            title: "Current calibration",
            subtitle: `Axis ${latest.axis.toUpperCase()} · recorded ${formatDate(latest.createdAtIso)}`,
            icon: "calibration",
            tone: latest.adequate ? "ok" : "danger",
            actions: [latest.adequate ? badge("ok", "adequate") : badge("danger", "not adequate")],
          },
          el("p", {
            class: "mono muted",
            text:
              latest.degreesPerCountAt100 !== null
                ? `${latest.degreesPerCountAt100.toExponential(4)} deg/count @100% · DPI ${latest.dpi?.toFixed(0) ?? "—"} · ${latest.method}`
                : `method ${latest.method}`,
          }),
        ),
      );
    } catch {
      // Status card is optional; the flow below still works.
    }
  })();

  // ---- guided procedure ----
  const steps = el("div", { class: "calib-steps" }, [
    el("div", { class: "calib-step", text: "In Fortnite, aim precisely at a fixed landmark (a door edge, a sign corner)." }),
    el("div", { class: "calib-step", text: "Press Start rep here, switch to the game, and perform EXACTLY the chosen rotation — e.g. one full 360° spin ending back on the same landmark." }),
    el("div", { class: "calib-step", text: "Press Stop rep. Repeat until you have at least 4–6 clean repetitions; more reps tighten the estimate." }),
    el("div", { class: "calib-step", text: "Press Compute & save. The engine judges whether the measurements are adequate — inadequate sets are stored but never trusted." }),
  ]);

  const methodSelect = el("select", {});
  for (const [value, label] of [
    ["full-rotation", "Full rotation(s) back to start landmark"],
    ["landmark-angle", "Two landmarks with known angle"],
  ] as const) {
    methodSelect.append(el("option", { value, text: label }));
  }
  const thetaInput = el("input", { type: "number", value: 360, step: "1" });
  const dpiInput = el("input", { type: "number", value: settings.dpi });
  const sensInput = el("input", { type: "number", step: "0.01", value: settings.sensX });
  const repsTarget = el("input", { type: "number", value: 6, min: "4", max: "20" });

  const paramsGrid = el("div", { class: "form-grid" }, [
    field("Method", methodSelect),
    field("Rotation angle θ (degrees)", thetaInput),
    field("DPI", dpiInput),
    field("In-game X sensitivity during calibration (%)", sensInput),
    field("Target repetitions", repsTarget),
  ]);

  const canvas = el("canvas", {
    id: "calibration-canvas",
    width: String(CANVAS_SIZE),
    height: "120",
  }) as HTMLCanvasElement;

  const counter = el("div", { class: "calib-counter mono", text: "0" });
  const counterLabel = el("div", { class: "calib-counter-label", text: "counts this rep" });
  const counterWrap = el("div", {}, [counter, counterLabel]);
  const live = el("div", { class: "calib-live" }, [counterWrap, canvas]);

  const startButton = button("Start rep", { variant: "primary", icon: "play" });
  const stopButton = button("Stop rep", { variant: "secondary" });
  stopButton.disabled = true;
  const computeButton = button("Compute & save calibration", { variant: "primary", icon: "check" });

  const measurementsTableHolder = el("div", {});
  const status = el("p", { class: "note", text: "" });

  let capture: PointerLockCaptureSource | null = null;
  let accumulating = false;
  let accX = 0;
  const measurements: Omit<CalibrationMeasurement, "rejected" | "rejectReason">[] = [];

  function redrawMeasurements(): void {
    clear(measurementsTableHolder);
    const derived = measurements.map((m) => m.thetaDeg / (m.countsX * (m.sensPercent / 100)));
    measurementsTableHolder.append(
      table({
        head: ["#", "Counts X", "deg/count @100%"],
        rows: measurements.map((m, i) => [
          String(i + 1),
          el("span", { class: "mono", text: m.countsX.toFixed(0) }),
          el("span", {
            class: "mono",
            text: Number.isFinite(derived[i]) ? derived[i]!.toFixed(5) : "—",
          }),
        ]),
        emptyText: "No repetitions recorded yet.",
      }),
    );
  }

  async function lock(): Promise<boolean> {
    capture = new PointerLockCaptureSource({
      element: canvas as unknown as LockRequestableElement,
      document: window.document as unknown as BrowserDocumentLike,
      window: window as unknown as DomEventTargetLike,
      viewportProvider: () => ({ widthPx: CANVAS_SIZE, heightPx: 120 }),
    });
    let acc = 0;
    capture.start({
      onEvent(event) {
        if (event.kind === "pointer-sample" && accumulating) {
          acc += event.dx;
          accX = acc;
          counter.textContent = acc.toFixed(0);
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
    counter.textContent = "0";
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
    status.className = record.adequate ? "tone-ok" : "tone-danger";
    status.textContent = record.adequate
      ? `Saved. degreesPerCountAt100 = ${record.degreesPerCountAt100?.toExponential(4)} ± ${record.standardErrorDegreesPerCountAt100?.toExponential(2)} (95% CI ${record.ci95DegreesPerCountAt100?.min.toExponential(3)}–${record.ci95DegreesPerCountAt100?.max.toExponential(3)})`
      : `Not adequate — not saved as calibrated. Reasons: ${record.inadequacyReasons.join("; ")}. Raw measurements still stored.`;
  });

  container.append(sectionLabel("Guided procedure — external, manual"));
  container.append(
    grid(
      2,
      card({ title: "How it works", icon: "info" }, steps),
      card({ title: "Parameters", icon: "settings" }, paramsGrid),
    ),
  );

  container.append(sectionLabel("Record repetitions"));
  container.append(
    card(
      { title: "Live counter", subtitle: "Raw horizontal mouse counts accumulate while a rep is running", icon: "mouse" },
      live,
      el("div", { style: "display:flex;gap:10px" }, [startButton, stopButton]),
      measurementsTableHolder,
      el("div", {}, [computeButton]),
      status,
    ),
  );

  redrawMeasurements();
}

function drawAccumulator(canvas: HTMLCanvasElement, acc: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#05070a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const w = Math.min(canvas.width - 20, Math.abs(acc) / 6);
  ctx.fillStyle = "rgba(200, 242, 78, 0.25)";
  ctx.fillRect(10, canvas.height / 2 - 8, w, 16);
  ctx.strokeStyle = "#c8f24e";
  ctx.lineWidth = 2;
  ctx.strokeRect(10, canvas.height / 2 - 8, Math.max(1, w), 16);
}

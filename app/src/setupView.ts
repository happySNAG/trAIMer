import { el, clear } from "./dom.ts";
import { loadSettings, saveSettings, type AppSettings } from "./state.ts";

export interface SetupCallbacks {
  onStart(settings: AppSettings): void;
}

export function renderSetupView(
  container: HTMLElement,
  callbacks: SetupCallbacks,
): void {
  const settings = loadSettings();
  clear(container);

  const nameInput = el("input", { type: "text", value: settings.playerName });
  const dpiInput = el("input", { type: "number", value: settings.dpi });
  const sensXInput = el("input", { type: "number", step: "0.1", value: settings.sensX });
  const sensYInput = el("input", { type: "number", step: "0.1", value: settings.sensY });
  const seedInput = el("input", { type: "number", value: settings.experimentSeed });
  const roundsInput = el("input", { type: "number", min: "1", max: "4", value: settings.rounds });
  const repsInput = el("input", { type: "number", min: "3", max: "20", value: settings.repsPerCandidate });
  const warmupsInput = el("input", { type: "number", min: "0", max: "5", value: settings.warmupTrials });
  const yCheck = el("input", { type: "checkbox" }) as HTMLInputElement;
  yCheck.checked = settings.yExploration;

  const form = el(
    "form",
    {},
    [
      el("h2", { text: "Experiment setup" }),
      el("label", { text: "Player name" }), nameInput,
      el("label", { text: "Mouse DPI" }), dpiInput,
      el("label", { text: "Fortnite X sensitivity (%)" }), sensXInput,
      el("label", { text: "Fortnite Y sensitivity (%) — leave equal unless exploring" }), sensYInput,
      el("label", { text: "Experiment seed" }), seedInput,
      el("label", { text: "Search rounds" }), roundsInput,
      el("label", { text: "Measured reps per candidate per round" }), repsInput,
      el("label", { text: "Warmup trials per block" }), warmupsInput,
      el("label", {}), el("span", {}, [yCheck, " explore independent Y after X search"]),
      el("p", {
        class: "note",
        text:
          "Candidates are blinded during play (shown as letters). " +
          "Rests are enforced automatically. Press Escape or Alt+Tab to abort safely.",
      }),
      el("button", { class: "primary", type: "submit", text: "Start session" }),
    ],
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next: AppSettings = {
      playerName: (nameInput.value || "player").trim(),
      dpi: Number(dpiInput.value) || 800,
      sensX: Number(sensXInput.value) || 7,
      sensY: Number(sensYInput.value) || 7,
      experimentSeed: Number(seedInput.value) || 20260822,
      rounds: Math.max(1, Math.min(4, Number(roundsInput.value) || 2)),
      repsPerCandidate: Math.max(3, Math.min(20, Number(repsInput.value) || 8)),
      warmupTrials: Math.max(0, Math.min(5, Number(warmupsInput.value) || 2)),
      yExploration: yCheck.checked,
    };
    saveSettings(next);
    callbacks.onStart(next);
  });

  container.append(form);
}

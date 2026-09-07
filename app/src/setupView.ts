import { edpi } from "../../src/sensmath/sensitivity.ts";
import { el, clear } from "./dom.ts";
import { loadSettings, saveSettings, type AppSettings } from "./state.ts";
import { button, card, detailsBlock, field, icon, pageHeader, sectionLabel } from "./ui.ts";

export interface SetupCallbacks {
  onStart(settings: AppSettings): void;
}

export function renderSetupView(
  container: HTMLElement,
  callbacks: SetupCallbacks,
): void {
  const settings = loadSettings();
  clear(container);

  container.append(
    pageHeader(
      "Aim Test",
      "A blinded session that measures your aim across several sensitivities and recommends the one the evidence supports.",
    ),
  );

  // Holders filled by main.ts (resume list + preflight report seams).
  container.append(
    el("div", { id: "setup-resume", class: "resume-list" }),
    el("div", { id: "setup-preflight", class: "preflight-panel" }),
  );

  const nameInput = el("input", { type: "text", value: settings.playerName, id: "setup-name" });
  const dpiInput = el("input", { type: "number", value: settings.dpi, id: "setup-dpi" });
  const sensXInput = el("input", { type: "number", step: "0.1", value: settings.sensX, id: "setup-sensx" });
  const sensYInput = el("input", { type: "number", step: "0.1", value: settings.sensY, id: "setup-sensy" });
  const seedInput = el("input", { type: "number", value: settings.experimentSeed, id: "setup-seed" });
  const roundsInput = el("input", { type: "number", min: "1", max: "4", value: settings.rounds, id: "setup-rounds" });
  const repsInput = el("input", { type: "number", min: "3", max: "20", value: settings.repsPerCandidate, id: "setup-reps" });
  const warmupsInput = el("input", { type: "number", min: "0", max: "5", value: settings.warmupTrials, id: "setup-warmups" });
  const yCheck = el("input", { type: "checkbox", id: "setup-ycheck" }) as HTMLInputElement;
  yCheck.checked = settings.yExploration;
  const breaksCheck = el("input", { type: "checkbox", id: "setup-autobreaks" }) as HTMLInputElement;
  breaksCheck.checked = settings.autoBreaks;
  const breakSecondsInput = el("input", {
    type: "number",
    min: "5",
    max: "60",
    value: settings.breakSeconds,
    id: "setup-breakseconds",
  }) as HTMLInputElement;
  breakSecondsInput.disabled = !settings.autoBreaks;
  breaksCheck.addEventListener("change", () => {
    breakSecondsInput.disabled = !breaksCheck.checked;
  });

  // Live eDPI preview (engine sensmath, display only).
  const edpiPreview = el("span", { class: "mono", text: "" });
  const updateEdpi = (): void => {
    const dpiNow = Number(dpiInput.value) || 0;
    const sensNow = Number(sensXInput.value) || 0;
    edpiPreview.textContent =
      dpiNow > 0 && sensNow > 0 ? `${edpi(dpiNow, sensNow).toFixed(0)} eDPI` : "—";
  };
  dpiInput.addEventListener("input", updateEdpi);
  sensXInput.addEventListener("input", updateEdpi);
  updateEdpi();

  const playerGrid = el("div", { class: "form-grid" }, [
    field("Player name", nameInput),
    field("Mouse DPI", dpiInput, {
      hint: "The DPI configured in your mouse software. Keep it fixed across sessions.",
    }),
  ]);

  const sensGrid = el("div", { class: "form-grid" }, [
    field("Fortnite X sensitivity (%)", sensXInput, {
      hint: "Your current in-game horizontal sensitivity — the starting point of the search.",
    }),
    field("Fortnite Y sensitivity (%)", sensYInput, {
      hint: "Leave equal to X unless you deliberately run an asymmetric setup.",
    }),
  ]);

  const yRow = el("label", { class: "check-row", for: "setup-ycheck" }, [
    yCheck,
    el("span", { text: "Explore independent vertical sensitivity after the X search" }),
  ]);

  const breaksRow = el("label", { class: "check-row", for: "setup-autobreaks" }, [
    breaksCheck,
    el("span", { text: "Automatic break between candidate blocks (always skippable — Space, Enter, or Skip break)" }),
  ]);
  const breaksGrid = el("div", { class: "form-grid" }, [
    field("Break length (seconds)", breakSecondsInput, {
      hint: "5–60. A short reset when the blinded sensitivity changes. Skip it any time; a fatigue-triggered rest is longer but also skippable.",
    }),
  ]);

  const advancedGrid = el("div", { class: "form-grid" }, [
    field("Experiment seed", seedInput, {
      hint: "Controls candidate ordering and target placement. Change it for a fresh randomization.",
    }),
    field("Search rounds", roundsInput, {
      hint: "1–4. More rounds refine the search but lengthen the session.",
    }),
    field("Measured reps per candidate per round", repsInput, {
      hint: "3–20. The evidence backbone — more reps, stronger conclusions.",
    }),
    field("Warm-up trials per block", warmupsInput, {
      hint: "0–5. Warm-ups are never analyzed; they absorb adjustment to each candidate.",
    }),
  ]);

  const startBtn = button("Start Aim Test", {
    variant: "primary",
    icon: "play",
    large: true,
    type: "submit",
  });

  const sessionNote = el("p", { class: "note" }, [
    "Candidates are blinded during play and shown only as letters. ",
    "Rests are enforced automatically. Press Esc or switch windows at any time to stop safely — completed trials are always saved.",
  ]);

  const form = el("form", {}, []);
  const formCard = card(
    { title: "Session setup", subtitle: "Saved automatically for next time", icon: "settings" },
    playerGrid,
    sectionLabel("Sensitivity"),
    sensGrid,
    el("div", { class: "check-row" }, [
      icon("zap", 14),
      el("span", { class: "muted", text: "Current baseline:" }),
      edpiPreview,
    ]),
    yRow,
    sectionLabel("Breaks"),
    breaksRow,
    breaksGrid,
    detailsBlock(
      "Advanced session parameters",
      advancedGrid,
    ),
    sessionNote,
    el("div", {}, [startBtn]),
  );
  form.append(formCard);

  /**
   * Reads a numeric field, falling back only when the value is genuinely
   * unusable.
   *
   * `Number(input.value) || fallback` treats a legitimate ZERO as "empty":
   * a player who set warm-up trials to 0 — a documented, in-range choice —
   * silently got 2 instead, and the automated suites inherited the same
   * surprise.
   */
  const numberField = (input: HTMLElement, fallback: number): number => {
    const raw = (input as HTMLInputElement).value.trim();
    if (raw === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next: AppSettings = {
      playerName: (nameInput.value || "player").trim(),
      dpi: numberField(dpiInput, 800),
      sensX: numberField(sensXInput, 7),
      sensY: numberField(sensYInput, 7),
      experimentSeed: numberField(seedInput, 20260822),
      rounds: Math.max(1, Math.min(4, numberField(roundsInput, 2))),
      repsPerCandidate: Math.max(3, Math.min(20, numberField(repsInput, 8))),
      warmupTrials: Math.max(0, Math.min(5, numberField(warmupsInput, 2))),
      yExploration: yCheck.checked,
      autoBreaks: breaksCheck.checked,
      breakSeconds: Math.max(5, Math.min(60, numberField(breakSecondsInput, 10))),
    };
    saveSettings(next);
    callbacks.onStart(next);
  });

  container.append(form);
}

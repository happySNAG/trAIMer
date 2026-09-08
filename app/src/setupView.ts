import { edpi } from "../../src/sensmath/sensitivity.ts";
import {
  CALIBRATION_MODES,
  CALIBRATION_MODE_ORDER,
  estimateModePlan,
  type CalibrationModeId,
} from "../../src/experiments/sessionModes.ts";
import { DEFAULT_LADDER_FACTORS } from "../../src/experiments/protocol.ts";
import { el, clear } from "./dom.ts";
import {
  loadSettings,
  saveSettings,
  withCalibrationMode,
  type AppSettings,
} from "./state.ts";
import { badge, button, card, detailsBlock, field, icon, inlineAlert, pageHeader, sectionLabel } from "./ui.ts";
import { renderGameProfilePanel } from "./gameProfileView.ts";
import type { GameProfileSelection } from "../../src/games/selection.ts";
import { resolveArenaAnchor } from "./arenaSensitivity.ts";
import { arenaCmPer360 } from "../../src/sensmath/arenaGain.ts";
import type { CalibrationHistoryEntry } from "../../src/history/api.ts";

/**
 * The player's calibration history, cached for the arena-feel note below.
 *
 * Setup renders synchronously at boot while the calibration store opens
 * asynchronously, so main.ts pushes the history in when it arrives (the same
 * shape as the capture-status banner). Until then the note describes the
 * declared-reference anchor, which is what an uncalibrated player really gets.
 */
let cachedCalibrationHistory: readonly CalibrationHistoryEntry[] = [];
let refreshArenaFeelNote: (() => void) | null = null;

/** Called by main.ts once the calibration store has been read. */
export function setSetupCalibrationHistory(
  history: readonly CalibrationHistoryEntry[],
): void {
  cachedCalibrationHistory = history;
  refreshArenaFeelNote?.();
}

export interface SetupCallbacks {
  onStart(settings: AppSettings): void;
  /** Opens Diagnostics on the capture check (requirement 3). */
  onRunCaptureCheck?: (() => void) | undefined;
}

/**
 * What the setup screen knows about this machine's capture path, so a player
 * is told BEFORE a calibration whether it will be measured at the confidence
 * they think it will.
 *
 * rc.7 buried this in Diagnostics and reported it only afterwards, on the
 * results page, as "Not graded for this session — run the capture check in
 * Diagnostics before your next test". By then the session was over.
 */
export interface SetupCaptureStatus {
  tier: 1 | 2 | 3;
  caption: string;
  /** Null when tier 1 is carrying the session. */
  rejectedBecause: string | null;
  /** True when the player could improve the tier by acting. */
  actionable: boolean;
}

export function renderSetupView(
  container: HTMLElement,
  callbacks: SetupCallbacks,
): void {
  let settings = loadSettings();
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
    el("div", { id: "setup-capture", class: "setup-capture" }),
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
    field("Starting sensitivity — X (%)", sensXInput, {
      hint: "The starting point of the search, on a percentage scale. The recommendation is reported relative to this number; choose your game below to see it in that game's own units.",
    }),
    field("Starting sensitivity — Y (%)", sensYInput, {
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

  // Editing a plan number by hand is a deliberate move OFF the named modes.
  for (const input of [roundsInput, repsInput, warmupsInput]) {
    input.addEventListener("input", () => {
      settings = {
        ...settings,
        rounds: Math.max(1, Math.min(4, Number((roundsInput as HTMLInputElement).value) || settings.rounds)),
        repsPerCandidate: Math.max(3, Math.min(20, Number((repsInput as HTMLInputElement).value) || settings.repsPerCandidate)),
        warmupTrials: Math.max(0, Math.min(5, Number((warmupsInput as HTMLInputElement).value))),
        calibrationMode: "custom",
      };
      settings = { ...settings, calibrationMode: classifyCurrentPlan() };
      refreshModeSelection();
    });
  }

  const classifyCurrentPlan = (): CalibrationModeId => {
    for (const modeId of CALIBRATION_MODE_ORDER) {
      const mode = CALIBRATION_MODES[modeId];
      if (
        mode.rounds === settings.rounds &&
        mode.measuredRepsPerCandidatePerRound === settings.repsPerCandidate &&
        mode.warmupTrialsPerCandidateBlock === settings.warmupTrials
      ) {
        return modeId;
      }
    }
    return "custom";
  };

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

  // ---- calibration length ----------------------------------------------
  //
  // A mode fixes rounds / reps / warm-ups; every other part of the protocol
  // is identical between them. The card shows the drills, the time and the
  // strongest result the evidence at that length can support — never a
  // promised confidence percentage, because confidence depends on how far
  // apart the player's own candidates turn out to be.
  const candidateCount = DEFAULT_LADDER_FACTORS.length;
  const modeCards = el("div", { class: "mode-grid", id: "setup-modes" });
  const modeButtons = new Map<CalibrationModeId, HTMLButtonElement>();

  const applyMode = (modeId: CalibrationModeId): void => {
    settings = withCalibrationMode(settings, modeId);
    (roundsInput as HTMLInputElement).value = String(settings.rounds);
    (repsInput as HTMLInputElement).value = String(settings.repsPerCandidate);
    (warmupsInput as HTMLInputElement).value = String(settings.warmupTrials);
    refreshModeSelection();
  };

  function currentModeId(): CalibrationModeId {
    return settings.calibrationMode;
  }

  function refreshModeSelection(): void {
    const active = currentModeId();
    for (const [id, node] of modeButtons) {
      const selected = id === active;
      node.classList.toggle("selected", selected);
      node.setAttribute("aria-pressed", selected ? "true" : "false");
    }
    customNote.hidden = active !== "custom";
  }

  const customNote = el("p", {
    class: "note",
    id: "setup-mode-custom",
    text: "Custom plan — the advanced parameters below no longer match Quick, Standard or Precision. Pick a mode above to go back to a documented plan.",
  });
  customNote.hidden = true;

  for (const modeId of CALIBRATION_MODE_ORDER) {
    const mode = CALIBRATION_MODES[modeId];
    const plan = estimateModePlan(mode, {
      candidateCount,
      restBetweenCandidatesMs: settings.autoBreaks ? settings.breakSeconds * 1000 : 0,
    });
    const node = el("button", {
      type: "button",
      class: "mode-card",
      "data-mode": modeId,
      "aria-pressed": "false",
    }) as HTMLButtonElement;
    node.append(
      el("div", { class: "mode-card-head" }, [
        el("span", { class: "mode-card-title", text: mode.label }),
        ...(modeId === "standard" ? [badge("accent", "Recommended")] : []),
      ]),
      el("p", { class: "mode-card-tagline", text: mode.tagline }),
      el("div", { class: "mode-card-facts" }, [
        el("span", { class: "mode-fact", text: `${plan.totalDrills} drills` }),
        el("span", { class: "mode-fact", text: `~${plan.estimatedMinutes} min` }),
        el("span", {
          class: "mode-fact",
          text: `${plan.measuredDrills} measured`,
        }),
      ]),
      el("p", {
        class: "mode-card-evidence",
        text: `Aims for ${mode.targetValidTrialsPerCandidate} usable drills on each of the ${plan.candidates} sensitivities tested.`,
      }),
      el("p", { class: "mode-card-claim", text: mode.claim }),
    );
    node.addEventListener("click", () => applyMode(modeId));
    modeButtons.set(modeId, node);
    modeCards.append(node);
  }

  const modeCard = card(
    {
      title: "How long should this take?",
      subtitle:
        "Every mode runs the same drills, the same blinding and the same scoring. A shorter mode buys less evidence — never easier evidence.",
      icon: "clock",
    },
    modeCards,
    customNote,
  );

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

  // ---- what the arena will actually feel like -------------------------
  //
  // The player is about to spend twenty minutes comparing sensitivities with
  // their hand, so they are told what the arena anchors that comparison to
  // BEFORE they start, not afterwards on a results page. The differences
  // between candidates are exact on every anchor; only the absolute feel
  // depends on the evidence available (docs/ARENA-SENSITIVITY.md §4).
  const arenaNote = el("p", { class: "note", id: "setup-arena-feel" });
  const refreshArenaNote = (): void => {
    const dpi = numberField(dpiInput, settings.dpi);
    const baseline = {
      sensX: numberField(sensXInput, settings.sensX),
      sensY: numberField(sensYInput, settings.sensY),
    };
    const anchor = resolveArenaAnchor(
      { baseline, dpi, gameProfile: gameSelection },
      cachedCalibrationHistory,
    );
    const cm = arenaCmPer360(anchor, baseline, dpi).x;
    arenaNote.textContent = `The test arena turns at about ${cm.toFixed(0)} cm per 360° at your starting sensitivity — based on ${anchor.basis}. Each blinded candidate speeds that up or slows it down by its own amount, which is the difference you are being asked to feel.`;
  };

  // ---- game profile (progressive disclosure) --------------------------
  //
  // One select until a game is chosen; the game's own settings and a live
  // physical equivalent only after. The panel re-renders on every change so
  // the equivalent can never be stale relative to the DPI field above it.
  const gameHolder = el("div", { id: "setup-game-profile" });
  let gameSelection: GameProfileSelection | null = settings.gameProfile;
  const refreshGamePanel = (): void => {
    renderGameProfilePanel(
      gameHolder,
      { selection: gameSelection, dpi: numberField(dpiInput, settings.dpi) },
      {
        onChange(next) {
          gameSelection = next;
          settings = { ...settings, gameProfile: next };
          saveSettings(settings);
          refreshGamePanel();
          // Choosing a game (or typing the sensitivity they play at) changes
          // which anchor the arena runs on, so the feel note must follow.
          refreshArenaNote();
        },
      },
    );
  };
  dpiInput.addEventListener("change", refreshGamePanel);
  for (const input of [dpiInput, sensXInput, sensYInput]) {
    input.addEventListener("change", refreshArenaNote);
  }
  refreshArenaFeelNote = refreshArenaNote;
  refreshArenaNote();

  const form = el("form", {}, []);
  form.append(modeCard);
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
    arenaNote,
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
  function numberField(input: HTMLElement, fallback: number): number {
    const raw = (input as HTMLInputElement).value.trim();
    if (raw === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next: AppSettings = {
      calibrationMode: currentModeId(),
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
      gameProfile: gameSelection,
    };
    saveSettings(next);
    callbacks.onStart(next);
  });

  refreshModeSelection();
  form.append(gameHolder);
  refreshGamePanel();
  container.append(form);
}

/**
 * Renders the capture-path banner into the setup screen's own holder.
 *
 * Deliberately not a blocker: a calibration on browser capture is a real
 * calibration, and forcing a technically unnecessary setup step would be the
 * opposite of the point. It just has to be TRUE, and it has to be said before
 * the session rather than after it.
 */
export function renderSetupCaptureStatus(
  container: HTMLElement,
  status: SetupCaptureStatus,
  onRunCaptureCheck?: (() => void) | null,
): void {
  clear(container);
  if (status.tier === 1) {
    container.append(
      inlineAlert(
        "ok",
        "High-rate capture is carrying this session",
        status.caption,
      ),
    );
    return;
  }
  const alert = inlineAlert(
    status.actionable ? "warn" : "info",
    status.actionable
      ? "This session will be measured at lower confidence"
      : "This session runs on browser capture",
    `${status.caption}. ${status.rejectedBecause ?? ""}`.trim(),
  );
  container.append(alert);
  const explain = el("p", {
    class: "note",
    text:
      "Capture quality changes how much the engine will claim, not whether it works. A lower-rate stream gives coarser aim paths, so the plausible range around the recommended sensitivity comes out wider.",
  });
  container.append(explain);
  if (status.actionable && onRunCaptureCheck) {
    const actions = el("div", { class: "setup-capture-actions" });
    actions.append(
      button("Run the capture check", {
        variant: "secondary",
        icon: "pulse",
        onClick: () => onRunCaptureCheck(),
      }),
    );
    container.append(actions);
  }
}

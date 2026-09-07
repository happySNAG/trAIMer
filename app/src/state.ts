import { DEFAULT_SAFE_RANGE } from "../../src/domain/candidate.ts";
import { PREFLIGHT_THRESHOLDS } from "../../src/preflight/preflight.ts";
import {
  CALIBRATION_MODES,
  DEFAULT_CALIBRATION_MODE,
  classifyPlan,
  isCalibrationModeId,
  type CalibrationMode,
  type CalibrationModeId,
} from "../../src/experiments/sessionModes.ts";

export interface AppSettings {
  playerName: string;
  /**
   * How long a calibration should be, in evidence rather than in drills.
   *
   * Quick / Standard / Precision each fix `rounds`, `repsPerCandidate` and
   * `warmupTrials`; "custom" means the player edited those directly in the
   * advanced form and the plan no longer matches any named mode.
   */
  calibrationMode: CalibrationModeId;
  dpi: number;
  sensX: number;
  sensY: number;
  experimentSeed: number;
  rounds: number;
  repsPerCandidate: number;
  warmupTrials: number;
  yExploration: boolean;
  /** Automatic breaks between candidate blocks (always skippable). */
  autoBreaks: boolean;
  /** Length of an automatic break, seconds (5–60). */
  breakSeconds: number;
}

export const SETTINGS_KEY = "traimer-settings";

/**
 * The key builds up to and including 1.0.0-rc.6 wrote settings under, when
 * the product was called Aldo Aim Lab.
 *
 * `loadSettings()` still reads it when the new key is absent, so a player who
 * upgrades keeps their name, DPI, sensitivity, seed and break preferences.
 * The old value is left in place rather than deleted: it costs nothing, and
 * it means rolling back to rc.6 is not a data-loss event either.
 */
export const LEGACY_SETTINGS_KEY = "aldo-aim-lab-settings";

export const DEFAULT_SETTINGS: AppSettings = {
  playerName: "Aldo",
  calibrationMode: DEFAULT_CALIBRATION_MODE,
  dpi: 800,
  sensX: 7,
  sensY: 7,
  experimentSeed: 20260822,
  rounds: CALIBRATION_MODES[DEFAULT_CALIBRATION_MODE].rounds,
  repsPerCandidate:
    CALIBRATION_MODES[DEFAULT_CALIBRATION_MODE].measuredRepsPerCandidatePerRound,
  warmupTrials:
    CALIBRATION_MODES[DEFAULT_CALIBRATION_MODE].warmupTrialsPerCandidateBlock,
  yExploration: false,
  autoBreaks: true,
  breakSeconds: 10,
};

/** Shared sanitizer: every persisted settings blob goes through this. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const finiteNumber = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, v));

  const dpiRaw = finiteNumber(obj.dpi);
  const sensXRaw = finiteNumber(obj.sensX);
  const sensYRaw = finiteNumber(obj.sensY);

  const rounds =
    finiteNumber(obj.rounds) !== null
      ? clamp(Math.round(obj.rounds as number), 1, 4)
      : DEFAULT_SETTINGS.rounds;
  const repsPerCandidate =
    finiteNumber(obj.repsPerCandidate) !== null
      ? clamp(Math.round(obj.repsPerCandidate as number), 3, 20)
      : DEFAULT_SETTINGS.repsPerCandidate;
  const warmupTrials =
    finiteNumber(obj.warmupTrials) !== null
      ? clamp(Math.round(obj.warmupTrials as number), 0, 5)
      : DEFAULT_SETTINGS.warmupTrials;

  // The mode and the three plan numbers must never disagree. A stored blob
  // from before modes existed (or one whose advanced fields were edited by
  // hand) is classified from the plan it actually describes, so a session
  // labelled "Standard" is always the Standard plan.
  const plan = { rounds, measuredRepsPerCandidatePerRound: repsPerCandidate, warmupTrialsPerCandidateBlock: warmupTrials };
  const storedMode = isCalibrationModeId(obj.calibrationMode)
    ? obj.calibrationMode
    : null;
  const derivedMode = classifyPlan(plan);
  const calibrationMode: CalibrationModeId =
    storedMode !== null && storedMode !== "custom" && storedMode === derivedMode
      ? storedMode
      : derivedMode;
  const resolved: CalibrationMode | null =
    calibrationMode === "custom" ? null : CALIBRATION_MODES[calibrationMode];

  return {
    calibrationMode,
    // Names render as textContent everywhere; cap length so even a hostile
    // blob can only ever produce an oversized-but-inert label.
    playerName:
      typeof obj.playerName === "string"
        ? obj.playerName.slice(0, 64)
        : DEFAULT_SETTINGS.playerName,
    dpi:
      dpiRaw !== null
        ? clamp(Math.round(dpiRaw), PREFLIGHT_THRESHOLDS.minPlausibleDpi, PREFLIGHT_THRESHOLDS.maxPlausibleDpi)
        : DEFAULT_SETTINGS.dpi,
    sensX:
      sensXRaw !== null
        ? clamp(sensXRaw, DEFAULT_SAFE_RANGE.minSensX, DEFAULT_SAFE_RANGE.maxSensX)
        : DEFAULT_SETTINGS.sensX,
    sensY:
      sensYRaw !== null
        ? clamp(sensYRaw, DEFAULT_SAFE_RANGE.minSensY, DEFAULT_SAFE_RANGE.maxSensY)
        : DEFAULT_SETTINGS.sensY,
    experimentSeed:
      finiteNumber(obj.experimentSeed) !== null
        ? Math.abs(Math.trunc(obj.experimentSeed as number)) % 0xffffffff
        : DEFAULT_SETTINGS.experimentSeed,
    rounds: resolved?.rounds ?? rounds,
    repsPerCandidate:
      resolved?.measuredRepsPerCandidatePerRound ?? repsPerCandidate,
    warmupTrials: resolved?.warmupTrialsPerCandidateBlock ?? warmupTrials,
    yExploration: obj.yExploration === true,
    // Missing → default ON: a stored blob from before this setting existed
    // must keep the documented protocol, not silently drop its breaks.
    autoBreaks: obj.autoBreaks === undefined ? DEFAULT_SETTINGS.autoBreaks : obj.autoBreaks === true,
    breakSeconds:
      finiteNumber(obj.breakSeconds) !== null
        ? clamp(Math.round(obj.breakSeconds as number), 5, 60)
        : DEFAULT_SETTINGS.breakSeconds,
  };
}

/**
 * Applies a named mode to a settings object, or leaves the plan untouched for
 * "custom". The three plan numbers are the ONLY thing a mode changes.
 */
export function withCalibrationMode(
  settings: AppSettings,
  modeId: CalibrationModeId,
): AppSettings {
  if (modeId === "custom") return { ...settings, calibrationMode: "custom" };
  const mode: CalibrationMode = CALIBRATION_MODES[modeId];
  return {
    ...settings,
    calibrationMode: modeId,
    rounds: mode.rounds,
    repsPerCandidate: mode.measuredRepsPerCandidatePerRound,
    warmupTrials: mode.warmupTrialsPerCandidateBlock,
  };
}

/** The mode object these settings describe, or null when the plan is custom. */
export function resolveCalibrationMode(
  settings: AppSettings,
): CalibrationMode | null {
  const id = classifyPlan({
    rounds: settings.rounds,
    measuredRepsPerCandidatePerRound: settings.repsPerCandidate,
    warmupTrialsPerCandidateBlock: settings.warmupTrials,
  });
  return id === "custom" ? null : CALIBRATION_MODES[id];
}

export function loadSettings(): AppSettings {
  try {
    // Current key first, then the pre-rename key. Everything still goes
    // through sanitizeSettings(), so a stale or hostile legacy blob is
    // clamped exactly like a current one.
    const raw =
      localStorage.getItem(SETTINGS_KEY) ??
      localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
}

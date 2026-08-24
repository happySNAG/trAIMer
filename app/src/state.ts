import { DEFAULT_SAFE_RANGE } from "../../src/domain/candidate.ts";
import { PREFLIGHT_THRESHOLDS } from "../../src/preflight/preflight.ts";

export interface AppSettings {
  playerName: string;
  dpi: number;
  sensX: number;
  sensY: number;
  experimentSeed: number;
  rounds: number;
  repsPerCandidate: number;
  warmupTrials: number;
  yExploration: boolean;
}

const SETTINGS_KEY = "aldo-aim-lab-settings";

export const DEFAULT_SETTINGS: AppSettings = {
  playerName: "Aldo",
  dpi: 800,
  sensX: 7,
  sensY: 7,
  experimentSeed: 20260822,
  rounds: 2,
  repsPerCandidate: 8,
  warmupTrials: 2,
  yExploration: false,
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

  return {
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
    rounds:
      finiteNumber(obj.rounds) !== null
        ? clamp(Math.round(obj.rounds as number), 1, 4)
        : DEFAULT_SETTINGS.rounds,
    repsPerCandidate:
      finiteNumber(obj.repsPerCandidate) !== null
        ? clamp(Math.round(obj.repsPerCandidate as number), 3, 20)
        : DEFAULT_SETTINGS.repsPerCandidate,
    warmupTrials:
      finiteNumber(obj.warmupTrials) !== null
        ? clamp(Math.round(obj.warmupTrials as number), 0, 5)
        : DEFAULT_SETTINGS.warmupTrials,
    yExploration: obj.yExploration === true,
  };
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
}

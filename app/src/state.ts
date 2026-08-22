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

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

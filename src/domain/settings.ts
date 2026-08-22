export interface SensitivityConfiguration {
  sensX: number;
  sensY: number;
}

export interface FortniteSettings {
  sensitivity: SensitivityConfiguration;
  targetingSensitivity?: number;
  scopeSensitivity?: number;
  buildModeSensitivity?: number;
  editModeSensitivity?: number;
  mouseSensitivityUnit: "fortnite-percent";
}

export function equalXy(sens: number): SensitivityConfiguration {
  return { sensX: sens, sensY: sens };
}

export const ALDO_BASELINE_SETTINGS: FortniteSettings = {
  sensitivity: equalXy(7.0),
  mouseSensitivityUnit: "fortnite-percent",
};

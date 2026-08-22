import type { MouseConfigId, PlayerId } from "./ids.ts";

export interface MouseConfiguration {
  id: MouseConfigId;
  dpi: number;
  pollingRateHz: number;
  model?: string;
}

export type SensitivityPreference = "low" | "medium" | "high" | "unknown";

export interface PlayerProfile {
  id: PlayerId;
  displayName: string;
  game: "fortnite";
  mouseConfigurationId: MouseConfigId;
  sensitivityPreference: SensitivityPreference;
  notes?: string;
}

export const DEFAULT_MOUSE_CONFIGURATION: MouseConfiguration = {
  id: "mouse-aldo-logitech-lightspeed",
  dpi: 800,
  pollingRateHz: 1000,
  model: "Logitech Lightspeed wireless",
};

export const ALDO_INITIAL_PROFILE: PlayerProfile = {
  id: "player-aldo",
  displayName: "Aldo",
  game: "fortnite",
  mouseConfigurationId: DEFAULT_MOUSE_CONFIGURATION.id,
  sensitivityPreference: "medium",
};

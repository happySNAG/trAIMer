/**
 * THE list of public game profiles.
 *
 * Adding a game is: one file under `src/games/profiles/`, one entry here. The
 * registry validates everything on load and refuses duplicate ids, so a new
 * profile can break its own conversion but never another game's.
 *
 * Order here is the order the game picker shows (Game Profile Pass 2,
 * requirement 8): the five named games, then the generic/raw control.
 */

import type { GameProfile } from "../profileSchema.ts";
import { GENERIC_RAW_PROFILE } from "./generic.ts";
import { FORTNITE_PROFILE } from "./fortnite.ts";
import { VALORANT_PROFILE } from "./valorant.ts";
import { COUNTER_STRIKE_2_PROFILE } from "./counterStrike2.ts";
import { APEX_LEGENDS_PROFILE } from "./apexLegends.ts";
import { CALL_OF_DUTY_WARZONE_PROFILE } from "./callOfDutyWarzone.ts";

export { GENERIC_RAW_PROFILE, GENERIC_PROFILE_ID, GENERIC_DEGREES_PER_COUNT_AT_ONE } from "./generic.ts";
export { FORTNITE_PROFILE, FORTNITE_PROFILE_ID, FORTNITE_DEGREES_PER_COUNT_PER_PERCENT } from "./fortnite.ts";
export {
  VALORANT_PROFILE,
  VALORANT_PROFILE_ID,
  VALORANT_DEGREES_PER_COUNT_AT_ONE,
  VALORANT_HIPFIRE_FOV_DEGREES,
} from "./valorant.ts";
export {
  COUNTER_STRIKE_2_PROFILE,
  CS2_PROFILE_ID,
  CS2_DEGREES_PER_COUNT_AT_ONE,
  CS2_HIPFIRE_FOV_DEGREES,
  CS2_AWP_FIRST_ZOOM_FOV_DEGREES,
} from "./counterStrike2.ts";
export { APEX_LEGENDS_PROFILE, APEX_PROFILE_ID, APEX_DEGREES_PER_COUNT_AT_ONE } from "./apexLegends.ts";
export {
  CALL_OF_DUTY_WARZONE_PROFILE,
  COD_WARZONE_PROFILE_ID,
  COD_DEGREES_PER_COUNT_AT_ONE,
  COD_DEFAULT_MONITOR_DISTANCE_COEFFICIENT,
} from "./callOfDutyWarzone.ts";

export const PUBLIC_GAME_PROFILES: readonly GameProfile[] = [
  FORTNITE_PROFILE,
  VALORANT_PROFILE,
  COUNTER_STRIKE_2_PROFILE,
  APEX_LEGENDS_PROFILE,
  CALL_OF_DUTY_WARZONE_PROFILE,
  GENERIC_RAW_PROFILE,
];

/** The five named games this pass ships, in picker order. */
export const NAMED_GAME_PROFILE_IDS: readonly string[] = [
  FORTNITE_PROFILE.id,
  VALORANT_PROFILE.id,
  COUNTER_STRIKE_2_PROFILE.id,
  APEX_LEGENDS_PROFILE.id,
  CALL_OF_DUTY_WARZONE_PROFILE.id,
];

/**
 * THE list of public game profiles.
 *
 * Adding a game is: one file under `src/games/profiles/`, one entry here. The
 * registry validates everything on load and refuses duplicate ids, so a new
 * profile can break its own conversion but never another game's.
 *
 * Order here is the order the game picker shows (Game Profile Pass 3,
 * requirement 9): the named games alphabetically, then the generic/raw
 * control last.
 */

import type { GameProfile } from "../profileSchema.ts";
import { GENERIC_RAW_PROFILE } from "./generic.ts";
import { FORTNITE_PROFILE } from "./fortnite.ts";
import { VALORANT_PROFILE } from "./valorant.ts";
import { COUNTER_STRIKE_2_PROFILE } from "./counterStrike2.ts";
import { APEX_LEGENDS_PROFILE } from "./apexLegends.ts";
import { CALL_OF_DUTY_WARZONE_PROFILE } from "./callOfDutyWarzone.ts";
import { OVERWATCH_2_PROFILE } from "./overwatch2.ts";
import { RAINBOW_SIX_SIEGE_PROFILE } from "./rainbowSixSiege.ts";
import { MARVEL_RIVALS_PROFILE } from "./marvelRivals.ts";
import { PUBG_PROFILE } from "./pubg.ts";
import { THE_FINALS_PROFILE } from "./theFinals.ts";
import { BATTLEFIELD_6_PROFILE } from "./battlefield6.ts";

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
export { OVERWATCH_2_PROFILE, OVERWATCH_PROFILE_ID, OVERWATCH_DEGREES_PER_COUNT_AT_ONE } from "./overwatch2.ts";
export {
  RAINBOW_SIX_SIEGE_PROFILE,
  SIEGE_PROFILE_ID,
  SIEGE_DEGREES_PER_COUNT_AT_ONE,
  SIEGE_NEUTRAL_ADS_VALUE,
} from "./rainbowSixSiege.ts";
export {
  MARVEL_RIVALS_PROFILE,
  MARVEL_RIVALS_PROFILE_ID,
  MARVEL_RIVALS_DEGREES_PER_COUNT_AT_ONE,
} from "./marvelRivals.ts";
export {
  PUBG_PROFILE,
  PUBG_PROFILE_ID,
  PUBG_DEGREES_PER_COUNT_AT_ONE,
  PUBG_REFERENCE_FOV_DEGREES,
} from "./pubg.ts";
export { THE_FINALS_PROFILE, THE_FINALS_PROFILE_ID, THE_FINALS_DEGREES_PER_COUNT_AT_ONE } from "./theFinals.ts";
export {
  BATTLEFIELD_6_PROFILE,
  BATTLEFIELD_6_PROFILE_ID,
  BATTLEFIELD_6_DEGREES_PER_COUNT_AT_ONE,
  BATTLEFIELD_6_DEFAULT_COEFFICIENT,
} from "./battlefield6.ts";

/** The named games, alphabetically by display name — the picker's order. */
const NAMED_GAME_PROFILES: readonly GameProfile[] = [
  APEX_LEGENDS_PROFILE,
  BATTLEFIELD_6_PROFILE,
  CALL_OF_DUTY_WARZONE_PROFILE,
  COUNTER_STRIKE_2_PROFILE,
  FORTNITE_PROFILE,
  MARVEL_RIVALS_PROFILE,
  OVERWATCH_2_PROFILE,
  PUBG_PROFILE,
  RAINBOW_SIX_SIEGE_PROFILE,
  THE_FINALS_PROFILE,
  VALORANT_PROFILE,
];

export const PUBLIC_GAME_PROFILES: readonly GameProfile[] = [
  ...NAMED_GAME_PROFILES,
  GENERIC_RAW_PROFILE,
];

/** The named games in picker order. */
export const NAMED_GAME_PROFILE_IDS: readonly string[] = NAMED_GAME_PROFILES.map((p) => p.id);

/** The five profiles Pass 2 shipped, in that pass's order. */
export const PASS_2_GAME_PROFILE_IDS: readonly string[] = [
  FORTNITE_PROFILE.id,
  VALORANT_PROFILE.id,
  COUNTER_STRIKE_2_PROFILE.id,
  APEX_LEGENDS_PROFILE.id,
  CALL_OF_DUTY_WARZONE_PROFILE.id,
];

/** The six profiles Pass 3 added. */
export const PASS_3_GAME_PROFILE_IDS: readonly string[] = [
  OVERWATCH_2_PROFILE.id,
  RAINBOW_SIX_SIEGE_PROFILE.id,
  MARVEL_RIVALS_PROFILE.id,
  PUBG_PROFILE.id,
  THE_FINALS_PROFILE.id,
  BATTLEFIELD_6_PROFILE.id,
];

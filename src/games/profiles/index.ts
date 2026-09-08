/**
 * THE list of public game profiles.
 *
 * Adding a game is: one file under `src/games/profiles/`, one entry here. The
 * registry validates everything on load and refuses duplicate ids, so a new
 * profile can break its own conversion but never another game's.
 *
 * Game Profile Pass 1 ships exactly one public profile — the generic/raw
 * control (requirement 27). The named-game set arrives in later passes.
 */

import type { GameProfile } from "../profileSchema.ts";
import { GENERIC_RAW_PROFILE } from "./generic.ts";

export { GENERIC_RAW_PROFILE, GENERIC_PROFILE_ID, GENERIC_DEGREES_PER_COUNT_AT_ONE } from "./generic.ts";

export const PUBLIC_GAME_PROFILES: readonly GameProfile[] = [GENERIC_RAW_PROFILE];

/**
 * The game-profile and sensitivity-conversion layer.
 *
 * This is a TRANSLATION layer. It reads what the measurement engine produced
 * and turns it into numbers a player can type into a specific game. Nothing
 * here is ever an input to how aim is measured: the engine core stays
 * game-agnostic (Game Profile Pass 1, requirement 1).
 *
 * See docs/GAME-PROFILES.md for the architecture and for how to add a profile.
 */

export * from "./canonical.ts";
export * from "./rounding.ts";
export * from "./fov.ts";
export * from "./matching.ts";
export * from "./profileSchema.ts";
export * from "./validate.ts";
export * from "./registry.ts";
export * from "./convert.ts";
export * from "./measurement.ts";
export * from "./export.ts";
export * from "./selection.ts";
export * from "./profiles/index.ts";

import { GameProfileRegistry } from "./registry.ts";
import { PUBLIC_GAME_PROFILES } from "./profiles/index.ts";

/**
 * THE registry of public profiles.
 *
 * Built at module load and fail-closed: a malformed profile throws here, which
 * makes it a startup failure and a red test rather than a wrong number on a
 * player's screen (requirement 9).
 */
export const GAME_PROFILE_REGISTRY = GameProfileRegistry.create(PUBLIC_GAME_PROFILES);

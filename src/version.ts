/**
 * Explicit application and engine version metadata (V1 public release).
 *
 * Every persisted artifact that records a decision (human session, optimizer
 * run, recommendation, export bundle, audit data, capture self-test) embeds
 * these strings so any historical result can be traced to the exact code that
 * produced it.
 *
 * The public release is identified as 1.0.0. It carries the same engine,
 * profiles, desktop shell, helper and installer pipeline as 1.0.0-rc.13;
 * the version number, the release notes and the repository's public face
 * are what changed. The one item that kept rc.13 a candidate — a person
 * completing a calibration on real Windows hardware on a build since rc.9,
 * when the arena first applied the blinded candidate sensitivity — was done
 * on the installed rc.13 build on 2026-09-08 (docs/RELEASE.md, "Hardware
 * validation record"). The release candidates that led here:
 * rc.13 (Game Profile
 * Campaign Pass 5 of 5: public-release hardening. No profile formula
 * changed. Adds the public README, support matrix, license, contributing
 * guide, profile-proposal template, issue templates, security and privacy
 * documents, release notes and changelog; makes an experimental profile's
 * status visible in the picker list and above its inputs; reorders the Aim
 * Test screen into the order a first-time player needs; tells the player on
 * the results screen to change the setting in the game themselves; turns
 * provenance URLs into links; and adds three installed-app gates to CI — an
 * end-to-end calibration on the installed build, an in-place upgrade from
 * rc.12 with the earlier session preserved, and a silent uninstall that
 * keeps user data followed by a reinstall that finds it. 1.0.0 was not cut
 * because no human has yet completed a calibration on real hardware on any
 * build since rc.9, when the arena first applied the blinded candidate
 * sensitivity; see docs/RELEASE.md.)
 * rc.12 (Game Profile
 * Campaign Pass 4 of 5: no new games, but every one of the twelve public
 * profiles re-researched from scratch and treated as untrusted until
 * re-confirmed from outside this repository. Eight base constants were
 * independently re-derived from a published cm/360 band that names no game
 * internals; Counter-Strike 2's and Valorant's zoom models were shown to be
 * algebraically identical to independently published formulas and to
 * reproduce their published constants to eight or nine significant figures.
 * One real defect was corrected: Battlefield 6's stock Uniform Soldier
 * Aiming coefficient is 133.3%, not the 177.8% Pass 3 recorded, which had
 * made two distinct matching philosophies produce one answer. Two disputes
 * were dissolved rather than decided — Siege's "rival" 0.00223 yaw is a
 * configuration multiplier, not a yaw, and Overwatch's 37.89 / 49.46 are the
 * tangent and angle ratios of the same scoped FOV. PUBG stays experimental
 * because Pass 4 tried and failed to confirm its scale is linear. Adds
 * source-derived golden tests, a rounding sweep over every field of every
 * profile, a full cross-profile equivalence audit, and a fail-closed warning
 * when a FOV-scaled profile is converted without a FOV.
 * See docs/GAME-PROFILES.md.)
 * rc.10 (Game Profile Campaign
 * Pass 2 of 5: the first five public game profiles — Fortnite, Valorant,
 * Counter-Strike 2, Apex Legends and Call of Duty / Warzone — on the
 * architecture rc.9 introduced, each a versioned, sourced conversion
 * definition with its hip-fire model, X/Y model, slider grid, field of view
 * and, where a defensible model exists, its aim-down-sights / scope
 * relationship. Two zoom behaviours the real games needed were added to the
 * profile schema without changing its version: a linear field-of-view ratio
 * (Counter-Strike, Valorant) and a game-applied monitor-distance coefficient
 * (Call of Duty). Where a game's scaling could not be verified — Fortnite
 * scopes, every Apex optic — the profile says so instead of guessing. See
 * docs/GAME-PROFILES.md.)
 * rc.9 (Game Profile Campaign
 * Pass 1 of 5: the game-profile and sensitivity-conversion architecture. The
 * measurement core stays game-agnostic; a new translation layer
 * (`src/games/**`) turns a measured physical aim into the number a specific
 * FPS accepts. One canonical internal representation — degrees of view
 * rotation per centimetre of mouse travel — sits between every pair of games,
 * so no conversion is ever pairwise. Profiles are versioned data validated
 * fail-closed by a central registry, carry provenance including the game build
 * they were checked against, and report every place a game's own slider
 * granularity costs precision rather than absorbing it. One public profile
 * ships: the generic/raw control. See docs/GAME-PROFILES.md.
 *
 * rc.9 also fixes the release-blocking measurement defect that pass uncovered:
 * up to and including rc.8 the arena moved the crosshair one logical pixel per
 * mouse count for EVERY candidate it was comparing, so the blinded candidate
 * sensitivity reached the trial record, the optimizer, the results page and
 * the simulator's player model — and never the player's hand. Every human
 * calibration on rc.5-rc.8 therefore compared sensitivities that felt
 * identical, and its recommended sensitivity is not evidence about
 * sensitivity. There is now one authoritative candidate-to-reticle conversion
 * (src/sensmath/arenaGain.ts) that the simulator and the arena share, applied
 * in exactly one place, with the applied gain recorded on every session so
 * pre-fix history is marked rather than trusted or deleted. See
 * docs/ARENA-SENSITIVITY.md.)
 * rc.8 (Pass 14: measurement
 * integrity, selectable calibration length, and a player-first results page.
 * A completed real-hardware session on rc.7 threw away 43 of its 80 measured
 * drills as "broken timestamps"; the cause was that browser Pointer Lock
 * stamps a sample with the moment the input OCCURRED and delivers it a frame
 * later, while the app started a trial by reading the clock at the moment it
 * OBSERVED the trial beginning. Every capture source now declares its
 * timestamp domain and its delivery lead, the native helper answers
 * `time-sync` probes so its QueryPerformanceCounter origin can be translated
 * into the renderer clock with a proven bound, calibration length is chosen
 * as Quick / Standard / Precision against evidence targets rather than drill
 * counts, and the results page answers the player's five questions before any
 * statistic — with every statistic kept, under Advanced results. Pairing
 * between candidates also became a property of the plan rather than of luck.)
 * rc.7 (Pass 13: the product
 * is publicly named trAIMer; the first break silently ended the whole
 * calibration because a deliberate pointer-lock release was misreported as a
 * loss; the tracking drill was indistinguishable from a shooting drill; shots
 * had no game feel; and a session that stopped early returned to the main UI
 * with nothing but a count). rc.6 (Pass 12: three
 * gameplay defects from the second hardware session — the strafing target was
 * hit-tested at a stale keyframe and swept too little of the field to be
 * shootable, a click on the tracking target deleted it and left the arena
 * blank until its timer ran out, and the break screen asked for a click while
 * the arena still held the mouse). rc.5 (Pass 11: gameplay
 * fixes from the first playable hardware session — the three-target switch
 * drill is genuinely sequential with per-target windows, breaks are
 * skippable and configurable, drill draws are balanced and de-repeated, and
 * the arena has real presentation). rc.4 (Pass 10) made the core shooting
 * test startable on real Windows hardware at all — rc.3
 * installed and launched on Aldo's PC but no session could ever begin,
 * because the arena overlay swallowed the "click to lock in" click and
 * pointer-lock events were bound to the canvas instead of the document).
 * rc.1 shipped a helper "binary" that was actually the C source file, rc.2
 * kept the PowerShell launch path, and rc.3 was the first installed desktop
 * application. rc.1–rc.3 never passed hardware validation; rc.N increments
 * mark each distinct candidate until hardware validation freezes one. All component
 * versions below are frozen for that release line; see docs/RELEASE.md for
 * the full compatibility matrix describing which builds can read which
 * persisted artifacts.
 */

/**
 * Machine name embedded in every persisted artifact.
 *
 * Renamed with the product (Pass 13). Artifacts written by earlier builds
 * carry `aldo-aim-lab`; nothing compares this field for compatibility (only
 * `engineVersion` is gated), so older artifacts keep loading unchanged.
 */
export const APP_NAME = "traimer";

/** Machine name used by builds up to and including 1.0.0-rc.6. */
export const LEGACY_APP_NAME = "aldo-aim-lab";

/** THE public product name. Every user-facing surface renders exactly this. */
export const PRODUCT_NAME = "trAIMer";

/** The product tagline, shown beside the wordmark. */
export const PRODUCT_TAGLINE = "Train. Measure. Tune.";

/** Application release version for the V1 public release. */
export const APP_VERSION = "1.0.0";

/**
 * Engine contract version: bump when a persisted engine-facing data contract
 * changes shape in a way consumers must detect.
 */
export const ENGINE_VERSION = "engine-v4";

/** Optimizer implementation version (paired fit + adequacy gating + change-point). */
export const OPTIMIZER_VERSION = "optimizer-v3";

/**
 * Back-compat alias used by older call sites; identical to OPTIMIZER_VERSION.
 * Do not introduce a second optimizer version without a migration plan.
 */
export const OPTIMIZER_VERSION_V4 = OPTIMIZER_VERSION;

/**
 * Scoring-model version: dimension definitions and composite utility weights
 * (accuracy .28 / speed .14 / trackingPrecision .14 / correctionEfficiency
 * .12 / overshootControl .11 / undershootControl .11 / consistency .10).
 */
export const SCORING_MODEL_VERSION = "scoring-v1";

/**
 * Native transport protocol version. Must equal PROTOCOL_VERSION embedded in
 * native/windows/traimer_capture_helper.c — enforced by
 * tests/nativeProtocolConstants.test.ts and CI.
 */
export const NATIVE_PROTOCOL_VERSION = 1;

/**
 * Native helper implementation version expected by this build. The helper's
 * self-reported HELPER_VERSION must match exactly (fail-closed handshake).
 */
export const EXPECTED_HELPER_VERSION = "helper-1.1.0";

/**
 * The arena's candidate-sensitivity model (Pass 15).
 *
 * Persisted on every session this build records. Its PRESENCE is what
 * distinguishes a session in which the player physically experienced the
 * blinded candidate sensitivities from one on a build whose arena moved the
 * reticle one pixel per mouse count regardless of candidate. Bump it when the
 * physical model in src/sensmath/arenaGain.ts changes in a way that makes two
 * sessions' gains incomparable.
 */
export const ARENA_GAIN_MODEL_VERSION = "arena-gain-v1";

/**
 * Calibration workflow version: multi-turn reps, median/MAD robust fitting,
 * adequacy gates, staleness fingerprints.
 */
export const CALIBRATION_VERSION = "calibration-v2";

/**
 * Resume checkpoint schema version (inner payload of `session-checkpoint`).
 */
export const RESUME_SCHEMA_VERSION = 2;

export interface ReleaseMetadata {
  appName: string;
  appVersion: string;
  engineVersion: string;
  optimizerVersion: string;
  schemaVersion: number;
}

export interface FullReleaseMetadata extends ReleaseMetadata {
  arenaGainModelVersion: string;
  scoringModelVersion: string;
  nativeProtocolVersion: number;
  expectedHelperVersion: string;
  calibrationVersion: string;
  resumeSchemaVersion: number;
}

let currentSchemaVersion = 1;

/** Registers the active schema version so metadata can carry it. */
export function setActiveSchemaVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`invalid schema version: ${version}`);
  }
  currentSchemaVersion = version;
}

export function releaseMetadata(): ReleaseMetadata {
  return {
    appName: APP_NAME,
    appVersion: APP_VERSION,
    engineVersion: ENGINE_VERSION,
    optimizerVersion: OPTIMIZER_VERSION,
    schemaVersion: currentSchemaVersion,
  };
}

export function fullReleaseMetadata(): FullReleaseMetadata {
  return {
    ...releaseMetadata(),
    arenaGainModelVersion: ARENA_GAIN_MODEL_VERSION,
    scoringModelVersion: SCORING_MODEL_VERSION,
    nativeProtocolVersion: NATIVE_PROTOCOL_VERSION,
    expectedHelperVersion: EXPECTED_HELPER_VERSION,
    calibrationVersion: CALIBRATION_VERSION,
    resumeSchemaVersion: RESUME_SCHEMA_VERSION,
  };
}

/**
 * Compatibility check used at load time: an artifact produced by a DIFFERENT
 * engine version must be rejected loudly unless it predates version tagging
 * (null/undefined). We have no cross-engine migration path, so strict
 * equality is the honest contract.
 */
export function checkEngineCompatibility(
  artifactEngineVersion: string | null | undefined,
): { compatible: boolean; reason: string | null } {
  if (artifactEngineVersion === null || artifactEngineVersion === undefined) {
    return { compatible: true, reason: null };
  }
  if (artifactEngineVersion === ENGINE_VERSION) {
    return { compatible: true, reason: null };
  }
  return {
    compatible: false,
    reason: `artifact was produced by ${artifactEngineVersion} but this build is ${ENGINE_VERSION}`,
  };
}

/**
 * Compatibility matrix entry describing which artifact generations this
 * build can read. Used by preflight and by docs/RELEASE.md (the prose copy
 * of this table is generated from these constants at release time).
 */
export interface ArtifactCompatibility {
  /** Envelope kind or artifact family. */
  artifact: string;
  /** Schema/inner versions readable by THIS build. */
  readableVersions: string;
  /** What happens to artifacts outside those versions. */
  olderPolicy: "migrated" | "rejected" | "flagged-stale";
  newerPolicy: "rejected" | "flagged";
}

export const ARTIFACT_COMPATIBILITY_MATRIX: readonly ArtifactCompatibility[] = [
  { artifact: "trial-record / experiment-definition / recommendation (envelope)", readableVersions: "schemaVersion 1", olderPolicy: "migrated", newerPolicy: "rejected" },
  { artifact: "resume checkpoint (session-checkpoint)", readableVersions: `resume schemaVersion ${RESUME_SCHEMA_VERSION}`, olderPolicy: "rejected", newerPolicy: "rejected" },
  { artifact: "session bundle import", readableVersions: "schemaVersion <= 1", olderPolicy: "migrated", newerPolicy: "rejected" },
  { artifact: "calibration record", readableVersions: "schemaVersion 1 (optional Pass-4 fields)", olderPolicy: "flagged-stale", newerPolicy: "rejected" },
  { artifact: "engine-tagged artifacts", readableVersions: `${ENGINE_VERSION} or untagged`, olderPolicy: "rejected", newerPolicy: "rejected" },
  { artifact: "human-session arena gain (candidate sensitivity actually applied)", readableVersions: `${ARENA_GAIN_MODEL_VERSION}; ABSENT on every session recorded before 1.0.0-rc.9`, olderPolicy: "flagged-stale", newerPolicy: "flagged" },
  { artifact: "native transport frames", readableVersions: `protocolVersion ${NATIVE_PROTOCOL_VERSION}`, olderPolicy: "rejected", newerPolicy: "rejected" },
];

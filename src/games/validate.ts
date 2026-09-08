/**
 * Fail-closed profile validation (Game Profile Pass 1, requirement 9).
 *
 * A malformed profile must never produce a sensitivity recommendation. The
 * registry runs this on every profile it loads and refuses to build if any
 * profile has an error, so a bad profile is a startup failure and a failing
 * test — never a wrong number on a player's screen.
 *
 * Severity split:
 *
 * - `error`   — the profile cannot be used at all. Registry construction fails.
 * - `warning` — the profile is usable but incomplete; surfaced to the author
 *               and, where it affects trust, to the player.
 */

import { fovWithinLimits, type FovModel } from "./fov.ts";
import { ZOOM_MATCH_KINDS, type ZoomMatchMethod } from "./matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  PROFILE_STATUSES,
  zoomLevelsOf,
  type GameProfile,
  type SensitivityFieldSpec,
  type SensitivityModel,
} from "./profileSchema.ts";
import type { ValueEntrySpec } from "./rounding.ts";

export type IssueSeverity = "error" | "warning";

export interface ProfileIssue {
  readonly severity: IssueSeverity;
  /** Dotted path to the offending field, e.g. `zoom.zooms[1].setting.entry`. */
  readonly path: string;
  readonly message: string;
}

export interface ProfileValidation {
  readonly profileId: string;
  readonly valid: boolean;
  readonly issues: readonly ProfileIssue[];
}

export class InvalidGameProfileError extends Error {
  readonly issues: readonly ProfileIssue[];
  constructor(profileId: string, issues: readonly ProfileIssue[]) {
    super(
      `game profile "${profileId}" is invalid: ` +
        issues
          .filter((i) => i.severity === "error")
          .map((i) => `${i.path}: ${i.message}`)
          .join("; "),
    );
    this.name = "InvalidGameProfileError";
    this.issues = issues;
  }
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkEntry(
  entry: ValueEntrySpec | undefined,
  path: string,
  issues: ProfileIssue[],
): void {
  if (!entry || typeof entry !== "object") {
    issues.push({ severity: "error", path, message: "value-entry spec is missing" });
    return;
  }
  if (!isFiniteNumber(entry.min) || !isFiniteNumber(entry.max)) {
    issues.push({ severity: "error", path, message: "min and max must be finite numbers" });
    return;
  }
  if (entry.min >= entry.max) {
    issues.push({
      severity: "error",
      path,
      message: `impossible sensitivity range: min ${entry.min} is not below max ${entry.max}`,
    });
  }
  if (entry.min < 0 || (entry.min === 0 && entry.allowZero !== true)) {
    issues.push({
      severity: "error",
      path,
      message: `min must be positive (got ${entry.min}); a zero or negative sensitivity has no physical meaning`,
    });
  }
  if (entry.step !== null) {
    if (!isFiniteNumber(entry.step) || entry.step <= 0) {
      issues.push({
        severity: "error",
        path: `${path}.step`,
        message: `invalid step size ${entry.step}: must be a positive number or null for a continuous control`,
      });
    } else if (entry.step > entry.max - entry.min) {
      issues.push({
        severity: "error",
        path: `${path}.step`,
        message: `step ${entry.step} is larger than the whole range ${entry.min}–${entry.max}`,
      });
    }
  }
  if (
    !Number.isInteger(entry.uiDecimals) ||
    entry.uiDecimals < 0 ||
    entry.uiDecimals > 10
  ) {
    issues.push({
      severity: "error",
      path: `${path}.uiDecimals`,
      message: `unsupported decimal precision ${entry.uiDecimals} (expected an integer 0–10)`,
    });
  }
  if (entry.configDecimals !== null) {
    if (
      !Number.isInteger(entry.configDecimals) ||
      entry.configDecimals < 0 ||
      entry.configDecimals > 12
    ) {
      issues.push({
        severity: "error",
        path: `${path}.configDecimals`,
        message: `unsupported config precision ${entry.configDecimals} (expected an integer 0–12 or null)`,
      });
    } else if (entry.configDecimals < entry.uiDecimals) {
      issues.push({
        severity: "error",
        path: `${path}.configDecimals`,
        message: `config precision ${entry.configDecimals} is coarser than the UI's ${entry.uiDecimals}; that inverts the reason the field exists`,
      });
    }
  }
  if (!["nearest", "down", "up"].includes(entry.rounding)) {
    issues.push({
      severity: "error",
      path: `${path}.rounding`,
      message: `invalid rounding rule "${String(entry.rounding)}"`,
    });
  }
  if (typeof entry.unitSuffix !== "string") {
    issues.push({
      severity: "error",
      path: `${path}.unitSuffix`,
      message: "unitSuffix must be a string (use \"\" for a bare scalar)",
    });
  }
  if (entry.step !== null && entry.step > 0) {
    const origin = entry.stepOrigin ?? entry.min;
    const gridPoints = (entry.max - origin) / entry.step;
    if (gridPoints < 1) {
      issues.push({
        severity: "error",
        path: `${path}.step`,
        message: "the step grid contains fewer than two enterable values",
      });
    }
  }
}

function checkField(
  field: SensitivityFieldSpec | null | undefined,
  path: string,
  issues: ProfileIssue[],
  required: boolean,
): void {
  if (!field) {
    if (required) {
      issues.push({ severity: "error", path, message: "field spec is missing" });
    }
    return;
  }
  if (typeof field.field !== "string" || field.field.length === 0) {
    issues.push({ severity: "error", path: `${path}.field`, message: "field name is required" });
  }
  if (typeof field.label !== "string" || field.label.length === 0) {
    issues.push({ severity: "error", path: `${path}.label`, message: "player-facing label is required" });
  }
  checkEntry(field.entry, `${path}.entry`, issues);
}

function checkSensitivityModel(
  model: SensitivityModel | undefined,
  issues: ProfileIssue[],
): void {
  if (!model || typeof model !== "object") {
    issues.push({ severity: "error", path: "sensitivityModel", message: "sensitivity model is missing" });
    return;
  }
  switch (model.kind) {
    case "linear-yaw": {
      if (!isFiniteNumber(model.yawDegreesPerCountAtOne) || model.yawDegreesPerCountAtOne <= 0) {
        issues.push({
          severity: "error",
          path: "sensitivityModel.yawDegreesPerCountAtOne",
          message: `impossible yaw constant ${model.yawDegreesPerCountAtOne}: must be positive and finite`,
        });
      } else if (model.yawDegreesPerCountAtOne >= 90) {
        issues.push({
          severity: "error",
          path: "sensitivityModel.yawDegreesPerCountAtOne",
          message: `implausible yaw constant ${model.yawDegreesPerCountAtOne} deg/count at sensitivity 1.0`,
        });
      }
      if (
        model.pitchDegreesPerCountAtOne !== null &&
        (!isFiniteNumber(model.pitchDegreesPerCountAtOne) ||
          model.pitchDegreesPerCountAtOne <= 0 ||
          model.pitchDegreesPerCountAtOne >= 90)
      ) {
        issues.push({
          severity: "error",
          path: "sensitivityModel.pitchDegreesPerCountAtOne",
          message: `impossible pitch constant ${model.pitchDegreesPerCountAtOne}`,
        });
      }
      break;
    }
    case "power-law-yaw": {
      if (!isFiniteNumber(model.yawCoefficient) || model.yawCoefficient <= 0) {
        issues.push({
          severity: "error",
          path: "sensitivityModel.yawCoefficient",
          message: `impossible yaw coefficient ${model.yawCoefficient}`,
        });
      }
      if (!isFiniteNumber(model.yawExponent) || model.yawExponent <= 0) {
        issues.push({
          severity: "error",
          path: "sensitivityModel.yawExponent",
          message: `exponent ${model.yawExponent} must be positive; a non-positive exponent makes the model non-invertible or inverted`,
        });
      }
      if (
        model.pitchCoefficient !== null &&
        (!isFiniteNumber(model.pitchCoefficient) || model.pitchCoefficient <= 0)
      ) {
        issues.push({
          severity: "error",
          path: "sensitivityModel.pitchCoefficient",
          message: `impossible pitch coefficient ${model.pitchCoefficient}`,
        });
      }
      if (
        model.pitchExponent !== null &&
        (!isFiniteNumber(model.pitchExponent) || model.pitchExponent <= 0)
      ) {
        issues.push({
          severity: "error",
          path: "sensitivityModel.pitchExponent",
          message: `impossible pitch exponent ${model.pitchExponent}`,
        });
      }
      break;
    }
    default:
      issues.push({
        severity: "error",
        path: "sensitivityModel.kind",
        message: `unknown conversion type "${String((model as { kind?: unknown }).kind)}"`,
      });
  }
}

function checkFov(model: FovModel | undefined, path: string, issues: ProfileIssue[]): void {
  if (!model || typeof model !== "object") {
    issues.push({ severity: "error", path, message: "fov model is missing (use {kind:\"none\"})" });
    return;
  }
  const axes = ["horizontal", "horizontal-at-4-3", "horizontal-at-16-9", "vertical"];
  if (model.kind === "fixed") {
    if (!axes.includes(model.axis)) {
      issues.push({ severity: "error", path: `${path}.axis`, message: `unknown fov axis "${model.axis}"` });
    }
    if (!isFiniteNumber(model.degrees) || model.degrees <= 0 || model.degrees >= 180) {
      issues.push({
        severity: "error",
        path: `${path}.degrees`,
        message: `invalid fov range: ${model.degrees} is outside (0, 180)`,
      });
    }
  } else if (model.kind === "configurable") {
    if (!axes.includes(model.axis)) {
      issues.push({ severity: "error", path: `${path}.axis`, message: `unknown fov axis "${model.axis}"` });
    }
    for (const [name, value] of [
      ["minDegrees", model.minDegrees],
      ["maxDegrees", model.maxDegrees],
      ["defaultDegrees", model.defaultDegrees],
    ] as const) {
      if (!isFiniteNumber(value) || value <= 0 || value >= 180) {
        issues.push({
          severity: "error",
          path: `${path}.${name}`,
          message: `invalid fov range: ${value} is outside (0, 180)`,
        });
      }
    }
    if (model.minDegrees >= model.maxDegrees) {
      issues.push({
        severity: "error",
        path: `${path}.minDegrees`,
        message: `invalid fov range: min ${model.minDegrees} is not below max ${model.maxDegrees}`,
      });
    } else if (!fovWithinLimits(model, model.defaultDegrees)) {
      issues.push({
        severity: "error",
        path: `${path}.defaultDegrees`,
        message: `default fov ${model.defaultDegrees} is outside the declared limits ${model.minDegrees}–${model.maxDegrees}`,
      });
    }
    if (
      model.stepDegrees !== null &&
      (!isFiniteNumber(model.stepDegrees) || model.stepDegrees <= 0)
    ) {
      issues.push({
        severity: "error",
        path: `${path}.stepDegrees`,
        message: `invalid step size ${model.stepDegrees}`,
      });
    }
  } else if (model.kind !== "none") {
    issues.push({
      severity: "error",
      path: `${path}.kind`,
      message: `unknown fov model "${String((model as { kind?: unknown }).kind)}"`,
    });
  }
}

function checkMatching(
  method: ZoomMatchMethod | undefined,
  path: string,
  issues: ProfileIssue[],
): void {
  if (!method || typeof method !== "object") {
    issues.push({ severity: "error", path, message: "matching method is missing" });
    return;
  }
  if (!ZOOM_MATCH_KINDS.includes(method.kind)) {
    issues.push({
      severity: "error",
      path: `${path}.kind`,
      message: `unknown conversion type "${String(method.kind)}"`,
    });
    return;
  }
  if (method.kind === "monitor-distance") {
    const c = method.coefficient;
    if (c === undefined || !isFiniteNumber(c) || c < 0 || c > 1) {
      issues.push({
        severity: "error",
        path: `${path}.coefficient`,
        message: `monitor-distance coefficient must be within [0, 1] (got ${String(c)})`,
      });
    }
    if (method.axis !== undefined && method.axis !== "horizontal" && method.axis !== "vertical") {
      issues.push({
        severity: "error",
        path: `${path}.axis`,
        message: `unknown matching axis "${String(method.axis)}"`,
      });
    }
  }
}

function checkSource(profile: GameProfile, issues: ProfileIssue[]): void {
  const src = profile.source;
  const isPublic = profile.visibility === "public";
  const claimsVerification =
    profile.status === "verified" || profile.status === "partially-verified";
  if (!src || typeof src !== "object") {
    issues.push({ severity: "error", path: "source", message: "source metadata is missing" });
    return;
  }
  if (typeof src.title !== "string" || src.title.length === 0) {
    issues.push({ severity: "error", path: "source.title", message: "source title is required" });
  }
  const types = [
    "official-documentation",
    "in-game-measurement",
    "first-party-config-file",
    "community-reference",
    "unit-definition",
  ];
  if (!types.includes(src.type)) {
    issues.push({ severity: "error", path: "source.type", message: `unknown source type "${String(src.type)}"` });
  }
  for (const [name, value] of [
    ["verifiedAtIso", src.verifiedAtIso],
    ["lastReviewedAtIso", src.lastReviewedAtIso],
  ] as const) {
    if (typeof value !== "string" || !ISO_PATTERN.test(value)) {
      issues.push({
        severity: "error",
        path: `source.${name}`,
        message: `"${String(value)}" is not an ISO date`,
      });
    }
  }
  if (
    typeof src.verifiedAtIso === "string" &&
    typeof src.lastReviewedAtIso === "string" &&
    ISO_PATTERN.test(src.verifiedAtIso) &&
    ISO_PATTERN.test(src.lastReviewedAtIso) &&
    Date.parse(src.lastReviewedAtIso) < Date.parse(src.verifiedAtIso)
  ) {
    issues.push({
      severity: "error",
      path: "source.lastReviewedAtIso",
      message: "a profile cannot have been reviewed before it was verified",
    });
  }
  if (!["exact", "high", "moderate", "low"].includes(src.confidence)) {
    issues.push({
      severity: "error",
      path: "source.confidence",
      message: `unknown confidence level "${String(src.confidence)}"`,
    });
  }
  if (!Array.isArray(src.uncertaintyNotes)) {
    issues.push({
      severity: "error",
      path: "source.uncertaintyNotes",
      message: "uncertaintyNotes must be an array (empty is fine)",
    });
  }
  // A profile that CLAIMS verification and is shown to players must say what
  // build it was verified against. Anything less is a stale formula waiting
  // to be presented as a fact.
  if (isPublic && claimsVerification) {
    if (src.type === "unit-definition") {
      // A unit definition is exact by construction and has no game build.
    } else if (typeof src.gameVersion !== "string" || src.gameVersion.length === 0) {
      issues.push({
        severity: "error",
        path: "source.gameVersion",
        message:
          "incomplete source metadata: a public, verified profile must name the game build/season its numbers were checked against",
      });
    }
  }
  if (isPublic && src.confidence === "low" && profile.status === "verified") {
    issues.push({
      severity: "error",
      path: "source.confidence",
      message: 'a profile cannot be status "verified" while its source confidence is "low"',
    });
  }
  if (isPublic && claimsVerification && src.uncertaintyNotes.length === 0 && src.confidence !== "exact") {
    issues.push({
      severity: "warning",
      path: "source.uncertaintyNotes",
      message: "a non-exact profile with no stated uncertainty is usually an omission",
    });
  }
}

/** Validates one profile. Never throws; returns everything it found. */
export function validateGameProfile(profile: GameProfile): ProfileValidation {
  const issues: ProfileIssue[] = [];
  const id = typeof profile?.id === "string" ? profile.id : "<no id>";

  if (!profile || typeof profile !== "object") {
    return {
      profileId: id,
      valid: false,
      issues: [{ severity: "error", path: "", message: "profile is not an object" }],
    };
  }

  if (profile.schemaVersion !== GAME_PROFILE_SCHEMA_VERSION) {
    issues.push({
      severity: "error",
      path: "schemaVersion",
      message: `profile declares schemaVersion ${String(profile.schemaVersion)}; this build reads ${GAME_PROFILE_SCHEMA_VERSION}`,
    });
  }
  if (typeof profile.id !== "string" || !ID_PATTERN.test(profile.id)) {
    issues.push({
      severity: "error",
      path: "id",
      message: `"${String(profile.id)}" is not a stable lower-kebab-case id`,
    });
  }
  if (typeof profile.displayName !== "string" || profile.displayName.length === 0) {
    issues.push({ severity: "error", path: "displayName", message: "display name is required" });
  }
  if (!Number.isInteger(profile.profileVersion) || profile.profileVersion < 1) {
    issues.push({
      severity: "error",
      path: "profileVersion",
      message: `invalid version ${String(profile.profileVersion)}: expected an integer ≥ 1`,
    });
  }
  if (!PROFILE_STATUSES.includes(profile.status)) {
    issues.push({ severity: "error", path: "status", message: `unknown status "${String(profile.status)}"` });
  }
  if (profile.visibility !== "public" && profile.visibility !== "fixture") {
    issues.push({
      severity: "error",
      path: "visibility",
      message: `unknown visibility "${String(profile.visibility)}"`,
    });
  }
  if (!Array.isArray(profile.platforms) || profile.platforms.length === 0) {
    issues.push({ severity: "error", path: "platforms", message: "at least one platform is required" });
  }
  if (typeof profile.unitDefinition !== "string" || profile.unitDefinition.length === 0) {
    issues.push({
      severity: "error",
      path: "unitDefinition",
      message: "every profile must say in one sentence what 1.00 on its scale means",
    });
  }

  checkSensitivityModel(profile.sensitivityModel, issues);
  checkField(profile.hipfireField, "hipfireField", issues, true);
  checkFov(profile.fov, "fov", issues);
  checkMatching(profile.defaultMatching, "defaultMatching", issues);

  // ---- axes (requirement 5) ----
  const axes = profile.axes;
  if (!axes || typeof axes !== "object") {
    issues.push({ severity: "error", path: "axes", message: "axis model is missing" });
  } else {
    if (axes.independentAxes && !axes.verticalField) {
      issues.push({
        severity: "error",
        path: "axes.verticalField",
        message: "a profile with independent axes must describe the vertical setting",
      });
    }
    if (!axes.independentAxes && axes.verticalField) {
      issues.push({
        severity: "error",
        path: "axes.verticalField",
        message: "a profile without independent axes must not carry a vertical setting",
      });
    }
    if (axes.independentAxes && axes.verticalSemantics === "none") {
      issues.push({
        severity: "error",
        path: "axes.verticalSemantics",
        message: 'independent axes cannot have vertical semantics "none"',
      });
    }
    if (!axes.independentAxes && axes.verticalSemantics !== "none") {
      issues.push({
        severity: "error",
        path: "axes.verticalSemantics",
        message: 'a linked-axis profile must declare vertical semantics "none"',
      });
    }
    checkField(axes.verticalField, "axes.verticalField", issues, false);
    if (
      axes.builtInVerticalRatio !== null &&
      (!isFiniteNumber(axes.builtInVerticalRatio) || axes.builtInVerticalRatio <= 0)
    ) {
      issues.push({
        severity: "error",
        path: "axes.builtInVerticalRatio",
        message: `impossible vertical ratio ${axes.builtInVerticalRatio}`,
      });
    }
    // A game's fixed pitch:yaw relationship has exactly one home. Expressing
    // it twice — once as a pitch constant in the sensitivity model and once
    // as an axis ratio — would apply it twice, and the profile author would
    // have no way to tell which number was wrong.
    const model = profile.sensitivityModel;
    const declaresPitchConstant =
      model?.kind === "linear-yaw"
        ? model.pitchDegreesPerCountAtOne !== null &&
          model.pitchDegreesPerCountAtOne !== model.yawDegreesPerCountAtOne
        : model?.kind === "power-law-yaw"
          ? model.pitchCoefficient !== null || model.pitchExponent !== null
          : false;
    if (declaresPitchConstant && axes.builtInVerticalRatio !== null) {
      issues.push({
        severity: "error",
        path: "axes.builtInVerticalRatio",
        message:
          "the vertical relationship is declared twice (a pitch constant in the sensitivity model AND an axis ratio); it would be applied twice",
      });
    }
  }

  // ---- DPI model (requirement 4) ----
  if (!profile.dpi || typeof profile.dpi !== "object") {
    issues.push({ severity: "error", path: "dpi", message: "dpi model is missing" });
  } else if (profile.dpi.countBased !== true) {
    issues.push({
      severity: "error",
      path: "dpi.countBased",
      message: "only count-based sensitivity scales are supported; a non-count-based profile cannot be converted honestly",
    });
  }

  // ---- zoom (requirement 6) ----
  const zoomModel = profile.zoom;
  if (!zoomModel || typeof zoomModel !== "object") {
    issues.push({ severity: "error", path: "zoom", message: "zoom model is missing (use {kind:\"none\"})" });
  } else if (!["none", "single-scalar", "per-zoom"].includes(zoomModel.kind)) {
    issues.push({
      severity: "error",
      path: "zoom.kind",
      message: `unsupported ADS model "${String((zoomModel as { kind?: unknown }).kind)}"`,
    });
  } else {
    const zooms = zoomLevelsOf(profile);
    if (zoomModel.kind === "per-zoom" && zooms.length === 0) {
      issues.push({
        severity: "error",
        path: "zoom.zooms",
        message: 'a "per-zoom" model must define at least one zoom level',
      });
    }
    const seen = new Set<string>();
    zooms.forEach((zoom, i) => {
      const path = `zoom[${i}]`;
      if (typeof zoom.id !== "string" || !ID_PATTERN.test(zoom.id)) {
        issues.push({ severity: "error", path: `${path}.id`, message: `"${String(zoom.id)}" is not a stable id` });
      } else if (seen.has(zoom.id)) {
        issues.push({ severity: "error", path: `${path}.id`, message: `duplicate zoom id "${zoom.id}"` });
      } else {
        seen.add(zoom.id);
      }
      if (typeof zoom.label !== "string" || zoom.label.length === 0) {
        issues.push({ severity: "error", path: `${path}.label`, message: "zoom label is required" });
      }
      if (
        zoom.magnification !== null &&
        (!isFiniteNumber(zoom.magnification) || zoom.magnification <= 0)
      ) {
        issues.push({
          severity: "error",
          path: `${path}.magnification`,
          message: `impossible magnification ${zoom.magnification}`,
        });
      }
      checkFov(zoom.fov, `${path}.fov`, issues);
      checkField(zoom.setting, `${path}.setting`, issues, false);
      const behaviors = [
        "hipfire",
        "multiplies-hipfire",
        "fov-relative-multiplier",
        "independent-scalar",
        "fov-ratio-multiplier",
        "monitor-distance-coefficient",
      ];
      if (!behaviors.includes(zoom.nativeBehavior)) {
        issues.push({
          severity: "error",
          path: `${path}.nativeBehavior`,
          message: `unsupported ADS model combination: unknown behaviour "${String(zoom.nativeBehavior)}"`,
        });
      }
      if (zoom.nativeBehavior !== "hipfire" && !zoom.setting) {
        issues.push({
          severity: "error",
          path: `${path}.setting`,
          message: `unsupported ADS model combination: "${zoom.nativeBehavior}" needs a setting the player can change`,
        });
      }
      if (zoom.setting && zoom.neutralValue === null) {
        issues.push({
          severity: "warning",
          path: `${path}.neutralValue`,
          message: "no neutral value declared; game-native matching cannot be offered for this zoom",
        });
      }
      if (
        zoom.nativeBehavior === "fov-relative-multiplier" &&
        zoom.fov.kind === "none"
      ) {
        issues.push({
          severity: "error",
          path: `${path}.fov`,
          message: 'unsupported ADS model combination: "fov-relative-multiplier" requires a field of view for this zoom',
        });
      }
      // Pass 2 behaviours: each needs exactly the data its arithmetic reads.
      if (
        zoom.nativeBehavior === "fov-ratio-multiplier" &&
        (zoom.fov.kind === "none" && zoom.magnification === null)
      ) {
        issues.push({
          severity: "error",
          path: `${path}.fov`,
          message: 'unsupported ADS model combination: "fov-ratio-multiplier" needs this zoom\'s field of view (or a magnification to derive it from)',
        });
      }
      if (zoom.nativeBehavior === "fov-ratio-multiplier" && profile.fov?.kind === "none") {
        issues.push({
          severity: "error",
          path: `${path}.nativeBehavior`,
          message: 'unsupported ADS model combination: "fov-ratio-multiplier" needs a hip-fire field of view on the profile',
        });
      }
      if (zoom.nativeBehavior === "monitor-distance-coefficient") {
        if (zoom.coefficientAxis !== "horizontal" && zoom.coefficientAxis !== "vertical") {
          issues.push({
            severity: "error",
            path: `${path}.coefficientAxis`,
            message: '"monitor-distance-coefficient" must name the screen axis the game matches on',
          });
        }
        if (zoom.setting && zoom.setting.entry && zoom.setting.entry.allowZero !== true) {
          issues.push({
            severity: "error",
            path: `${path}.setting.entry.allowZero`,
            message: "a monitor-distance coefficient must accept 0 (the FOV-relative limit)",
          });
        }
      } else if (zoom.coefficientAxis !== undefined) {
        issues.push({
          severity: "error",
          path: `${path}.coefficientAxis`,
          message: `a coefficient axis is only meaningful for "monitor-distance-coefficient" (behaviour is "${zoom.nativeBehavior}")`,
        });
      }
      if (
        zoom.valueScale !== undefined &&
        (!isFiniteNumber(zoom.valueScale) || zoom.valueScale <= 0)
      ) {
        issues.push({
          severity: "error",
          path: `${path}.valueScale`,
          message: `impossible value scale ${String(zoom.valueScale)}: must be a positive number`,
        });
      }
    });
  }

  // ---- matching support declarations ----
  if (!Array.isArray(profile.supportedMatching) || profile.supportedMatching.length === 0) {
    issues.push({
      severity: "error",
      path: "supportedMatching",
      message: "a profile must declare at least one supported matching philosophy",
    });
  } else {
    for (const kind of profile.supportedMatching) {
      if (!ZOOM_MATCH_KINDS.includes(kind)) {
        issues.push({
          severity: "error",
          path: "supportedMatching",
          message: `unknown conversion type "${String(kind)}"`,
        });
      }
    }
    if (
      profile.defaultMatching &&
      ZOOM_MATCH_KINDS.includes(profile.defaultMatching.kind) &&
      !profile.supportedMatching.includes(profile.defaultMatching.kind)
    ) {
      issues.push({
        severity: "error",
        path: "defaultMatching",
        message: `default matching "${profile.defaultMatching.kind}" is not in supportedMatching`,
      });
    }
    // Monitor-distance matching is defined in terms of FOV. Declaring support
    // for it without modelling a hip-fire FOV would let a caller ask for a
    // ratio the profile cannot compute.
    if (
      profile.supportedMatching.includes("monitor-distance") &&
      profile.fov?.kind === "none"
    ) {
      issues.push({
        severity: "error",
        path: "supportedMatching",
        message: "monitor-distance matching is declared but the profile models no hip-fire field of view",
      });
    }
  }

  // ---- deprecation bookkeeping (requirement 20) ----
  if (profile.status === "deprecated") {
    if (!profile.deprecationNote) {
      issues.push({
        severity: "error",
        path: "deprecationNote",
        message: "a deprecated profile must say why, so a player with saved history is told what changed",
      });
    }
  } else if (profile.supersededByProfileId) {
    issues.push({
      severity: "error",
      path: "supersededByProfileId",
      message: "only a deprecated profile may name a successor",
    });
  }
  if (profile.supersededByProfileId !== null && profile.supersededByProfileId === profile.id) {
    issues.push({
      severity: "error",
      path: "supersededByProfileId",
      message: "a profile cannot supersede itself",
    });
  }

  checkSource(profile, issues);

  return {
    profileId: id,
    valid: !issues.some((i) => i.severity === "error"),
    issues,
  };
}

/** Validates and throws on any error. Used wherever failing closed matters. */
export function assertValidGameProfile(profile: GameProfile): GameProfile {
  const result = validateGameProfile(profile);
  if (!result.valid) throw new InvalidGameProfileError(result.profileId, result.issues);
  return profile;
}

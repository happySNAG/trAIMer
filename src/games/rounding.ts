/**
 * Slider granularity, rounding, and the honesty rules around them
 * (Game Profile Pass 1, requirements 2 and 15).
 *
 * A conversion produces an EXACT number. A game accepts a value on its own
 * grid. The difference between the two is a real loss of aim precision, and
 * trAIMer's rule is that it is always reported, never absorbed silently:
 *
 *     Exact equivalent: 6.347%
 *     Game UI step:     0.1%
 *     Recommended entry: 6.3%   (0.74% below exact)
 *
 * Some games accept more precision in a configuration file than in their
 * settings UI. The model carries both, so a player who is willing to edit a
 * config gets the closer value and is told that is what it is for.
 */

export type RoundingMode = "nearest" | "down" | "up";

/**
 * How a game accepts one numeric setting.
 *
 * `step` is the slider/increment granularity. `null` means the control is
 * continuous, in which case `uiDecimals` alone bounds what can be entered.
 */
export interface ValueEntrySpec {
  readonly min: number;
  readonly max: number;
  readonly step: number | null;
  /** Value the step grid is anchored at. Defaults to `min` when omitted. */
  readonly stepOrigin?: number | undefined;
  /** Decimal places the in-game UI accepts. */
  readonly uiDecimals: number;
  /**
   * Decimal places a configuration file accepts, when the game has one and it
   * is finer than the UI. `null` means "no separate config precision".
   */
  readonly configDecimals: number | null;
  readonly rounding: RoundingMode;
  /** Unit shown next to the number ("%", "×", "" for a bare scalar). */
  readonly unitSuffix: string;
  /**
   * True for a control whose zero is meaningful (a monitor-distance
   * coefficient of 0.00 is the FOV-relative limit). A sensitivity never sets
   * this; the validator rejects a zero minimum unless it is set.
   */
  readonly allowZero?: boolean | undefined;
  /**
   * What to tell the player when the exact value falls off the range.
   * `dpi` (the default) says a DPI change reaches it — true for a hip-fire
   * sensitivity, meaningless for a multiplier or a coefficient, which say
   * `none`.
   */
  readonly clampAdvice?: "dpi" | "none" | undefined;
}

/** The result of putting one exact value onto a game's entry grid. */
export interface QuantizedValue {
  /** The mathematically exact value, before any clamping or rounding. */
  readonly exact: number;
  /** What the player types into the game's own settings UI. */
  readonly ui: number;
  /** Finer value for a config file, when the profile declares one. */
  readonly config: number | null;
  readonly clampedToMin: boolean;
  readonly clampedToMax: boolean;
  /** (ui − exact) / exact. Signed; zero when the grid hit the value exactly. */
  readonly relativeError: number;
  /** True when `ui` is not `exact` — i.e. precision was lost. */
  readonly roundingLoss: boolean;
  /** Player-facing sentences explaining any clamping or rounding. */
  readonly notes: readonly string[];
}

/**
 * Nudge applied before a rounding decision, in units of the last place.
 *
 * A value like 1.005 is stored slightly BELOW 1.005, and 2.675 * 100 comes out
 * as 267.49999999999994, so a naive Math.round rounds both the wrong way. The
 * correction has to be proportional to the magnitude being rounded — a fixed
 * relative epsilon such as 1e-9 works at two decimal places and shifts the
 * answer by twelve whole units at ten, which is exactly the bug this constant
 * replaced.
 */
const GRID_NUDGE_ULPS = 8 * Number.EPSILON;

/**
 * Relative difference below which two sensitivities are the same number.
 *
 * Separate from the rounding nudge on purpose: this one answers "did the
 * player lose any precision", and a few ulps of round-trip noise must not be
 * reported to them as rounding loss.
 */
const NEGLIGIBLE_RELATIVE = 1e-12;

function nudge(value: number): number {
  return value + Math.sign(value) * Math.abs(value) * GRID_NUDGE_ULPS;
}

/** Rounds to a fixed number of decimals without float dust. */
export function roundToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  // Round-half-away-from-zero, corrected for binary representation error:
  // 1.005 is stored slightly below 1.005, and Math.round would give 1.00.
  return Math.round(nudge(value * factor)) / factor;
}

/** Formats a value the way the game's own UI would show it. */
export function formatEntryValue(spec: ValueEntrySpec, value: number): string {
  return `${value.toFixed(spec.uiDecimals)}${spec.unitSuffix}`;
}

function applyRounding(value: number, mode: RoundingMode): number {
  const nudged = nudge(value);
  if (mode === "down") return Math.floor(nudged);
  if (mode === "up") return Math.ceil(nudged);
  return Math.round(nudged);
}

/** Snaps a value onto the spec's step grid, ignoring range and decimals. */
function snapToStep(spec: ValueEntrySpec, value: number): number {
  if (spec.step === null || spec.step <= 0) return value;
  const origin = spec.stepOrigin ?? spec.min;
  const steps = applyRounding((value - origin) / spec.step, spec.rounding);
  return origin + steps * spec.step;
}

/**
 * Puts an exact value onto a game's entry grid and reports what that cost.
 *
 * Order of operations, and why: the value is snapped to the step grid FIRST
 * and clamped to the range SECOND, then re-snapped inwards. Clamping first
 * could park the value on `max` even when `max` is not on the grid, and a
 * value the game will not accept is worse than one that is slightly off.
 */
export function quantize(spec: ValueEntrySpec, exact: number): QuantizedValue {
  const notes: string[] = [];
  if (!Number.isFinite(exact)) {
    throw new RangeError(`cannot quantize a non-finite value (${exact})`);
  }

  let value = snapToStep(spec, exact);
  value = roundToDecimals(value, spec.uiDecimals);

  let clampedToMin = false;
  let clampedToMax = false;
  if (value < spec.min) {
    // Step back INTO range: the first grid point at or above min.
    value = spec.step
      ? roundToDecimals(
          (spec.stepOrigin ?? spec.min) +
            Math.ceil(
              nudge((spec.min - (spec.stepOrigin ?? spec.min)) / spec.step) - NEGLIGIBLE_RELATIVE,
            ) *
              spec.step,
          spec.uiDecimals,
        )
      : roundToDecimals(spec.min, spec.uiDecimals);
    if (value < spec.min) value = roundToDecimals(spec.min, spec.uiDecimals);
    clampedToMin = true;
  } else if (value > spec.max) {
    value = spec.step
      ? roundToDecimals(
          (spec.stepOrigin ?? spec.min) +
            Math.floor(
              nudge((spec.max - (spec.stepOrigin ?? spec.min)) / spec.step) + NEGLIGIBLE_RELATIVE,
            ) *
              spec.step,
          spec.uiDecimals,
        )
      : roundToDecimals(spec.max, spec.uiDecimals);
    if (value > spec.max) value = roundToDecimals(spec.max, spec.uiDecimals);
    clampedToMax = true;
  }

  const relativeError = exact === 0 ? 0 : (value - exact) / exact;
  const roundingLoss =
    Math.abs(value - exact) > NEGLIGIBLE_RELATIVE * Math.max(1, Math.abs(exact));

  const dpiAdvice = (spec.clampAdvice ?? "dpi") === "dpi";
  if (clampedToMin) {
    notes.push(
      `This game's lowest accepted value is ${formatEntryValue(spec, spec.min)}; the exact equivalent (${exact.toFixed(spec.uiDecimals + 2)}${spec.unitSuffix}) is below it.${dpiAdvice ? " Lower your DPI to reach it." : " The game cannot express it; the nearest accepted value is shown."}`,
    );
  }
  if (clampedToMax) {
    notes.push(
      `This game's highest accepted value is ${formatEntryValue(spec, spec.max)}; the exact equivalent (${exact.toFixed(spec.uiDecimals + 2)}${spec.unitSuffix}) is above it.${dpiAdvice ? " Raise your DPI to reach it." : " The game cannot express it; the nearest accepted value is shown."}`,
    );
  }
  if (roundingLoss && !clampedToMin && !clampedToMax) {
    const grain =
      spec.step !== null
        ? `steps of ${spec.step}${spec.unitSuffix}`
        : `${spec.uiDecimals} decimal place${spec.uiDecimals === 1 ? "" : "s"}`;
    notes.push(
      `Exact equivalent ${exact.toFixed(spec.uiDecimals + 2)}${spec.unitSuffix}; this game accepts ${grain}, so enter ${formatEntryValue(spec, value)} (${(relativeError * 100).toFixed(2)}% ${relativeError < 0 ? "below" : "above"} exact).`,
    );
  }

  let config: number | null = null;
  if (spec.configDecimals !== null && spec.configDecimals > spec.uiDecimals) {
    const clampedExact = Math.min(spec.max, Math.max(spec.min, exact));
    config = roundToDecimals(clampedExact, spec.configDecimals);
    if (config !== value) {
      notes.push(
        `A configuration file accepts ${spec.configDecimals} decimal places: ${config}${spec.unitSuffix} is closer to exact than the ${formatEntryValue(spec, value)} the settings screen allows.`,
      );
    }
  }

  return {
    exact,
    ui: value,
    config,
    clampedToMin,
    clampedToMax,
    relativeError,
    roundingLoss,
    notes,
  };
}

/**
 * The worst relative error a single quantization of this spec can introduce,
 * for values in the usable middle of its range.
 *
 * This is the declared round-trip tolerance: `canonical → game → canonical`
 * cannot do better than the game's own grid, and a test that demanded better
 * would be testing a lie.
 */
export function roundTripToleranceFraction(
  spec: ValueEntrySpec,
  representativeValue: number,
): number {
  const grain =
    spec.step !== null && spec.step > 0 ? spec.step : 10 ** -spec.uiDecimals;
  const magnitude = Math.max(Math.abs(representativeValue), 10 ** -spec.uiDecimals);
  // Half a grid step, relative to the value. The 1 + 1e-6 is headroom for
  // binary floating point: a value that lands exactly half a step from the
  // grid produces an error equal to this bound to the last bit, and a bound
  // that fails on equality would be a bound that is wrong.
  return ((grain / 2) / magnitude) * (1 + 1e-6) + 1e-12;
}

/** True when `value` sits exactly on the spec's grid and inside its range. */
export function isEnterableValue(spec: ValueEntrySpec, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (value < spec.min - NEGLIGIBLE_RELATIVE) return false;
  if (value > spec.max + NEGLIGIBLE_RELATIVE) return false;
  if (roundToDecimals(value, spec.uiDecimals) !== roundToDecimals(value, spec.uiDecimals + 6)) {
    return false;
  }
  if (spec.step === null || spec.step <= 0) return true;
  const origin = spec.stepOrigin ?? spec.min;
  const steps = (value - origin) / spec.step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

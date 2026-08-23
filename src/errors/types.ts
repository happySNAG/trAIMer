/**
 * Typed domain error model (Pass 4, requirement S).
 *
 * Errors crossing the engine → UI boundary are always `AimLabError`: a
 * machine-readable `category`, a safe user-facing message, and structured
 * `details` for diagnostics. Raw internal stack traces must never be shown to
 * normal users; `userMessage` is the only string UIs should render directly.
 */

export const AIM_ERROR_CATEGORIES = [
  "user-correctable",
  "capture",
  "persistence",
  "corrupted-data",
  "optimizer",
  "unsupported-environment",
  "calibration",
] as const;

export type AimErrorCategory = (typeof AIM_ERROR_CATEGORIES)[number];

export interface AimErrorDetail {
  [key: string]: string | number | boolean | null;
}

export class AimLabError extends Error {
  readonly category: AimErrorCategory;
  readonly code: string;
  readonly userMessage: string;
  readonly details: AimErrorDetail;
  readonly retryable: boolean;
  /** True when the failure already put persistent data in a known-safe state. */
  readonly failSafeApplied: boolean;

  constructor(init: {
    category: AimErrorCategory;
    code: string;
    userMessage: string;
    details?: AimErrorDetail | undefined;
    cause?: unknown;
    retryable?: boolean | undefined;
    failSafeApplied?: boolean | undefined;
  }) {
    super(`${init.category}/${init.code}: ${init.userMessage}`, { cause: init.cause });
    this.name = "AimLabError";
    this.category = init.category;
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.details = init.details ?? {};
    this.retryable = init.retryable ?? false;
    this.failSafeApplied = init.failSafeApplied ?? false;
  }

  toJSON(): { category: AimErrorCategory; code: string; userMessage: string; details: AimErrorDetail } {
    return {
      category: this.category,
      code: this.code,
      userMessage: this.userMessage,
      details: this.details,
    };
  }
}

/** Normalizes any thrown value into an AimLabError without losing detail. */
export function toAimLabError(err: unknown): AimLabError {
  if (err instanceof AimLabError) return err;
  if (err instanceof Error) {
    // Preserve the original message in details only — it may contain
    // internals; the user-facing message stays generic.
    return new AimLabError({
      category: "user-correctable",
      code: "UNEXPECTED_ERROR",
      userMessage: "Something went wrong. The diagnostic bundle contains details.",
      details: { internalType: err.name },
      cause: err,
    });
  }
  return new AimLabError({
    category: "user-correctable",
    code: "UNEXPECTED_THROWN_VALUE",
    userMessage: "Something went wrong.",
    details: {},
    cause: err,
  });
}

export function captureError(
  code: string,
  userMessage: string,
  details?: AimErrorDetail,
  opts?: { retryable?: boolean; failSafeApplied?: boolean; cause?: unknown },
): AimLabError {
  return new AimLabError({
    category: "capture",
    code,
    userMessage,
    details,
    retryable: opts?.retryable ?? true,
    failSafeApplied: opts?.failSafeApplied ?? false,
    cause: opts?.cause,
  });
}

export function persistenceError(
  code: string,
  userMessage: string,
  details?: AimErrorDetail,
  opts?: { retryable?: boolean; failSafeApplied?: boolean; cause?: unknown },
): AimLabError {
  return new AimLabError({
    category: "persistence",
    code,
    userMessage,
    details,
    retryable: opts?.retryable ?? true,
    failSafeApplied: opts?.failSafeApplied ?? false,
    cause: opts?.cause,
  });
}

export function corruptedDataError(
  code: string,
  userMessage: string,
  details?: AimErrorDetail,
  opts?: { cause?: unknown },
): AimLabError {
  return new AimLabError({
    category: "corrupted-data",
    code,
    userMessage,
    details,
    retryable: false,
    failSafeApplied: true,
    cause: opts?.cause,
  });
}

export function optimizerError(
  code: string,
  userMessage: string,
  details?: AimErrorDetail,
  opts?: { cause?: unknown },
): AimLabError {
  return new AimLabError({
    category: "optimizer",
    code,
    userMessage,
    details,
    retryable: false,
    cause: opts?.cause,
  });
}

export function unsupportedEnvironmentError(
  code: string,
  userMessage: string,
  details?: AimErrorDetail,
): AimLabError {
  return new AimLabError({
    category: "unsupported-environment",
    code,
    userMessage,
    details,
    retryable: false,
  });
}

export function calibrationError(
  code: string,
  userMessage: string,
  details?: AimErrorDetail,
): AimLabError {
  return new AimLabError({
    category: "calibration",
    code,
    userMessage,
    details,
    retryable: true,
  });
}

/** Fail-safe contract for persistence writes (requirement R). */
export interface WriteOutcome<T> {
  ok: boolean;
  value?: T;
  error?: AimLabError;
}

/**
 * Wraps a persistence write so failures surface as typed errors and NEVER
 * leave partially-written state silently accepted by callers.
 */
export async function guardedWrite<T>(
  op: () => Promise<T>,
  context: { kind: string; path: string },
): Promise<WriteOutcome<T>> {
  try {
    const value = await op();
    return { ok: true, value };
  } catch (err) {
    const aimErr =
      err instanceof AimLabError
        ? err
        : persistenceError(
            "WRITE_FAILED",
            "Saving data locally failed. Your last action was not lost permanently — try again.",
            { kind: context.kind, path: context.path },
            { cause: err },
          );
    return { ok: false, error: aimErr };
  }
}

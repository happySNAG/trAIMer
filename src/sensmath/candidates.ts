import type {
  SafeSensitivityRange,
  SensitivityCandidate,
} from "../domain/candidate.ts";
import { makeCandidateId } from "../domain/ids.ts";
import type { SensitivityConfiguration } from "../domain/settings.ts";
import { multiplicativeChange } from "./sensitivity.ts";

export interface CandidateLadderOptions {
  baseline: SensitivityConfiguration;
  factors: readonly number[];
  safeRange: SafeSensitivityRange;
}

export function clampToSafeRange(
  sensitivity: SensitivityConfiguration,
  range: SafeSensitivityRange,
): SensitivityConfiguration {
  return {
    sensX: Math.min(range.maxSensX, Math.max(range.minSensX, sensitivity.sensX)),
    sensY: Math.min(range.maxSensY, Math.max(range.minSensY, sensitivity.sensY)),
  };
}

function formatFactor(factor: number): string {
  const percent = Math.round((factor - 1) * 1000) / 10;
  return `f${percent >= 0 ? "p" : "m"}${Math.abs(percent).toFixed(0)}`;
}

export function withinSafeRange(
  sensitivity: SensitivityConfiguration,
  range: SafeSensitivityRange,
): boolean {
  const clamped = clampToSafeRange(sensitivity, range);
  return (
    Math.abs(clamped.sensX - sensitivity.sensX) < 1e-9 &&
    Math.abs(clamped.sensY - sensitivity.sensY) < 1e-9
  );
}

export function generateCandidateLadder(
  options: CandidateLadderOptions,
): SensitivityCandidate[] {
  const { baseline, factors, safeRange } = options;
  if (!factors.every((f) => Number.isFinite(f) && f > 0)) {
    throw new Error("Candidate factors must be positive finite numbers");
  }
  const sorted = [...factors].sort((a, b) => a - b);
  const out: SensitivityCandidate[] = [
    {
      id: makeCandidateId("baseline"),
      sensitivity: clampToSafeRange(baseline, safeRange),
      origin: { kind: "baseline" },
    },
  ];
  for (const factor of sorted) {
    if (Math.abs(factor - 1) < 1e-12) continue;
    const raw = multiplicativeChange(baseline, factor);
    const sensitivity = clampToSafeRange(raw, safeRange);
    if (out.some((c) => sameSensitivity(c.sensitivity, sensitivity))) continue;
    out.push({
      id: makeCandidateId(formatFactor(factor)),
      sensitivity,
      origin: { kind: "generated", multiplicativeFactorVsBaseline: factor },
    });
  }
  return out;
}

export function manualCandidate(
  label: string,
  sensitivity: SensitivityConfiguration,
): SensitivityCandidate {
  return {
    id: makeCandidateId(label.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
    sensitivity,
    origin: { kind: "manual", label },
  };
}

export function sameSensitivity(
  a: SensitivityConfiguration,
  b: SensitivityConfiguration,
  epsilon = 1e-6,
): boolean {
  return (
    Math.abs(a.sensX - b.sensX) < epsilon &&
    Math.abs(a.sensY - b.sensY) < epsilon
  );
}

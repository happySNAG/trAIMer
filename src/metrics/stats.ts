export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("mean of empty list");
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const ss = values.reduce((acc, v) => acc + (v - m) * (v - m), 0);
  return Math.sqrt(ss / (values.length - 1));
}

export function coefficientOfVariation(values: readonly number[]): number {
  const m = mean(values);
  if (m === 0) return 0;
  return sampleStandardDeviation(values) / Math.abs(m);
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

export function percentile(
  values: readonly number[],
  levelPercent: number,
): number {
  if (values.length === 0) throw new Error("percentile of empty list");
  if (levelPercent < 0 || levelPercent > 100) {
    throw new Error("percentile level must be within [0, 100]");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (levelPercent / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function rootMeanSquare(values: readonly number[]): number {
  if (values.length === 0) throw new Error("rms of empty list");
  return Math.sqrt(mean(values.map((v) => v * v)));
}

export interface MeanAndSe {
  mean: number;
  standardError: number;
  sampleCount: number;
}

export function meanAndStandardError(
  values: readonly number[],
): MeanAndSe | null {
  if (values.length === 0) return null;
  return {
    mean: mean(values),
    standardError: sampleStandardDeviation(values) / Math.sqrt(values.length),
    sampleCount: values.length,
  };
}

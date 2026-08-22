import type { Vec2 } from "../domain/geometry.ts";
import type { Rng } from "../util/rng.ts";

export interface SubmovementOptions {
  from: Vec2;
  to: Vec2;
  startMs: number;
  durationMs: number;
  sampleDtMs: number;
  tremorSigmaPx: number;
}

export interface EmittedPoint {
  position: Vec2;
  tMs: number;
}

export function emitSubmovement(
  options: SubmovementOptions,
  rng: Rng,
  emit: (tMs: number, dx: number, dy: number) => void,
): EmittedPoint {
  const { from, to, startMs, durationMs, sampleDtMs, tremorSigmaPx } = options;
  const steps = Math.max(2, Math.round(durationMs / sampleDtMs));
  let prev = jittered(from, rng, tremorSigmaPx);
  if (steps > 0) {
    emit(startMs, prev.x - from.x, prev.y - from.y);
  }
  for (let i = 1; i <= steps; i++) {
    const z = i / steps;
    const s = z * z * (3 - 2 * z);
    const ideal = {
      x: from.x + (to.x - from.x) * s,
      y: from.y + (to.y - from.y) * s,
    };
    const noisy = jittered(ideal, rng, tremorSigmaPx);
    emit(startMs + i * sampleDtMs, noisy.x - prev.x, noisy.y - prev.y);
    prev = noisy;
  }
  return { position: prev, tMs: startMs + steps * sampleDtMs };
}

function jittered(p: Vec2, rng: Rng, sigmaPx: number): Vec2 {
  if (sigmaPx <= 0) return { ...p };
  return {
    x: p.x + rng.normal(0, sigmaPx),
    y: p.y + rng.normal(0, sigmaPx),
  };
}

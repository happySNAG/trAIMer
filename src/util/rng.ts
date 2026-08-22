export class Rng {
  #state: number;

  constructor(seed: number) {
    if (!Number.isFinite(seed)) throw new Error("seed must be finite");
    this.#state = seed === 0 ? 0x9e3779b9 : Math.floor(seed) >>> 0;
  }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(upperExclusive: number): number {
    return Math.floor(this.next() * upperExclusive);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("cannot pick from empty list");
    return items[this.int(items.length)]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  normal(meanValue = 0, sigma = 1): number {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const mag = Math.sqrt(-2 * Math.log(u1));
    const z = mag * Math.cos(2 * Math.PI * u2);
    return meanValue + sigma * z;
  }

  lognormal(medianValue: number, sigma: number): number {
    return Math.exp(this.normal(Math.log(medianValue), sigma));
  }

  bernoulli(p: number): boolean {
    return this.next() < p;
  }
}

export function combineSeeds(...parts: readonly number[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    const v = Math.floor(part) >>> 0;
    h ^= v + 0x9e3779b9 + (h << 6) + (h >>> 2);
    h >>>= 0;
  }
  return h;
}

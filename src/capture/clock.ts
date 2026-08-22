export interface MonotonicClock {
  nowMs(): number;
}

export class SystemMonotonicClock implements MonotonicClock {
  nowMs(): number {
    return performance.now();
  }
}

export class ManualClock implements MonotonicClock {
  #currentMs: number;

  constructor(startMs = 0) {
    this.#currentMs = startMs;
  }

  nowMs(): number {
    return this.#currentMs;
  }

  advance(deltaMs: number): void {
    this.#currentMs += deltaMs;
  }

  set(ms: number): void {
    this.#currentMs = ms;
  }
}

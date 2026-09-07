/**
 * Arena sound. Synthesized in the browser with WebAudio — no asset files, no
 * network, nothing to bundle, and nothing that could ever phone home.
 *
 * MEASUREMENT RULE (Pass 13, requirement 3/11): every method here is called
 * AFTER the shot has already been handed to the recorder. Sound is scheduled
 * on the audio clock and never blocks, never awaits, and never touches target
 * geometry, timing or hit detection. If the audio context cannot be created
 * at all — an old engine, a locked-down build, a user with audio disabled —
 * every method degrades to a no-op and the drill plays exactly as before.
 */
export class ArenaAudio {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #failed = false;
  #enabled = true;
  /** Shared noise buffer for the shot transient (built once). */
  #noise: AudioBuffer | null = null;

  /**
   * MUST be called from inside a user gesture (the arena click). Browsers
   * start an AudioContext suspended otherwise, and a suspended context makes
   * every later sound silently vanish.
   */
  unlock(): void {
    if (this.#failed || !this.#enabled) return;
    const ctx = this.#context();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (this.#master) this.#master.gain.value = enabled ? 0.9 : 0;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** The shot itself: a short, dry click. Fired for every recorded shot. */
  shot(): void {
    const ctx = this.#context();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.#noiseBurst(t, 0.045, 2600, 0.16);
    this.#tone(t, "square", 220, 140, 0.05, 0.1);
  }

  /**
   * A confirmed hit. Bright, short, and pitched UP with the streak so a run of
   * hits feels like a run — capped so it never becomes shrill, and completely
   * independent of anything that is measured.
   */
  hit(streak: number): void {
    const ctx = this.#context();
    if (!ctx) return;
    const t = ctx.currentTime;
    const step = Math.min(8, Math.max(0, streak - 1));
    const base = 880 * Math.pow(2, step / 12);
    this.#tone(t, "triangle", base, base * 1.5, 0.09, 0.22);
    this.#tone(t + 0.012, "sine", base * 2, base * 2, 0.06, 0.1);
  }

  /** A shot that landed nowhere: dull, low, over quickly. */
  miss(): void {
    const ctx = this.#context();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.#tone(t, "sine", 150, 90, 0.11, 0.13);
  }

  /** A target the player never shot at all. Softer than a miss. */
  expired(): void {
    const ctx = this.#context();
    if (!ctx) return;
    this.#tone(ctx.currentTime, "sine", 240, 110, 0.2, 0.08);
  }

  /** The tracking window closed. Two rising notes: unmistakably "done". */
  trackComplete(): void {
    const ctx = this.#context();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.#tone(t, "triangle", 660, 660, 0.1, 0.16);
    this.#tone(t + 0.11, "triangle", 990, 990, 0.16, 0.16);
  }

  /** A tracking drill is starting: one low, calm note. Not a "go" buzzer. */
  trackStart(): void {
    const ctx = this.#context();
    if (!ctx) return;
    this.#tone(ctx.currentTime, "sine", 392, 523, 0.18, 0.1);
  }

  /** Closes the audio graph. Safe to call more than once. */
  dispose(): void {
    const ctx = this.#ctx;
    this.#ctx = null;
    this.#master = null;
    this.#noise = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  #context(): AudioContext | null {
    if (this.#failed || !this.#enabled) return null;
    if (this.#ctx) return this.#ctx;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) {
        this.#failed = true;
        return null;
      }
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      this.#ctx = ctx;
      this.#master = master;
      return ctx;
    } catch {
      this.#failed = true;
      return null;
    }
  }

  #tone(
    startAt: number,
    type: OscillatorType,
    fromHz: number,
    toHz: number,
    durationSec: number,
    peakGain: number,
  ): void {
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(fromHz, startAt);
      if (toHz !== fromHz) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(20, toHz),
          startAt + durationSec,
        );
      }
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSec);
      osc.connect(gain);
      gain.connect(master);
      osc.start(startAt);
      osc.stop(startAt + durationSec + 0.02);
    } catch {
      // A refused node allocation must never interrupt a drill.
    }
  }

  #noiseBurst(
    startAt: number,
    durationSec: number,
    filterHz: number,
    peakGain: number,
  ): void {
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master) return;
    try {
      if (!this.#noise) {
        const frames = Math.max(1, Math.floor(ctx.sampleRate * 0.25));
        const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        // Deterministic pseudo-noise: identical every launch, so nothing about
        // the sound can vary between sessions.
        let seed = 22222;
        for (let i = 0; i < frames; i++) {
          seed = (seed * 1103515245 + 12345) >>> 0;
          data[i] = (seed / 0xffffffff) * 2 - 1;
        }
        this.#noise = buffer;
      }
      const src = ctx.createBufferSource();
      src.buffer = this.#noise;
      const filter = ctx.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = filterHz;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(peakGain, startAt);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSec);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      src.start(startAt);
      src.stop(startAt + durationSec + 0.02);
    } catch {
      // Same rule: audio never breaks a drill.
    }
  }
}

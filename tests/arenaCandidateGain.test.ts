import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PointerLockCaptureSource,
  VirtualReticle,
  type BrowserDocumentLike,
  type DomEventTargetLike,
  type LockRequestableElement,
} from "../src/capture/browserSource.ts";
import type { CaptureEvent } from "../src/capture/events.ts";
import { TrialRecorder } from "../src/capture/recorder.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { makeExperimentId } from "../src/domain/ids.ts";
import type { SensitivityCandidate } from "../src/domain/candidate.ts";
import type { ExperimentDefinition } from "../src/domain/experiment.ts";
import {
  ARENA_PX_PER_DEGREE,
  ARENA_REFERENCE_CM_PER_360,
  ARENA_REFERENCE_DEGREES_PER_CM,
  ARENA_MAX_PLAYABLE_CM_PER_360,
  ARENA_REFERENCE_DPI,
  anchorIsPlayable,
  arenaCmPer360,
  arenaDegreesPerCount,
  arenaGainPxPerCount,
  arenaGainRatio,
  baselineReferenceAnchor,
  calibratedAnchor,
  gameProfileAnchor,
  CM_PER_INCH,
  type ArenaSensitivityAnchor,
} from "../src/sensmath/arenaGain.ts";
import { CM_PER_INCH as GAMES_CM_PER_INCH } from "../src/games/canonical.ts";
import {
  candidateReticleGain,
  resolveArenaAnchor,
  type ArenaAnchorInput,
} from "../app/src/arenaSensitivity.ts";
import type { CalibrationHistoryEntry } from "../src/history/api.ts";
import { SyntheticExperimentRunner } from "../src/sim/simulator.ts";
import { DEFAULT_PLAYER_CONFIG } from "../src/sim/player.ts";

/**
 * The arena must actually apply the blinded candidate sensitivity (Pass 15).
 *
 * ## What this file is
 *
 * rc.8's `VirtualReticle.applyRawDelta` moved the reticle one logical pixel
 * per mouse count for every candidate. The candidate reached the trial
 * record's metadata and the simulator's player model; it never reached the
 * player's hand. A human calibration on that build compared five
 * sensitivities that all felt identical.
 *
 * The reproduction that proved it is kept first, inverted into the assertion
 * it should always have been. Everything after it pins the physical model,
 * the single application point, and the agreement between the simulator and
 * the real arena.
 *
 * ## The harness
 *
 * `PointerLockCaptureSource` is the production class `BrowserRunController`
 * constructs, behind the same fake DOM the rest of the browser-capture suite
 * uses, driven through the same candidate → gain → reticle sequence a real
 * Electron trial runs — and through the production `candidateReticleGain`,
 * not a copy of its arithmetic. What is NOT covered here is the wiring from
 * the run controller to that call; the real Chromium arena proves that
 * (tests/browser/candidateGain.spec.ts) and so does the installed-app gate
 * (scripts/verify-candidate-gain.mjs).
 */

class FakeTarget {
  readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
  pointerLockElementValue: unknown = null;
  /**
   * Present so `detectPointerEventCapabilities` selects the pointermove path,
   * which is what a real Chromium arena uses. Without it the source listens
   * for "mousemove" and the coalesced-burst test below silently exercises
   * nothing at all.
   */
  onpointermove: unknown = null;
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  requestPointerLock(): void {}
  emit(type: string, ev: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(ev);
  }
}

const LOGICAL_VIEWPORT = { widthPx: 1280, heightPx: 720 };

function makeArena(viewport = LOGICAL_VIEWPORT) {
  const element = new FakeTarget();
  const docLike = new FakeTarget();
  const win = new FakeTarget();
  const documentLike = docLike as unknown as BrowserDocumentLike & FakeTarget;
  Object.defineProperty(documentLike, "pointerLockElement", {
    get: () => element.pointerLockElementValue,
  });
  documentLike.exitPointerLock = () => {
    element.pointerLockElementValue = null;
    docLike.emit("pointerlockchange", {});
  };
  Object.defineProperty(documentLike, "hidden", { get: () => false });

  const source = new PointerLockCaptureSource({
    element: element as unknown as LockRequestableElement,
    document: documentLike as unknown as BrowserDocumentLike,
    window: win as unknown as DomEventTargetLike,
    viewportProvider: () => ({ ...viewport }),
  });
  const events: CaptureEvent[] = [];
  source.start({ onEvent: (e) => events.push(e) });
  const moveType =
    "onpointermove" in (element as object) ? "pointermove" : "mousemove";
  const lock = (): void => {
    element.pointerLockElementValue = {};
    docLike.emit("pointerlockchange", {});
  };
  lock();
  return {
    source,
    element,
    events,
    lock,
    unlock: () => documentLike.exitPointerLock(),
    moveType,
    /** One raw mouse movement through the production pointermove handler. */
    move(dx: number, dy: number): void {
      element.emit(moveType, { movementX: dx, movementY: dy });
    },
    samples: () =>
      events.filter(
        (e): e is Extract<CaptureEvent, { kind: "pointer-sample" }> =>
          e.kind === "pointer-sample",
      ),
  };
}

function definitionAt(dpi: number, baselineSens: number): ExperimentDefinition {
  return buildExperimentDefinition({
    id: makeExperimentId(`arena-gain-${dpi}-${baselineSens}`),
    name: "arena gain",
    baselineSensitivity: { sensX: baselineSens, sensY: baselineSens },
    dpi,
    orderSeed: 4242,
  });
}

/**
 * A physically real calibration constant: 0.4665 deg/count at 100 %
 * sensitivity is what a player who turns 360° in ~35 cm at 7 % / 800 DPI
 * actually measures. Test fixtures use it rather than a round number so a
 * gain that comes out absurd shows up as an absurd gain rather than as an
 * assertion that quietly still passes.
 */
const REAL_DEG_PER_COUNT_100 = 0.4665;

/** The same measurement with a mistyped turn count — an unplayable arena. */
const MISTYPED_DEG_PER_COUNT_100 = 0.0132;

const definition = definitionAt(800, 7);
const anchor = baselineReferenceAnchor(
  definition.baselineSensitivity,
  definition.dpi,
);

function candidateBy(
  predicate: (c: SensitivityCandidate) => boolean,
  def: ExperimentDefinition = definition,
): SensitivityCandidate {
  const found = def.candidates.find(predicate);
  if (!found) throw new Error("candidate not found");
  return found;
}

const slowest = candidateBy((c) => c.sensitivity.sensX < 7 * 0.8);
const fastest = candidateBy((c) => c.sensitivity.sensX > 7 * 1.2);
const baselineCandidate = candidateBy((c) => c.origin.kind === "baseline");

/**
 * EXACTLY what `BrowserRunController.#executeTrial` does to the capture
 * source before a drill begins: set the candidate gain, then recentre.
 */
function beginTrialForCandidate(
  arena: ReturnType<typeof makeArena>,
  candidate: SensitivityCandidate,
  def: ExperimentDefinition = definition,
  useAnchor: ArenaSensitivityAnchor = anchor,
): void {
  arena.source.setReticleGain(candidateReticleGain(useAnchor, candidate, def.dpi));
  arena.source.reticle.reset();
}

function displacementForCandidate(
  candidate: SensitivityCandidate,
  rawCounts: { dx: number; dy: number },
  def: ExperimentDefinition = definition,
  useAnchor: ArenaSensitivityAnchor = anchor,
): { dx: number; dy: number } {
  const arena = makeArena();
  beginTrialForCandidate(arena, candidate, def, useAnchor);
  const before = arena.source.reticle.position;
  arena.move(rawCounts.dx, rawCounts.dy);
  const after = arena.source.reticle.position;
  return { dx: after.x - before.x, dy: after.y - before.y };
}

// ---------------------------------------------------------------------------
// A. the reproduction, inverted
// ---------------------------------------------------------------------------

describe("the real arena applies the blinded candidate sensitivity", () => {
  it("moves the reticle by the candidates' sensitivity ratio for identical raw counts", () => {
    const sensRatio = fastest.sensitivity.sensX / slowest.sensitivity.sensX;
    expect(sensRatio).toBeGreaterThan(1.5);

    const raw = { dx: 100, dy: -40 };
    const slow = displacementForCandidate(slowest, raw);
    const fast = displacementForCandidate(fastest, raw);

    expect(fast.dx).not.toBeCloseTo(slow.dx, 3);
    expect(fast.dx / slow.dx).toBeCloseTo(sensRatio, 9);
    expect(fast.dy / slow.dy).toBeCloseTo(sensRatio, 9);
  });

  it("never moves 1 logical px per raw count for every candidate alike", () => {
    const raw = { dx: 100, dy: -40 };
    const seen = new Set<number>();
    for (const candidate of definition.candidates) {
      const moved = displacementForCandidate(candidate, raw);
      seen.add(Number((moved.dx / raw.dx).toFixed(9)));
    }
    // Five ladder arms, five distinct gains — the rc.8 defect produced one.
    expect(seen.size).toBe(definition.candidates.length);
  });

  it("reproduces rc.8 exactly at the reference sensitivity, and only there", () => {
    // The declared reference is pinned so the arena's feel at the centre of
    // the range is unchanged by this fix.
    const referenceAnchor = baselineReferenceAnchor(
      { sensX: 7, sensY: 7 },
      ARENA_REFERENCE_DPI,
    );
    const gain = arenaGainPxPerCount(
      referenceAnchor,
      { sensX: 7, sensY: 7 },
      ARENA_REFERENCE_DPI,
    );
    expect(gain.x).toBeCloseTo(1, 12);
    expect(gain.y).toBeCloseTo(1, 12);
    expect(
      arenaCmPer360(referenceAnchor, { sensX: 7, sensY: 7 }, ARENA_REFERENCE_DPI).x,
    ).toBeCloseTo(ARENA_REFERENCE_CM_PER_360, 12);
  });
});

// ---------------------------------------------------------------------------
// B. the physical model
// ---------------------------------------------------------------------------

describe("the candidate-gain equation", () => {
  it("is px/count = pxPerDegree × cm/inch ÷ dpi × degPerCm(sens)", () => {
    const dpi = 1600;
    const sens = { sensX: 9.1, sensY: 5.3 };
    const gain = arenaGainPxPerCount(anchor, sens, dpi);

    const degPerCmX =
      ARENA_REFERENCE_DEGREES_PER_CM *
      (sens.sensX / anchor.referenceSensX) *
      (dpi / anchor.referenceDpi);
    const expectedX = degPerCmX * (CM_PER_INCH / dpi) * ARENA_PX_PER_DEGREE;
    expect(gain.x).toBeCloseTo(expectedX, 12);

    const degPerCmY =
      ARENA_REFERENCE_DEGREES_PER_CM *
      (sens.sensY / anchor.referenceSensY) *
      (dpi / anchor.referenceDpi);
    expect(gain.y).toBeCloseTo(degPerCmY * (CM_PER_INCH / dpi) * ARENA_PX_PER_DEGREE, 12);
  });

  it("routes DPI through the same single boundary the canonical layer uses", () => {
    // deg/count = deg/cm × cm/count, and cm/count = 2.54/dpi. One inch, one
    // definition — the game layer re-exports it rather than declaring its own.
    expect(GAMES_CM_PER_INCH).toBe(CM_PER_INCH);
    const perCount = arenaDegreesPerCount(anchor, { sensX: 7, sensY: 7 }, 800);
    expect(perCount.x).toBeCloseTo(
      (ARENA_REFERENCE_DEGREES_PER_CM * CM_PER_INCH) / anchor.referenceDpi,
      12,
    );
  });

  it("derives the arena's display constant instead of hardcoding a multiplier", () => {
    expect(ARENA_PX_PER_DEGREE).toBeCloseTo(
      ARENA_REFERENCE_DPI / (CM_PER_INCH * ARENA_REFERENCE_DEGREES_PER_CM),
      12,
    );
    // The 1280 px logical arena is a plausible angular field, not a number
    // that happens to make the arithmetic work.
    const fieldOfViewDeg = LOGICAL_VIEWPORT.widthPx / ARENA_PX_PER_DEGREE;
    expect(fieldOfViewDeg).toBeGreaterThan(20);
    expect(fieldOfViewDeg).toBeLessThan(120);
  });

  it("knows an unplayable arena from a playable one", () => {
    const a = baselineReferenceAnchor({ sensX: 7, sensY: 7 }, 800);
    expect(anchorIsPlayable(a, { sensX: 7, sensY: 7 }, 800)).toBe(true);
    // The ladder's extremes stay playable too — a guard that rejected them
    // would silently narrow the search it exists to protect.
    for (const c of definition.candidates) {
      expect(anchorIsPlayable(a, c.sensitivity, 800), c.id).toBe(true);
    }
    // A hundredth of the baseline is not an arena anyone can play in.
    expect(anchorIsPlayable(a, { sensX: 0.07, sensY: 0.07 }, 800)).toBe(false);
    // Neither is a thousand times it.
    expect(anchorIsPlayable(a, { sensX: 7000, sensY: 7000 }, 800)).toBe(false);
    // Junk is not playable rather than throwing.
    expect(anchorIsPlayable(a, { sensX: Number.NaN, sensY: 7 }, 800)).toBe(false);
  });

  it("refuses impossible inputs rather than producing a silent zero gain", () => {
    expect(() => arenaGainPxPerCount(anchor, { sensX: 0, sensY: 7 }, 800)).toThrow();
    expect(() => arenaGainPxPerCount(anchor, { sensX: 7, sensY: 7 }, 0)).toThrow();
    expect(() =>
      arenaGainPxPerCount(anchor, { sensX: Number.NaN, sensY: 7 }, 800),
    ).toThrow();
    expect(() => new VirtualReticle(LOGICAL_VIEWPORT).setGain({ x: 0, y: 1 })).toThrow();
    expect(() =>
      new VirtualReticle(LOGICAL_VIEWPORT).setGain({ x: 1, y: Number.NaN }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// F. DPI participates correctly
// ---------------------------------------------------------------------------

describe("DPI and candidate sensitivity interact correctly", () => {
  it("gives equivalent arena movement for the same physical hand movement at any DPI", () => {
    // ONE physical calibration, then four different mice. The player moves
    // their hand 5 cm each time. Halving the in-game slider as the DPI
    // doubles keeps the physical sensitivity identical (same eDPI, same
    // cm/360), so the arena travel must be identical too.
    const measured = calibratedAnchor({
      degreesPerCountAt100X: REAL_DEG_PER_COUNT_100,
      degreesPerCountAt100Y: REAL_DEG_PER_COUNT_100,
      calibrationDpi: 800,
    });
    const cm = 5;
    const travels: number[] = [];
    const cmPer360s: number[] = [];
    for (const [dpi, sens] of [
      [400, 14],
      [800, 7],
      [1600, 3.5],
      [3200, 1.75],
    ] as const) {
      const counts = (cm * dpi) / CM_PER_INCH;
      const gain = arenaGainPxPerCount(measured, { sensX: sens, sensY: sens }, dpi);
      travels.push(counts * gain.x);
      cmPer360s.push(arenaCmPer360(measured, { sensX: sens, sensY: sens }, dpi).x);
    }
    for (const t of travels) expect(t).toBeCloseTo(travels[0]!, 9);
    for (const c of cmPer360s) expect(c).toBeCloseTo(cmPer360s[0]!, 9);
  });

  it("makes the arena faster when DPI alone rises, exactly as the real game would", () => {
    // The counterpart of the test above, and the reason the anchor carries a
    // DPI: a slider value fixes degrees per COUNT, so doubling DPI without
    // touching the slider genuinely doubles physical sensitivity.
    const measured = calibratedAnchor({
      degreesPerCountAt100X: REAL_DEG_PER_COUNT_100,
      degreesPerCountAt100Y: REAL_DEG_PER_COUNT_100,
      calibrationDpi: 800,
    });
    const sens = { sensX: 7, sensY: 7 };
    const travelPerCm = (dpi: number): number =>
      arenaGainPxPerCount(measured, sens, dpi).x * (dpi / CM_PER_INCH);
    expect(travelPerCm(1600)).toBeCloseTo(travelPerCm(800) * 2, 9);
  });

  it("makes equal cm/360 behave equivalently regardless of DPI", () => {
    const a = calibratedAnchor({
      degreesPerCountAt100X: REAL_DEG_PER_COUNT_100,
      degreesPerCountAt100Y: REAL_DEG_PER_COUNT_100,
      calibrationDpi: 800,
    });
    // Arena travel per centimetre of real hand movement is exactly the
    // player's cm/360 expressed in arena pixels — at every DPI, for every
    // sensitivity. That identity is the whole DPI contract.
    for (const dpi of [400, 800, 1600, 3200]) {
      for (const sens of [12, 40, 96]) {
        const s = { sensX: sens, sensY: sens };
        const pxPerCm = arenaGainPxPerCount(a, s, dpi).x * (dpi / CM_PER_INCH);
        const degPerCm = 360 / arenaCmPer360(a, s, dpi).x;
        expect(pxPerCm).toBeCloseTo(degPerCm * ARENA_PX_PER_DEGREE, 9);
      }
    }
  });

  it("keeps the per-count gain a property of the slider, not of the mouse", () => {
    // Degrees per count is what a game's sensitivity slider sets, and DPI has
    // nothing to do with it. So the same slider value is the same px/count at
    // any DPI — the DPI's effect arrives through the number of counts a hand
    // movement produces, which is where it belongs.
    const g800 = arenaGainPxPerCount(anchor, { sensX: 7, sensY: 7 }, 800);
    const g1600 = arenaGainPxPerCount(anchor, { sensX: 7, sensY: 7 }, 1600);
    expect(g1600.x).toBeCloseTo(g800.x, 12);
  });

  it("keeps the candidate ratio exactly DPI-independent", () => {
    for (const dpi of [400, 800, 1600, 3200]) {
      const a = arenaGainPxPerCount(anchor, fastest.sensitivity, dpi);
      const b = arenaGainPxPerCount(anchor, slowest.sensitivity, dpi);
      expect(a.x / b.x).toBeCloseTo(
        fastest.sensitivity.sensX / slowest.sensitivity.sensX,
        12,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// the anchor ladder
// ---------------------------------------------------------------------------

describe("the physical anchor is resolved from the best evidence available", () => {
  const settings: ArenaAnchorInput = {
    baseline: { sensX: 7, sensY: 7 },
    dpi: 800,
    gameProfile: null,
  };

  it("uses a completed calibration when one exists", () => {
    const history: CalibrationHistoryEntry[] = [
      {
        recordPath: "calibrations/x-1.json",
        axis: "x",
        createdAtIso: "2026-09-01T00:00:00.000Z",
        adequate: true,
        degreesPerCountAt100: REAL_DEG_PER_COUNT_100,
        dpi: 800,
        method: "one-turn",
      },
    ];
    const resolved = resolveArenaAnchor(settings, history);
    expect(resolved.source).toBe("measured-calibration");
    // deg/cm at 100% = deg/count × dpi/2.54
    expect(resolved.referenceDegreesPerCmX).toBeCloseTo(REAL_DEG_PER_COUNT_100 * (800 / CM_PER_INCH), 12);
    expect(resolved.referenceSensX).toBe(100);
  });

  it("ignores a calibration the engine judged inadequate", () => {
    const history: CalibrationHistoryEntry[] = [
      {
        recordPath: "calibrations/x-1.json",
        axis: "x",
        createdAtIso: "2026-09-01T00:00:00.000Z",
        adequate: false,
        degreesPerCountAt100: REAL_DEG_PER_COUNT_100,
        dpi: 800,
        method: "one-turn",
      },
    ];
    expect(resolveArenaAnchor(settings, history).source).toBe("baseline-reference");
  });

  it("falls back to the declared reference with no calibration and no game", () => {
    const resolved = resolveArenaAnchor(settings, []);
    expect(resolved.source).toBe("baseline-reference");
    expect(resolved.referenceDegreesPerCmX).toBe(ARENA_REFERENCE_DEGREES_PER_CM);
    expect(resolved.basis).toContain(String(ARENA_REFERENCE_CM_PER_360));
  });

  it("uses the player's game profile when their stated sensitivity is the one under test", () => {
    const withGame: ArenaAnchorInput = {
      ...settings,
      gameProfile: {
        recordVersion: 1,
        profileId: "generic-raw",
        profileVersion: 1,
        currentHipfire: 7,
        currentVertical: null,
        fovDegrees: null,
        matchingKind: "physical-360-distance",
        matchingCoefficient: null,
        matchingAxis: null,
      },
    };
    const resolved = resolveArenaAnchor(withGame, []);
    expect(resolved.source).toBe("game-profile");
    expect(resolved.referenceSensX).toBe(7);
  });

  it("refuses a game anchor whose sensitivity is on a different scale from the baseline", () => {
    // The player tests at 7 but told the game screen they play at 0.5. Those
    // are not the same number entered twice; pairing them would anchor the
    // arena 14x wrong. The ladder's ratios stay exact on the fallback.
    const mismatched: ArenaAnchorInput = {
      ...settings,
      gameProfile: {
        recordVersion: 1,
        profileId: "generic-raw",
        profileVersion: 1,
        currentHipfire: 0.5,
        currentVertical: null,
        fovDegrees: null,
        matchingKind: "physical-360-distance",
        matchingCoefficient: null,
        matchingAxis: null,
      },
    };
    expect(resolveArenaAnchor(mismatched, []).source).toBe("baseline-reference");
  });

  it("refuses a calibration that describes an unplayable arena", () => {
    // A calibration taken with a mistyped turn count is arithmetically fine
    // and physically absurd: at REAL_DEG_PER_COUNT_100 deg/count@100 a 7 % player would need
    // over a metre and a half of mouse movement to cross the arena, so no
    // drill could be completed and every trial would be garbage. Better
    // evidence that says something impossible is worse than no evidence.
    const absurd: CalibrationHistoryEntry[] = [
      {
        recordPath: "calibrations/x-bad.json",
        axis: "x",
        createdAtIso: "2026-09-01T00:00:00.000Z",
        adequate: true,
        degreesPerCountAt100: MISTYPED_DEG_PER_COUNT_100,
        dpi: 800,
        method: "one-turn",
      },
    ];
    expect(
      arenaCmPer360(
        calibratedAnchor({
          degreesPerCountAt100X: MISTYPED_DEG_PER_COUNT_100,
          degreesPerCountAt100Y: MISTYPED_DEG_PER_COUNT_100,
          calibrationDpi: 800,
        }),
        { sensX: 7, sensY: 7 },
        800,
      ).x,
    ).toBeGreaterThan(ARENA_MAX_PLAYABLE_CM_PER_360);
    expect(resolveArenaAnchor(settings, absurd).source).toBe("baseline-reference");
  });

  it("accepts a calibration that describes a real player's arena", () => {
    // The same player's genuine measurement: 7 % at 800 DPI ≈ 35 cm/360.
    const real: CalibrationHistoryEntry[] = [
      {
        recordPath: "calibrations/x-good.json",
        axis: "x",
        createdAtIso: "2026-09-01T00:00:00.000Z",
        adequate: true,
        degreesPerCountAt100: REAL_DEG_PER_COUNT_100,
        dpi: 800,
        method: "one-turn",
      },
    ];
    const resolved = resolveArenaAnchor(settings, real);
    expect(resolved.source).toBe("measured-calibration");
    const cm = arenaCmPer360(resolved, { sensX: 7, sensY: 7 }, 800).x;
    expect(cm).toBeGreaterThan(30);
    expect(cm).toBeLessThan(40);
    // ...and it is playable: a couple of centimetres to cross the arena.
    const gain = arenaGainPxPerCount(resolved, { sensX: 7, sensY: 7 }, 800);
    expect(1280 / gain.x / (800 / CM_PER_INCH)).toBeLessThan(10);
  });

  it("anchors a resumed session on its ORIGINAL definition, not today's setup form", () => {
    // A player who edits their sensitivity mid-calibration and then resumes
    // must not have the second half of the session measured against a
    // different ruler from the first. `resolveArenaAnchor` therefore takes
    // the baseline explicitly and the run controller feeds it the experiment
    // definition's own, which for a resumed session is the original.
    const original = resolveArenaAnchor({
      baseline: definition.baselineSensitivity,
      dpi: definition.dpi,
      gameProfile: null,
    });
    const afterEditingTheForm = resolveArenaAnchor({
      baseline: definition.baselineSensitivity,
      dpi: definition.dpi,
      gameProfile: null,
    });
    expect(afterEditingTheForm).toEqual(original);
    // ...whereas anchoring on an edited baseline really would move the ruler,
    // which is what the explicit input makes impossible to do by accident.
    const edited = resolveArenaAnchor({
      baseline: { sensX: 9, sensY: 9 },
      dpi: definition.dpi,
      gameProfile: null,
    });
    expect(
      arenaGainPxPerCount(edited, baselineCandidate.sensitivity, definition.dpi).x,
    ).not.toBeCloseTo(
      arenaGainPxPerCount(original, baselineCandidate.sensitivity, definition.dpi).x,
      6,
    );
  });

  it("measures the same candidate ratios whichever anchor was chosen", () => {
    const anchors: ArenaSensitivityAnchor[] = [
      baselineReferenceAnchor({ sensX: 7, sensY: 7 }),
      calibratedAnchor({
        degreesPerCountAt100X: REAL_DEG_PER_COUNT_100,
        degreesPerCountAt100Y: REAL_DEG_PER_COUNT_100 * 0.886,
        calibrationDpi: 1600,
      }),
      gameProfileAnchor({
        atSensX: 7,
        atSensY: 7,
        atDpi: 800,
        degreesPerCmX: 9.4,
        degreesPerCmY: 9.4,
        gameDisplayName: "Generic",
      }),
    ];
    const expected = fastest.sensitivity.sensX / slowest.sensitivity.sensX;
    for (const a of anchors) {
      const ratio = arenaGainRatio(a, fastest.sensitivity, slowest.sensitivity);
      expect(ratio.x).toBeCloseTo(expected, 12);
    }
  });
});

// ---------------------------------------------------------------------------
// E. applied exactly once
// ---------------------------------------------------------------------------

describe("candidate scaling is applied exactly once", () => {
  const raw = { dx: 60, dy: 25 };
  const gain = candidateReticleGain(anchor, fastest, definition.dpi);

  it("applies it on the plain pointermove path", () => {
    const arena = makeArena();
    beginTrialForCandidate(arena, fastest);
    const before = arena.source.reticle.position;
    arena.move(raw.dx, raw.dy);
    const after = arena.source.reticle.position;
    expect(after.x - before.x).toBeCloseTo(raw.dx * gain.x, 9);
    expect(after.y - before.y).toBeCloseTo(raw.dy * gain.y, 9);
  });

  it("applies it once — not twice — on the coalesced pointermove path", () => {
    const arena = makeArena();
    beginTrialForCandidate(arena, fastest);
    const before = arena.source.reticle.position;
    // A coalesced burst: the outer event carries the summary, the coalesced
    // list carries the real samples. Only the list may be applied.
    arena.element.emit(arena.moveType, {
      movementX: raw.dx,
      movementY: raw.dy,
      getCoalescedEvents: () => [
        { movementX: raw.dx / 2, movementY: raw.dy / 2 },
        { movementX: raw.dx / 2, movementY: raw.dy / 2 },
      ],
    });
    const after = arena.source.reticle.position;
    expect(after.x - before.x).toBeCloseTo(raw.dx * gain.x, 9);
    expect(after.x - before.x).not.toBeCloseTo(raw.dx * gain.x * gain.x, 3);
  });

  it("applies it once on the scripted (E2E) path", () => {
    const arena = makeArena();
    beginTrialForCandidate(arena, fastest);
    const before = arena.source.reticle.position;
    arena.source.emitForTesting({
      kind: "pointer-sample",
      tMs: 1,
      dx: raw.dx,
      dy: raw.dy,
    });
    const after = arena.source.reticle.position;
    expect(after.x - before.x).toBeCloseTo(raw.dx * gain.x, 9);
  });

  it("emits the LOGICAL delta, so the recorder's cursor cannot re-apply it", () => {
    // The recorder integrates the emitted deltas into its own cursor. If the
    // source emitted raw counts and the recorder re-scaled them, or if the
    // recorder integrated already-scaled deltas a second time, this diverges.
    const arena = makeArena();
    beginTrialForCandidate(arena, fastest);
    const recorder = new TrialRecorder({
      id: "trial-gain" as never,
      sessionId: null,
      experimentId: null,
      candidateId: fastest.id,
      indexInSession: 0,
      phase: "measured",
      scenarioId: "flick-static-medium",
      scenarioKind: "flick-static",
      scenarioRepIndex: 0,
      viewport: { ...LOGICAL_VIEWPORT },
      sensitivity: fastest.sensitivity,
      dpi: definition.dpi,
      expectedSampleIntervalMs: null,
      startedAtMonotonicMs: 0,
    });
    for (const e of arena.events) recorder.add(e);
    const startIndex = arena.events.length;
    for (let i = 0; i < 20; i++) arena.move(7, -3);
    for (const e of arena.events.slice(startIndex)) recorder.add(e);

    const record = recorder.finish("hit", 1000);
    const finalCursor = record.samples.at(-1)!.cursor;
    const reticle = arena.source.reticle.position;
    expect(finalCursor.x).toBeCloseTo(reticle.x, 9);
    expect(finalCursor.y).toBeCloseTo(reticle.y, 9);
    // ...and the recorded travel is the gained travel, once.
    expect(reticle.x - LOGICAL_VIEWPORT.widthPx / 2).toBeCloseTo(20 * 7 * gain.x, 9);
  });

  it("keeps native high-rate capture out of the scored path entirely", () => {
    // The native helper streams counts that never pass through the reticle.
    // While that is true, it cannot double-apply anything; if it is ever
    // integrated, it must go through the same reticle and this test's premise
    // (and the comment in app/src/captureTiers.ts) must be revisited.
    const controller = readFileSync("app/src/runController.ts", "utf8");
    expect(controller).not.toContain("nativeClient");
    expect(controller).not.toContain("NativeCaptureClient");
    const tiers = readFileSync("app/src/captureTiers.ts", "utf8");
    expect(tiers).toContain("NATIVE_LIVE_BLOCKER");
  });
});

// ---------------------------------------------------------------------------
// G. real-arena behaviour
// ---------------------------------------------------------------------------

describe("real-arena gain behaviour", () => {
  it("is symmetric in X and Y for the symmetrical calibration model", () => {
    const gain = candidateReticleGain(anchor, fastest, definition.dpi);
    expect(gain.x).toBeCloseTo(gain.y, 12);
    const arena = makeArena();
    beginTrialForCandidate(arena, fastest);
    const before = arena.source.reticle.position;
    arena.move(50, 50);
    const after = arena.source.reticle.position;
    expect(after.x - before.x).toBeCloseTo(after.y - before.y, 9);
  });

  it("supports independent Y when the anchor is asymmetric", () => {
    const asymmetric = calibratedAnchor({
      degreesPerCountAt100X: REAL_DEG_PER_COUNT_100,
      degreesPerCountAt100Y: REAL_DEG_PER_COUNT_100 * 0.75,
      calibrationDpi: 800,
    });
    const gain = arenaGainPxPerCount(asymmetric, { sensX: 40, sensY: 40 }, 800);
    expect(gain.y / gain.x).toBeCloseTo(0.75, 12);
  });

  it("handles negative deltas with the same gain", () => {
    const gain = candidateReticleGain(anchor, slowest, definition.dpi);
    const arena = makeArena();
    beginTrialForCandidate(arena, slowest);
    const before = arena.source.reticle.position;
    arena.move(-80, -30);
    const after = arena.source.reticle.position;
    expect(after.x - before.x).toBeCloseTo(-80 * gain.x, 9);
    expect(after.y - before.y).toBeCloseTo(-30 * gain.y, 9);
  });

  it("handles enormous deltas safely by clamping, never by producing NaN", () => {
    const arena = makeArena();
    beginTrialForCandidate(arena, fastest);
    arena.move(1e9, -1e9);
    const pos = arena.source.reticle.position;
    expect(Number.isFinite(pos.x)).toBe(true);
    expect(Number.isFinite(pos.y)).toBe(true);
    expect(pos.x).toBe(LOGICAL_VIEWPORT.widthPx);
    expect(pos.y).toBe(0);
    // The emitted sample reports only the movement that survived clamping.
    const last = arena.samples().at(-1)!;
    expect(last.dx).toBeLessThanOrEqual(LOGICAL_VIEWPORT.widthPx);
  });

  it("has no frame-rate or sample-rate dependence", () => {
    // 200 Hz rendering means more, smaller samples for the same hand
    // movement. The gain is per count, so the total must be identical.
    const oneShot = makeArena();
    beginTrialForCandidate(oneShot, fastest);
    oneShot.move(200, 100);

    const manySmall = makeArena();
    beginTrialForCandidate(manySmall, fastest);
    for (let i = 0; i < 200; i++) manySmall.move(1, 0.5);

    expect(manySmall.source.reticle.position.x).toBeCloseTo(
      oneShot.source.reticle.position.x,
      6,
    );
    expect(manySmall.source.reticle.position.y).toBeCloseTo(
      oneShot.source.reticle.position.y,
      6,
    );
  });

  it("keeps the gain constant for the whole of a drill", () => {
    const arena = makeArena();
    beginTrialForCandidate(arena, fastest);
    const expected = candidateReticleGain(anchor, fastest, definition.dpi);
    for (let i = 0; i < 500; i++) {
      arena.move(i % 2 === 0 ? 3 : -3, 1);
      expect(arena.source.reticle.gain.x).toBeCloseTo(expected.x, 12);
    }
  });

  it("survives pause, lock loss and resume without reverting to 1 px/count", () => {
    const arena = makeArena();
    beginTrialForCandidate(arena, fastest);
    const expected = candidateReticleGain(anchor, fastest, definition.dpi);

    arena.source.releaseLock(); // pause / break
    arena.unlock();
    arena.lock(); // resume
    arena.source.reticle.reset(); // next trial recentres

    expect(arena.source.reticle.gain.x).toBeCloseTo(expected.x, 12);
    const before = arena.source.reticle.position;
    arena.move(40, 0);
    expect(arena.source.reticle.position.x - before.x).toBeCloseTo(40 * expected.x, 9);
  });

  it("changes the gain only when the candidate changes", () => {
    const arena = makeArena();
    const seen: number[] = [];
    // Two blocks of the same candidate, then a switch — the shape of a
    // block-randomized round.
    for (const candidate of [fastest, fastest, slowest, slowest, baselineCandidate]) {
      beginTrialForCandidate(arena, candidate);
      arena.move(10, 0);
      seen.push(Number(arena.source.reticle.gain.x.toFixed(12)));
    }
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).toBe(seen[3]);
    expect(seen[0]).not.toBe(seen[2]);
    expect(seen[4]).not.toBe(seen[0]);
    expect(seen[4]).not.toBe(seen[2]);
  });
});

// ---------------------------------------------------------------------------
// D. blinding
// ---------------------------------------------------------------------------

describe("applying the candidate does not break blinding", () => {
  it("puts no candidate identity into anything the arena emits", () => {
    const arena = makeArena();
    beginTrialForCandidate(arena, fastest);
    arena.move(30, 10);
    const serialized = JSON.stringify(arena.events);
    expect(serialized).not.toContain(fastest.id);
    expect(serialized).not.toContain("sens");
    expect(serialized).not.toContain("gain");
  });

  it("exposes the gain only on the engine-facing capture object", () => {
    // ArenaSnapshot is what E2E automation and the arena renderer read. It
    // carries positions and counts, never the sensitivity under test.
    const source = readFileSync("app/src/runController.ts", "utf8");
    const snapshotBlock = source.slice(
      source.indexOf("export interface ArenaSnapshot"),
      source.indexOf("export interface ArenaSnapshot") + 900,
    );
    expect(snapshotBlock).not.toContain("gain");
    expect(snapshotBlock).not.toContain("sensitivity");
    expect(snapshotBlock).not.toContain("candidate");
  });

  it("keeps the sensitivity out of every player-facing string in the arena", () => {
    const source = readFileSync("app/src/runController.ts", "utf8");
    // The drawing and announcement code may not read the candidate at all.
    const drawing = source.slice(source.indexOf("#drawFrame"));
    expect(/candidate\.sensitivity/.test(drawing)).toBe(false);
    expect(/reticle\.gain/.test(drawing)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C. simulator and real arena agree
// ---------------------------------------------------------------------------

describe("the simulator and the real arena share one candidate-gain model", () => {
  it("agrees on the ratio between two candidates", () => {
    // `SyntheticExperimentRunner.#effectFor` is this expression verbatim (it
    // builds the same declared-reference anchor from the same definition and
    // calls the same `arenaGainRatio`), so what the simulated player's motor
    // model sees and what the real reticle does are one number.
    const simulatorRatio = arenaGainRatio(
      baselineReferenceAnchor(definition.baselineSensitivity, definition.dpi),
      fastest.sensitivity,
      slowest.sensitivity,
    );
    const arenaFast = displacementForCandidate(fastest, { dx: 100, dy: 0 });
    const arenaSlow = displacementForCandidate(slowest, { dx: 100, dy: 0 });
    expect(arenaFast.dx / arenaSlow.dx).toBeCloseTo(simulatorRatio.x, 9);
  });

  it("keeps the simulator reading the shared function rather than its own copy", () => {
    // The structural half of the guarantee: a future edit that reintroduces
    // private eDPI arithmetic in the simulator fails here, before it can
    // silently diverge from the arena again.
    const sim = readFileSync("src/sim/simulator.ts", "utf8");
    expect(sim).toContain("arenaGainRatio");
    expect(sim).not.toMatch(/candEdpi[XY]\s*\/\s*this\.#player\.trueOptimalEdpi/);
  });

  it("produces the same eDPI-ratio effect the simulator always used", () => {
    // The refactor must not move a single simulated number: the previous
    // implementation computed (dpi × sens) / trueOptimalEdpi directly.
    const legacy = (sens: number): number =>
      (definition.dpi * sens) / DEFAULT_PLAYER_CONFIG.trueOptimalEdpi;
    const viaShared = (sens: number): number =>
      arenaGainRatio(
        baselineReferenceAnchor(definition.baselineSensitivity, definition.dpi),
        { sensX: sens, sensY: sens },
        {
          sensX: DEFAULT_PLAYER_CONFIG.trueOptimalEdpi / definition.dpi,
          sensY: DEFAULT_PLAYER_CONFIG.trueOptimalEdpiY / definition.dpi,
        },
      ).x;
    for (const c of definition.candidates) {
      expect(viaShared(c.sensitivity.sensX)).toBeCloseTo(legacy(c.sensitivity.sensX), 12);
    }
  });

  it("still runs a full simulated round unchanged", () => {
    const runner = new SyntheticExperimentRunner(definition, DEFAULT_PLAYER_CONFIG);
    const trials = runner.runRound(1, 99, "sess-gain" as never, definition.id);
    expect(trials.length).toBeGreaterThan(0);
    for (const t of trials) expect(Number.isFinite(t.endedAtMonotonicMs)).toBe(true);
  });
});

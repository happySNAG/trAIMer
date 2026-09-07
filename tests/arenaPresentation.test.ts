import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ScenarioDirector } from "../src/scenarios/director.ts";
import { scenarioById } from "../src/domain/scenario.ts";
import { planScenarioInstance, createInstanceRng } from "../src/scenarios/planner.ts";
import { trialRequest } from "./arenaHarness.ts";

/**
 * ARENA PRESENTATION (Pass 13, requirements 2/3/9/11).
 *
 * Two guarantees, both of which must hold no matter how good the game feel
 * gets:
 *
 *   1. THE SHOT IS RECORDED FIRST. Sound, hit markers, muzzle flashes and
 *      streaks are consequences of a measurement that has already happened.
 *      Nothing presentational may run before `recorder.add(event)`, and
 *      nothing presentational may feed back into hit detection or geometry.
 *   2. TRACKING IS NOT SHOT AT. Its target survives clicks, its window is not
 *      shortened by them, and its feedback never dresses a click up as a shot.
 *
 * The ordering guarantee is enforced statically against the controller source
 * (the same style as the desktop-shell contract suite): a runtime assertion
 * cannot prove that no future edit moves an effect above the recorder call,
 * but reading the handler can.
 */

const controllerSource = readFileSync("app/src/runController.ts", "utf8");

/** The body of `#handleCaptureEvent`, where a shot becomes a measurement. */
function captureEventHandler(): string {
  const start = controllerSource.indexOf("#handleCaptureEvent(event: CaptureEvent): void {");
  expect(start).toBeGreaterThan(-1);
  const rest = controllerSource.slice(start);
  const end = rest.indexOf("\n  #startRenderLoop(");
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe("the shot is recorded before anything is presented", () => {
  it("recorder.add() precedes every effect and every sound in the event handler", () => {
    const handler = captureEventHandler();
    const recordAt = handler.indexOf("active.recorder.add(event);");
    expect(recordAt).toBeGreaterThan(-1);

    for (const presentation of [
      "this.#audio.shot()",
      "this.#audio.hit(",
      "this.#audio.miss()",
      "this.#fx.muzzleAt(",
      "this.#fx.hitMarkerAt(",
      "this.#fx.missAt(",
      "this.#streak++",
    ]) {
      const at = handler.indexOf(presentation);
      expect(at, `${presentation} must appear in the handler`).toBeGreaterThan(-1);
      expect(
        at,
        `${presentation} runs BEFORE the shot is recorded — presentation must never precede measurement`,
      ).toBeGreaterThan(recordAt);
    }
  });

  it("hit and miss feedback are chosen from the RECORDED shot, not from the reticle", () => {
    const handler = captureEventHandler();
    // The branch condition reads the recorder's own verdict.
    expect(handler).toContain("const latest = active.recorder.state.latestShot;");
    expect(handler).toContain("latest?.hit");
    expect(handler).toContain("latest && !latest.hit");
    // Nothing in the handler re-derives a hit from geometry.
    expect(handler).not.toMatch(/Math\.hypot\([^)]*radius/);
  });

  it("the effect layer is bounded and clears at every drill boundary", () => {
    expect(controllerSource).toContain("static readonly MAX = 24;");
    // Every push site trims to MAX.
    const pushes = controllerSource.match(/if \(this\.#(bursts|ripples|marks)\.length > ArenaFx\.MAX\)/g);
    expect(pushes?.length).toBeGreaterThanOrEqual(5);
    expect(controllerSource).toContain("this.#fx.clear();");
  });

  it("no screen shake, no weapon model: nothing moves the aiming reference", () => {
    // A canvas translate/rotate around the whole frame would move the world
    // under the crosshair. The only save/restore/rotate in the arena belongs
    // to the tracking target's own collar and the HUD text.
    const drawFrame = controllerSource.slice(
      controllerSource.indexOf("#drawFrame("),
      controllerSource.indexOf("// Arena presentation helpers"),
    );
    expect(drawFrame).not.toContain("ctx.translate(");
    expect(drawFrame).not.toContain("ctx.rotate(");
    expect(drawFrame).not.toContain("ctx.scale(");
  });
});

describe("tracking is followed, not shot", () => {
  const scenario = scenarioById("tracking-smooth-sine");

  function makeDirector() {
    const instance = planScenarioInstance(
      scenario,
      { widthPx: 1280, heightPx: 720 },
      createInstanceRng({ experimentSeed: 5, round: 0, scenarioId: scenario.id, repIndex: 0 }),
    );
    const director = new ScenarioDirector(trialRequest(scenario, "track"), instance);
    director.start(0);
    return director;
  }

  it("the scenario declares that a hit does NOT remove its target", () => {
    expect(makeDirector().removesTargetOnHit).toBe(false);
    for (const id of ["flick-static-medium", "flick-static-small", "flick-dynamic-horizontal", "target-switch-triple"]) {
      const other = scenarioById(id);
      const instance = planScenarioInstance(
        other,
        { widthPx: 1280, heightPx: 720 },
        createInstanceRng({ experimentSeed: 5, round: 0, scenarioId: other.id, repIndex: 0 }),
      );
      expect(new ScenarioDirector(trialRequest(other, "shoot"), instance).removesTargetOnHit).toBe(
        true,
      );
    }
  });

  it("completes on its clock with no click at all, and stays visible the whole time", () => {
    const director = makeDirector();
    const duration = director.durationMs;
    expect(duration).toBeGreaterThan(1000);
    let sawTargetAtEveryStep = true;
    for (let t = 0; t < duration - 100; t += 100) {
      const status = director.tick(t);
      expect(status.finished).toBe(false);
      if (director.recorder.activeTargetsAt(t).length === 0) sawTargetAtEveryStep = false;
    }
    expect(sawTargetAtEveryStep).toBe(true);
    expect(director.tick(duration).finished).toBe(true);
    expect(director.recorder.state.shotCount).toBe(0);
  });

  it("clicks do not remove the target, do not end the trial, and do not need a second click", () => {
    const director = makeDirector();
    const duration = director.durationMs;
    director.tick(0);
    // Ten clicks straight through the middle of the drill.
    for (let i = 0; i < 10; i++) {
      const t = 200 + i * 100;
      director.tick(t);
      director.recorder.add({ kind: "button", tMs: t, action: "press" });
      // A live target is still on screen after every one of them.
      expect(director.recorder.activeTargetsAt(t).length).toBeGreaterThan(0);
      expect(director.tick(t).finished).toBe(false);
    }
    // The drill still ends on its own clock, at the same moment it would have.
    expect(director.tick(duration - 200).finished).toBe(false);
    expect(director.tick(duration).finished).toBe(true);
    // Every click was RECORDED (behavioural data), just not acted on.
    expect(director.recorder.state.shotCount).toBe(10);
    expect(
      director.recorder.state.spawnedTargets.some((t) => t.removalReason === "hit"),
    ).toBe(false);
  });

  it("the controller suppresses shot feedback during tracking and shows a hint instead", () => {
    const handler = captureEventHandler();
    expect(handler).toContain('const isTracking = this.#activeScenario?.kind === "tracking";');
    const trackingBranch = handler.slice(
      handler.indexOf("if (isTracking) {"),
      handler.indexOf("} else {", handler.indexOf("if (isTracking) {")),
    );
    // No shot sound, no hit marker, no miss ripple, no streak in that branch.
    for (const forbidden of ["#audio.shot", "#audio.hit", "#audio.miss", "hitMarkerAt", "missAt", "#streak++"]) {
      expect(trackingBranch).not.toContain(forbidden);
    }
    expect(trackingBranch).toContain("this.#trackingClicks++");
  });

  it("the drill's instruction says, in words, not to shoot", () => {
    expect(controllerSource).toContain(
      "tracking: \"Keep your crosshair on the target — don't shoot.\"",
    );
    expect(controllerSource).toContain('tracking: "track"');
    expect(controllerSource).toContain("Keep your crosshair on the target — don't shoot");
    expect(controllerSource).toContain("No need to shoot — just stay on it");
    expect(controllerSource).toContain("TRACK COMPLETE");
  });

  it("the tracking HUD reports time remaining and on-target state", () => {
    expect(controllerSource).toContain("remainingMs");
    expect(controllerSource).toContain('"ON TARGET"');
    expect(controllerSource).toContain('"OFF TARGET"');
    expect(controllerSource).toContain("onTargetRatio");
  });
});

import { ScenarioDirector } from "../src/scenarios/director.ts";
import { createInstanceRng, planScenarioInstance } from "../src/scenarios/planner.ts";
import type { ScenarioDefinition } from "../src/domain/scenario.ts";
import type { TrialRecordingRequest } from "../src/capture/recorder.ts";
import type { TargetId } from "../src/domain/ids.ts";

/**
 * The arena, as the run controller drives it.
 *
 * These helpers mirror `BrowserRunController` exactly — the shot path, the
 * hit-removal rule, and the frame loop — so drill tests exercise the same
 * behaviour the player gets instead of a parallel re-implementation that can
 * drift away from it.
 */

export const VIEWPORT = { widthPx: 1280, heightPx: 720 };

export function trialRequest(
  def: ScenarioDefinition,
  id: string,
  viewport = VIEWPORT,
): TrialRecordingRequest {
  return {
    id: id as never,
    sessionId: null,
    experimentId: null,
    candidateId: null,
    indexInSession: 0,
    phase: "measured",
    scenarioId: def.id,
    scenarioKind: def.kind,
    scenarioRepIndex: 0,
    viewport,
    sensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    expectedSampleIntervalMs: null,
    startedAtMonotonicMs: 1000,
  };
}

export function directorFor(
  def: ScenarioDefinition,
  seed: number,
  id = `${def.id}-${seed}`,
  viewport = VIEWPORT,
  startAt = 1000,
): ScenarioDirector {
  const instance = planScenarioInstance(
    def,
    viewport,
    createInstanceRng({ experimentSeed: seed, round: 0, scenarioId: def.id, repIndex: 0 }),
  );
  const director = new ScenarioDirector(trialRequest(def, id, viewport), instance);
  director.start(startAt);
  return director;
}

/**
 * A left-button press, handled exactly as BrowserRunController#handleCaptureEvent
 * handles it — including the rule that only click-to-hit drills remove the
 * target they hit (`director.removesTargetOnHit`).
 */
export function shoot(director: ScenarioDirector, t: number): boolean {
  director.recorder.add({ kind: "button", tMs: t, action: "press" });
  const latest = director.recorder.state.latestShot;
  if (director.removesTargetOnHit && latest?.hit && latest.aimTargetId) {
    director.recorder.add({
      kind: "target-remove",
      tMs: latest.tMs + 1,
      targetId: latest.aimTargetId as TargetId,
      reason: "hit",
    });
    director.observeRemoval(latest.tMs + 1);
    return true;
  }
  return latest?.hit ?? false;
}

/** Moves the recorder cursor onto a point in one sample. */
export function aimAt(
  director: ScenarioDirector,
  cursor: { x: number; y: number },
  target: { x: number; y: number },
  t: number,
): void {
  director.recorder.add({
    kind: "pointer-sample",
    tMs: t,
    dx: target.x - cursor.x,
    dy: target.y - cursor.y,
  });
  cursor.x = target.x;
  cursor.y = target.y;
}

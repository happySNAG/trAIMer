import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  nextSessionState,
  TRANSITIONS,
  SESSION_STATES,
  type SessionState,
} from "../src/session/stateMachine.ts";

describe("session state machine", () => {
  it("covers all declared states in the transition table", () => {
    for (const state of SESSION_STATES) {
      expect(TRANSITIONS[state]).toBeDefined();
    }
  });

  it("walks the nominal happy path", () => {
    let state: SessionState = "idle";
    const steps: [SessionState, Parameters<typeof nextSessionState>[1]][] = [
      ["setup", "CONFIGURE"],
      ["awaiting-lock", "REQUEST_LOCK"],
      ["candidate-transition", "LOCK_ACQUIRED"],
      ["warmup", "BEGIN_WARMUP"],
      ["trial-ready", "WARMUP_ENDED"],
      ["trial-active", "TRIAL_STARTED"],
      ["inter-trial", "TRIAL_COMPLETED"],
      ["trial-ready", "NEXT_TRIAL_READY"],
      ["analyzing", "ALL_TRIALS_DONE"],
      ["complete", "ANALYSIS_COMPLETE"],
    ];
    for (const [expected, event] of steps) {
      const next = nextSessionState(state, event);
      expect(next).not.toBeNull();
      expect(next).toBe(expected);
      state = next!;
    }
  });

  it("supports rest between candidate blocks and returning", () => {
    let state: SessionState = "inter-trial";
    state = nextSessionState(state, "REST_STARTED")!;
    expect(state).toBe("rest");
    state = nextSessionState(state, "REST_ENDED")!;
    expect(state).toBe("inter-trial");
  });

  it("supports pause from an active trial and resume to inter-trial", () => {
    let state: SessionState = "trial-active";
    state = nextSessionState(state, "PAUSE")!;
    expect(state).toBe("paused");
    state = nextSessionState(state, "RESUME")!;
    expect(state).toBe("inter-trial");
  });

  it("allows cancellation from every live state", () => {
    for (const state of SESSION_STATES) {
      if (state === "complete" || state === "aborted") continue;
      expect(nextSessionState(state, "CANCEL")).toBe("aborted");
    }
  });

  it("treats lock loss during a trial as fatal interruption to inter-trial (record preserved)", () => {
    const state = nextSessionState("trial-active", "LOCK_LOST");
    expect(state).toBe("inter-trial");
  });

  it("returns null for illegal transitions (runner surfaces IllegalTransitionError)", () => {
    expect(nextSessionState("idle", "TRIAL_STARTED")).toBeNull();
    expect(() => {
      const result = nextSessionState("idle", "TRIAL_STARTED");
      if (result === null) throw new IllegalTransitionError("idle", "TRIAL_STARTED");
    }).toThrow(IllegalTransitionError);
  });

  it("throws IllegalTransitionError for unknown mappings via runner helper", () => {
    expect(() => {
      const result = nextSessionState("complete", "CONFIGURE");
      if (result === null) throw new IllegalTransitionError("complete", "CONFIGURE");
    }).toThrow(IllegalTransitionError);
  });

  it("terminal states accept no events", () => {
    for (const event of Object.keys(TRANSITIONS.complete)) {
      void event;
    }
    expect(Object.keys(TRANSITIONS.complete)).toHaveLength(0);
    expect(Object.keys(TRANSITIONS.aborted)).toHaveLength(0);
  });
});

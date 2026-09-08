/**
 * E2E test adapter (requirement P).
 *
 * Headless automation cannot grant real Pointer Lock. This adapter is loaded
 * ONLY when the app boots with `?e2e=1` and replaces the lock acquisition
 * path with a synthetic grant while feeding scripted CaptureEvents through
 * the SAME production PointerLockCaptureSource event plumbing
 * (emitForTesting) — no production capture code is forked.
 */
import type { ArenaSnapshot, BrowserRunController } from "./runController.ts";
import type { Recommendation } from "../../src/domain/recommendation.ts";
import type { FinalResult } from "../../src/results/finalResult.ts";
import type { SessionOutcomeReport } from "../../src/results/sessionOutcome.ts";
import { GAME_PROFILE_REGISTRY } from "../../src/games/index.ts";
import { availableMatching, conversionUsesFov } from "../../src/games/convert.ts";

interface TestHooks {
  mode: "virtual";
  injectPointerSample(dx: number, dy: number): void;
  injectClick(): void;
  /**
   * Read-only arena state, so the scripted player can AIM rather than sweep
   * blindly. Without it the synthetic player never hit anything and every
   * trial it produced was rejected by the validator.
   */
  arenaSnapshot(): Promise<ArenaSnapshot | null>;
  /** Presentation state (streaks, tracking completion) for arena-feel specs. */
  presentationState(): Promise<{
    streak: number;
    bestStreak: number;
    trackingClicks: number;
    effectCount: number;
    lastTrackingCompletion: {
      onTargetRatio: number;
      clicks: number;
      completedAtMs: number;
    } | null;
  }>;
  grantLock(): void;
  releaseLock(): void;
  /** Simulates ESC/unlock mid-trial through the production capture path. */
  simulateLockLoss(): void;
  /**
   * Renders an engine-produced recommendation/final-result through the REAL
   * results view (result-state torture automation). Test-only.
   */
  renderResultsForTesting(payload: {
    recommendation: Recommendation | null;
    finalResult: FinalResult | null;
    trialsAnalyzed: number;
    /** The full session report, so the player-facing screen can be driven. */
    outcome?: SessionOutcomeReport | null;
  }): void;
}

/** One public profile, as the registry declares it. Read-only; test-only. */
export interface GameProfileDeclarationForTesting {
  id: string;
  displayName: string;
  status: string;
  visibility: string;
  profileVersion: number;
  hasVerticalField: boolean;
  showsFovInput: boolean;
  matchingChoices: number;
  sampleHipfire: number;
}

declare global {
  interface Window {
    __ALDO_TEST_HOOKS__?: TestHooks;
    /**
     * What the game-profile registry declares, installed at boot under
     * `?e2e=1` so the installed-app picker gate can check the picker against
     * the engine's own data without starting a session (Pass 3,
     * requirement 10).
     */
    __ALDO_GAME_PROFILES_FOR_TESTING__?: () => GameProfileDeclarationForTesting[];
  }
}

/** Installs the read-only registry hook. Test mode only; never converts. */
export function installGameProfileHook(): void {
  window.__ALDO_GAME_PROFILES_FOR_TESTING__ = () =>
    GAME_PROFILE_REGISTRY.selectable().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      status: p.status,
      visibility: p.visibility,
      profileVersion: p.profileVersion,
      hasVerticalField: p.axes.independentAxes && p.axes.verticalField !== null,
      showsFovInput: conversionUsesFov(p),
      matchingChoices: availableMatching(p).length,
      // A value inside the game's own range, for typing into the picker.
      sampleHipfire: Number(
        (
          p.hipfireField.entry.min +
          (p.hipfireField.entry.max - p.hipfireField.entry.min) * 0.1
        ).toFixed(p.hipfireField.entry.uiDecimals),
      ),
    }));
}

export interface TestHookExtras {
  renderResultsForTesting(payload: {
    recommendation: Recommendation | null;
    finalResult: FinalResult | null;
    trialsAnalyzed: number;
    outcome?: SessionOutcomeReport | null;
  }): void;
}

export function installTestHooks(
  controllerPromise: Promise<BrowserRunController>,
  extras?: TestHookExtras,
): void {
  void controllerPromise.then((c) => {
    (window as unknown as { __ALDO_CONTROLLER__?: BrowserRunController }).__ALDO_CONTROLLER__ = c;
  });
  const hooks: TestHooks = {
    mode: "virtual",
    async injectPointerSample(dx, dy) {
      const controller = await controllerPromise;
      controller.emitForTesting({
        kind: "pointer-sample",
        tMs: performance.now(),
        dx,
        dy,
      });
    },
    async injectClick() {
      const controller = await controllerPromise;
      controller.emitForTesting({
        kind: "button",
        tMs: performance.now(),
        action: "press",
      });
    },
    async arenaSnapshot() {
      const controller = await controllerPromise;
      return controller.arenaSnapshot;
    },
    async presentationState() {
      const controller = await controllerPromise;
      return controller.presentationDebug;
    },
    async grantLock() {
      const controller = await controllerPromise;
      controller.simulateLockAcquired();
    },
    async releaseLock() {
      const controller = await controllerPromise;
      controller.releaseCaptureForTesting();
    },
    async simulateLockLoss() {
      const controller = await controllerPromise;
      // Flows through emitForTesting → the exact production fatal-interruption
      // handler (recorder abort + session cancel), unlike releaseLock which
      // relies on a real pointerlockchange DOM event.
      controller.emitForTesting({
        kind: "lock-change",
        tMs: performance.now(),
        locked: false,
        reason: "pointer-lock-loss",
      });
    },
    renderResultsForTesting(payload) {
      if (!extras) throw new Error("renderResultsForTesting requires extras");
      extras.renderResultsForTesting(payload);
    },
  };
  window.__ALDO_TEST_HOOKS__ = hooks;
}

export function testModeEnabled(): boolean {
  return typeof window !== "undefined" && window.location.search.includes("e2e=1");
}

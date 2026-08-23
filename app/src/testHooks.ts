/**
 * E2E test adapter (requirement P).
 *
 * Headless automation cannot grant real Pointer Lock. This adapter is loaded
 * ONLY when the app boots with `?e2e=1` and replaces the lock acquisition
 * path with a synthetic grant while feeding scripted CaptureEvents through
 * the SAME production PointerLockCaptureSource event plumbing
 * (emitForTesting) — no production capture code is forked.
 */
import type { BrowserRunController } from "./runController.ts";

interface TestHooks {
  mode: "virtual";
  injectPointerSample(dx: number, dy: number): void;
  injectClick(): void;
  grantLock(): void;
  releaseLock(): void;
}

declare global {
  interface Window {
    __ALDO_TEST_HOOKS__?: TestHooks;
  }
}

export function installTestHooks(controllerPromise: Promise<BrowserRunController>): void {
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
    async grantLock() {
      const controller = await controllerPromise;
      controller.simulateLockAcquired();
    },
    async releaseLock() {
      const controller = await controllerPromise;
      controller.releaseCaptureForTesting();
    },
  };
  window.__ALDO_TEST_HOOKS__ = hooks;
}

export function testModeEnabled(): boolean {
  return typeof window !== "undefined" && window.location.search.includes("e2e=1");
}

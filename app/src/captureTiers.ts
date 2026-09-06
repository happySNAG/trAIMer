/**
 * What capture path this session actually runs on, and why the others were
 * not used.
 *
 * The run screen used to print a hardcoded "browser capture · pointer lock"
 * caption. That string happened to be true, but it could not have been false:
 * nothing in the live path ever consulted the native helper, so the caption
 * could not have told a player that high-rate capture was available and idle.
 * This module produces the caption from observed facts instead.
 *
 * Tier policy (docs/CAPTURE.md): 1. validated native high-rate →
 * 2. browser coalesced pointer events → 3. basic mouse events.
 */
import {
  detectPointerEventCapabilities,
  type PointerEventCapabilities,
} from "../../src/capture/browserSource.ts";
import type { CaptureSelfTestResult } from "../../src/diagnostics/captureSelfTest.ts";
import type { LocalJsonStore } from "../../src/persistence/store.ts";
import { desktopBridge } from "./desktopBridge.ts";

/**
 * Why tier 1 is not the live measurement transport yet, even on a machine
 * whose helper is ready.
 *
 * The helper timestamps frames with milliseconds since ITS OWN start
 * (QueryPerformanceCounter origin). The recorder compares sample times with
 * target spawn times, which come from the renderer's `performance.now()`
 * origin. Feeding one clock's samples into the other's timeline would shift
 * every reaction time by an unknown constant — silently, and in a direction
 * nothing downstream could detect. Aligning the two origins is a measurement
 * change, not a UI change, and is deliberately not part of this pass.
 */
export const NATIVE_LIVE_BLOCKER =
  "helper and renderer clock origins are not aligned yet (docs/NATIVE-CAPTURE.md)";

export interface CaptureTierReport {
  /** The tier actually producing measured samples this session. */
  activeTier: 1 | 2 | 3;
  activeKind: "native" | "browser-pointer-lock";
  /** Short caption for the run screen. */
  caption: string;
  /** Long-form explanation (tooltip / diagnostics log). */
  detail: string;
  native: {
    /** A desktop shell is present (the helper can exist at all). */
    shellPresent: boolean;
    platformSupported: boolean;
    helperState: string;
    /** Helper is up and serving on loopback. */
    helperReady: boolean;
    /** A capture self-test proved the stream, per docs/CAPTURE.md tier-1 rule. */
    validatedByDiagnostics: boolean;
    /** Why tier 1 is not carrying this session, or null when it is. */
    rejectedBecause: string | null;
  };
  browser: PointerEventCapabilities;
}

/**
 * Pure decision function so the tier policy is testable without a DOM, a
 * shell, or a helper.
 */
export function decideCaptureTier(input: {
  shellPresent: boolean;
  platformSupported: boolean;
  helperState: string;
  selfTest: Pick<CaptureSelfTestResult, "verdict" | "sourceKind"> | null;
  browser: PointerEventCapabilities;
  /** Set only once native frames can share the renderer's clock origin. */
  nativeLiveTransportEnabled: boolean;
}): CaptureTierReport {
  const helperReady = input.shellPresent && input.helperState === "ready";
  const validatedByDiagnostics =
    input.selfTest !== null &&
    input.selfTest.sourceKind === "native" &&
    input.selfTest.verdict === "pass";

  let rejectedBecause: string | null = null;
  if (!input.shellPresent) {
    rejectedBecause = "not running in the desktop shell";
  } else if (!input.platformSupported) {
    rejectedBecause = "no native capture helper for this platform";
  } else if (!helperReady) {
    rejectedBecause = `capture helper is ${input.helperState}, not ready`;
  } else if (!validatedByDiagnostics) {
    rejectedBecause =
      "helper is ready but unvalidated — run the capture check in Diagnostics";
  } else if (!input.nativeLiveTransportEnabled) {
    rejectedBecause = NATIVE_LIVE_BLOCKER;
  }

  if (rejectedBecause === null) {
    return {
      activeTier: 1,
      activeKind: "native",
      caption: "native capture · raw input",
      detail:
        "Measured samples come from the local Aldo capture helper (Windows Raw Input). The mouse stays locked to the arena.",
      native: {
        shellPresent: input.shellPresent,
        platformSupported: input.platformSupported,
        helperState: input.helperState,
        helperReady,
        validatedByDiagnostics,
        rejectedBecause: null,
      },
      browser: input.browser,
    };
  }

  const activeTier = input.browser.capturePath === "pointermove-coalesced" ? 2 : 3;
  return {
    activeTier,
    activeKind: "browser-pointer-lock",
    caption: "browser capture · pointer lock",
    detail:
      `Measured samples come from browser Pointer Lock (${input.browser.capturePath}). ` +
      `Native high-rate capture is not carrying this session: ${rejectedBecause}.`,
    native: {
      shellPresent: input.shellPresent,
      platformSupported: input.platformSupported,
      helperState: input.helperState,
      helperReady,
      validatedByDiagnostics,
      rejectedBecause,
    },
    browser: input.browser,
  };
}

/**
 * Observes the live environment and applies {@link decideCaptureTier}. Never
 * throws: an unreadable helper status or store degrades to "browser capture"
 * with an honest reason rather than blocking the session.
 */
export async function reportCaptureTier(
  store: LocalJsonStore | null,
  probeElement: { onpointermove?: unknown } | null,
): Promise<CaptureTierReport> {
  const browser = detectPointerEventCapabilities(
    (probeElement ??
      (typeof document !== "undefined"
        ? document.createElement("div")
        : {})) as never,
  );

  const bridge = desktopBridge();
  let helperState = "no-shell";
  let platformSupported = false;
  if (bridge) {
    platformSupported = true;
    try {
      const status = await bridge.helperStatus();
      helperState = status.state;
      platformSupported = status.platformSupported;
    } catch {
      helperState = "unreadable";
    }
  }

  let selfTest: Pick<CaptureSelfTestResult, "verdict" | "sourceKind"> | null = null;
  if (store) {
    try {
      const paths = await store.listByPrefix("self-tests");
      const latest = paths[paths.length - 1];
      if (latest) {
        const loaded = await store.loadRawAt<CaptureSelfTestResult>(
          "capture-self-test",
          latest,
        );
        const payload = loaded?.payload ?? null;
        if (payload) {
          selfTest = { verdict: payload.verdict, sourceKind: payload.sourceKind };
        }
      }
    } catch {
      selfTest = null;
    }
  }

  return decideCaptureTier({
    shellPresent: bridge !== null,
    platformSupported,
    helperState,
    selfTest,
    browser,
    // Flipped on by the pass that aligns helper and renderer clock origins.
    nativeLiveTransportEnabled: false,
  });
}

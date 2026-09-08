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
 * whose helper is ready and whose clocks are now synchronized.
 *
 * The clock-domain blocker is GONE: the helper answers `time-sync` probes and
 * the transport translates every event into the renderer clock before it
 * emits anything, with a proven bound (src/capture/timebase.ts). What remains
 * is an integration question, not a correctness one.
 *
 * The arena's capture source owns three things the native helper does not:
 * Pointer Lock, window focus, and the virtual reticle every drill is drawn
 * against. Running native motion through it means suppressing the browser's
 * own pointermove for the same physical movement — and getting that exactly
 * right, because a single missed suppression applies every mouse movement
 * twice and silently doubles the sensitivity the player is being measured at.
 * That composite has never run on real hardware; shipping it untested in the
 * build that exists to make measurement trustworthy would risk the very
 * session it is meant to protect.
 *
 * Diagnostics runs native capture (and its clock sync) end to end today, so
 * the path is exercised and reported honestly — it just does not yet carry
 * the scored drills.
 */
export const NATIVE_LIVE_BLOCKER =
  "native motion has not yet been integrated with the arena's Pointer Lock reticle on real hardware (docs/NATIVE-CAPTURE.md)";

/** Why tier 1 was refused because the two clocks were never put on one timeline. */
export const NATIVE_CLOCK_SYNC_BLOCKER =
  "the capture helper's clock was never synchronized with this window's clock";

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
    /** Helper↔renderer clock offset was established during that check. */
    clockSynchronized: boolean;
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
  selfTest:
    | (Pick<CaptureSelfTestResult, "verdict" | "sourceKind"> & {
        clockSync?: { state: string } | null | undefined;
      })
    | null;
  browser: PointerEventCapabilities;
  /**
   * Set only once native motion is integrated with the arena's Pointer Lock
   * reticle on real hardware. See {@link NATIVE_LIVE_BLOCKER}.
   */
  nativeLiveTransportEnabled: boolean;
}): CaptureTierReport {
  const helperReady = input.shellPresent && input.helperState === "ready";
  const validatedByDiagnostics =
    input.selfTest !== null &&
    input.selfTest.sourceKind === "native" &&
    input.selfTest.verdict === "pass";
  const clockSynchronized =
    input.selfTest?.clockSync?.state === "established";

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
  } else if (!clockSynchronized) {
    rejectedBecause = NATIVE_CLOCK_SYNC_BLOCKER;
  } else if (!input.nativeLiveTransportEnabled) {
    rejectedBecause = NATIVE_LIVE_BLOCKER;
  }

  if (rejectedBecause === null) {
    return {
      activeTier: 1,
      activeKind: "native",
      caption: "native capture · raw input",
      detail:
        "Measured samples come from the local trAIMer capture helper (Windows Raw Input). The mouse stays locked to the arena.",
      native: {
        shellPresent: input.shellPresent,
        platformSupported: input.platformSupported,
        helperState: input.helperState,
        helperReady,
        validatedByDiagnostics,
        clockSynchronized,
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
      clockSynchronized,
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

  let selfTest:
    | (Pick<CaptureSelfTestResult, "verdict" | "sourceKind"> & {
        clockSync?: { state: string } | null | undefined;
      })
    | null = null;
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
          selfTest = {
            verdict: payload.verdict,
            sourceKind: payload.sourceKind,
            clockSync: payload.clockSync ?? null,
          };
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
    // Flipped on by the pass that integrates native motion with the arena's
    // Pointer Lock reticle and validates it on real hardware.
    nativeLiveTransportEnabled: false,
  });
}

import type { PreflightEnvironment } from "../../src/preflight/preflight.ts";
import { detectPointerEventCapabilities } from "../../src/capture/browserSource.ts";
import type { LocalJsonStore } from "../../src/persistence/store.ts";
import type { CaptureSelfTestResult } from "../../src/diagnostics/captureSelfTest.ts";

/**
 * Gathers the live-browser preflight environment (Pass 5).
 * Every probe degrades to honest nulls — never fabricated values.
 */
export async function gatherPreflightEnvironment(
  store: LocalJsonStore,
): Promise<PreflightEnvironment> {
  // Runtime capabilities.
  const caps = detectPointerEventCapabilities(
    typeof document !== "undefined"
      ? (document.createElement("div") as never)
      : ({} as never),
  );
  const pointerLockSupported =
    typeof document !== "undefined" && "requestPointerLock" in HTMLCanvasElement.prototype;
  const isChromium =
    typeof navigator !== "undefined" &&
    /Chrome|Chromium|Edg/.test(navigator.userAgent) &&
    !/OPR\/.{0,20}Mobile/.test(navigator.userAgent);

  // Latest persisted capture self-test, if any.
  let selfTest: CaptureSelfTestResult | null = null;
  try {
    const paths = await store.listByPrefix("self-tests");
    if (paths.length > 0) {
      const latest = paths[paths.length - 1]!;
      const loaded = await store.loadRawAt<CaptureSelfTestResult>(
        "capture-self-test",
        latest,
      );
      selfTest = loaded?.payload ?? null;
    }
  } catch {
    selfTest = null;
  }

  // Unfinished checkpoints.
  const unfinishedCheckpoints: { ageMs: number }[] = [];
  try {
    const now = Date.now();
    for (const p of await store.listByPrefix("sessions/checkpoints")) {
      const loaded = await store.loadRawAt<{ status?: string; updatedAtIso?: string }>(
        "session-checkpoint",
        p,
      );
      if (
        loaded?.payload &&
        (loaded.payload.status === "running" || loaded.payload.status === "interrupted")
      ) {
        const ageMs = Math.max(0, now - Date.parse(loaded.payload.updatedAtIso ?? ""));
        unfinishedCheckpoints.push({ ageMs: Number.isFinite(ageMs) ? ageMs : 0 });
      }
    }
  } catch {
    // Storage trouble itself surfaces in the persistent-storage check.
  }

  // Storage estimate.
  let availableBytes: number | null = null;
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      if (typeof est.quota === "number" && typeof est.usage === "number") {
        availableBytes = Math.max(0, est.quota - est.usage);
      }
    }
  } catch {
    availableBytes = null;
  }

  // Settings (DPI/X/Y).
  let dpi: number | null = null;
  let sensXPercent: number | null = null;
  let sensYPercent: number | null = null;
  try {
    const raw = localStorage.getItem("aldo-aim-lab-settings");
    if (raw) {
      const parsed = JSON.parse(raw) as { dpi?: number; sensX?: number; sensY?: number };
      dpi = typeof parsed.dpi === "number" ? parsed.dpi : null;
      sensXPercent = typeof parsed.sensX === "number" ? parsed.sensX : null;
      sensYPercent = typeof parsed.sensY === "number" ? parsed.sensY : null;
    }
  } catch {
    // leave nulls
  }

  return {
    runtime: {
      browserName:
        typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 60) : "unknown",
      isSupportedChromiumRuntime: isChromium,
      pointer: { capturePath: caps.capturePath, pointerLockSupported },
    },
    nativeHelper: null, // helper probing stays in the Diagnostics tab probe
    activeCaptureTier: 2,
    captureQuality: {
      observedRateHz: selfTest?.observedRateHz ?? selfTest?.activeMotionRateHz ?? null,
      timestampsMonotonic:
        selfTest === null
          ? null
          : selfTest.nonMonotonicTimestamps === 0,
      dropFraction:
        selfTest && selfTest.transportCounters
          ? selfTest.transportCounters.missingSequences /
            Math.max(selfTest.transportCounters.framesReceived +
              selfTest.transportCounters.missingSequences, 1)
          : null,
      jitterCv: selfTest?.jitterCv ?? null,
      selfTestVerdict: selfTest?.verdict ?? null,
    },
    dpi,
    sensXPercent,
    sensYPercent,
    calibration: null, // wired when calibration records carry context fingerprints
    storage: { availableBytes },
    viewport:
      typeof window !== "undefined"
        ? { widthPx: window.innerWidth, heightPx: window.innerHeight }
        : null,
    unfinishedCheckpoints,
    storedArtifactEngineVersions: [], // filled by loadStoredEngineVersions below
  };
}

/** Reads engine tags from stored decision artifacts for compatibility checks. */
export async function loadStoredEngineVersions(
  store: LocalJsonStore,
): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  try {
    for (const p of (await store.listByPrefix("recommendations")).slice(-10)) {
      const loaded = await store.loadRawAt<{ engineVersion?: string }>("recommendation", p);
      out.push(loaded?.payload?.engineVersion ?? null);
    }
  } catch {
    // unreadable artifacts are surfaced by other gates
  }
  return out;
}

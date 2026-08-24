import { fullReleaseMetadata, type FullReleaseMetadata } from "../version.ts";
import type { LocalJsonStore } from "../persistence/store.ts";

/**
 * Hardware-validation data bundle (Pass 7, requirement V).
 *
 * After the FIRST real smoke on Aldo's Windows PC, this assembles a compact
 * evidence file from already-persisted local records: versions, runtime and
 * display metadata, capture diagnostics (observed polling rate, jitter,
 * drops), session/resume/calibration status, and warnings. It exists so the
 * hardware visit produces inspectable facts — NOT telemetry; it is exported
 * deliberately by the user and contains no raw input samples and no personal
 * information beyond what the player typed into the player-name field.
 */

export interface RuntimeFacts {
  /** navigator.userAgent (browser/runtime identification). */
  userAgent: string;
  /** navigator.platform or "unknown". */
  platform: string;
  /** Logical screen size reported by the OS/browser. */
  screenPx: { width: number | null; height: number | null };
  /** window.devicePixelRatio at export time (Windows display scaling). */
  devicePixelRatio: number | null;
  /** CPU threads visible to the runtime (informational). */
  hardwareConcurrency: number | null;
  /**
   * Display refresh estimate in Hz measured by the Diagnostics probe
   * (requestAnimationFrame cadence over ~1 s), if it was run.
   */
  estimatedRefreshHz: number | null;
}

export interface HardwareValidationBundle {
  kind: "aldo-hardware-validation-bundle";
  schemaVersion: 1;
  generatedAtIso: string;
  release: FullReleaseMetadata;

  runtime: RuntimeFacts;

  capture: {
    /** Latest persisted capture self-test verdict + rates/counters. */
    latestSelfTest: {
      startedAtIso: string;
      endedAtIso: string;
      sourceKind: string;
      deviceDescription: string | null;
      nominalRateHz: number | null;
      observedRateHz: number;
      verdict: string;
      checksFailed: string[];
      transportCounters: Record<string, number> | null;
    } | null;
  };

  sessions: {
    total: number;
    completed: number;
    aborted: number;
    firstSessionAtIso: string | null;
    lastSessionAtIso: string | null;
    lastOptimizerVersion: string | null;
  };

  resume: {
    unfinishedCheckpoints: number;
    staleCheckpoints: number;
  };

  calibration: {
    hasRecord: boolean;
    adequateX: boolean | null;
    adequateY: boolean | null;
    lastCreatedAtIso: string | null;
  };

  warnings: string[];
}

export interface GatherHardwareValidationOptions {
  runtime: RuntimeFacts;
  nowIso?: () => string;
}

export async function buildHardwareValidationBundle(
  store: LocalJsonStore,
  options: GatherHardwareValidationOptions,
): Promise<HardwareValidationBundle> {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const warnings: string[] = [];

  // ---- capture self-test -----------------------------------------------------
  let latestSelfTest: HardwareValidationBundle["capture"]["latestSelfTest"] = null;
  try {
    const paths = await store.listByPrefix("self-tests");
    if (paths.length > 0) {
      const loaded = await store.loadRawAt<{
        startedAtIso: string;
        endedAtIso: string;
        sourceKind: string;
        deviceDescription?: string | null;
        nominalRateHz: number | null;
        observedRateHz: number;
        verdict: string;
        checks: { id: string; pass: boolean }[];
        transportCounters?: Record<string, number>;
      }>("capture-self-test", paths[paths.length - 1]!);
      if (loaded) {
        const p = loaded.payload;
        latestSelfTest = {
          startedAtIso: p.startedAtIso,
          endedAtIso: p.endedAtIso,
          sourceKind: p.sourceKind,
          deviceDescription: p.deviceDescription ?? null,
          nominalRateHz: p.nominalRateHz,
          observedRateHz: p.observedRateHz,
          verdict: p.verdict,
          checksFailed: Array.isArray(p.checks)
            ? p.checks.filter((c) => !c.pass).map((c) => c.id)
            : [],
          transportCounters: p.transportCounters ?? null,
        };
        if (p.verdict !== "pass") {
          warnings.push(`capture self-test verdict: ${p.verdict}`);
        }
      }
    } else {
      warnings.push("no capture self-test on record");
    }
  } catch {
    warnings.push("capture self-test records unreadable");
  }

  // ---- session history ---------------------------------------------------------
  const sessions = {
    total: 0,
    completed: 0,
    aborted: 0,
    firstSessionAtIso: null as string | null,
    lastSessionAtIso: null as string | null,
    lastOptimizerVersion: null as string | null,
  };
  try {
    const paths = await store.listByPrefix("human-sessions");
    const loadedList: { startedAtIso: string | null; status: string; optimizerVersion: string | null }[] = [];
    for (const p of paths) {
      const rec = await store.loadRawAt<{
        startedAtIso?: string;
        status?: string;
        optimizerVersion?: string;
      }>("human-session", p);
      if (!rec?.payload) continue;
      loadedList.push({
        startedAtIso: rec.payload.startedAtIso ?? null,
        status: rec.payload.status ?? "unknown",
        optimizerVersion: rec.payload.optimizerVersion ?? null,
      });
    }
    loadedList.sort((a, b) => (a.startedAtIso ?? "").localeCompare(b.startedAtIso ?? ""));
    sessions.total = loadedList.length;
    sessions.completed = loadedList.filter((s) => s.status === "complete").length;
    sessions.aborted = loadedList.filter((s) => s.status === "aborted").length;
    sessions.firstSessionAtIso = loadedList[0]?.startedAtIso ?? null;
    sessions.lastSessionAtIso = loadedList.at(-1)?.startedAtIso ?? null;
    sessions.lastOptimizerVersion = loadedList.at(-1)?.optimizerVersion ?? null;
    if (sessions.total === 0) {
      warnings.push("no human sessions recorded yet — run the MANUAL-TEST.md smoke first");
    }
  } catch {
    warnings.push("human-session records unreadable");
  }

  // ---- resume checkpoints --------------------------------------------------------
  const resume = { unfinishedCheckpoints: 0, staleCheckpoints: 0 };
  try {
    const nowMs = Date.now();
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    for (const p of await store.listByPrefix("sessions/checkpoints")) {
      const rec = await store.loadRawAt<{ status?: string; updatedAtIso?: string }>(
        "session-checkpoint",
        p,
      );
      if (!rec?.payload || rec.payload.status !== "running") continue;
      resume.unfinishedCheckpoints++;
      const age = nowMs - Date.parse(rec.payload.updatedAtIso ?? "");
      if (Number.isFinite(age) && age > STALE_MS) resume.staleCheckpoints++;
    }
  } catch {
    warnings.push("checkpoint records unreadable");
  }

  // ---- calibration -----------------------------------------------------------------
  const calibration: HardwareValidationBundle["calibration"] = {
    hasRecord: false,
    adequateX: null,
    adequateY: null,
    lastCreatedAtIso: null,
  };
  try {
    const paths = await store.listByPrefix("calibrations");
    if (paths.length > 0) {
      calibration.hasRecord = true;
      for (const p of paths) {
        const rec = await store.loadRawAt<{
          axis: string;
          adequate: boolean;
          createdAtIso: string;
        }>("calibration-record", p);
        if (!rec?.payload) continue;
        calibration.lastCreatedAtIso =
          calibration.lastCreatedAtIso === null ||
          rec.payload.createdAtIso > (calibration.lastCreatedAtIso ?? "")
            ? rec.payload.createdAtIso
            : calibration.lastCreatedAtIso;
        if (rec.payload.axis === "x" || rec.payload.axis === "y") {
          const key = `adequate${rec.payload.axis.toUpperCase()}` as "adequateX" | "adequateY";
          calibration[key] = rec.payload.adequate;
        }
      }
      if (calibration.adequateX === false || calibration.adequateY === false) {
        warnings.push("latest calibration judged inadequate by the engine");
      }
    } else {
      warnings.push("no calibration on record (physical distances unavailable)");
    }
  } catch {
    warnings.push("calibration records unreadable");
  }

  return {
    kind: "aldo-hardware-validation-bundle",
    schemaVersion: 1,
    generatedAtIso: nowIso(),
    release: fullReleaseMetadata(),
    runtime: options.runtime,
    capture: { latestSelfTest },
    sessions,
    resume,
    calibration,
    warnings,
  };
}

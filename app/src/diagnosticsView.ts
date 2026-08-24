import {
  NativeTransportCaptureSource,
  assertLoopbackUrl,
  type TransportSocket,
} from "../../src/capture/nativeClient.ts";
import { analyzeNativeStream } from "../../src/diagnostics/nativeDiagnostics.ts";
import { buildHardwareValidationBundle } from "../../src/diagnostics/hardwareValidation.ts";
import { detectPointerEventCapabilities } from "../../src/capture/browserSource.ts";
import { gatherRuntimeFacts } from "./preflightClient.ts";
import type { LocalDiagnosticLog } from "../../src/diagnostics/localLog.ts";
import type { CaptureSink } from "../../src/capture/events.ts";
import type { NativeFrame } from "../../src/capture/native.ts";
import type { LocalJsonStore } from "../../src/persistence/store.ts";
import { el, clear, downloadJson } from "./dom.ts";
import {
  button,
  card,
  detailsBlock,
  field,
  icon,
  jsonBlock,
  pageHeader,
  sectionLabel,
  type IconName,
  type Tone,
} from "./ui.ts";

/** Adapts the platform WebSocket to the engine transport port (loopback only). */
function browserSocketFactory(url: string): TransportSocket {
  assertLoopbackUrl(url); // defense in depth; transport constructor also enforces
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (cb) => ws.addEventListener("open", cb),
    onMessage: (cb) =>
      ws.addEventListener("message", (ev) => cb(String((ev as MessageEvent).data))),
    onClose: (cb) =>
      ws.addEventListener("close", (ev) => cb((ev as CloseEvent).code, (ev as CloseEvent).reason)),
    onError: (cb) => ws.addEventListener("error", () => cb("socket error")),
  };
}

/** Tone for one named engine check — the engine's status verbatim, no UI thresholds. */
function checkTone(
  checks: { name: string; status: string }[],
  name: string,
): Tone {
  const check = checks.find((c) => c.name === name);
  if (!check) return "neutral";
  return check.status === "pass" ? "ok" : check.status === "warn" ? "warn" : "danger";
}

function diagTile(name: string, iconName: IconName, tone: Tone, value: string, sub?: string): HTMLElement {
  const tile = el("div", { class: "diag-tile" });
  tile.append(el("span", { class: `card-icon tone-${tone}` }, [icon(iconName, 15)]));
  const text = el("div", { class: "diag-tile-text" });
  text.append(
    el("span", { class: "diag-tile-name", text: name }),
    el("span", { class: "diag-tile-value", text: value }),
  );
  if (sub) text.append(el("span", { class: "diag-tile-sub", text: sub }));
  tile.append(text);
  return tile;
}

/**
 * Diagnostics view (requirements C/T): native capture probe with
 * pass/warn/fail checks, browser fallback capability display, and local
 * diagnostic bundle export. No telemetry ever leaves the machine.
 */
export function renderDiagnosticsView(
  container: HTMLElement,
  sessionToken: string,
  log: LocalDiagnosticLog,
  store: Promise<LocalJsonStore>,
): void {
  clear(container);
  container.append(
    pageHeader(
      "Diagnostics",
      "Everything here runs on this machine only. The capture check talks to the local Aldo helper — nothing ever leaves your PC.",
    ),
  );

  // ---- player-level system status ----
  const caps = detectPointerEventCapabilities(
    typeof document !== "undefined" ? (document.createElement("div") as never) : ({} as never),
  );

  const statusGrid = el("div", { class: "diag-status-grid" });
  statusGrid.append(
    diagTile(
      "Mouse input",
      "mouse",
      caps.coalescingSupported ? "ok" : "warn",
      caps.coalescingSupported ? "High-rate browser capture" : "Standard browser capture",
      `capture path: ${caps.capturePath} · coalescing ${caps.coalescingSupported ? "supported" : "unavailable"}`,
    ),
  );

  const selfTestTile = diagTile("Capture check", "pulse", "neutral", "Not run yet", "Run the guided check below");
  statusGrid.append(selfTestTile);
  void store.then(async (s) => {
    try {
      const paths = await s.listByPrefix("self-tests");
      const latestPath = paths[paths.length - 1];
      if (!latestPath) return;
      const loaded = await s.loadRawAt<{ verdict?: string; observedRateHz?: number; endedAtIso?: string }>(
        "capture-self-test",
        latestPath,
      );
      const st = loaded?.payload;
      if (!st?.verdict) return;
      const tone: Tone = st.verdict === "pass" ? "ok" : st.verdict === "warn" ? "warn" : "danger";
      const fresh = diagTile(
        "Capture check",
        "pulse",
        tone,
        st.verdict === "pass" ? "Passed" : st.verdict === "warn" ? "Passed with warnings" : "Failed",
        st.observedRateHz ? `~${st.observedRateHz.toFixed(0)} Hz observed on last run` : undefined,
      );
      selfTestTile.replaceWith(fresh);
    } catch {
      // leave the neutral tile
    }
  });

  statusGrid.append(
    diagTile("Storage", "storage", "neutral", "Local browser database", "Raw trials, sessions, and results never leave this machine"),
  );
  container.append(statusGrid);

  // ---- guided native capture check ----
  container.append(sectionLabel("Capture check"));

  const urlInput = el("input", { type: "text", value: "ws://127.0.0.1:48765" }) as HTMLInputElement;
  const tokenInput = el("input", { type: "text", value: sessionToken }) as HTMLInputElement;
  const durationInput = el("input", { type: "number", value: 3, min: "1", max: "30" }) as HTMLInputElement;

  const runButton = button("Run capture check", { variant: "primary", icon: "play" });
  const liveStatus = el("p", { class: "muted", text: "Checks the native high-rate helper. Start the helper first (see the packaged launcher), then run the check and move your mouse naturally while clicking a few times." });
  const resultHolder = el("div", {});

  runButton.addEventListener("click", () => {
    clear(resultHolder);
    runButton.disabled = true;
    liveStatus.textContent = "Connecting to the capture helper…";
    const source = new NativeTransportCaptureSource({
      url: urlInput.value.trim(),
      sessionToken: tokenInput.value.trim(),
      appVersion: "diagnostics-view",
      socketFactory: browserSocketFactory,
      reconnect: { maxAttempts: 2, initialDelayMs: 300, maxDelayMs: 1000 },
      onStatus: (status) => {
        log.nativeLifecycle(status);
      },
      onError: (err) => {
        log.error("NATIVE_PROBE_FAILED", err.message);
      },
    });
    const frames: NativeFrame[] = [];
    let seq = 0;
    const startedAt = performance.now();
    const durationMs = Math.max(1, Number(durationInput.value) || 3) * 1000;
    // Display refresh estimate: count rAF cadence during the same window
    // (Pass 7 hardware-validation metadata; honest null when unavailable).
    let rafFrames = 0;
    const rafStart = startedAt;
    const countRaf = (): void => {
      rafFrames++;
      if (performance.now() - rafStart < durationMs) requestAnimationFrame(countRaf);
    };
    requestAnimationFrame(countRaf);
    const sink: CaptureSink = {
      onEvent(event) {
        if (
          event.kind === "pointer-sample" ||
          event.kind === "button"
        ) {
          // Group into one frame per event for analysis purposes.
          frames.push({
            sequence: seq++,
            tMonotonicMs: event.tMs,
            events: [event],
          });
        }
      },
    };
    source.start(sink);

    const liveTicker = setInterval(() => {
      if (source.status === "streaming") {
        const secondsLeft = Math.max(0, Math.ceil((durationMs - (performance.now() - startedAt)) / 1000));
        liveStatus.textContent = `Move your mouse naturally and click several times — ${frames.length} samples captured · ${secondsLeft}s left`;
      }
    }, 150);

    const finish = (): void => {
      clearInterval(liveTicker);
      runButton.disabled = false;
      source.stop();
      const report = analyzeNativeStream(frames, {
        requestedRateHz: source.header?.nominalRateHz ?? null,
        reconnectEvents: source.counters.reconnects,
      });
      log.log("info", "native-probe-result", {
        verdict: report.verdict,
        observedRateHz: Number(report.observedRateHz.toFixed(1)),
        dropped: report.droppedSequences,
      });
      // Record the display refresh estimate for the hardware-validation bundle.
      const rafElapsedS = (performance.now() - rafStart) / 1000;
      if (rafFrames > 30 && rafElapsedS > 0.5) {
        try {
          localStorage.setItem(
            "aldo-estimated-refresh-hz",
            String(Math.round(rafFrames / rafElapsedS)),
          );
        } catch {
          // storage optional — the estimate simply won't persist
        }
      }
      // Persist the self-test so preflight can trust tier-1 later.
      if (source.header) {
        const selfTest = {
          kind: "capture-self-test" as const,
          schemaVersion: 1 as const,
          startedAtIso: new Date(startedAt).toISOString(),
          endedAtIso: new Date().toISOString(),
          durationMs: Math.round(performance.now() - startedAt),
          sourceKind: source.header.sourceKind,
          deviceId: source.header.deviceId,
          deviceDescription: source.header.deviceDescription,
          nominalRateHz: source.header.nominalRateHz,
          transportCounters: {
            framesReceived: source.counters.framesReceived,
            duplicateSequences: source.counters.duplicateSequences,
            missingSequences: source.counters.missingSequences,
            nonMonotonicTimestamps: source.counters.nonMonotonicTimestamps,
            reconnects: source.counters.reconnects,
          },
          observedRateHz: report.observedRateHz,
          activeMotionRateHz: report.observedRateHz,
          intervalP10Ms: report.intervalP10Ms,
          intervalP50Ms: report.intervalP50Ms,
          intervalP90Ms: report.intervalP90Ms,
          jitterCv: report.jitterCv,
          movementSamples: frames.length,
          totalDx: frames.reduce(
            (a: number, f: NativeFrame) =>
              a + f.events.reduce((b, e) => b + (e.kind === "pointer-sample" ? e.dx : 0), 0),
            0,
          ),
          totalDy: 0,
          clickPresses: frames.reduce(
            (a: number, f: NativeFrame) =>
              a +
              f.events.filter((e) => e.kind === "button" && e.action === "press").length,
            0,
          ),
          clickReleases: frames.reduce(
            (a: number, f: NativeFrame) =>
              a +
              f.events.filter((e) => e.kind === "button" && e.action === "release").length,
            0,
          ),
          zeroMotionFraction: 0,
          longestStillnessMs: null,
          largestGapMs: report.longestGapMs,
          droppedSequences: report.droppedSequences,
          duplicateSequences: report.duplicateSequences,
          nonMonotonicTimestamps: report.nonMonotonicTimestamps,
          reconnects: report.reconnectEvents,
          checks: report.checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail })),
          verdict: report.verdict,
          reasonCodes: report.checks.filter((c) => c.status !== "pass").map((c) => `${c.name}:${c.status}`),
        };
        void store
          .then((st) =>
            st.saveRaw("capture-self-test", `self-tests/st-${Date.now()}.json`, selfTest),
          )
          .catch((err) => log.error("SELF_TEST_PERSIST_FAILED", String(err)));
      }

      // ---- player-level summary ----
      liveStatus.textContent = "Check complete.";
      const verdictTone: Tone =
        report.verdict === "pass" ? "ok" : report.verdict === "warn" ? "warn" : "danger";
      const summary = el("div", { class: "diag-status-grid" });
      summary.append(
        diagTile(
          "Capture quality",
          "shield",
          verdictTone,
          report.verdict === "pass" ? "Validated" : report.verdict === "warn" ? "Usable with warnings" : "Not validated",
          source.header ? `${source.header.sourceKind} · ${source.header.deviceDescription ?? "unknown device"}` : undefined,
        ),
        diagTile(
          "Polling rate",
          "zap",
          checkTone(report.checks, "effective-rate"),
          `~${report.observedRateHz.toFixed(0)} Hz observed`,
          report.requestedRateHz ? `device claims ${report.requestedRateHz} Hz` : undefined,
        ),
        diagTile(
          "Timing stability",
          "clock",
          checkTone(report.checks, "timing-jitter"),
          report.jitterCv !== null ? `jitter CV ${report.jitterCv.toFixed(3)}` : "—",
          `longest gap ${report.longestGapMs.toFixed(1)} ms`,
        ),
        diagTile(
          "Dropped samples",
          "warn",
          checkTone(report.checks, "sequence-integrity"),
          String(report.droppedSequences),
          `${report.duplicateSequences} duplicates · ${report.nonMonotonicTimestamps} out-of-order`,
        ),
      );
      resultHolder.append(summary);

      // Engine checks verbatim.
      const checksList = el("div", { class: "preflight-checks" });
      for (const check of report.checks) {
        const tone: Tone = check.status === "pass" ? "ok" : check.status === "warn" ? "warn" : "danger";
        const item = el("div", { class: "preflight-check" });
        item.append(
          el("span", { class: `tone-${tone}` }, [
            icon(check.status === "pass" ? "check" : check.status === "warn" ? "warn" : "x", 13),
          ]),
        );
        const text = el("div", {});
        text.append(
          el("span", { class: "preflight-check-name", text: check.name }),
          el("p", { class: "preflight-check-detail", text: check.detail }),
        );
        item.append(text);
        checksList.append(item);
      }
      resultHolder.append(
        detailsBlock("Engine checks", checksList),
        detailsBlock(
          "Technical detail",
          jsonBlock({
            verdict: report.verdict,
            header: source.header,
            requestedRateHz: report.requestedRateHz,
            observedRateHz: Number(report.observedRateHz.toFixed(1)),
            throughputRateHz: Number(report.throughputRateHz.toFixed(1)),
            intervalP10P50P90Ms: [
              report.intervalP10Ms?.toFixed(2),
              report.intervalP50Ms?.toFixed(2),
              report.intervalP90Ms?.toFixed(2),
            ],
            jitterCv: report.jitterCv?.toFixed(3) ?? null,
            droppedSequences: report.droppedSequences,
            duplicateSequences: report.duplicateSequences,
            nonMonotonicTimestamps: report.nonMonotonicTimestamps,
            bursts: report.bursts,
            longestGapMs: Number(report.longestGapMs.toFixed(1)),
            durationTestedMs: Number(report.durationTestedMs.toFixed(0)),
            counters: source.counters,
            checks: report.checks,
          }),
        ),
      );
    };
    const wait = (): void => {
      if (performance.now() - startedAt > durationMs + 4000) {
        finish();
        return;
      }
      if (source.status === "streaming" && performance.now() - startedAt >= durationMs) {
        finish();
        return;
      }
      if (source.status === "failed") {
        clearInterval(liveTicker);
        runButton.disabled = false;
        liveStatus.textContent = "";
        clear(resultHolder);
        resultHolder.append(
          card(
            { title: "Helper not reachable", icon: "warn", tone: "warn" },
            el("p", { class: "muted", text: `No capture helper answered at ${urlInput.value}. Browser capture keeps working — native high-rate capture just stays unavailable until the helper runs.` }),
            el("p", { class: "muted", text: "Start the helper with the packaged launcher (or see native/windows/BUILD.md) and run the check again." }),
          ),
        );
        return;
      }
      setTimeout(wait, 200);
    };
    wait();
  });

  container.append(
    card(
      {
        title: "Native capture check",
        subtitle: "Validates the Windows high-rate helper against what your hardware actually delivers",
        icon: "pulse",
      },
      liveStatus,
      el("div", {}, [runButton]),
      resultHolder,
      detailsBlock(
        "Connection settings",
        el("div", { class: "form-grid" }, [
          field("Helper URL", urlInput, { hint: "Loopback only — remote URLs are refused." }),
          field("Session token (must match --token)", tokenInput),
          field("Check duration (seconds)", durationInput),
        ]),
      ),
    ),
  );

  // ---- diagnostic bundle export ----
  container.append(sectionLabel("Bug report bundle"));
  const exportBtn = button("Export diagnostic bundle", { variant: "secondary", icon: "download" });
  exportBtn.addEventListener("click", () => {
    downloadJson(`aldo-diagnostics-${Date.now()}.json`, log.exportBundle());
  });
  container.append(
    card(
      { title: "Local diagnostic bundle", icon: "shield" },
      el("p", {
        class: "muted",
        text: "Contains app versions, capture mode, state transitions, and error codes only — never raw input data. Nothing is sent anywhere; you choose where the file goes.",
      }),
      el("div", {}, [exportBtn]),
    ),
  );

  // ---- hardware validation evidence (Pass 7) ----
  const validationBtn = button("Export hardware validation bundle", {
    variant: "secondary",
    icon: "download",
  });
  validationBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const s = await store;
        const bundle = await buildHardwareValidationBundle(s, {
          runtime: gatherRuntimeFacts(),
        });
        downloadJson(
          `aldo-hardware-validation-${Date.now()}.json`,
          bundle,
        );
        log.log("info", "hardware-validation-export", { sessions: bundle.sessions.total });
      } catch (err) {
        log.error("VALIDATION_BUNDLE_FAILED", String(err));
      }
    })();
  });
  container.append(
    card(
      { title: "Hardware validation evidence", icon: "check" },
      el("p", {
        class: "muted",
        text: "A compact summary for the first real smoke on this PC: versions, display and scaling facts, capture self-test results (observed rate, jitter, drops), session/resume/calibration status. Local-only until you share the file yourself.",
      }),
      el("div", {}, [validationBtn]),
    ),
  );
}

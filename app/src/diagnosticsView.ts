import {
  NativeTransportCaptureSource,
  type TransportSocket,
} from "../../src/capture/nativeClient.ts";
import { analyzeNativeStream } from "../../src/diagnostics/nativeDiagnostics.ts";
import { detectPointerEventCapabilities } from "../../src/capture/browserSource.ts";
import type { LocalDiagnosticLog } from "../../src/diagnostics/localLog.ts";
import type { CaptureSink } from "../../src/capture/events.ts";
import type { NativeFrame } from "../../src/capture/native.ts";
import { el, clear, downloadJson } from "./dom.ts";

/** Adapts the platform WebSocket to the engine transport port. */
function browserSocketFactory(url: string): TransportSocket {
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

/**
 * Diagnostics view (requirements C/T): native capture probe with
 * pass/warn/fail checks, browser fallback capability display, and local
 * diagnostic bundle export. No telemetry ever leaves the machine.
 */
export function renderDiagnosticsView(
  container: HTMLElement,
  sessionToken: string,
  log: LocalDiagnosticLog,
): void {
  clear(container);
  container.append(
    el("h2", { text: "Diagnostics" }),
    el("p", {
      class: "note",
      text:
        "Everything here runs locally. The native probe connects to the Aldo capture helper on this machine only.",
    }),
  );

  // ---- browser fallback capabilities ----
  const caps = detectPointerEventCapabilities(
    typeof document !== "undefined" ? (document.createElement("div") as never) : ({} as never),
  );
  const capBlock = el("div", {});
  capBlock.append(el("h3", { text: "Browser capture fallback" }));
  capBlock.append(
    el("p", {
      text: `capture path: ${caps.capturePath} · coalescing ${caps.coalescingSupported ? "supported" : "unavailable"}`,
    }),
  );
  container.append(capBlock);

  // ---- native helper probe ----
  const urlInput = el("input", {
    type: "text",
    value: "ws://127.0.0.1:48765",
    style: "width:340px",
  }) as HTMLInputElement;
  const tokenInput = el("input", { type: "text", value: sessionToken }) as HTMLInputElement;
  const durationInput = el("input", { type: "number", value: 3, min: "1", max: "30" }) as HTMLInputElement;
  const runButton = el("button", { class: "primary", text: "Run native capture probe" });
  const output = el("pre", { class: "json" });

  runButton.addEventListener("click", () => {
    output.textContent = "connecting…";
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

    const finish = (): void => {
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
      output.textContent = JSON.stringify(
        {
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
        },
        null,
        2,
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
        output.textContent = `probe failed: ${urlInput.value} unreachable or rejected.\nStart the helper (see native/windows/BUILD.md) and try again.`;
        return;
      }
      setTimeout(wait, 200);
    };
    wait();
  });

  container.append(
    el("h3", { text: "Native high-rate capture probe" }),
    el("label", { text: "Helper URL" }), urlInput,
    el("label", { text: "Session token (must match --token)" }), tokenInput,
    el("label", { text: "Probe duration (seconds)" }), durationInput,
    runButton,
    output,
  );

  // ---- diagnostic bundle export ----
  const exportBtn = el("button", { text: "Export diagnostic bundle" });
  exportBtn.addEventListener("click", () => {
    downloadJson(`aldo-diagnostics-${Date.now()}.json`, log.exportBundle());
  });
  container.append(el("h3", { text: "Bug report bundle" }), exportBtn,
    el("p", {
      class: "note",
      text: "Contains app versions, capture mode, transitions and error codes only — never raw input data.",
    }));
}

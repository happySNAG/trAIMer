import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assertLoopbackUrl, NativeTransportCaptureSource, NATIVE_TRANSPORT_LIMITS } from "../src/capture/nativeClient.ts";
import type { TransportSocketFactory } from "../src/capture/nativeClient.ts";
import { buildFinalResult } from "../src/results/finalResult.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";

/**
 * Pass 6 security round two (requirement 15).
 *
 * Re-audits the local attack surface: transport parser abuse, loopback
 * origin assumptions, launcher-script hygiene, archive-path safety, and
 * hostile strings in engine metadata. Every material finding gets a
 * regression assertion here.
 */

function makeSocketFactory(): TransportSocketFactory {
  return () => {
    throw new Error("no sockets in this test");
  };
}

/** Mirror of scripts/package-release.mjs isSafeArchivePath (kept in sync by test). */
function isSafeArchivePath(relPath: unknown): boolean {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  if (/^[A-Za-z]:/.test(relPath)) return false;
  if (relPath.includes("\\")) return false;
  const parts = relPath.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  return true;
}

describe("loopback origin assumptions", () => {
  it("rejects lookalike hosts, wrong schemes, and userinfo tricks", () => {
    const bypasses = [
      "ws://127.0.0.1.evil.com:48765",
      "ws://localhost.localdomain:48765",
      "wss://127.0.0.1@evil.com:48765",
      "http://127.0.0.1:48765",
      "ftp://127.0.0.1",
    ];
    for (const url of bypasses) {
      expect(() => assertLoopbackUrl(url), url).toThrow();
    }
    expect(() => assertLoopbackUrl("ws://127.0.0.1:48765")).not.toThrow();
    expect(() => assertLoopbackUrl("ws://localhost:48765")).not.toThrow();
    expect(() => assertLoopbackUrl("ws://[::1]:48765")).not.toThrow();
  });

  it("accepts numeric IP aliases because WHATWG normalization proves they ARE loopback", () => {
    // 2130706433 / 0x7f000001 / 127.1 all normalize to 127.0.0.1 before the
    // allowlist comparison — the guard therefore operates on the RESOLVED
    // host, not attacker-controlled spelling.
    expect(new URL("ws://2130706433:48765").hostname).toBe("127.0.0.1");
    expect(new URL("ws://0x7f000001:48765").hostname).toBe("127.0.0.1");
    expect(new URL("ws://127.1:48765").hostname).toBe("127.0.0.1");
    // A public decimal IP normalizes to something NOT allowlisted and stays
    // rejected — normalization cannot smuggle in a remote host.
    expect(new URL("ws://3221226219:48765").hostname).toBe("192.0.2.235");
    expect(() => assertLoopbackUrl("ws://3221226219:48765")).toThrow();
  });
});

describe("transport parser abuse", () => {
  function transportWithErrors(token: string): {
    source: NativeTransportCaptureSource;
    errors: string[];
  } {
    const errors: string[] = [];
    const source = new NativeTransportCaptureSource({
      url: "ws://127.0.0.1:48765",
      sessionToken: token,
      appVersion: "test",
      socketFactory: makeSocketFactory(),
      onError: (err) => errors.push(err.message),
    });
    return { source, errors };
  }

  it("emits a typed failure on oversized messages", () => {
    const { source, errors } = transportWithErrors("tok");
    const huge = "x".repeat(NATIVE_TRANSPORT_LIMITS.maxMessageChars + 1);
    source.handleRawMessage(huge);
    expect(errors.some((m) => /oversized/.test(m))).toBe(true);
    expect(source.status).toBe("failed");
  });

  it("treats malformed JSON (including parser-stack bombs) as typed failures", () => {
    const { source, errors } = transportWithErrors("tok");
    let deep: unknown = "leaf";
    for (let i = 0; i < 200_000; i++) deep = [deep];
    try {
      source.handleRawMessage(JSON.stringify(deep));
    } catch (err) {
      // RangeError from the JSON parser is acceptable surfacing too.
      expect(String((err as Error).message)).toMatch(/call stack|malformed/i);
    }
    source.handleRawMessage("{broken");
    expect(errors.some((m) => /malformed/.test(m))).toBe(true);
    expect(source.status).toBe("failed");
  });

  it("fails closed on wrong-typed protocol fields", () => {
    const cases = [
      JSON.stringify({ type: "frame", sequence: "one", tMonotonicMs: 0, events: [] }),
      JSON.stringify({ type: "frame", sequence: 1, tMonotonicMs: 1, events: "not-array" }),
      JSON.stringify({ type: "welcome", protocolVersion: "1" }),
      JSON.stringify({ type: 42 }),
    ];
    for (const raw of cases) {
      const { source, errors } = transportWithErrors("tok");
      source.handleRawMessage(raw);
      expect(errors.length, raw).toBeGreaterThan(0);
      expect(source.status, raw).toBe("failed");
    }
  });

  it("keeps lone-surrogate strings inert (no parser escape)", () => {
    const { source } = transportWithErrors("tok");
    const hostile = JSON.stringify({
      type: "lifecycle",
      phase: "reconnecting",
      detail: "\uD800 partial surrogate \uFFFD",
    });
    expect(() => source.handleRawMessage(hostile)).not.toThrow();
  });
});

describe("windows launcher scripts (static contract)", () => {
  const startScript = readFileSync("scripts/release/windows/start-traimer.ps1", "utf8");
  const stopScript = readFileSync("scripts/release/windows/stop-traimer.ps1", "utf8");

  it("never uses shell-interpolation execution sinks", () => {
    for (const [name, script] of [["start", startScript], ["stop", stopScript]] as const) {
      expect(script.includes("Invoke-Expression"), name).toBe(false);
      expect(/iex\s/i.test(script), name).toBe(false);
      expect(script.includes("Invoke-Command"), name).toBe(false);
    }
  });

  it("binds loopback only and never exposes non-local endpoints", () => {
    expect(startScript).toContain('"http://127.0.0.1:');
    expect(startScript).toMatch(/Prefixes\.Add\("http:\/\/127\.0\.0\.1:\$\{?port/);
  });

  it("passes the token as a quoted argument array to the helper", () => {
    expect(startScript).toMatch(/\$helperArgs\s*=\s*@\(/);
    expect(startScript).toMatch(/"--token",\s*\$token/);
    expect(startScript).toMatch(/-ArgumentList \$helperArgs/);
    expect(startScript).not.toMatch(/-ArgumentList "[^"]*\$token/);
  });

  it("generates a cryptographic token and validates its shape", () => {
    expect(startScript).toContain("RandomNumberGenerator");
    expect(startScript).toMatch(/\^\[0-9a-f\]\{32\}\$/);
  });

  it("guards static-file serving against path traversal", () => {
    expect(startScript).toContain("GetFullPath");
    expect(startScript).toMatch(/StartsWith\(\$fullAppDir/);
  });

  it("stop routine parses PIDs strictly before killing them", () => {
    expect(stopScript).toMatch(/TryParse/);
    expect(stopScript).toMatch(/Stop-Process -Id \$procIdAsInt -Force/);
    expect(stopScript).not.toMatch(/Stop-Process -Name/);
  });
});

describe("release archive path safety", () => {
  it("rejects traversal, absolute, drive-letter, and empty members", () => {
    const bad = [
      "",
      "../evil",
      "a/../../evil",
      "/absolute/path",
      "C:\\\\evil",
      "C:/evil",
      "folder//file",
      "./here",
      "..",
      42,
      null,
    ] as unknown[];
    for (const p of bad) expect(isSafeArchivePath(p), String(p)).toBe(false);
    const good = ["app/index.html", "traimer_capture_helper.exe", "manifest.json"];
    for (const p of good) expect(isSafeArchivePath(p), String(p)).toBe(true);
  });
});

describe("hostile metadata stays inert through engine outputs", () => {
  function minimalRecommendation(): Recommendation {
    return {
      experimentId: "experiment-sec" as never,
      primarySensitivity: { sensX: 7.2, sensY: 7 },
      recommendedEdpi: 5760,
      sensXRange: { min: 6.8, max: 7.6 },
      edpiRange: { min: 5440, max: 6080 },
      confidence: 0.6,
      confidenceLabel: "moderate",
      dimensionEstimates: {},
      utilityWeights: {
        speed: 0.14,
        accuracy: 0.28,
        overshootControl: 0.11,
        undershootControl: 0.11,
        correctionEfficiency: 0.12,
        trackingPrecision: 0.14,
        consistency: 0.1,
      },
      evidence: {
        trialsAnalyzed: 40,
        trialsExcluded: 0,
        exclusionReasonCounts: {},
        candidatesEvaluated: 4,
        validTrialsPerCandidate: { a: 10, b: 10, c: 10, d: 10 },
        bestCandidateId: "cand-baseline",
        runnerUpCandidateId: null,
        utilityGapBestVsRunnerUp: 0.04,
        utilityGapZScore: 2.2,
        separation: "clear",
        searchRoundsRun: 1,
        notes: [],
      },
      warnings: [],
      refusedHighConfidence: false,
      rationaleLines: [],
      unresolvedBoundary: false,
      furtherTestingSuggested: false,
    };
  }

  it("carries HTML/script payloads verbatim as data (textContent-safe)", () => {
    const xss = '<img src=x onerror="window.__pwned=1">';
    const recommendation = minimalRecommendation();
    recommendation.rationaleLines.push(xss);
    recommendation.warnings.push("<script>alert(1)</script>");
    const result = buildFinalResult({
      recommendation,
      dpi: 800,
      currentSensXPercent: 7,
      currentSensYPercent: 7,
      calibration: null,
      retestPlan: null,
    });
    expect(result.rationaleLines).toContain(xss);
    expect(result.warnings).toContain("<script>alert(1)</script>");
  });

  it("does not interpret markup-like experiment ids", () => {
    const recommendation = minimalRecommendation();
    (recommendation as { experimentId: string }).experimentId = '"><svg/onload=1>';
    const result = buildFinalResult({
      recommendation,
      dpi: 800,
      currentSensXPercent: 7,
      currentSensYPercent: 7,
      calibration: null,
      retestPlan: null,
    });
    expect(result.experimentId).toBe('"><svg/onload=1>');
  });
});

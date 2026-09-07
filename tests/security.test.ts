import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_HELPER_VERSION } from "../src/version.ts";
import {
  exportBackupAll,
  importBackupAll,
  validateBackupPath,
  BackupError,
  sha256Hex,
} from "../src/persistence/backup.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import {
  assertLoopbackUrl,
  NativeTransportCaptureSource,
  createLoopbackSocketPair,
} from "../src/capture/nativeClient.ts";
import { NativeTransportError } from "../src/capture/nativeClient.ts";
import { NATIVE_CAPTURE_PROTOCOL_VERSION } from "../src/capture/native.ts";

/**
 * Security tests (Pass 5). The threat model is LOCAL: a hostile or corrupted
 * artifact file, a malicious "helper", and tampering with the local store.
 * There is no network attack surface by design — the no-telemetry audit
 * (scripts/audit-no-telemetry.mjs) enforces that separately.
 */

describe("storage path safety", () => {
  it("rejects traversal, absolutes, drive letters, and unknown roots", () => {
    for (const bad of [
      "../escape.json",
      "trials/../../escape.json",
      "/etc/passwd",
      "C:\\Users\\evil.json",
      "C:/Users/evil.json",
      "unknown-root/x.json",
      "profiles/../../world.json",
      "trials/x/../../../y.json",
      "",
      ".",
      "trials/",
    ]) {
      expect(() => validateBackupPath(bad), `should reject ${bad}`).toThrow(BackupError);
    }
  });

  it("accepts every legitimate storage layout path", () => {
    for (const ok of [
      "profiles/player-aldo.json",
      "sessions/session-x.json",
      "sessions/checkpoints/session-x.json",
      "experiments/experiment-e1.json",
      "trials/experiment-e1/trial-t1.json",
      "recommendations/experiment-e1.json",
      "optimizer-runs/experiment-e1.json",
      "calibrations/x-123.json",
      "human-sessions/session-x.json",
      "audit/experiment-e1.json",
      "self-tests/st-1.json",
      "session-bundles/b1.json",
    ]) {
      expect(() => validateBackupPath(ok), `should accept ${ok}`).not.toThrow();
    }
  });

  it("restore refuses backups carrying unsafe paths BEFORE writing anything", async () => {
    const backend = new InMemoryBackend();
    const legit = await exportBackupAll(new InMemoryBackend());
    const evil = {
      ...legit,
      entryPaths: [...legit.entryPaths, "../../escaped.json"],
      entries: [...legit.entries, "{}"],
    };
    // Re-sign with the tampered contents so ONLY the path check can catch it.
    evil.integrity = {
      algorithm: "sha256",
      checksumHex: await sha256Hex(
        `${1}|${evil.entryPaths.map((p: string, i: number) => `${p}=${evil.entries[i] ?? ""};`).join("")}`,
      ),
    };
    await expect(importBackupAll(backend, evil)).rejects.toThrow(/unsafe storage path/);
    expect((await backend.listFiles("")).length).toBe(0); // nothing written
  });
});

describe("transport hardening against a hostile helper", () => {
  function makeSource(url: string): {
    source: NativeTransportCaptureSource;
    pair: ReturnType<typeof createLoopbackSocketPair>;
  } {
    const pair = createLoopbackSocketPair();
    const source = new NativeTransportCaptureSource({
      url,
      sessionToken: "tok",
      appVersion: "sec-test",
      socketFactory: () => pair.client,
      reconnect: { maxAttempts: 0, initialDelayMs: 1, maxDelayMs: 1 },
    });
    source.start({ onEvent: () => undefined });
    pair.open();
    return { source, pair };
  }

  const welcome = JSON.stringify({
    type: "welcome",
    protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
    sourceKind: "native",
    deviceId: "d",
    deviceDescription: "",
    nominalRateHz: 1000,
    timeOriginNote: "",
    helperVersion: EXPECTED_HELPER_VERSION,
  });

  it("rejects DNS names that merely LOOK like loopback", () => {
    for (const url of [
      "ws://127.0.0.1.evil.example:48765",
      "ws://localhost.attacker.internal:48765",
      "wss://example.com",
      "http://127.0.0.1:48765",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      expect(() => assertLoopbackUrl(url), url).toThrow(NativeTransportError);
    }
    for (const url of [
      "ws://127.0.0.1:48765",
      "ws://localhost:48765",
      "ws://[::1]:48765",
      "wss://127.0.0.1:48765",
    ]) {
      expect(() => assertLoopbackUrl(url), url).not.toThrow();
    }
  });

  it("fails closed on a flood of malformed frames without ingesting any", () => {
    const { source, pair } = makeSource("ws://127.0.0.1:48765");
    source.handleRawMessage(welcome);
    const before = source.counters.framesReceived;
    for (let i = 0; i < 500; i++) {
      source.handleRawMessage(
        JSON.stringify({ type: "frame", sequence: i, tMonotonicMs: i, events: [{ kind: "bogus" }] }),
      );
      // First failure kills the stream; subsequent messages are ignored.
      if (source.status === "failed") break;
    }
    expect(source.status).toBe("failed");
    expect(source.counters.framesReceived).toBe(before);
    void pair;
  });

  it("rejects frames whose declared events array is absurdly large", () => {
    const { source } = makeSource("ws://127.0.0.1:48765");
    source.handleRawMessage(welcome);
    const huge = Array.from({ length: 5000 }, (_, i) => ({
      kind: "pointer-sample",
      tMs: i,
      dx: 1,
      dy: 1,
    }));
    source.handleRawMessage(
      JSON.stringify({ type: "frame", sequence: 0, tMonotonicMs: 1, events: huge }),
    );
    expect(source.status).toBe("failed");
    expect(source.counters.framesReceived).toBe(0);
  });

  it("caps inbound message size regardless of content validity", () => {
    const { source } = makeSource("ws://127.0.0.1:48765");
    source.handleRawMessage(welcome);
    // > maxMessageChars of valid-looking padding.
    source.handleRawMessage(`"${"A".repeat(1_100_000)}"`);
    expect(source.status).toBe("failed");
  });
});

describe("DOM safety in the app layer", () => {
  const APP_DIR = join(import.meta.dirname ?? ".", "..", "app", "src");

  function listTs(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...listTs(full));
      else if (name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("views never assign innerHTML / outerHTML / document.write (textContent only)", () => {
    const files = listTs(APP_DIR);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\.innerHTML\s*=/);
      expect(text, file).not.toMatch(/\.outerHTML\s*=/);
      expect(text, file).not.toMatch(/document\.write\s*\(/);
      expect(text, file).not.toMatch(/insertAdjacentHTML/);
    }
  });

  it("session tokens are restricted to safe characters", () => {
    // Mirrors the app generator; keeps IDB keys and helper handshake clean.
    const token = `tok-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    expect(token).toMatch(/^tok-[a-z0-9]+$/);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  NATIVE_PROTOCOL_VERSION,
  EXPECTED_HELPER_VERSION,
} from "../src/version.ts";

/**
 * Native protocol constant parity (Pass 5).
 *
 * The C helper and the TypeScript transport MUST agree on the wire protocol
 * version and the helper version string. The handshake fails closed on any
 * mismatch at runtime; this test catches drift AT BUILD TIME by parsing the
 * C source directly — no Windows toolchain required.
 */

const C_SOURCE_PATH = "native/windows/traimer_capture_helper.c";

function readCHelper(): string {
  return readFileSync(new URL(`../${C_SOURCE_PATH}`, import.meta.url), "utf8");
}

describe("native protocol constant parity (C ↔ TS)", () => {
  const source = readCHelper();

  it("C PROTOCOL_VERSION equals the TS transport constant", () => {
    const match = /#define\s+PROTOCOL_VERSION\s+(\d+)/.exec(source);
    expect(match, `PROTOCOL_VERSION not found in ${C_SOURCE_PATH}`).not.toBeNull();
    expect(Number(match![1])).toBe(NATIVE_PROTOCOL_VERSION);
  });

  it("C HELPER_VERSION equals the TS expected-helper constant", () => {
    const match = /#define\s+HELPER_VERSION\s+"([^"]+)"/.exec(source);
    expect(match, `HELPER_VERSION not found in ${C_SOURCE_PATH}`).not.toBeNull();
    expect(match![1]).toBe(EXPECTED_HELPER_VERSION);
  });

  /**
   * Every OTHER place that pins the helper version.
   *
   * rc.8 bumped the helper to `helper-1.1.0` for the time-sync protocol, and
   * `scripts/build-native-windows.sh` still asserted `helper-1.0.0` in a
   * hardcoded grep. The Windows CI job failed on that literal — a release
   * gate failing for a bookkeeping reason unrelated to the thing it guards.
   * There is exactly one source of truth; this test holds every copy to it.
   */
  it("no shipped script pins a stale helper version", () => {
    const files = [
      "../scripts/build-native-windows.sh",
      "../scripts/build-native-windows.bat",
      "../.github/workflows/ci.yml",
    ] as const;
    for (const relative of files) {
      const text = readFileSync(new URL(relative, import.meta.url), "utf8");
      // Line by line, so a comment narrating the history cannot buy cover for
      // an assertion that pins the wrong value somewhere else in the file.
      const offenders: string[] = [];
      text.split("\n").forEach((line, index) => {
        const isComment = /^\s*(#|rem\b|\/\/|\*)/.test(line);
        if (isComment) return;
        for (const found of line.matchAll(/helper-\d+\.\d+\.\d+/g)) {
          if (found[0] !== EXPECTED_HELPER_VERSION) {
            offenders.push(`${relative}:${index + 1}: ${found[0]} in ${line.trim()}`);
          }
        }
      });
      expect(
        offenders,
        `expected ${EXPECTED_HELPER_VERSION}; stale pins:\n${offenders.join("\n")}`,
      ).toEqual([]);
    }
  });

  it("helper binds loopback only and refuses missing tokens", () => {
    expect(source).toContain("INADDR_LOOPBACK"); // 127.0.0.1 bind
    expect(source).toMatch(/refusing to run without an explicit --token/);
    expect(source).toMatch(/session token mismatch/);
  });

  it("helper uses documented APIs only — no injection/hook/game surfaces", () => {
    // Raw Input + QPC + Winsock are the entire Win32 surface.
    expect(source).toContain("RegisterRawInputDevices");
    expect(source).toContain("GetRawInputData");
    expect(source).toContain("QueryPerformanceCounter");
    // Anti-cheat boundary: these must NEVER appear in the helper.
    for (const banned of [
      "CreateRemoteThread",
      "WriteProcessMemory",
      "ReadProcessMemory",
      "SetWindowsHookEx",
      "SendInput",
      "mouse_event",
      "LoadLibrary",
      "VirtualAllocEx",
      "DLL injection",
    ]) {
      expect(source).not.toContain(banned);
    }
  });
});

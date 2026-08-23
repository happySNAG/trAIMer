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

const C_SOURCE_PATH = "native/windows/aldo_capture_helper.c";

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

# Building the Windows native capture helper

`aldo_capture_helper.c` is a single-file, dependency-free C program using only
documented Win32 APIs (`RegisterRawInputDevices`, `GetRawInputData`,
`QueryPerformanceCounter`, `GetRawInputDeviceInfo`, Winsock loopback).

## Microsoft Visual Studio (recommended on the Aldo Fortnite machine)

From a Developer Command Prompt:

```bat
cd native\windows
cl /O2 /W4 /DUNICODE /D_UNICODE aldo_capture_helper.c /Fe:aldo_capture_helper.exe ws2_32.lib user32.lib
```

## MinGW-w64

```bat
gcc -O2 -Wall -Werror -o aldo_capture_helper.exe aldo_capture_helper.c -lws2_32 -luser32
```

## Cross-checking the source from macOS/Linux

You cannot ship a cross-built helper — the shipped binary is always the MSVC
`/W4 /WX` build produced by the `native-windows` CI job, the single build
authority for releases. But you can prove the source COMPILES without a
Windows machine, which is worth doing before pushing:

```bash
# zig bundles the mingw-w64 headers and libs; no toolchain install needed
zig cc -target x86_64-windows-gnu -O2 -Wall -Wextra -Wshadow \
  -o /tmp/aldo_capture_helper.exe native/windows/aldo_capture_helper.c \
  -lws2_32 -luser32

node scripts/verify-windows-artifacts.mjs --helper /tmp/aldo_capture_helper.exe
```

`x86_64-w64-mingw32-gcc` works the same way. Neither reproduces MSVC-specific
diagnostics (C4996 deprecation, for instance), so a clean cross-build is a
smoke check, not a substitute for the CI compile.

## Running

```bat
aldo_capture_helper.exe --port 48765 --token <random-secret> [--parent-pid PID]
```

- The token MUST be supplied and must match the token configured in the Aim Lab
  app; it prevents two Aim Lab instances (or any other local program) from
  consuming each other's stream.
- The helper binds **127.0.0.1 only**. It never opens a firewall prompt and is
  unreachable from the network.
- `--parent-pid` makes the helper watch the process that launched it and exit
  when that process does. The desktop shell passes its own PID, so a helper
  can never be orphaned holding the port if the shell is killed hard. Omit it
  and the helper runs until stopped, as before.
- Press Ctrl+C or close the console to stop it.

## What it does / does not do

| Does | Never does |
|---|---|
| Reads raw mouse deltas via Raw Input (RIDEV_INPUTSINK) | Inject DLLs into any process |
| Reports button press/release with monotonic timestamps | Read/write other processes' memory |
| Reports device arrival/removal lifecycle events | Hook or synthesize input for games |
| Serves one authenticated loopback WebSocket client | Touch game files or anti-cheat |
| Preserves exact hardware counts at up to 8 kHz+ | Send anything to the network |

This is functionally identical to what common input-latency/measurement
utilities do; it observes desktop input without touching any game.

## Verifying a build

First, prove the file is a real, runnable Windows x64 program. `v1.0.0-rc.1`
shipped this source file under the `.exe` name and Windows answered *"The
specified executable is not a valid application for this OS platform."*

```bat
aldo_capture_helper.exe --version
rem -> aldo_capture_helper version=helper-1.0.0 protocol=1 arch=x64
```

`--version` registers no devices, opens no sockets and creates no windows; it
prints and exits 0. CI runs exactly this, plus a byte-level PE check:

```bash
node scripts/verify-windows-artifacts.mjs --helper native/windows/aldo_capture_helper.exe
```

Then exercise the real capture path:

```bat
aldo_capture_helper.exe --port 48765 --token test-token
```

Then in PowerShell:

```powershell
# A browser-based check page ships in the app under Diagnostics → Native.
```

The Aim Lab app's Diagnostics view connects to `ws://127.0.0.1:48765`, performs
the versioned handshake, runs the stream diagnostics (rate, jitter, sequence
integrity) for a chosen duration, and reports pass/warn/fail per check.

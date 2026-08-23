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
gcc -O2 -Wall -o aldo_capture_helper.exe aldo_capture_helper.c -lws2_32 -luser32
```

## Running

```bat
aldo_capture_helper.exe --port 48765 --token <random-secret>
```

- The token MUST be supplied and must match the token configured in the Aim Lab
  app; it prevents two Aim Lab instances (or any other local program) from
  consuming each other's stream.
- The helper binds **127.0.0.1 only**. It never opens a firewall prompt and is
  unreachable from the network.
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

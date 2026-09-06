# Installing Aldo Aim Lab on Windows

One file. Double-click it. That is the whole procedure.

## What you need

- `AldoAimLab-Setup-1.0.0-rc.3.exe` (also copied as `AldoAimLab-Setup.exe`)
- Windows 10 or 11, 64-bit (`PROCESSOR_ARCHITECTURE = AMD64`)

You do **not** need PowerShell, a terminal, a browser, a compiler, admin
rights, or any developer tools.

## Install

1. Copy `AldoAimLab-Setup.exe` from the flash drive to the Desktop (running it
   from the drive works too, it is just slower).
2. Double-click it.
3. Windows SmartScreen will say the publisher is unknown — the build is not
   code-signed yet. Click **More info → Run anyway**.
4. The normal installer window appears. Click through it. It installs for the
   current user only: no admin prompt, no services, no drivers, no registry
   surgery beyond the standard uninstall entry.
5. When it finishes, an **Aldo Aim Lab** icon is on the Desktop and in the
   Start Menu.

Default install location: `%LOCALAPPDATA%\Programs\Aldo Aim Lab`.

## Launch

Double-click the **Aldo Aim Lab** icon.

The application window opens and everything starts by itself:

- the interface loads inside the app (no browser, no address bar),
- the native capture helper starts hidden in the background,
- the Diagnostics tab's **Capture helper** tile shows `Running on port …`.

If Windows Defender or the firewall asks about `aldo_capture_helper.exe`,
allow it. It listens on `127.0.0.1` only and never talks to the network.

Launching a second time just brings the window you already have to the front —
it never starts a second helper or a second copy of the app.

## Close

Close the window. The app stops the capture helper and every child process it
started before it exits. Nothing is left running.

## First session

1. Open **Diagnostics** once and run the guided capture check. This is what
   earns high-confidence ("tier-1") measurement; without a passing self-test
   the engine deliberately caps its confidence.
2. Open the **Test** tab, confirm the readiness checks are green (player name,
   mouse DPI, starting sensitivity).
3. **Start session**, click the arena to lock the mouse in, and play. Candidate
   sensitivities stay hidden until the end.
4. Your recommendation appears on **Results** with an honest confidence label.

Back up any time from the **Data** tab.

## If the capture helper does not start

The app still works. It falls back to browser-tier capture, which samples at
frame rate instead of the mouse's full polling rate, and every result is
labelled with the lower confidence that deserves. The Diagnostics tab names
the exact reason code and offers **Restart capture helper**.

Reason codes you may see:

| Code | Meaning |
| --- | --- |
| `HELPER_MISSING` | The installed helper file is gone — reinstall. |
| `HELPER_SPAWN_FAILED` | Windows refused to start it (usually antivirus quarantine). |
| `HELPER_NOT_READY` | It started but never accepted a local connection. |
| `HELPER_CRASHED` | It exited repeatedly and was not restarted again. |
| `HELPER_NO_FREE_PORT` | Ports 48765-48776 are all occupied. |

The shell writes a plain-text log to
`%APPDATA%\AldoAimLab\logs\desktop.log`. It stays on the machine.

## Your data

Training history, calibration and settings live in `%APPDATA%\AldoAimLab`.

Uninstalling (Settings → Apps → Aldo Aim Lab, or the Start Menu uninstaller)
removes the application and **keeps** that data, so a reinstall picks up where
you left off. The uninstaller asks once whether you also want the data
deleted; the default answer, and the answer any silent/automatic uninstall
gets, is **no**.

## What this program does and does not do

It observes physical mouse movement through the documented Windows Raw Input
API — the same mechanism accessibility tools and input-statistics utilities
use — and measures your aim inside its own window.

It does not inject into any process, read or write another program's memory,
hook or synthesise input for other applications, modify game files, or
interact with anti-cheat software in any way. It makes no network connections
beyond `127.0.0.1` on your own PC. There is no account, no telemetry, and
nothing to sign in to.

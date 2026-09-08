# Privacy

trAIMer runs entirely on your own PC. There is no account, no sign-in, no
cloud, no analytics and no crash reporting. This document says exactly what
the application stores, where, and what happens to it when you uninstall.

## No telemetry, no network

- The application makes **no network requests** for any part of its normal
  use. Nothing is uploaded, nothing is downloaded, nothing phones home.
- This is enforced in CI, not just promised: `scripts/audit-no-telemetry.mjs`
  fails the build if `fetch`, `XMLHttpRequest`, `sendBeacon`, `EventSource`,
  a non-loopback WebSocket, or any non-local URL literal appears in the
  sources or in the shipped bundle.
- The one network-shaped thing that exists is **local only**: the native
  capture helper listens on `127.0.0.1` (your own machine, never a network
  interface) on a port between 48765 and 48776, and accepts exactly one
  client, the app window, authenticated by a token generated fresh at every
  launch. See [SECURITY.md](SECURITY.md).
- Game profiles cite reference URLs as provenance. They are displayed as
  links; the app never fetches them. Clicking one opens your system browser,
  which is then an ordinary browser visit by you.
- There is no update checker. You find out about new versions from the
  project page, not from the app.

## What is stored

Everything below stays on the machine.

| Data | What it is | Where |
| --- | --- | --- |
| Training history | Every session, drill, trial, measurement, recommendation and calibration record you produce | A browser-style IndexedDB database inside the app's user-data folder |
| Settings | Player name, mouse DPI, starting sensitivity, chosen game profile and the sensitivity you entered for it, calibration mode, break settings, experiment seed, recently used games | Browser-style local storage inside the same folder |
| Helper session token | A random token that pairs the app window with the capture helper for this launch | Local storage inside the same folder |
| Desktop shell log | Plain-text log of the shell's own start-up, helper lifecycle and errors (`desktop.log`). No mouse data, no session data | `logs\` inside the user-data folder |
| Backups and exports | Files you create from the **Data** tab: a whole-database backup, a single-session bundle, or a diagnostic bundle | Wherever you choose to save them |

The user-data folder on Windows is `%APPDATA%\trAIMer`. If you upgraded from
a build older than 1.0.0-rc.7, the folder was moved there from the product's
earlier name on first launch; the contents are the same.

The IndexedDB database keeps its original internal name from before the
product was renamed. That name never appears in the interface and is kept
only because renaming it would hide every existing player's history.

What a stored session contains: timestamps, raw mouse counts per sample,
button presses, target positions, the blinded candidate sensitivities and
which one each drill ran on, the computed metrics, the recommendation, the
app and engine versions that produced it, and the game conversion if a game
was selected. It also records the mouse's device description as reported by
Windows Raw Input, and the browser engine's user-agent string, so the
capture path can be audited later. It does not contain your Windows user
name, machine name, IP address, or anything from outside the app window.

## What is not stored

- No screenshots or screen recordings.
- No keyboard input, other than the keys the app itself binds (Escape, Space,
  Enter for pausing and skipping).
- No mouse movement outside a drill. The capture helper receives raw mouse
  counts whenever it is running (that is how Raw Input works), but the app
  records them only during a drill or a diagnostics probe you start
  yourself, and the helper itself writes nothing to disk.
- No data from any game or any other program.

## Uninstall

Uninstalling from **Settings → Apps** or the Start Menu uninstaller removes
the application and **keeps** the user-data folder, so a reinstall picks up
your history. The uninstaller asks once whether you also want your data
deleted. The default answer, and the answer any silent or automated uninstall
gets, is **No**. This is tested in CI: a silent uninstall followed by a
reinstall must show every earlier session in History.

To remove everything yourself: uninstall, then delete `%APPDATA%\trAIMer`
(and, if it still exists from an older install, the folder under the
product's earlier name in the same location). Any backups or exports you
saved elsewhere are ordinary files you delete yourself.

## The browser development build

Developers running `npm run app` use the same frontend in an ordinary
browser. In that mode the data above lives in that browser's storage for
`http://localhost:5173` and follows the browser's own rules. This build is
not what players install.

## Changes

If any of this changes, this file changes in the same release, and the
release notes say so.

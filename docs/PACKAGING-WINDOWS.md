# Windows packaging

trAIMer ships to players as **one Windows installer**.

```
trAIMer-Setup-<version>.exe      ← the product (NSIS + Electron shell)
```

Double-click, install, launch from the Start Menu / Desktop icon. No
PowerShell, no terminal, no browser step, no compiler, no admin rights. The
architecture and the release gates behind it are documented in
`docs/DESKTOP-SHELL.md`; the player-facing instructions are
`docs/INSTALL-WINDOWS.md`.

Built by the `windows-installer` job in `.github/workflows/ci.yml`:

1. `native-windows` compiles `traimer_capture_helper.exe` with MSVC `/W4 /WX`.
2. `windows-installer` downloads it, **verifies it is a real x64 PE**, runs it
   with `--version` to prove it executes, builds `dist-app/` and
   `dist-desktop/`, then runs `electron-builder --win nsis --x64`.
3. The installer is silently installed on the runner, the installed layout is
   verified, and the installed app is smoke-tested for startup and clean
   shutdown before the artifact is uploaded.

---

# Portable folder (advanced / diagnostic path)

The pre-Pass-9 portable folder is retained for development and troubleshooting
only. It is **not** what players receive and it is not produced by the
installer.

## Shipped layout

Assembled deterministically by `scripts/package-release.mjs` (CI) or
`npm run package:dry-run` (local, placeholder helper):

```
trAIMer-v<version>/
├── traimer_capture_helper.exe      ← MSVC-compiled Raw Input observer
├── app/                         ← contents of dist-app/ (relative asset base)
├── start-traimer.ps1           ← one-click launcher
├── stop-traimer.ps1            ← clean shutdown via recorded PIDs only
├── FIRST-RUN.md                 ← zero-knowledge quick start
├── manifest.json                ← versions, commit, per-file SHA-256
└── trAIMer-v<version>-SHA256SUMS.txt     (written beside the folder)
```

CI zips the folder as `trAIMer-v<version>-windows-x64.zip`, prints the
zip's SHA-256 into the job summary, and uploads both (90-day retention).
No source tree, tests, node_modules, secrets, or local paths ship.

## Launcher contract (`start-traimer.ps1`)

1. Sanity checks: helper present (offers honest browser-capture fallback if
   missing), `manifest.json` version metadata cross-check, helper SHA-256
   warning on mismatch.
2. Refuses to fight a running instance: probes the capture port first.
3. Mints a FRESH 32-hex-char session token (`RNGCryptoServiceProvider`),
   shape-checked before use.
4. Starts `traimer_capture_helper.exe --port 48765 --token <token>` hidden,
   records the PID in `.traimer/helper.pid`, and waits (≤10 s) for the
   loopback listen socket.
5. Picks a free web-server port from 48800–48809 and serves `app/` with an
   `HttpListener` bound to `http://127.0.0.1:<port>/` ONLY (loopback is a
   secure context, so Pointer Lock works). Traversal-guarded static serving,
   MIME allowlist, GET-only. A one-time UAC-elevated `netsh http add urlacl`
   is offered if http.sys permissions are missing; declining falls back to
   documented manual options.
6. Opens the default browser at `http://127.0.0.1:<port>/index.html?token=<token>`;
   the app adopts the token once and immediately strips it from the URL.
7. Closing the window or running `stop-traimer.ps1` tears everything down
   from the recorded PID files (strictly integer-parsed; never kills by name).

State lives ONLY inside the install folder (`.traimer/*.pid`) — uninstall =
delete the folder.

## Why the portable folder is no longer the product

The original rationale ("no admin rights, no system mutation, the browser
already provides the rendering stack") is preserved by the installer, which is
per-user, needs no elevation, installs no services and no drivers, and keeps
every artifact under `%LOCALAPPDATA%\Programs\trAIMer` and
`%APPDATA%\trAIMer`.

What the portable folder could not preserve was the product experience: it
required unblocking and running `.ps1` files, keeping a console window open,
and driving the app through an external browser. Pass 9 moved that whole path
into the desktop shell.

## Build & release flow

1. `npm ci && npm test && npm run build` → commit-tagged `dist-app/`.
2. `scripts/build-native-windows.sh --compile` (or `.bat`) on a Windows
   runner → `traimer_capture_helper.exe`. CI compiles this automatically
   (.github/workflows/ci.yml, native-windows job, /W4 /WX).
3. `node scripts/package-release.mjs --helper <exe> --commit <sha>` assembles
   the folder + checksums; `node scripts/verify-release.mjs --release-dir <folder>`
   recomputes every hash and refuses placeholder helpers.
4. Repack determinism: identical inputs produce byte-identical manifests and
   SHA256SUMS (the MSVC exe itself embeds timestamps and is pinned by hash).

## First run on Aldo's PC

Covered by the preflight system (`src/preflight/preflight.ts`, Diagnostics
tab): token match, protocol/helper-version parity (fail-closed at the
handshake), capture self-test before tier-1 trust, storage/DPI/calibration
checks. Any failure names a stable reason code — nothing degrades silently.

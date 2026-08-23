# Windows packaging (V1 RC approach)

Aldo Aim Lab is a **local-first browser app plus a native capture helper**.
Pointer Lock requires a secure context, so the shipped product is a small
portable folder run from disk — no installer, no registry writes, no
services, no drivers.

## Ship layout

```
AldoAimLab/
├── aldo_capture_helper.exe      ← Raw Input telemetry (native/windows/)
├── start-aldo-lab.ps1           ← one-click launcher (below)
├── stop-aldo-lab.ps1            ← clean shutdown of helper + server
└── app/                         ← contents of dist-app/ (static bundle)
```

## Launcher contract (`start-aldo-lab.ps1`)

1. Generate (or reuse) `%LOCALAPPDATA%\AldoAimLab\session-token` — 32 random
   hex chars via `Get-Random`/RNG. This is the helper handshake token.
2. Start `aldo_capture_helper.exe --port 48765 --token <token>` **without a
   console window**; record its PID.
3. Serve `app/` on `http://127.0.0.1:8123` with correct MIME types. V1 uses a
   dependency-free PowerShell `HttpListener` loopback server embedded in the
   launcher (~80 lines); it binds 127.0.0.1 only.
4. Open the user's default browser at that URL. Chromium-family browsers give
   the tested Pointer Lock behavior (see the support matrix in
   `docs/RELEASE.md`).
5. On `stop-aldo-lab.ps1`: stop the HTTP listener, then terminate the helper
   PID. An orphaned helper is harmless by design (loopback-only, exits at
   shutdown), but the stop routine makes cleanup deterministic.

The launcher itself is deliberately tiny and auditable; it starts/stops two
local processes and never touches the network beyond loopback.

## Why not an installer / Electron?

- No admin rights, no system mutation → matches the anti-cheat-safe,
  audit-friendly posture (docs/SECURITY-REVIEW.md).
- The browser already provides the rendering stack on the target machine;
  Electron would triple the binary size for zero benefit in V1.
- Every artifact stays inside the project folder + `%LOCALAPPDATA%`
  (session token only). Uninstall = delete the folder.

## Build & release flow

1. `npm ci && npm test && npm run build` → commit-tagged `dist-app/`.
2. `scripts/build-native-windows.sh --compile` (or `.bat`) on a Windows
   runner → `aldo_capture_helper.exe`. CI compiles this automatically
   (.github/workflows/ci.yml, native-windows job).
3. Assemble the folder above, run `node scripts/verify-release.mjs`, and
   attach the zip to the release tag.

## First run on Aldo's PC

Covered by the preflight system (`src/preflight/preflight.ts`, Diagnostics
tab): token match, protocol/helper-version parity, capture self-test before
tier-1 trust, storage/DPI/calibration checks. Any failure names a stable
reason code — nothing degrades silently.

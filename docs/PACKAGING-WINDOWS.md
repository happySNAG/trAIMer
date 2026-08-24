# Windows packaging (V1 RC approach)

Aldo Aim Lab is a **local-first browser app plus a native capture helper**.
Pointer Lock requires a secure context, so the shipped product is a small
portable folder run from disk — no installer, no registry writes, no
services, no drivers.

## Shipped layout

Assembled deterministically by `scripts/package-release.mjs` (CI) or
`npm run package:dry-run` (local, placeholder helper):

```
AldoAimLab-v<version>/
├── aldo_capture_helper.exe      ← MSVC-compiled Raw Input observer
├── app/                         ← contents of dist-app/ (relative asset base)
├── start-aldo-lab.ps1           ← one-click launcher
├── stop-aldo-lab.ps1            ← clean shutdown via recorded PIDs only
├── FIRST-RUN.md                 ← zero-knowledge quick start
├── manifest.json                ← versions, commit, per-file SHA-256
└── AldoAimLab-v<version>-SHA256SUMS.txt  (written beside the folder)
```

CI zips the folder as `Aldo-Aim-Lab-v<version>-windows-x64.zip`, prints the
zip's SHA-256 into the job summary, and uploads both (90-day retention).
No source tree, tests, node_modules, secrets, or local paths ship.

## Launcher contract (`start-aldo-lab.ps1`)

1. Sanity checks: helper present (offers honest browser-capture fallback if
   missing), `manifest.json` version metadata cross-check, helper SHA-256
   warning on mismatch.
2. Refuses to fight a running instance: probes the capture port first.
3. Mints a FRESH 32-hex-char session token (`RNGCryptoServiceProvider`),
   shape-checked before use.
4. Starts `aldo_capture_helper.exe --port 48765 --token <token>` hidden,
   records the PID in `.aldo-lab/helper.pid`, and waits (≤10 s) for the
   loopback listen socket.
5. Picks a free web-server port from 48800–48809 and serves `app/` with an
   `HttpListener` bound to `http://127.0.0.1:<port>/` ONLY (loopback is a
   secure context, so Pointer Lock works). Traversal-guarded static serving,
   MIME allowlist, GET-only. A one-time UAC-elevated `netsh http add urlacl`
   is offered if http.sys permissions are missing; declining falls back to
   documented manual options.
6. Opens the default browser at `http://127.0.0.1:<port>/index.html?token=<token>`;
   the app adopts the token once and immediately strips it from the URL.
7. Closing the window or running `stop-aldo-lab.ps1` tears everything down
   from the recorded PID files (strictly integer-parsed; never kills by name).

State lives ONLY inside the install folder (`.aldo-lab/*.pid`) — uninstall =
delete the folder.

## Why not an installer / Electron?

- No admin rights, no system mutation → matches the anti-cheat-safe,
  audit-friendly posture (docs/SECURITY-REVIEW.md).
- The browser already provides the rendering stack on the target machine;
  Electron would triple the binary size for zero benefit in V1.
- Every artifact stays inside the project folder. Uninstall = delete it.

## Build & release flow

1. `npm ci && npm test && npm run build` → commit-tagged `dist-app/`.
2. `scripts/build-native-windows.sh --compile` (or `.bat`) on a Windows
   runner → `aldo_capture_helper.exe`. CI compiles this automatically
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

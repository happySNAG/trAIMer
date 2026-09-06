# Windows desktop shell (Pass 9)

## Why this exists

`v1.0.0-rc.1` reached Aldo's PC as a portable folder driven by
`start-aldo-lab.ps1`. Two things were wrong with it:

1. **Release-blocking defect.** The packaged `aldo_capture_helper.exe` was
   byte-for-byte `native/windows/aldo_capture_helper.c`
   (`sha256 5af4339191f8…`). Windows reported *"The specified executable is
   not a valid application for this OS platform."* The packager copied
   whatever `--helper` pointed at and never looked at the bytes, and a local
   macOS `--allow-placeholder-helper` dry-run folder was what got copied to
   the USB stick.
2. **Product shape.** Even with a real binary, the launch path was: unblock a
   `.ps1`, run it with PowerShell, keep a console window open, let it open a
   browser, and stop it with a second `.ps1`. That is a developer workflow,
   not a consumer application.

Pass 9 replaces the launch path with an installed desktop application and
makes the packaging defect structurally impossible.

## Architecture

```
AldoAimLab-Setup-<version>.exe        (NSIS, electron-builder)
        │  installs, per-user, no elevation
        ▼
%LOCALAPPDATA%\Programs\Aldo Aim Lab\
├── Aldo Aim Lab.exe                  ← Electron shell (desktop/main.ts)
├── resources\app.asar                ← dist-desktop/ + dist-app/
└── resources\aldo_capture_helper.exe ← MSVC-compiled Raw Input helper
                                         (outside the asar so it is spawnable)
```

The Electron main process owns everything the launcher used to:

| Responsibility | Implementation |
| --- | --- |
| App window | `desktop/main.ts` — sandboxed, context-isolated, no menu bar |
| Frontend delivery | `desktop/frontendProtocol.ts` — `aldo://app/…` custom scheme |
| Static-file rules | `desktop/staticFiles.ts` — traversal guard + MIME allowlist |
| Helper lifecycle | `desktop/captureHelper.ts` — spawn, readiness, restart, teardown |
| Session token | `desktop/sessionToken.ts` — 32 hex chars, per launch, in memory |
| Renderer bridge | `desktop/preload.ts` → `app/src/desktopBridge.ts` |
| Single instance | `app.requestSingleInstanceLock()` |
| User data | `%APPDATA%\AldoAimLab` (`app.setName`) |
| Installer/uninstaller | `electron-builder.yml` + `build/installer.nsh` |

### Why a custom scheme instead of a loopback HTTP server

Pointer Lock needs a secure context, and IndexedDB — where **all** training
history lives — is keyed by origin. A loopback server would either need a
fixed port (which collides) or an ephemeral one (which silently orphans a
player's history on the next launch). `aldo://app` is registered
`standard: true, secure: true, corsEnabled: true`, giving a permanently
stable, potentially-trustworthy origin with no listening socket at all.

Verified end to end by the smoke test's IndexedDB write/read round trip.

### Helper lifecycle

```
launch ─► mint token (16 random bytes → 32 hex)
       ─► scan 48765..48776 for a free loopback port
       ─► spawn aldo_capture_helper.exe --port N --token T
             (argument array, shell:false, windowsHide:true)
       ─► poll 127.0.0.1:N until it accepts, ≤10 s
       ─► state "ready", renderer receives ws://127.0.0.1:N over the bridge
```

- Unexpected exit → at most 2 automatic restarts, then `HELPER_CRASHED`.
- Every failure is a stable reason code surfaced in Diagnostics, never a
  silent downgrade. The app keeps working on browser-tier capture, and the
  engine's existing confidence gates handle the rest.
- `before-quit` awaits `helper.stop()`: polite kill, then `SIGKILL` after a
  3 s grace period. Closing the window stops every process the app started.
- A second launch hits the single-instance lock and focuses the existing
  window before any helper or protocol work happens.

### Safety boundary (unchanged)

Raw Input observation on loopback only. No injection, no hooks into games, no
foreign process memory, no anti-cheat interaction, no synthetic input. The
shell adds: renderer sandbox + context isolation, a CSP whose `connect-src`
is limited to `ws://127.0.0.1:*`, navigation locked to the app origin, and a
permission handler that grants only `pointerLock` and `fullscreen`.

## Release gates

`scripts/verify-windows-artifacts.mjs` is the missing check that rc.1 lacked.
It fails the build when the helper is missing, is source text, is zero or
implausibly small, is not a PE (`MZ` + `PE\0\0`), is not `IMAGE_FILE_MACHINE_AMD64`,
is a DLL, or when the installer/frontend/installed layout is incomplete.

`scripts/package-release.mjs` now runs that gate before copying anything to
the `aldo_capture_helper.exe` name, and its dry-run placeholder is written as
`aldo_capture_helper.exe.PLACEHOLDER-NOT-EXECUTABLE` — a name Windows will
never execute. No flag can bypass either rule.

CI adds the two gates that only a Windows host can prove:

- **execution**: the freshly compiled helper is run with `--version` and must
  exit 0 printing `version=helper-1.0.0 protocol=1 arch=x64`;
- **startup/shutdown**: the installed application is launched with
  `--smoke-test --require-helper`, which asserts the frontend rendered, the
  context bridge is live, IndexedDB works, the helper reached `ready`, and the
  process then shuts down cleanly on its own.

See `.github/workflows/ci.yml`, job `windows-installer`.

## The portable folder

`scripts/release/windows/*.ps1` and `scripts/package-release.mjs` are kept as
an **advanced/diagnostic** path (and their security contract tests still run).
They are not part of the shipped launch experience and are not installed by
the setup program.

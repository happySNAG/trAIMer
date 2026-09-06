# Aldo Aim Lab — Engineering Pass 9 Final Report

Status: **Complete — Windows distribution rebuilt as an installed desktop
application.** Feature commit `6b17267` — "Ship Aldo Aim Lab as an installed
Windows desktop application" (39 files, +6584/−199) — followed by this report
committed separately. Version advanced to **1.0.0-rc.3**.

Pass 9 was triggered by a release-blocking failure on real hardware. It is not
a feature pass: it replaces the Windows launch path, adds the release gates
that would have caught the failure, and proves the gates on the exact artifact
that failed.

---

## 1. Baseline commit

`777a85f` — "Add Pass 8 report".

(The worktree this pass started in was stale at `71bb87e`, three feature
commits behind `origin/main`. It was fast-forwarded before any work began;
`71bb87e` is an ancestor of `777a85f`, so nothing was lost or duplicated.
Pass 8 had already moved the line to `1.0.0-rc.2`, which is why the corrected
candidate is **rc.3**, not rc.2.)

## 2. The failure

On Aldo's Windows x64 PC (`PROCESSOR_ARCHITECTURE = AMD64`), the PowerShell
launcher reached the helper-launch step and Windows answered:

> The specified executable is not a valid application for this OS platform.

`aldo_capture_helper.exe` in `AldoAimLab-v1.0.0-rc.1/` began with the bytes
`47 42 10 32` — `/*` — and `Get-Content` showed:

```
/* Aldo Aim Lab — Windows native mouse capture helper...
```

## 3. Root cause (proven, not inferred)

```
$ git show 71bb87e:native/windows/aldo_capture_helper.c | shasum -a 256
5af4339191f8da715c9b05d6061fb0ebf2e08a649ecbab8914cc5813c16e3330  -

$ shasum -a 256 "/Volumes/NO NAME/AldoAimLab-v1.0.0-rc.1/aldo_capture_helper.exe"
5af4339191f8da715c9b05d6061fb0ebf2e08a649ecbab8914cc5813c16e3330
```

The shipped "executable" is the C source file, byte for byte (29 831 bytes,
identical length and digest). Three failures compounded:

1. **`scripts/package-release.mjs` never inspected the bytes it packaged.**
   `copyFileSync(helperPath, join(releaseDir, "aldo_capture_helper.exe"))` —
   any file handed to `--helper` became the shipped `.exe`.
2. **A dry-run escape hatch could occupy the real filename.**
   `--allow-placeholder-helper` existed so the folder/manifest pipeline could
   be exercised without a Windows compile. It recorded
   `helperBinaryIsPlaceholder: true` in the manifest, but it still wrote a
   non-binary file to `aldo_capture_helper.exe`.
3. **Nothing gated the dry-run output from shipping.** The rc.1 folder's own
   manifest says `"gitCommit": "LOCAL-DRY-RUN"` and
   `"helperBinaryIsPlaceholder": true`. It was produced on macOS, where no
   compiled helper can exist, and copied straight to the USB stick. The
   CI-side check for that flag lived in the `windows-release` job, which this
   folder never went through.

The CI machinery to build a real helper (`native-windows`, MSVC `/W4 /WX`)
already existed and worked. It simply was not the source of the artifact that
travelled to Aldo's PC, and no gate said so.

## 4. What changed in the product

Repairing the binary alone would have restored a launch path that was still a
developer workflow: unblock a `.ps1`, run it with PowerShell, keep a console
window open, let it open an external browser, stop it with a second `.ps1`.
Pass 9 replaces that with a conventional Windows application.

### Architecture chosen

Electron desktop shell + electron-builder/NSIS installer. The existing web
frontend is unchanged in substance; the shell wraps it.

| Responsibility | Owner |
| --- | --- |
| App window | `desktop/main.ts` |
| Local static frontend delivery | `desktop/frontendProtocol.ts` (`aldo://app`) |
| Static-file security rules | `desktop/staticFiles.ts` (traversal guard, MIME allowlist, CSP) |
| Native helper lifecycle | `desktop/captureHelper.ts` |
| Session token | `desktop/sessionToken.ts` |
| Renderer bridge | `desktop/preload.ts` → `app/src/desktopBridge.ts` |
| Single instance | `app.requestSingleInstanceLock()` |
| Installed user data | `%APPDATA%\AldoAimLab` |
| Installer / uninstaller | `electron-builder.yml`, `build/installer.nsh` |

**Why a custom scheme rather than a loopback HTTP server.** Pointer Lock needs
a secure context, and *all* training history lives in IndexedDB, which is
keyed by origin. A fixed port collides; an ephemeral port silently orphans a
player's history on the next launch. `aldo://app` is registered
`standard/secure/corsEnabled`, giving a permanently stable, potentially-
trustworthy origin with no listening socket. Proven by a real IndexedDB
write/read round trip inside the smoke test.

### Helper lifecycle

```
launch ─► mint token (16 random bytes → 32 hex, memory only)
       ─► scan 48765..48776 for a free loopback port
       ─► spawn aldo_capture_helper.exe --port N --token T
            (argument array, shell:false, windowsHide:true)
       ─► poll 127.0.0.1:N until it accepts, ≤10 s
       ─► "ready"; renderer receives ws://127.0.0.1:N over the context bridge
```

- Unexpected exit → at most 2 automatic restarts, then `HELPER_CRASHED`.
- Six stable reason codes (`HELPER_MISSING`, `HELPER_SPAWN_FAILED`,
  `HELPER_NOT_READY`, `HELPER_CRASHED`, `HELPER_NO_FREE_PORT`,
  `HELPER_PLATFORM_UNSUPPORTED`) surface in Diagnostics with a one-click
  restart. The app never silently degrades — it falls back to browser-tier
  capture and says so, and the engine's existing confidence gates do the rest.
- `before-quit` awaits `helper.stop()`: polite kill, then `SIGKILL` after a
  3 s grace period. Closing the window stops everything the app started.
- A second launch hits the single-instance lock and focuses the existing
  window before any helper or protocol work happens.

### Safety boundary — unchanged

Raw Input observation on loopback only. No injection, no hooks into games, no
foreign process memory, no anti-cheat interaction, no synthetic input, no
network egress beyond `127.0.0.1`. The shell *adds* hardening: renderer
sandbox + context isolation + no Node integration, a CSP whose `connect-src`
is limited to `ws://127.0.0.1:*`, navigation locked to the app origin,
`setWindowOpenHandler` denying all popups, and a permission handler that
grants only `pointerLock` and `fullscreen`.

## 5. Release gates added

`scripts/verify-windows-artifacts.mjs` is the check that did not exist. It
fails the build when:

| Gate | Detects |
| --- | --- |
| helper missing | absent artifact |
| helper begins with source text | **the exact rc.1 defect** |
| zero / implausibly small (< 16 KiB) | stub, truncation, placeholder |
| no `MZ` DOS header | not a Windows program |
| no `PE\0\0` signature | DOS stub only |
| machine ≠ `0x8664` | 32-bit or ARM64 build on an AMD64 target |
| `IMAGE_FILE_DLL` set | a library, not an application |
| installer missing / < 20 MB | broken electron-builder run |
| frontend assets missing | no `index.html`, no JS/CSS bundle |
| installed layout incomplete | missing exe, asar, or bundled helper |

Two structural fixes make the original mistake impossible rather than merely
detected:

- `package-release.mjs` runs the full PE gate before anything is copied to the
  `aldo_capture_helper.exe` name, with **no bypass flag**.
- Dry-run mode writes `aldo_capture_helper.exe.PLACEHOLDER-NOT-EXECUTABLE` —
  a name Windows will never execute and a name no launcher looks for.

Format checking alone would not have caught a corrupt or cross-compiled
binary, so the helper gained `--version` (registers no devices, opens no
sockets, creates no windows) and CI **runs the freshly compiled binary**,
requiring exit 0 and `version=helper-1.0.0 protocol=1 arch=x64`.

### CI path

`.github/workflows/ci.yml`, new job `windows-installer` (needs
`native-windows`), on `windows-latest`:

1. `npm ci`, lint, strict typecheck (engine **and** shell), full vitest suite,
   no-telemetry audit.
2. `npm run build` (frontend) → frontend-assets gate.
3. `npm run build:desktop` (Electron main + preload) → `verify-release.mjs`
   → `npm audit --audit-level=moderate`.
4. Download the MSVC-compiled helper → **PE gate** → **execution gate**.
5. `npx electron-builder --win nsis --x64` → **installer gate**.
6. Silent install (`/S /D=C:\aldo-install-test`) → **installed-layout gate**.
7. Launch the *installed* app with `--smoke-test --require-helper`, asserting:
   frontend rendered, context bridge live with a well-formed token, IndexedDB
   write/read round trip, helper reached `ready`, and **no `Aldo Aim Lab` or
   `aldo_capture_helper` process survives shutdown**.
8. Publish `AldoAimLab-Setup-<version>.exe` + a stable `AldoAimLab-Setup.exe`
   + SHA-256, 90-day retention.

The smoke test refuses to pass when the single-instance lock is already held
(exit 3), so a stale process left by `runAfterFinish` cannot fake a green run.

`native-windows` also gained the PE and execution gates, so a bad helper fails
at the earliest possible job.

## 5b. Two long-broken CI gates found while proving the pipeline

Pushing the work exposed that the Windows half of CI had not actually been
running. Both failures predate this pass and both were hiding real breakage.

**The MSVC compile step had never compiled anything.** It hardcoded
`C:\Program Files\Microsoft Visual Studio\2022\Enterprise\...\vcvars64.bat`,
a path that does not exist on the current `windows-latest` image — *"The
system cannot find the path specified."* This is the deeper reason a
placeholder could travel to a USB stick without anyone noticing: the pipeline
that was supposed to produce the real helper had been failing at step 6 for
some time. `scripts/build-native-windows.bat` now locates any Visual Studio
carrying the x64 C++ toolset via `vswhere`, falls back to MinGW, and fails
loudly otherwise; it also no longer tests `%errorlevel%` inside a
parenthesised block, where batch expands it at parse time and reads a stale
value.

**The helper source had never compiled.** Once `vswhere` found the toolset
(Visual Studio 18 Enterprise on the current image) and `cl` finally ran, MSVC
rejected the file outright: `RAWINPUTDEVICE_LIST` is not a Win32 type — the
real name is `RAWINPUTDEVICELIST`, with no underscore — and `strncpy` trips
C4996, which `/WX` turns into an error. Four errors and a deprecation in code
that had been reviewed across four passes and described in docs as compiled by
CI. This is the strongest confirmation of the root cause: no compiled helper
had ever existed, so a placeholder was the only thing available to package.
Fixed by correcting the type name and replacing `strncpy` with an explicit
always-NUL-terminating `copy_bounded` (rather than hiding the whole
deprecation class behind `_CRT_SECURE_NO_WARNINGS`). Verified locally by
cross-compiling with `zig cc -target x86_64-windows-gnu -O2 -Wall -Wextra
-Wshadow` — clean, and the resulting PE32+ x86-64 binary passes the new
release gate, which also still rejects the `.c` file.

**The PowerShell-parse step had never parsed anything.** Its own error
reporting line used `"$script:$(...)"`, which PowerShell reads as a
scope-qualified variable reference, so `pwsh` failed to parse the step before
executing a line. Fixed with `${script}`.

**A fuzz test was host-dependent.** `tests/schemaFuzz.test.ts` built its
deeply-nested hostile payload by nesting 100 000 real arrays and calling
`JSON.stringify`, which recurses once per level. The fixture blew the stack
*before the assertion ran* — green on macOS, `RangeError` on the Linux
runner. The payload is now built directly as a string: identical nesting
depth, no recursion, and it is now guaranteed to actually reach
`importBackupAll`. Stricter, not weaker.

## 6. Tests

Run on macOS at commit `6b17267`:

| Suite | Result |
| --- | --- |
| `npm test` (vitest) | **566 passed / 67 files** |
| `npx playwright test` | **74 passed** |
| `npm run lint` | clean |
| `npm run typecheck` (root + `desktop/tsconfig.json`) | clean |
| `node scripts/audit-no-telemetry.mjs` (now covers `desktop/`) | clean |
| `node scripts/verify-release.mjs` | 30 checks passed |
| `npx electron . --smoke-test` | pass — frontend, app shell, bridge, IndexedDB, clean shutdown |

New tests (53):

- `tests/windowsArtifacts.test.ts` (19) — PE parsing against synthesized
  images, source-text detection, and a **regression test that feeds the real
  `aldo_capture_helper.c` to the gate and requires rejection**. Runs on any
  host, so the gate is proven long before a Windows runner is involved.
- `tests/desktopShell.test.ts` (34) — executed traversal/MIME rules plus
  static contracts on the shell and installer config: sandbox + context
  isolation, argument-array spawn with `shell:false`, loopback-only, bounded
  restarts, awaited teardown, single-instance ordering, no `fetch`/remote
  URLs, per-user install, shortcuts, helper outside the asar, user data
  preserved on uninstall, and no `.ps1` in the installed launch path.

Nothing was weakened. The PowerShell launcher's own security contract tests
in `tests/securityRoundTwo.test.ts` still run unchanged, and every hardware-
validation requirement is untouched — a successful compile is still explicitly
not hardware validation.

## 7. Honesty notes

- **The installer has not been validated on Aldo's PC.** CI proves the helper
  is a real x64 PE that executes, that the installer installs, and that the
  installed app starts and shuts down cleanly on a Windows runner. It does not
  prove Raw Input quality on Aldo's mouse. The Diagnostics capture self-test
  still gates tier-1 confidence, exactly as before.
- **The installer is unsigned.** SmartScreen will show "More info → Run
  anyway". `docs/INSTALL-WINDOWS.md` says so plainly rather than hiding it.
- **The rc.1 folder on the USB stick is invalid** and should be deleted. It
  was left in place rather than removed unilaterally.
- The portable PowerShell folder still exists as an advanced/diagnostic path.
  It is not installed, not shipped, and not the product.

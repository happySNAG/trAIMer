# Public-share checklist

The state of everything that has to be true before trAIMer is shared with
strangers, as of **1.0.0**. Each row says what is done, what is checked
automatically, and what is still a human's decision or action. This file is
maintained by hand; the automated columns name the gate that enforces the
row. The rc.13 state of this table, with the one open item that kept it a
candidate, is in the repository history and in PASS-19-REPORT.md.

| # | Item | Status | Enforced by | What remains |
| --- | --- | --- | --- | --- |
| 1 | Product naming: "trAIMer — Train. Measure. Tune." on every user-facing surface | Done | `scripts/verify-branding.mjs` (sources, docs, bundle, installed app, installer name) | — (repository renamed to `trAIMer` for 1.0.0) |
| 2 | Installer: one versioned NSIS installer, per-user, plus a stable `trAIMer-Setup.exe` copy | Done | `windows-installer` job: PE check, helper executes, silent install, installed-layout verification | Unsigned (row 15) |
| 3 | README for a stranger | Done | `scripts/verify-docs.mjs` (links, versions, game table vs registry) | Screenshot of a human session on Windows (row 5) |
| 4 | License | Done: MIT | `verify-docs.mjs` checks the file is MIT and the README links it | Copyright line reads "trAIMer contributors"; the maintainer may prefer a name |
| 5 | Screenshots | Partly done: captured from the real frontend by a scripted session on macOS Chromium | `scripts/capture-screenshots.mjs`; manifest in `docs/screenshots/` | Frames from the installed Windows app and a human session; docs/SCREENSHOTS.md lists them |
| 6 | Release notes | Done: `docs/RELEASE-NOTES.md` | `verify-docs.mjs` (title names this version) | Paste as the GitHub release body |
| 7 | Supported games stated honestly, with per-game limits | Done: `docs/SUPPORT-MATRIX.md` | `verify-docs.mjs` cross-checks status and verified date against the registry; `tests/gameSourceGolden.test.ts` cross-profile audit | — |
| 8 | Experimental profiles labelled in the list, above the inputs, and on every conversion | Done | `tests/browser/gameProfilesPass3.spec.ts`; installed-app picker gate | — |
| 9 | Privacy documented and enforced | Done: `PRIVACY.md` | `scripts/audit-no-telemetry.mjs` on sources and bundle; uninstall keeps data (CI) | — |
| 10 | Security / safety boundary documented, reporting path stated | Done: `SECURITY.md` | `tests/nativeProtocolConstants.test.ts`, `tests/gameProfileBoundary.test.ts` | Private vulnerability reporting: see PASS-20-REPORT.md for whether it could be enabled from the CLI |
| 11 | Contributing guide and profile proposal template | Done | — | — |
| 12 | Issue templates: bug, profile correction, new profile, installation, measurement | Done | YAML validated | — |
| 13 | CI: lint, typecheck, engine, browser, Electron, profile, golden, audit, gain, capture/timing, picker, full smoke, migration, branding, telemetry, release, docs | Done, all gates on every push | `.github/workflows/ci.yml` | — |
| 14 | Checksums: SHA-256 published beside the installer | Done | `windows-installer` job writes `trAIMer-Setup-SHA256.txt` and the job summary | — |
| 15 | Code signing | Not done, documented as post-V1 | `docs/CODE-SIGNING.md` | Purchase a certificate; sign in CI |
| 16 | GitHub release with installer, checksum and notes | Done: `v1.0.0` (installer, `trAIMer-Setup.exe`, checksum, release notes); `v1.0.0-rc.13` and `v1.0.0-rc.12` kept as pre-releases | Manual, per docs/RELEASE.md step 8 | Do not overwrite an existing release; advance `PRIOR_RC_*` in ci.yml to 1.0.0 with the next version |
| 17 | Known limitations stated in README and release notes | Done | — | — |
| 18 | Repository visibility | Public | — | — |
| 19 | `main` reflects the release | Done: pull request #1 merged; 1.0.0 is built from `main` | — | — |
| 20 | Human hardware validation on a build ≥ rc.9 | Done: one maintainer session on the installed rc.13 build, 2026-09-08 (docs/RELEASE.md, "Hardware validation record") | Recorded in docs/RELEASE.md | A fuller record (mode, History detail, exported bundle) from any later session is welcome but not required |
| 21 | Old branding in history | Preserved deliberately in `PASS-*-REPORT.md`, `CHANGELOG.md`, and named data-path survivals | `verify-branding.mjs` allowlist with reasons | — |

## What the maintainer still owns

1. Code signing (row 15), when a certificate is purchased.
2. Screenshots from the installed Windows app and a human session (row 5).
3. A personal name in the license copyright line, if wanted (row 4).
4. Branch protection on `main` requiring the five CI checks
   (docs/GITHUB-LANDING-PAGE.md).

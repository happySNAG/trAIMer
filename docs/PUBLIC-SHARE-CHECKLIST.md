# Public-share checklist

The state of everything that has to be true before trAIMer is shared with
strangers, as of **1.0.0-rc.13**. Each row says what is done, what is
checked automatically, and what is still a human's decision or action. This
file is maintained by hand; the automated columns name the gate that
enforces the row.

| # | Item | Status | Enforced by | What remains |
| --- | --- | --- | --- | --- |
| 1 | Product naming: "trAIMer — Train. Measure. Tune." on every user-facing surface | Done | `scripts/verify-branding.mjs` (sources, docs, bundle, installed app, installer name) | Repository slug still carries the working title; see docs/GITHUB-LANDING-PAGE.md |
| 2 | Installer: one versioned NSIS installer, per-user, plus a stable `trAIMer-Setup.exe` copy | Done | `windows-installer` job: PE check, helper executes, silent install, installed-layout verification | Unsigned (row 15) |
| 3 | README for a stranger | Done | `scripts/verify-docs.mjs` (links, versions, game table vs registry) | Screenshot of a human session on Windows (row 5) |
| 4 | License | Done: MIT | `verify-docs.mjs` checks the file is MIT and the README links it | Copyright line reads "trAIMer contributors"; the maintainer may prefer a name |
| 5 | Screenshots | Partly done: captured from the real frontend by a scripted session on macOS Chromium | `scripts/capture-screenshots.mjs`; manifest in `docs/screenshots/` | Frames from the installed Windows app and a human session; docs/SCREENSHOTS.md lists them |
| 6 | Release notes | Done: `docs/RELEASE-NOTES.md` | `verify-docs.mjs` (title names this version) | Paste as the GitHub release body |
| 7 | Supported games stated honestly, with per-game limits | Done: `docs/SUPPORT-MATRIX.md` | `verify-docs.mjs` cross-checks status and verified date against the registry; `tests/gameSourceGolden.test.ts` cross-profile audit | — |
| 8 | Experimental profiles labelled in the list, above the inputs, and on every conversion | Done | `tests/browser/gameProfilesPass3.spec.ts`; installed-app picker gate | — |
| 9 | Privacy documented and enforced | Done: `PRIVACY.md` | `scripts/audit-no-telemetry.mjs` on sources and bundle; uninstall keeps data (CI) | — |
| 10 | Security / safety boundary documented, reporting path stated | Done: `SECURITY.md` | `tests/nativeProtocolConstants.test.ts`, `tests/gameProfileBoundary.test.ts` | Enable GitHub private vulnerability reporting |
| 11 | Contributing guide and profile proposal template | Done | — | — |
| 12 | Issue templates: bug, profile correction, new profile, installation, measurement | Done | YAML validated | — |
| 13 | CI: lint, typecheck, engine, browser, Electron, profile, golden, audit, gain, capture/timing, picker, full smoke, migration, branding, telemetry, release, docs | Done, all gates on every push | `.github/workflows/ci.yml` | — |
| 14 | Checksums: SHA-256 published beside the installer | Done | `windows-installer` job writes `trAIMer-Setup-SHA256.txt` and the job summary | — |
| 15 | Code signing | Not done, documented as post-V1 | `docs/CODE-SIGNING.md` | Purchase a certificate; sign in CI |
| 16 | GitHub release with installer, checksum and notes | See PASS-19-REPORT.md for this build's status | Manual, per docs/RELEASE.md step 8 | Do not overwrite an existing release |
| 17 | Known limitations stated in README and release notes | Done | — | — |
| 18 | Repository visibility | Private | — | Maintainer decision; flip after rows 16 and 19 |
| 19 | `main` reflects the release | Not done: release candidates are built from the working branch on pull request #1 | — | Merge the pull request |
| 20 | Human hardware validation on a build ≥ rc.9 | **Not done** | Recorded in a pass report when it happens | The one item between rc.13 and 1.0.0 (docs/RELEASE.md) |
| 21 | Old branding in history | Preserved deliberately in `PASS-*-REPORT.md`, `CHANGELOG.md`, and named data-path survivals | `verify-branding.mjs` allowlist with reasons | — |

## Before flipping the repository to public

1. Merge the working branch so `main` is what strangers read.
2. Create the GitHub release for the current tag with the installer, the
   `trAIMer-Setup.exe` copy, the checksum file and the release notes.
3. Enable private vulnerability reporting.
4. Rename the repository (optional but recommended) and update
   `.github/ISSUE_TEMPLATE/config.yml` and the branding allowlist.
5. Set the description and topics from docs/GITHUB-LANDING-PAGE.md.
6. Re-read `PRIVACY.md` and `SECURITY.md` once more as a stranger.

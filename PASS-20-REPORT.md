# Pass 20 — trAIMer 1.0.0, the public release

**Product:** **trAIMer** — *Train. Measure. Tune.*
**Release:** `1.0.0`
**Repository:** `https://github.com/happySNAG/trAIMer` (public)

**In one sentence:** the maintainer's real-hardware session on rc.13 closed
the one gate the project had left open, and 1.0.0 was cut from `main`,
built by CI from the merge commit, tagged, released, and made public with
the repository renamed and its metadata set.

---

## 1. Commits

| | |
| --- | --- |
| Starting HEAD | `96ae665` — "Add the Pass 19 report" (pull request #1 head, `1.0.0-rc.13`) |
| `12faa89` | Cut 1.0.0: the rc.13 hardware validation closes the release gate |
| `21bd398` | Name the capture helper after the product in the two UI strings that still said Aldo |
| **`9a4a72d`** | **Merge pull request #1 into `main`. This is the 1.0.0 release commit: tag `v1.0.0`, CI run 34235481925** |
| (this commit) | Add the Pass 20 report; note that private vulnerability reporting is enabled |

No commit was rewritten, force-pushed, squashed or deleted. The pull
request was merged with a merge commit (the repository's default), so all
55 commits of the release line are on `main` as they were.

## 2. The hardware validation that closed the gate

Recorded in docs/RELEASE.md under "Hardware validation record". The facts
the maintainer supplied, and nothing beyond them:

- the rc.13 installer (`trAIMer-Setup-1.0.0-rc.13.exe`, digest
  `0da0196f…1eb6`, CI run 34228526352) was installed on a real Windows PC;
- the installed application launched;
- a calibration was run to completion with a real mouse;
- the arena on that build applies the blinded candidate sensitivities, so
  the post-rc.9 candidate-gain implementation was exercised by a person;
- the maintainer's verdict was "it all works"; no release-blocking issue
  was observed.

Not supplied, and therefore not claimed: the calibration mode, the
session's History detail (candidate-gain record, capture tier,
recommendation state) and any measured value. docs/RELEASE.md had asked
for those; the record says so, and says the maintainer accepted the report
as sufficient. That is a smaller record than the checklist wanted, and it
is stated as such rather than dressed up.

## 3. Pre-release audit

| Check | Result |
| --- | --- |
| Working tree | clean at start and before every commit |
| Branch vs `main` | 53 commits ahead, 0 behind (fast-forwardable); merged with a merge commit |
| Pull request #1 | open, all five checks green on `96ae665`, then on the two 1.0.0 commits |
| Public documents | README, LICENSE (MIT), SECURITY.md, PRIVACY.md, CONTRIBUTING.md, five issue templates, profile proposal template: all present; enforced by `scripts/verify-docs.mjs` |
| Secrets | none: no token/key/password patterns, no `.env`/`.pem`/`.key`/`.p12` tracked, no private certificates |
| Personal data | the only e-mail addresses in tracked files are a dependency author's in `package-lock.json` and a test fixture; no addresses, no credentials |
| Private machine paths | one, in PASS-12-REPORT.md (a historical worktree path); none in a public-facing document |
| Old branding, user-facing | **two shipped strings found and fixed** (§4); everything else is a documented survival |
| Profile statuses and caveats | unchanged since rc.12/rc.13; support matrix cross-checked against the registry by the docs gate |
| Reproducibility | CI builds from the pushed commit and publishes the SHA-256; the release asset was re-downloaded unauthenticated and re-hashed (§8) |

## 4. A branding defect the gate had missed

The native capture tier's detail line read "Measured samples come from the
local **Aldo** capture helper", and the Diagnostics footer read "talks to
the local **Aldo** helper". Both are rendered to the player; both were in
the shipped bundle of every release candidate through rc.13. The branding
gate hunts for the working title's full forms ("Aldo Aim Lab",
"AldoAimLab", file names), so a bare first name in a UI string never
matched.

Fixed in `21bd398`: both strings say "the local trAIMer capture helper";
the built bundle contains no occurrence of the word. The gate gained
"Aldo capture helper" and "Aldo helper" as patterns, and the
`--classify` probe confirms the old line is now flagged. An engine data
string ("First real Aldo sessions may justify tuning", not in the bundle)
was reworded too, and a stale electron-builder comment that named a person
was replaced. `ALDO_INITIAL_PROFILE`, `__ALDO_*` test hooks, the `aldo://`
scheme and the migration identifiers remain, for the reasons written in
`scripts/verify-branding.mjs`; none renders.

## 5. Version 1.0.0

`package.json`, `package-lock.json` (both fields), `src/version.ts`
(`APP_VERSION` and its header), `tests/pass5Engine.test.ts`; README
(status, badges, download name, limitations, clone URL); CHANGELOG (new
entry); docs/RELEASE-NOTES.md (rewritten); docs/RELEASE.md (version line,
the 1.0.0 decision, the validation record, the component matrix);
docs/INSTALL-WINDOWS.md, docs/CODE-SIGNING.md, docs/SUPPORT-MATRIX.md,
docs/PUBLIC-SHARE-CHECKLIST.md, docs/GITHUB-LANDING-PAGE.md; the five
issue templates' placeholders; `.github/ISSUE_TEMPLATE/config.yml` and
CONTRIBUTING.md (new repository URL). The CI upgrade gate's `PRIOR_RC_*`
was advanced to rc.13 (release asset, digest `0da0196f…`). The docs gate's
historical-version list gained `1.0.0-rc.13`, since the release notes name
the validated build. The rc history in `src/version.ts`, docs/RELEASE.md
and CHANGELOG.md is intact.

## 6. Tests and gates

Locally on the 1.0.0 tree, then in CI on the pull request head
(run 34233895474) and on the `main` merge commit (run 34235481925):

| Suite / gate | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck` | clean |
| Unit / engine | **1230 passed, 98 files** |
| Browser (Playwright) | **179 passed** |
| Candidate-gain gate (dev tree, and installed app twice in CI) | PASS — gains 0.8696 / 1.0000 |
| Arena-entry, capture/timing gates | PASS |
| Game-profile suites, golden tests, cross-profile audit, rounding sweep | PASS (3,456 conversions, 0 failures; unchanged) |
| Installed-app picker gate | PASS — 12 selectable profiles |
| Installed-app full smoke | PASS on rc.13 (prior build) and on 1.0.0: hits, tracking, 2 breaks, results with the Valorant conversion, History |
| Upgrade rc.13 → 1.0.0 | PASS — "upgraded in place: trAIMer 1.0.0; user data preserved"; one Apps & Features entry |
| Silent uninstall keeps data; reinstall finds it | PASS — 4 sessions listed after reinstall, PriorRcPlayer's among them |
| Migration (`userDataMigration`) | PASS |
| Branding gate (sources, docs, bundle, installed app, installer) | PASS — 13 documented survivals; two new patterns |
| No-telemetry audit (sources + bundle) | CLEAN |
| Docs gate | PASS — 33 links, 12 profiles, 1.0.0 current everywhere |
| Release verification | PASS |
| `npm audit --audit-level=moderate` (CI) | PASS |

No gate was weakened; one was tightened (§4).

## 7. Windows CI

| Run | Commit | Outcome |
| --- | --- | --- |
| 34230233526 | `96ae665` (rc.13 + Pass 19 report) | all five jobs green |
| 34233460376 | `12faa89` | cancelled by me after §4 was found, before completion |
| 34233895474 | `21bd398` (PR head) | all five jobs green |
| **34235481925** | **`9a4a72d` (`main`)** | **all five jobs green — the authoritative 1.0.0 build** |

## 8. The installer

| | |
| --- | --- |
| Filename | `trAIMer-Setup-1.0.0.exe` |
| Size | 100,554,048 bytes |
| **SHA-256** | `fe27b26283c0057d0e90bf1ceb65594283af4b5abb424938200f341035d30b21` |
| Also published as | `trAIMer-Setup.exe` (byte-identical) |
| Checksum file | `trAIMer-Setup-SHA256.txt` |
| Built by | run 34235481925 from `9a4a72d`; not a renamed rc.13 (the rc.13 digest is `0da0196f…`) |
| Staged locally | `release/v1.0.0/` and `release/installer/` (both names + checksum) |

The digest was computed three times and matched each time: on the CI
artifact after download, on the staged copies, and on the release asset
re-downloaded without credentials. `verify-windows-artifacts.mjs
--installer` and `verify-branding.mjs --installer` pass on the staged file.
The installed app's own log in CI reports `productVersion: 1.0.0`.

## 9. GitHub release, repository, metadata

| | |
| --- | --- |
| Tag | `v1.0.0` → `9a4a72d` (annotated, pushed) |
| Release | https://github.com/happySNAG/trAIMer/releases/tag/v1.0.0 — normal release, marked Latest, not a draft or pre-release; body = docs/RELEASE-NOTES.md; assets: installer, `trAIMer-Setup.exe`, checksum |
| Earlier releases | `v1.0.0-rc.13` and `v1.0.0-rc.12` untouched, still pre-releases |
| Rename | `happySNAG/Aldo-Aim-Lab` → **`happySNAG/trAIMer`**; the old URL redirects (page and git) |
| Visibility | **public** |
| Description | "Blinded sensitivity calibration and game-profile conversion for FPS players. Train. Measure. Tune." |
| Topics | aim-trainer, aim-training, fps, sensitivity, mouse-sensitivity, calibration, gaming, windows, electron, typescript, open-source |
| Private vulnerability reporting | **enabled** via the API after the flip (`{"enabled": true}`) |

Checked without credentials after publication: repository page, raw
README/LICENSE/SECURITY/PRIVACY/CONTRIBUTING/support matrix, three
screenshots, release page, `releases/latest`, all three asset downloads,
the issue chooser, the advisory form, the proposal template, both README
badges, the old slug and an old release URL — all HTTP 200. The README on
`main` does not mention the old slug.

## 10. Flash drive

`/Volumes/NO NAME` was not mounted at any point. Files are staged at
`release/v1.0.0/trAIMer-Setup-1.0.0.exe`, `release/v1.0.0/trAIMer-Setup.exe`
and `release/v1.0.0/trAIMer-Setup-SHA256.txt` (copies in
`release/installer/`). To copy later:

```
cp release/v1.0.0/trAIMer-Setup-1.0.0.exe release/v1.0.0/trAIMer-Setup.exe release/v1.0.0/trAIMer-Setup-SHA256.txt "/Volumes/NO NAME/"
shasum -a 256 "/Volumes/NO NAME/trAIMer-Setup-1.0.0.exe"
# expect fe27b26283c0057d0e90bf1ceb65594283af4b5abb424938200f341035d30b21
```

## 11. What remains

**Experimental profiles:** PUBG: Battlegrounds, Battlefield 6 (unchanged).
Partially verified: Fortnite, Valorant, Apex Legends (hip-fire only), Call
of Duty / Warzone, Overwatch 2, Rainbow Six Siege, Marvel Rivals, The
Finals. Verified: Counter-Strike 2, Generic / Raw.

**Known limitations** are as the release notes state: Windows x64 only,
unsigned, the refused scope/ADS conversions, browser-rate fallback when the
helper cannot start, one-sitting variance, the arena is not the game,
pre-rc.9 sessions cannot tell you a sensitivity. Engineering items carried
from Pass 19: History's candidate ranking beyond #1 is not a ranking; the
screenshots are a scripted session.

**Maintainer actions, none blocking:** code signing; screenshots from the
installed Windows app and a human session; a personal name in the license
if wanted; branch protection on `main` requiring the five checks; when the
next version is cut, advance `PRIOR_RC_*` to 1.0.0 (digest above). Local
clones should run `git remote set-url origin https://github.com/happySNAG/trAIMer.git`.

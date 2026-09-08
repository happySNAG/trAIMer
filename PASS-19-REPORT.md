# Pass 19 — making trAIMer share-ready

**Product:** **trAIMer** — *Train. Measure. Tune.*
**Release candidate:** `1.0.0-rc.13`
**Campaign:** trAIMer Game Profile Campaign, **Pass 5 of 5** — public-release
hardening and the share-ready V1.

**In one sentence:** the repository now has everything a stranger needs to
understand, install, trust, use and contribute to trAIMer; the installed
application is driven through a complete calibration, an upgrade and an
uninstall/reinstall on every CI run; and the version stays a release
candidate for exactly one stated reason, which no amount of automation can
close.

---

## 1. Starting HEAD, resulting HEAD, commits

| | |
| --- | --- |
| Repo | `https://github.com/happySNAG/Aldo-Aim-Lab.git` (private) |
| Branch | `ox/aldo-aim-lab-20260823T194949Z-a28b6239`, pull request #1 |
| **Starting HEAD** | `1f846d6` — "Add the Pass 18 report" |
| **Built HEAD** | `8d6b16f` — the commit CI run 34228526352 built and verified (tag `v1.0.0-rc.13`) |
| Report commit | follows the built HEAD |

| Commit | |
| --- | --- |
| `31c8545` | Show an experimental profile's status where it is chosen, and order the Aim Test screen for a first-time player |
| `c928739` | Drive the installed app through a full calibration, an upgrade from rc.12, and an uninstall that keeps data |
| `6f648d1` | Write the public face of the repository: README, license, support matrix, privacy, security, contributing, templates |
| `2134e58` | Cut 1.0.0-rc.13 for Game Profile Campaign Pass 5 |
| `54bec94` | Let the installer job read releases and artifacts, and source the previous RC from its release |
| `e2cdfeb` | Make the full smoke's Skip break click best-effort |
| `8d6b16f` | Wait for History to render before the full smoke counts its rows |
| (this commit) | Add the Pass 19 report |

The three commits after the version cut are fixes to the new CI gates found
by running them on the Windows runner (§18); none touches the application.

## 2. Version decision: 1.0.0-rc.13, not 1.0.0

Every criterion in the pass brief is met by evidence except one:

| Criterion | Evidence |
| --- | --- |
| installer works | CI: PE check, helper executes, silent install, installed-layout verification, startup + clean shutdown |
| calibration works | CI: arena entry, candidate-gain measurement, **full calibration on the installed app** (new), 1230 unit tests, 179 browser tests |
| results are understandable | player-first results reviewed (§10); scripted-session screenshots |
| profile conversions are honest | cross-profile audit 3,456 conversions / 0 failures; golden tests from external sources; support matrix checked against the registry in CI (new) |
| unsupported areas fail closed | validator + `gameProfileBoundary`; refusals preserved (Apex optics, Fortnite scope, Marvel scopes, PUBG extras, The Finals zoom FOVs) |
| public documentation is accurate | `scripts/verify-docs.mjs` (new): links, versions, matrix |
| repo is understandable to strangers | README, CONTRIBUTING, SUPPORT-MATRIX, PRIVACY, SECURITY, templates (new) |
| release artifacts are reproducible | CI builds from the pushed commit; SHA-256 published; `verify-release.mjs` |
| no known sev-1 / sev-2 correctness bug | none found; one suspected inconsistency investigated and shown to be an artefact of comparing two different runs (§11) |
| **hardware validation** | **not done on any build since rc.9** |

The last human session on record is on rc.7 (PASS-15-REPORT.md). rc.9 is
the build in which the arena first applied the blinded candidate sensitivity
(docs/ARENA-SENSITIVITY.md); every hardware session before it compared
sensitivities that felt identical, so none of them is evidence that the
product's core loop works for a person. The repository's own release
checklist (docs/RELEASE.md, step 6 then step 7) requires that before
`v1.0.0`. The automated gates now prove the installed build does everything
a human would need; they are not a substitute for one human doing it. Cutting
1.0.0 on that basis would be exactly the optimism the brief warns against.

What closes it, written into docs/RELEASE.md: one Standard or Precision
calibration on the installed rc.13 build with a real mouse, recorded in a
pass report with the session's History detail. No particular result is
required — "More data needed" is an acceptable honest outcome.

Two further items are the maintainer's decisions, not blockers: the
repository is private, and the release candidates are built from the working
branch on pull request #1 rather than from `main`.

## 3. README

`README.md` was rewritten for a stranger. It states what trAIMer is, the
problem it solves, how it differs from an aim trainer (an instrument, not a
score), that it measures performance across blinded candidates and converts
the physical result into supported game settings, the twelve games with
their statuses, installation, first run, the three calibration modes with
their drill counts and times, what the results screen answers, limitations,
privacy, the safety boundary, Windows-only support, contribution and the
license. It names the one open item before 1.0.0 in its status line. The
old README described the headless core of Pass 1 and a player-specific
initial profile; both are gone. The README is a hard file for the branding
gate and its game table is checked against the registry by the docs gate.

**Positioning paragraph** (README, release notes, landing-page doc):

> trAIMer is a sensitivity calibration and aim-training tool for
> mouse-and-keyboard FPS players on Windows. It runs a short, blinded aim
> test across several candidate sensitivities, measures how you actually
> perform on each, estimates the physical sensitivity the evidence supports,
> and translates that into the settings of the game you play. It does not
> touch the game: you type the number in yourself.

Nothing in it claims to prove, guarantee, or find an objective optimum.

## 4. Screenshots

`scripts/capture-screenshots.mjs` renders the real frontend in Chromium at
1440×900, drives a Quick calibration with the browser suite's scripted
player, and takes plain `page.screenshot()` frames. Ten frames are in
`docs/screenshots/` with a manifest: home, setup with Valorant chosen,
setup with PUBG chosen (the experimental treatment), shooting drill,
tracking drill, break, results summary, results game conversion, advanced
results, history. Nothing is composited or annotated in-image.

`docs/SCREENSHOTS.md` says exactly what they are (scripted session, macOS
Chromium, the engine's real output for that session, not a human's aim) and
lists the frames that still need a human on Windows: the installer and
SmartScreen dialog, the installed app's window frame, the native capture
check with a real mouse, a human session's results, and History with a
pre-rc.9 session. None of those was fabricated.

## 5. Support matrix

`docs/SUPPORT-MATRIX.md`: one row per public profile with Game, Profile
status, Hip-fire, X/Y, ADS, Scopes / optics, FOV, Last verified, Important
limitation; a status legend; what "experimental" means in practice; what is
deliberately refused. The docs gate parses it and fails CI if any row's
status word or last-verified date differs from the profile file, or if it
lists a game the registry does not ship. All twelve rows match.

## 6. License

None existed. **MIT** added as `LICENSE` ("trAIMer contributors"; the
maintainer may prefer a personal name). README links it; the docs gate
checks the file is the MIT text.

## 7. CONTRIBUTING, profile proposal template, issue templates

- `CONTRIBUTING.md`: setup, test and gate commands, repository layout, how
  a profile is structured (field by field), source and provenance
  expectations with the authority order, verification expectations
  including the cm/360-band inversion and the measured-360° gold standard,
  how to add a profile (seven steps), how to add profile tests and golden
  tests, how to report a formula problem, no-telemetry and privacy
  expectations, safety boundaries, pull-request rules.
- `docs/PROFILE-PROPOSAL-TEMPLATE.md`: fifteen required sections — game and
  version, hip-fire model and constants, slider ranges, X/Y model, DPI
  assumptions, FOV model, ADS and scope behaviour per zoom, matching
  philosophies, sources with type and independence, measurements,
  uncertainty, verification date, test cases, proposed status, checklist.
  It says in its first paragraph that a calculator-copy submission is sent
  back.
- `.github/ISSUE_TEMPLATE/`: bug report, game-profile correction, new
  game-profile request, installation problem, measurement / calibration
  problem, plus `config.yml` pointing security reports at private
  reporting. Each asks for version, build, capture path, mode and the
  relevant evidence, and none asks for personal data; the bug template says
  so explicitly.

## 8. SECURITY.md and PRIVACY.md

`SECURITY.md`: what trAIMer does not do (inject, read memory, hook or
synthesise input, modify game files, interact with anti-cheat), which
static tests enforce it, the native helper's role and limits (loopback
only, one token-authenticated client, no files, compiled in CI, version
pinned), the unsigned status, and a reporting path: GitHub private
vulnerability reporting if enabled, otherwise a details-free issue asking
for contact. No email address was invented.

`PRIVACY.md`: no telemetry and no network (with the CI audit that enforces
it), the loopback helper, provenance links, no update checker; a table of
what is stored and where (`%APPDATA%\trAIMer`: IndexedDB history, local
storage settings and session token, `logs\desktop.log`, exports wherever
the player saves them); what a stored session contains and does not; what
is not stored; uninstall behaviour (keeps data by default, tested in CI);
the browser development build. The IndexedDB database's pre-rename internal
name is described without being named.

## 9. Release notes and changelog

`docs/RELEASE-NOTES.md` is the public body for the release: what you get,
installing, known limitations, why not 1.0.0, checksum. It does not list
pass history. `CHANGELOG.md` summarises the path from rc.1 to rc.13 with
player-visible changes first, grouping rc.3–rc.6 and rc.1–rc.2, and points
at the pass reports for the engineering record. The docs gate requires the
changelog's newest entry and the release-notes title to name the current
version.

## 10. UX review findings and fixes

**First-run (requirement 21).** The Aim Test screen opened with the
calibration-length cards before the player had said anything about
themselves, and the game card was last. Reordered: session setup (player,
DPI, starting sensitivity, breaks, advanced), then game, then length, then a
Start card whose subtitle says trAIMer never changes a game's settings. The
DPI hint names common values; the starting-sensitivity hint says the player
need not know how the percentage maps to their game. Home's three steps
now say "no need to know what cm/360 or eDPI mean", name the modes, and end
with "Set it in your game"; its "30–50 minutes" estimate (stale since the
modes were introduced) now matches them. The default player name was a
specific person's; it is "Player". `docs/UI-CONTRACT.md` records the DOM
order and ids.

**Profile status (requirement 7).** The status badge sat below the inputs
as a badge plus a sentence, visually similar for every status. Now: the
picker option itself reads "PUBG: Battlegrounds (experimental)" /
"Battlefield 6 (experimental)"; the status block renders above the inputs
with `profile-status-<status>` classes (warn-toned border for experimental,
info for partly verified); the experimental sentence adds what to do
("treat the number as a starting point and check it in the game"). Verified
profiles show nothing, as before. The decision on opt-in (carried from Pass
4): the two experimental profiles stay listed and labelled rather than
hidden, because a label in the list, above the inputs and on every
converted value is prominent enough, and an opt-in would hide the games
whose players are most likely to bring back the measurement that settles
them. Browser specs assert the option label, the class, the wording and
that the block precedes the first input.

**Results (requirement 22).** The four questions are answered in order by
the ending banner, the hero (value, range, confidence label, summary,
aim-tendency sentence), the game card, the performance cards and "What to
do next", with Advanced results below. One gap: nothing told the player
that the last step is manual. "What to do next" now adds, when a conversion
is ready, "Open <game>'s settings and enter the values from the 'What to
set in <game>' list above. trAIMer does not change game settings for you."
The provenance reference is a link (system browser in the shell).

**History (requirement 23).** Verified by `arenaGainHistoryValidity.test.ts`
and by reading the view: the absence of a stored `arenaGain` record marks a
pre-rc.9 session; History says so once at the top and again in every
affected row's detail before any statistic; the session stays readable;
profile id and definition version are shown as "valorant v1"; a session
from this build is not marked. One finding, left as is and recorded here:
the "Candidate ranking" cells rank #1 correctly (the winner) but assign
ranks 2–5 in candidate-id order, not by utility; the numbers are real, the
ordering of the non-winners is not a ranking. A proper fix needs
per-candidate utilities in the stored explanation and is not a public-share
blocker.

## 11. A suspected defect that was not one

Comparing the results screenshot against the history screenshot showed
different recommended values (7560 vs 6785 eDPI; Valorant 0.540 vs 0.48).
Three targeted probes — two in the Electron shell, one in Chromium
replicating the capture script's pauses — read the results DOM, the
Advanced rationale, the stored recommendation, the human-session record and
the audit trail after a scripted session: all agree, and the audit trail
shows exactly one analysis per session. The mismatch was an artefact of the
capture process: the results frames I compared came from the second capture
attempt and the history frame from the third (each a fresh session with
different scripted aim). The committed frames all come from one run.

## 12. Repository cleanup

Found and fixed: stale README (Pass 1 headless-core framing, a named
player's initial profile); `package-lock.json` still at `1.0.0-rc.3`; the
home screen's stale session-length estimate; a specific person's name as
the default player; player-specific titles and phrases in
`docs/MANUAL-TEST.md`, `docs/HUMAN-VALIDATION.md`,
`docs/PACKAGING-WINDOWS.md`, `docs/NATIVE-CAPTURE.md`, `docs/RELEASE.md`
and `docs/SIMULATOR.md`; the pull request's rc.3-era title and body.

Audited and clean: no secrets or tokens; no machine-specific or `/Users`
paths in tracked files; no `TODO`/`FIXME` in shipped sources; no committed
binaries (`native/windows/*.exe` and `release/` are ignored); the largest
tracked files are the Pass 6 campaign data (3.6 MB of JSON, historical
evidence, kept); `scripts/campaigns/` are the documented Pass 6 drivers,
not dead; all 33 relative links in the public docs resolve.

**Remaining old branding, and why:** the pass reports and `CHANGELOG.md`
(history); `aldo-aim-lab` as the IndexedDB name, legacy localStorage keys,
`AldoAimLab` as the migration source directory, `com.aldoaimlab.desktop` as
appId/AppUserModelId, `aldo://app` as the frontend origin — each one a
user-data or upgrade-identity survival with a written reason in
`scripts/verify-branding.mjs`; the `__ALDO_*` test-hook identifiers
(internal, never rendered); `ALDO_INITIAL_PROFILE` and friends in
`src/domain` (engine fixture defaults, configurable, never displayed); and
the repository slug itself, which now appears in the issue-template contact
links and is allowlisted with the recommendation to rename the repository.

## 13. Support for the decisions in docs/GITHUB-LANDING-PAGE.md

Description: "Blinded sensitivity calibration and game-profile conversion
for FPS players." Topics, release title, homepage (none yet), and settings
(rename to `traimer`, enable private vulnerability reporting, merge the
pull request before going public) are in that document.

## 14. Code signing

Unsigned; SmartScreen warning expected and documented in the README, the
install guide, the release notes, the installation issue template and
`docs/CODE-SIGNING.md`, which also gives the checksum procedure and records
signing as a post-V1 distribution improvement. Nothing was faked.

## 15. Profile source view (requirement 20)

The details block under a chosen profile shows status, unit definition,
source title and type, game build checked against, last verified, last
reviewed, confidence, definition version, the reference as a link, the FOV
note where relevant, assumptions, and "What this profile does not cover".
The installed-app picker gate requires all of it to be reachable. Raw
metadata (ids, schema versions, fixture fields) is not shown.

## 16. Profile audit (requirement 26)

No profile formula, constant, range, default, status or verification date
changed in this pass. The Pass 4 audit re-ran unchanged as part of the unit
suite: `gameSourceGolden.test.ts` (32 tests including the 3,456-conversion
cross-profile equivalence audit, zero failures) and
`gameRoundingHardening.test.ts` (38 tests). The support matrix is checked
against the registry in CI and matches.

## 17. Tests and gates

| Suite / gate | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` (engine + desktop) | clean |
| Unit / engine tests | **1230 passed, 98 files** (unchanged count; `pass5Engine` version assertion updated) |
| Browser tests (Playwright) | **179 passed** — full suite locally (two specs updated for the new home-step text and a 4K sub-pixel tolerance) and in CI |
| Game-profile browser specs | 43 passed, with new assertions for the option label, status class, wording and placement |
| Golden tests / cross-profile audit | 32 passed; 3,456 conversions, 0 failures (unchanged) |
| Rounding sweep | 38 passed (unchanged) |
| Candidate-gain gate (dev tree + installed) | PASS — gains 0.8696 / 1.0000, spread 1.15× |
| Arena-entry and capture/timing gates | PASS (unchanged) |
| Installed-app picker gate | PASS — twelve profiles, experimental labels present in the list |
| **Installed-app full smoke** (new) | PASS on rc.12 and on rc.13: hit, tracking, three breaks (one skipped), results with Valorant conversion, History |
| **Upgrade rc.12 → rc.13** (new) | PASS — one Apps & Features entry "trAIMer 1.0.0-rc.13", user data preserved, PriorRcPlayer's session listed after the upgrade |
| **Silent uninstall keeps data, reinstall finds it** (new) | PASS — 4 sessions listed after reinstall, PriorRcPlayer's among them |
| Branding gate (sources + 14 new hard files, bundle, installed app, installer name) | PASS — 14 documented survivals |
| No-telemetry audit (sources + bundle) | CLEAN — 9 declared provenance URLs |
| Release verification | PASS — 40 checks including the new public documents |
| **Docs gate** (new) | PASS — 33 links, 12 profiles cross-checked against the matrix |
| Migration test (`userDataMigration`) | PASS (unchanged, plus the live upgrade above) |

No gate was weakened. Three gate scripts were corrected after their first
runs on Windows (§18); each correction makes the gate wait for or tolerate
something a player would also wait for or tolerate, and none loosens an
assertion about the product.

## 18. Windows CI and the installer

Four runs were needed; the product did not change between them.

| Run | Commit | Outcome |
| --- | --- | --- |
| 34225002265 | `2134e58` | engine, browser, native-windows, windows-release green; windows-installer failed at the upgrade gate: the workflow token could not read the rc.12 run's artifact (HTTP 403). Fixed by publishing rc.12 as a GitHub pre-release (the gate's first route) and declaring `contents: read` / `actions: read` on the job. |
| 34225992421 | `54bec94` | same four green; the full smoke on the installed rc.12 timed out clicking Skip break on a five-second break that ended by itself. Fixed: best-effort skip. |
| 34227079105 | `e2cdfeb` | rc.12 leg and upgrade green; the full smoke on rc.13 read History before it had rendered (0 rows). Fixed: wait for rows or the empty state. |
| **34228526352** | **`8d6b16f`** | **all five jobs green** — engine, browser, native-windows, windows-release, windows-installer including every new gate |

Run: [`34228526352`](https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34228526352).

| | |
| --- | --- |
| Filename | `trAIMer-Setup-1.0.0-rc.13.exe` |
| Size | 100,556,787 bytes |
| **SHA-256** | `0da0196f1429e64b8ede8bad23726db222b144f1a88b520ff43472971b5b1eb6` |
| Also published as | `trAIMer-Setup.exe` (byte-identical, same digest) |
| Checksum file | `trAIMer-Setup-SHA256.txt` |
| Staged at | `release/installer/trAIMer-Setup-1.0.0-rc.13.exe`, `release/installer/trAIMer-Setup.exe`, `release/installer/trAIMer-Setup-SHA256.txt` (also `release/rc13/`) |

The digest was recomputed locally after download and matches the one CI
wrote. `verify-windows-artifacts.mjs --installer` and
`verify-branding.mjs --installer` pass against the staged file.

## 19. Flash drive

`/Volumes/NO NAME` was **not mounted** at any point during the pass (checked
at the start, when the user prompted mid-pass, and after the release). The
installer, the stable-name copy and the checksum are staged at the paths in
§18. To copy later:

```
cp release/installer/trAIMer-Setup-1.0.0-rc.13.exe release/installer/trAIMer-Setup-SHA256.txt "/Volumes/NO NAME/"
shasum -a 256 "/Volumes/NO NAME/trAIMer-Setup-1.0.0-rc.13.exe"
# expect 0da0196f1429e64b8ede8bad23726db222b144f1a88b520ff43472971b5b1eb6
```

No drive copy is claimed.

## 20. GitHub release

Two pre-releases were created, neither overwriting anything (none existed):

| Tag | Commit | Assets | Why |
| --- | --- | --- | --- |
| `v1.0.0-rc.12` | `b4b30c4` | `trAIMer-Setup-1.0.0-rc.12.exe` (digest `dcc93df9…079a1`, the exact CI artifact of run 34197845506), checksum | So the upgrade gate has a durable source for the previous candidate that does not expire with a CI artifact |
| **`v1.0.0-rc.13`** | **`8d6b16f`** | `trAIMer-Setup-1.0.0-rc.13.exe`, `trAIMer-Setup.exe`, `trAIMer-Setup-SHA256.txt`; body = `docs/RELEASE-NOTES.md` | The release of this pass |

**Public download location:**
`https://github.com/happySNAG/Aldo-Aim-Lab/releases/tag/v1.0.0-rc.13`
— reachable by anyone with access to the repository, which is still
**private**. Making it public is the maintainer's action
(docs/PUBLIC-SHARE-CHECKLIST.md, "Before flipping the repository to
public"). The pull request title and body were updated to describe the
product as it is.

## 21. Remaining known limitations

Player-facing, from the release notes: Windows x64 only; unsigned; PUBG and
Battlefield 6 experimental; Apex per-optic ADS, Fortnite scope, Marvel
Rivals hero scopes, PUBG Targeting/ADS/per-scope and The Finals zoomed FOVs
deliberately unconverted; one-sitting variance; the arena is not the game;
highest confidence needs the capture check; pre-rc.9 sessions cannot tell
you a sensitivity.

Engineering: the History candidate ranking beyond #1 (§10); `PRIOR_RC_*`
in the workflow still names rc.12 (its release asset is durable), and the
next pass should advance it to rc.13 so the upgrade gate tests the newest
step; the automated screenshots are a scripted session, not a person.

## 22. Remaining release blockers before 1.0.0

1. **One human calibration on the installed rc.13 build**, recorded as
   docs/RELEASE.md describes. This is the only item.

Maintainer decisions that are not blockers: merge pull request #1 so `main`
is the public branch; make the repository public; rename it; enable private
vulnerability reporting; set description and topics.

## 23. Public-share checklist

`docs/PUBLIC-SHARE-CHECKLIST.md` — 21 rows, each with status, the gate that
enforces it, and what remains. Done: naming, installer, README, license,
release notes, supported games, experimental labelling, privacy, security,
contributing, issue templates, CI, checksums, known limitations, old
branding accounted for, GitHub release (v1.0.0-rc.13 pre-release with
installer, stable-name copy, checksum and notes). Partly done: screenshots
(scripted; human frames listed). Not done: code signing (post-V1),
repository visibility and `main` (maintainer), human hardware validation
(the 1.0.0 gate).

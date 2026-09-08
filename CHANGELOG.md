# Changelog

All notable changes to trAIMer. The public release line is `1.0.0`; the
entries below are its release candidates. Player-visible changes come first
in each entry; the detailed engineering record for every pass lives in the
`PASS-*-REPORT.md` files at the repository root and is deliberately not
repeated here.

## 1.0.0-rc.13 — 2026-09-08 — public-release hardening

The share-ready candidate. No calibration-engine change and no game-profile
formula change.

**For players**

- An experimental profile now says so in the game list itself
  ("PUBG: Battlegrounds (experimental)", "Battlefield 6 (experimental)"),
  and its status block sits above the inputs, tone-coded, with a sentence on
  what to do about it.
- The Aim Test screen reads in the order a first-time player needs: player
  and DPI, game and current sensitivity, how long to test, start.
- The results screen's "What to do next" tells you to change the setting in
  the game yourself, and names the list to copy from.
- Profile reference URLs are links (opened in the system browser); the app
  still never fetches anything.
- The home screen's time estimate now matches the calibration modes.

**Public documentation**

- New README, installation guide, support matrix, privacy document,
  security document, contributing guide, profile proposal template, GitHub
  issue templates, code-signing status, release notes, this changelog, and
  an MIT license.
- Screenshots captured from the real frontend by a scripted session.

**Release gates added to CI**

- The installed application is driven through a complete calibration:
  profile selection, DPI, Quick mode, shooting hits, tracking completion, a
  break, results with the game conversion, History, clean shutdown.
- The previous release candidate is installed first and used; the new
  installer must upgrade it in place with the earlier session still in
  History.
- A silent uninstall must keep the player's data, and a reinstall must find
  it.
- Public docs are checked: links resolve, version strings are current, and
  the support matrix matches the profile registry.

**Why this is not 1.0.0**

No human has completed a calibration on real hardware on any build since
rc.9, when the arena first applied the blinded candidate sensitivity. The
automated gates prove the installed build does everything a human would
need; they do not replace one human doing it. That is the remaining step.

## 1.0.0-rc.12 — 2026-09-08 — every profile re-verified

- All twelve public profiles re-researched from scratch. Eight base
  constants confirmed from a published cm/360 band that names no game
  internals; Counter-Strike 2's and Valorant's zoom models shown equivalent
  to independently published formulas.
- **Battlefield 6:** stock Uniform Soldier Aiming coefficient corrected to
  133.3% (was 177.8%).
- **PUBG:** FOV default corrected to 90; conversion warns when no FOV is
  entered because the FOV multiplies the answer. Stays experimental: its
  scale could not be confirmed linear.
- **The Finals:** FOV slider corrected to a vertical 45–100 defaulting to 71.
- Rainbow Six Siege's "rival" 0.00223 and Overwatch's 49.46 explained as
  category errors, not competing measurements.
- Golden tests with expected values from outside this repository; a
  rounding sweep over every field of every profile; a cross-profile
  equivalence audit (3,456 conversions, zero failures).
- The status badge names each game's own limitation instead of boilerplate.

## 1.0.0-rc.11 — 2026-09-08 — six more games

- Added Overwatch 2, Rainbow Six Siege, Marvel Rivals, PUBG: Battlegrounds,
  The Finals and Battlefield 6.
- The game picker grew "Recently used", alphabetical grouping, a filter box,
  and Generic / Raw on its own.
- Installed-app gate: every public profile must be offered and must render
  its own fields inside the installed application.

## 1.0.0-rc.10 — 2026-09-07 — the first five games

- Added Fortnite, Valorant, Counter-Strike 2, Apex Legends and Call of
  Duty / Warzone.
- Results show what to set in the game, what you are on today, the physical
  equivalent, and every rounding the game's grid forced.
- Profile schema gained the two zoom behaviours real games use
  (FOV-ratio multipliers and monitor-distance coefficients).

## 1.0.0-rc.9 — 2026-09-07 — the game-profile layer, and a critical fix

- New versioned game-profile and sensitivity-conversion layer, kept
  strictly outside the measurement core, shipping the Generic / Raw
  profile.
- **Fixed:** builds rc.5 through rc.8 never applied the blinded candidate
  sensitivity to the arena, so every human calibration on those builds
  compared sensitivities that felt identical. Sessions from before this fix
  remain readable in History and are marked as unable to tell you a
  sensitivity. A CI gate now measures the crosshair's travel in the
  installed app and requires it to change between candidates.

## 1.0.0-rc.8 — measurement integrity

- Capture timestamp domains reconciled between the native helper and the
  app clock.
- Quick / Standard / Precision calibration modes.
- Player-first results page: performance cards, "What to do next", and
  Advanced results for the detail.

## 1.0.0-rc.7 — renamed to trAIMer

- The product, installer, executable, shortcuts and window were renamed
  from the working title *Aldo Aim Lab* to **trAIMer — Train. Measure.
  Tune.** Existing user data is migrated on first launch and the installer
  upgrades the old entry in place. A CI branding gate keeps the old name
  off every user-facing surface.
- Fixed break, tracking-drill and shot-feedback defects found in hardware
  sessions.

## 1.0.0-rc.3 through rc.6 — the installed desktop application

- One double-clickable Windows installer replacing the portable folder and
  PowerShell launcher. Electron shell, custom-scheme frontend delivery, the
  native Raw Input helper started and stopped automatically.
- Arena capture-entry fix (rc.4); sequential three-target drill, skippable
  breaks, balanced drill sequencing and new arena presentation (rc.5);
  real-PC fixes to the strafing target, tracking-target deletion and
  break/pause pointer release (rc.6).

## 1.0.0-rc.1 and rc.2 — first candidates

- Headless measurement core: domain model, capture pipeline, metrics,
  validity system, seeded simulator, evidence-based optimizer, local-first
  persistence, blind-recovery tests.
- Browser frontend with real pointer-lock input; native high-rate capture
  helper; resume and recovery; history; diagnostics.
- rc.1 shipped a helper that was not an executable; the release pipeline
  has verified the binary executes on every build since.

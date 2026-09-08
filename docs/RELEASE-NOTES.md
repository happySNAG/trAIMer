# trAIMer 1.0.0-rc.13

**Train. Measure. Tune.**

A sensitivity calibration and aim-training tool for FPS players on Windows.
It runs a short, blinded aim test across several candidate sensitivities,
measures how you perform on each, estimates the physical sensitivity your
evidence supports, and converts it into the settings of the game you play.
You change the setting in the game yourself; trAIMer never touches it.

This is the final release candidate before 1.0.0. Everything a player needs
is in it. See *Why not 1.0.0* at the end.

## What you get

- **Sensitivity calibration.** Five candidate sensitivities around your
  current one, tested in shooting and tracking drills, scored on accuracy,
  speed, tracking precision, correction efficiency, overshoot and undershoot
  control, and consistency.
- **Blinded candidates.** You see letters, never numbers, and each candidate
  feels different in your hand. You are not asked to judge which is best;
  the measurement does that.
- **Quick, Standard and Precision.** About 3, 4 and 8 minutes. Same drills,
  same blinding, same scoring; a shorter mode buys less evidence and the
  results say so.
- **Shooting and tracking drills** with breaks between candidates that you
  can skip. Press Esc at any time; completed drills are saved and the
  calibration can be continued later.
- **Game profile conversion.** Pick your game, type the sensitivity you play
  at, and the recommendation comes back in that game's own units, with every
  rounding the game's slider forces shown side by side with the exact value.
- **Supported games:** Counter-Strike 2 and Generic / Raw (verified);
  Fortnite, Valorant, Apex Legends, Call of Duty / Warzone, Overwatch 2,
  Rainbow Six Siege, Marvel Rivals and The Finals (partially verified: hip-fire
  well supported, some scoped behaviour not); PUBG: Battlegrounds and
  Battlefield 6 (experimental, labelled as such everywhere). The full table
  of what is and is not converted per game is `docs/SUPPORT-MATRIX.md`.
- **Results you can act on.** What to change, how confident the evidence is,
  what you are doing well or poorly, and what to do next. When the evidence
  is thin, the app says "More data needed" and offers to continue the same
  calibration instead of inventing a number. Advanced results hold every
  measurement.
- **History.** Every session is kept, with its game conversion and the
  versions that produced it.
- **Privacy.** No telemetry, no account, no network use, enforced by a CI
  audit of the shipped bundle. Everything is stored under
  `%APPDATA%\trAIMer` and survives uninstall unless you say otherwise.
- **Windows installer.** One file, per-user install, no admin rights.

## Installing

Download `trAIMer-Setup-1.0.0-rc.13.exe` and `trAIMer-Setup-SHA256.txt`.
The build is **not code-signed**, so SmartScreen will warn: click **More
info → Run anyway**. You can verify the download first:

```powershell
Get-FileHash -Algorithm SHA256 .\trAIMer-Setup-1.0.0-rc.13.exe
```

Upgrading from any earlier release candidate is an in-place upgrade with
your history intact. Full instructions: `docs/INSTALL-WINDOWS.md`.

## Known limitations

- **Windows x64 only.** No macOS or Linux build.
- **Unsigned.** SmartScreen and some antivirus products warn on first run.
- **Two experimental profiles.** PUBG's 1–100 scale is not confirmed
  linear; Battlefield 6's constant rests on one published measurement.
  Both convert hip-fire with a warning. One measured 360° turn in each game
  would settle them.
- **Deliberately not converted:** Apex Legends per-optic ADS, Fortnite
  scope sensitivity, Marvel Rivals hero scopes, PUBG Targeting/ADS/per-scope
  settings, The Finals zoomed FOVs. Published references conflict or are
  absent, so the app leaves these for you rather than guess.
- **Short sessions, real variance.** A recommendation is a measurement of
  one sitting. Repeat sessions before acting on a small difference.
- **The arena is not your game.** It measures aim on its own targets; it
  cannot see recoil, movement, or a game's engine, and does not claim to.
- **Highest confidence needs the capture check.** Run Diagnostics → Native
  capture check once; without it sessions are still valid but graded lower.
  If the native helper cannot start, the app falls back to browser-rate
  capture and labels the result accordingly.
- **Sessions from before rc.9** remain in History but are marked as unable
  to tell you a sensitivity: on those builds the arena did not apply the
  blinded candidate sensitivity.

## Why not 1.0.0

Every automated gate passes on the installed build, including a complete
calibration driven end to end, an in-place upgrade from rc.12 with the
earlier session preserved, and a silent uninstall that keeps data followed
by a reinstall that finds it. What has not happened yet is a **human
completing a calibration on real hardware on a build since rc.9**, the
build in which the arena first applied the blinded candidate sensitivity.
The project's own release checklist requires that before tagging 1.0.0, and
this release does not claim it. When one such session has been run and
recorded, 1.0.0 is this build with a version number.

## Checksum

The installer's SHA-256 is published in `trAIMer-Setup-SHA256.txt` next to
the download and in the CI job summary that built it.

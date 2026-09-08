# trAIMer 1.0.0

**Train. Measure. Tune.**

trAIMer is a sensitivity calibration and aim-training tool for
mouse-and-keyboard FPS players on Windows. It runs a short, blinded aim test
across several candidate sensitivities, measures how you actually perform on
each, estimates the physical sensitivity the evidence supports, and converts
it into the settings of the game you play. You change the setting in the
game yourself; trAIMer never touches it.

This is the first public release. It is the 1.0.0-rc.13 build with the
version number changed: a person has now installed that build on a real
Windows PC and completed a calibration with a real mouse, which was the one
thing the project's own release checklist required before calling it 1.0.0.

## What you get

- **Blinded sensitivity calibration.** Five candidate sensitivities around
  the one you play at, shown to you as letters, never numbers. Each one
  feels different in your hand, and you are not asked to judge which is
  best: the measurement does that.
- **Quick, Standard and Precision.** About 3, 4 and 8 minutes. Same drills,
  same blinding, same scoring. A shorter mode buys less evidence, never
  easier evidence, and the results say how much they can support.
- **Shooting and tracking drills**, with enforced breaks between candidates
  that you can skip. Press Esc at any time; completed drills are saved and
  the calibration can be continued later.
- **Results with a stated confidence.** The recommendation is a value, a
  plausible range and a confidence label. When the evidence is thin the app
  says "More data needed" and offers to continue the same calibration
  instead of inventing a number. Advanced results hold every measurement,
  the candidate comparison and the fitted curve.
- **Game-specific conversion.** Pick your game, type the sensitivity you
  play at today, and the recommendation comes back in that game's own
  units, with every rounding the game's slider forces shown beside the
  exact value.
- **Twelve game profiles**, each with a status the app shows you:
  - *Verified:* Counter-Strike 2, Generic / Raw.
  - *Partially verified* (hip-fire well supported, some scoped or
    aimed-down-sights behaviour not): Fortnite, Valorant, Apex Legends,
    Call of Duty / Warzone, Overwatch 2, Rainbow Six Siege, Marvel Rivals,
    The Finals.
  - *Experimental* (the base constant rests on evidence that does not settle
    it): PUBG: Battlegrounds, Battlefield 6.

  Every profile carries its sources, its verification date and what it does
  not cover. The full per-game table is `docs/SUPPORT-MATRIX.md`.
- **History.** Every session is kept, with its game conversion and the
  versions that produced it.
- **Local-first, no telemetry.** No account, no network use, no analytics,
  no update checker. A CI audit of the shipped bundle enforces it.
  Everything is stored under `%APPDATA%\trAIMer` and survives uninstall
  unless you ask for it to be deleted.
- **One Windows installer.** Per-user install, no admin rights, no terminal.

## Installing

Download `trAIMer-Setup-1.0.0.exe` and `trAIMer-Setup-SHA256.txt` from this
release. The build is **not code-signed**, so Windows SmartScreen will warn
that the publisher is unknown: click **More info → Run anyway**. You can
verify the download first:

```powershell
Get-FileHash -Algorithm SHA256 .\trAIMer-Setup-1.0.0.exe
```

Upgrading from any release candidate is an in-place upgrade with your
history intact; CI installs rc.13 first and checks exactly that on every
build. Full instructions: `docs/INSTALL-WINDOWS.md`.

## Important limitations

- **Windows x64 only.** No macOS or Linux build.
- **Unsigned.** SmartScreen and some antivirus products warn on first run.
  Why, and what the checksum does and does not prove: `docs/CODE-SIGNING.md`.
- **trAIMer does not edit game settings.** It shows you the numbers; you
  open the game and type them in yourself.
- **Some profiles are partially verified or experimental.** PUBG:
  Battlegrounds stays experimental because its 1–100 scale is not confirmed
  linear and the reference FOV of its constant is unconfirmed. Battlefield 6
  stays experimental because its base constant rests on a single published
  measurement. Both convert hip-fire with a warning; one measured 360° turn
  in each game would settle them.
- **Unsupported scope and ADS conversions are refused on purpose.** Apex
  Legends per-optic ADS, Fortnite scope sensitivity, Marvel Rivals hero
  scopes, PUBG Targeting/ADS/per-scope settings and The Finals zoomed FOVs
  are left for you to set, because the published references conflict or are
  absent. The app says so rather than guessing.
- **Native Raw Input has boundaries.** The capture helper delivers the
  mouse's full polling rate on the desktop shell. If it cannot start, the
  app falls back to browser-rate capture and labels every result with the
  lower confidence that deserves; the highest confidence needs one run of
  Diagnostics → Native capture check.
- **Short sessions, real variance.** A recommendation is a measurement of
  one sitting. Repeat sessions before acting on a small difference.
- **The arena is not your game.** It measures aim on its own targets; it
  cannot see recoil, movement or a game's engine, and does not claim to.
- **Sessions from before rc.9** remain in History but are marked as unable
  to tell you a sensitivity: on those builds the arena did not apply the
  blinded candidate sensitivity.

trAIMer estimates what your own evidence supports and tells you how much to
trust that estimate. It does not claim to find the objectively best
sensitivity for anyone.

## What was checked before this release

Every gate in `.github/workflows/ci.yml` passed on the release commit,
including the installed-application gates: arena entry, candidate-gain
measurement, the game picker, a complete calibration, an in-place upgrade
from rc.13 with the earlier session preserved, and a silent uninstall that
keeps data followed by a reinstall that finds it. The hardware validation
record is in `docs/RELEASE.md`.

## Checksum

The installer's SHA-256 is published in `trAIMer-Setup-SHA256.txt` next to
the download and in the CI job summary that built it.

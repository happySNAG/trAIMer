# GitHub landing page

Repository metadata for the public release. None of this is set by code; a
maintainer applies it in the repository settings, and the values below were
applied for 1.0.0 (PASS-20-REPORT.md records what was set and how). Where a
value was chosen over alternatives, the reason is given so it can be
revisited.

## Name

**`trAIMer`** — `https://github.com/happySNAG/trAIMer`.

The previous slug carried the product's working title, which no longer
appeared anywhere a player saw except that URL. GitHub redirects the old
slug to the new one, so existing clones and links keep working; local
clones should still point `origin` at the new address:

```bash
git remote set-url origin https://github.com/happySNAG/trAIMer.git
```

## Description

> Blinded sensitivity calibration and game-profile conversion for FPS players.

This is the one-line description GitHub shows under the name. It says what
the tool does, names the mechanism that distinguishes it, and makes no claim
the README does not back. Alternatives considered:

- "Find your perfect sensitivity" — a claim the product explicitly does not
  make.
- "Aim trainer with sensitivity optimizer" — puts the trainer first, which
  is backwards.

## Tagline (for the README header, social cards, release titles)

> trAIMer — Train. Measure. Tune.

## Topics

```
aim-trainer
aim-training
fps
sensitivity
mouse-sensitivity
calibration
gaming
windows
electron
typescript
open-source
```

Game-specific topics were left off: eleven of them would read as keyword
stuffing, and the support matrix is where the games are listed.

## Homepage

Leave empty until there is a page that is not this repository. The README
is the homepage. If a release page is wanted as the homepage later, use the
**Releases** URL of the repository.

## Release title

> trAIMer 1.0.0 — Train. Measure. Tune.

Body: `docs/RELEASE-NOTES.md`. Release candidates are marked
**pre-release**; `v1.0.0` is a normal release. Assets:
`trAIMer-Setup-1.0.0.exe`, `trAIMer-Setup.exe`, `trAIMer-Setup-SHA256.txt`.

## Repository settings worth setting

- **Visibility:** public since 1.0.0. `docs/PUBLIC-SHARE-CHECKLIST.md` is
  what was checked before the flip.
- **Default branch:** `main`. The release candidates were built from the
  working branch on pull request #1; it was merged for 1.0.0, and 1.0.0 was
  built from `main`.
- **Security → Private vulnerability reporting:** enable it. `SECURITY.md`
  points there.
- **Issues:** enabled, with the templates in `.github/ISSUE_TEMPLATE/`.
- **Branch protection on `main`:** require the `engine`, `browser`,
  `native-windows`, `windows-installer` and `windows-release` checks.
- **Social preview:** a 1280×640 image of the results screen from
  `docs/screenshots/06-results-summary.png`, or the wordmark. Optional.

## Short pitch, for anywhere it is needed

> trAIMer runs a short blinded aim test across several sensitivities,
> measures how you actually perform on each, estimates the physical
> sensitivity your evidence supports, and converts it into your game's
> settings. Windows, local-only, no telemetry, MIT.

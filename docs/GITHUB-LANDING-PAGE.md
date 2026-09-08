# GitHub landing page

Recommended repository metadata for the public release. None of this is set
by code; a maintainer applies it in the repository settings. Where a value
was chosen over alternatives, the reason is given so it can be revisited.

## Name

**Recommendation: rename the repository to `traimer`.**

The current slug carries the product's working title, which no longer
appears anywhere a player sees except this URL. GitHub redirects the old
slug to the new one, so existing clones, links and the open pull request
keep working. After renaming: update the two absolute URLs in
`.github/ISSUE_TEMPLATE/config.yml`, remove the matching entry from
`ALLOWED` in `scripts/verify-branding.mjs`, and update `origin` in local
clones.

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
sensitivity
aim-trainer
fps
mouse
calibration
windows
electron
typescript
counter-strike-2
valorant
fortnite
apex-legends
overwatch
raw-input
local-first
```

Game topics are limited to the games with the most searched-for sensitivity
questions; the support matrix lists the rest.

## Homepage

Leave empty until there is a page that is not this repository. The README
is the homepage. If a release page is wanted as the homepage later, use the
**Releases** URL of the repository.

## Release title

> trAIMer 1.0.0-rc.13 — Train. Measure. Tune.

Body: `docs/RELEASE-NOTES.md`. Mark release candidates as **pre-release**.
Assets: `trAIMer-Setup-1.0.0-rc.13.exe`, `trAIMer-Setup.exe`,
`trAIMer-Setup-SHA256.txt`.

## Repository settings worth setting

- **Visibility:** the repository is private today. Making it public is the
  maintainer's decision and is not something CI or a script does. Before
  flipping it, run through `docs/PUBLIC-SHARE-CHECKLIST.md`.
- **Default branch:** `main`. The release candidates so far were built from
  the working branch on pull request #1; merge it before or with the first
  public release so `main` is what strangers read.
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

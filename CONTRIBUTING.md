# Contributing to trAIMer

Thank you for looking. This document tells you how to set the project up,
what the tests expect, how game profiles are built and verified, and what a
contribution needs to carry to be accepted. The short version: measurements
over opinions, sources over calculators, and nothing ships that the app
cannot honestly label.

## Development setup

Requirements: Node 20 or newer, npm. Windows is needed only to build and run
the desktop shell and the native helper; the engine, the frontend and the
browser suite run anywhere.

```bash
git clone https://github.com/happySNAG/trAIMer.git
cd trAIMer
npm install
npm test              # engine suite (unit, integration, blind-recovery campaigns)
npm run lint
npm run typecheck     # engine + desktop shell
npm run app           # frontend in a browser at http://localhost:5173
npm run test:browser  # Playwright end-to-end suite (starts Vite itself)
npm run desktop       # Electron shell locally (helper is Windows-only)
```

Useful single gates:

```bash
npm run verify:candidate-gain     # two blinded candidates must move the crosshair differently
npm run verify:game-picker        # every public profile is offered and renders its own fields
npm run verify:branding           # only "trAIMer" on user-facing surfaces
npm run audit:no-telemetry        # no network API or non-local URL in sources / bundle
node scripts/verify-docs.mjs      # links resolve, versions current, support matrix matches registry
node scripts/verify-installed-smoke.mjs   # a complete calibration in the Electron shell
```

`npm run dist:win` builds the installer on a Windows host. CI builds the real
one on a Windows runner and drives the installed application through every
gate before publishing it (`.github/workflows/ci.yml`).

## Repository layout

```
src/            measurement core: domain, capture, metrics, validation, optimizer,
                persistence, results, history — game-agnostic, reports physical units
src/games/      the game-profile layer: schema, registry, conversion, rounding,
                FOV/matching math, and one file per public profile under profiles/
app/            the frontend (TypeScript + DOM, no framework); views under app/src
desktop/        the Electron shell: window, local frontend delivery, helper lifecycle
native/windows/ the Raw Input capture helper (single C file, compiled in CI)
scripts/        release gates and audits (each is a `verify-*.mjs` or `audit-*.mjs`)
tests/          vitest suites; tests/browser holds the Playwright suite
docs/           architecture, methodology, release process, support matrix
```

One rule shapes everything: **nothing under `src/` outside `src/games/` may
import the profile layer.** Game profiles read the engine's output; they are
never an input to how aim is measured. `tests/gameProfileBoundary.test.ts`
enforces it.

## How a game profile is structured

A profile is **data, not code**: one `GameProfile` object
(`src/games/profileSchema.ts`) that `src/games/convert.ts` evaluates. It
declares:

| Field | What it says |
| --- | --- |
| `sensitivityModel` | how the game's number becomes degrees of rotation per mouse count (`linear-yaw` or `power-law-yaw`) |
| `hipfireField` | the setting's name, label, range, step, decimals and rounding rule |
| `axes` | one value, two values, or a value plus a vertical multiplier; any built-in vertical ratio |
| `dpi` | whether the scale is per mouse count, and what it assumes about pointer speed and raw input |
| `fov` | the field-of-view model: fixed, configurable (range, default, axis), or none; whether FOV scales hip-fire |
| `zoom` | ADS and optics: none, one scalar, or one entry per optic, each with its native behaviour |
| `defaultMatching`, `supportedMatching` | which scoped-aim philosophies the profile can express exactly |
| `unitDefinition`, `knownEdgeCases`, `warnings` | player-facing sentences, rendered verbatim |
| `source` | provenance: title, type, URL, publisher, game build, verified date, review date, confidence, uncertainty notes |
| `status`, `profileVersion` | how far to trust it, and which conversion definition this is |

`docs/GAME-PROFILES.md` explains each part with the reasoning behind it.

## Source and provenance expectations

Every number in a profile must be traceable. In order of authority:

1. Official documentation from the publisher.
2. First-party configuration behaviour (config keys, their scale, their
   defaults).
3. Reproducible technical references: a published formula, or a published
   cm/360 band that can be inverted into a constant.
4. Community references (converters, guides), only when they agree with each
   other and with something above them.
5. Professional players' published settings: corroboration only, never
   formula authority.

Rules that follow from this:

- A constant copied from a calculator, with no statement of where the
  calculator got it, is not a source. Two calculators that copy each other
  are one source.
- `source.type` must say what kind of evidence it is, and `confidence` must
  match it. The validator refuses `verified` alongside `confidence: "low"`.
- `uncertaintyNotes` must name what is still open. They are shown to players.
- `gameVersion` must say which build, patch or season the numbers were
  checked against, and `verifiedAtIso` when.
- A URL in `source.url` is displayed text. The app never fetches it. The
  no-telemetry audit allows it in the bundle only because it appears as a
  `url:` field in a profile file.

## Profile verification expectations

Before a profile is `partially-verified` or `verified`, its base constant
needs confirmation from a source family the profile did not already depend
on. The technique that settled most of the registry:

> A long-standing sensitivity reference publishes, per game, the in-game
> sensitivity range that puts a player at 800 DPI inside a 20 to 80 cm/360
> band. Inverting the fast end gives the constant:
> `yaw = 360 × 2.54 / (20 × 800 × sens_at_20cm)`. Calibrate the method first
> on games whose constants are documented, then apply it.

The gold standard is a measured 360° turn in the installed game: at one
sensitivity to pin a constant, at two to prove a scale is linear. If you
have the game and a mouse, that measurement is worth more than any number of
web references, and it is what would promote PUBG and Battlefield 6 out of
experimental.

Status honesty:

- `verified`: every converted value traces to documented behaviour, or is a
  definition.
- `partially-verified`: hip-fire confirmed; some zoom or FOV behaviour is
  not, and `knownEdgeCases` says which.
- `experimental`: the base constant rests on evidence that does not settle
  it. The app labels it everywhere. This is a legitimate status, not a
  failure.
- When references conflict, **refuse** the setting (leave it out and say so
  in `knownEdgeCases`) rather than pick one. A refusal is a feature.

## Adding a new profile

1. Open a **new game-profile request** issue, or a pull request, using
   [docs/PROFILE-PROPOSAL-TEMPLATE.md](docs/PROFILE-PROPOSAL-TEMPLATE.md).
   Fill every section; unsourced proposals are closed.
2. Create `src/games/profiles/<game>.ts` exporting one `GameProfile`. Put
   the reasoning in the file's header comment: which game, what the model
   is, why the status is what it is.
3. Add it to `PUBLIC_GAME_PROFILES` in `src/games/profiles/index.ts`.
4. Add tests (see the next two sections).
5. Add a row to `docs/SUPPORT-MATRIX.md` with the status and the verified
   date exactly as the profile declares them; `scripts/verify-docs.mjs`
   checks this.
6. Add the profile id to `REQUIRED_PROFILE_IDS` in
   `scripts/verify-game-picker.mjs` so the installed-app gate requires it.
7. Run the full suite. No conversion code should change and no existing
   game's arithmetic should move; if either does, that is a separate change
   with its own justification.

To change an existing profile's conversion definition, bump `profileVersion`
and say what changed in the file header and in `CHANGELOG.md`. Wording
changes do not bump it. Players with saved values under the old version are
told the definition changed; their stored numbers are never reinterpreted.

## Adding profile tests

`tests/gamePublicProfiles.test.ts` (Pass 2 games) and
`tests/gamePublicProfilesPass3.test.ts` show the shape. For a new profile,
cover:

- a known sensitivity + DPI → cm/360 case, and the inverse;
- the round-trip matrix (canonical → game → canonical) at several cm/360
  values and DPIs, within the profile's declared tolerance;
- bounds, rounding and step for every numeric field;
- the X/Y model;
- every zoom level the profile converts, under every matching philosophy it
  supports, and the explicit absence of any it refuses;
- FOV behaviour, if the conversion reads it;
- metadata: status, provenance completeness, currentness;
- a malformed variant the validator must refuse.

`tests/gameRoundingHardening.test.ts` sweeps every field of every public
profile automatically; a new profile is picked up without changes.

## Adding golden tests

`tests/gameSourceGolden.test.ts` holds cases whose **expected values were
published somewhere else**: a cm/360 band, a published zoom constant, a
publisher's documented neutral value. Those are the tests that catch a
profile that is internally consistent and wrong. When you add a profile:

- add its band-inversion case if the reference publishes a range for it;
- add any independently published constant the profile should reproduce
  (and, where relevant, a value it must **not** produce, the way the
  Overwatch case asserts 37.89 and never 49.46);
- cite the source in the test's comment. A golden test whose expected value
  came from this repository is not golden.

The cross-profile equivalence audit in the same file runs every ordered pair
of public profiles through `A → canonical → B → canonical`. A new profile is
included automatically; it must produce zero failures.

## Reporting a formula problem

Use the **game-profile correction** issue template. It asks for the game and
build, the setting, the value trAIMer produced, the value you believe is
right, and the evidence: ideally a measured 360° turn (DPI, sensitivity,
counts or centimetres), otherwise a source with a URL and a statement of
what kind of source it is. "Another calculator says something different" is
a useful pointer but is not, on its own, evidence that the profile is wrong.

## Privacy and no-telemetry expectations

trAIMer makes no network requests. A contribution must not add any: no
`fetch`, `XMLHttpRequest`, `sendBeacon`, `EventSource`, non-loopback
WebSocket, remote script, font, image, analytics, crash reporter or update
check. `scripts/audit-no-telemetry.mjs` runs against the sources and the
shipped bundle in CI and fails on any of them. Everything the app stores is
local; [PRIVACY.md](PRIVACY.md) is the contract, and a change to what is
stored changes that file in the same pull request.

## Safety boundaries

The app and the helper observe mouse input and measure aim in their own
window. A contribution must not: inject into any process, read or write
another process's memory, hook or synthesise input, modify game files or
configuration, or interact with anti-cheat. The static tests that enforce
this (`tests/nativeProtocolConstants.test.ts`,
`tests/gameProfileBoundary.test.ts`) are not to be weakened. The player
changes game settings by hand; trAIMer tells them what to set.

## Pull requests

- Keep the gates green: lint, typecheck, unit, browser, and the release
  gates listed in `docs/RELEASE.md`. No gate is weakened to make a change
  pass.
- Deterministic tests only. Seeded randomness, no wall-clock dependence.
- Every constant that affects a result is named, defaulted in one place,
  and documented.
- No fabricated precision: when evidence supports a range, return a range
  and a confidence.
- User-facing text says "trAIMer" and nothing else; `npm run verify:branding`
  enforces it.
- Do not rewrite the historical engineering reports (`PASS-*-REPORT.md`).
  They record what was true at the time.

## Code of conduct

Be straightforward and kind. Disagree with evidence. Assume the other person
wants the numbers to be right as much as you do.

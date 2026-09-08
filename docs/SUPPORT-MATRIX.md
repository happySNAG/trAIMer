# Game profile support matrix

What trAIMer can and cannot convert, per game, as of **1.0.0-rc.13**. This
table is checked against the profile registry in CI (`scripts/verify-docs.mjs`):
the status and the last-verified date in each row must match what the shipped
profile declares.

A conversion turns the physical sensitivity trAIMer measured (centimetres of
mouse travel per 360° turn, at your DPI) into the number a game's settings
screen accepts. Everything a profile does *not* cover is left alone rather
than guessed: the app says so on the results screen, and nothing is offered
for it.

## Status legend

| Status | Meaning |
| --- | --- |
| **Verified** | Every converted value traces to documented engine behaviour or is a definition. |
| **Partially verified** | Hip-fire is well supported. Some scoped or aimed-down-sights behaviour is unsupported, and the profile says which. |
| **Experimental** | The base constant rests on evidence that does not settle it. Shown in the picker with an "(experimental)" label, with a warning above its inputs and on every converted value. Use the number as a starting point and check it in the game. |

"Converted" below means trAIMer produces a value you can type into the game.
"Not converted" means the setting is left for you to set yourself, and the
app tells you so.

## The matrix

| Game | Profile status | Hip-fire | X/Y | ADS | Scopes / optics | FOV | Last verified | Important limitation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fortnite | Partially verified | Converted | Independent X and Y percentages, both converted | Targeting sensitivity converted as a plain multiplier | Scope sensitivity **not converted** (scope FOVs unpublished) | Not used by the conversion | 2026-09-08 | Scope sensitivity is not converted; slider bounds assumed from the settings screen. |
| Valorant | Partially verified | Converted | One value | ADS multiplier converted (rifle tier 1.25×) | Scoped multiplier converted (Operator tier 2.5×) | Fixed 103° horizontal | 2026-09-08 | Each multiplier covers a weapon *tier*: exact for one weapon, within a few percent for the others. |
| Counter-Strike 2 | Verified | Converted (`m_yaw` 0.022) | One value | No separate ADS setting | `zoom_sensitivity_ratio` converted for the AWP first zoom | Fixed 90° at 4:3 | 2026-09-08 | Whether the zoom ratio still applies to the AUG and SG 553 is disputed; neither is converted. Menu slider bounds vary between guides. |
| Apex Legends | Partially verified | Converted | One value | **Not converted** (published references disagree on the factors) | **Not converted** (per-optic) | 70–110, not used by the conversion | 2026-09-08 | Hip-fire only. Three references still conflict on per-optic ADS, so no value is offered. |
| Call of Duty / Warzone | Partially verified | Converted | Value plus a vertical multiplier, both converted | Relative mode coefficient converted (0.00 FOV-relative, 1.33 game default, 1.78 full-width on 16:9) | Per-zoom multipliers left at 1.00 (not converted) | 60–120, not used by the conversion | 2026-09-08 | Legacy ADS mode is not modelled. Assumed unchanged across the shared Black Ops 7 / Warzone menu. |
| Overwatch 2 | Partially verified | Converted | One value | No separate ADS setting | Relative zoom converted for Widowmaker, Ana and Ashe; other heroes **not converted** | 80–103, read (hero scoped FOVs are fixed) | 2026-09-08 | Only three heroes' scopes; their scoped FOVs are community-measured. |
| Rainbow Six Siege | Partially verified | Converted | Horizontal and vertical whole numbers, both converted | Per-optic ADS converted (eight optics, Ubisoft's neutral 50) | Same eight optics | 60–90 vertical, read | 2026-09-08 | Per-optic FOV factors are a community reconstruction of a table Ubisoft publishes only as an image. |
| Marvel Rivals | Partially verified | Converted | One value | No separate ADS setting | Hero scopes **not converted** (Black Widow, The Punisher: FOVs unpublished) | Fixed, not modelled | 2026-09-08 | Hero scopes are not converted; field bounds assumed. |
| PUBG: Battlegrounds | Experimental | Converted **with warning** (0.00222°/count per unit at FOV 80, scaled by the FOV you enter) | One value | Targeting and ADS **not converted** | Per-scope sliders **not converted** | 80–103, default 90, **multiplies the hip-fire answer** | 2026-09-08 | Whether the 1–100 scale is linear is unverified, and the reference FOV of the constant is unconfirmed. Measure one 360° turn before trusting a converted value. Enter your actual FOV. |
| The Finals | Partially verified | Converted | One value | One zoom multiplier: only the game's own 100% is offered | Zoomed FOVs unpublished, so no other value | 45–100 vertical, default 71, not modelled | 2026-09-08 | The constant is fitted, never measured (moderate confidence). Only the game's own zoom relationship is offered. |
| Battlefield 6 | Experimental | Converted **with warning** (0.0025079°/count per menu unit, from one published measurement) | One value | Uniform Soldier Aiming coefficient converted (0% FOV-relative, 133.3% game default, 177.8% full-width on 16:9) | Per-zoom multipliers left at 1.00 (not converted) | 85–122, not used by the conversion | 2026-09-08 | The base constant rests on a single published measurement, with a competing 0.0022 in circulation. One live-game 360° measurement would settle it. |
| Generic / Raw | Verified | Converted (0.02°/count at 1.00, by definition) | Independent absolute X and Y | None | None | None | 2026-09-08 | A four-decimal grid: the app reports the rounding where the grid cannot express a value exactly. |

## What "experimental" means in practice

PUBG: Battlegrounds and Battlefield 6 are shipped, selectable, and convert
hip-fire. They are not presented as recommendations of the same standing as
the other ten:

- the picker lists them as "PUBG: Battlegrounds (experimental)" and
  "Battlefield 6 (experimental)";
- choosing one shows a warning block above the inputs that names the specific
  open question;
- every converted value on the results screen carries the experimental badge
  and the same warning.

Both would be settled by one measured 360° turn in the installed game, at two
different sensitivities for PUBG. Until someone measures that, the profile
stays experimental, and the app says so.

## What is deliberately refused

These are not gaps waiting for a value to be typed in. In each case the
available references conflict or publish nothing, and picking one would turn
a guess into a number that looks measured:

- Apex Legends per-optic ADS
- Fortnite scope sensitivity
- Marvel Rivals hero scopes
- PUBG Targeting, ADS, per-scope and vertical settings
- The Finals zoomed FOVs

If you can supply a documented or measured source for any of these, see
[CONTRIBUTING.md](../CONTRIBUTING.md) and the
[profile proposal template](PROFILE-PROPOSAL-TEMPLATE.md).

## Where the numbers come from

Every profile carries its own provenance, visible in the app under "About the
… profile": the source and its type, the game build the numbers were checked
against, when they were last verified, a confidence level, and the list of
what the profile does not cover. The full engineering account, including the
independent re-derivation of eight base constants from a published cm/360
band, is in [GAME-PROFILES.md](GAME-PROFILES.md).

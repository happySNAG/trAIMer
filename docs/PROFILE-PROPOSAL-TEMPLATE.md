# Game profile proposal

Copy this file into your issue or pull request and fill in every section. A
proposal with empty sections, or whose only source is a converter website,
will be sent back for evidence rather than merged. That is not a judgement on
the game or on you; it is what lets the app label the profile honestly.

Read [CONTRIBUTING.md](../CONTRIBUTING.md) first, in particular *Source and
provenance expectations* and *Profile verification expectations*.

---

## 1. Game

- **Title:**
- **Publisher / developer:**
- **Platform(s) the profile covers:** (PC only, unless you have evidence for
  others)
- **Game version / build / season the numbers were checked against:**
- **Engine or franchise family, if relevant:** (for example "Source 2",
  "Unreal Engine 5", "Frostbite")
- **Does an earlier or related title share this exact scale?** If yes, name
  it and the evidence; if no, say what changed.

## 2. Hip-fire sensitivity model

- **Setting name as the game's own settings screen shows it:**
- **Config-file key, if any, and its relationship to the menu value:**
  (for example "menu 0–100 in tenths stores as 0.000000–0.075000, 0.000750
  per unit")
- **Model:** `linear-yaw` (degrees per count = value × constant) or
  `power-law-yaw` (coefficient × value ^ exponent). Anything else needs a
  discussion first.
- **Constant(s):** degrees of view rotation per mouse count at a value of
  1.0, to as many significant figures as the evidence supports.
- **Pitch constant, if different from yaw:** (leave blank if the game uses
  the same constant for both)
- **At what FOV is the constant stated?** Does hip-fire rotation per count
  change with the FOV slider? If so, how (linear in degrees? tangent?), and
  what is the evidence?

## 3. Slider ranges and entry grid

For **every** numeric setting the profile will convert:

| Setting | Minimum | Maximum | Step | Decimals shown | Decimals stored in config | Rounding rule | Unit suffix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |

State how you know the bounds (the settings screen, the config file, a
published reference). "Assumed" is an acceptable answer if you say so.

## 4. X/Y model

Pick one and give the evidence:

- [ ] One value for both axes
- [ ] Two independent absolute values (name the vertical setting)
- [ ] One value plus a vertical **multiplier** (name it, its range and its
      default)
- [ ] The engine applies a fixed vertical:horizontal ratio the player cannot
      change (state the ratio and how it was measured)

## 5. DPI and input assumptions

- Is the game's scale defined per mouse **count** (so DPI and sensitivity
  trade off exactly)?
- Does it assume Windows pointer speed at the default 6/11 notch with
  "Enhance pointer precision" off?
- Does it require raw input to be enabled for the constant to hold?
- Any other assumption (mouse acceleration setting, a smoothing option, a
  "sensitivity curve" toggle)?

## 6. Field of view model

- **Setting:** none / fixed / configurable
- **Axis the number refers to:** horizontal at 16:9, horizontal at 4:3,
  vertical, or something else. Say how you know.
- **Range, step, and default:**
- **Does any conversion read it?** (Only if a zoom's FOV is derived from it,
  or if hip-fire scales with it.)

## 7. ADS and scope behaviour

Pick one:

- [ ] No ADS or scope setting
- [ ] One ADS setting covering every optic
- [ ] One setting per optic (list them)

For **each** zoom level, state:

| Zoom | Magnification | FOV in this state (and its axis) | Setting name | Neutral value (stock behaviour) | Native behaviour | Value scale (e.g. 100 for percent) |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

Native behaviour is one of: `multiplies-hipfire`, `fov-relative-multiplier`,
`fov-ratio-multiplier`, `independent-scalar`, `monitor-distance-coefficient`.
`src/games/profileSchema.ts` defines each. If you are not sure which one the
game uses, say so; a wrong native behaviour produces plausible wrong numbers.

If a zoom's FOV is unpublished and cannot be measured, **leave it out** and
list it under section 11. Do not estimate one.

## 8. Matching philosophies

Which scoped-aim philosophies can the profile express **exactly**?

- [ ] Same physical sensitivity (same cm/360 in every state)
- [ ] FOV-relative / focal-length / 0% monitor distance
- [ ] Monitor-distance match at a coefficient (state which axis the game
      matches on)
- [ ] The game's own default

Which should be the default, and why?

## 9. Sources

List every source. For each:

| # | Title | URL | Type | Publisher / author | Date | What it establishes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | |

Type is one of: `official-documentation`, `in-game-measurement`,
`first-party-config-file`, `community-reference`, `unit-definition`.

Then answer:

- Which source is the **authority** for the base constant?
- Which sources are **independent** of each other (not copies)?
- Did any two sources **disagree**? On what, and how did you resolve it (or
  did you leave the setting unconverted)?
- Does a published cm/360 band exist for this game? If so, show the
  inversion (`yaw = 360 × 2.54 / (20 × 800 × sens_at_20cm)`) and whether it
  reproduces your constant.

## 10. Measurements (strongly preferred)

If you measured in the game:

- DPI:
- Sensitivity value(s) tested:
- Method: (full 360° turn back to a landmark; number of repetitions)
- Counts or centimetres per turn, per repetition:
- Derived constant per repetition, and the spread:
- For a linearity check: the same at a second sensitivity, and the ratio.

## 11. Uncertainty

What is **not** settled? Be specific: "the 1–100 scale is assumed linear",
"scope FOVs are unpublished", "field bounds come from a screenshot of an
older build". Every line here becomes an `uncertaintyNotes` entry the player
reads.

What is deliberately **not converted**, and why?

## 12. Verification date and reviewer

- **Verified on:** (ISO date)
- **Verified by:** (handle)
- **Game build at verification:**

## 13. Test cases

Give at least:

1. A known sensitivity + DPI → expected cm/360 (show the arithmetic).
2. The inverse: a cm/360 + DPI → expected in-game value, with the rounding
   the game's grid forces.
3. For each converted zoom, under each supported philosophy: hip-fire
   value → expected zoom setting.
4. One value the game **cannot** express (out of range or between steps)
   and what the profile should say.
5. Any published constant from an independent source that the profile must
   reproduce (a golden case), and any it must **not** produce.

## 14. Proposed status

- [ ] `verified` — every converted value traces to documented behaviour
- [ ] `partially-verified` — hip-fire confirmed; some zoom or FOV behaviour
      is not, and section 11 says which
- [ ] `experimental` — the base constant rests on evidence that does not
      settle it

Confidence: `exact` / `high` / `moderate` / `low`. Justify it in one
sentence. The validator refuses `verified` with `low`.

## 15. Checklist

- [ ] Every section above is filled in or explicitly marked "not applicable"
- [ ] No number in the profile comes only from a calculator that does not
      state its own source
- [ ] Every unpublished or contradictory setting is left unconverted and
      listed in section 11
- [ ] The proposed status matches the evidence, not the effort
- [ ] Tests from section 13 are included (see CONTRIBUTING.md, *Adding
      profile tests* and *Adding golden tests*)
- [ ] A row for `docs/SUPPORT-MATRIX.md` is included

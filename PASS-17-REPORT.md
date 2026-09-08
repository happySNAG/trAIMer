# Pass 17 — the second game batch, and the picker gate the installer was missing

**Product:** **trAIMer** — *Train. Measure. Tune.*
**Release candidate:** `1.0.0-rc.11`
**Campaign:** trAIMer Game Profile Campaign, **Pass 3 of 5** — expansion
public profiles plus installed-app picker validation. Pass 4 (the final
formula/source validation campaign) has **not** been started.

**In one sentence:** six more games ship as versioned, sourced profiles —
Overwatch 2, Rainbow Six Siege, Marvel Rivals, PUBG: Battlegrounds, The
Finals and Battlefield 6 — the picker is organised for twelve, and Windows
CI now drives the real picker inside the installed application and checks
every public profile against the engine's own declarations.

---

## 0. Baseline

| | |
| --- | --- |
| Repo | `https://github.com/happySNAG/Aldo-Aim-Lab.git` |
| Branch | `ox/aldo-aim-lab-20260823T194949Z-a28b6239` |
| **Starting HEAD** | `e17ff56` — "Name the report commit in the Pass 16 commit table" |
| **Built HEAD** | `7a893b8` — "Cut 1.0.0-rc.11 for Game Profile Campaign Pass 3" (the commit CI built and verified); the report commit follows |
| Unit tests at start | 1102 passing, 95 files |
| Unit tests at end | **1160 passing, 96 files** |
| Browser tests at end | **179 passing** (was 155) |

## 1. Commits

| Commit | |
| --- | --- |
| `c3451b9` | Let a profile scale a zoom from the hip-fire FOV and hip-fire from the FOV slider |
| `bf35336` | Add six more public game profiles |
| `1648129` | Organise the picker for twelve games and gate it inside the installed app |
| `7a893b8` | Cut 1.0.0-rc.11 for Game Profile Campaign Pass 3 |
| (this commit) | Add the Pass 17 report |

---

## 2. Research method, and why four constants had to be settled

None of the six publishers documents a rotation constant. For each game the
settings menu, the technical community references, and — decisively — the
published professional settings with their cm/360 figures were compared.
Where converters disagreed, the pro-settings tables broke the tie, because a
constant that puts every professional at an absurd distance is wrong
whatever a converter says. Four constants were disputed:

| Game | Candidates found | Adopted | Why |
| --- | --- | --- | --- |
| Rainbow Six Siege | 0.00223 (older guides) vs 0.00572958 (2026 references) | **0.00572958** per unit | pro data (Shaiiko 400 DPI / 12 = 33.2 cm, Pengu 1600 / 2 = 49.9 cm) fits 0.00573 exactly; 0.00223 puts them 2.57× slower than published |
| Marvel Rivals | 0.022, 0.0066, 0.017453 | **0.017453** (π/180) | the two references that state a constant AND publish consistent cm/360 tables use π/180; 0.0066 puts published pros at 30–135 cm |
| The Finals | 0.0066 (copied from Overwatch) vs 0.001 | **0.001** per unit | published pros (26 at 800 = 43.6 cm; 38 at 800 = 29.8 cm) fit 0.001; 0.0066 would make a "50" slider 3 cm/360 |
| PUBG | "0.022" vs 0.00222 | **0.00222** per unit, linear, at FOV 80 | pro data (chocoTaco 800 / 25 = 20.6 cm) fits 0.00222; "0.022" is off by ten. Linearity of the 1–100 scale is NOT verified → experimental |

Battlefield 6 has no dispute — it has one data point (the community guide's
author at 1600 DPI, menu 6 = 37.98 cm/360), which gives 0.0025079° per count
per menu unit, and one data point is why it ships experimental.

---

## 3. The six profiles

Verification date 2026-09-08 for all six. Every `source` carries a URL,
type, game/version context, confidence and uncertainty notes. Only
Rainbow Six Siege cites an official document (Ubisoft's Y5S3 ADS guide);
the rest are community references, stated as such.

### 3.1 Overwatch 2 — `overwatch-2` v1

| | |
| --- | --- |
| Model | linear yaw, **0.0066° per count at 1.00** (shared with Call of Duty) |
| Hip-fire field | Sensitivity, 1.00–100.00, two decimals; one value for both axes |
| FOV | configurable **80–103 in 0.5° steps, horizontal at 16:9**; does not change hip-fire, but IS read — hero scoped FOVs do not move with it |
| Zoom | per hero, each its own "Relative Aim Sensitivity While Zoomed" (1–100%): Widowmaker and Ana (scoped 50.94°), Ashe (aimed 65.81°). `multiplies-hipfire` with `valueScale: 100` — the game applies no scaling of its own |
| Philosophies | same physical (100%), FOV-relative (**37.89 / 37.89 / 51.47** at 103 FOV — the published values, reproduced to two decimals), 100% monitor distance, game default (30.00%, the default) |
| Worked example | 5.00 at 800 DPI = 34.6 cm/360 |
| Status | partially-verified (high) |
| Source | game-sens.jor.dev, consistent with mouse-sensitivity.com-derived values |
| Not converted | heroes added after Ashe with a zoom |
| Open | yaw and scoped FOVs community-measured; slider bounds assumed; stock relative value assumed 30% |

### 3.2 Rainbow Six Siege — `rainbow-six-siege` v1

| | |
| --- | --- |
| Model | linear yaw, **0.00572958° per count per unit** at the stock MouseSensitivityMultiplierUnit 0.02 |
| Hip-fire fields | Mouse sensitivity horizontal and vertical, **separate whole numbers 1–100** |
| FOV | configurable **60–90 vertical**, read |
| Zoom | eight optics (1.0×, 1.5×, 2.0×, 2.5×, 3.0×, 4.0×, 5.0×, 12.0×), each an Advanced ADS slider 1–200, each `scaled-from-hipfire` (FOV factors 0.90, 0.59, 0.49, 0.42, 0.35, 0.30, 0.22, 0.092) as `fov-relative-multiplier` with `valueScale: 50` — 50 is the game's own focal-length neutral under Ubisoft's visuomotor-gain scale |
| Philosophies | game default (50) = FOV-relative (50); same physical (57 at 1× on 60 vFOV, clamped at 200 for 12× and reported); 100% monitor distance |
| Worked example | 12 at 400 DPI = 33.2 cm/360 |
| Status | partially-verified (high) |
| Source | Ubisoft, "Guide to ADS Sensitivity in Y5S3" (official) for the ADS model; r6senscalculator.com / aimbench.com for the constants |
| Open | the yaw dispute above (stated in the profile); 50 = exact focal-length neutral follows from Ubisoft's description, not re-measured; FOV factors are a two-decimal community reconstruction |

### 3.3 Marvel Rivals — `marvel-rivals` v1

| | |
| --- | --- |
| Model | linear yaw, **0.017453° per count at 1.00** (π/180) |
| Hip-fire field | Mouse Sensitivity, 0.01–20.00, two decimals; linked axes |
| FOV | fixed, no setting (≈90° reported); modelled as none |
| Zoom | **not converted** — Black Widow's scope and The Punisher's turret have their own aim sensitivity, reportedly focal-length scaled at 1.0, with unpublished FOVs |
| Worked example | 3.50 at 800 DPI = 18.7 cm/360 |
| Status | partially-verified (**moderate**) |
| Source | game-sens.jor.dev; aimbench.com tables |
| Open | three community constants exist; bounds assumed; the game writes but does not read a finer config value (DPI Wizard) |

### 3.4 PUBG: Battlegrounds — `pubg-battlegrounds` v1 — EXPERIMENTAL

| | |
| --- | --- |
| Model | linear yaw, **0.00222° per count per General-sensitivity unit at FOV 80**, and **hip-fire × FOV/80** (`hipfireScaling`) |
| Hip-fire field | General sensitivity, whole numbers 1–100; linked axes |
| FOV | configurable 80–103, read because it scales hip-fire; the conversion states the FOV it is for |
| Zoom | **not converted** — Targeting, ADS, per-scope (2×–15×) and the vertical multiplier each have their own unpublished scale |
| Worked example | 25 at 800 DPI (FOV 80) = 20.6 cm/360 |
| Status | **experimental** (low) — every conversion carries the warning |
| Source | aimbench.com pro tables; schokkya/PUBG-Sensitivity-Converter for the 80/FOV scaling |
| Open | linearity of the 1–100 scale; the FOV scaling is from a community tool; FOV axis assumed |

### 3.5 The Finals — `the-finals` v1

| | |
| --- | --- |
| Model | linear yaw, **0.001° per count per look-sensitivity unit** |
| Hip-fire field | Mouse look sensitivity, whole numbers 1–100 (default 50); linked axes |
| FOV | slider exists (horizontal, ~71–100), not modelled, not read |
| Zoom | one "Mouse zoom sensitivity multiplier" (10–200%), `fov-relative-multiplier` with an unpublished FOV: with "focal length sensitivity scaling" on the game matches at the crosshair itself, so only the game's own 100% is offered; the achieved rotation is reported as unknown |
| Worked example | 40 at 800 DPI = 28.6 cm/360 |
| Status | partially-verified (moderate — "Embark publishes no exact constant") |
| Source | aimbench.com |
| Open | constant fitted, not measured; zoom bounds assumed; FOV not modelled |

### 3.6 Battlefield 6 — `battlefield-6` v1 — EXPERIMENTAL

**Exact supported title: Battlefield 6 (EA / DICE, October 2025), PC.**
Battlefield 2042 and earlier use a different menu scale (the guide's
maintainer documents the change) and are explicitly out of scope; the
profile is named "Battlefield 6", not "Battlefield".

| | |
| --- | --- |
| Model | linear yaw, **0.0025079° per count per menu unit**, from the one published measurement (1600 DPI, 6.0 = 37.98 cm/360) |
| Hip-fire field | Soldier mouse sensitivity, 0.1–100.0 in 0.1 steps (the config stores value × 0.000750 — same setting, other scale, not offered as precision) |
| FOV | configurable 85–122 horizontal (bounds assumed); unused by the conversion |
| Zoom | **Uniform Soldier Aiming coefficient** as `monitor-distance-coefficient` on the vertical axis, in percent (0–400 in 0.1): FOV-relative → **0.0%**, 100% horizontal on 16:9 → **177.8%**, game default → **178.0%**; per-zoom sensitivities (1.00×–10.00×) left at 1.00 |
| Philosophies | FOV-relative, 100% monitor distance, game default; same-physical refused |
| Worked example | 6.0 at 1600 DPI = 38.0 cm/360 |
| Status | **experimental** (moderate) |
| Source | Jotunn, "Battlefield 6 PC Sensitivity Guide" (gist); mouse-sensitivity.com's BF6 thread for the zoom structure |
| Not converted | per-zoom multipliers (product with soldier zoom capped at 3), Zoom Sensitivity Smoothing |
| Open | one data point; stock coefficient reported as both 178% and 133%; coefficient and FOV bounds assumed; 16:9 assumed |

---

## 4. ADS / scope, FOV, and precision — all twelve at a glance

| Game | ADS / scope | FOV in the picker | Grid |
| --- | --- | --- | --- |
| Apex Legends | not converted | no | 0.1 steps + file |
| Battlefield 6 | coefficient (3 philosophies) | no | 0.1 steps; coefficient 0.1% |
| Call of Duty / Warzone | coefficient (3 philosophies) | no | 2 decimals |
| Counter-Strike 2 | zoom ratio (4 philosophies) | no (fixed 90 at 4:3) | 2 decimals + 6 in console |
| Fortnite | targeting (1 philosophy); scope not converted | no | 0.1% |
| Marvel Rivals | not converted | no (fixed) | 2 decimals |
| Overwatch 2 | per hero ×3 (4 philosophies) | **yes** | 2 decimals |
| PUBG | not converted | **yes** (scales hip-fire) | whole numbers |
| Rainbow Six Siege | per optic ×8 (4 philosophies) | **yes** (vertical) | whole numbers; ADS 1–200 |
| The Finals | game default only | no | whole numbers; zoom 1% |
| Valorant | two multipliers (4 philosophies) | no (fixed 103) | 3 decimals |
| Generic / Raw | none | no | 4 decimals |

---

## 5. Unsupported fields, and why

- **Marvel Rivals scoped heroes** — zoomed FOVs unpublished; the game
  reportedly scales at the crosshair natively, so 1.0 is left alone.
- **PUBG Targeting / ADS / per-scope / vertical multiplier** — each has its
  own unpublished scale; collapsing them into General would be a guess.
- **The Finals same-physical and monitor-distance** — zoomed FOVs
  unpublished; the game's own focal-length relationship is the only
  defensible statement.
- **Battlefield 6 per-zoom multipliers and smoothing** — covered by Uniform
  Soldier Aiming at 1.00; the individual scales are not documented.
- **Overwatch heroes newer than Ashe with a zoom** — no published scoped
  FOV.
- Carried over unchanged from Pass 2: Fortnite scope, every Apex optic,
  Call of Duty Legacy and per-zoom multipliers.

---

## 6. Architecture changes (additive; schema version unchanged)

| Addition | Used by |
| --- | --- |
| `FovModel` `scaled-from-hipfire` for zoom levels (`resolveScaledFov`) | Rainbow Six Siege's eight optics follow the FOV slider |
| `hipfireScaling` on a configurable FOV (`hipfireFovFactor`) | PUBG's hip-fire × FOV/80 |
| `fov-relative-multiplier` with no FOV, allowed only when `game-native` is the sole philosophy; achieved rotation reported as `null` | The Finals |
| `quantize` reports "clamped" when the EXACT value is outside the range, even if the grid would have snapped it onto the floor | Siege's whole-number grid at extreme values |
| picker: `Recently used` / `Games (A–Z)` / `Other` groups; `#game-profile-filter` above six profiles | twelve profiles |
| `window.__ALDO_GAME_PROFILES_FOR_TESTING__` — boot-time, read-only, `?e2e=1` only | the installed-app picker gate |

The measurement core did not change. `git diff e17ff56..HEAD -- src/optimizer
src/analysis src/capture src/sensmath src/calibration src/scenarios` is
empty; candidate gain, blinding, pairing, geometry, hit detection, timing,
capture rules and evidence gating are untouched, and the boundary test still
forbids the game layer from every measurement module.

---

## 7. Picker UX

Twelve entries needed structure. The select now has three groups —
**Recently used** (up to three, most recent first, kept in local storage),
**Games (A–Z)** (the eleven named games, alphabetical), **Other** (Generic /
Raw) — and a **Find a game** box appears above it once more than six
profiles are selectable, narrowing the list by name as you type. The
default interaction is unchanged: pick a game, type your value. Option
values are still profile ids; fixtures cannot reach the picker. An
experimental profile is labelled the moment it is chosen, with its
uncertainties one click below.

---

## 8. The installed-app picker gate

`scripts/verify-game-picker.mjs` (also `npm run verify:game-picker`):

1. launches the Electron shell (dev tree, or `--exe <installed trAIMer.exe>`),
   navigates to `aldo://app/index.html?e2e=1`, opens the Aim Test screen;
2. reads what the registry declares through the boot-time hook — id, name,
   status, visibility, version, whether it has a vertical field, whether it
   reads an FOV, how many philosophies it offers, and a sample value inside
   its own range;
3. checks the list: all twelve required ids present, nothing offered the
   registry does not declare, no fixture, every entry public, Games
   alphabetical, Generic / Raw alone under Other;
4. for **every** declared profile: selects it, asserts the vertical / FOV /
   matching controls match the declaration exactly, types the sample value,
   asserts a physical equivalent in cm/360 renders, asserts the definition
   version and "Last verified" are in the details, and that a non-verified
   status badge is shown;
5. checks the filter narrows the list, a Valorant selection with a typed
   value survives `page.reload()`, the Recently used group lists it,
   Generic / Raw converts, and the on-screen text contains no legacy name
   (read from the branding gate's `--print-contract`, so the legacy names
   exist in exactly one file) and does contain trAIMer.

CI runs it on the dev tree in `windows-installer` right after the
candidate-gain gate, and again on the **installed** application at
`C:\traimer-install-test\trAIMer.exe` before the installer is published. On
the dev tree it makes 60 checks.

---

## 9. Cross-profile equivalence

`tests/gamePublicProfilesPass3.test.ts`: Overwatch 2 → Siege → Marvel
Rivals → PUBG → The Finals → Battlefield 6 → Fortnite, each link at 400 /
800 / 1600 DPI, preserving the requested physical sensitivity and reading
back inside the target's own round-trip tolerance; the constant ratios the
references publish (The Finals = 6.6 × Overwatch, etc.); a twelve-profile
loop Fortnite → … → Generic → Fortnite that returns within 8% (the whole-
number grids of Siege, PUBG and The Finals are the coarse links); and a
check that no profile file names another game. All conversions go through
`CanonicalAim`; there is still no pairwise formula anywhere.

---

## 10. Tests added

| File | What |
| --- | --- |
| `tests/gamePublicProfilesPass3.test.ts` (new, 41 tests) | per game: known value → canonical, inverse, round-trip matrix, min/max, grid, X/Y, every offered philosophy, FOV, metadata; fail-closed: zero yaw, inverted range, version zero, foreign schema, bad date, verified-on-low, unknown matching, impossible FOV, scaled zoom without hip FOV, hip scaling without the flag, native-only relaxation, invalid DPI/sensitivity, impossible coefficient; the six-link chain and the twelve-profile loop |
| `tests/browser/gameProfilesPass3.spec.ts` (new, 24 tests) | twelve offered / no fixture / no legacy name, filter, reload + Recently used, each new game's fields, physical equivalent per game, PUBG's equivalent following its FOV, provenance per game, the results card per game (per-hero lines, exact vs entered, experimental warning, coefficient), result section follows the selected game |
| `scripts/verify-game-picker.mjs` (new gate) | §8 |
| existing suites | registry / boundary / picker-order expectations updated for twelve |

## 11. Full suite

| Suite | Result |
| --- | --- |
| lint | clean |
| typecheck (engine + desktop) | clean |
| unit (`vitest run`) | **1160 passed, 96 files** |
| browser (`playwright test`) | **179 passed** (10.5 min, one worker) |
| Electron: arena entry (dev tree) | all checks passed |
| Electron: candidate gain (dev tree) | gains 0.8696 / 1.0000, spread 1.15× — passed |
| Electron: game picker (dev tree) | **60 checks passed** |
| Electron: smoke | pass, `appVersion 1.0.0-rc.11` |
| `verify-release`, `verify-windows-artifacts --frontend` | passed |
| branding gate (sources, docs, bundle) | PASS — 13 documented survivals, unchanged |
| no-telemetry audit (sources + bundle) | CLEAN; the bundle's nine allowed URLs are exactly the nine distinct profile sources |

No gate was weakened; one was added.

## 12. Windows CI and installer

CI run **34192559910** on commit `7a893b8` — **all five jobs green**
(`engine`, `browser`, `native-windows`, `windows-release`,
`windows-installer`), 05:56–06:10 UTC on 2026-09-08.
<https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34192559910>

| Gate | Job | Result |
| --- | --- | --- |
| game profiles fail closed and stay out of the measurement core (now including `gamePublicProfiles` and `gamePublicProfilesPass3`) | engine | passed |
| arena candidate gain + gain history validity; user-data migration; calibration journey; branding | engine | passed |
| browser suite incl. the three game-profile specs | browser | passed |
| two blinded candidates differ in the REAL arena | browser | passed |
| helper is a genuine x64 PE and executes | native-windows / windows-installer | passed |
| **game picker offers every public profile (dev tree)** | windows-installer | 60 checks passed |
| no-telemetry audit on the Windows-built bundle | windows-installer | CLEAN — nine allowed URLs, exactly the nine distinct profile sources |
| branding: sources, bundle, installer, installed layout | windows-installer | PASS |
| silent install → complete application | windows-installer | passed |
| installed app starts and shuts down cleanly (`helperState: ready`, `appVersion: 1.0.0-rc.11`) | windows-installer | passed |
| the INSTALLED app can start a test | windows-installer | passed |
| the INSTALLED app changes sensitivity between candidates | windows-installer | gains 0.8696 / 1.0000, spread 1.15× — passed |
| **the INSTALLED app's game picker offers every public profile** | windows-installer | **60 checks passed** on `C:\traimer-install-test\trAIMer.exe` |

The installed-app picker gate, verbatim from the Windows runner (abridged
to one profile; all twelve passed the same four checks):

```
game-picker gate: installed app at C:\traimer-install-test\trAIMer.exe
  ok   the registry loaded inside the shipped shell — 12 selectable profiles
  ok   every public profile this pass ships is offered — 12 offered
  ok   the picker offers nothing the registry does not declare
  ok   no fixture profile appears
  ok   every offered profile is public
  ok   the named games are listed alphabetically — Apex Legends, Battlefield 6, …
  ok   Generic / Raw sits on its own at the end
  ok   Rainbow Six Siege: renders its own fields and no others — vertical=1 fov=1 matching=1 (declared 1/1/1)
  ok   Rainbow Six Siege: 11 converts to a physical equivalent — Physical equivalent 18.1 cm/360 …
  ok   Rainbow Six Siege: definition version and provenance are reachable — v1
  ok   Rainbow Six Siege: its partially-verified status is shown where it is chosen
  …
  ok   a filter box is offered for a list this long
  ok   typing part of a name narrows the list — marvel-rivals, valorant, generic-raw
  ok   a game selection and its entered value survive a reload — restored valorant / 0.4
  ok   the last game chosen is listed under Recently used
  ok   Generic / Raw still converts a current value — Physical equivalent 57.1 cm/360 …
  ok   no legacy product name appears on the screen
  ok   the product name on screen is trAIMer
game-picker gate: all checks passed.
```

(The filter check typed "val": Marvel Rivals matches because its name
contains "val", and the currently selected profile is always kept in the
list — both by design.)

History migration and the marking of pre-rc.9 sessions as invalid are
covered by the engine job's release gates, unchanged and passing.

**Artifact**, downloaded from the run and checksum-verified against the value
CI published:

| | |
| --- | --- |
| `release/rc11/trAIMer-Setup-1.0.0-rc.11.exe` | 100,541,998 bytes |
| `release/rc11/trAIMer-Setup.exe` | identical copy |
| `release/rc11/trAIMer-Setup-SHA256.txt` | CI's checksum file |
| SHA-256 | `515954725c04deca239d208ef11eee77688b5a82f1328a4363cf75b37b9ad581` |

`/Volumes/NO NAME` was **not mounted** at any point during this pass
(checked at the start, before the build and after the download). The
installer is staged locally under `release/rc11/` with its checksum file;
the flash drive is **not** prepared and nothing was copied. Once the drive
is present:

```
cp release/rc11/trAIMer-Setup-1.0.0-rc.11.exe release/rc11/trAIMer-Setup.exe release/rc11/trAIMer-Setup-SHA256.txt "/Volumes/NO NAME/" && shasum -a 256 "/Volumes/NO NAME/"trAIMer-Setup*.exe
```

## 13. Remaining uncertainty, per new profile

- **Overwatch 2** — yaw and scoped FOVs community-measured; sensitivity and
  relative-zoom bounds assumed; stock relative value assumed 30%; newer zoom
  heroes not modelled.
- **Rainbow Six Siege** — the 0.00223 vs 0.00572958 dispute is resolved by
  pro data, not by Ubisoft; 50 as the exact focal-length neutral follows
  from Ubisoft's description; FOV factors are a two-decimal reconstruction.
- **Marvel Rivals** — three community constants; bounds assumed; fixed FOV
  value unverified.
- **PUBG** — slider linearity unverified (the reason it is experimental);
  FOV scaling from a community tool; FOV axis assumed; everything but
  General sensitivity unconverted.
- **The Finals** — constant fitted, not measured; zoom bounds assumed; FOV
  not modelled.
- **Battlefield 6** — one data point; stock coefficient 178% vs 133%;
  coefficient and FOV bounds assumed; 16:9 assumed for the axis
  translation.

Every item is in the profile's `uncertaintyNotes` or `knownEdgeCases`,
rendered under "What this profile does not cover".

## 14. Correctness defects found outside the profile work

One, in the Pass 1 rounding model: `quantize` snapped a below-floor exact
value onto a whole-number grid's floor and reported it as rounding rather
than clamping (an exact 0.54 on Siege's 1–100 grid became "1, rounded"). It
now reports the exact value as outside the game's range. No measurement
code, gate or result contract was affected.

## 15. Pass 4

Not started. No formula/source validation campaign work exists in the tree
beyond the profiles' own uncertainty notes.

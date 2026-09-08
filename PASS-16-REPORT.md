# Pass 16 — the first five public game profiles

**Product:** **trAIMer** — *Train. Measure. Tune.*
**Release candidate:** `1.0.0-rc.10`
**Campaign:** trAIMer Game Profile Campaign, **Pass 2 of 5** — core public
game profiles. Pass 3 (the second game batch) has **not** been started.

**In one sentence:** Fortnite, Valorant, Counter-Strike 2, Apex Legends and
Call of Duty / Warzone now ship as versioned, sourced conversion profiles on
the architecture rc.9 introduced, each converting a player's current settings
to a physical sensitivity before any calibration and a calibration's
recommendation back into that game's own numbers — and each saying, in
writing, what it does not convert.

---

## 0. Baseline

| | |
| --- | --- |
| Repo | `https://github.com/happySNAG/Aldo-Aim-Lab.git` |
| Branch | `ox/aldo-aim-lab-20260823T194949Z-a28b6239` |
| **Starting HEAD** | `cad60de` — "Record the rc.9 build outcome in the Pass 15 report" |
| **Built HEAD** | `a8d0ef9` — "Freeze the RC identifier at 1.0.0-rc.10" (the commit CI built and verified); the report commit follows it (§1) |
| Unit tests at start | 1032 passing, 94 files |
| Unit tests at end | **1102 passing, 95 files** (was 1032 / 94) |
| Browser tests at end | **155 passing** (was 136) |

## 1. Commits

| Commit | |
| --- | --- |
| `d4cff4b` | Teach the profile schema the two zoom behaviours real games need |
| `8f097fd` | Add the first five public game profiles |
| `786bc35` | Show the five games in the picker and their numbers on the results screen |
| `394e34d` | Cut 1.0.0-rc.10 for Game Profile Campaign Pass 2 |
| `a8d0ef9` | Freeze the RC identifier at 1.0.0-rc.10 (the frozen-version test in `tests/pass5Engine.test.ts` still said rc.9; caught by the local re-run after the first push, so CI run 34177835281 on `394e34d` was cancelled and superseded) |
| `«REPORT»` | Add the Pass 16 report |

---

## 2. The canonical conversion model

Unchanged from Pass 1 and used by every profile below: a `CanonicalAim` is
degrees of view rotation per centimetre of mouse travel, per axis. Every
conversion goes `game A → canonical → game B`; there is no pairwise formula
anywhere, and `tests/gamePublicProfiles.test.ts` asserts that no profile file
names another game and that `src/games/convert.ts` names none.

```
deg/count(game)  = value × yawDegreesPerCountAtOne          (linear-yaw)
deg/cm           = deg/count × DPI / 2.54
cm/360           = 360 / deg/cm
```

DPI enters exactly once, at the boundary. Rounding to a game's grid happens
after the exact value is computed and is reported, never absorbed.

---

## 3. The five profiles

All five were researched against current (2025–2026) settings menus and the
technical references the sensitivity community treats as authoritative. No
publisher documents its own constant, so every `source.type` is
`community-reference` with `confidence: "high"`, `verifiedAtIso: 2026-09-07`,
and the open points written into `uncertaintyNotes` where the player can read
them. Only Counter-Strike 2 is `verified`; the others are `partially-verified`
and the app labels them so at the moment they are chosen.

### 3.1 Fortnite — `fortnite` v1

| | |
| --- | --- |
| Model | linear yaw, **0.005555° per count per 1%** |
| Hip-fire fields | X-axis sensitivity, Y-axis sensitivity — independent, absolute, 1.0–100.0% in 0.1% steps, one decimal |
| DPI | count-based; raw counts, Windows 6/11, no acceleration |
| FOV | none exposed by the game; modelled as `none` |
| Targeting (ADS) | **converted**: `multiplies-hipfire`, `valueScale: 100`. Fortnite keeps the hip-fire FOV for non-scoped weapons (DPI Wizard), so 100% is exactly hip-fire and every philosophy agrees; one philosophy offered |
| Scope | **not converted** — scoped weapons change FOV and the game rescales itself; current-season scope FOVs unverified |
| Worked example | 8% at 800 DPI = 25.7 cm/360 |
| Status | partially-verified |
| Source | mouse-sensitivity.com (DPI Wizard) targeting-FOV thread; the 0.005555 constant is the one every major converter uses |
| Open | Epic has not published the yaw; 0.1% step and the absence of finer config precision are assumed; Y assumed to share X's constant |

A symmetric physical recommendation converts to equal X and Y; an asymmetric
one converts exactly, because the axes are independent.

### 3.2 Valorant — `valorant` v1

| | |
| --- | --- |
| Model | linear yaw, **0.07° per count at 1.000** |
| Hip-fire field | Sensitivity: Aim, 0.001–10.000, three decimals, one value for both axes |
| FOV | **fixed 103° horizontal (16:9)** — modelled as fixed, no fake slider |
| ADS Sensitivity Multiplier | `fov-ratio-multiplier`; converted for the 1.25× tier (Vandal, Phantom, Bulldog); 1.15× and 1.5× share the setting |
| Scoped Sensitivity Multiplier | `fov-ratio-multiplier`; converted for the Operator's 2.5× first zoom; Marshal/Outlaw 3.5× and Operator 5× share it |
| Zoom FOV model | 103° ÷ zoom, horizontal; the game scales sensitivity by the **linear** angle ratio before the multiplier |
| Philosophies | same physical sensitivity (1.25 / 2.5), FOV-relative (**0.870 / 0.747**), 100% monitor distance, game default (1.000, the default) |
| Worked example | 0.400 at 800 DPI = 40.8 cm/360 |
| Status | partially-verified |
| Source | game-sens.jor.dev (community), cross-checked against mouse-sensitivity.com-derived values |
| Open | multiplier bounds assumed equal to the aim field's; Riot has published neither the yaw nor the zoomed FOVs |

The evidence for the zoom model: under it, FOV-relative matching gives
0.870439 for the rifles and 0.747462 for the Operator — the exact six-figure
values an independent reference publishes. The unit test asserts both to five
decimals.

### 3.3 Counter-Strike 2 — `counter-strike-2` v1

| | |
| --- | --- |
| Model | linear yaw, **0.022° per count** (`m_yaw`), `m_pitch` equal |
| Hip-fire field | Mouse sensitivity, 0.10–8.00 on screen (two decimals), **six decimals in the console / autoexec** — both reported |
| FOV | fixed **90°, horizontal at 4:3** (106.26° on 16:9) |
| Zoom | `zoom_sensitivity_ratio` ("Zoom Sensitivity Multiplier", 0.10–3.00, six decimals in console) as `fov-ratio-multiplier` for the **AWP first zoom, 40°**; AWP 10°, SSG 08 40°/15°, AUG/SG 553 45° share it within ~4% |
| Philosophies | same physical sensitivity (2.25), FOV-relative (**0.818933**), 100% monitor distance, game default (1.00, the default) |
| Worked example | 2.00 at 800 DPI = 26.0 cm/360 |
| Status | **verified** |
| Source | CS2 weapon-data reference (Steam Community guide) for zoom FOVs; Valve console variables |
| Open | settings-menu slider bounds vary between guides (the console is unbounded); whether the ratio still applies to the AUG/SG 553 first zoom |

The profile derives 0.818933 rather than storing it, and the test asserts the
ratio is formed on the game's 4:3 numbers (40/90), because forming it on the
16:9 horizontal angles gives a different, wrong answer.

### 3.4 Apex Legends — `apex-legends` v1

| | |
| --- | --- |
| Model | linear yaw, **0.022° per count at 1.0** (Source lineage) |
| Hip-fire field | Mouse sensitivity, 0.1–20.0 in 0.1 steps, six decimals in the settings file — both reported |
| FOV | configurable **70–110, horizontal at 4:3**, does not change hip-fire; no conversion reads it, so the picker shows no FOV input |
| ADS / per-optic | **not converted.** References disagree on the per-optic factors (the 4× optic is 0.55 in one and 0.36 in another; 6× is 0.40 vs 0.30) and on whether the scaling is focal-length or linear. A precise number here would be a guess |
| Worked example | 1.5 at 800 DPI = 34.6 cm/360 |
| Status | partially-verified |
| Source | Steam Community Apex discussion (records the conflicting factors); community converters for the yaw |
| Open | slider bounds and step from player reports; the whole ADS model |

### 3.5 Call of Duty / Warzone — `call-of-duty-warzone` v1

| | |
| --- | --- |
| Title/version | Warzone with the Black Ops 7 (2025–2026) shared settings menu |
| Model | linear yaw, **0.0066° per count at 1.00** |
| Hip-fire fields | Mouse Sensitivity 0.01–100.00 (two decimals) + **Vertical Sensitivity Multiplier** (0.10–5.00, `multiplier-of-horizontal`) |
| FOV | configurable **60–120, horizontal at the display aspect**; does not change hip-fire and is not read by the ADS conversion |
| ADS | **Relative mode** as `monitor-distance-coefficient` on the **vertical** axis. The layer translates the philosophy into the Monitor Distance Coefficient (0.00–2.00): FOV-relative → **0.00**; 100% horizontal monitor distance on 16:9 → **1.78**; game default → **1.33**. Multipliers left at 1.00, Custom Sensitivity Per Zoom off, so one number matches every optic |
| Not converted | Legacy ADS type; per-zoom multipliers; same-physical-sensitivity matching (cannot be a coefficient — refused, not approximated) |
| Worked example | 6.00 at 800 DPI = 28.9 cm/360 |
| Status | partially-verified |
| Source | mouse-sensitivity.com (DPI Wizard) on the coefficient: 1.33 = 133% vertical (100% horizontal on 4:3), 1.78 = 177.8% vertical (100% horizontal on 16:9) |
| Open | slider bounds from recent titles' menus; 0.0066 assumed unchanged in Black Ops 7; the horizontal→vertical translation assumes 16:9 |

This is the profile that would have been wrong as one scalar. It is not one:
the ADS answer is a mode plus a coefficient, and the export's entry lines say
so.

---

## 4. Architecture changes required

Two zoom behaviours were missing from the Pass 1 schema and both were needed
to model a real game honestly. Both are additive; `schemaVersion` stays 1 and
every Pass 1 profile and fixture validates unchanged.

| Addition | Why |
| --- | --- |
| `nativeBehavior: "fov-ratio-multiplier"` | Counter-Strike and Valorant scale scoped sensitivity by the **linear** angle ratio on their own FOV numbers. Pass 1 could express a plain multiplier or a focal-length multiplier, neither of which is what these engines do |
| `nativeBehavior: "monitor-distance-coefficient"` + `coefficientAxis` | Call of Duty applies monitor-distance matching itself and exposes the coefficient. Nothing in Pass 1 could express "the game does the arithmetic; here is the knob" |
| `ZoomLevelSpec.valueScale` | Fortnite shows a multiplier as a percentage |
| `ValueEntrySpec.allowZero`, `clampAdvice` | a coefficient of 0.00 is meaningful; "raise your DPI" is wrong advice for a clamped multiplier |
| `ConvertedZoom.achieved*` nullable | a coefficient gives every optic its own value |
| `GameRecommendationExport.exactVsEntered`, `current.hipfireDisplay` | requirement 11's exact-versus-entered pairs, built in the engine, rendered verbatim |
| `conversionUsesFov(profile)` | the picker asks for a FOV only when a conversion reads one |

A third behaviour (a fixed per-optic scale) was prototyped for Apex and
removed when Apex's optics turned out to be unverifiable: nothing ships
without a user.

---

## 5. Matching philosophies offered per game

| Game | Offered | Default | Refused |
| --- | --- | --- | --- |
| Fortnite | same physical sensitivity | same physical sensitivity | FOV-based (no FOV model) |
| Valorant | physical / FOV-relative / 100% monitor distance / game default | game default | — |
| Counter-Strike 2 | physical / FOV-relative / 100% monitor distance / game default | game default | — |
| Apex Legends | (no optics converted) | — | everything but hip-fire |
| Call of Duty | FOV-relative / 100% monitor distance / game default | game default | same physical sensitivity |

Defaults are the game's own relationship so that choosing a game never
changes a scoped feel unasked; the alternatives are one select away and
each is labelled in player language.

---

## 6. Rounding and slider behaviour

| Game | Field | Grid | What the player sees |
| --- | --- | --- | --- |
| Fortnite | X / Y / targeting | 0.1% steps, 1.0–100.0% | "Exact equivalent 6.859%; this game accepts steps of 0.1%, so enter 6.9%" |
| Valorant | aim, multipliers | 3 decimals | exact vs 3-decimal entry |
| Counter-Strike 2 | sensitivity, zoom ratio | 2 decimals on screen, 6 in console | exact, entry, **and** the console value |
| Apex | sensitivity | 0.1 steps, 6 decimals in settings file | e.g. 2.040 exact → 2.0 slider → 2.04 file |
| Call of Duty | sensitivity, vertical multiplier, coefficient | 2 decimals; coefficient 0.01 steps | exact vs entry; clamps explained without DPI advice |

The results card renders an "Exact versus what the game accepts" block for
every value the grid or range moved. Nothing is hidden.

---

## 7. Cross-profile equivalence tests

`tests/gamePublicProfiles.test.ts`:

- Fortnite → canonical → Valorant, Valorant → CS2, CS2 → Apex, Apex →
  Warzone, at 400/800/1600 DPI: the requested physical sensitivity is
  preserved and reading the target's rounded values back lands inside the
  target's own round-trip tolerance.
- The chain Fortnite → Valorant → CS2 → Apex → Warzone → Generic → Fortnite
  returns to its start within 3% (Apex's 0.1 slider is the coarsest link).
- The community ratios fall out of the constants: CS 1.0 ≈ Valorant 0.314 ≈
  Fortnite 3.96% ≈ Apex 1.0 ≈ Call of Duty 3.33.
- No profile imports another; the converter contains no game name.

---

## 8. Tests added

| File | What |
| --- | --- |
| `tests/gamePublicProfiles.test.ts` (new, 64 tests) | per game: known value → canonical, canonical → value, round-trip matrix, min/max, rounding and step, X/Y, ADS/scope per philosophy, FOV, version/source metadata, malformed rejection; cross-profile equivalence; picker order |
| `tests/gameProfileSchema.test.ts` (+6) | the new validator rules through the `fixture-engine-scaled` fixture |
| `tests/browser/gameProfilesPublic.spec.ts` (new, 19 tests) | each game's fields, physical equivalent before calibration, per-game recommendation rendering, exact vs entered, unsupported fields absent, provenance, matching switch, and a full session whose History record keeps `valorant v1` after switching to Counter-Strike 2 |
| `tests/browser/gameProfile.spec.ts` (updated) | six options in order, no fixture, Generic / Raw |
| existing suites | registry/boundary/bridge expectations updated for six profiles |

## 9. Full suite

| Suite | Result |
| --- | --- |
| lint | clean |
| typecheck (engine + desktop) | clean |
| unit (`vitest run`) | **1102 passed, 95 files** |
| browser (`playwright test`) | **155 passed** (10.3 min, one worker) |
| Electron: arena entry (dev tree) | all checks passed |
| Electron: candidate gain (dev tree) | gains 0.8696 / 1.0000, spread 1.15× — passed |
| Electron: smoke (`--smoke-test`) | pass, `appVersion 1.0.0-rc.10` |
| `verify-release`, `verify-windows-artifacts --frontend` | passed |
| branding gate (sources, docs, bundle) | PASS — 13 documented legacy survivals, unchanged |
| no-telemetry audit (sources + bundle) | CLEAN; the bundle's five allowed URLs are exactly the five profile sources |

No gate was weakened. The measurement core did not change: `git diff
cad60de..HEAD -- src/optimizer src/analysis src/capture src/sensmath` is
empty, and the boundary test still forbids the game layer from every
measurement module.

## 10. Windows CI and installer

CI run **34177974034** on commit `a8d0ef9` — **all five jobs green**
(`engine`, `browser`, `native-windows`, `windows-release`,
`windows-installer`), 01:50–02:03 UTC on 2026-09-08.
<https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34177974034>

| Gate | Job | Result |
| --- | --- | --- |
| game profiles fail closed and stay out of the measurement core (schema, registry, boundary, round-trip, integration) | engine | passed |
| arena candidate gain + gain history validity | engine | passed |
| browser suite incl. `gameProfile.spec.ts` and `gameProfilesPublic.spec.ts` | browser | passed |
| two blinded candidates differ in the REAL arena | browser | passed |
| helper is a genuine x64 PE and executes (`helper-1.1.0 protocol=1 arch=x64`) | native-windows / windows-installer | passed |
| no-telemetry audit on the Windows-built bundle | windows-installer | CLEAN — the five allowed URLs are exactly the five profile sources, which is how the shipped bundle is known to carry all five profiles |
| branding: sources, bundle, installer, installed layout | windows-installer | PASS — no legacy name anywhere; installed executable is `trAIMer.exe` |
| silent install → complete application | windows-installer | passed |
| installed app starts and shuts down cleanly (`helperState: ready`, `appVersion: 1.0.0-rc.10`) | windows-installer | passed |
| **the INSTALLED app can start a test** | windows-installer | arena click resolved in 193 ms — all checks passed |
| **the INSTALLED app changes sensitivity between candidates** | windows-installer | gains observed 0.8696 / 1.0000, spread 1.15× — all checks passed |

```
candidate-gain gate: installed app at C:\traimer-install-test\trAIMer.exe
  ok   two blinded candidates move the crosshair by different amounts — gains observed: 0.8696, 1
  ok   the difference is at least one ladder step — spread 1.1500x
  ok   the arena has NOT reverted to 1 px/count regardless of candidate — gains observed: 0.8696, 1
```

History migration and the marking of pre-rc.9 sessions as invalid are
covered by the engine job's release gates (`userDataMigration`,
`arenaGainHistoryValidity`), which ran unchanged and passed.

What CI does **not** do yet: drive the game picker inside the installed
Windows application. Profile presence and selection were proven in the real
Chromium app (155 browser tests, including a full session recorded with
`valorant v1` in History) and in the Electron dev-tree gates; the installed
app is proven to contain the same bundle by the no-telemetry audit above.
A picker-driving gate on the installed app is a candidate for Pass 3.

**Artifact**, downloaded from the run and checksum-verified against the value
CI published:

| | |
| --- | --- |
| `release/rc10/trAIMer-Setup-1.0.0-rc.10.exe` | 100,548,519 bytes |
| `release/rc10/trAIMer-Setup.exe` | identical copy |
| SHA-256 | `d74bf8e69596cfd8460d5292dd4375a390a9063e70a551fd41b8948e5daa5b8f` |

`/Volumes/NO NAME` was **not mounted** at any point during this pass
(checked at the start, before the build, and after the download). The
installer is staged locally under `release/rc10/`; the flash drive is
**not** prepared. Copying it is one command once the drive is present:

```
cp release/rc10/trAIMer-Setup-1.0.0-rc.10.exe release/rc10/trAIMer-Setup.exe "/Volumes/NO NAME/" && shasum -a 256 "/Volumes/NO NAME/"trAIMer-Setup*.exe
```

## 11. Uncertainty remaining, per profile

- **Fortnite** — yaw constant community-measured (last digit); 0.1% step and
  no finer config precision assumed; scope not converted.
- **Valorant** — multiplier field bounds assumed; zoomed FOVs community-derived
  (validated to 0.005% against published multipliers).
- **Counter-Strike 2** — settings-menu slider bounds; AUG/SG 553 zoom-ratio
  applicability. Console values are exact.
- **Apex Legends** — the ADS model entirely; slider bounds/step from reports.
- **Call of Duty / Warzone** — slider bounds; vertical multiplier bounds;
  yaw assumed unchanged in Black Ops 7; Legacy mode unmodelled; 16:9 assumed
  for the horizontal→vertical coefficient translation.

Every item above is in the profile's `uncertaintyNotes` or
`knownEdgeCases`, rendered under "What this profile does not cover".

## 12. Pass 3

Not started. No second-batch game exists in the tree.

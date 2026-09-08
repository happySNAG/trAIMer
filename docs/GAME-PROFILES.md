# Game profiles and sensitivity conversion

**Status: Game Profile Campaign, Pass 1 of 5 — architecture.**
One public profile ships (the generic/raw control). The named-game set arrives
in later passes.

trAIMer measures a player's physical aim. A *game profile* is the translation
layer that turns that measurement into the number a specific FPS accepts. This
document is the architecture, the contract for adding a profile, and the list
of things a profile is not allowed to do.

---

## 1. The separation that everything else depends on

| Physical / input domain | Game domain |
| --- | --- |
| mouse DPI | game sensitivity scale |
| physical mouse movement | horizontal / vertical values |
| measured degrees per count | ADS and scope multipliers |
| flick and tracking performance | FOV model and limits |
| recommendation evidence | slider granularity and rounding |
| `src/**` outside `src/games/**` | `src/games/**` |

The measurement engine never imports a game profile. `tests/gameProfileBoundary.test.ts`
enforces this statically across `src/analysis`, `src/calibration`, `src/campaigns`,
`src/capture`, `src/confidence`, `src/diagnostics`, `src/domain`, `src/experiments`,
`src/metrics`, `src/optimizer`, `src/results`, `src/scenarios`, `src/sensmath`,
`src/sim` and `src/validation`.

Two modules do know that a game record exists, and only as a record:

- `src/session/humanSession.ts` carries an OPTIONAL `gameConversion` field on
  the persisted session, imported **type-only** so nothing from the game layer
  exists at runtime there;
- `src/history/api.ts` reads that field back.

Neither feeds a measurement.

---

## 2. The canonical representation

Every conversion goes

```
game A settings ──▶ CanonicalAim ──▶ game B settings
```

and never game A → game B. There are no pairwise formulas in this tree.

`CanonicalAim` (`src/games/canonical.ts`) stores, per axis, **degrees of view
rotation per centimetre of physical mouse travel**.

### Why deg/cm

- **It is physical.** Aiming equivalence between two games means the same hand
  movement produces the same rotation — exactly deg/cm. Counts-based units
  (deg/count, rad/count, yaw-per-count, eDPI) change value when the player
  changes DPI without changing anything their hand does.
- **It is DPI-free.** A DPI change re-expresses the canonical value instead of
  altering it, which is what Pass 1 requirement 4 asks for. DPI enters exactly
  once, at the boundary, in `degreesPerCountAt()`.
- **It is linear in game sensitivity.** For every model this layer supports,
  deg/cm is monotone increasing in the slider and, for linear models,
  proportional to it. A 1 % error in a slider is a 1 % error in deg/cm, so a
  tolerance expressed as a fraction means the same thing on both sides of a
  conversion. cm/360 is *inversely* proportional, which inverts and distorts
  every tolerance and is singular as sensitivity approaches zero.
- **It is reversible.** Both directions are closed form. The only loss is the
  game's own slider granularity, which the rounding model reports rather than
  absorbs.

**cm/360 remains the player-facing number** — `cmPer360X/Y()` derive it. It is
a presentation of the canonical value, not the storage form.

### Reaching the canonical value

`src/games/measurement.ts` implements the only two honest routes:

1. **Calibrated** — `canonicalFromCalibration()` converts a measured
   degrees-per-count constant directly. No assumptions.
2. **Relative to the player's own baseline** — trAIMer's search reports its
   recommendation in the same units as the baseline the player entered, so the
   ratio between them is a pure multiplicative change in physical sensitivity.
   Applied to a canonical aim derived from the player's current in-game
   settings (`canonicalFromGameSettings()`), that gives the recommended
   physical aim with **no calibration at all**.

Route 2 needs an ANCHOR: some setting the player is on today. With neither an
anchor nor a calibration, the app says so rather than producing a number.

---

## 3. The profile schema

`src/games/profileSchema.ts`. Two versions, and they mean different things:

| Field | Meaning | Bumping it means |
| --- | --- | --- |
| `schemaVersion` | shape of the profile types | old profile objects need migrating |
| `profileVersion` | the conversion DEFINITION for that game | values produced under the old definition may no longer be right |

A profile declares:

- identity — `id` (stable, lower-kebab-case, never reused), `displayName`,
  `publisher`, `gameFamily`, `platforms`;
- `status` — `verified` / `partially-verified` / `experimental` / `deprecated`;
- `visibility` — `public` or `fixture`;
- `sensitivityModel` — `linear-yaw` or `power-law-yaw`, both invertible in
  closed form;
- `hipfireField` and `axes` — the X/Y model (§5);
- `dpi` — count-based, raw-input and pointer-speed assumptions;
- `fov` — `none` / `fixed` / `configurable`, with the axis the game's number
  actually names (§7);
- `zoom` — `none` / `single-scalar` / `per-zoom` (§6);
- `defaultMatching` and `supportedMatching` (§6);
- `unitDefinition` — one sentence saying what 1.00 means, in player language;
- `knownEdgeCases`, `warnings`;
- `source` — provenance (§9);
- `supersededByProfileId`, `deprecationNote` for deprecation (§10).

### Value entry and rounding

`ValueEntrySpec` (`src/games/rounding.ts`) describes how a game accepts one
number: `min`, `max`, `step` (null for continuous), `stepOrigin`, `uiDecimals`,
`configDecimals` (when a config file accepts more than the settings screen),
`rounding` and `unitSuffix`.

`quantize()` snaps to the step grid FIRST and clamps to the range SECOND, then
steps back inwards, so a clamped value is still ON the grid. It returns the
exact value, the enterable value, the config value, the signed relative error,
and player-facing sentences:

```
Exact equivalent 6.347%; this game accepts steps of 0.1%,
so enter 6.3% (-0.74% below exact).
```

**Rounding loss is never hidden.** The results view renders these notes above
the details block, and `tests/gameRecommendationBridge.test.ts` asserts it.

---

## 4. DPI

`changeDpi()` answers "same feel at a different DPI". Because the canonical
value is DPI-free, cm/360 is invariant by construction and only the game-facing
number moves. `unreachableAtNewDpi` is true when the new DPI puts the value off
the game's slider, and the note says which way to move the DPI.

No default DPI is hardcoded anywhere in the conversion path; 800 appears only
as the app's initial settings value.

---

## 5. The X/Y model

Four shapes are representable, none assumed:

| Shape | `independentAxes` | `verticalSemantics` | `builtInVerticalRatio` |
| --- | --- | --- | --- |
| one scalar | false | `none` | null |
| one scalar, engine pitch ratio | false | `none` | e.g. 0.75 |
| two absolute values | true | `absolute` | null |
| value + vertical multiplier | true | `multiplier-of-horizontal` | null |

A game's fixed pitch:yaw relationship has exactly one home. Declaring it both
as a pitch constant in the sensitivity model and as `builtInVerticalRatio`
would apply it twice, and the validator rejects that.

When the engine's recommendation is symmetric, the conversion is symmetric.
When a single-slider game cannot express the requested vertical, the conversion
says so in words rather than pretending:

> *Fixture — linked axes, stepped slider exposes a single sensitivity, so
> vertical cannot be set independently. Its vertical works out at 40.3 cm/360
> rather than the requested 30.0 cm/360.*

---

## 6. ADS, scopes, and matching philosophies

A zoom level (`ZoomLevelSpec`) is hip-fire, ADS, or one optic. It carries a
magnification, an FOV model, the setting the player changes, the value that
produces the game's stock behaviour, and how the game applies that setting:

| `nativeBehavior` | Meaning |
| --- | --- |
| `hipfire` | the hip-fire view itself; no multiplier |
| `multiplies-hipfire` | `deg/count(zoom) = deg/count(hip) × value` |
| `fov-relative-multiplier` | the game already applies FOV scaling, so its neutral value means "matched to what you see" |
| `independent-scalar` | the optic carries its own absolute sensitivity |

**There is no single correct scoped sensitivity.** The profile layer represents
the choice explicitly (`src/games/matching.ts`):

| Philosophy | What it preserves |
| --- | --- |
| `physical-360-distance` | the same hand movement turns the view the same amount at every zoom |
| `monitor-distance`, coefficient `c` | the same hand movement sweeps the same fraction of the screen; `c = 1` is the screen edge |
| FOV-relative (`monitor-distance`, `c = 0`) | a target visible in both views takes the same hand movement |
| `game-native` | the developers' own relationship |

For half-angles θ_h (hip) and θ_z (zoomed) on the matched axis:

```
ratio(c) = atan(c · tan θ_z) / atan(c · tan θ_h)     for c > 0
ratio(0) = tan θ_z / tan θ_h                          (the limit, FOV-relative)
```

A profile must declare which philosophies it can express, and a request for one
it cannot is refused rather than approximated.

---

## 7. Field of view

Games disagree about what "FOV: 90" means. `FovAxis` is part of the model —
`horizontal`, `horizontal-at-4-3`, `horizontal-at-16-9`, `vertical` — and every
internal calculation runs on a normalized horizontal/vertical pair for the
display aspect ratio in use. A 4:3-quoted horizontal number is taken to its
vertical angle at 4:3 (the angle the engine preserves) and then widened, which
is what hor+ rendering actually does.

`{ kind: "none" }` means the profile models no FOV. A matching philosophy that
needs one then **throws instead of inventing an equivalence**, and the
conversion records the reason as a warning against that optic.

---

## 8. The registry

`src/games/registry.ts`. One place resolves an id to a profile — there is no
switch statement on a game name anywhere in the app.

It fails closed. Duplicate ids, foreign schema versions, validation errors, and
a deprecated profile naming a successor that does not exist all refuse the
whole load. `GAME_PROFILE_REGISTRY` is built at module load, so a malformed
profile is a startup failure and a red test rather than a wrong number on a
player's screen.

`selectable()` is what a player may pick: public, not deprecated. Fixtures can
never reach it.

---

## 9. Provenance

Game sensitivity behaviour changes between patches. Every public profile
carries `ProfileSource`: title, type, URL (optional), publisher, the game build
or season the numbers were checked against, `verifiedAtIso`, `lastReviewedAtIso`,
a confidence level, and explicit uncertainty notes.

The validator refuses:

- a public, verified profile with no `gameVersion` — unless its source type is
  `unit-definition`, which is exact by construction and has no game build;
- `status: "verified"` alongside `confidence: "low"`;
- a review date earlier than its verification date.

### Provenance URLs and the no-telemetry audit

trAIMer makes no network requests. A profile's `source.url` is displayed text.
`scripts/audit-no-telemetry.mjs` therefore allows a URL literal in the shipped
bundle **only when the identical string appears as a `url:` field under
`src/games/profiles/`**; the allowlist is derived from the profile sources, not
hand-written, and is printed on every run. This pass declares none, so the
bundle rule is byte-for-byte as strict as it was before the exception existed.

---

## 10. Versioning, deprecation, and saved history

A saved selection is `{ profileId, profileVersion }` — never a display name.

`GameProfileRegistry.checkSelection()` reports, and never silently applies:

| Status | Meaning |
| --- | --- |
| `ok` | made under the current definition |
| `profile-updated` | saved under an older definition; values are left as they were |
| `profile-newer-than-build` | saved under a definition this build does not know |
| `profile-deprecated` | superseded; names the replacement |
| `unknown-profile` | not in this build; kept so history stays readable |

A completed session records a `SessionGameConversionRecord` alongside its
result: profile id and version, status, DPI, current and recommended values,
the exact pre-rounding value, the canonical aim, cm/360, the conversion method,
and the rounding fraction that was applied. Sessions written before game
profiles existed simply do not have the field, and readers treat absence as "no
game profile", never as an error. Nothing already written is ever rewritten.

---

## 11. The safety boundary

Game profiles are informational conversion layers. trAIMer does not inject into
games, read process memory, modify game files, bypass anti-cheat, hook game
input, edit protected configuration, or simulate input into another
application. The player changes the values themselves; trAIMer says exactly
what to set.

`tests/gameProfileBoundary.test.ts` statically forbids child processes,
filesystem access, process-memory APIs, input injection, window/process hooking,
network APIs and shell invocation across `src/games/**`,
`app/src/gameProfileView.ts` and `app/src/gameConversionBridge.ts` — and asserts
that no public profile ships a game file path to edit.

---

## 12. Adding a profile (Pass 2 and later)

1. Create `src/games/profiles/<game>.ts` exporting one `GameProfile`.
2. Add it to `PUBLIC_GAME_PROFILES` in `src/games/profiles/index.ts`.
3. Fill in `source` completely — including the build or season the constants
   were verified against.
4. Set `status` honestly. `partially-verified` and `experimental` are shown to
   players with the gap stated; `verified` is a claim the validator enforces.
5. Add a round-trip case to `tests/gameRoundTrip.test.ts` and any game-specific
   edge cases to `tests/gameConversion.test.ts`.
6. If the profile cites a URL, expect it in the no-telemetry audit's printed
   allowlist and check that it is the one you meant.

That is the whole procedure. No conversion code changes, and no existing
game's arithmetic can move.

### Bumping a profile

Increment `profileVersion` whenever the conversion DEFINITION changes — a new
constant, a corrected FOV, a different native behaviour. Do not increment it
for a wording change. Players with saved values under the old version are told
the definition changed; their stored numbers are not reinterpreted.

To retire one: set `status: "deprecated"`, write a `deprecationNote` saying
what changed, and point `supersededByProfileId` at the replacement, which must
exist in the same registry.

---

## 13. Architecture fixtures

`src/games/fixtures.ts` holds synthetic profiles that are not games. They exist
so every branch of the schema is exercised by tests: linked and independent
axes, stepped and continuous entry, a built-in vertical ratio, a vertical
multiplier, a single ADS scalar, per-optic multipliers with mixed native
behaviours, a configurable FOV, a config file finer than the settings screen, a
power-law scale, and a deprecated profile with a successor.

They carry `visibility: "fixture"`, are never in `PUBLIC_GAME_PROFILES`, and a
test asserts no shipped view imports them.

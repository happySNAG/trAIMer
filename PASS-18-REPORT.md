# Pass 18 — every game profile put back on trial

**Product:** **trAIMer** — *Train. Measure. Tune.*
**Release candidate:** `1.0.0-rc.12`
**Campaign:** trAIMer Game Profile Campaign, **Pass 4 of 5** — independent
formula/source validation and profile hardening. Pass 5 (final public-release
hardening) has **not** been started.

**In one sentence:** no games were added; instead all twelve public profiles
were re-researched from scratch and treated as untrusted, which confirmed
eight base constants against a published source that names no game internals,
dissolved two "disputes" that were never disputes, corrected one real
conversion defect in Battlefield 6, and left PUBG experimental because the
attempt to confirm it failed.

---

## 0. Baseline

| | |
| --- | --- |
| Repo | `https://github.com/happySNAG/Aldo-Aim-Lab.git` |
| Branch | `ox/aldo-aim-lab-20260823T194949Z-a28b6239` |
| **Starting HEAD** | `949b21a` — "Add the Pass 17 report" |
| Unit tests at start | 1160 passing, 96 files |
| Unit tests at end | **1230 passing, 98 files** |

---

## 1. The method, and why it counts as independent

Pass 3 leaned on `game-sens.jor.dev` and `aimbench.com`, cross-checked
against published professional settings. Re-reading those same pages would
have confirmed nothing, so Pass 4 needed a source that was both technical and
in a different family.

It found one, and more usefully found a way to use it that does not require
trusting it. A long-standing sensitivity reference publishes, per game, the
in-game sensitivity range that puts a player at 800 DPI inside a stated band
of **20 to 80 cm per 360° turn**. That is a claim about centimetres, not
about any game's internals, and it inverts straight into a base constant:

```
yaw = 360 × 2.54 / (20 × 800 × sens_at_20cm)
```

**The method was calibrated before it was used.** Applied to games whose
constants are independently known — Valorant's 0.07, Counter-Strike's and
Apex's 0.022, Call of Duty's 0.0066 — it reproduces each one to the precision
the reference prints. Only then was it turned on the game it was needed for.

| Game | Published range at 800 DPI | Implied constant | Profile's constant | |
| --- | --- | --- | --- | --- |
| Valorant | 0.204 – 0.816 | 0.070000 | 0.07 | ✅ |
| Apex Legends | 0.65 – 2.6 | 0.021981 | 0.022 | ✅ |
| Counter-Strike 2 | *(engine cvar)* | 0.022 | 0.022 | ✅ |
| Fortnite | 2.6 – 10.3 | 0.005495 – 0.005549 | 0.005555 | ✅ |
| Marvel Rivals | 0.82 – 3.27 | 0.017424 – 0.017477 | 0.017453 (π/180) | ✅ |
| Overwatch 2 | 2.16 – 8.66 | 0.0065993 | 0.0066 | ✅ |
| Call of Duty (BO6/7) | 2.16 – 8.66 | 0.0065993 | 0.0066 | ✅ |
| Rainbow Six Siege | 2 – 10 | ≈0.005715 (fast end 9.975 → "10") | 0.00572958 | ✅ |
| The Finals | 14 – 57 | 0.0010026 – 0.0010205 | 0.001 | ✅ |
| PUBG | 23 – 53 | **does not decide** — see §4 | 0.00222 | ⚠️ |
| Battlefield 6 | not published | — | 0.0025079 | ⚠️ |

Eight of the twelve constants now have confirmation from a source family the
profiles did not previously depend on. `tests/gameSourceGolden.test.ts` runs
this table as golden cases whose expected values name none of our constants.

### Source hierarchy actually used

1. **Official documentation** — Ubisoft's *Guide to ADS Sensitivity in Y5S3*
   (Siege's ADS model and its neutral 50); Valve's `m_yaw` default.
2. **First-party configuration behaviour** — Battlefield 6's `GstInput.*`
   keys and their menu-to-config scale.
3. **Reproducible technical references** — the published cm/360 band above;
   the independently published CS2 and Valorant zoom formulas.
4. **Community references** — the converters Pass 3 used.
5. **Pro-settings tables** — corroboration only, never formula authority.

---

## 2. The one real defect: Battlefield 6's stock ADS coefficient

Pass 3 recorded Battlefield 6's stock Uniform Soldier Aiming coefficient as
**177.7%**. It is **133.3%**.

177.7% is 16/9 — the value that matches 100% of the screen *width* on a 16:9
display, which is precisely what the "100% monitor distance" philosophy
already computes from the player's aspect ratio. Recording it as the game's
default made two genuinely different choices produce one number:

| Philosophy | Before (rc.11) | After (rc.12) |
| --- | --- | --- |
| Match what you see (FOV-relative) | 0.0% | 0.0% |
| Match 100% monitor distance | 177.8% | 177.8% |
| **The game's own default** | **177.8%** ❌ | **133.3%** ✅ |

The correction is evidenced twice over: the community guide the profile
already cites lists 133.3% as a real coefficient value, and a technical author
writing specifically about this setting says in as many words that *"a common
misconception is that you should use the default value of 133, but that is not
the case for 16:9 screens"* — which only parses if 133 is the default. 133.3
is also the Battlefield-series default going back to the introduction of
Uniform Soldier Aiming.

The published per-aspect-ratio table (4:3 → 133.3%, 16:9 → 177.7%,
21:9 → 233.3%, 32:9 → 355.5%) is exactly the list of aspect ratios, which
independently confirms the *semantics* the profile declares: the coefficient
names the fraction of the **vertical** half-screen matched. The engine is
never given that table; a new golden test makes it compute all four.

---

## 3. Two "disputes" that were never disputes

### 3.1 Rainbow Six Siege's 0.00223 — a category error, retired

Pass 3 recorded 0.00223 as a rival yaw constant from older references and
rejected it for being 2.57× off. **It was never a yaw constant.** It is a
value players write into `MouseSensitivityMultiplierUnit` — the configuration
knob that scales the whole 1–100 slider — to get finer control than whole
numbers allow. At 0.00223 a sensitivity of 50 behaves like 0.1165 on the
stock 0.02 scale. The two numbers were never candidates for the same quantity,
so there was nothing to adjudicate, and the profile no longer claims there was.

Pass 4 also found *why* 0.00572958 is the right number rather than merely the
popular one: it is **1e-4 radians expressed in degrees**. The engine turns
0.005 rad per count per unit of `sensitivity × MouseSensitivityMultiplierUnit`,
and at the stock 0.02 that is exactly 1e-4 rad. A round engine constant, not a
fitted one. A test now asserts the identity.

### 3.2 Overwatch 2's 37.89 vs 49.46 — two ratios of one FOV

Both circulate as "1:1 scoped" for Widowmaker and Ana, and a Blizzard-forum
thread argues for 49.46 over 37.89. They are not rival measurements. From the
same 50.94° scoped FOV against a 103° hip-fire FOV:

- **37.8892%** — ratio of the *tangents* of the half-angles. FOV-relative /
  focal-length / 0% monitor distance. What a flick to a target visible in both
  views needs.
- **49.4563%** — ratio of the *angles*. Corresponds to no matching
  philosophy; it is the classic linear-versus-tangent slip.

The engine derives 37.89 and 51.47 (Ashe, 65.81°) from the FOVs, reproducing
both published values to two decimals, and a golden test asserts it produces
37.89 **and never 49.46**. This is exactly what the matching-philosophy labels
exist for, and the disagreement is now explained in the profile rather than
hidden.

---

## 4. PUBG: the pass that failed, honestly

PUBG was flagged high-risk and it earned it.

- **The constant survived.** A second source family states 0.002222 outright,
  matching the profile's 0.00222. The "0.022" family is out by a factor of
  ten; one of its calculators publishes *"sens 50 at 800 DPI ≈ 1.0 cm/360"* as
  a worked example, which is a three-centimetre full turn and is
  self-evidently wrong. That family is treated as misinformation, not as a
  competing view.
- **Linearity did not.** The band method that settled six other games does not
  decide here: the reference prints **23–53**, a span of 2.3×, where a
  20–80 cm/360 band on a linear scale must span exactly **4×**. Either it
  models a curve, or it quotes a PUBG-specific band — its numbers do bracket
  the published professional settings, which is the innocent reading — and the
  two cannot be told apart from outside the game.

So the profile stays **experimental** and says why. Promoting it on evidence
that does not decide would have been the wrong outcome; so would deleting a
constant that two independent families agree on.

One data correction fell out: **PUBG's FOV default is 90, not 80.** 80 is the
slider's floor, and separately the FOV the constant is stated at. Pass 3 had
recorded 80 for both, so a player who never touched the FOV slider and never
typed one would have been converted at a field of view they do not play.

---

## 5. Fail-closed: a FOV that multiplies the answer is not optional

For a profile whose hip-fire rotation scales with the FOV setting — only PUBG
— the field of view is not a decoration on the answer, it is a **multiplier on
it**. A conversion run without one is a conversion at a field of view the
player never stated.

`gameSettingsFromCanonical` now says so:

> No field of view was given, so this conversion assumes 90°. Because PUBG:
> Battlegrounds scales hip-fire with the field of view, playing at a different
> one makes every value here wrong in the same proportion — enter your actual
> FOV.

A test asserts that exactly one profile raises it, and that stating the FOV
removes it.

---

## 6. FOV-convention hardening

The validator checked that a FOV axis was a *known* axis. It did not check
that a zoom's FOV used the *same* convention as the hip-fire FOV it is
compared against — and every comparison the layer makes (tangent ratio,
linear angle ratio, scale factor) is meaningless if they differ. A
`vertical 30` scope under a `horizontal-at-4-3 90` hip-fire would have
resolved to a real angle and produced a plausible wrong answer.

It is now a validation **error**. All twelve profiles already complied;
`scaled-from-hipfire` (which inherits the axis by construction) remains the
way to express a zoom FOV without restating it. A test builds a deliberately
mixed profile and asserts the validator rejects it.

Two FOV data corrections also came out of this audit:

- **The Finals** — the slider is a **vertical** 45–100 defaulting to 71. Pass
  3 recorded a horizontal "roughly 71–100", wrong on both the axis and the
  floor. Nothing reads it, so no conversion moved.
- **Battlefield 6** — references conflict (85–120 vs up to 122) and the
  guide's own author describes the same setting as both horizontal and
  vertical. Recorded as unresolved; unused by any converted value.

---

## 7. Per-profile outcome

| Profile | Status before | Status after | Confidence | What changed |
| --- | --- | --- | --- | --- |
| Generic / Raw | verified | **verified** | exact | Documentation overstatement corrected (§8) |
| Fortnite | partially-verified | **partially-verified** | high | Constant confirmed; FOV sliders noted; scope still refused |
| Valorant | partially-verified | **partially-verified** | high | Constant confirmed exactly; zoom formula shown equivalent to a published one |
| Counter-Strike 2 | verified | **verified** | high | Zoom formula independently confirmed; 0.818933027 reproduced to 9 s.f. |
| Apex Legends | partially-verified | **partially-verified** | high | Constant confirmed; ADS conflict corroborated, refusal preserved |
| Call of Duty / Warzone | partially-verified | **partially-verified** | high | Constant confirmed for the BO6/7 family; 1.33 default confirmed |
| Overwatch 2 | partially-verified | **partially-verified** | high | Constant confirmed; scoped FOV corroborated; 37.89/49.46 explained |
| Rainbow Six Siege | partially-verified | **partially-verified** | high | Constant confirmed *and derived*; 0.00223 dispute retired |
| Marvel Rivals | partially-verified | **partially-verified** | moderate → **high** | Three rival constants excluded arithmetically |
| PUBG | experimental | **experimental** | low | Constant corroborated; linearity still open; FOV default corrected |
| The Finals | partially-verified | **partially-verified** | moderate | Constant confirmed; FOV axis and range corrected |
| Battlefield 6 | experimental | **experimental** | moderate | **Stock ADS coefficient corrected**; competing 0.0022 recorded |

**No profile was downgraded.** One confidence level was raised. Every
"verified" status was re-examined and re-justified rather than assumed:
Counter-Strike 2 keeps its because every value it actually converts traces to
documented engine behaviour, and Generic / Raw keeps its because its unit is a
definition.

### Refusals preserved (nothing was invented to fill a gap)

- **Apex Legends** — per-optic ADS. A third reference was found, quoting the
  lower family (4× 0.36, 6× 0.30) against the other's 0.55 / 0.40. The
  conflict is corroborated, not resolved. No value is offered.
- **Fortnite** — scope sensitivity. Scope FOVs are still unpublished; guides
  offer only heuristics ("base × 0.6–0.75"). No value is offered.
- **Marvel Rivals** — Black Widow and The Punisher scopes, FOVs unpublished.
- **PUBG** — Targeting, ADS, per-scope sliders, vertical multiplier.
- **The Finals** — everything but the game's own zoom relationship.

---

## 8. The control profile

Generic / Raw is the reference, so its own claims were audited too, and one
was wrong: its documentation said a round trip through it was *"limited only
by float precision"*. Its four-decimal grid is finer than any real game's here
but it is not infinite — 0.1786 is the closest this scale gets to an 80 cm/360
turn at 3200 DPI.

The profile itself was never wrong; its rounding model reported the difference
correctly the whole time. The prose has been corrected, and two tests now
separate the properties that were being conflated:

- the **inverse is exactly the inverse**, unconditionally, at every value;
- the **grid** is exact wherever it can express the value, and reports its
  error where it cannot.

---

## 9. Tests added

| File | What it does |
| --- | --- |
| `tests/gameSourceGolden.test.ts` (32 tests) | Golden cases whose expected values were published elsewhere: the eight-game cm/360 band; CS2's 0.818933027; Valorant's 0.870439 / 0.747462; Overwatch's 37.89 / 51.47 *and the explicit absence of 49.46*; Ubisoft's neutral 50 at all eight optics; Siege's 1e-4 rad identity; Battlefield's four-aspect-ratio coefficient table; Call of Duty's 1.33 / 1.78; fail-closed behaviour; FOV-convention hardening; currentness; and a **full cross-profile equivalence audit** |
| `tests/gameRoundingHardening.test.ts` (38 tests) | Every numeric field of every public profile — hip-fire, vertical and every zoom setting — swept through boundaries, half-steps, out-of-range and tie-breaking values |

### Cross-profile equivalence audit (requirement 25)

`A → canonical → B → canonical` for **every ordered pair** of the twelve public
profiles, at six cm/360 values (15, 20, 27.5, 34.6, 50, 80) and four DPIs
(400, 800, 1600, 3200) — 3,456 conversions, each held to profile B's own
declared tolerance, skipping only pairs where A's slider physically cannot
express the aim. **Zero failures.**

### The rounding sweep's central assertion

The Pass 3 defect produced values the game would have rejected. So the first
thing the sweep asserts, for every field of every profile at every probe
value, is `isEnterableValue(spec, quantized.ui)` — whatever is printed must be
a number the game will actually accept. Then: clamping is reported for the
*exact* value rather than for where the grid landed; inside the range nothing
moves by more than half a step; anything that cost precision is said out loud;
and the reported relative error is the error actually made.

It found one thing worth stating: **Battlefield 6's stock coefficient is not
typeable in its own menu.** The config value is 1.333333 and the menu moves in
tenths of a percent, so 133.3% is as close as a player can get. That is a fact
about the game, and the right behaviour is to produce 133.3 with the
difference stated — which is what happens.

---

## 10. Circular sourcing and misinformation found

- **A "PUBG yaw 0.022" calculator** publishing "sens 50 at 800 DPI ≈ 1.0
  cm/360" — internally absurd, and the shape of automatically generated
  content rather than measurement. Excluded, and named in the profile.
- **"The Battlefield series uses 0.0022"** — repeated without distinguishing
  Battlefield 6's changed menu scale, which the community guide the profile
  cites documents explicitly. Recorded as a competing value *and* as probably
  stale.
- **Marvel Rivals' four constants** — 0.017453, 0.022, 0.0066 and 0.07 are all
  in print, several sites plainly copying one another. Settled arithmetically
  rather than by counting sites.
- **An internal circularity** — Pass 3's own reasoning about Siege's 0.00223
  compared a configuration knob against a yaw and reported a 2.57× discrepancy
  as evidence. Corrected.

Pro-settings tables were used only as corroboration. Where a constant and a
pro table came from the same site, that was not counted as two sources.

---

## 11. Player-facing changes

**Profile confidence (requirement 22).** The status badge used to be followed
by one generic sentence for all eleven non-verified profiles. It now names
*this* game's own limitation, quoting the profile's first stated edge case:

> **Partly verified** — Hip-fire conversion is well supported; some scoped
> behaviour is not. What it does not cover: ADS and per-optic sensitivity are
> not converted. Apex scales each optic on its own before your multiplier
> applies, and published references disagree on the factors…

For two profiles the edge-case list was reordered so the sentence that appears
here is the one that most affects whether a number can be trusted (Valorant's
per-tier multipliers; Siege's reconstructed optic FOV factors).

**Provenance (requirement 23).** The installed-app gate now additionally
requires, for every profile, that source, confidence, the game build checked
against, and the limitations list are all reachable from the profile details —
and that a non-verified badge carries its game-specific explanation rather
than boilerplate.

---

## 12. Boundaries respected

No change was made to the calibration engine: arena gain, candidate blinding,
pairing, timing, hit detection, capture validation and evidence gating are
untouched. The one engine-side change in this pass is a warning string in the
profile layer's own `convert.ts`. The measurement-core boundary test still
passes: nothing under `src/**` outside `src/games/**` imports the profile
layer.

**No calibration-engine defect was discovered in this pass.**

---

## 13. Remaining uncertainty, per profile

| Profile | What is still open |
| --- | --- |
| Generic / Raw | Nothing. Its unit is a definition; its only loss is its own four-decimal grid, which it reports. |
| Fortnite | Epic publishes no constant (confirmed to ~0.5%, the resolution of the check). Scope FOVs unpublished — scope stays unconverted. Slider bounds assumed. |
| Valorant | Riot publishes nothing; the constant and zoom model are confirmed by derivation, not by measurement. Each multiplier covers a weapon *tier*; the converted value is exact for one weapon and within a few percent for the others. Multiplier field bounds assumed. |
| Counter-Strike 2 | Menu slider bounds vary between guides (the console accepts anything). Whether the zoom ratio still applies to the AUG and SG 553 has been disputed since 2014; neither is converted. |
| Apex Legends | Per-optic ADS factors remain contradictory across three references. Slider bounds and step from player reports. |
| Call of Duty / Warzone | Legacy ADS mode not modelled. Field bounds from recent settings screens. Assumed unchanged across the Black Ops 7 / Warzone shared menu. |
| Overwatch 2 | Scoped FOVs are community-measured. Only three heroes converted; later ones are not. Stock relative value assumed 30%. |
| Rainbow Six Siege | Per-optic FOV factors are a community reconstruction — Ubisoft publishes its table only as an image, so it could not be read back. That 50 is *exactly* the focal-length neutral follows from Ubisoft's wording, not from measurement. |
| Marvel Rivals | Hero scope FOVs unpublished — scopes unconverted. Field bounds assumed. Fixed FOV reported as ~90° but unverified and unused. |
| **PUBG** | **Linearity of the 1–100 scale is unverified**, and the FOV the constant is stated at (80) is itself unconfirmed — if the true reference is the game's default of 90, every value is 12.5% out. Everything but General sensitivity is unconverted. |
| The Finals | Constant fitted, never measured. Zoomed FOVs unpublished, so only the game's own relationship is offered. Zoom multiplier bounds assumed. |
| **Battlefield 6** | **One published measurement**, with a competing 0.0022 in circulation that appears to predate the game's menu-scale change. Coefficient upper bound and FOV bounds assumed and conflicting. |

### Profiles not suitable for a V1 public recommendation

**PUBG: Battlegrounds** and **Battlefield 6**. Both rest on a single
un-remeasured number — one whose *shape* (linearity) is unconfirmed, one
whose *value* is contested — and both already carry the experimental warning
on every conversion. They are safe to ship as labelled experiments and should
not be presented in Pass 5 as recommendations of the same standing as the
other ten.

The remaining ten are suitable, with their stated limitations shown.

---
## 14. Commits

| Commit | |
| --- | --- |
| `35a2aa2` | Re-verify all twelve game profiles and correct what Pass 3 got wrong |
| `a777c3b` | Add golden tests whose expected values come from outside this repository |
| `b4b30c4` | Cut 1.0.0-rc.12 for Game Profile Campaign Pass 4 |
| (this commit) | Add the Pass 18 report |

**Starting HEAD:** `949b21a` · **Built HEAD:** `b4b30c4` (the commit CI built
and verified; the report commit follows).

---

## 15. Test and gate results

| Suite | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` (engine + desktop) | clean |
| Unit / engine tests | **1230 passed, 98 files** (was 1160 / 96) |
| Browser tests (Playwright) | **179 passed** |
| — of which game-profile specs | 43 passed |
| New: `gameSourceGolden.test.ts` | 32 passed |
| New: `gameRoundingHardening.test.ts` | 38 passed |
| Cross-profile equivalence audit | 3,456 conversions, **0 failures** |
| Branding gate (sources + docs + bundle + installer) | PASS |
| No-telemetry audit (sources + bundle) | CLEAN — 9 declared provenance URLs |
| Release verification | PASS |
| Installed-app game-picker gate | PASS (in CI, against the installed application) |
| Candidate-gain / arena-entry / timing / capture gates | PASS (unchanged) |

No gate was weakened. Two browser tests (`breaks.spec` "Space ends a break",
`calibrationJourney` "Continue calibration resumes") failed once while the
CPU-heavy unit suite was running concurrently and passed in isolation and in
the clean full run; they are load-induced timing flakes, unrelated to this
pass, and CI's browser job passed.

---

## 16. Windows CI and the installer

| | |
| --- | --- |
| Run | [`34197845506`](https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34197845506) |
| Commit built | `b4b30c4` (the exact pushed commit) |
| `engine` | ✅ success |
| `browser` | ✅ success |
| `native-windows` | ✅ success |
| `windows-installer` | ✅ success — including silent install, installed-app verification, installed-app branding gate, and the game-picker gate driven inside the installed application |
| `windows-release` | ✅ success |

### Installer

| | |
| --- | --- |
| Filename | `trAIMer-Setup-1.0.0-rc.12.exe` |
| Size | 100,547,913 bytes |
| **SHA-256** | `dcc93df94fc52bbad49d82f2045d89388670b47e7a361b262a73d78cfae079a1` |
| Staged at | `release/installer/trAIMer-Setup-1.0.0-rc.12.exe` |
| Also staged as | `release/installer/trAIMer-Setup.exe` (byte-identical, same digest) |
| Checksum file | `release/installer/trAIMer-Setup-SHA256.txt` |

The digest was recomputed locally after download and matches the one CI
published. `verify-windows-artifacts.mjs --installer` and
`verify-branding.mjs --installer` both pass against the staged file.

### Flash drive

`/Volumes/NO NAME` is **not mounted** — the only volume present is
`Macintosh HD`. Per the pass instructions the installer was left staged
locally at the paths above and the work continued. To copy it later:

```
cp "release/installer/trAIMer-Setup-1.0.0-rc.12.exe" "/Volumes/NO NAME/"
shasum -a 256 "/Volumes/NO NAME/trAIMer-Setup-1.0.0-rc.12.exe"
# expect dcc93df94fc52bbad49d82f2045d89388670b47e7a361b262a73d78cfae079a1
```

---

## 17. Release blockers before Pass 5

**None.** All five CI jobs are green on the built commit, the installed
application passes every gate including the strengthened picker gate, and no
calibration-engine defect was found.

Two items are carried into Pass 5 as decisions rather than blockers:

1. **PUBG and Battlefield 6 should not be presented as recommendations of the
   same standing as the other ten.** They are correctly labelled experimental
   today; Pass 5 should decide whether "experimental" is prominent enough for
   a public release, or whether they belong behind an explicit opt-in.
2. **Two constants would be settled in minutes with the games installed.**
   PUBG's linearity and Battlefield 6's yaw are the only two questions in the
   registry that external sources cannot answer. A single measured 360° turn
   in each — at two sensitivities for PUBG — would resolve both. Every other
   open item is a documented limitation, not a missing measurement.

---

## 18. Pass 5

**Pass 5 has not been started.** No public-release hardening work was begun:
no changes to the release channel, installer signing, onboarding, first-run
experience, or public documentation beyond recording this pass's findings.

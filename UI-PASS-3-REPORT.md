# Aldo Aim Lab — UI Design Pass 3 Report

Status: **Complete.** Implementation commit
`47c14f37b603f218ffd0da2bb40015ea008d9490` on `ui/fable-v1`
("Final UI polish before hardware validation (UI Pass 3)"), on top of the
accepted Pass 2 work (`234ddac` + report `8f11eca`). This report is
committed separately on the same branch. The engine (`src/**`) was not
touched — every change is inside `app/**` and `tests/browser/**`.

Pass 3 was the final polish pass before hardware validation: one more full
visual audit (empty and populated states at 1920×1080, 2560×1440,
1440×900, 1280×720, plus a 1366×768 spot check, driven through a real
end-to-end session twice), a concrete defect list, targeted fixes, and a
verify-by-reshoot loop for every fix.

---

## 1. Final visual audit findings (before changes)

**Functional defects**
- The Test tab's recoverable-session list was mounted once at boot and
  never refreshed — after finishing or discarding a session, the Test tab
  showed a stale (or missing) resume list until a full reload. (Fixed —
  remounted on every Test-tab activation.)
- Preflight was computed once at boot with no way to recompute. Fixing a
  flagged item (e.g. entering DPI) could never turn the readiness card
  green without reloading the app. (Fixed — "Run checks again" recomputes
  through the same `runPreflightChecks` seam and re-renders in place; the
  error card offers it too.)
- The checkpoint card's export action was labeled "Export diagnostic
  bundle" but downloads the session's **resume bundle**. (Fixed — now
  "Export session bundle".)

**Presentation defects**
- History's per-session candidate-ranking chips printed "#1 · 4148 eDPI",
  "#2 · 4148 eDPI", … — the engine's `rankingHistory` view model carries
  one shared placeholder eDPI (`edpiRange.min`) for every row, and
  repeating it per chip read as (wrong) data. (Fixed presentationally —
  the eDPI is shown per chip only when the rows actually differ; utility,
  rank, tie, and tooltip data unchanged and verbatim.)
- Home always rendered the latest recommendation as a confident volt
  number even when the engine had refused high confidence — the landing
  screen looked more certain than the Results screen. (Fixed — driven by
  the engine's own `refusedHighConfidence` flag: the number drops the volt
  accent and gains a quiet warn "preliminary" badge.)
- Home greeted "Welcome back" on true first use.
- The Home readiness line floated the raw capture detail ("coalesced
  pointer events available") with no label.
- Preflight's category grid left a large void beside the tall CAPTURE
  panel (the Pass 2 known defect).
- At 1161–1420 px viewports the Results sensitivity chain wrapped
  vertically while its connecting arrow still pointed sideways at
  nothing; at 1280 the "X %" axis captions wrapped onto two lines.
- Results "Trials — Analyzed 15 / Excluded 15" read as impossible; the
  count is measured trials.
- Two volt primary buttons competed on Calibration (Start rep and
  Compute & save), and Compute was clickable with zero reps.
- Data's import was a raw browser `Choose File` control amid styled
  buttons, and its failure copy ("import failed: Error…") didn't match
  the restore card's designed rejection line.
- Home ("System ready" / "Setup needed") and Test ("Ready" / "Blocked")
  used different words for the same engine verdicts.
- History's empty state answered "why empty" but not "what should I do"
  (no CTA), and the first-use Home was one thin row above a mostly empty
  page.

## 2. Pixel-level refinements

- `.sens-axis` no longer wraps; the sensitivity chain gets a
  `flex-direction: column` + rotated-arrow treatment in the 1161–1420 px
  band where the two-column Results layout squeezes the hero card.
- Preflight groups switched from a 3-column grid to CSS multi-columns
  (`columns: 3/2/1`, `break-inside: avoid`) with the tall CAPTURE group
  ordered last so it packs into its own column — the void is gone at
  every audited width, and fully-passing states still balance.
- New `home-step-num` numeral chip reuses the existing token set (same
  geometry as the calibration step counter).
- No new colors, radii, shadows, or spacing values were introduced;
  every fix reuses existing tokens.

## 3. Home refinements

- Greeting is honest: "Welcome, Aldo" until at least one session exists,
  then "Welcome back, Aldo".
- Verdict badge labels now match the Test screen exactly (one vocabulary:
  Ready / Ready with warnings / Limited confidence / Blocked).
- The capture detail line is labeled: "Capture: coalesced pointer events
  available".
- First-use state now teaches the product in one quiet hairline-divided
  surface: 1 Confirm your setup · 2 Play the blinded test · 3 Get a
  measured answer — no decorative filler, and it fills the previously
  empty first-run page.
- A latest recommendation the engine refused to back is marked
  "preliminary" (warn badge, no volt accent) — Home and Results now agree
  about certainty.

## 4. Results refinements

- Trials row renamed "Analyzed" → "Measured" (matches the run screen's "n
  / ≤N measured trials" vocabulary and stops reading as
  "15 analyzed · 15 excluded" nonsense when all trials were excluded).
- Mid-width stacking fix (§2) keeps the CURRENT → PRELIMINARY/USE NOW
  chain legible with a downward arrow instead of a sideways one.
- Confident vs preliminary treatments, staged-change chain, range bar,
  next-action card, evidence sections, and technical details verified
  again at all four widths — no other changes needed; the tentative and
  confident states remain visually distinct screens.

## 5. Gameplay refinements

Final measurement-safety review found nothing to change: the stage
remains bare (canvas, top state bar, bottom progress bar), the
candidate/scenario line stays peripheral, targets and reticle geometry
are untouched, the hit ring remains the only effect (fixed-position,
160 ms, draw-after-the-fact), and no new animation, blur, or observer
was added anywhere near the measurement path. Pause/rest/end-dialog
overlays re-verified by screenshot.

## 6. History / chart refinements

- Empty history now carries a primary "Start an aim test" CTA (wired
  through a navigation callback — no view-layer coupling).
- Ranking chips: placeholder-eDPI dedup (§1); rank/utility/tie/trial
  data unchanged.
- Single-point trend note shortened to "trend begins with your second
  session" (was repeated verbatim as a longer sentence across three
  cards); Home's variant aligned.

## 7. Preflight / diagnostics refinements

- "Run checks again" on the readiness card (and on the check-failure
  card) recomputes preflight in place via the frozen seam and re-renders;
  Home picks up the fresh report on its next render. Warning vs blocked
  presentation itself was already unmistakable and is unchanged.
- Masonry packing (§2) removes the category-grid void.
- Diagnostics needed no changes: player tiles first, claimed
  ("device claims N Hz") vs observed ("~M Hz observed") vs validated
  wording re-verified as distinct.

## 8. Calibration refinements

- One primary action at a time: "Compute & save calibration" is now
  secondary and disabled until at least one repetition exists (pure
  presentation gating — adequacy judgment stays with the engine).
- "No calibration on record" copy rewritten in player language while
  keeping the engine meaning ("Testing works without it, but physical
  distances (like cm per 360°) stay unavailable until you complete this
  flow and the engine judges the measurements adequate.").
- Section label "Guided procedure — external, manual" → "Guided
  procedure" (the page subtitle already carries the alongside-Fortnite
  context).

## 9. Resume / data refinements

- Checkpoint export action relabeled "Export session bundle" — it was
  claiming to be a diagnostic bundle.
- Test-tab resume list stays current (§1).
- Data: import is now a styled "Choose bundle file…" chooser (hidden
  input, same pattern as restore); import rejection copy matches the
  restore card's designed line ("Import rejected — nothing was written."
  with the validation reason as detail).
- Privacy line, danger-zone fencing, and confirm-gated restore
  unchanged and re-verified.

## 10. Microcopy refinements

Every user-facing string was re-read. Changes beyond those listed above:
verdict-label unification (one phrase per state across Home/Test), the
"Capture:" prefix, first-use greeting, trials "Measured", trend-note
wording. The deliberately technical surfaces (reason codes, mono record
lines, diagnostics capture path) remain behind labels or disclosure by
design.

## 11. Accessibility findings

- New controls are ordinary buttons inheriting the global
  `:focus-visible` treatment; the refresh action is reachable directly
  after the readiness badge; disabled Compute is announced via native
  `disabled`.
- Keyboard walkthrough re-verified: nav (`aria-current`), preflight
  summaries, form fields, advanced-details disclosure, history rows
  (Enter/Space, `aria-expanded`), dialogs (native `<dialog>`: focus
  containment, Esc, cancel-first focus order), meters' `aria-label`s.
- Unchanged honest gaps: no live-region narration of trial state during
  pointer-locked gameplay; chart tooltips are hover-only (native
  `<title>`).

## 12. Responsive findings

Re-verified at 1920×1080, 2560×1440, 1440×900, 1280×720 (and 1366×768
for Results): no horizontal body scroll, no hidden primary action, no
clipped dialogs, hierarchy preserved. Two mid-width defects found and
fixed (sens-chain arrow, axis-label wrap). 2560 keeps the 1320 px
centered content column with intentional whitespace.

## 13. Performance findings

No new animation loops, observers, blur surfaces, or chart work. CSS
multi-columns replace a grid (layout-time only, static content). The
preliminary-badge lookup on Home is one additional recommendation load
on an already-async panel. Bundle: 219.5 KB JS (72.7 KB gzip, +0.4 KB
over Pass 2), 28.9 KB CSS.

## 14. Dead UI removed

- `monitor` icon (defined, never rendered) removed from the icon set.
- `statTile` `large` option and its `.stat-large` CSS (unused since the
  Pass 2 stat-strip consolidation) removed.
- Grep sweep confirmed no other orphaned components; `grid cols-3/4`
  retained deliberately as live design-system primitives.

## 15. Final walkthrough findings

Full first-use walkthrough (launch → preflight → setup → start →
lock-in → warmup → measured trials → pause/resume → rest → end-dialog
cancel → completion → results → home → history → data/backup) was driven
twice end-to-end in a real browser session. Confusing moments found and
fixed along the way: the stale Test-tab resume list, the
impossible-sounding trials row, and Home's over-confident preliminary
number. One residual confusion is engine-owned and documented in §19
(the lingering 0-trial "running" checkpoint after a completed session).

## 16–17. Automated test / check results

| Check | Result |
| --- | --- |
| `npm test` | 52 files, **405 passed**, exit 1 from the pre-existing worker-RPC timeout (see below) |
| `npm run test:browser` | **23 passed** (was 20; +3 Pass 3 assertions: in-place preflight re-run, empty-history CTA, first-use Home steps) |
| `npm run lint` | 0 problems |
| `npx tsc --noEmit` | clean |
| `npm run build` | ✓ 219.5 KB js / 72.7 KB gzip · 28.9 KB css |
| `node scripts/verify-release.mjs` | all checks pass |
| `node scripts/audit-no-telemetry.mjs` | CLEAN (sources + bundle) |
| `npm audit` | 0 vulnerabilities |

The `npm test` exit-1 is the documented engine-side vitest issue
("Timeout calling onTaskUpdate" from the long fully-synchronous
Monte-Carlo suites starving the worker RPC). It was re-confirmed
**identically on the unmodified Pass 2 commit** on this machine
(`git stash` → baseline exit 1 → `git stash pop`), so it is not a
regression from this pass; all 405 tests pass in both runs. No engine
test was touched.

## 18. Known visual defects

- Chart tooltips remain native browser tooltips (functional, unstyled).
- The rest overlay has no numeric countdown (no engine seam exposes
  remaining rest time); stale targets from the last frame are faintly
  visible behind the translucent rest/pause overlays (honest, dimmed).
- The Results hero's left card can sit shorter than the action card at
  wide viewports, leaving whitespace below the range bar.
- Firefox/Safari were not visually swept (engine support there is
  functional-untested per `docs/RELEASE.md`).

## 19. Known functional defects

- None known in the UI layer. Engine-side quirks the UI renders
  honestly: a completed session can leave a 0-trial "running" checkpoint
  behind (it then appears as a resumable session on Home/Test until
  discarded), and `rankingHistory` rows carry a placeholder per-candidate
  eDPI (now de-duplicated in presentation). Live in-browser resume
  execution remains an engine-integration seam
  (`SessionRunner.resumeFrom`) that the UI surfaces through the mandated
  Resume action + explanation dialog.

## 20. Remaining work, classified

**A. MUST FIX BEFORE HARDWARE VALIDATION** — none in the UI layer.

**B. CAN ONLY BE VALIDATED ON ALDO'S WINDOWS/HIGH-REFRESH HARDWARE**
1. Target color/contrast, reticle crispness, hit-ring visibility, and
   vignette strength on his actual panel at high refresh.
2. Motion feel of trial transitions and the state-chip beat at 240 Hz.
3. Native capture tier end-to-end (helper + preflight capture group +
   diagnostics capture check with real tier-1 data).
4. Real DPI/scaling behavior of the 1280×720 stage on his display mode.

**C. OPTIONAL POST-V1**
1. Rest countdown + session time-remaining (needs an engine seam).
2. Candidate-block progress map in the run screen (progress-snapshot
   seam).
3. Styled chart tooltips; X/Y asymmetry panel when `jointXY` ran.
4. Session-detail deep view; visual-regression snapshots; engine-side
   cleanup of the completed-session checkpoint and ranking eDPI
   placeholder.

## 21–22. Commit hashes

- Pass 3 implementation: `47c14f37b603f218ffd0da2bb40015ea008d9490`
- Pass 3 report: the commit containing only this file, immediately after
  (`git log --format=%H --grep "Add UI Pass 3 report" -1`).

## 23. GO / NO-GO — merge `ui/fable-v1` into `main`

**GO.** All UI acceptance surfaces are verified on this hardware; the
only red check (`npm test` exit code) is pre-existing, engine-owned, and
identical on the accepted baseline commit. Recommend merging after the
engine owner signs off on that CI issue's disposition.

## 24. GO / NO-GO — hardware validation

**GO.** The build is ready for Aldo's Windows machine; the B-list above
is exactly what that pass exists to answer.

## 25. Self-score

| Category | Score | Note |
| --- | --- | --- |
| Visual design | 9.5 | Coherent and restrained; icons remain good-not-jewel; hero-card whitespace at wide viewports |
| Gameplay UI | 9.5 | Clean, honest, measurement-safe; rest countdown still missing (engine seam) |
| Results | 9.5 | Confident/preliminary clearly distinct at every width; asymmetry panel pending |
| Usability | 9.5 | Re-runnable preflight, current resume lists, every empty state answers "what next" |
| Consistency | 10 | One verdict vocabulary, one accent discipline, no ad-hoc values introduced |
| Accessibility | 9 | Keyboard/contrast/reduced-motion solid; hover-only tooltips and no gameplay live-region keep it under 9.5 |
| Responsiveness | 9.5 | All four target widths intentional; mid-width chain/axis defects found and fixed |
| Overall polish | 9.5 | The remaining half-point is precisely the hardware pass — target rendering and motion feel cannot be honestly scored from this Mac |

Not a 10, deliberately: every fixable-on-this-Mac issue found by the
audit was fixed, but items in section 20-B are real UI-quality questions
that only Aldo's panel can answer, and two visual niceties (tooltip
styling, rest countdown) wait on post-V1/engine seams.

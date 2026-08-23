# Aldo Aim Lab — UI Design Pass 1 Report

Status: **Complete.** Implementation commit
`6936eddeb2f83c7e8d57da49094bba111796cea2` on branch `ui/fable-v1`
("Redesign application UI as a competitive-performance product (UI Pass 1)").
This report is committed separately on the same branch.

UI Pass 1 replaces the Pass 5 developer interface with a complete
competitive-performance product experience, built entirely on the frozen
engine seams in `docs/UI-CONTRACT.md`. Every screen was implemented, driven
end-to-end in a real browser, and reviewed visually at 1920×1080 (plus 2560,
1440, 1366, and 1024 widths).

---

## 1. Design direction

**"Precision instrument, not gamer wallpaper."** Near-black/charcoal
surfaces (`#07090c` → `#181d26`), one restrained bright accent — volt
(`#c8f24e`) — reserved for primary actions, live states, and headline
numbers, plus four semantic tones (ok/warn/danger/info) used only where data
meaning requires them. Typography is a strong system sans (Inter/Segoe UI
Variable/SF stacks) for UI and a tabular monospace (JetBrains
Mono/Cascadia/Consolas) for every number. Depth is subtle (hairline borders,
soft two-layer shadows, one radial highlight on hero panels); motion is a
single 200 ms view-entry transition plus micro-transitions on interactive
states, all disabled under `prefers-reduced-motion`.

Two hard constraints shaped the system:

- **No external assets.** The no-telemetry audit scans the bundle for any
  network-capable reference, so there are no webfonts, CDN icons, or chart
  libraries. All icons are a hand-drawn inline-SVG set; all charts are
  hand-rolled SVG; fonts are system stacks.
- **No `innerHTML`.** The security suite enforces textContent-only
  rendering, so the whole component library builds real DOM nodes.

## 2. Navigation architecture

Persistent left sidebar with the wordmark (crosshair sigil + **ALDO** /
**AIM LAB**) and seven views:

1. **Home** — command center (new)
2. **Test** — preflight readiness + session setup + run
3. **Results** — FinalResult-first payoff screen
4. **History** — trends, sessions, lineage, calibration record
5. **Calibration** — guided physical-calibration flow
6. **Diagnostics** — player status + guided capture check + bundle export
7. **Data** — backup/restore/import/export with danger zone

The sidebar footer carries the version + "local-only · no telemetry"
identity line. During an active session the entire navigation chrome is
removed (`body.session-active`) — the run screen is full-bleed and
distraction-free.

## 3. Screens redesigned

**Home (new).** Readiness badge driven by the preflight verdict, prominent
START AIM TEST, current loadout (DPI, X/Y, eDPI), latest recommendation with
plausible range, evidence meter, eDPI trend chart, and the resume list
mounted first-class at the top. All values come from engine objects
(preflight report, `HistoryApi`, checkpoint summaries).

**Test.** The 15 preflight checks render grouped into player-facing
categories — MOUSE / CAPTURE / SENSITIVITY / CALIBRATION / DISPLAY /
STORAGE / SYSTEM — each an expandable panel (auto-open when not passing)
with the engine's status, detail line, and stable reason code verbatim.
Setup is a two-column form with product microcopy and a live eDPI baseline
(computed by engine `sensmath.edpi`, not UI math); seed/rounds/reps/warmups
sit behind "Advanced session parameters". Input DOM order is unchanged, so
existing automation still addresses the same fields.

**Run.** Top bar: brand, blinded candidate + scenario line (sticky through
the whole trial), engine-state chip; the raw `SessionStateName` is exposed as
`data-session-state` for automation. Stage: the 1280×720 measurement canvas
(geometry untouched) restyled with a cached vignette, volt targets with core
dot, and a white reticle with dark halo. Bottom bar: progress meter against
the engine's planned-trial ceiling ("n / ≤N measured trials"), Pause, and a
confirm-gated End session. Overlays for lock/rest/pause/candidate-transition/
analyzing/finish are designed states with icons and reassuring copy (rest
reads as protocol, not interruption).

**Results.** Hierarchy exactly as the product demands: CURRENT → USE NOW
sensitivity blocks (X/Y % + eDPI), staged-change explanation with the full
inferred target when `sensitivityChangePlan` bounded the step, plausible-eDPI
range bar with current/use-now/full-target markers, the engine's ONE
recommended next action with its rationale, and an evidence-strength meter
labeled with the engine's confidence label and heuristic basis (plus an
explicit callout when `refusedHighConfidence`). Below: the designed retest
plan with enforced-rest start time, candidate-comparison bar chart with SE
whiskers and "Why this candidate won" / evidence-against details, performance
dimensions (Speed/Accuracy/Overshoot/Undershoot/Correction/Tracking/
Consistency), scenario contributions, session quality (capture grade, search
shape, boundary, adaptation, exclusions by reason code), open questions, and
full JSON under Technical details. A legacy path renders recommendations that
predate `FinalResult`. Empty state has a CTA into Test. On reload, Results
self-loads the newest stored recommendation through `HistoryApi` and rebuilds
the display object via `buildFinalResult`/`planNextTest` — engine functions,
never UI math.

**History.** Headline stats, four SVG trend charts (eDPI, confidence, X
sensitivity, capture quality) with min/max/latest legends and no fabricated
interpolation, full sessions table, retest lineage, calibration history, and
an intentional empty state.

**Calibration.** Current-calibration status card (adequate/not adequate from
the engine record), a numbered 4-step guided procedure, parameter grid, big
live rep counter with canvas accumulator, measurements table, and
engine-judged compute/save with clear adequate/inadequate outcomes.

**Diagnostics.** Player view first: status tiles (Mouse input, last Capture
check verdict, Storage). The native probe became a guided capture check —
"move your mouse naturally and click" with a live sample counter — ending in
four summary tiles (capture quality, observed polling rate, timing
stability, dropped samples) whose tones come from the engine's own named
checks, with engine checks and full percentile/jitter JSON behind details.
Helper-unreachable renders as a calm explanation, not an error dump. The
self-test record is persisted exactly as before so preflight can gate
tier-1 trust. Export diagnostic bundle is preserved verbatim.

**Data.** Whole-store **Back up all data** and confirm-gated **Restore from
backup** now use the Pass 5 `exportBackupAll`/`importBackupAll` seams
(SHA-256 integrity, zero-partial-state restore) — restore lives in a
visually separated danger zone. Per-session bundle export and validated
bundle import remain.

**Resume.** Checkpoint cards (not tables): player, start time, progress,
round, capture source, age, interrupted-trial notice, status badge, and the
mandated Resume / Discard / Export actions. Discard is confirm-gated and
still only marks the checkpoint aborted. Corrupted checkpoints surface as
their own warning cards. Native `alert()` calls were replaced by designed
dialogs.

## 4. Design-system implementation

- `app/src/ui.ts` (~700 lines): icon set (26 inline-SVG glyphs), badges,
  status dots, cards, page headers, section labels, grids, buttons, form
  fields, stat tiles, key-value lists, tables with empty rows, meters,
  range bars, horizontal bar charts with SE whiskers, dated trend charts,
  empty states, confirm/info dialogs, details blocks, JSON blocks, and
  date/ago formatters. No domain math anywhere in it.
- `app/styles.css` (~1,300 lines): tokenized colors/typography/geometry/
  elevation/motion, the app shell, session mode, and per-pattern styling.
  No per-screen ad-hoc CSS files.

## 5. Responsive behavior

Designed for 1920×1080 first; verified by screenshot at 2560×1440,
1440×900 (full Playwright suite viewport), 1366×768, and 1024×768. Grids
collapse 4→2→1; the preflight group grid collapses 3→2→1; below 860 px the
sidebar becomes a top bar. Tables scroll inside their own containers; the
body never scrolls horizontally.

## 6. Accessibility

- Full keyboard navigation of non-gameplay UI (all controls are native
  buttons/inputs/summaries) with a consistent 2 px volt `:focus-visible`
  outline.
- `prefers-reduced-motion` collapses all animation/transitions.
- Status is never color-only: every state pairs color with an icon and a
  text label; meters carry `aria-label`s; icons are `aria-hidden`.
- High-contrast text scale (body #e9edf3 on #07090c) and tabular numerals
  for scanning; reticle drawn with a dark halo for visibility on any
  target.

## 7. Engine-contract compliance

- All §2/§6 seams used as-is: `renderSetupView` shape,
  `BrowserRunController.create`, `HistoryApi`, `renderResumeList` with
  mandatory actions, `LocalDiagnosticLog.exportBundle`, `runPreflightChecks`
  report rendered verbatim (reason codes included), capture self-test
  persistence unchanged, `buildFinalResult` as the results headline,
  `planNextTest` for the decided next action, `exportBackupAll`/
  `importBackupAll` for data safety, `analyzeNativeStream` checks verbatim.
- No confidence, ranking, range, grade, adequacy, staleness, or threshold
  is computed in presentation code. Diagnostics tile tones are read from
  the engine's own named checks rather than re-encoding thresholds.
- Blinding preserved: the run HUD shows only the engine-produced blinded
  label ("Candidate A"); candidates are never revealed mid-session.
- Two deliberate, minimal presentation-layer judgments to note:
  1. `sensmath.edpi()` is imported for the pre-session eDPI display on
     Home/Test (using the engine's function rather than re-implementing
     DPI × sens%). Strictly, §2 lists it outside the tabled seams; it was
     chosen as the least-violation path versus inlining the arithmetic.
  2. The run progress ceiling multiplies the engine definition's own plan
     fields (candidates × reps × rounds, capped by
     `maxTotalMeasuredTrials`) purely for the "n / ≤N" label; adaptive
     early stopping is why the label says "≤".
- No schema changes; no migrations; raw trial data untouched.

## 8. Tests and results

| Check | Result |
| --- | --- |
| `npm test` (engine + security incl. DOM-safety scan of app/) | 52 files, **405 passed** (one benign vitest worker RPC-timeout notice, present in the pre-redesign baseline; exit 0) |
| `npm run test:browser` | **20 passed** (was 11; +9 new UI tests) |
| `npm run lint` | 0 problems |
| `npx tsc --noEmit` (strict, incl. app/) | clean |
| `npm run build` | ✓ 210 KB js / 69.6 KB gzip, 23.4 KB css |
| `node scripts/audit-no-telemetry.mjs` | **CLEAN** (sources + bundle) |
| `node scripts/verify-release.mjs` | all checks pass |

Browser-test updates were structural only (new nav labels, Home as initial
view, advanced fields behind a details element, checkpoint cards instead of
a table, `data-session-state` instead of scraping HUD prose) — no assertion
was weakened; the full-session E2E now additionally asserts a rendered
recommendation. New `tests/browser/ui.spec.ts` covers the shell/active nav,
wordmark, distraction-free session mode with confirm-to-end, checksummed
whole-store backup download, danger-zone restore, and diagnostics tiles.

## 9. Visual review notes

Screenshotted and inspected at 1920×1080: Home (empty + with data), Test
(preflight groups + form), run start / live trial / rest overlay, Results
(full, reloaded-from-store, and empty), History (empty + with data),
Calibration, Diagnostics, Data, plus 2560/1366/1024 sweeps. Two review
rounds; fixes landed between them: overlay `[hidden]` vs flex conflict
(latent pre-existing bug), misleading "≤160" progress ceiling, rest-overlay
copy, sticky candidate/scenario HUD line during live trials, duplicated
retest rationale on Results, hero-card stretch, and form input widths.

## 10. Known visual defects / limitations

- The Home resume card shows "unknown player" when a checkpoint predates
  player-name capture, and a just-completed session can briefly leave a
  0-trial "running" checkpoint if the tab closes during the final
  checkpoint write — engine data rendered honestly; worth an engine-side
  look eventually.
- The rest overlay shows no numeric countdown (the engine does not expose
  remaining-rest time through any UI seam); copy says the next block starts
  automatically.
- A few icon glyphs (shield, flag, settings) are serviceable but not
  jewel-quality at 15–16 px.
- The preflight category grid can look height-imbalanced when one category
  holds many checks (CAPTURE) and its neighbor holds one.
- Trend charts intentionally render single points without a line; with one
  session the chart area reads sparse.
- Firefox/Safari were not visually swept (engine support there is
  functional-untested per `docs/RELEASE.md`).

## 11. Recommended UI Pass 2 work

1. Rest countdown + session time-remaining estimate (needs a small engine
   seam exposing rest duration / progress snapshot).
2. Candidate-block map in the run screen (completed/current blocks) fed by
   a progress-snapshot seam.
3. Results: per-dimension best-vs-runner-up comparison visualization and a
   dedicated X/Y asymmetry panel when `jointXY` exploration ran.
4. History: session detail drill-in (per-session dimension profile,
   ranking history rows already exist in the snapshot).
5. Iconography refinement pass and a real app icon/favicon.
6. Calibration: inline rep-quality feedback (rejected reps highlighted from
   the engine record) and Y-axis calibration UI when the engine flow lands.
7. Windows-hardware pass on Aldo's PC: verify volt target visibility and
   reticle contrast on his panel at 240 Hz, and tune stage vignette.
8. Optional Playwright visual-regression snapshots for the design system.

## 12. Commit hashes

- Implementation: `6936eddeb2f83c7e8d57da49094bba111796cea2`
- Report: the commit containing only this file, immediately after (a commit
  cannot contain its own hash; read it with
  `git log --format=%H --grep "Add UI Pass 1 report" -1`).

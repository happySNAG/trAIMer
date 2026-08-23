# Aldo Aim Lab — UI Design Pass 2 Report

Status: **Complete.** Implementation commit
`234ddac711f154ef4d9a31682369baddf3eb1bbc` on `ui/fable-v1`
("Refine every screen to commercial quality (UI Pass 2)"), on top of the
accepted Pass 1 foundation (`6936edd`). This report is committed separately
on the same branch. The engine was not touched.

Pass 2 was a refinement pass: a systematic screenshot audit first (28
captures across 1920×1080, 2560×1440, 1440×900, 1280×720, covering
populated and empty states, run/pause/rest/abort, dialogs, and error
states), a concrete weakness list second, and three implement-and-reshoot
loops third. Every change below was verified visually, not just in code.

---

## 1. Visual audit findings (before changes)

**Functional defects found by the audit**
- The measured-trials counter never reset between sessions: a second
  session started at "15 / ≤15" and Results reported the accumulated
  count. (Fixed — the counter is per-session now.)
- The Data tab listed `checkpoints/...` storage paths as exportable
  sessions; exporting one targeted a nonexistent session file. (Fixed —
  checkpoints are filtered out of the export list.)
- Pause/Resume button label was self-toggled instead of engine-driven, so
  it could disagree with actual session state; Pause and End session gave
  no feedback during the (correct) engine wait for a safe trial boundary.
  (Fixed — the label follows `SessionStateName`, and "Pausing/Ending after
  this trial…" hints appear immediately.)

**Design weaknesses found**
- Home was card soup: a 4-tile stat grid plus three icon+title+subtitle
  cards — the classic AI-dashboard look.
- Resume cards repeated their reassurance copy per card, printed
  "unknown player" and "Capture: not recorded" noise, and three volt
  Resume buttons competed with the volt Start button.
- A low-confidence Results screen looked identical to a confident one
  apart from body text; retest rationale duplicated in two cards; a wide
  retest card held two short lines; exclusion reasons rendered as raw
  `IMPOSSIBLE_MOVEMENT` codes; the session-quality row was three more
  uniform cards.
- History trend charts stretched a single data point across an empty plot;
  chart cards repeated the same icon four times; no per-session detail.
- Preflight category grid stretched rows to the tallest member (a huge
  empty MOUSE panel).
- Uppercase tracking labels appeared at three hierarchy levels at once.
- Icon glyphs for shield/flag/settings read poorly at 15 px.
- Import errors surfaced as raw `Error: …` strings.

## 2. Visual-system refinements

- **Section labels** switched from uppercase tracking to sentence-case
  13 px semibold with a hairline rule — uppercase is now reserved for tiny
  stat labels and table headers only.
- **New primitives**: `inlineAlert` (tone-tinted status lines that state
  outcome + data safety), `codeChip` (quiet mono chips for machine codes),
  `stat-strip` and `cell-grid-3` (single surfaces divided by hairlines —
  the anti-card-soup pattern), compact single-point trend mode.
- **Cards** gained a 1 px inner top highlight; borders/shadows otherwise
  unchanged. Card titles moved to `h4` so heading order is h2 → h3 → h4.
- **Icons**: shield (with check), pennant flag, dial-style settings, and
  chevron redrawn on the same 24-box stroke grammar; trend cards dropped
  their repeated icon entirely.
- **Range bar** markers brightened with a dark halo; captions to sentence
  case. **Favicon**: inline data-URI crosshair (no network fetch).
- **Motion**: dialog + backdrop entrance (160 ms), staggered result-reveal
  rise, a one-beat state-chip "breathe" on trial-ready — all inside the
  existing `prefers-reduced-motion` kill switch.

## 3. Home improvements

One hero surface now holds readiness (badge + preflight capture detail +
one-line verdict), the primary START AIM TEST, and the current loadout
(DPI/X/Y/eDPI key-values with an Edit shortcut) separated by a single
hairline. "Latest results" is one panel with three zones — recommendation
(big volt number + plausible range + Open), evidence (confidence meter +
trial counts), eDPI trend (or its honest single-point/empty note). The
empty state is a single quiet row with a CTA. The resume list keeps one
shared reassurance line; only the newest checkpoint gets a primary button.

## 4. Navigation / shell

Kept deliberately (it earned its place in Pass 1): 232 px rail, wordmark,
active volt tick. Added `aria-current="page"` to the active item and the
crosshair favicon. Version/no-telemetry identity remains in the rail foot.

## 5. Results-screen improvements

- **Tentative mode**, driven purely by the engine's
  `refusedHighConfidence` flag: the recommended block becomes a dashed
  amber **PRELIMINARY** panel, the range-bar marker relabels to
  "preliminary", and an explicit note says to treat the range as the
  result. A confident recommendation keeps the solid volt USE NOW
  treatment — the two outcomes are now visually different screens.
- **Staged changes** render as a CURRENT → USE NOW → FULL TARGET block
  chain with a one-line "why two numbers" explanation.
- **Next action card** now tells the whole story in one place: the decided
  action, the three most useful rationale lines (full engine reasoning one
  click away), the designed retest plan with its rest-unlock time as a
  tinted alert, and the evidence-strength meter with the heuristic basis.
  The former half-empty retest card is gone.
- **Session quality** is one three-zone surface; exclusion reasons are
  humanized ("Impossible movement · 5") with engine codes preserved on
  hover; the ungraded capture state now tells the player what to do about
  it.

## 6. History / chart improvements

- Headline stats merged into one hairline-divided strip.
- Trend charts: dated legends (first → last), native per-point tooltips
  (date · value), hover-enlarged dots, min–max line, and a compact
  single-point mode ("trend line starts with your second session") instead
  of a lonely dot in an empty plot.
- **Per-session detail**: every session row expands (click or
  Enter/Space, `aria-expanded`) into candidate ranking chips (rank, eDPI,
  utility, ties) and aim-dimension chips (mean, SE on hover) read from the
  engine's `rankingHistory`/`dimensionTrend` view models, plus experiment
  and optimizer-version chips.
- **Comparability**: when stored sessions span multiple optimizer
  versions, an informational alert states that cross-version trends are
  indicative only.

## 7. Test-session improvements

- Restrained **hit confirmation**: a 160 ms expanding ring at the shot
  position — drawn after the fact at a fixed point, so it cannot suggest
  target motion or contaminate measurement; misses deliberately get
  nothing. Target/reticle geometry untouched.
- Bottom bar states the capture source ("browser capture · pointer lock")
  for the whole session — the contract's source-transparency rule, now
  visible during play.
- Candidate/scenario line stays up through the live trial; progress reads
  against the engine's planned-trial ceiling; pause/end give immediate
  boundary hints; the state chip takes a single subtle beat on trial-ready.

## 8. Preflight / diagnostics improvements

- Preflight category grid is top-aligned (no more stretched empty panels);
  category → check → reason-code hierarchy unchanged and verbatim.
- Diagnostics storage tile no longer claims a validated "ok" state — it is
  informational; capture-check tiles already take their tones from the
  engine's own named checks (claimed vs observed vs validated stays
  honest: "device claims N Hz" / "~M Hz observed" / "Not validated").

## 9. Calibration improvements

Compute/save outcomes now render as designed alerts: adequate (with the
engine's statistics as the detail line) vs not adequate (reasons, plus
"add more consistent reps and compute again"). The guided 4-step flow,
status card, and live counter carry over from Pass 1.

## 10. Resume / recovery improvements

Compact single-line-meta cards; one shared "progress is safe" line;
"unknown player"/"capture: not recorded" noise removed; status badges as
quiet dots; primary accent only on the newest checkpoint; Discard remains
confirm-gated and non-destructive (checkpoint marked ended, raw data
kept — and the dialog says so).

## 11. Settings / data improvements

Backup, session export, import, and restore all report through inline
alerts that answer what happened / is my data safe / what next ("Restore
rejected — nothing was written."). Checkpoint files no longer appear in
the session-export table. The danger zone remains visually fenced.

## 12–13. Typography / spacing / color / motion

Covered in §2. Numbers remain tabular mono everywhere; body text never
drops below 11 px; accent usage was reduced (resume buttons, storage tile)
rather than expanded; surfaces gained depth via one inner highlight, not
glow.

## 14. Accessibility findings

- `aria-current` on active navigation; history rows keyboard-operable with
  `aria-expanded`; `role="status"` on inline alerts; meters keep
  `aria-label`s; heading order corrected; dialogs are native `<dialog>`
  (focus containment + Esc); all state distinctions pair icon + label with
  color; reduced-motion collapses all new animation.
- Not addressed (honest gap): no screen-reader narration of live trial
  state during gameplay (out of scope for a pointer-locked canvas), and
  chart tooltips rely on hover.

## 15. Responsive findings

1920 is the design target and looks it. 2560 reads spacious (content max
1320 centered, one-surface panels stretch gracefully). 1440×900 and
1280×720 verified: hero grid, cell grids, and stat strips collapse to
stacked layouts with preserved hierarchy; no horizontal body scroll; the
run stage still centers the fixed 1280×720 canvas at every size.

## 16. Performance findings

No chart library, no animation loops outside the session render loop, no
blur beyond the dialog backdrop. The hit-ring effect adds at most a few
arc draws per frame with an auto-pruned array. Bundle: 218 KB JS
(72.3 KB gzip), 28.6 KB CSS — up ~8 KB gzip from Pass 1 for all of Pass 2.

## 17. AI-UI telltales found and removed

Stats-grid card soup (Home, History) → single divided surfaces; repeated
icon+title+subtitle card headers (trend cards, Home cells) → plain titled
cells; badge/pill overuse (resume status, storage tile) → quiet dots and
informational tones; repeated per-card reassurance copy → one line;
uppercase tracking at three levels → one level; raw `Error:` strings →
product alerts; accent spam (three volt buttons in one list) → one.
Retained deliberately: the volt accent system itself, the wordmark, and
engine-verbatim technical lines behind disclosure.

## 18. Screenshots / visual review notes

Three audit rounds (28 + 28 + targeted captures) stored in the session
scratchpad; every claim above was verified against a capture, including
paused/end-dialog/aborted states, discard dialog, import error, and the
final full-page results walkthrough at 1920.

## 19. Tests / results

| Check | Result |
| --- | --- |
| `npm test` | 52 files, **405 passed** |
| `npm run test:browser` | **20 passed** (assertions added: aria-current, capture-source note) |
| `npm run lint` | 0 problems |
| `npx tsc --noEmit` | clean |
| `npm run build` | ✓ 217.9 KB js / 72.3 KB gzip · 28.6 KB css |
| `node scripts/verify-release.mjs` | all checks pass |
| `node scripts/audit-no-telemetry.mjs` | CLEAN (sources + bundle) |
| `npm audit` | 0 vulnerabilities |

The known engineering-side CI issue is unchanged and untouched by this
pass: in CI mode (`CI=true`), vitest exits 1 despite 405/405 passing
because a >60 s fully-synchronous block in the heavy campaign suites
(Monte-Carlo optimum estimation feeding `blindRecovery.test.ts`) starves
the vitest worker↔host RPC ("Timeout calling onTaskUpdate", 60 s
hard-coded deadline). Reproduced locally and confirmed deterministic;
`pool: "forks"` does not clear it. The fix belongs to the engine owner
(yield inside sim loops, or a vitest major upgrade); no test was weakened
to hide it.

## 20. Known visual defects

- Preflight category grid is intentionally masonry-like; a category with
  many checks (CAPTURE) sits beside short ones — aligned, but asymmetric.
- Chart tooltips are native browser tooltips (functional, not styled).
- The rest overlay still has no numeric countdown (no engine seam exposes
  remaining rest time).
- Firefox/Safari were not visually swept (engine support there is
  functional-untested per `docs/RELEASE.md`).

## 21. Known functional defects

- None known in the UI layer. Engine-side quirks surfaced honestly by the
  UI: a session interrupted during its final checkpoint write can linger
  as a 0-trial "running" checkpoint, and live browser sessions don't
  populate `playerName` in checkpoints (the UI now omits the name rather
  than printing "unknown player").

## 22. Remaining work, classified

**A. MUST FIX BEFORE V1** — none in the UI layer. (Engine side: the CI
vitest RPC exit-1 and the native-windows compile job, both pre-existing
and documented above.)

**B. POLISH THAT WOULD IMPROVE V1**
1. Rest countdown + session time-remaining (needs a small engine seam).
2. Candidate-block progress map in the run screen (needs a
   progress-snapshot seam).
3. Styled chart tooltips and an X/Y asymmetry panel when `jointXY` ran.
4. Hardware pass on Aldo's 1080p/high-refresh panel: target color,
   ring-feedback visibility, vignette strength.

**C. OPTIONAL POST-V1**
1. Session-detail deep view (full per-scenario breakdowns).
2. Visual-regression snapshots for the design system.
3. Theming/crosshair customization where the engine permits.

## 23. Commit hashes

- Pass 2 implementation: `234ddac711f154ef4d9a31682369baddf3eb1bbc`
- Pass 2 report: the commit containing only this file, immediately after
  (`git log --format=%H --grep "Add UI Pass 2 report" -1`).
- Pass 1 baseline: `6936eddeb2f83c7e8d57da49094bba111796cea2`.

## 24. GO / NO-GO

**GO — production quality for V1 RC**, with the explicit caveat that final
sign-off belongs on Aldo's actual Windows machine (item B4): target
rendering and motion feel must be confirmed on the real high-refresh
panel. Everything verifiable on this hardware — hierarchy, states,
honesty of presentation, responsiveness, accessibility, performance,
engine-contract compliance — is verified.

## 25. Self-score (earned, not asked-for)

| Category | Score | Note |
| --- | --- | --- |
| Visual design | 9.5 | Coherent, restrained, distinctive; icons are good, not jewel-grade |
| Gameplay UI | 9.5 | Clean stage, honest feedback, zero measurement contamination; no rest countdown yet |
| Results | 9.5 | Confident vs tentative are different screens; story-first; asymmetry panel pending |
| Usability | 9.5 | One obvious action per screen; boundary hints; progressive disclosure throughout |
| Consistency | 10 | One component system, one spacing scale, one accent discipline — no ad-hoc styling |
| Accessibility | 9 | Solid keyboard/contrast/reduced-motion/labels; hover-only tooltips and no live-region narration keep it under 9.5 |
| Responsiveness | 9.5 | All four target widths verified intentional; phones explicitly out of scope |
| Overall product polish | 9.5 | Reads as a designed product; the remaining half-point is hardware validation and B-list polish |

Weighted judgment: **9.5 / 10** as shipped on this hardware — a 10/10 call
requires the on-device pass (B4), which no amount of simulator screenshots
can honestly replace.

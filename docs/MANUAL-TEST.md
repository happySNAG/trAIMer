# Manual test harness — Aldo's Windows PC validation

This is THE checklist for the first real session on Aldo's machine.
Work top-to-bottom; do not skip ahead. Record PASS/FAIL plus evidence
(screenshot, file, or note) for every row. If a HARD-GATE row fails,
stop and fix before continuing.

Setup on the day:

```
1. Copy Aldo-Aim-Lab-v*-windows-x64.zip to the desktop; extract it.
2. Double-click start-aldo-lab.ps1 ("Run with PowerShell").
3. Keep the launcher window open for the whole session.
```

Evidence goes in the `Evidence` column: screenshot name / exported file /
one-line note. Export the **hardware validation bundle** at step 15 and
attach it to the report.

## A — Artifact verification (before anything runs)

| # | Check | Expected | Gate | Evidence |
|---|-------|----------|------|----------|
| A1 | Zip SHA-256 matches the value printed by CI (`SHA256:` line in the windows-release job summary) | identical | HARD | |
| A2 | `manifest.json` next to `app/` lists every release file + `helperBinaryIsPlaceholder: false` | true/false flag correct | HARD | |
| A3 | `aldo_capture_helper.exe` exists beside `start-aldo-lab.ps1`, is a real exe (>100 KB) | present | HARD | |
| A4 | `verify-release.mjs --release-dir .` passes inside the extracted folder (run from a Node prompt if available; optional on-site) | all ✓ | soft | |

## B — Launcher start/stop

| # | Check | Expected | Gate | Evidence |
|---|-------|----------|------|----------|
| B1 | Run `start-aldo-lab.ps1` | Browser opens automatically to `http://127.0.0.1:488xx/index.html?token=…`; launcher shows "capture helper : ws://127.0.0.1:48765" | HARD | |
| B2 | SmartScreen/firewall prompts | Approve once; helper allowed on loopback only | HARD | |
| B3 | Run `start-aldo-lab.ps1` again while running | Clear "already running" message, no second helper | | |
| B4 | Run `stop-aldo-lab.ps1` from another terminal (or close launcher window) | Helper + server stop; window prints "Stopped" | HARD | |
| B5 | Start again after stop | Works cleanly (no port conflicts) | | |

## C — Machine facts

| # | Check | Expected | Gate | Evidence |
|---|-------|----------|------|----------|
| C1 | Windows display scaling (Settings → Display) | Record it (100/125/150/200%) | record | |
| C2 | Monitor refresh rate (Advanced display settings) | Record it (e.g. 200 Hz); set the GPU driver to the max, not 60 Hz | HARD | |
| C3 | Mouse polling rate (vendor tool or online checker) | Record it (125/250/500/1000 Hz) | HARD | |
| C4 | Chrome or Edge version ≥ 114, Firefox NOT used for the session | primary browser confirmed | HARD | |

## D — In-app readiness (browser)

| # | Check | Expected | Gate | Evidence |
|---|-------|----------|------|----------|
| D1 | Home tab loads; footer shows app + engine versions | versions visible | | |
| D2 | Test tab → readiness checks | No BLOCKED verdicts; DPI/sens configured; capture group green or warning-only | HARD | |
| D3 | Diagnostics tab shows capture path | "pointermove-coalesced" expected on Chrome/Edge | HARD | |
| D4 | Diagnostics → connect to helper (`ws://127.0.0.1:48765`) and run the live probe ~5 s while moving the mouse | verdict pass; observed rate ≈ mouse polling rate (C3); jitter/drops low | HARD | |
| D5 | Export **hardware validation bundle** (Diagnostics) | File downloads; keep it | HARD | |

## E — Pointer-lock measurement sanity

| # | Check | Expected | Gate | Evidence |
|---|-------|----------|------|----------|
| E1 | Start a short session; click arena | OS cursor disappears; reticle appears; HUD counts trials | HARD | |
| E2 | Move mouse slowly then fast | Reticle tracks raw movement; targets clickable; hit ring feedback only | | |
| E3 | Press Esc mid-trial | Session ends visibly ("Session ended"), completed trials saved, no silent continuation | HARD | |
| E4 | Alt+Tab mid-session, return | Trial invalidated (POINTER_LOCK_LOST/focus), session aborts honestly — restart session afterwards | HARD | |
| E5 | Resize/window-drag during a trial | Trial flagged RESIZE_DURING_TRIAL (or aborted); never silently kept | | |
| E6 | Unplug/replug the mouse between trials | Next trials still capture; if not, preflight/diagnostics says so | | |
| E7 | Complete the full session (~70 trials incl. rests) | Results tab opens automatically | HARD | |

## F — Results / history / data

| # | Check | Expected | Gate | Evidence |
|---|-------|----------|------|----------|
| F1 | Results screen | Recommended X/Y, eDPI, plausible range, confidence label matches wording, ONE clear next action | HARD | |
| F2 | History tab | The finished session listed; charts render | | |
| F3 | Data tab → Back up all data | JSON backup downloads; size sane | HARD | |
| F4 | Restore the same backup after wiping site data (DevTools → Application → Clear storage) | Restored count > 0; History shows the session again | HARD | |
| F5 | Calibration tab: run one guided axis rep set | Engine accepts adequate data / refuses inadequate with reasons | | |

## G — Crash/resume

| # | Check | Expected | Gate | Evidence |
|---|-------|----------|------|----------|
| G1 | Start session, complete ≥ 2 trials, kill browser tab mid-block | Checkpoint remains (Test/Home shows resumable session) | HARD | |
| G2 | Resume flow | Completed steps are NOT repeated; explanation dialog shown; session continues or ends cleanly per engine plan | HARD | |
| G3 | Discard flow | Checkpoint marked ended; raw history preserved | | |

## H — Close-out

| # | Check | Expected | Gate | Evidence |
|---|-------|----------|------|----------|
| H1 | Export hardware validation bundle AGAIN (post-session state) | sessions.total ≥ 1; warnings reviewed | HARD | |
| H2 | Stop launcher; confirm helper process gone (Task Manager) | clean exit | HARD | |
| H3 | Copy to report: zip SHA-256, scaling %, refresh Hz, polling Hz, observed capture rate, both bundle files | recorded | HARD | |

## Headless verification (dev machine, before the visit)

```bash
npm test            # engine suite — must exit 0
npm run test:browser
npm run build && npm run package:dry-run && npm run verify:release
npm run audit:no-telemetry && npm audit
```

## Known honest limits (do not "fix" on-site)

- Simulated refresh-rate/polling tests cover logic only; C2–C4/D4 are the
  real-hardware counterparts.
- Native tier-1 trust requires a passing D4 probe; otherwise the session
  runs in browser capture with reduced-confidence labels — that is the
  designed degradation, not a bug.

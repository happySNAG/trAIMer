# Manual test harness — run Aldo Aim Lab locally

## Start

```bash
npm install
npm run app          # vite dev server → http://localhost:5173
```

Production build check: `npm run build` (outputs `dist-app/`).
No accounts, keys, network services, or telemetry are involved.

## Smoke-test checklist

| # | Check | Expected |
|---|---|---|
| 1 | Open http://localhost:5173 | Setup tab visible |
| 2 | Enter player name, DPI 800, X=Y=7 %, seed; press **Start session** | Run tab opens with canvas |
| 3 | Click the canvas | OS cursor disappears; crosshair reticle appears centered (**Pointer Lock**) |
| 4 | Move the mouse | Reticle moves with raw deltas, clamped at edges; HUD shows `state: …` |
| 5 | First trials are warmups | HUD shows `warmup · <scenario>`; no numeric sensitivity anywhere on screen (blinding) |
| 6 | Static flick target | Blue disc spawns off-center; click destroys it; HUD shows `hit`/`missed` |
| 7 | Small-target flick (`flick-static-small`) | Smaller disc behaves identically |
| 8 | Moving-target flick (`flick-dynamic-horizontal`) | Target strafes horizontally; leading shots connect |
| 9 | Target switch (`target-switch-triple`) | Three targets spawn in sequence; each click removes one |
| 10 | Tracking (`tracking-smooth-sine`) | Continuous path for ~6 s; no clicks needed; ends automatically |
| 11 | Press **Pause** mid-block | Overlay "Paused."; **Resume** continues the same block |
| 12 | Press Escape / alt-tab during a trial | Pointer lock drops; trial is aborted, persisted as invalid with `POINTER_LOCK_LOSS`; session aborts without silent continuation |
| 13 | Resize window >10 % mid-trial | Trial flagged `RESIZE_DURING_TRIAL` |
| 14 | Long stretch (>12 min) or degrading acquisition times | Forced rest overlay appears; block resumes after rest |
| 15 | Candidate transition | Rest overlay between blocks; ordering is randomized per seed |
| 16 | Completion | "Session complete" overlay → Results tab opens automatically |
| 17 | Results tab | Recommended X/Y, DPI, eDPI, range, confidence, warnings, analyzed/excluded counts, dimension estimates, candidate table, rationale lines, further-testing flag |
| 18 | Reload page mid-experiment | Relaunching a new session works; previous checkpoint remains under Data tab |
| 19 | Data tab | Sessions listed from IndexedDB; export downloads a versioned JSON bundle |
| 20 | Import bundle | File picker accepts an exported bundle; status reports imported trial count |
| 21 | Calibration tab | Follow on-screen instructions; reps recorded; outliers flagged; inadequate data refuses to save as calibrated |

## Headless verification

```bash
npm test        # full automated suite (engine + campaigns + persistence)
npm run build   # production bundle compiles
```

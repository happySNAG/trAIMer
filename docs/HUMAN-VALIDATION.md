# Human validation protocol (for Aldo)

A practical, realistic protocol for producing trustworthy sensitivity
recommendations with repeated sessions. No lab equipment needed — just the
browser app, your mouse, and Fortnite settings you can copy.

## Before the first session (one-time)

1. Run the **Calibration tab** procedure once so cm/360 values are available
   (optional but recommended).
2. Note your current Fortnite X/Y and DPI in the Setup tab.
3. Close heavy background apps; use the same mouse/pad/desk setup every time.

## Session shape

| Item | Value |
|---|---|
| Warmup per candidate block | 2 trials (not scored) |
| Measured trials per candidate | 8–10 per round |
| Candidates | 5 (auto-generated around your current sens) |
| Rounds | 2 (the second round re-tests candidates adaptively) |
| Active time | ~15–25 min |
| Forced rest | every 12 min of continuous play, or when the app detects slowing |
| Between-candidate rest | 15 s (automatic) |

## How many sessions?

- **3 sessions minimum** before trusting any recommendation.
- Sessions 1–2 establish test/retest stability; session 3 confirms.
- Stop early only if two consecutive sessions agree closely:
  recommended eDPI within ~±10 % AND same best candidate AND confidence ≥ moderate.

## During a session

- Play normally; do not look at numbers — candidates are blinded on purpose.
- If real life interrupts (someone talks to you, phone, cramp): press
  **Pause**, not Cancel. Cancel only if the session is unrecoverable.
- Do not resize the window mid-trial; it invalidates the trial.
- If Pointer Lock drops, the trial is invalidated automatically — click back
  in and finish the session; do not restart from scratch.

## When NOT to trust the recommendation

Treat a recommendation as provisional if any of these appear:

- confidence label is **low**, or "high confidence refused"
- "unresolved boundary" warning appears (the true optimum may be outside the
  tested range)
- "capture quality is degraded" warning (event rate too low, lock losses,
  resizes)
- fewer than 3 candidates had valid data
- it suggests a change larger than ±20 % after a single short session — the
  staged-change safety will cap the applied step, and you should retest first
- adaptation note says late-session improvement was detected (you were still
  warming up mid-session)

## Comparing repeated results

After at least two sessions, export both bundles (Data tab) or compare the
Results screens:

1. **Recommended eDPI drift**: within ±10 % → stable; beyond ±25 % → keep
   testing; the middle is inconclusive.
2. **Best candidate**: identical → stable ranking; different → inconclusive.
3. **Prior recommendation inside new range**: yes is reassuring; no means the
   new session disagrees materially.
4. **Dimension estimates**: large swings in accuracy/tracking between sessions
   mean those dimensions are too noisy to trust yet.
5. Confidence labels should match directionally; a "low" followed by "high" is
   itself informative — run one more session.

The engine's `compareSessions` output (in exported bundles as
`reliabilitySummary`) reports exactly these quantities; treat them as
descriptive diagnostics, not validated statistics.

## Realistic expectations

- A recommendation narrows your search; it does not replace feel.
- Expect to converge over 3–5 sessions across at least a week of play.
- Big jumps almost never survive adaptation: prefer the staged-change plan
  when the app offers one.

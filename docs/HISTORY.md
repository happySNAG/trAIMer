# History engine (Pass 4)

`src/history/api.ts` exposes a stable, UI-independent API over the existing
persistence envelopes. It returns typed view models only; charts/styling are
owned by the design pass (`docs/UI-CONTRACT.md`).

## API surface

| Method | Returns |
| --- | --- |
| `listSessions()` | `SessionSummaryViewModel[]` — player, dates, trials, eDPI/range/confidence, quality score, optimizer version, retest link |
| `trends()` | X %, Y %, eDPI, confidence, capture-quality series as `{experimentId, atIso, value}` points |
| `rankingHistory()` | per-session candidate rows with rank 1 = winner |
| `dimensionTrend()` | per-dimension mean/SE across sessions |
| `calibrationHistory()` | axis, date, deg/count@100, DPI, adequacy (never deleted) |
| `retestLineage()` | prior → retest experiment edges |
| `deviceHistory()` | UA/platform/screen/coalescing per session |
| `optimizerVersionHistory()` | which optimizer produced each result |
| `snapshot()` | all of the above in one call |

Everything is derived from stored envelopes at read time — no duplicate
storage, no write-path changes. The History tab renders these models
directly.

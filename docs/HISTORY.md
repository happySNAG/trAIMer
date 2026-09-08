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

## Game Profile Pass 1 addition

`SessionSummaryViewModel` gained `gameConversion:
SessionGameConversionRecord | null`. It is populated from the persisted
session's optional `gameConversion` field through
`readSessionGameConversionRecord()`, which returns `null` for anything it does
not recognise — an unreadable game record must never make an otherwise valid
historical session unreadable.

Every session recorded before game profiles existed reports `null` here, and
its stored result is never re-interpreted under a profile it never used.

## Pass 15 addition — candidate-gain validity

`SessionSummaryViewModel` gained three fields:

| Field | Meaning |
| --- | --- |
| `arenaGain` | `SessionArenaGainRecord \| null` — the sensitivity the session's arena actually applied, per candidate |
| `candidateGainApplied` | whether the player physically experienced the sensitivities the session compared |
| `candidateGainWarning` | the sentence to show wherever that session's recommended sensitivity is shown, or `null` |

**Absence of the stored `arenaGain` field is the marker.** Every session
recorded before 1.0.0-rc.9 ran on an arena that moved the crosshair one logical
pixel per mouse count for every candidate (docs/ARENA-SENSITIVITY.md §1), so it
simply does not have the field, and `candidateGainApplied` is `false`.

That is a statement about the **recommended sensitivity only**. The drills,
trials, timings, capture quality and per-dimension scores of an affected
session are unaffected and are kept in full. Nothing historical is rewritten
and nothing is deleted.

An experiment with a recommendation but no human-session artifact (a bundle
import, a CLI run) reports `false` as well: it cannot testify that its arena
applied candidate gain, and unproven is not the same as good.

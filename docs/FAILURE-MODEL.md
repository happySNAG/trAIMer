# Failure model & diagnostics

## Typed error categories (`src/errors/types.ts`)

| Category | Meaning | Retryable |
| --- | --- | --- |
| user-correctable | bad input, unexpected condition | case-by-case |
| capture | capture source/transport failures | usually yes |
| persistence | local write/read failures | yes |
| corrupted-data | envelopes/checkpoints that fail validation | no (fail-safe applied) |
| optimizer | analysis failures / refusals | no |
| unsupported-environment | missing browser capabilities | no |
| calibration | inadequate or stale calibration usage | yes |

Contract: errors crossing to the UI are `AimLabError` with
`category`, `code`, safe `userMessage` (no stack traces, no internals — the
original error is preserved on `cause` and in diagnostic details),
machine-readable `details`. `guardedWrite()` wraps persistence so callers get
`{ok:false,error}` instead of thrown surprises.

## Failure-injection matrix (tested in `tests/failureInjection.test.ts`)

| Fault | Expected fail-safe behavior |
| --- | --- |
| native helper disconnect | transport fails loudly; mid-trial → trial invalidated via `native-disconnect`; negotiation records transition; explicit inter-trial fallback only |
| IndexedDB write failure | typed retryable persistence error; caller keeps state consistent |
| corrupted checkpoint | `parseResumeCheckpoint` throws; resume refused; UI offers export/discard |
| malformed import bundle | rejected with reason; zero partial state written |
| future schema version | rejected ("newer than supported") |
| optimizer starved of valid trials | low-confidence refusal recommendation, never an exception |
| clock anomaly (timestamp regression) | trial excluded by validation (`IMPOSSIBLE_TIMESTAMPS`) |
| missing trial samples | fatal validation reason; excluded from scoring |
| invalid calibration artifact | flagged inadequate; parameters NEVER produced |
| duplicate/malformed native frames | stream aborts (fail closed), counters show zero partial ingestion |

## Local observability

`LocalDiagnosticLog` (in-memory, rotating at 2000 entries) records app boot +
versions, capture mode, session transitions, validation failures, native
lifecycle, optimizer summaries and error codes. **No remote telemetry exists;
nothing leaves the machine.** "Export Diagnostic Bundle" produces a JSON
containing only these entries plus release metadata — no raw input samples,
no file contents.

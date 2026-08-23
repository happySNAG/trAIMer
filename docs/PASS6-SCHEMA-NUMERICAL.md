# Pass 6 — Schema/Migration & Numerical Robustness Findings

## 1. Schema/migration fuzzing

`tests/schemaFuzz.test.ts` attacks every persisted-artifact boundary with
deterministic mutation campaigns (27 envelope mutators, 12 backup attack
shapes, 8 bundle mutations, hostile store paths):

| Boundary | Result |
| --- | --- |
| Envelope unwrap (wrong/future/negative/NaN schemaVersion, wrong kind, missing fields, prototype-pollution shapes, future unknown fields) | rejects cleanly or accepts only structurally intact payloads; original never mutated |
| Store paths (`trials/../profiles/…`, empty, dotfiles, encoded traversal) | all rejected; zero files written (S9 fix) |
| Corrupted stored JSON | typed load failure, no partial state |
| Backups (checksum mismatch, truncated entries array, oversized 500 k-entry arrays, deep-nesting JSON bombs in entries, path attacks) | every attack rejected with ZERO partial mutation |
| Bundles (wrong kind, future schema, tampered checksum, duplicated trial IDs, null definition, corrupted scenario enum, non-string timestamps) | rejected pre-write; store stays empty |

Fail-closed principle held everywhere: **no partial mutation was ever
observed** across the campaign.

## 2. Numerical robustness

`tests/numericalRobustness.test.ts` attacks core math with NaN, ±Infinity,
denormals (~1e-320), huge magnitudes (1e300), singular/degenerate surfaces,
nearly identical candidates, giant/duplicate timestamps.

Defects FOUND and FIXED this pass:

1. `computeConfidence({utilityGapZ: NaN})` returned **NaN confidence** — now
   treated as missing evidence (0.15 floor). `labelForConfidence` also made
   NaN-safe.
2. `normalQuantile(NaN)` silently returned NaN (comparisons false) — now
   throws on any non-finite/out-of-range p. `normalCdf(NaN)` maps to 0.5.
3. Simulator negative-fatigue configs could drive effective reaction/trigger
   medians negative → `lognormal(negative)` → NaN timestamps poisoning the
   virtual clock for ALL later trials (found via the warming player family).
   Fixed at the source (offset clamp + median floors) AND defensively:
   `TrialRecorder.finish` now fails records closed on any non-finite value so
   raw-record consumers without a later validation pass are safe by
   construction; scenario-center aggregation skips non-finite dimension
   values so one poisoned value can no longer turn a whole scenario's center
   NaN.

Behavior verified as already-safe: `fitQuadraticWeighted` refuses
NaN/Infinity/singular inputs (returns null); huge-magnitude fits either stay
finite or refuse; adequacy excludes non-finite utilities instead of
poisoning shape classification.

Contract upheld everywhere: results are finite + bounded, explicitly refused,
or typed invalid — never a silent NaN.

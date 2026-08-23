# Persistence model

Local-first, file-backed, no cloud, no network. One player/device per store.

## Layout

```
<root>/
  profiles/<playerId>.json
  sessions/<sessionId>.json
  experiments/<experimentId>.json
  trials/<experimentId>/<trialId>.json      ← raw samples, verbatim
  recommendations/<experimentId>.json
  optimizer-runs/<experimentId>.json        ← optimizer version + weights + config
```

`LocalJsonStore` (Node `fs/promises`) implements typed save/load wrappers plus
generic `saveRaw`/`loadRaw`. Path segments are validated against
`^[A-Za-z0-9._-]+$`.

## Versioned envelopes

Every stored document is:

```json
{
  "schemaVersion": 1,
  "kind": "trial-record",
  "savedAtIso": "2026-08-22T15:00:00.000Z",
  "payload": { ... }
}
```

- Current version: `SCHEMA_VERSION = 1` (`src/domain/schema.ts`).
- Reading runs the payload through the migration registry
  (`src/persistence/migrations.ts`) until it reaches the current version.
  Each step is `{fromVersion, toVersion, migrate(payload)}`; steps are
  registered per kind and sorted into chains.
- Unknown/missing migration paths throw with the exact version gap — old data
  is never silently reinterpreted, and newer-than-supported data fails loudly.
- `loadRaw` returns `{payload, migratedFrom}` so callers can detect migrated
  documents.

**Shipped example**: a v0 trial record using `{t, pos}` sample fields migrates
to v1 `{tMs, cursor, dx, dy}` with deltas integrated from position differences.
This doubles as the template for future migrations: write the legacy shape,
register one pure function, test the round trip.

## Raw-first guarantee

Trial payloads persist the complete `samples`, `targets`, `shots`,
`focusInterruptions`, capture context, and validity result. Derived metrics and
recommendations are *also* persisted (so history survives engine changes), but
never as replacements for raw data — any metric can be recomputed from a stored
trial under the schema version that produced it.

Round-trip tests cover profile/experiment/trial/recommendation shapes, byte-
level sample fidelity, envelope rejection (wrong kind, future version), and the
v0→v1 migration.

## Pass 4 additions

- `session-checkpoint` payloads now carry the resume schema (inner
  schemaVersion 2): blinded labels, rep counters, completed trial ids, audit
  trail, capture-source metadata, versions, interrupted-trial marker. The
  outer envelope machinery is unchanged. See docs/RESUME.md.
- Recommendations gain OPTIONAL fields: `curveAdequacy`,
  `changePointAnalysis`, `jointXY`, `pairedFit`, `captureQualitySession`,
  `engineVersion`, `appVersion`. Old records load unchanged (missing =
  absent).
- Calibration records gain OPTIONAL `estimator`, `qualityScore`,
  `consistency`, `contextFingerprint`, and optional `turns` on measurements.
- History API reads through the same envelopes only; no new kinds.

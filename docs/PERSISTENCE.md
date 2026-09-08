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

## Game Profile Pass 1 additions

Two OPTIONAL fields, no new envelope kind, and no migration:

- `human-session` payloads may carry `gameConversion`, a
  `SessionGameConversionRecord` (`src/games/selection.ts`): profile id and
  conversion-definition version, profile status, DPI, the player's current and
  recommended values, the exact pre-rounding value, the canonical aim in
  degrees per centimetre, cm/360, the conversion method, and the rounding
  fraction the game's own entry grid imposed. Sessions written before game
  profiles existed simply do not have the field; readers treat absence as
  "no game profile", never as an error. Nothing already written is rewritten.
- The app's `traimer-settings` localStorage blob may carry `gameProfile`, a
  `GameProfileSelection`. It stores a profile **id and version**, never a
  display name, so renaming a game later is cosmetic rather than a data-loss
  event. A blob without it reads back as "no game selected".

A saved selection naming a profile this build does not ship is preserved
verbatim so history stays readable; `GameProfileRegistry.checkSelection()`
reports the mismatch instead of reinterpreting the values. See
docs/GAME-PROFILES.md §10.

## Pass 15 addition — `arenaGain`

One more OPTIONAL field on `human-session` payloads, no new envelope kind, and
no migration:

- `arenaGain`, a `SessionArenaGainRecord` (`src/session/arenaGainRecord.ts`):
  the arena physical-model version (`arena-gain-v1`), the anchor the session
  ran against and where it came from, the reference sensitivity and
  degrees-per-centimetre, the arena's px-per-degree constant, the DPI, the
  logical px/count actually applied for every candidate, and the largest ratio
  between any two of them.

**Here, absence carries meaning.** Every session written before 1.0.0-rc.9 ran
on an arena that applied no candidate sensitivity at all, so it does not have
the field — and that is precisely how a reader tells the two generations apart.
`readSessionArenaGainRecord()` returns `null` for anything unrecognised, which
is the same answer as "this session did not apply candidate gain", so an
unreadable record can never make a historical session unreadable.

Nothing already written is rewritten. See docs/ARENA-SENSITIVITY.md §8 and
docs/HISTORY.md.

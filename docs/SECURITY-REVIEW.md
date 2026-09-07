# Security review & anti-cheat boundary (V1 RC)

Scope: local threat model. trAIMer has **no network attack surface by
design** — the no-telemetry audit (`scripts/audit-no-telemetry.mjs`, run in
CI against sources AND the shipped bundle) fails the build on `fetch`,
`XMLHttpRequest`, `sendBeacon`, `EventSource`, non-loopback WebSocket, or any
non-local URL literal in shipped code.

## Anti-cheat boundary review

The capture helper and app are independent observers of desktop mouse input.
Verified by automated test (`tests/nativeProtocolConstants.test.ts`) that the
C source contains NONE of: `CreateRemoteThread`, `WriteProcessMemory`,
`ReadProcessMemory`, `SetWindowsHookEx`, `SendInput`, `mouse_event`,
`LoadLibrary` for injection, `VirtualAllocEx`. The helper:

- registers a message-only window with `RIDEV_INPUTSINK` — it receives raw
  input without focus, exactly like accessibility/input-statistics tools;
- never opens a game process handle, never reads or writes another process's
  memory, never injects DLLs, never synthesizes input, never modifies game
  files;
- communicates only with one token-authenticated client over loopback.

Fortnite's anti-cheat sees an unrelated local process reading Raw Input —
the same signature class as common hardware diagnostics utilities. No
boundary is bypassed; nothing interacts with the game or its protection.

## Findings (Pass 5 review)

| # | Finding | Severity | Resolution |
|---|---|---|---|
| S1 | Transport accepted any URL passed in options | high | `assertLoopbackUrl()` at construction + at every socket-factory use; DNS-lookalike hosts rejected; tested |
| S2 | Unbounded inbound WS messages → memory exhaustion by hostile helper | medium | `NATIVE_TRANSPORT_LIMITS` caps (1 MiB msg / 4096 events per frame); fail-closed; tested |
| S3 | Sequence tracking retained every seen sequence (unbounded growth at 1000 Hz) | low | replaced by strictly-increasing check; duplicates/regressions still fail closed; tested incl. 100 k-frame soak |
| S4 | Backup restore wrote attacker-controlled paths | high | strict whitelist `validateBackupPath`; traversal/absolute/unknown-root rejected BEFORE any write; tested |
| S5 | Session-bundle import could partially mutate on late failure | medium | import now validates EVERY envelope before the first write (zero partial state); tested |
| S6 | Negative bundle schemaVersion slipped the "newer" check | medium | integer ≥ 0 enforced; tested |
| S7 | NaN/Infinity sample values bypassed all numeric validation comparisons | high (data integrity) | explicit non-finite guards in `validateTrial` (fatal `IMPOSSIBLE_TIMESTAMPS`); found BY the Pass 5 adversarial campaign; regression-tested |
| S8 | DOM layer could inject markup via views | info | static test enforces textContent-only rendering (no innerHTML/outerHTML/document.write/insertAdjacentHTML anywhere in `app/src`) |

## Findings (Pass 6 round two)

All regression-tested in `tests/securityRoundTwo.test.ts` and
`tests/schemaFuzz.test.ts`.

| # | Finding | Severity | Resolution |
|---|---|---|---|
| S9 | `LocalJsonStore.saveRaw/loadRaw/listByPrefix` did not validate raw relative paths; a caller could hand `trials/../profiles/...` straight to the backend and escape the storage root on filesystem backends (segment regex allowed `..`) | high | every path segment now validated (`[A-Za-z0-9]` first char — rejects `.`/`..`/dotfiles in one rule) at the store boundary; tested incl. zero-files-written assertion |
| S10 | Bundle import accepted duplicate trial IDs inside one bundle (silent overwrite) and non-string `exportedAtIso` | medium | duplicate-ID rejection + ISO-string type check added to the pre-mutation validation pass; tested |
| S11 | Loopback allowlist vs numeric IP spellings | info (no action needed) | WHATWG URL normalization resolves decimal/hex aliases BEFORE the allowlist comparison, so `ws://2130706433` etc. are provably loopback; public-IP decimals still rejected — documented with tests |
| S12 | Launcher hygiene contract was implicit | medium (hardening) | PowerShell scripts are statically contract-tested: no Invoke-Expression/iex/Invoke-Command, token passed as quoted argument array, RNG token shape validated, GetFullPath traversal guard, TryParse before PID kill |
| S13 | Release archive member paths were unvalidated by construction | low | packager enforces safe archive members (no traversal/drive-letter/double-slash); verify-release recomputes all SHA-256s from disk against manifest.json |
| S14 | Hostile strings in engine metadata | info | FinalResult carries HTML/script payloads verbatim as data (textContent-safe rendering unchanged); tested |

## Data safety

- Whole-database backup (`exportBackupAll`) carries a SHA-256 integrity
  checksum; restore validates checksum + every envelope + every path before
  writing anything (`tests/pass5Engine.test.ts`, `tests/security.test.ts`).
- Session bundles gained integrity metadata with full pre-validation.
- Local data lives in browser IndexedDB under one origin; uninstall = delete
  folder + clear site data. No cloud, no sync.

## Residual risks (accepted for V1)

- A compromised helper binary could lie about input events. Mitigation:
  helper version pinning (`EXPECTED_HELPER_VERSION`, fail-closed handshake),
  CI-compiled binaries attached to signed release tags, and the capture
  self-test cross-checking claimed vs observed rates before tier-1 trust.
- The launcher's static server serves only its own folder on loopback; it
  adds no auth because there is nothing to protect from the same user.

## Round three (Pass 7 — integrated presentation layer)

| # | Finding | Severity | Resolution |
|---|---|---|---|
| S15 | Stored settings blob was trusted on load and at submit (`Number(...) || default` only); a corrupt/hostile/old settings blob (`traimer-settings`, `aldo-aim-lab-settings` before the rename) could poison DPI/sensitivity in session definitions (e.g. dpi = -99999 or 1e9) | medium | `sanitizeSettings()` clamps every numeric field to engine bounds (`PREFLIGHT_THRESHOLDS`, `DEFAULT_SAFE_RANGE`), caps name length, hardens seed; applied on BOTH load and save; browser-tested |
| S16 | Launcher scripts referenced by tests/packaging did not exist in the repository (integration defect) | high (build integrity, not runtime) | real launcher scripts committed with the S12 static contract enforced by tests: RNG token + shape check, loopback-only HttpListener prefix, GetFullPath+StartsWith traversal guard, MIME allowlist, TryParse-guarded PID kills, no shell-interpolation sinks |
| S17 | Presentation-layer XSS re-audit of merged UI | clean | no innerHTML/outerHTML/insertAdjacentHTML/document.write anywhere in app/src (static contract test); hostile display names/ids render as inert text; prototype-pollution shapes via JSON are inert; oversized strings capped at ingest |
| S18 | Token hand-off from launcher to app | info | token travels once via `?token=` query param on first open, shape-validated (`^[0-9a-f]{32}$`) before adoption into localStorage; used solely for the loopback helper handshake |

Regression-tested in `tests/uiContract.test.ts`,
`tests/browser/securityRoundThree.spec.ts`, and
`tests/securityRoundTwo.test.ts`.

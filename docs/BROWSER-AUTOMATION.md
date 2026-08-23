# Browser automation (Playwright)

## Running

```bash
npx playwright install chromium   # once
npm run test:browser              # starts vite + runs specs
```

Config: `playwright.config.ts` (single worker, webServer on :5173).

## Pointer Lock in headless

Headless Chromium does not grant real pointer locks. The app exposes a
clearly-separated test adapter, `app/src/testHooks.ts`, active ONLY when the
app is loaded with `?e2e=1`. It:

- starts the session without a user-gesture lock
  (`BrowserRunControllerOptions.virtualLock` — the runner's requestLock port
  resolves true without touching `requestPointerLock`),
- injects scripted `pointer-sample` / `button` events through the production
  `PointerLockCaptureSource.emitForTesting` path.

No production capture code is forked; the adapter lives entirely in `app/`
and is inert without the query flag. `docs/UI-CONTRACT.md` marks it test-only.

## Coverage

| Spec | Covers |
| --- | --- |
| boot.spec.ts | boot, tabs, version footer, IndexedDB init, Data/History/Diagnostics/Calibration views, settings persistence + clamping |
| persistence.spec.ts | malformed/future bundle import failures with zero partial state; resume checkpoint UI (seeded checkpoint → list with Resume/Discard/Export → discard flow) |
| session.spec.ts | full session: setup → virtual lock → scripted trials through all scenario families → analysis → results rendering |

Representative failure states are asserted by visible typed messages
("import failed…"), never silent.

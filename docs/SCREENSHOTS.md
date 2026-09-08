# Screenshots

The images in `docs/screenshots/` are captured by
`scripts/capture-screenshots.mjs`, not drawn or composited. This file says
exactly what they are, so nobody mistakes them for something they are not,
and lists the frames that still need a human to capture.

## What the current frames are

- **Source:** the real frontend, the same code the Windows installer ships,
  served by the Vite dev server and rendered in Chromium at 1440×900 with
  the dark colour scheme.
- **Driver:** the scripted player the browser test suite uses. Under
  `?e2e=1` Pointer Lock is virtual; capture, recorder, validator, optimizer,
  results, game conversion and persistence are the production paths. The
  numbers on the results frames are the engine's real output for that
  scripted Quick session (Valorant, 0.4 at 800 DPI). They are not a human's
  aim.
- **Platform:** captured on macOS. The frontend is identical on Windows; the
  window frame, the Electron title bar and the installer are not shown.
- **Manifest:** `docs/screenshots/MANIFEST.json` records when the set was
  captured and how.

To regenerate: `node scripts/capture-screenshots.mjs` from a tree where
`npm run app` works. It starts Vite itself, runs the session (about four
minutes) and overwrites the files below.

| File | What it shows |
| --- | --- |
| `01-home.png` | Home: readiness, current loadout, the three-step orientation, Start Aim Test |
| `02-setup-game-picker.png` | Aim Test with Valorant chosen: the game panel, the partly-verified status block above the inputs, the live physical equivalent |
| `02c-setup-experimental-profile.png` | The same panel with PUBG: Battlegrounds chosen: the "(experimental)" list label and the warning block, followed by the calibration-length cards and the Start card |
| `03-arena-shooting-drill.png` | The arena during a shooting drill |
| `04-arena-tracking-drill.png` | The arena during a tracking drill |
| `05-break.png` | A break between candidates, with the countdown and Skip break |
| `06-results-summary.png` | Results: calibration complete, the recommended sensitivity with its range and confidence label, the start of the game conversion |
| `07-results-game-conversion.png` | "Recommended for Valorant": current, recommended and physical equivalent; what to set; warnings; provenance |
| `08-results-advanced.png` | Advanced results, opened |
| `09-history.png` | History with the session's detail open (sensitivity validity, game conversion) |

## Frames that still need a human capture

These cannot be produced by the script in this environment and are
**not** in the repository. Nothing has been fabricated to stand in for them.

| Frame | Why it needs a human | How to capture |
| --- | --- | --- |
| The installer window and the SmartScreen "More info → Run anyway" dialog | Windows-only, interactive | Run `trAIMer-Setup-<version>.exe` on Windows; Win+Shift+S at each step |
| The installed app's window with its title bar and Start Menu / Desktop shortcut | Electron frame is not rendered in a browser capture | Launch the installed app on Windows; capture the window |
| Diagnostics → Native capture check with a real mouse and the helper running | Needs real Raw Input at the mouse's polling rate | Run the check on Windows with the installed app |
| A results screen from a **human** session | The scripted player's aim is not a person's | Complete a Standard or Precision calibration on Windows; capture Results |
| History showing a pre-rc.9 session marked as unable to tell you a sensitivity | Needs stored data from a build older than rc.9 | Open History on a machine that has such sessions |

When a human frame is captured, add it to `docs/screenshots/` with a name
that says what it is (for example `10-windows-installer.png`), list it in
the table above with the date and the build, and note it in
`MANIFEST.json`. Do not replace a scripted frame with an edited one.

## Rules

- Current trAIMer branding only. No frames from before the rename.
- No compositing, annotation layers baked into the image, or invented
  numbers. Annotate in the document, not in the picture.
- Keep each file under about 500 KB; PNG at 1440×900 is fine.

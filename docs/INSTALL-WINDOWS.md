# Installing trAIMer on Windows

> **trAIMer — Train. Measure. Tune.**
>
> Upgrading from *Aldo Aim Lab* (1.0.0-rc.6 or earlier)? Your training
> history, calibration and settings come with you: the first launch moves
> `%APPDATA%\AldoAimLab` to `%APPDATA%\trAIMer` automatically, and the
> installer replaces the old entry rather than adding a second one.
> Upgrading from any later release candidate is an in-place upgrade with your
> history intact; CI installs the previous candidate first and checks this on
> every build.

One file. Double-click it. That is the whole procedure.

## What you need

- `trAIMer-Setup-1.0.0.exe` from the [release page](https://github.com/happySNAG/trAIMer/releases/latest)
  (also published as `trAIMer-Setup.exe`, the same file under a version-free
  name)
- Windows 10 or 11, 64-bit
- A mouse. Any DPI; you will type the DPI in.

You do **not** need PowerShell, a terminal, a browser, a compiler, admin
rights, or any developer tools.

## 1. Download and, if you like, verify

Next to the installer on the release page is `trAIMer-Setup-SHA256.txt`. To
check the download matches it, open PowerShell in the folder you downloaded
to and run:

```powershell
Get-FileHash -Algorithm SHA256 .\trAIMer-Setup-1.0.0.exe
```

The hash it prints should equal the one in the text file. If it does not, do
not run the file.

## 2. The SmartScreen warning

The build is **not code-signed**, so Windows SmartScreen shows "Windows
protected your PC" with an unknown publisher. This is expected. Click
**More info**, then **Run anyway**. Why it is unsigned and what the checksum
does and does not prove: [CODE-SIGNING.md](CODE-SIGNING.md).

## 3. Install

1. Run the installer and click through it.
2. It installs for the current user only: no admin prompt, no services, no
   drivers, no registry changes beyond the standard uninstall entry.
3. When it finishes, a **trAIMer** icon is on the Desktop and in the Start
   Menu.

Default install location: `%LOCALAPPDATA%\Programs\trAIMer`.

## 4. Launch

Double-click the **trAIMer** icon. The window opens and everything starts by
itself: the interface loads inside the app (no browser, no address bar) and
the native capture helper starts hidden in the background.

If Windows Defender or a firewall asks about `traimer_capture_helper.exe`,
allow it. It listens on `127.0.0.1` only and never talks to the network.

Launching a second time brings the window you already have to the front. It
never starts a second copy.

## 5. First run

Open **Test** in the sidebar. The screen reads top to bottom in the order
you need:

1. **Player name and mouse DPI.** DPI is the number set in your mouse
   software (800 and 1600 are common). Keep it the same across sessions.
2. **Starting sensitivity.** Leave the default unless you know what you want
   here; it is trAIMer's own scale, and the next step maps it to your game.
3. **Game.** Pick your game from the list, then type the sensitivity you have
   set in it right now. The panel shows what that is physically, as
   centimetres of mouse travel for one full turn, before any test.
   - A profile marked **(experimental)** in the list, or **Partly verified**
     after you pick it, explains right there what it does and does not
     cover. Experimental profiles can still be used; treat the result as a
     starting point and check it in the game.
   - Choose **Generic / Raw** if your game is not listed. You get the
     result in physical units and can convert it yourself.
4. **How long should this take?** Pick **Quick** (about 3 minutes),
   **Standard** (about 4) or **Precision** (about 8). Every mode runs the
   same drills and the same blinding; a shorter mode simply buys less
   evidence, and the results say so.
5. Press **Start Aim Test**.

Worth doing once before your first real session: **Diagnostics → Native
capture check**. It measures what your mouse delivers and is what lets a
session be graded at the highest confidence. Without it the session is still
valid, just capped lower.

## 6. Running a calibration

1. Click the arena to lock your mouse in.
2. Each drill tells you what to do. **Shooting drills**: click the targets.
   **Tracking drills**: keep your crosshair on the moving target and do not
   click.
3. Candidate sensitivities are shown as letters, never numbers, and each
   candidate feels different. That difference is what you are being asked to
   feel; you are not asked to judge it.
4. Breaks come between candidates. Wait them out or press **Skip break**,
   Space or Enter.
5. Press **Esc** or switch windows at any time to stop safely. Completed
   drills are always saved, and the session can be continued later from
   **Test**.

## 7. Reading the result

**Results** opens when the session ends.

- **Recommended sensitivity** gives the value, the plausible range, and a
  confidence label. If the evidence is thin it says **More data needed** and
  offers **Continue calibration**, which picks up exactly where you stopped.
  It never invents a number to fill the space.
- **Recommended for *your game*** lists what to set, what you are on today,
  and the physical equivalent underneath both. If the game's own slider
  cannot express the exact value, the exact value and the nearest one the
  game accepts are shown side by side.
- **How you performed** and **What to do next** are written for a player.
  **Advanced results** holds every measurement for anyone who wants it.

## 8. Changing the setting in your game

trAIMer never changes a game's settings. Open the game, go to its mouse or
controller settings, and type the values from the "What to set in *your
game*" list. Then play on it for a while; if it feels off, run a **clean
repeat** from **Results** or a new test from **Test**. Large jumps disrupt
trained aim, and the results screen will say when it is recommending a
staged step rather than the full change.

## Close

Close the window. The app stops the capture helper and every process it
started. Nothing is left running.

## If the capture helper does not start

The app still works. It falls back to browser-rate capture, which samples at
frame rate instead of the mouse's full polling rate, and every result is
labelled with the lower confidence that deserves. **Diagnostics** names the
exact reason code and offers **Restart capture helper**.

| Code | Meaning |
| --- | --- |
| `HELPER_MISSING` | The installed helper file is gone — reinstall. |
| `HELPER_SPAWN_FAILED` | Windows refused to start it (usually antivirus quarantine). |
| `HELPER_NOT_READY` | It started but never accepted a local connection. |
| `HELPER_CRASHED` | It exited repeatedly and was not restarted again. |
| `HELPER_NO_FREE_PORT` | Ports 48765–48776 are all occupied. |

The shell writes a plain-text log to `%APPDATA%\trAIMer\logs\desktop.log`. It
stays on the machine. If you report a problem, that file and a diagnostic
bundle from the **Data** tab are the two things that help most.

## Your data

Training history, calibration and settings live in `%APPDATA%\trAIMer`
(moved automatically from `%APPDATA%\AldoAimLab` the first time a build newer
than rc.6 runs). Nothing leaves the machine; see [../PRIVACY.md](../PRIVACY.md).

## Uninstall

**Settings → Apps → trAIMer**, or the Start Menu uninstaller. It removes the
application and **keeps** your data, so a reinstall picks up where you left
off. The uninstaller asks once whether you also want the data deleted; the
default answer, and the answer any silent or automatic uninstall gets, is
**No**.

## What this program does and does not do

It observes physical mouse movement through the documented Windows Raw Input
API, the same mechanism accessibility tools and input-statistics utilities
use, and measures your aim inside its own window.

It does not inject into any process, read or write another program's memory,
hook or synthesise input for other applications, modify game files, or
interact with anti-cheat software in any way. It makes no network connections
beyond `127.0.0.1` on your own PC. There is no account, no telemetry, and
nothing to sign in to. See [../SECURITY.md](../SECURITY.md).

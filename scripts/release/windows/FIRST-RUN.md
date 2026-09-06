# Aldo Aim Lab — portable folder (advanced path)

> **Most people should not use this folder.** The Aldo Aim Lab product is a
> normal Windows installer: run `AldoAimLab-Setup.exe`, then launch the app
> from its Start Menu or Desktop icon. See `docs/INSTALL-WINDOWS.md`.
>
> This portable folder is kept for development and troubleshooting: it runs
> the same engine through PowerShell and an external browser, which is useful
> when you need to isolate a problem to the desktop shell.

Welcome. Everything runs on this PC only: no account, no internet, no
telemetry. Your data stays in this browser's local storage.

## Start it

1. Double-click **start-aldo-lab.ps1** ("Run with PowerShell").
   - It starts the local capture helper and the app, then opens your browser.
   - Keep the black launcher window open while you play.
2. If Windows SmartScreen appears, click **More info → Run anyway**
   (the app is the folder you downloaded; nothing is installed).
3. When you are done, close the launcher window or run
   **stop-aldo-lab.ps1**.

## If the helper could not start

The app still works in **browser capture** mode — measurement just samples
at frame rate instead of your mouse's full polling rate, so results carry a
"limited confidence" label. The launcher tells you when this happens, and
the Diagnostics tab shows which capture source produced your data.

Common fix: approve the Windows Defender / firewall prompt for
`aldo_capture_helper.exe` (it listens on 127.0.0.1 only) and start again.

## First session (about 10 minutes)

1. Open the **Test** tab and confirm the readiness checks are green
   (player name, mouse DPI, starting sensitivity).
2. Press **Start session**, click the arena to lock your mouse in.
3. Play the targets — candidate sensitivities are hidden until the end.
4. Short rests happen automatically; press Pause any time.
5. Your recommendation appears on the **Results** tab with an honest
   confidence label and a suggested next step.

Backup any time from the **Data** tab (export a single file; restore it on
any machine).

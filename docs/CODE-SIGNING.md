# Code signing status

**The trAIMer installer and application are not code-signed.** This is the
honest current state, not an oversight in the documentation.

## What you will see

When you run `trAIMer-Setup-<version>.exe`, Windows SmartScreen shows
"Windows protected your PC" with the publisher listed as unknown. Click
**More info → Run anyway** to continue. Some antivirus products show a
similar prompt for `traimer_capture_helper.exe` the first time the app
starts it; allow it. It listens on `127.0.0.1` only.

This warning is expected for every unsigned program and says nothing about
what the program does. What it does is documented in
[../SECURITY.md](../SECURITY.md).

## How to check what you downloaded

Every release publishes a SHA-256 checksum next to the installer. To verify
on Windows, in PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\trAIMer-Setup-1.0.0-rc.13.exe
```

Compare the printed hash with the one in `trAIMer-Setup-SHA256.txt` on the
release page (letter case does not matter). If they differ, do not run the
file.

The checksum proves the file is the one CI built. It does not prove who
built it; that is what a code-signing certificate would add.

## Why it is unsigned

A Windows code-signing certificate costs money, requires identity
verification of a person or organisation, and, for SmartScreen reputation,
either an Extended Validation certificate or time and download volume on a
standard one. None of that has been done for this project yet. Faking a
signature is not possible and would not be attempted; a self-signed
certificate would not remove the warning and would be misleading.

## Plan

Code signing is a **post-V1 distribution improvement**, not a blocker for the
public release: the software is fully usable unsigned, the checksum lets you
verify the download, and the warning is documented everywhere a player will
meet it.

When it is done, it will be done in CI (the signing step goes in the
`windows-installer` job before the installer is verified), the certificate
will never be committed to the repository, and this document will be updated
to say what the publisher name on the signature is.

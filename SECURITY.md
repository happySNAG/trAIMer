# Security and safety boundary

## What trAIMer does not do

trAIMer measures your aim **inside its own window** and reads physical mouse
movement through the documented Windows Raw Input API. That is the whole
extent of its contact with your system. It does **not**:

- inject code into any process, including games;
- read or write another process's memory;
- hook, intercept or synthesise input for any other application;
- modify game files, game configuration, or protected settings;
- interact with, bypass, or attempt to evade any anti-cheat software;
- send any input anywhere. It only *observes* the mouse events Windows
  delivers to the desktop, the same way accessibility tools and
  input-statistics utilities do.

A game's anti-cheat sees an unrelated local process that has registered for
Raw Input. No boundary is crossed, and nothing touches the game.

These are not just policy. `tests/nativeProtocolConstants.test.ts` fails the
build if the helper's C source contains `CreateRemoteThread`,
`WriteProcessMemory`, `ReadProcessMemory`, `SetWindowsHookEx`, `SendInput`,
`mouse_event`, `VirtualAllocEx`, or `LoadLibrary` used for injection.
`tests/gameProfileBoundary.test.ts` forbids child processes, filesystem
access, process-memory APIs, input injection, window hooking, network APIs
and shell invocation anywhere in the game-profile layer, and asserts that no
profile ships a game file path to edit. Game settings are changed by you, by
hand, from the numbers the app shows.

## The native capture helper

`traimer_capture_helper.exe` is a single-file C program using only documented
Win32 APIs. It exists because a browser window only sees mouse movement at
frame rate; the helper delivers the mouse's full polling rate (125 to 1000+
Hz) with high-resolution timestamps, which is what earns a session the
highest measurement confidence.

Its role and its limits:

- It is started by the desktop shell when the app opens and stopped when the
  app closes. It exits on its own if the app process disappears.
- It listens on `127.0.0.1` only, on one free port between 48765 and 48776.
  It never binds a network interface.
- It serves exactly one client at a time, and only after that client presents
  the session token the shell generated for this launch.
- It sends raw counts, buttons and timestamps as versioned JSON frames. It
  never interpolates or fabricates samples.
- It writes no files and reads no files.
- If it cannot start, the app still works on browser-rate capture and labels
  every result with the lower confidence that deserves.

It is compiled in CI on a Windows runner with MSVC (`/W4 /WX`) and is never
committed as a binary. The release pipeline refuses to ship an installer
whose helper is not a genuine, executing Windows x64 binary. The shell pins
the helper version and fails closed at the handshake if it does not match.

## Running unsigned software

The installer and the application are currently **not code-signed**. Windows
SmartScreen will warn that the publisher is unknown. See
[docs/CODE-SIGNING.md](docs/CODE-SIGNING.md) for what that means and how to
verify what you downloaded against its published SHA-256 checksum.

## Reporting a vulnerability

Please report security problems privately rather than in a public issue.

1. Preferred: use GitHub's private vulnerability reporting on this
   repository (**Security → Report a vulnerability**), if the repository has
   it enabled.
2. Otherwise: open an issue titled "Security: please contact me" with **no
   details of the problem**, and a maintainer will reach out to arrange a
   private channel.

What helps: the version (shown in the app's sidebar footer and in the
installer filename), what you observed, and steps to reproduce. Please do not
include other people's data.

What to expect: an acknowledgement, a fix or a documented decision, and
credit in the release notes if you want it. This is a small open-source
project without a security team or a bug bounty; response times are
best-effort.

## Scope notes

Things that are **not** security issues here, because they are documented
behaviour:

- The SmartScreen warning on an unsigned installer.
- Windows Defender or a firewall asking about the helper listening on
  loopback.
- Diagnostic bundles and backups containing your own session data. They are
  files you create and keep.

The full engineering security review, with the findings from each pass and
how each was resolved, is in [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).

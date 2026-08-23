#!/usr/bin/env bash
# Native build pipeline — Windows target (Pass 5).
#
# Builds aldo_capture_helper.exe. On Windows (MSVC or MinGW) this script
# compiles directly; on other hosts it validates the pipeline configuration
# and emits the exact command an Windows CI runner / the Aldo PC must run.
#
# Usage:
#   scripts/build-native-windows.sh            # validate + print commands
#   scripts/build-native-windows.sh --compile  # actually compile (Windows only)
set -euo pipefail

C_SRC="native/windows/aldo_capture_helper.c"
EXE="native/windows/aldo_capture_helper.exe"

fail() { echo "✗ $*" >&2; exit 1; }

[ -f "$C_SRC" ] || fail "missing $C_SRC"

echo "== native build pipeline (windows-x64) =="

# 1. Configuration validation (works on every host).
grep -Eq '#define PROTOCOL_VERSION[[:space:]]+1' "$C_SRC" || fail "protocol version drift"
grep -Eq '#define HELPER_VERSION[[:space:]]+"helper-1.0.0"' "$C_SRC" || fail "helper version drift"
grep -q 'INADDR_LOOPBACK' "$C_SRC" || fail "loopback bind missing"
node -e '
const fs = require("fs");
const ts = fs.readFileSync("src/version.ts", "utf8");
const c = fs.readFileSync(process.argv[1], "utf8");
const protoTs = /NATIVE_PROTOCOL_VERSION = (\d+)/.exec(ts)[1];
const protoC = /#define PROTOCOL_VERSION\s+(\d+)/.exec(c)[1];
if (protoTs !== protoC) { console.error(`protocol drift: TS=${protoTs} C=${protoC}`); process.exit(1); }
const verTs = /EXPECTED_HELPER_VERSION = "([^"]+)"/.exec(ts)[1];
const verC = /#define HELPER_VERSION\s+"([^"]+)"/.exec(c)[1];
if (verTs !== verC) { console.error(`helper version drift: TS=${verTs} C=${verC}`); process.exit(1); }
console.log("config parity ok: protocol=" + protoTs + " helper=" + verTs);
' "$C_SRC"

echo "✓ configuration validated"

# 2. Compilation.
if [[ "${1:-}" == "--compile" ]]; then
  if command -v cl >/dev/null 2>&1; then
    echo "-- MSVC build --"
    cl //O2 //W4 "$C_SRC" //Fe:"$EXE" ws2_32.lib user32.lib
    echo "✓ built $EXE"
  elif command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    echo "-- MinGW cross build --"
    x86_64-w64-mingw32-gcc -O2 -Wall -o "$EXE" "$C_SRC" -lws2_32 -luser32
    echo "✓ built $EXE"
  else
    fail "--compile requested but no MSVC (cl) or mingw (x86_64-w64-mingw32-gcc) toolchain found"
  fi
else
  cat <<'EOF'
Compilation requires a Windows host (or MinGW cross toolchain). Run there:

  MSVC Developer Prompt:   cl /O2 /W4 native\windows\aldo_capture_helper.c /Fe:native\windows\aldo_capture_helper.exe ws2_32.lib user32.lib
  MinGW:                   gcc -O2 -Wall -o native/windows/aldo_capture_helper.exe native/windows/aldo_capture_helper.c -lws2_32 -luser32

Or re-run this script with --compile on such a host.
EOF
fi

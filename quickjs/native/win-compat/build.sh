#!/bin/sh
# Builds the Windows 7 compatibility DLLs (see Win7Compat.ts): fgsynch.dll and fgprng.dll.
# Usage: build.sh <x64|x86> <output-dir>
set -eu
ARCH="${1:?usage: build.sh <x64|x86> <output-dir>}"
OUT="${2:?usage: build.sh <x64|x86> <output-dir>}"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$ARCH" in
	x64) CC=x86_64-w64-mingw32-gcc ;;
	x86) CC=i686-w64-mingw32-gcc ;;
	*) echo "error: unknown arch '$ARCH'" >&2; exit 2 ;;
esac
command -v "$CC" >/dev/null 2>&1 || { echo "error: $CC is not installed (apt install mingw-w64)" >&2; exit 1; }
mkdir -p "$OUT"
# --kill-at keeps the exports undecorated on 32-bit, which is how importers name them. fgsynch also
# carries a .def, which adds the functions it merely forwards to kernel32.
"$CC" -O2 -shared -Wl,--kill-at -static-libgcc -o "$OUT/fgsynch.dll" "$HERE/fgsynch.c" "$HERE/fgsynch.def" -lkernel32
"$CC" -O2 -shared -Wl,--kill-at -static-libgcc -o "$OUT/fgprng.dll" "$HERE/fgprng.c" -lkernel32
echo "[build] built $OUT/fgsynch.dll and $OUT/fgprng.dll"

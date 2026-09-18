#!/bin/sh
# Builds a quickjs-ng engine for a ForgeGraal target from source.
#
# The published quickjs-ng binaries already cover most targets, and QuickJsRuntime fetches those.
# This exists for the one thing they cannot do: Windows XP. The official 32-bit build imports four
# Vista-era functions (InitOnceExecuteOnce and the three CONDITION_VARIABLE calls), all from a
# single block in the engine's cutils.h. winxp-compat.patch replaces that block with equivalents
# built from CreateSemaphore, CreateEvent, CRITICAL_SECTION and InterlockedCompareExchange, which
# are NT 3.1/4 era, and this script builds with it applied.
#
# Usage:
#   quickjs/build-engine.sh <target> [output-dir]
#
# Targets:
#   win-xp-x86        32-bit Windows, XP-compatible (patched)
#   win-x86           32-bit Windows, stock (Vista and later)
#   win-x64           64-bit Windows, stock
#   native            the host platform
#
# Needs: git, cmake, and for the Windows targets mingw-w64
# (apt: cmake mingw-w64).

set -eu

TARGET="${1:-}"
OUT_DIR="${2:-$(pwd)/quickjs-build}"
QUICKJS_VERSION="${QUICKJS_VERSION:-v0.16.2}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -z "$TARGET" ]; then
	echo "usage: $0 <win-xp-x86|win-x86|win-x64|native> [output-dir]" >&2
	exit 2
fi

for tool in git cmake; do
	command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is not installed" >&2; exit 1; }
done

case "$TARGET" in
	win-xp-x86|win-x86) CC=i686-w64-mingw32-gcc; RC=i686-w64-mingw32-windres; CROSS=1 ;;
	win-x64)            CC=x86_64-w64-mingw32-gcc; RC=x86_64-w64-mingw32-windres; CROSS=1 ;;
	native)             CC=""; RC=""; CROSS=0 ;;
	*) echo "error: unknown target '$TARGET'" >&2; exit 2 ;;
esac

if [ "$CROSS" = "1" ] && ! command -v "$CC" >/dev/null 2>&1; then
	echo "error: $CC is not installed (apt install mingw-w64)" >&2
	exit 1
fi

SRC_DIR="$OUT_DIR/quickjs-ng"
mkdir -p "$OUT_DIR"

if [ ! -d "$SRC_DIR" ]; then
	echo "[quickjs] cloning $QUICKJS_VERSION"
	git clone -q --depth 1 --branch "$QUICKJS_VERSION" https://github.com/quickjs-ng/quickjs.git "$SRC_DIR"
fi

cd "$SRC_DIR"
git checkout -q -- cutils.h 2>/dev/null || true

EXTRA_FLAGS=""
WINNT_ARG=""
if [ "$TARGET" = "win-xp-x86" ]; then
	echo "[quickjs] applying winxp-compat.patch"
	git apply "$SCRIPT_DIR/winxp-compat.patch"
	EXTRA_FLAGS="-DQJS_WINXP_COMPAT"
	# Set through the cache variable the patch adds, because the project appends its own
	# _WIN32_WINNT after CMAKE_C_FLAGS and would otherwise win.
	WINNT_ARG="-DQJS_WIN32_WINNT=0x0501"
fi

BUILD_DIR="$SRC_DIR/build-$TARGET"
rm -rf "$BUILD_DIR"

if [ "$CROSS" = "1" ]; then
	cmake -B "$BUILD_DIR" \
		-DCMAKE_SYSTEM_NAME=Windows \
		-DCMAKE_C_COMPILER="$CC" \
		-DCMAKE_RC_COMPILER="$RC" \
		-DCMAKE_BUILD_TYPE=Release \
		-DQJS_BUILD_LIBC=ON \
		${WINNT_ARG:+"$WINNT_ARG"} \
		-DCMAKE_C_FLAGS="$EXTRA_FLAGS" >/dev/null
else
	cmake -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release -DQJS_BUILD_LIBC=ON >/dev/null
fi

# Only the engine binary is built. run-test262 is skipped on purpose: it calls GetTickCount64,
# which is Vista-only, so it cannot link for the XP target and is not part of the runtime anyway.
echo "[quickjs] building qjs for $TARGET"
cmake --build "$BUILD_DIR" --target qjs_exe -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)" >/dev/null

BINARY="$BUILD_DIR/qjs"
[ -f "$BINARY.exe" ] && BINARY="$BINARY.exe"
[ -f "$BINARY" ] || { echo "error: build produced no binary" >&2; exit 1; }

cp "$BINARY" "$OUT_DIR/"
echo "[quickjs] built $OUT_DIR/$(basename "$BINARY")"

if [ "$TARGET" = "win-xp-x86" ] && command -v i686-w64-mingw32-objdump >/dev/null 2>&1; then
	echo "[quickjs] checking for imports Windows XP does not have"
	FOUND=$(i686-w64-mingw32-objdump -p "$BINARY" | grep -oE \
		"InitOnceExecuteOnce|InitializeConditionVariable|WakeConditionVariable|WakeAllConditionVariable|SleepConditionVariableCS|GetTickCount64|InitializeCriticalSectionEx|InitializeSRWLock" || true)
	if [ -n "$FOUND" ]; then
		echo "[quickjs] FAILED: still imports post-XP functions:" >&2
		echo "$FOUND" | sort -u >&2
		exit 1
	fi
	echo "[quickjs] clean: no post-XP imports"
fi

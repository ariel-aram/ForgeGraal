#!/bin/sh
# Builds the C runtime: quickjs-ng + mbedTLS + miniz + the ForgeGraal native layer.
#
# This is the backend that reaches the oldest machines. The Rust host in runtime/ is preferred
# where it can run, but Rust's standard library for 32-bit Windows imports ProcessPrng (Windows
# 10), WaitOnAddress (Windows 8) and the api-ms-win-core-synch API set (Windows 7), so it cannot
# serve Windows XP or Vista at all. This build uses only Winsock 2 and CryptoAPI, both present
# since the 1990s.
#
# Usage:
#   quickjs/native/build.sh <target> [output-dir]
#
# Targets:
#   win-xp-x86   32-bit Windows, XP-compatible (applies winxp-compat.patch)
#   win-x86      32-bit Windows, stock engine (Vista and later)
#   native       the host platform
#
# Needs: git, cmake, and for the Windows targets mingw-w64.

set -eu

TARGET="${1:-}"
OUT_DIR="${2:-$(pwd)/forgegraal-c-build}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
QUICKJS_DIR="$SCRIPT_DIR/.."
QUICKJS_VERSION="${QUICKJS_VERSION:-v0.16.2}"
MBEDTLS_VERSION="${MBEDTLS_VERSION:-v3.6.2}"
MINIZ_VERSION="${MINIZ_VERSION:-3.0.2}"

if [ -z "$TARGET" ]; then
	echo "usage: $0 <win-xp-x86|win-x86|native> [output-dir]" >&2
	exit 2
fi

for tool in git cmake; do
	command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is not installed" >&2; exit 1; }
done

case "$TARGET" in
	win-xp-x86|win-x86) CC=i686-w64-mingw32-gcc; AR=i686-w64-mingw32-ar; CROSS=1 ;;
	native)             CC="${CC:-cc}"; AR="${AR:-ar}"; CROSS=0 ;;
	*) echo "error: unknown target '$TARGET'" >&2; exit 2 ;;
esac

if [ "$CROSS" = "1" ] && ! command -v "$CC" >/dev/null 2>&1; then
	echo "error: $CC is not installed (apt install mingw-w64)" >&2
	exit 1
fi

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

# ---- sources -------------------------------------------------------------------------------

if [ ! -d quickjs-ng ]; then
	echo "[build] fetching quickjs-ng $QUICKJS_VERSION"
	git clone -q --depth 1 --branch "$QUICKJS_VERSION" https://github.com/quickjs-ng/quickjs.git quickjs-ng
fi
if [ ! -d mbedtls ]; then
	echo "[build] fetching mbedTLS $MBEDTLS_VERSION"
	git clone -q --depth 1 --branch "$MBEDTLS_VERSION" https://github.com/Mbed-TLS/mbedtls.git mbedtls
	(cd mbedtls && git submodule update --init --depth 1 --recursive >/dev/null 2>&1 || true)
fi
if [ ! -f miniz/miniz.c ]; then
	echo "[build] fetching miniz $MINIZ_VERSION"
	mkdir -p miniz
	(cd miniz && curl -sL -o miniz.zip \
		"https://github.com/richgel999/miniz/releases/download/$MINIZ_VERSION/miniz-$MINIZ_VERSION.zip" \
		&& (unzip -oq miniz.zip || python3 -c "import zipfile;zipfile.ZipFile('miniz.zip').extractall('.')"))
fi

# ---- patches -------------------------------------------------------------------------------

XP_FLAGS=""
(cd quickjs-ng && git checkout -q -- . 2>/dev/null || true)
if [ "$TARGET" = "win-xp-x86" ]; then
	echo "[build] applying winxp-compat.patch to the engine"
	(cd quickjs-ng && git apply "$QUICKJS_DIR/winxp-compat.patch")
	# mbedTLS seeds its RNG from BCryptGenRandom, which is Vista and later. CryptGenRandom is
	# the CryptoAPI equivalent and has been present since Windows 95 OSR2.
	echo "[build] switching mbedTLS entropy to CryptoAPI for XP"
	(cd mbedtls && git checkout -q -- library/entropy_poll.c 2>/dev/null || true)
	python3 "$SCRIPT_DIR/patch-mbedtls-xp.py" mbedtls/library/entropy_poll.c
	XP_FLAGS="-DQJS_WINXP_COMPAT -D_WIN32_WINNT=0x0501"
fi

# ---- mbedTLS -------------------------------------------------------------------------------

MBEDTLS_BUILD="mbedtls/build-$TARGET"
if [ ! -f "$MBEDTLS_BUILD/library/libmbedtls.a" ]; then
	echo "[build] building mbedTLS"
	if [ "$CROSS" = "1" ]; then
		cmake -S mbedtls -B "$MBEDTLS_BUILD" \
			-DCMAKE_SYSTEM_NAME=Windows \
			-DCMAKE_C_COMPILER="$CC" \
			-DCMAKE_AR="$(command -v "$AR")" \
			-DCMAKE_BUILD_TYPE=Release \
			-DENABLE_TESTING=OFF -DENABLE_PROGRAMS=OFF \
			-DCMAKE_C_FLAGS="$XP_FLAGS" >/dev/null
	else
		cmake -S mbedtls -B "$MBEDTLS_BUILD" -DCMAKE_BUILD_TYPE=Release \
			-DENABLE_TESTING=OFF -DENABLE_PROGRAMS=OFF >/dev/null
	fi
	cmake --build "$MBEDTLS_BUILD" -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)" >/dev/null
fi

# ---- CA bundle -----------------------------------------------------------------------------

if [ ! -f "$SCRIPT_DIR/ca_bundle.c" ]; then
	echo "[build] generating the CA bundle"
	"$SCRIPT_DIR/gen-ca-bundle.sh"
fi

# ---- link ----------------------------------------------------------------------------------

echo "[build] compiling the runtime for $TARGET"
EXE="forgegraal-c"
[ "$CROSS" = "1" ] && EXE="forgegraal-c.exe"

WIN_LIBS=""
[ "$CROSS" = "1" ] && WIN_LIBS="-lws2_32 -ladvapi32 -lbcrypt"
[ "$TARGET" = "win-xp-x86" ] && WIN_LIBS="-lws2_32 -ladvapi32"

# -DMINIZ_NO_TIME keeps miniz off time() APIs that differ across the old Windows CRTs.
"$CC" -O2 -std=gnu11 -w $XP_FLAGS \
	-D_GNU_SOURCE -DMINIZ_NO_TIME -DMINIZ_NO_STDIO \
	-I quickjs-ng -I mbedtls/include -I miniz -I "$SCRIPT_DIR" \
	-o "$EXE" \
	"$SCRIPT_DIR/fg_main.c" \
	"$SCRIPT_DIR/forgegraal_native.c" \
	"$SCRIPT_DIR/ca_bundle.c" \
	miniz/miniz.c \
	quickjs-ng/quickjs.c quickjs-ng/libregexp.c quickjs-ng/libunicode.c \
	quickjs-ng/dtoa.c quickjs-ng/quickjs-libc.c \
	quickjs-ng/gen/repl.c quickjs-ng/gen/standalone.c \
	-L "$MBEDTLS_BUILD/library" -lmbedtls -lmbedx509 -lmbedcrypto \
	$WIN_LIBS -lm $([ "$CROSS" = "1" ] || echo "-ldl -lpthread -latomic") \
	$([ "$CROSS" = "1" ] && echo "-static-libgcc -static")

echo "[build] built $OUT_DIR/$EXE"

if [ "$TARGET" = "win-xp-x86" ] && command -v i686-w64-mingw32-objdump >/dev/null 2>&1; then
	echo "[build] checking for imports Windows XP does not have"
	FOUND=$(i686-w64-mingw32-objdump -p "$EXE" | grep -oE \
		"InitOnceExecuteOnce|InitializeConditionVariable|WakeConditionVariable|WakeAllConditionVariable|SleepConditionVariableCS|GetTickCount64|InitializeCriticalSectionEx|InitializeSRWLock|AcquireSRWLock[A-Za-z]*|BCryptGenRandom|ProcessPrng|WaitOnAddress|GetSystemTimePreciseAsFileTime|GetFinalPathNameByHandleW" | sort -u || true)
	if [ -n "$FOUND" ]; then
		echo "[build] FAILED: still imports post-XP functions:" >&2
		echo "$FOUND" >&2
		exit 1
	fi
	echo "[build] clean: no post-XP imports"
fi

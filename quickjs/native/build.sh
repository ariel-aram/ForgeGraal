#!/bin/sh
# Builds the Graak native host: quickjs-ng + mbedTLS + miniz + Brotli + the Graak native layer.
#
# This is the only backend Graak ships -- one C binary, every target, no Node.js and no
# second language required to reach it. It uses only Winsock 2 and CryptoAPI on Windows, both
# present since the 1990s, so the same source serves the oldest machines and the newest ones
# without a version split.
#
# Usage:
#   quickjs/native/build.sh <target> [output-dir]
#
# Targets:
#   win-xp-x86   32-bit Windows, XP-compatible (applies winxp-compat.patch)
#   win-x86      32-bit Windows, stock engine (Vista and later)
#   win-x64      64-bit Windows, stock engine (Vista and later)
#   linux-x86    32-bit x86 Linux, statically linked against musl (also what iSH's Alpine
#                userland on iOS actually is, so the same binary serves both)
#   linux-x64    64-bit x86 Linux, statically linked against musl. Deliberately not "native" with
#                a dynamic glibc link: glibc and musl are not ABI-compatible, and a dynamic glibc
#                binary will not even start on a musl system (Alpine, and anything built on it --
#                which is a common Docker base for exactly the kind of small bot this packages).
#                Static musl runs unmodified on both, which is the point of shipping one binary.
#   linux-x64-glibc  64-bit x86 Linux, dynamically linked against glibc instead -- an explicit
#                opt-in for glibc rather than the default (see Graak's --native-libc flag),
#                using the x86_64-linux-gnu triple rather than plain cc so it stays a named,
#                reproducible target independent of what the build host happens to be.
#   linux-x64-musl-dyn, linux-x86-musl-dyn
#                dynamically linked against musl: for Alpine (and iSH), where a native addon is a
#                musl-linked shared library. A static executable cannot dlopen, so these exist for
#                the bots that need one. They need the musl loader on the target, which Alpine has.
#   native       the host platform, using whatever compiler and libc the host provides. For
#                quick local iteration only -- not what any TargetDevice actually builds against.
#
# Needs: git, cmake, mingw-w64 for the Windows targets, x86_64-linux-gnu-gcc (gcc-x86-64-linux-gnu)
# for linux-x64-glibc, and for linux-x86/linux-x64 an i686-linux-musl/x86_64-linux-musl
# cross-compiler on PATH (Debian/Ubuntu ship neither; get one prebuilt from musl.cc, e.g.
# x86_64-linux-musl-cross.tgz, and add its bin/ to PATH).

set -eu

TARGET="${1:-}"
OUT_DIR="${2:-$(pwd)/graak-c-build}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
QUICKJS_DIR="$SCRIPT_DIR/.."
QUICKJS_VERSION="${QUICKJS_VERSION:-v0.16.2}"
MBEDTLS_VERSION="${MBEDTLS_VERSION:-v3.6.2}"
MINIZ_VERSION="${MINIZ_VERSION:-3.0.2}"
WASM3_VERSION="${WASM3_VERSION:-v0.5.0}"
SQLITE_VERSION="${SQLITE_VERSION:-3460100}"
SQLITE_YEAR="${SQLITE_YEAR:-2024}"
LIBFFI_VERSION="${LIBFFI_VERSION:-3.4.6}"
LIBUV_VERSION="${LIBUV_VERSION:-1.48.0}"
BROTLI_VERSION="${BROTLI_VERSION:-v1.1.0}"
ZSTD_VERSION="${ZSTD_VERSION:-v1.5.6}"

if [ -z "$TARGET" ]; then
	echo "usage: $0 <win-xp-x86|win-x86|win-x64|linux-x86|linux-x64|linux-x64-glibc|linux-x64-musl-dyn|linux-x86-musl-dyn|native> [output-dir]" >&2
	exit 2
fi

for tool in git cmake; do
	command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is not installed" >&2; exit 1; }
done

WINDOWS=0
STATIC=1
case "$TARGET" in
	win-xp-x86|win-x86) CC=i686-w64-mingw32-gcc; AR=i686-w64-mingw32-ar; CROSS=1; WINDOWS=1 ;;
	win-x64)            CC=x86_64-w64-mingw32-gcc; AR=x86_64-w64-mingw32-ar; CROSS=1; WINDOWS=1 ;;
	linux-x86)          CC=i686-linux-musl-gcc; AR=i686-linux-musl-ar; CROSS=1 ;;
	linux-x64)          CC=x86_64-linux-musl-gcc; AR=x86_64-linux-musl-ar; CROSS=1 ;;
	linux-x64-glibc)    CC=x86_64-linux-gnu-gcc; AR=x86_64-linux-gnu-ar; CROSS=1; STATIC=0 ;;
	linux-x64-musl-dyn) CC=x86_64-linux-musl-gcc; AR=x86_64-linux-musl-ar; CROSS=1; STATIC=0 ;;
	linux-x86-musl-dyn) CC=i686-linux-musl-gcc; AR=i686-linux-musl-ar; CROSS=1; STATIC=0 ;;
	native)             CC="${CC:-cc}"; AR="${AR:-ar}"; CROSS=0; STATIC=0 ;;
	*) echo "error: unknown target '$TARGET'" >&2; exit 2 ;;
esac

if [ "$CROSS" = "1" ] && ! command -v "$CC" >/dev/null 2>&1; then
	case "$TARGET" in
		linux-x86|linux-x64)
			echo "error: $CC is not installed (get a prebuilt ${CC%-gcc}-cross toolchain from musl.cc and add its bin/ to PATH)" >&2 ;;
		linux-x64-glibc)
			echo "error: $CC is not installed (apt install gcc-x86-64-linux-gnu)" >&2 ;;
		*)
			echo "error: $CC is not installed (apt install mingw-w64)" >&2 ;;
	esac
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

if [ ! -d wasm3 ]; then
	echo "[build] fetching wasm3 $WASM3_VERSION"
	git clone -q --depth 1 --branch "$WASM3_VERSION" https://github.com/wasm3/wasm3.git wasm3
fi

if [ ! -f sqlite/sqlite3.c ]; then
	echo "[build] fetching the SQLite amalgamation $SQLITE_VERSION"
	mkdir -p sqlite
	(cd sqlite && curl -sL -o sqlite.zip "https://www.sqlite.org/$SQLITE_YEAR/sqlite-amalgamation-$SQLITE_VERSION.zip" \
		&& (unzip -oqj sqlite.zip || python3 -c "
import zipfile
z = zipfile.ZipFile('sqlite.zip')
for n in z.namelist():
    if n.endswith(('.c', '.h')):
        open(n.split('/')[-1], 'wb').write(z.read(n))
"))
fi
if [ ! -f libffi/configure ]; then
	echo "[build] fetching libffi $LIBFFI_VERSION"
	mkdir -p libffi
	(cd libffi && curl -sL -o libffi.tar.gz "https://github.com/libffi/libffi/releases/download/v$LIBFFI_VERSION/libffi-$LIBFFI_VERSION.tar.gz" \
		&& tar -xzf libffi.tar.gz --strip-components=1)
fi

if [ ! -f brotli/c/dec/decode.c ]; then
	# Decoder (single-file executables carry their application Brotli-compressed, see fg_sea.c) and encoder (zlib.brotliCompress).
	echo "[build] fetching Brotli $BROTLI_VERSION"
	rm -rf brotli
	git clone -q --depth 1 --branch "$BROTLI_VERSION" https://github.com/google/brotli.git brotli
fi

if [ ! -f zstd/lib/zstd.h ]; then
	# Zstandard (BSD-licensed): zlib.zstdCompress and friends.
	echo "[build] fetching Zstandard $ZSTD_VERSION"
	rm -rf zstd
	git clone -q --depth 1 --branch "$ZSTD_VERSION" https://github.com/facebook/zstd.git zstd
fi

if [ ! -f libuv/include/uv.h ]; then
	# Headers only: an addon that calls libuv directly lays its requests out by them (see napi.c).
	echo "[build] fetching the libuv $LIBUV_VERSION headers"
	mkdir -p libuv
	(cd libuv && curl -sL -o libuv.tar.gz "https://github.com/libuv/libuv/archive/refs/tags/v$LIBUV_VERSION.tar.gz" \
		&& tar -xzf libuv.tar.gz --strip-components=1 "libuv-$LIBUV_VERSION/include")
fi

# ---- patches -------------------------------------------------------------------------------

# The TLS 1.2 server answers a client that does not offer 1.2 with protocol_version, as OpenSSL does. A build made
# before the patch is thrown away so the library is compiled again.
if ! grep -q GRAAK_TLS12_VERSION_ALERT mbedtls/library/ssl_tls12_server.c; then
	echo "[build] patching mbedTLS: protocol_version alert from the TLS 1.2 server"
	python3 "$SCRIPT_DIR/patch-mbedtls-tls12-version.py" mbedtls/library/ssl_tls12_server.c
	rm -rf mbedtls/build-*
fi

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
			-DCMAKE_SYSTEM_NAME="$([ "$WINDOWS" = "1" ] && echo Windows || echo Linux)" \
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

# ---- libffi --------------------------------------------------------------------------------

LIBFFI_BUILD="libffi/build-$TARGET"
if [ ! -f "$LIBFFI_BUILD/.libs/libffi.a" ]; then
	echo "[build] building libffi"
	mkdir -p "$LIBFFI_BUILD"
	FFI_HOST=""
	case "$TARGET" in
		win-xp-x86|win-x86) FFI_HOST="--host=i686-w64-mingw32" ;;
		win-x64)            FFI_HOST="--host=x86_64-w64-mingw32" ;;
		linux-x86|linux-x86-musl-dyn) FFI_HOST="--host=i686-linux-musl" ;;
		linux-x64|linux-x64-musl-dyn) FFI_HOST="--host=x86_64-linux-musl" ;;
		linux-x64-glibc)    FFI_HOST="--host=x86_64-linux-gnu" ;;
	esac
	(cd "$LIBFFI_BUILD" && CC="$CC" AR="$AR" CFLAGS="-O2 $XP_FLAGS" ../configure $FFI_HOST --disable-shared --enable-static \
		--disable-docs --disable-multi-os-directory --disable-exec-static-tramp >/dev/null 2>&1 \
		&& make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)" >/dev/null 2>&1) \
		|| { echo "error: building libffi for $TARGET failed" >&2; exit 1; }
fi

# ---- CA bundle -----------------------------------------------------------------------------

if [ ! -f "$SCRIPT_DIR/ca_bundle.c" ]; then
	echo "[build] generating the CA bundle"
	"$SCRIPT_DIR/gen-ca-bundle.sh"
fi

# ---- link ----------------------------------------------------------------------------------

echo "[build] compiling the runtime for $TARGET"
EXE="graak-c"
[ "$WINDOWS" = "1" ] && EXE="graak-c.exe"

WIN_LIBS=""
[ "$WINDOWS" = "1" ] && WIN_LIBS="-lws2_32 -ladvapi32 -lbcrypt"
[ "$TARGET" = "win-xp-x86" ] && WIN_LIBS="-lws2_32 -ladvapi32"

# Node-API needs the host to export its napi_* functions to the addons it loads: dynamic Linux builds
# link with --export-dynamic, Windows exports them through dllexport, and a static executable cannot
# dlopen anything at all, so those builds compile the loader out and say so when an addon is loaded.
NAPI_CFLAGS=""
NAPI_LDFLAGS=""
if [ "$WINDOWS" != "1" ]; then
	if [ "$STATIC" = "1" ]; then NAPI_CFLAGS="-DFG_NO_DLOPEN"; else NAPI_LDFLAGS="-Wl,--export-dynamic"; fi
fi

# -DMINIZ_NO_TIME keeps miniz off time() APIs that differ across the old Windows CRTs.
"$CC" -O2 -DNDEBUG -std=gnu11 -w $XP_FLAGS \
	-D_GNU_SOURCE -DMINIZ_NO_TIME -DMINIZ_NO_STDIO \
	-DZSTD_DISABLE_ASM -DZSTD_LEGACY_SUPPORT=0 -DDEBUGLEVEL=0 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_DEFAULT_MEMSTATUS=0 -DSQLITE_USE_URI=1 \
	$NAPI_CFLAGS \
	-I quickjs-ng -I mbedtls/include -I mbedtls/library -I miniz -I wasm3/source -I sqlite -I brotli/c/include -I zstd/lib -I zstd/lib/common -I libuv/include -I "$LIBFFI_BUILD/include" -I "$SCRIPT_DIR" -I "$SCRIPT_DIR/include" \
	-o "$EXE" \
	"$SCRIPT_DIR/fg_main.c" \
	"$SCRIPT_DIR/fg_sea.c" \
	"$SCRIPT_DIR/graak_native.c" \
	"$SCRIPT_DIR/napi.c" \
	"$SCRIPT_DIR/fg_uv.c" \
	"$SCRIPT_DIR/fg_wasm.c" \
	"$SCRIPT_DIR/fg_sqlite.c" \
	"$SCRIPT_DIR/fg_crypto.c" \
	"$SCRIPT_DIR/fg_ffi.c" \
	wasm3/source/m3_bind.c wasm3/source/m3_code.c wasm3/source/m3_compile.c wasm3/source/m3_core.c \
	wasm3/source/m3_emit.c wasm3/source/m3_env.c wasm3/source/m3_exec.c wasm3/source/m3_function.c \
	wasm3/source/m3_info.c wasm3/source/m3_module.c wasm3/source/m3_optimize.c wasm3/source/m3_parse.c \
	"$SCRIPT_DIR/ca_bundle.c" \
	miniz/miniz.c \
	brotli/c/common/constants.c brotli/c/common/context.c brotli/c/common/dictionary.c brotli/c/common/platform.c \
	brotli/c/common/shared_dictionary.c brotli/c/common/transform.c \
	brotli/c/dec/bit_reader.c brotli/c/dec/decode.c brotli/c/dec/huffman.c brotli/c/dec/state.c \
	brotli/c/enc/backward_references.c brotli/c/enc/backward_references_hq.c brotli/c/enc/bit_cost.c brotli/c/enc/block_splitter.c brotli/c/enc/brotli_bit_stream.c brotli/c/enc/cluster.c brotli/c/enc/command.c brotli/c/enc/compound_dictionary.c brotli/c/enc/compress_fragment.c brotli/c/enc/compress_fragment_two_pass.c brotli/c/enc/dictionary_hash.c brotli/c/enc/encode.c brotli/c/enc/encoder_dict.c brotli/c/enc/entropy_encode.c brotli/c/enc/fast_log.c brotli/c/enc/histogram.c brotli/c/enc/literal_cost.c brotli/c/enc/memory.c brotli/c/enc/metablock.c brotli/c/enc/static_dict.c brotli/c/enc/utf8_util.c \
	zstd/lib/common/*.c zstd/lib/compress/*.c zstd/lib/decompress/*.c \
	sqlite/sqlite3.c \
	quickjs-ng/quickjs.c quickjs-ng/libregexp.c quickjs-ng/libunicode.c \
	quickjs-ng/dtoa.c quickjs-ng/quickjs-libc.c \
	quickjs-ng/gen/repl.c quickjs-ng/gen/standalone.c \
	-L "$MBEDTLS_BUILD/library" -lmbedtls -lmbedx509 -lmbedcrypto "$LIBFFI_BUILD/.libs/libffi.a" \
	$WIN_LIBS -lm $([ "$WINDOWS" = "1" ] || echo "-ldl -lpthread") \
	$NAPI_LDFLAGS \
	$([ "$WINDOWS" = "1" ] || { [ "$STATIC" = "1" ] && echo "-latomic" || echo "-Wl,-Bstatic -latomic -Wl,-Bdynamic -static-libgcc"; }) \
	$([ "$STATIC" = "1" ] && echo "-static-libgcc -static")

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

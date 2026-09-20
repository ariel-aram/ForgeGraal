<p align="center"><img src="https://raw.githubusercontent.com/ariel-aram/ForgeGraal/main/assets/logo.webp" alt="ForgeGraal logo" width="256"></p>
<h1 align="center">ForgeGraal</h1><p align="center">Standalone executables for ForgeScript powered apps, on every device, with no Node.js required on the device.</p>

<p align="center">
<a href="https://github.com/ariel-aram/ForgeGraal/"><img src="https://img.shields.io/github/package-json/v/ariel-aram/ForgeGraal/main?label=forgegraal&color=5c16d4" alt="forgegraal"></a>
<a href="https://github.com/tryforge/ForgeScript/"><img src="https://img.shields.io/github/package-json/v/tryforge/ForgeScript/main?label=@tryforge/forgescript&color=5c16d4" alt="@tryforge/forgescript"></a>
<a href="https://discord.gg/hcJgjzPvqb"><img src="https://img.shields.io/discord/739934735387721768?logo=discord" alt="Discord"></a>
</p>
<h2 align="center">Contents</h2>

1. [Installation](#installation)
2. [Quick start](#quick-start)
3. [How a build works](#how-a-build-works)
4. [Supported targets](#supported-targets)
5. [Native host (quickjs-ng)](#native-host-quickjs-ng)
   - [The compatibility layer](#the-compatibility-layer)
   - [The C host](#the-native-host-quickjsnative-c)
   - [Native addons (Node-API)](#native-addons-node-api)
   - [Addons written against V8 or NAN](#addons-written-against-v8-or-nan)
   - [Windows 7 compatibility](#windows-what-is-verified-and-what-makes-windows-7-work)
6. [Package managers](#package-managers)
   - [Bun projects](#bun-projects)
   - [Yarn Plug'n'Play](#yarn-plugnplay)
7. [The Node.js path](#the-nodejs-path)
8. [CLI](#cli)
9. [Extension](#extension)
10. [Development](#development)
<br>

<h3 align="center">Installation</h3><hr>

1. Run the following command to install ForgeGraal in your project:
```bash
npm i forgegraal
```
2. Optionally, add it to your client to use `$compileBinary` from inside a bot (see [Extension](#extension)):
```js
const { ForgeClient } = require("@tryforge/forgescript")
const { ForgeGraal } = require("forgegraal")

const client = new ForgeClient({
    ...options // The options you currently have
    extensions: [
        new ForgeGraal({ allowCompile: false })
    ]
})
```
Building for the native host cross-compiles a C binary on your machine (Linux is the build host), so it also
needs `git` and `cmake`, plus, per target: `mingw-w64` for Windows, a prebuilt `x86_64-linux-musl-cross` /
`i686-linux-musl-cross` toolchain from [musl.cc](https://musl.cc) on `PATH` for static Linux and iSH builds, and
`x86_64-linux-gnu-gcc` for `--native-libc glibc`. The build stops and names whatever is missing. Targets that
still use Node.js need only the CLI.

<h3 align="center">Quick start</h3><hr>

1. Build your bot's JavaScript first (TypeScript projects run `tsc`), then compile it:
```bash
npx forgegraal compile dist/index.js --target win-legacy-x64
```
2. Copy the output folder to the device and run the launcher inside it (`<name>.cmd` on Windows, `<name>`
   elsewhere). A native-host build is ready to run as it is; a Node.js build extracts its archive beside the
   executable on first start.
3. List every device with `npx forgegraal targets`, and check one with `npx forgegraal info <target>`.

<br>

---

## How a build works

1. The project (the directory of the closest `package.json`) and its production `node_modules` are collected.
   pnpm and Bun symlink layouts are flattened into a plain, resolvable tree, and a Yarn Plug'n'Play project is
   materialized into one (see [Package managers](#package-managers)). `.env`, `.npmrc`, `.git` and
   devDependencies stay out unless you ask for them.
2. The target decides the engine that runs the bot. Output is one of three strategies:
   - **native host** (default for XP, Vista, Windows 7, iSH, 32-bit Linux and `linux-modern-x64`) — ForgeGraal's
     own C binary, `forgegraal-c`, embedding quickjs-ng. **No Node.js binary is shipped.** The output folder holds
     `forgegraal-c[.exe]`, `runtime/` (the Node-shaped compatibility layer), `app/` (your bot and its
     `node_modules`, as loose files) and a launcher (`<name>.cmd` / `<name>`). Files the bot writes to `app/`,
     SQLite databases included, stay put across rebuilds. See [Native host](#native-host-quickjs-ng).
   - **sea** — a [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
     injected into a target Node.js runtime (>= 20.12). Official runtimes are downloaded and SHA-256 verified.
     The archive is extracted beside the executable on first start (`<name>.forgegraal/app`).
   - **portable** — a folder with the archive, `boot.cjs`, a launcher and the runtime if one is available.
     Chosen automatically when no SEA-capable runtime exists.
3. `--node-binary`, `--strategy sea|portable` or a runtime registered with `forgegraal runtimes add` move any
   native-host target back onto Node.js. Everything else stays on the native host.

The build machine needs Node.js >= 20.12 to run `forgegraal` itself. The compiled bot needs nothing installed on
the device when it targets the native host.

---

## Supported targets

| Target               | Platform                                | Runtime                                                          |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `win-xp-x86`         | Windows XP / Server 2003 (NT 5.1/5.2)   | **native host** (quickjs-ng)                                     |
| `win-vista-x86`      | Windows Vista (32-bit)                  | **native host** (quickjs-ng)                                     |
| `win-vista-x64`      | Windows Vista (64-bit)                  | **native host** (quickjs-ng)                                     |
| `win-legacy-x86`     | Windows 7 (32-bit)                      | **native host** (quickjs-ng)                                     |
| `win-legacy-x64`     | Windows 7 (64-bit)                      | **native host** (quickjs-ng)                                     |
| `ios-ish-x86`        | Alpine (musl i686) under iOS iSH        | **native host** (quickjs-ng)                                     |
| `linux-x86`          | Linux 32-bit (i686)                     | **native host** (quickjs-ng)                                     |
| `linux-modern-x64`   | Linux 64-bit (x86_64)                   | **native host** (quickjs-ng), static musl or `--native-libc glibc` |
| `freebsd-x86`        | FreeBSD 32-bit                          | portable Node.js, installs itself on-device (`pkg`)              |
| `win-x86`            | Windows 10 / 11 (32-bit)                | sea, official Node.js (up to Node 22)                            |
| `linux-armv7`        | Linux ARMv7 (32-bit)                    | sea, official Node.js                                            |
| `win-modern-x64`     | Windows 10 / 11 (64-bit)                | sea, official Node.js                                            |
| `linux-modern-arm64` | Linux ARM64 (AArch64)                   | sea, official Node.js                                            |
| `darwin-x64`         | macOS Intel                             | sea, official Node.js (sign with `codesign --sign -`)            |
| `darwin-arm64`       | macOS Apple Silicon                     | sea, official Node.js (sign with `codesign --sign -`)            |

The native host is the default wherever Node.js itself is the obstacle. Any target can still be moved back onto
Node.js with `--node-binary`, `--strategy sea|portable` or a registered runtime (see [CLI](#cli)).

Every package manager (NPM, PNPM, Yarn, Bun) may build every target, and Yarn Plug'n'Play projects build too.

---

## Native host (quickjs-ng)

Node's own limits, not the hardware's, decide which *language* an old machine may run: Windows 7 is
stuck on Node 12, 32-bit Linux on an unofficial Node 12.16.3. Lowering code to fit that is what the
[legacy pipeline](#the-nodejs-path) does, and it works — but it is treating a symptom.

[quickjs-ng](https://github.com/quickjs-ng/quickjs) does not have that coupling. It is a ~72k-line
C99 engine that publishes *current* builds for exactly the platforms Node abandoned, including
32-bit Windows (1.85 MiB) and 32-bit Linux. `QuickJsRuntime` fetches and checksum-verifies those
binaries; `tools/engine-conformance.js` measures any engine against what a ForgeScript bot actually
needs. Run it against anything: `node tools/engine-conformance.js`, `qjs tools/engine-conformance.js`.

Measured, not assumed:

| | language | builtins | host APIs | node modules | total |
| --- | --- | --- | --- | --- | --- |
| Node.js 26 | 10/10 | 10/10 | 8/8 | 30/30 | **58/58** |
| Node.js 12.22.12 (the Windows 7 pin) | 5/10 | 1/10 | 1/8 | 29/30 | **36/58** |
| quickjs-ng, bare engine | 10/10 | 10/10 | 0/8 | 0/30 | **20/58** |
| quickjs-ng + JavaScript layer | 10/10 | 10/10 | 8/8 | 21/30 | **49/58** |
| quickjs-ng + JavaScript layer + native host | 10/10 | 10/10 | 8/8 | 29/30 | **57/58** |

The one remaining gap is `http2`, and it is left as an error that explains itself rather than a
stub. A working HTTP/2 client needs HPACK header compression, stream multiplexing and flow
control, plus ALPN negotiation in the TLS layer — a protocol implementation in its own right, and
one nothing here needs: Discord's REST API is HTTP/1.1 and its gateway is a WebSocket. A stub that
loaded and then failed somewhere unrelated would be worse than the current message.

### The compatibility layer

`quickjs/runtime/node-compat.js` is the part of Node's surface that can be written in JavaScript,
built on the engine's own `qjs:os` and `qjs:std` primitives: `Buffer`, `events`, `stream`
(Readable/Writable/Duplex/Transform, piping and async iteration), `fs`, `path`, `process`, `util`,
`assert`, `os`, `querystring`, `string_decoder`, `timers`, `diagnostics_channel`, plus
`TextEncoder`/`TextDecoder`, `EventTarget`, `AbortController` and a real `structuredClone`. It also
implements CommonJS `require`, including `node_modules` resolution, so an installed dependency tree
loads.

`quickjs/runtime/selftest.js` runs **unmodified on both runtimes** and is the check that matters —
a layer that merely loads proves nothing. It passes 26/26 on Node, 26/26 on quickjs-ng, and 26/26
on the official 32-bit engine build. `pnpm test` runs that comparison automatically when a `qjs` is
on PATH (or `FORGEGRAAL_QJS` points at one) and skips it otherwise.

With a native host underneath, that layer now covers `net`, `tls`, `http`, `https`, `dns`, `crypto`,
`zlib`, `worker_threads`, `child_process`, `async_hooks`, `v8`, `tty` and `readline`, plus `fetch`,
Web Streams and `Blob`/`File` — and `Intl.Segmenter`, implemented per UAX #29 rather than
approximated: grapheme and word granularity pass Unicode's own conformance files in full
(`GraphemeBreakTest` 1187/1187, `WordBreakTest` 1826/1826). Sentence granularity throws, because
those rules are locale-tailorable and one untailored implementation would be wrong for the locales
that need it.

Without a native host the socket-dependent modules stay unavailable and say so, which is why the
bare-engine row above is 49/58 rather than a number propped up by stubs.

### The native host (`quickjs/native/`, C)

The engine plus a JavaScript compatibility layer still cannot reach Discord: `qjs:os` has no
socket API, so `net`, `tls`, `http` and everything above them are unreachable no matter how much
JavaScript is written. `quickjs/native/` is the missing half — a single C binary, `forgegraal-c`,
that embeds quickjs-ng and supplies exactly the capabilities that require native code, using only
Winsock 2 and CryptoAPI on Windows, both present since the 1990s:

- **TCP and TLS** (mbedTLS). Sockets stay on the native side and are handed to JavaScript as
  integer ids, so a JavaScript bug cannot produce a use-after-free or a descriptor mix-up.
  Certificates verify against a CA bundle compiled into the binary by `gen-ca-bundle.sh` rather
  than the OS store, which is what makes an old machine able to reach Discord at all — a Windows 7
  certificate store is typically a decade stale.
- **Hashing, HMAC and secure randomness** (mbedTLS `md.h`, `ctr_drbg`/`entropy`). A hash written
  in JavaScript would be correct but slow; randomness written in JavaScript would not be random,
  which is a security bug rather than a performance one.
- **Compression** (miniz deflate/inflate/gzip), which the gateway needs.
- **Timers, filesystem and process**, so the JavaScript layer has one host abstraction to target.

One binary, every target — this is the only native host ForgeGraal ships. There is no second
backend to keep in sync (no Rust) and no target that needs different source: the same
`forgegraal_native.c` that reaches Windows XP also reaches the newest 64-bit desktops. Some targets
do need a different cross-compiler to produce that binary, though — see below.

```sh
quickjs/native/build.sh native        # host platform, dynamic link -- local iteration only
quickjs/native/build.sh win-x86       # 32-bit Windows, Vista and later
quickjs/native/build.sh win-x64       # 64-bit Windows, Vista and later
quickjs/native/build.sh win-xp-x86    # 32-bit Windows, XP-compatible
quickjs/native/build.sh linux-x86     # 32-bit x86 Linux, static musl (also serves iSH)
quickjs/native/build.sh linux-x64     # 64-bit x86 Linux, static musl -- the linux-modern-x64 default
quickjs/native/build.sh linux-x64-glibc  # 64-bit x86 Linux, dynamic glibc -- explicit opt-in only
```

`native` is a dynamic link against whatever libc the build host has, meant for quick local
testing — it is not what any `TargetDevice` actually builds against. Every Linux `TargetDevice`
uses a dedicated static-musl cross-compile (`linux-x86`/`linux-x64`) instead, precisely so the
result runs on both glibc and musl systems (Alpine included) unmodified.

The XP build applies two patches: `winxp-compat.patch` for the engine's four Vista-era threading
calls, and `patch-mbedtls-xp.py`, which swaps mbedTLS's `BCryptGenRandom` (Vista, `bcrypt.dll`) for
`CryptGenRandom` (Windows 95 OSR2, `advapi32`). Both draw from the OS CSPRNG; only the API vintage
differs. The build then **verifies the result imports nothing newer than XP and fails if it does**.

Result: a self-contained **2.7 MB** Windows executable — JavaScript engine, TLS stack, compression
and CA bundle included — importing only `KERNEL32`, `msvcrt`, `ADVAPI32` and `WS2_32`.

`quickjs/runtime/native-modules.js` gives that native object Node's shapes, so a library sees
`tls.connect()` and `crypto.createHash()` rather than an integer id. Verified end to end, against
live Discord, on the `native` build:

```
$ ./forgegraal-c quickjs/runtime/native-selftest.js
crypto.createHash sha256: ba7816bf…f20015ad   (matches the known vector)
createHmac sha256       : f7bc83f4…2d1a3cd8   (matches the RFC vector)
zlib deflate/inflate    : true (330 -> 38)
tls.connect status      : HTTP/1.1 200 OK
tls.connect body        : {"url":"wss://gateway.discord.gg"}
```

`pnpm test` runs that same check when `FORGEGRAAL_C` points at a built binary, and skips it
otherwise.

**Windows:** the Windows hosts now run for real under Wine (see "Windows: what is verified" below), which
found and fixed bugs that only exist there. What is still unverified is a real Windows 7 / Vista / XP
machine: Wine implements the newer Windows APIs itself, so it cannot reproduce a Windows 7 load failure.

### Windows XP

The published 32-bit binary declares PE subsystem 4.0, but the imports are what decide, and it
needs four Vista-era functions: `InitOnceExecuteOnce`, `InitializeConditionVariable`,
`WakeConditionVariable`, `SleepConditionVariableCS` — all from one block in the engine's `cutils.h`
guarded by `JS_HAVE_THREADS`.

`quickjs/winxp-compat.patch` replaces that block with equivalents built from `CreateSemaphore`,
`CreateEvent`, `CRITICAL_SECTION` and `InterlockedCompareExchange`, which are NT 3.1/4 era: a
counting-semaphore condition variable with the waiters-done handshake, and an interlocked
`js_once`. `quickjs/build-engine.sh win-xp-x86` fetches the pinned release, applies it, cross-builds
with mingw-w64 and then **verifies the result imports nothing newer than XP**, failing the build if
it does.

```sh
quickjs/build-engine.sh win-xp-x86     # patched, XP-compatible
quickjs/build-engine.sh win-x86        # stock, Vista and later
quickjs/build-engine.sh native
```

Confirmed: the patched build links clean and imports only `CreateEventA`, `CreateSemaphoreA`,
`EnterCriticalSection`, `SetEvent`, `WaitForSingleObject` and `InterlockedCompareExchange`, against
`KERNEL32.dll` and `msvcrt.dll` only. It has **not** been run on real XP hardware — linking clean is
not the same as working, and that check is still outstanding.

### Which targets actually use it

`QuickJsPackager` (`src/compiler/QuickJsPackager.ts`) is what turns the engine plus the native
host into a real build output, and `BinaryPackager` routes a target to it instead of Node.js
whenever `QuickJsPackager.supports(target)` is true. It is the **default**, not an opt-in, for
every target where Node.js itself is the actual problem:

- `linux-modern-x64` — the original proof target: built, run, and verified end to end (a real
  bot, nested `node_modules`, no Node.js anywhere in the output). Built via `quickjs/native/build.sh
  linux-x64`, a static musl binary (same `x86_64-linux-musl-cross` toolchain approach as
  `linux-x86`/iSH below) — deliberately **not** `build.sh native`'s dynamic glibc link, which fails
  outright on a musl system. Confirmed on real Alpine Linux via Docker: the dynamic-glibc build
  exits with a bare `exec: no such file or directory` (a missing ELF interpreter, since glibc and
  musl are not ABI-compatible and Alpine's loader lives elsewhere), while the static musl build
  runs and passes the live-Discord self-test unmodified. Alpine is a common enough Docker base for
  small bots that this was worth fixing rather than leaving as a footnote. A dynamic glibc build
  is still available as an explicit opt-in — `--native-libc glibc` (`nativeLibc: "glibc"` on
  `BinaryPackager.compile()`) builds via `quickjs/native/build.sh linux-x64-glibc` instead. It is
  not the default for the same reason the fix above exists: it will not run on a musl system.
  Requesting `--native-libc glibc` on a target with no glibc build (everything except
  linux-modern-x64, today) fails with a clear error rather than silently falling back to musl.
- `ios-ish-x86` and `linux-x86` — one binary, `quickjs/native/build.sh linux-x86`, a statically
  linked 32-bit x86 ELF against **musl**, serving both (iSH really is an Alpine/musl userland, so
  this is not an approximation). Built with a prebuilt `i686-linux-musl-cross` toolchain from
  musl.cc rather than `gcc-multilib`, which cannot install on this machine at all — the installed
  `gcc-13` (`13.3.0`) and the only available `gcc-13-multilib` (`13.2.0`) are different point
  releases with no compatible build, and fixing that means downgrading the system's default
  compiler, not something worth doing for one build target. The musl.cc toolchain sidesteps the
  system package manager entirely. **Run and verified for real**, not just linked clean: a static
  PIE ELF32 binary that executes directly (this sandbox's kernel runs 32-bit binaries on x86-64
  natively), passing the same live-Discord self-test as every other backend, and a full
  bot-packaging round trip through the actual `BinaryPackager` output.
- `win-xp-x86`, `win-vista-x86`, `win-vista-x64`, `win-legacy-x86`, `win-legacy-x64` — built and
  linked clean via `quickjs/native/build.sh {win-xp-x86,win-x86,win-x64}` (one binary per
  architecture/floor pair covers both the Vista and the "Legacy" Windows 7 target sharing it), and
  checked structurally (right PE machine type, right bitness) and, for x64, run under Wine. **Not yet
  run on a real Windows 7 machine** — see "Windows: what is verified" below.

Still on Node.js, deliberately:

- Every other target (`win-x86`, `win-modern-x64`, `linux-armv7`, `linux-modern-arm64`,
  `darwin-x64`, `darwin-arm64`, `freebsd-x86`) is unaffected by this rollout and keeps building on
  Node.js, with full `npm`/`pnpm`/`yarn`/`bun` support (`PolicyEnforcer.getAllowedTargets` never
  restricted these by package manager; `linux-armv7`/`linux-modern-arm64` is what an Android device
  actually is, and both were already covered before this rollout).

### Native addons (Node-API)

A `.node` file is a shared library that imports `napi_*` functions from the process that loads it.
Nothing in that contract needs Node.js, so the native host implements it itself:
`quickjs/native/napi.c` exports the whole Node-API surface (every function Node's own headers
declare, ~150) on top of the QuickJS C API, and loads the library with `dlopen` / `LoadLibrary`.
Addons built on Node-API run unmodified, on the architecture they were built for.

Verified for real, not by inspection, on the Linux glibc host:

- **`@napi-rs/canvas`** (Skia): draws and encodes a PNG synchronously and asynchronously; the file is
  byte-identical to the one Node.js writes.
- **`sharp`** (libvips): a full image pipeline through async work and a promise.
- **`@gifsx/gifsx`, `bufferutil`, `utf-8-validate`**: load and run, through their real platform
  loaders (`node-gyp-build`, napi-rs's glibc/musl selection).
- A purpose-built fixture addon (`test/fixtures/napi/addon.c`) covering values, strings, objects,
  buffers, callbacks, exceptions, wrapped classes, references, BigInt, async work resolving a
  promise, and a thread-safe function called from a second OS thread. Its output is compared
  against Node.js's, and is identical.

What follows from how it is built:

- **A static host cannot load addons.** A statically linked executable has no dynamic loader, so
  when a bot needs an addon, `linux-modern-x64` automatically gets the dynamically linked glibc host
  instead of the default static musl one, and the build says so. It then runs on glibc systems (most
  distributions) but not on Alpine. `--native-libc musl` with an addon is refused with that
  explanation, and `ios-ish-x86`/`linux-x86`, which have only a static host, say so too.
  Addons that are only optional accelerators (`msgpackr-extract`, `zlib-sync`, `mediaplex`, ...) do
  not trigger any of this: their libraries fall back to JavaScript, so the portable static host is
  kept and the build warns.
- **Windows hosts export the Node-API functions** (they are ordinary dynamic executables), and the
  addon's own delay-load hook binds to them. Run for real under Wine: the fixture addon (async work,
  thread-safe functions, promises) and real Windows prebuilds of better-sqlite3 and @napi-rs/canvas.
- **The addon still has to run on the target's OS.** It is a native binary its authors built for
  some Windows or glibc; on a target older than that, loading fails with the system's own message
  (for example Windows error 127, which the host explains), and the build warns for legacy targets.
- **Addons written against V8 or NAN are rebuilt from source** -- see the next section.
- Getting real packages to run turned up gaps in the Node compatibility layer, fixed at the root
  rather than per package: global `setTimeout`/`setInterval` did not exist in the host; a script
  that threw at top level exited 0 silently (the module's rejected promise was never checked; now
  an error and exit 1); `package.json` `exports` subpaths (`pkg/sub`, patterns) were ignored;
  `Buffer.from(arrayBuffer)` copied instead of sharing memory; `Duplex.call(this)` and
  `EventEmitter.call(this)` (the pre-ES6 inheritance most libraries still use) threw; `child_process`
  captured no output; and `util.debuglog`, `process.report` and `process.arch` were missing or wrong.
- Async work runs on real OS threads, one per queued item, and finishes on the JavaScript thread
  through a timer that runs only while work is outstanding and backs off when idle. Weak references
  are real (`WeakRef`), and finalizers run at safe points, never inside the engine's GC.

### Windows: what is verified, and what makes Windows 7 work

Every earlier Windows claim was structural. Running the Windows host under Wine (a Docker image, see
`test/win7Compat.test.ts`) found bugs that only exist there, all fixed: the engine's `os` module has no
`getpid`/`exec`/`lstat` on Windows (`node-compat.js` failed at startup, so no Windows bot ever ran);
the path module treated `C:` as a directory name; `mkdir -p` built `\C:\...`; and a backslashed launcher
path made the engine fail to find `node-web.js` next to it. Now the compatibility selftest passes 26/26
on the Windows host, its crypto/zlib/TLS selftest reaches Discord over Winsock + mbedTLS, the Node-API
fixture output matches Node's, and real Windows prebuilds run: **better-sqlite3** (real SQLite) and
**@napi-rs/canvas** (Skia, sync and async PNG encode).

**Windows 7 and prebuilt addons.** An addon is a DLL whose imports the OS binds at load. Measuring the
real Windows prebuilds of lmdb, better-sqlite3, msgpackr-extract, @napi-rs/canvas, davey, mediaplex and
sharp, the whole gap to Windows 7 is five functions: `WaitOnAddress`, `WakeByAddressSingle/All`
(Windows 8, in an API-set DLL Windows 7 lacks), `ProcessPrng` (Windows 10) and
`GetSystemTimePreciseAsFileTime` (Windows 8). So instead of refusing these addons, `forgegraal compile`
patches them for Vista/7 targets (`src/compiler/Win7Compat.ts`, in place, layout unchanged):

- the API-set DLL and `bcryptprimitives.dll` imports are renamed to ForgeGraal's own `fgsynch.dll` /
  `fgprng.dll` (`quickjs/native/win-compat/`), shipped beside the addon, where Windows looks first;
  `fgsynch.dll` implements the three functions and forwards the rest of that API set to kernel32;
- `GetSystemTimePreciseAsFileTime` is renamed to the signature-identical `GetSystemTimeAsFileTime`.

Verified under Wine on the real Skia addon: with the shim DLL present it loads and renders, with it
removed the patched addon fails to bind — so the redirect is real, and the shim's code runs. What Wine
cannot show is Windows 7's own loader accepting the result.

- **The Universal C Runtime** (`api-ms-win-crt-*`, which libvips/sharp link) is a Windows update on 7
  (KB2999226), not something to reimplement. The build says so; `--ucrt-dir <Redist\ucrt\DLLs\arch>`
  from a Windows SDK ships it app-local, which Microsoft permits.
- The patcher only touches imports it knows how to satisfy and only when a whole import descriptor is
  covered; anything else still fails with the system's own message.

**Alpine and iSH.** A static host cannot `dlopen`, so there are dynamic musl hosts too
(`linux-x64-musl-dyn`, `linux-x86-musl-dyn`), chosen automatically when the addon is musl-linked or the
target is musl-only. Verified in real Alpine containers on x86-64 and on i386 (the iSH class): a
musl-linked addon runs there with output identical to Node's. Dynamic hosts also no longer need
`libatomic` on the target.

**Console output.** The engine's `console.log` printed every object as `[object Object]`. The host now
formats like Node (`quickjs/runtime/node-inspect.js`): compared against Node on a corpus of nested
objects, classes, Map/Set, typed arrays, Buffers, errors, circular references, long numeric arrays, and
`console.table`, stdout and stderr are byte-identical.

### Addons written against V8 or NAN

A prebuilt V8 addon (the older `better-sqlite3`, `erlpack`, `zlib-sync`, anything on NAN) cannot be
loaded by anything but Node.js: the compiled code reads V8's own heap layout. Its *source* is another
matter -- it is C++ written against a documented API. So ForgeGraal ships an implementation of that API
on top of Node-API (`quickjs/native/v8/`: `v8.h`, `node.h`, `node_buffer.h`, `node_object_wrap.h`,
`uv.h`), header-only, and `forgegraal compile` rebuilds such a package from its source against it:

1. A `.node` file is recognised as a V8 binary by the symbols it imports (`_ZN2v8...`, `...@v8@@`).
2. The package's `binding.gyp` is read (targets, sources, include_dirs, defines, cflags, libraries,
   dependent static-library targets such as a vendored zlib, `conditions` on OS and arch) and compiled with
   the **target's** cross toolchain -- any build machine, whatever platform the installed prebuild was for.
3. The result imports only `napi_*` functions, so the host loads it like any other addon, and it replaces
   the prebuilt binary in the output (`build/Release/<target>.node`, where `bindings` and `node-gyp-build`
   look first).

Verified with the real thing, not a stand-in: **`erlpack`** (Discord's own NAN addon) installed from npm
with its real V8 binary, packaged, and run with no Node.js -- output identical to Node's own V8 build;
**`zlib-sync`** built from its unmodified source with its bundled zlib, inflating a real deflate stream;
**NAN 2.29** itself (`Nan::New`, `ObjectWrap`, `AsyncWorker`, `Callback`, `Persistent`, accessors,
`Buffer`), and a raw-V8 fixture (`FunctionTemplate`, `ObjectWrap`, `Persistent`, `TryCatch`, ...), each
compared against Node.js running the same source. Windows 7 x64/x86 builds compile and link, and their
import tables show `napi_*` bound to the host executable; like everything Windows here, not yet run on
real hardware.

What this cannot do, said plainly:

- **A V8 binary with no source next to it** is rebuilt from the source in its repository when it names
  one: the GitHub tag for the installed version (`gitHead`, `v<version>`, `<version>`) is fetched into the
  cache. Offline, or with no findable source, the build stops naming the package ("ships only a prebuilt
  addon compiled against V8") rather than shipping something that would fail at runtime.
- **The gyp reader is a subset.** A `binding.gyp` that needs something outside it (`actions`, unusual
  command expansions) stops the build and names it.
- **It is the API addons use, not all of V8.** A call outside it is an ordinary compile error, so a gap
  shows at build time. Named and indexed property interceptors (`ObjectTemplate::SetHandler`) have no
  Node-API equivalent, so an object whose template carries one is handed out behind a JavaScript Proxy
  whose traps call the callbacks (get, set, query/`in`, delete, enumerate); a callback that sets no return
  value declines and the access falls through to the plain object, as in V8. Not modelled: `kNonMasking`
  and the definer/descriptor callbacks.
- **A static host cannot dlopen**, so this applies wherever a dynamic host exists: glibc and musl on
  Linux x64, musl on 32-bit Linux and iSH, and every Windows host.

Getting these to run also fixed the runtime underneath: a stack-trace API (`Error.prepareStackTrace` and
CallSite objects, which `bindings` uses to find the calling module) and real file names in stack frames
(they used to read `<evalScript>`).

---

## Package managers

npm, pnpm, Yarn and Bun all build every target; the manager is detected from `packageManager` in
`package.json`, then the lockfile, then the invoking environment, and can be forced with `--pm`.

### Bun projects

ForgeGraal assists Bun's own binary system rather than replacing it — use whichever fits.
`bun build --compile` is the quick path for a modern 64-bit desktop, with no other cooperation
needed. But it produces a binary that needs Bun's own runtime on the device, and on Android
(Termux), running that at all commonly means going through proot-distro first — friction that a
plain Node.js build does not have. ForgeGraal builds every target for Bun projects, including
`linux-armv7`, by transpiling the Bun-authored source at build time. On the native host there is
no Node.js and no Bun on the device; on the Node.js targets the build runs on a plain Node.js. Either
way no Bun and no proot-distro are required there.

- **TypeScript and JSX entrypoints are transpiled automatically.** Bun projects are commonly run straight
  from `.ts`/`.tsx` with no separate build step; ForgeGraal runs `bun build --target=node --format=cjs
  --packages=external` on the entrypoint itself so local imports are bundled but installed packages stay
  external — the real, installed `node_modules` your lockfile pinned are what gets shipped, not a
  bundler's copy of them. Requires `bun` on PATH at build time only; the compiled executable never needs it.
- **`bun:sqlite` and common `Bun` globals work on the Node.js targets only.** Code written against Bun's own
  APIs is polyfilled at startup there. The **native host does not polyfill `Bun`**: a bot on
  `win-legacy-x64`, `linux-x86`, ... that reaches for `Bun.*` or `bun:sqlite` fails at the point of use, so
  use `node:` APIs or a portable database driver for those targets. On the Node.js targets:
  - `import { Database } from "bun:sqlite"` — backed by Node's built-in `node:sqlite` (Node.js >= 22.5),
    matching Bun's synchronous API. Rows go to the real database file.
  - `Bun.env`, `Bun.file`, `Bun.write`, `Bun.sleep`, `Bun.which`, `Bun.nanoseconds` — real, working
    implementations over `node:fs` / `node:process`.
  - `Bun.serve({ fetch })` — bridged onto `node:http`, so a Fetch API handler written for Bun runs
    unmodified.
  - `Bun.password` and `Bun.hash` throw instead of being polyfilled: Node's standard library has no
    algorithm that reproduces their output, and a different algorithm behind the same name is a silent
    correctness bug (hashes that don't verify, cache keys that never hit), not a compatibility shim.
    `Bun.spawn`, FFI, and anything else not listed above throw the same way, at the point of use.

### Yarn Plug'n'Play

A PnP project (`nodeLinker: pnp`, Yarn Berry's default) has no `node_modules` at all — dependencies
live as zip archives that `.pnp.cjs` resolves at `require()` time, in the project's own `.yarn/cache/`
or, by default, a global cache outside the project entirely. `ProjectCollector` needs a real
directory tree to walk, so it cannot see a PnP install as-is.

Rather than reading `.pnp.cjs` or the zip cache directly, `YarnPnpCompat`
(`src/compiler/YarnPnpCompat.ts`) asks Yarn itself to produce one: it copies the project into a
throwaway temp directory and runs `YARN_NODE_LINKER=node-modules yarn install` there, using the
project's own pinned `yarnPath` from `.yarnrc.yml` — the exact same `yarn.lock` resolves to a real
`node_modules` tree instead of `.pnp.cjs`, ForgeGraal never touches the original project, and Yarn's
own resolver is never reimplemented. Verified against a real Yarn Berry install: a genuine `.pnp.cjs`
project builds, runs correctly, and leaves the original project's `.pnp.cjs`/lockfile untouched and
`node_modules`-free afterward. Classic Yarn (1.x) and Berry with `nodeLinker: node-modules` already
had no gap here — this only matters for PnP specifically.

---

## The Node.js path

Everything in this part applies only to builds that ship a Node.js runtime: the targets that are still on
Node.js (`win-x86`, `win-modern-x64`, `linux-armv7`, `linux-modern-arm64`, `darwin-*`, `freebsd-x86`) and any
native-host target you move back with `--node-binary` or `--strategy sea|portable`. The native host needs none
of it: it runs current JavaScript directly and loads native addons itself.

### Runtime pins for legacy targets

**Windows 7** used to say "supply a community build yourself." That was wrong — Node.js's own
`BUILDING.md` declares Windows 7 Tier 1 support through v13.x (Node 14 bumped the floor to Windows 8.1).
But that Tier declaration reflects Node's CI image (Windows Server 2012 R2), not genuine Windows 7
hardware; community reports describe later 13.x/14.x builds crashing on real Windows 7 with missing
`ws2_32.dll` entry points, unconfirmed here without real hardware to test on. ForgeGraal pins **v12.22.12**
instead, the version community guidance converges on as actually launching there, and downloads/verifies
it automatically, no `--node-binary` needed.

Node 12 cannot parse or run current discord.js as published, so ForgeGraal rewrites the bot instead of
giving up — see **[Legacy runtimes](#legacy-runtimes-running-modern-code-on-old-nodejs)** below. A real
ForgeScript bot built this way was verified end to end on a real Node.js 12.22.12: 1120 native functions
registered, `$sum[$multi[3;4];$sum[10;5]]` evaluated to `27`, and live HTTPS calls to Discord's API
returning real responses through both `undici.request()` and `fetch()`.

**Windows Vista** is a separate, older pin — Node.js dropped Vista support entirely in v6.0.0, so the
Windows 7 build above will not even launch there (missing Win32 APIs, not a syntax problem). The last
release that runs on Vista at all is **v5.12.0**, checksum-verified and fetched automatically for
`win-vista-x86` / `win-vista-x64`. It is pre-ES6, and that puts it below what the legacy pipeline can
reach: esbuild refuses to emit below ES6, so the bundled code is shipped unchanged and the build says so.
Only a bot whose entire dependency tree is already ES5 can run there. See
`forgegraal info win-vista-x86`.

**iSH and FreeBSD** were never actually missing a binary — `apk`/`pkg` already have a real, current Node.js
build for their own platform. The executable now runs that install command itself on first launch instead
of just telling you to.

**Windows XP and 32-bit Linux** genuinely have no automatable path today. XP's last Node.js release predates
ES6 and modern TLS by years; 32-bit Linux's last community build (`unofficial-builds.nodejs.org`, checked
directly) is Node 12.16.3, already below ForgeScript's own `engines.node` floor. These stay `--node-binary`
or `forgegraal runtimes add` (checksum-pinned, tried automatically after that).

### Legacy runtimes: running modern code on old Node.js

When the runtime a build targets is older than Node.js 20, ForgeGraal stops treating the bot as
something to ship as-is and starts rewriting it. Two gaps have to be closed, and they are separate
problems:

**Syntax.** Every bundled JavaScript file is re-emitted for the target's exact language level
(`node12.22`, not a fixed guess) with esbuild. ES modules become CommonJS and `"type": "module"` is
dropped, because `require()` of an ES module only works on Node 20.19+/22.12+ and ForgeScript
`require()`s chalk, which is published as pure ESM. Your `node_modules` on disk is never touched — the
rewrite happens on the way into the archive.

> esbuild is used rather than the TypeScript compiler on evidence, not preference: TypeScript's ES2019
> downlevel hoists private class methods out of the class body but leaves their `super.x()` calls
> behind, emitting `SyntaxError: 'super' keyword unexpected here`. undici's decompress interceptor hits
> this. esbuild emits a `__superGet` helper, and is about six times faster over a real dependency tree.

**APIs.** The runtime's missing platform surface is filled in at startup: Web Streams, `EventTarget`,
`AbortController`, `Blob`/`File`/`FormData`, `DOMException`, `AggregateError`, `WeakRef`, the `node:`
specifier prefix, `diagnostics_channel`, `structuredClone`, `crypto.randomUUID`, `stream.isDisturbed`,
and the newer `Array`/`String`/`Promise` statics. The gap was measured against a real Node 12.22.12
rather than assumed.

**Code generated at runtime.** Rewriting files ahead of time cannot reach source a program builds while
running, and ForgeScript's compiler does exactly that — it generates a template literal containing `??`
and hands it to `new Function`. So esbuild's WebAssembly build ships with the bundle (~3.6 MiB
compressed) and lowers generated source on the device, memoised so repeated templates cost one transform
instead of one per call. The launcher waits for it to come up before loading the bot, since ForgeScript
compiles while its own modules are still being required.

#### What it deliberately does not do

- **`Intl.Segmenter` throws** instead of being approximated. Correct grapheme and word breaking needs
  ICU's segmentation tables; splitting by code point would mis-handle emoji, combining marks and ZWJ
  sequences while looking like it worked. `$segmentTextSplit` and friends fail loudly on these targets.
- **`WeakRef` and `FinalizationRegistry` never collect.** Neither can be implemented without
  garbage-collector integration the engine does not expose, so they hold strong references and never
  finalize. undici uses them only to evict idle per-origin dispatchers, so what leaks is bounded by the
  number of hosts the bot talks to.
- **A dependency's `engines.node` floor is overridden, and says so.** Running code on a runtime older
  than its authors declared is the entire point, but the build prints that it did this rather than
  passing silently.
- **Below Node.js 6, nothing is rewritten.** esbuild cannot emit below ES6, so Windows Vista's Node 5.12
  pin gets its code shipped unchanged and a warning saying why.

### Legacy behaviour on Node.js

Old and 32-bit targets get two adjustments, both derived from the target metadata rather than guessed
from the target name:

- **undici's SIMD parser is disabled** (`UNDICI_NO_WASM_SIMD=1`) on 32-bit and legacy targets, whose CPUs may
  not implement the instructions it uses. Set the variable yourself to override.
- **A native addon shim is installed.** Prebuilt `.node` addons usually cannot load on these platforms
  (`ERR_DLOPEN_FAILED`). The shim answers that failure *only where a correct replacement exists*:

| Package                      | On a legacy target                                                              |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `bufferutil`, `utf-8-validate` | Replaced by pure JS with identical behaviour (what `ws` itself falls back to).   |
| `sqlite3`, `better-sqlite3`  | Backed by built-in `node:sqlite` (Node >= 22.5). Rows go to the real database file. |
| `zlib-sync`, `msgpackr-extract`, `pg-native`, `mediaplex`, opus | Error is passed through, so the library takes its own pure-JS path. |
| `lmdb`, `canvas`, `@gifsx/gifsx`, `sodium-native`, `@snazzah/davey`, `bcrypt`, `argon2` | Load fails with an explanation. |

That last row is deliberate. A stub that returns blank images, throws database writes away, hashes passwords
with unsalted SHA-256, or encrypts with a different algorithm than the one asked for leaves a bot that looks
healthy while losing data or its security guarantees — worse than stopping with a clear message. Use
`forge.linked` (Lavalink) instead of `forge.music` on these targets, and a pure JavaScript ForgeDB driver
(`mongodb`, `mysql`, `postgres`) where `node:sqlite` is unavailable.

Windows note: Node validates TLS against its own bundled Mozilla CA list, not the OS certificate store, so
XP/Vista/7's outdated store is normally not why a bot cannot reach Discord. Forcing `--use-system-ca` or
`--use-openssl-ca` through `NODE_OPTIONS` opts back into the OS store; the launcher warns when it sees that.

---

## CLI

```sh
# The entrypoint must be JavaScript (TypeScript and JSX are transpiled only for Bun projects, see above).
forgegraal compile dist/index.js --target linux-modern-x64     # native host, no Node.js in the output
forgegraal compile dist/index.js --target ios-ish-x86          # native host, static musl
forgegraal compile dist/index.js --target win-legacy-x64       # native host, Windows 7 patches applied
forgegraal compile dist/index.js --target win-xp-x86
forgegraal compile dist/index.js --target win-modern-x64       # sea, official Node.js
forgegraal compile dist/index.js --target win-vista-x86 --node-binary ./node-5.12.0/node.exe   # opt back onto Node.js

forgegraal targets [--pm <package manager>]
forgegraal info win-legacy-x64 [--db sqlite]                   # architecture, format, runtime, warnings
forgegraal extensions                                          # ForgeScript extensions the project uses
forgegraal inspect ./forgegraal-out/bot-linux-modern-x64
forgegraal runtimes list [--target <target>]
forgegraal runtimes add linux-x86 12.16.3 https://example.com/node-linux-x86.tar.gz --sha256 <hex>
forgegraal runtimes remove linux-x86 12.16.3
forgegraal version
```

| Option | Effect |
| --- | --- |
| `-t, --target <name>` | Target device (see `forgegraal targets`) |
| `-o, --output <path>` | Output file (sea) or directory (portable, native host) |
| `-s, --strategy auto\|sea\|portable` | `auto` picks the target's default. `sea` or `portable` also moves a native-host target onto Node.js |
| `--pm <name>` | Package manager override (`bun`, `pnpm`, `npm`, `yarn`) |
| `--node-binary <path>` | Use this Node.js runtime instead of the target's default. Also moves a native-host target onto Node.js |
| `--node-version <ver>` | Official Node.js version to download (`22` or `22.11.0`) |
| `--native-libc musl\|musl-dynamic\|glibc` | Libc of the native host. `musl` (static) is the default and runs on glibc and musl systems; it cannot load addons, so a bot that needs one gets a dynamic host automatically |
| `--ucrt-dir <dir>` | `Redist\ucrt\DLLs\<arch>` from a Windows SDK, shipped app-local for addons that need the Universal C Runtime on Windows 7 (sharp/libvips) |
| `--offline` | Never download runtimes or fetch addon sources |
| `--include-dev` | Bundle devDependencies too |
| `--include-env` | Bundle `.env` files (they usually contain your bot token) |
| `--allow-native-mismatch` | Bundle native addons built for another platform |

---

## Extension

```js
const { ForgeClient } = require("@tryforge/forgescript");
const { ForgeGraal } = require("forgegraal");

const client = new ForgeClient({
    extensions: [
        new ForgeGraal({
            allowCompile: false, // set true to enable $compileBinary
            root: process.cwd(), // file arguments are confined to this directory
        }),
    ],
});
```

`$compileBinary` stays disabled unless `allowCompile: true`. Function reference lives in
`metadata/functions.json` (regenerate with `pnpm docgen`).

| Group | Functions |
| --- | --- |
| Build | `$compileBinary`, `$dbDriverCompat`, `$suggestDbDriver`, `$graalVersion` |
| Binary | `$binarySize`, `$sha256Binary`, `$verifyBinaryHeader`, `$generateSeaConfig` |
| Policy | `$isTargetSupported`, `$supportedTargets`, `$packageManager`, `$packagerType`, `$canPackageOnBun` |
| Target | `$listPlatforms`, `$targetName`, `$targetDescription`, `$targetPlatform`, `$targetBits`, `$binaryArchitecture`, `$binaryExtension`, `$binaryFormat`, `$is32BitTarget`, `$is64BitTarget`, `$is32BitOrLegacy`, `$isArmTarget`, `$isIsh`, `$isLegacyWindows` |

`$packagerType` reports the Node.js default (`sea` or `portable`); a target on the native host ignores it
unless you pass `--strategy`.

---

## Development

```sh
pnpm install
pnpm typecheck && pnpm build && pnpm test && pnpm check
```

`pnpm test` compiles first and runs everything under `test/` with Node's test runner. Checks that need
something extra skip themselves when it is missing: a built host (`FORGEGRAAL_C`), `qjs` (`FORGEGRAAL_QJS`),
the musl.cc toolchains on `PATH`, NAN sources (`FORGEGRAAL_NAN_DIR`) and the `fg-wine` Docker image, which
runs the Windows host. `pnpm conformance` measures an engine against what a ForgeScript bot needs, and
`quickjs/native/build.sh <target>` builds the C host by hand. `dist/` is committed, so run `pnpm build` before
committing.

<h3 align="center">Credits</h3><hr>

- [ForgeScript](https://github.com/tryforge/ForgeScript) by the BotForge team.
- [quickjs-ng](https://github.com/quickjs-ng/quickjs), [mbedTLS](https://github.com/Mbed-TLS/mbedtls) and
  [miniz](https://github.com/richgel999/miniz) power the native host.

Licensed under GPL-3.0-or-later (see `LICENSE`).

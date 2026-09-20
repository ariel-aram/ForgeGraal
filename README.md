# ForgeGraal

ForgeScript extension and CLI that turns [ForgeScript](https://github.com/tryforge/ForgeScript) bots into
standalone executables and portable bundles — including 32-bit devices (iSH on iOS, x86, ARMv7, FreeBSD) and
legacy Windows (XP, Vista, 7).

---

## How a build works

1. The project (the directory of the closest `package.json`) and its production `node_modules` are collected.
   pnpm/Bun symlink layouts are flattened into a plain, Node-resolvable tree. `.env`, `.npmrc`, `.git` and
   devDependencies stay out unless you ask for them.
2. Everything is packed into a compressed archive next to a small launcher. On first start the archive is
   extracted beside the executable (`<name>.forgegraal/app`, or `app/` in a portable bundle) and the bot runs
   from there, so ForgeScript's directory scanning (`client.commands.load("./commands")`, extensions, ForgeDB)
   keeps working. Files the bot writes there — SQLite databases included — survive rebuilds.
3. Output is one of two strategies:
   - **sea** — a [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
     injected into a target Node.js runtime (>= 20.12). Official runtimes are downloaded and SHA-256 verified.
   - **portable** — a folder with the archive, `boot.cjs`, a launcher (`<name>.cmd` / `<name>` shell script)
     and the runtime if one is available. Chosen automatically when no SEA-capable runtime exists.

---

## Supported targets

| Target               | Platform                                | Runtime                                                      |
| -------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `win-xp-x86`         | Windows XP / Server 2003 (NT 5.1/5.2)   | portable, `--node-binary` — no automatable source (see below) |
| `win-vista-x86`      | Windows Vista (32-bit)                  | portable, **auto**: official Node.js 5.12.0                   |
| `win-vista-x64`      | Windows Vista (64-bit)                  | portable, **auto**: official Node.js 5.12.0                   |
| `win-legacy-x86`     | Windows 7 (32-bit)                      | portable, **auto**: official Node.js 12.22.12                 |
| `win-legacy-x64`     | Windows 7 (64-bit)                      | portable, **auto**: official Node.js 12.22.12                 |
| `ios-ish-x86`        | Alpine (musl i686) under iOS iSH        | portable, **auto**: installs itself on-device (`apk`)         |
| `linux-x86`          | Linux 32-bit (i686)                     | portable, `--node-binary` — no automatable source (see below) |
| `freebsd-x86`        | FreeBSD 32-bit                          | portable, **auto**: installs itself on-device (`pkg`)         |
| `win-x86`            | Windows 10 / 11 (32-bit)                | sea, official (up to Node 22)                                  |
| `linux-armv7`        | Linux ARMv7 (32-bit)                    | sea, official                                                  |
| `win-modern-x64`     | Windows 10 / 11 (64-bit)                | sea, official                                                  |
| `linux-modern-x64`   | Linux 64-bit (x86_64)                   | sea, official                                                  |
| `linux-modern-arm64` | Linux ARM64 (AArch64)                   | sea, official                                                  |
| `darwin-x64`         | macOS Intel                             | sea, official (sign with `codesign --sign -`)                 |
| `darwin-arm64`       | macOS Apple Silicon                     | sea, official (sign with `codesign --sign -`)                 |

Every package manager (NPM, PNPM, Yarn, Bun) may build every target. Yarn Plug'n'Play is not supported;
set `nodeLinker: node-modules` in `.yarnrc.yml` and reinstall.

### Why some legacy targets still need `--node-binary`

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

---

## Legacy runtimes: running modern code on old Node.js

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

### What it deliberately does not do

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

---

## quickjs-ng: the way past Node's ceiling

Everything above works around a constraint that is really Node's, not the hardware's. Node decides
which *language* an old machine may run: Windows 7 is stuck on Node 12, 32-bit Linux on an
unofficial Node 12.16.3. Lowering code to fit that is what the legacy pipeline does, and it works —
but it is treating a symptom.

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

**Still unverified:** the Windows builds have not been run on real Windows hardware. Linking clean
and importing nothing too new is necessary, not sufficient — the next step for those targets is a
real machine, the same bar already met for the `native` build above.

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
  checked structurally (right PE machine type, right bitness). **Not yet run on real Windows
  hardware** — same caveat as the XP build above, now covering five targets instead of one.

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
  addon's own delay-load hook binds to them. This is built and checked (145 exported symbols), but
  like everything Windows here, **not yet run on real Windows hardware**.
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

- **A V8 binary with no source next to it cannot be rebuilt.** The build stops naming the package
  ("ships only a prebuilt addon compiled against V8"), rather than shipping something that would fail at
  runtime. Use a version that ships its source, or a Node-API build of it (`better-sqlite3` 13 is one).
- **The gyp reader is a subset.** A `binding.gyp` that needs something outside it (`actions`, unusual
  command expansions) stops the build and names it.
- **It is the API addons use, not all of V8.** A call outside it is an ordinary compile error, so a gap
  shows at build time. Named and indexed property interceptors (`ObjectTemplate::SetHandler`) have no
  Node-API equivalent and fail loudly at the call.
- **A static host still cannot dlopen**, so this applies wherever the addon-loading (dynamic) host does.

Getting these to run also fixed the runtime underneath: a stack-trace API (`Error.prepareStackTrace` and
CallSite objects, which `bindings` uses to find the calling module) and real file names in stack frames
(they used to read `<evalScript>`).

---

## Bun projects

ForgeGraal assists Bun's own binary system rather than replacing it — use whichever fits.
`bun build --compile` is the quick path for a modern 64-bit desktop, with no other cooperation
needed. But it produces a binary that needs Bun's own runtime on the device, and on Android
(Termux), running that at all commonly means going through proot-distro first — friction that a
plain Node.js build does not have. ForgeGraal builds every target for Bun projects, including
`linux-armv7`, by transpiling the Bun-authored source at build time and shipping a build that runs
on a plain Node.js on the device: no Bun and no proot-distro required there.

- **TypeScript and JSX entrypoints are transpiled automatically.** Bun projects are commonly run straight
  from `.ts`/`.tsx` with no separate build step; ForgeGraal runs `bun build --target=node --format=cjs
  --packages=external` on the entrypoint itself so local imports are bundled but installed packages stay
  external — the real, installed `node_modules` your lockfile pinned are what gets shipped, not a
  bundler's copy of them. Requires `bun` on PATH at build time only; the compiled executable never needs it.
- **`bun:sqlite` and common `Bun` globals work in the compiled executable.** It runs on Node.js
  regardless of target, so code written against Bun's own APIs is polyfilled at startup:
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

---

## Yarn Plug'n'Play

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

## Legacy behaviour

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
# The entrypoint must be JavaScript: build TypeScript first.
forgegraal compile dist/index.js --target linux-modern-x64
forgegraal compile dist/index.js --target ios-ish-x86          # installs Node.js on-device itself
forgegraal compile dist/index.js --target win-legacy-x64       # auto-fetches Node.js 12.22.12
forgegraal compile dist/index.js --target win-vista-x86        # auto-fetches Node.js 5.12.0
forgegraal compile dist/index.js --target win-xp-x86 --node-binary ./node-xp/node.exe
forgegraal compile dist/index.js --target linux-x86 --node-binary ./node-linux-x86/node

forgegraal targets
forgegraal info win-legacy-x86                                 # shows the discord.js-compatibility warning
forgegraal info linux-armv7 --db sqlite
forgegraal inspect ./forgegraal-out/bot-linux-modern-x64
forgegraal runtimes add linux-x86 12.16.3 https://example.com/node-linux-x86.tar.gz --sha256 <hex>
forgegraal runtimes list
```

Options: `--output`, `--strategy auto|sea|portable`, `--pm`, `--node-binary`, `--node-version`, `--offline`,
`--include-dev`, `--include-env`, `--allow-native-mismatch`.

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

---

## Development

```sh
pnpm install
pnpm typecheck && pnpm build && pnpm test && pnpm check
```

Licensed under GPL-3.0-or-later (see `LICENSE`).

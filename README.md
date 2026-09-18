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

## quickjs-ng: the way past Node's ceiling (in progress)

Everything above works around a constraint that is really Node's, not the hardware's. Node decides
which *language* an old machine may run: Windows 7 is stuck on Node 12, 32-bit Linux on an
unofficial Node 12.16.3. Lowering code to fit that is what the legacy pipeline does, and it works —
but it is treating a symptom.

[quickjs-ng](https://github.com/quickjs-ng/quickjs) does not have that coupling. It is a ~72k-line
C99 engine that publishes *current* builds for exactly the platforms Node abandoned, including
32-bit Windows (1.85 MiB) and 32-bit Linux. `QuickJsRuntime` fetches and checksum-verifies those
binaries; `tools/engine-conformance.js` measures any engine against what a ForgeScript bot actually
needs. Run it against anything: `node tools/engine-conformance.js`, `qjs tools/engine-conformance.js`.

Measured on v0.16.2, not assumed:

| | language | builtins | host APIs | node modules | total |
| --- | --- | --- | --- | --- | --- |
| Node.js 26 | 10/10 | 10/10 | 8/8 | 30/30 | **58/58** |
| Node.js 12.22.12 (the Windows 7 pin) | 5/10 | 1/10 | 1/8 | 29/30 | **36/58** |
| quickjs-ng 0.16.2, bare engine | 10/10 | 10/10 | 0/8 | 0/30 | **20/58** |
| quickjs-ng + `quickjs/runtime/node-compat.js` | 10/10 | 10/10 | 4/8 | 16/30 | **40/58** |

Node 12 and the bare engine are exact complements: **Node 12 has the libraries but not the
language; quickjs-ng has the language but not the libraries.** Every construct that fails to parse
on the Windows 7 pin — optional chaining, `??=`, private methods calling `super`, class static
blocks, async generators — runs on the 32-bit quickjs-ng build unmodified.

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

What is missing is now specific: `net`, `tls`, `http`, `dns`, `crypto`, `zlib` and
`worker_threads`. Those need native work — **`qjs:os` exposes no socket API at all** — and a bot
cannot reach Discord without them. They are registered as modules that throw an explanation when
used rather than being stubbed, the same rule the native addon shim follows.

### The native host (`runtime/`, Rust)

The engine plus a JavaScript compatibility layer still cannot reach Discord: `qjs:os` has no
socket API, so `net`, `tls`, `http` and everything above them are unreachable no matter how much
JavaScript is written. `runtime/` is the missing half — a Rust binary that embeds quickjs-ng and
supplies exactly the capabilities that require native code:

- **TCP and TLS** (tokio + rustls). Sockets stay on the Rust side and are handed to JavaScript as
  integer ids, so a JavaScript bug cannot produce a use-after-free or a descriptor mix-up.
  Certificates verify against rustls's compiled-in roots rather than the OS store, which is what
  makes an old machine able to reach Discord at all — a Windows 7 certificate store is typically a
  decade stale.
- **Hashing, HMAC and secure randomness.** A hash written in JavaScript would be correct but slow;
  randomness written in JavaScript would not be random, which is a security bug rather than a
  performance one.
- **Compression** (zlib/deflate/gzip), which the gateway needs.
- **Timers, filesystem and process**, so the JavaScript layer has one host abstraction to target
  instead of one per backend.

`quickjs/runtime/native-modules.js` gives those Node's shapes, so a library sees `tls.connect()`
and `crypto.createHash()` rather than an integer id. Verified end to end, against live Discord:

```
$ ./runtime/target/release/forgegraal-runtime quickjs/runtime/native-selftest.js
crypto.createHash sha256: ba7816bf…f20015ad   (matches the known vector)
createHmac sha256       : f7bc83f4…2d1a3cd8   (matches the RFC vector)
zlib deflate/inflate    : true (330 -> 38)
tls.connect status      : HTTP/1.1 200 OK
tls.connect body        : {"url":"wss://gateway.discord.gg"}
```

```sh
cd runtime && cargo build --release                        # host platform
cargo build --release --target i686-pc-windows-gnu         # 32-bit Windows
```

Cross-compiling needs mingw-w64; the repo's `runtime/.cargo/config.toml` carries the linker and
bindgen settings so it works without per-machine setup.

**The platform cost.** Rust's standard library for 32-bit Windows imports `ProcessPrng`
(Windows 10), `WaitOnAddress` and `GetSystemTimePreciseAsFileTime` (Windows 8), and the
`api-ms-win-core-synch` API set (Windows 7). So this host cannot serve Windows XP or Vista, and its
32-bit Windows build requires Windows 10. Rust buys memory safety on the code that parses bytes off
a network and costs the oldest targets — which is why there is a second backend.

### The C native host (`quickjs/native/`), for the oldest machines

Same surface, different floor. It installs the identical `__forgegraal_native` object, so
`native-modules.js` runs unchanged on either backend, and uses only Winsock 2 and CryptoAPI — both
present since the 1990s. TLS is mbedTLS; compression is miniz; certificates verify against a bundle
compiled into the binary by `gen-ca-bundle.sh`, since the certificate store on a machine this old
would reject Discord outright.

```sh
quickjs/native/build.sh native        # host platform
quickjs/native/build.sh win-x86       # 32-bit Windows, Vista and later
quickjs/native/build.sh win-xp-x86    # 32-bit Windows, XP-compatible
```

The XP build applies two patches: `winxp-compat.patch` for the engine's four Vista-era threading
calls, and `patch-mbedtls-xp.py`, which swaps mbedTLS's `BCryptGenRandom` (Vista, `bcrypt.dll`) for
`CryptGenRandom` (Windows 95 OSR2, `advapi32`). Both draw from the OS CSPRNG; only the API vintage
differs. The build then **verifies the result imports nothing newer than XP and fails if it does**.

Result: a self-contained **2.7 MB** executable — JavaScript engine, TLS stack, compression and CA
bundle included — importing only `KERNEL32`, `msvcrt`, `ADVAPI32` and `WS2_32`.

Both backends run the same `quickjs/runtime/native-selftest.js` and produce the same output,
against live Discord:

```
crypto.createHash sha256: ba7816bf…f20015ad   (matches the known vector)
createHmac sha256       : f7bc83f4…2d1a3cd8   (matches the RFC vector)
zlib deflate/inflate    : true (330 -> 38)
tls.connect status      : HTTP/1.1 200 OK
tls.connect body        : {"url":"wss://gateway.discord.gg"}
```

`pnpm test` runs that comparison across whichever backends are built (`FORGEGRAAL_RUNTIME`,
`FORGEGRAAL_C`) and skips it otherwise.

**Still unverified:** neither Windows build has been run on real hardware. Linking clean and
importing nothing too new is necessary, not sufficient.

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

---

## Bun projects

ForgeGraal builds every target for Bun projects, including the modern 64-bit ones Bun's own
`bun build --compile` already covers — use whichever fits: `bun build --compile` for a quick modern
binary with no other cooperation needed, ForgeGraal for 32-bit/legacy targets, or when you also want
one of the things below.

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

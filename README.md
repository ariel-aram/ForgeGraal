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
| `win-legacy-x86`     | Windows 7 (32-bit)                      | portable, **auto**: official Node.js 13.14.0                  |
| `win-legacy-x64`     | Windows 7 (64-bit)                      | portable, **auto**: official Node.js 13.14.0                  |
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

**Windows 7** used to say "supply a community build yourself." That was wrong — Node.js itself still
hosts and checksums the last release that officially supported Windows 7: **v13.14.0** (Node 14 bumped
the floor to Windows 8.1, confirmed against `BUILDING.md` at both tags). ForgeGraal now downloads and
verifies it automatically, no `--node-binary` needed. It does **not** make current discord.js-based bots
run there, though: tested directly, `@tryforge/forgescript` fails to parse on it (`Unexpected token '.'`,
optional chaining, ES2020), and with `--harmony` it gets further before failing on `??=` (ES2021, used by
`@discordjs/util`) — a syntax gap no runtime flag closes, on top of `undici` needing Node >= 18 at the API
level regardless of syntax. The build still succeeds and prints this as a loud warning (see `forgegraal
info win-legacy-x86`), for projects with a lighter dependency tree that doesn't reach that far.

**Windows Vista** is a separate, older pin — Node.js dropped Vista support entirely in v6.0.0, so the
Windows 7 build above will not even launch there (missing Win32 APIs, not a syntax problem). The last
release that runs on Vista at all is **v5.12.0**, checksum-verified and fetched automatically for
`win-vista-x86` / `win-vista-x64`. It is pre-ES6: no classes, no async/await, no template literals — only
a bot written specifically for it, with no modern dependency (including current discord.js or
ForgeScript) in its chain, can run there. See `forgegraal info win-vista-x86` for the full warning.

**iSH and FreeBSD** were never actually missing a binary — `apk`/`pkg` already have a real, current Node.js
build for their own platform. The executable now runs that install command itself on first launch instead
of just telling you to.

**Windows XP and 32-bit Linux** genuinely have no automatable path today. XP's last Node.js release predates
ES6 and modern TLS by years; 32-bit Linux's last community build (`unofficial-builds.nodejs.org`, checked
directly) is Node 12.16.3, already below ForgeScript's own `engines.node` floor. These stay `--node-binary`
or `forgegraal runtimes add` (checksum-pinned, tried automatically after that).

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
forgegraal compile dist/index.js --target win-legacy-x64       # auto-fetches Node.js 13.14.0
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

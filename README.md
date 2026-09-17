# ForgeGraal

ForgeScript extension and CLI that turns [ForgeScript](https://github.com/tryforge/ForgeScript) bots into
standalone executables — including 32-bit devices (iSH on iOS, x86, ARMv7, FreeBSD) and legacy Windows (7 / Vista).

## Package manager policy

| Project uses       | Targets ForgeGraal builds                                   |
| ------------------ | ----------------------------------------------------------- |
| NPM, PNPM, Yarn    | every target                                                |
| Bun                | 32-bit and legacy Windows only                              |

Bun already compiles modern 64-bit executables with `bun build --compile`, so ForgeGraal only covers what Bun
cannot. The package manager is detected from `package.json#packageManager`, then lockfiles
(`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`), and can be overridden with `--pm`.
Yarn Plug'n'Play is not supported; use `nodeLinker: node-modules`.

## How builds work

1. The project (next to the closest `package.json`) and its production `node_modules` are collected.
   pnpm/Bun symlinked layouts are flattened into a Node.js-resolvable tree. `.env`, `.npmrc`, `.git` and
   devDependencies are left out unless requested.
2. Everything is packed into a compressed archive with a small launcher. On first start the archive is
   extracted next to the executable (`<name>.forgegraal/app`, or `app/` inside a portable bundle) and the bot
   runs from there, so ForgeScript's directory based loading (`client.commands.load("./commands")`,
   extensions, ForgeDB) keeps working. Files the bot creates there (e.g. SQLite databases) survive updates.
3. Output strategy:
   - **sea** — a [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
     injected into a target Node.js runtime (>= 20.12). Official runtimes are downloaded and SHA-256 verified
     for `win-x86`, `linux-armv7` and all modern targets.
   - **portable** — a folder with the archive, `boot.cjs`, a launcher (`<name>.cmd` / `<name>` shell script)
     and, if available, the runtime. Used automatically when no SEA-capable runtime exists for the target.

| Target               | Official runtime | Notes                                                                  |
| -------------------- | ---------------- | ---------------------------------------------------------------------- |
| `ios-ish-x86`        | no               | `apk add nodejs` inside iSH, or `--node-binary` with Alpine's x86 node  |
| `win-legacy-x86/x64` | no               | pass a Windows 7 compatible Node.js build with `--node-binary`          |
| `linux-x86`          | no               | distro Node.js or `--node-binary`                                       |
| `freebsd-x86`        | no               | `pkg install node` or `--node-binary`                                   |
| `win-x86`            | up to Node 22    |                                                                        |
| `linux-armv7`        | yes              |                                                                        |
| modern 64-bit        | yes              | macOS executables must be signed (`codesign --sign -`) on a Mac        |

Native addons (e.g. `sqlite3` used by ForgeDB's sqlite driver) are checked against the target and the
build fails if none fits; install them for the target platform, or switch to a pure JavaScript ForgeDB
driver (`mongodb`, `mysql`, `postgres`) — `forgegraal info <target> --db <driver>` and the error message
both suggest one.

### TLS on legacy Windows

Node.js validates TLS against its own bundled Mozilla CA snapshot by default — not the OS certificate
store — so an outdated store on Windows 7 / Vista is normally *not* the reason a bot can't reach Discord.
That only changes if `NODE_OPTIONS` forces `--use-system-ca` / `--use-openssl-ca`; ForgeGraal's launcher
warns if it detects that on a legacy Windows target. If TLS still fails there, look at the runtime's own
OpenSSL build and the OS's outbound TLS 1.2/1.3 support, not the certificate store.

### Community runtimes (`forgegraal runtimes`)

Targets with no official Node.js build (Windows 7 / Vista, `linux-x86`, `freebsd-x86`, iSH) need a runtime
supplied by you. ForgeGraal ships **no** entries of its own — it has no way to vouch for a third-party
binary's authenticity ahead of time — so you register the URL once, pinned to its exact SHA-256, and
ForgeGraal re-verifies the checksum on every download after that:

```sh
forgegraal runtimes add win-legacy-x86 20.18.1 https://example.com/node-v20.18.1-win7-x86.zip \
  --sha256 <64-hex-digest> --notes "community Win7 build" [--global]
forgegraal runtimes list
forgegraal runtimes remove win-legacy-x86 20.18.1
```

Entries are stored in `.forgegraal/runtimes.json` (project-local — commit it so your team shares the same
pinned runtime) or, with `--global`, in the cache directory. Once registered, `compile` picks a matching
entry automatically when `--node-binary` isn't given. Accepts a raw executable, `.tar.gz`/`.tgz`, or `.zip`
URL.

## CLI

```sh
# build your bot first if it is TypeScript: the entrypoint must be JavaScript
forgegraal compile dist/index.js --target linux-modern-x64
forgegraal compile dist/index.js --target ios-ish-x86
forgegraal compile dist/index.js --target win-legacy-x86 --node-binary ./node-win7-x86/node.exe
forgegraal targets --pm bun
forgegraal info linux-armv7 --db sqlite
forgegraal inspect ./forgegraal-out/bot-linux-modern-x64
forgegraal runtimes list
```

Options: `--output`, `--strategy auto|sea|portable`, `--pm`, `--node-binary`, `--node-version`, `--offline`,
`--include-dev`, `--include-env`, `--allow-native-mismatch`.

## Extension

```js
const { ForgeClient } = require("@tryforge/forgescript")
const { ForgeGraal } = require("forgegraal")

new ForgeClient({
    extensions: [new ForgeGraal({ allowCompile: false, root: process.cwd() })],
    // ...
})
```

`$compileBinary` is disabled unless `allowCompile: true`. File arguments of every function are confined to
`root`. Function reference: `metadata/functions.json` (regenerate with `pnpm docgen`).

## Development

```sh
pnpm install
pnpm typecheck && pnpm build && pnpm test && pnpm check
```

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
build fails if none fits; install them for the target platform or use a pure JavaScript ForgeDB driver
(mongodb, mysql, postgres).

## CLI

```sh
# build your bot first if it is TypeScript: the entrypoint must be JavaScript
forgegraal compile dist/index.js --target linux-modern-x64
forgegraal compile dist/index.js --target ios-ish-x86
forgegraal compile dist/index.js --target win-legacy-x86 --node-binary ./node-win7-x86/node.exe
forgegraal targets --pm bun
forgegraal info linux-armv7 --db sqlite
forgegraal inspect ./forgegraal-out/bot-linux-modern-x64
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

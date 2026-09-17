# ForgeGraal

ForgeScript extension and CLI that turns [ForgeScript](https://github.com/tryforge/ForgeScript) bots into
standalone executables and portable bundles — including 32-bit devices (iSH on iOS, x86, ARMv7, FreeBSD) and legacy Windows (Windows XP, Windows Vista, Windows 7).

## Translations & Crowdin Documentation

ForgeGraal documentation and function metadata translations follow the BotForge documentation system.

- **Translate on Crowdin**: [BotForge Crowdin Project](https://crowdin.com/project/botforge)
- **Official Documentation**: [https://docs.botforge.org/p/ForgeGraal/](https://docs.botforge.org/p/ForgeGraal/)
- **Translations Directory**: `metadata/translations/` (`en.json`, `es.json`, etc.)

To update and generate translation and metadata files after modifying functions:
```sh
pnpm docgen
```

---

## Universal WebAssembly & Pure-JS Virtual Layer

ForgeGraal features a universal native addon virtual layer that prevents `ERR_DLOPEN_FAILED` crashes on legacy operating systems (Windows XP / Vista / 7, iSH):
- **Databases**: `@quoriel/db`, `lmdb`, and native sqlite fall back to Pure-JS storage engines.
- **Canvas / Graphics**: `@napi-rs/canvas` and `canvas` fall back to Pure-JS canvas stubs.
- **Audio & Crypto**: `@snazzah/davey` and `sodium-native` voice encryption fall back to standard Node Crypto.
- **Relational Databases**: `pg-native` and `mysql2` native hooks automatically route to pure JavaScript implementations.

---

## Package Manager Policy

ForgeGraal supports **NPM**, **PNPM**, **Yarn**, and **Bun** across all targets:
- Projects using PNPM have their `.pnpm` virtual stores hoisted into a portable tree.
- Yarn Plug'n'Play projects should set `nodeLinker: node-modules` in `.yarnrc.yml`.

---

## Supported Targets

| Target               | Platform Description                                | Runtime Mode |
| -------------------- | --------------------------------------------------- | ------------ |
| `win-xp-x86`         | Windows XP / Server 2003 (NT 5.1/5.2)               | portable     |
| `win-legacy-x86`     | Windows Vista / 7 (32-bit x86)                      | portable     |
| `win-legacy-x64`     | Windows Vista / 7 (64-bit x64)                      | portable     |
| `ios-ish-x86`        | Alpine Linux (musl i686) under iOS iSH              | portable     |
| `linux-x86`          | Linux 32-bit (i686)                                 | portable     |
| `freebsd-x86`        | FreeBSD 32-bit (x86)                                | portable     |
| `win-x86`            | Windows 10 / 11 (32-bit x86)                        | SEA / auto   |
| `linux-armv7`        | Linux ARMv7 (32-bit)                                | SEA / auto   |
| `win-modern-x64`     | Windows 10 / 11 (64-bit x64)                        | SEA / auto   |
| `linux-modern-x64`   | Linux 64-bit (x86_64)                               | SEA / auto   |
| `linux-modern-arm64` | Linux ARM64 (AArch64)                               | SEA / auto   |
| `darwin-x64`         | macOS Intel (64-bit)                                | SEA / auto   |
| `darwin-arm64`       | macOS Apple Silicon (ARM64)                         | SEA / auto   |

---

## CLI Usage

```sh
# Compile bot for Windows 7 / Vista 64-bit
forgegraal compile dist/index.js --target win-legacy-x64 --strategy portable

# Compile bot for Windows XP 32-bit
forgegraal compile dist/index.js --target win-xp-x86 --strategy portable --node-binary ./node-xp/node.exe

# Compile bot for iOS iSH
forgegraal compile dist/index.js --target ios-ish-x86

# List available targets
forgegraal targets

# Register a community runtime for legacy Windows
forgegraal runtimes add win-legacy-x64 20.18.1 https://example.com/node-v20.18.1-win7-x64.zip --sha256 <hash>
```

---

## Extension Usage

```js
const { ForgeClient } = require("@tryforge/forgescript");
const { ForgeGraal } = require("forgegraal");

const client = new ForgeClient({
    extensions: [
        new ForgeGraal({
            allowCompile: true, // enables $compileBinary
            root: process.cwd()
        })
    ]
});
```

---

## Development

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm check
```

# ForgeGraal Documentation

Welcome to the internal documentation for **ForgeGraal** — the universal compilation and execution layer for [ForgeScript](https://github.com/tryforge/ForgeScript) bots.

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Target Matrix](#target-matrix)
3. [Universal WebAssembly & Pure-JS Virtual Layer](#universal-webassembly--pure-js-virtual-layer)
4. [Supported Package Managers](#supported-package-managers)
5. [CLI Commands](#cli-commands)
6. [ForgeScript Extension Integration](#forgescript-extension-integration)

---

## Architecture Overview
ForgeGraal collects your bot's project structure, its dependency tree (including hoisted symlinks from PNPM and Bun), and packages everything into an optimized standalone bundle:
- **SEA (Single Executable Application)**: Injects bytecode into target Node.js runtimes (Node >= 20.12).
- **Portable Bundle**: Produces a zero-install folder with `boot.cjs`, archive files, and runtime scripts, suited for constrained environments.

---

## Target Matrix
- **`win-xp-x86`**: Windows XP / Server 2003 (NT 5.1/NT 5.2) 32-bit.
- **`win-legacy-x86` / `win-legacy-x64`**: Windows Vista and Windows 7 (NT 6.0/NT 6.1).
- **`ios-ish-x86`**: iOS iSH Alpine Linux userland (i686 musl).
- **`linux-x86`**: 32-bit x86 Linux (i686 glibc/musl).
- **`freebsd-x86`**: 32-bit x86 FreeBSD.
- **Modern 64-bit Targets**: `win-modern-x64`, `linux-modern-x64`, `linux-modern-arm64`, `darwin-x64`, `darwin-arm64`.

---

## Universal WebAssembly & Pure-JS Virtual Layer
To eliminate dynamic library link failures (`ERR_DLOPEN_FAILED`) across legacy OSs:
- **Database Engine**: `@quoriel/db` and `lmdb` route to an in-memory/pure-JS store.
- **Graphics Engine**: `@napi-rs/canvas` and `canvas` route to Pure-JS canvas stubs.
- **Audio & Crypto**: `@snazzah/davey` and `sodium-native` voice encryption route to Node crypto.
- **Relational Databases**: `pg-native` and `mysql2` fall back to pure JS protocol drivers.

---

## Supported Package Managers
ForgeGraal supports **NPM**, **PNPM**, **Yarn**, and **Bun** across all targets.

---

## CLI Commands
```sh
# Compile bot for Windows 7 / Vista 64-bit
forgegraal compile dist/index.js --target win-legacy-x64 --strategy portable

# Compile bot for Windows XP 32-bit
forgegraal compile dist/index.js --target win-xp-x86 --strategy portable --node-binary ./node-xp/node.exe

# List targets
forgegraal targets

# List extensions compatibility
forgegraal extensions
```

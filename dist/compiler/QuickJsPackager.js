"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuickJsPackager = void 0;
exports.addonPackageNames = addonPackageNames;
exports.classifyNativeAddons = classifyNativeAddons;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const nativeShim_1 = require("../runtime/nativeShim");
const structures_1 = require("../structures");
const NodeRuntime_1 = require("./NodeRuntime");
/**
 * Packages a bot to run on the ForgeGraal native host (quickjs-ng + `quickjs/native/`) instead of
 * a bundled Node.js binary.
 *
 * Default for the legacy Windows targets, iSH, and 32-bit Linux: those are exactly the targets
 * Node.js itself cannot serve well (Windows 7 tops out at Node 12, XP has no official build at
 * all, and 32-bit Linux's last Node is an unofficial 12.16.3), so the native host is the better
 * default there rather than an alternative. `LinuxModernX64` is included too, as the original
 * proof target. Every other target still ships on Node.js. See NATIVE_HOST_BUILD_TARGET below for
 * exactly which targets this covers today, and why some are missing: coverage is added only once
 * this repo can both build and actually run the result, per target, with real verification — not
 * declared for a target just because it seems like it should work.
 *
 * Known limitation, called out rather than hidden: the output is loose files (`app/`, `runtime/`),
 * not the compressed single-file FGAR archive the Node path produces, because the quickjs runtime
 * has no in-engine unarchiver yet. `native-modules.js`/`node-compat.js` already expose a working
 * `zlib`, so adding one is possible — just not part of proving this path works at all.
 */
/**
 * Maps a target to the `quickjs/native/build.sh` argument that builds its native host. Only
 * targets this repo can actually build belong here; every other target keeps shipping on Node.js
 * until it gets its own entry, with its own real verification.
 *
 * `IosIshX86` and `LinuxX86` share `linux-x86`: both need a 32-bit x86 Linux ELF (iSH is an
 * Alpine/musl userland), so the same static binary serves both. `linux-x86` needs an
 * `i686-linux-musl-gcc` cross-compiler on PATH -- Debian/Ubuntu's own `gcc-multilib` cannot
 * provide one here (the installed `gcc-13` and the only available `gcc-13-multilib` are different
 * point releases with no compatible build), so this build uses a prebuilt i686-linux-musl-cross
 * toolchain from musl.cc instead, which needs nothing from the system package manager at all.
 * This is also, fittingly, the same libc iSH itself runs on.
 *
 * `LinuxModernX64` maps to `linux-x64`, a static musl build cross-compiled the same way, not the
 * `native` target (which links dynamically against whatever libc the build host has). Confirmed
 * on real Alpine Linux via Docker: the dynamic-glibc build fails outright with a bare
 * `exec: no such file or directory` -- the classic symptom of a missing ELF interpreter, since
 * Alpine's loader lives at a different path and glibc and musl are not ABI-compatible -- while
 * the static musl build runs and passes the same live-Discord self-test unmodified. Alpine is a
 * very common Docker base for exactly the kind of small bot this packages, so this was a real
 * gap, not a hypothetical one.
 */
const NATIVE_HOST_BUILD_TARGET = {
    [structures_1.TargetDevice.LinuxModernX64]: "linux-x64",
    [structures_1.TargetDevice.WinXpX86]: "win-xp-x86",
    [structures_1.TargetDevice.WinVistaX86]: "win-x86",
    [structures_1.TargetDevice.WinLegacyX86]: "win-x86",
    [structures_1.TargetDevice.WinVistaX64]: "win-x64",
    [structures_1.TargetDevice.WinLegacyX64]: "win-x64",
    [structures_1.TargetDevice.LinuxX86]: "linux-x86",
    [structures_1.TargetDevice.IosIshX86]: "linux-x86",
};
/**
 * Explicit opt-in for targets where a dynamically-linked glibc build also exists, for whoever
 * specifically wants that instead of the static-musl default (e.g. matching a glibc-based
 * production image, or a smaller build when musl's own libc growth is not wanted). Static musl
 * stays the default because it is the one build that runs unmodified on both glibc and musl
 * systems; this map is deliberately not a replacement for it, and is not filled in until a target
 * both has a `build.sh` glibc variant and has been run for real.
 */
const NATIVE_HOST_GLIBC_BUILD_TARGET = {
    [structures_1.TargetDevice.LinuxModernX64]: "linux-x64-glibc",
};
/**
 * Dynamically linked against musl: what an addon needs on Alpine and iSH, where the static host
 * cannot dlopen. Only built for the targets where musl is the system libc.
 */
const NATIVE_HOST_MUSL_DYNAMIC_BUILD_TARGET = {
    [structures_1.TargetDevice.LinuxModernX64]: "linux-x64-musl-dyn",
    [structures_1.TargetDevice.LinuxX86]: "linux-x86-musl-dyn",
    [structures_1.TargetDevice.IosIshX86]: "linux-x86-musl-dyn",
};
function buildTargetFor(target, libc) {
    const map = libc === "glibc"
        ? NATIVE_HOST_GLIBC_BUILD_TARGET
        : libc === "musl-dynamic"
            ? NATIVE_HOST_MUSL_DYNAMIC_BUILD_TARGET
            : NATIVE_HOST_BUILD_TARGET;
    return map[target];
}
const PLATFORM_SUFFIX = /-(?:win32|linux|darwin|freebsd|openbsd|android)-.+$/;
/**
 * Maps an addon's archive path to the package a developer actually depends on. Native packages
 * usually ship as a per-platform sibling (`@lmdb/lmdb-win32-x64`, `mediaplex-win32-x64-msvc`), so
 * the platform suffix is stripped and both the scoped and unscoped spellings are returned.
 */
function addonPackageNames(addonPath) {
    const segments = addonPath.split("/");
    const at = segments.lastIndexOf("node_modules");
    const first = segments[at + 1];
    if (at < 0 || !first)
        return [addonPath];
    const scoped = first.startsWith("@");
    const scope = scoped ? first : "";
    const raw = (scoped ? segments[at + 2] : first) ?? first;
    const base = raw.replace(PLATFORM_SUFFIX, "");
    if (!scoped)
        return [base, raw];
    // `@lmdb/lmdb-win32-x64` is the platform half of plain `lmdb`, not of a package called `@lmdb/lmdb`.
    const own = `${scope}/${base}`;
    return scope.slice(1) === base ? [base, own, `${scope}/${raw}`] : [own, base, `${scope}/${raw}`];
}
/**
 * Splits the native addons found in a project into the ones the bot can live without and the ones
 * it needs. `required` addons decide which host gets built: a static executable cannot dlopen, so a
 * bot that depends on one needs a dynamically linked host. `optional` ones are accelerators whose own
 * library falls back to pure JavaScript, and must not be the reason a build gives up the portable
 * static host.
 */
function classifyNativeAddons(addonPaths) {
    const required = new Map();
    const optional = new Map();
    for (const path of addonPaths) {
        const names = addonPackageNames(path);
        const fallback = names.find((n) => nativeShim_1.OPTIONAL_ACCELERATORS.includes(n));
        const bucket = fallback ? optional : required;
        const key = fallback ?? names[0];
        bucket.set(key, [...(bucket.get(key) ?? []), path]);
    }
    return { required, optional };
}
/**
 * `node-compat.js`'s own dependency graph: `node-web.js` (Web platform bits), `node-misc.js`,
 * `segmenter.js` + `segmenter-tables.js` (Intl.Segmenter), and `native-modules.js` (dynamically
 * imported once a native host is present). `native-selftest.js` and `selftest.js` are test
 * harnesses, not part of what a packaged bot needs, so they are deliberately left out.
 */
const RUNTIME_FILES = [
    "node-compat.js",
    "node-web.js",
    "node-misc.js",
    "node-inspect.js",
    "segmenter.js",
    "segmenter-tables.js",
    "native-modules.js",
];
class QuickJsPackager {
    /** Whether this target has a wired-up native host build (see the module doc for why so few do). */
    static supports(target) {
        return target in NATIVE_HOST_BUILD_TARGET;
    }
    /**
     * Whether the host built for `target` with `libc` can `dlopen` a native addon. Windows hosts are
     * ordinary dynamic executables and always can. On Linux only the dynamically linked glibc build
     * can: a static musl executable has no dynamic loader to load a library with, and this is a
     * property of static linking, not a limitation of the host's Node-API layer.
     */
    static loadsAddons(target, libc) {
        const buildTarget = buildTargetFor(target, libc);
        return buildTarget !== undefined && (buildTarget.startsWith("win-") || libc !== "musl");
    }
    /**
     * Builds (and caches) the `forgegraal-c` binary for a target by invoking
     * `quickjs/native/build.sh`. Not a download: there is no published, checksummed release of
     * this binary yet (unlike `QuickJsRuntime`'s bare engine builds or Node.js itself), so the
     * only trustworthy source right now is building it from the pinned quickjs-ng/mbedTLS/miniz
     * versions the script fetches itself. Slow the first time, instant after — same cache
     * directory convention as `NodeRuntime`.
     */
    static async ensureNativeHost(target, libc = "musl", onLog = () => { }) {
        const buildTarget = buildTargetFor(target, libc);
        if (!buildTarget) {
            if (libc !== "musl") {
                const available = Object.keys(libc === "glibc" ? NATIVE_HOST_GLIBC_BUILD_TARGET : NATIVE_HOST_MUSL_DYNAMIC_BUILD_TARGET);
                throw new structures_1.RuntimeError(`No ${libc} native host build exists yet for ${target}. Only ${available.join(", ")} do. ` +
                    "Drop --native-libc to use the static-musl default instead, which every native-host target has.");
            }
            throw new structures_1.RuntimeError(`No native host build is wired up yet for ${target}. Only ${Object.keys(NATIVE_HOST_BUILD_TARGET).join(", ")} ` +
                "are, because those are the ones this build can both compile and actually run.");
        }
        const repoRoot = (0, node_path_1.dirname)(require.resolve("../../package.json"));
        const buildScript = (0, node_path_1.join)(repoRoot, "quickjs/native/build.sh");
        const cacheDir = (0, node_path_1.join)(NodeRuntime_1.NodeRuntime.cacheDir(), "native-host", buildTarget);
        const exe = (0, node_path_1.join)(cacheDir, buildTarget.startsWith("win-") ? "forgegraal-c.exe" : "forgegraal-c");
        // The cached binary is only good for the sources it was built from: a host cached before the
        // native layer changed would otherwise be reused forever, missing whatever changed.
        const sourceHash = QuickJsPackager.nativeSourceHash(repoRoot);
        const marker = (0, node_path_1.join)(cacheDir, ".native-source-hash");
        if ((0, node_fs_1.existsSync)(exe) && (0, node_fs_1.existsSync)(marker) && (0, node_fs_1.readFileSync)(marker, "utf-8") === sourceHash)
            return exe;
        onLog(`Building the ForgeGraal native host for '${buildTarget}' (first run only; cached at ${exe} after)`);
        (0, node_fs_1.mkdirSync)(cacheDir, { recursive: true });
        const result = (0, node_child_process_1.spawnSync)("sh", [buildScript, buildTarget, cacheDir], { stdio: "inherit" });
        if (result.status !== 0 || !(0, node_fs_1.existsSync)(exe)) {
            throw new structures_1.RuntimeError(`Building the native host for '${buildTarget}' failed (exit ${result.status ?? result.signal}). ` +
                "See quickjs/native/build.sh's own output above for the reason.");
        }
        (0, node_fs_1.chmodSync)(exe, 0o755);
        (0, node_fs_1.writeFileSync)(marker, sourceHash);
        return exe;
    }
    /**
     * Whether every one of these addon files is linked against musl rather than glibc, which decides
     * which dynamic host fits them: a musl-linked addon cannot load into a glibc process, or the reverse.
     */
    static addonsAreMusl(entries, paths) {
        const sources = paths
            .map((p) => entries.find((e) => e.path === p)?.source)
            .filter((s) => typeof s === "string");
        // glibc-linked code carries GLIBC_x.y symbol-version strings; musl-linked code names musl's loader
        // or its libc (Rust's musl targets say libc.musl-<arch>.so.1, musl's own toolchains just libc.so).
        return (sources.length > 0 &&
            sources.every((file) => {
                const bytes = (0, node_fs_1.readFileSync)(file);
                if (bytes.includes("GLIBC_"))
                    return false;
                return bytes.includes("libc.musl") || bytes.includes("ld-musl") || bytes.includes("libc.so\0");
            }));
    }
    /** Hash of everything under `quickjs/native/` that ends up inside the host binary. */
    static nativeSourceHash(repoRoot) {
        const hash = (0, node_crypto_1.createHash)("sha256");
        const walk = (dir) => {
            for (const entry of (0, node_fs_1.readdirSync)(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                const path = (0, node_path_1.join)(dir, entry.name);
                if (entry.isDirectory())
                    walk(path);
                else if (/\.(c|h|sh|py)$/.test(entry.name))
                    hash.update(entry.name).update((0, node_fs_1.readFileSync)(path));
            }
        };
        walk((0, node_path_1.join)(repoRoot, "quickjs/native"));
        hash.update((0, node_fs_1.readFileSync)((0, node_path_1.join)(repoRoot, "quickjs/winxp-compat.patch")));
        return hash.digest("hex");
    }
    /**
     * Writes the project, the compatibility layer and the native host into `outputPath`, plus a
     * launcher script that runs them with no Node.js involved at any point.
     */
    static build(options) {
        const meta = structures_1.TARGET_METADATA_MAP[options.target];
        if (!meta)
            throw new structures_1.RuntimeError(`Unknown target '${options.target}'`);
        const isWindows = meta.nodePlatform === "win32";
        const out = options.outputPath;
        (0, node_fs_1.mkdirSync)(out, { recursive: true });
        let sizeBytes = 0;
        const hash = (0, node_crypto_1.createHash)("sha256");
        const appDir = (0, node_path_1.join)(out, "app");
        for (const entry of options.entries) {
            const dest = (0, node_path_1.join)(appDir, entry.path);
            (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(dest), { recursive: true });
            const bytes = typeof entry.source === "string" ? (0, node_fs_1.readFileSync)(entry.source) : entry.source;
            (0, node_fs_1.writeFileSync)(dest, bytes);
            if (entry.mode)
                (0, node_fs_1.chmodSync)(dest, entry.mode);
            sizeBytes += bytes.length;
            hash.update(entry.path).update(bytes);
        }
        const runtimeDir = (0, node_path_1.join)(out, "runtime");
        (0, node_fs_1.mkdirSync)(runtimeDir, { recursive: true });
        const repoRoot = (0, node_path_1.dirname)(require.resolve("../../package.json"));
        for (const file of RUNTIME_FILES) {
            const from = (0, node_path_1.join)(repoRoot, "quickjs/runtime", file);
            const to = (0, node_path_1.join)(runtimeDir, file);
            (0, node_fs_1.copyFileSync)(from, to);
            const bytes = (0, node_fs_1.readFileSync)(to);
            sizeBytes += bytes.length;
            hash.update(file).update(bytes);
        }
        const hostDest = (0, node_path_1.join)(out, isWindows ? "forgegraal-c.exe" : "forgegraal-c");
        (0, node_fs_1.copyFileSync)(options.nativeHostBinary, hostDest);
        if (!isWindows)
            (0, node_fs_1.chmodSync)(hostDest, 0o755);
        const hostBytes = (0, node_fs_1.readFileSync)(hostDest);
        sizeBytes += hostBytes.length;
        hash.update("forgegraal-c").update(hostBytes);
        const launcherPath = (0, node_path_1.join)(out, isWindows ? `${options.name}.cmd` : options.name);
        const appEntry = `app/${options.entry}`;
        if (isWindows) {
            (0, node_fs_1.writeFileSync)(launcherPath, [
                "@echo off",
                "setlocal",
                'set "FORGEGRAAL_DIR=%~dp0"',
                `"%FORGEGRAAL_DIR%forgegraal-c.exe" "%FORGEGRAAL_DIR%runtime\\node-compat.js" "%FORGEGRAAL_DIR%${appEntry.replace(/\//g, "\\")}" %*`,
                "exit /b %ERRORLEVEL%",
                "",
            ].join("\r\n"));
        }
        else {
            (0, node_fs_1.writeFileSync)(launcherPath, [
                "#!/bin/sh",
                'FORGEGRAAL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1',
                `exec "$FORGEGRAAL_DIR/forgegraal-c" "$FORGEGRAAL_DIR/runtime/node-compat.js" "$FORGEGRAAL_DIR/${appEntry}" "$@"`,
                "",
            ].join("\n"));
            (0, node_fs_1.chmodSync)(launcherPath, 0o755);
        }
        return {
            outputPath: out,
            launcherPath,
            nativeHostBinary: hostDest,
            sizeBytes,
            sha256: hash.digest("hex"),
            warnings: [
                "This build ships as loose files (app/, runtime/, forgegraal-c) rather than a single compressed " +
                    "archive: the quickjs path has no in-runtime unarchiver yet. Distribute the whole output directory.",
            ],
        };
    }
}
exports.QuickJsPackager = QuickJsPackager;
//# sourceMappingURL=QuickJsPackager.js.map
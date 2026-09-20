import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RuntimeError, TARGET_METADATA_MAP, TargetDevice } from "../structures";
import type { ArchiveEntry } from "./Archive";
import { NodeRuntime } from "./NodeRuntime";

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
const NATIVE_HOST_BUILD_TARGET: Partial<Record<TargetDevice, string>> = {
	[TargetDevice.LinuxModernX64]: "linux-x64",
	[TargetDevice.WinXpX86]: "win-xp-x86",
	[TargetDevice.WinVistaX86]: "win-x86",
	[TargetDevice.WinLegacyX86]: "win-x86",
	[TargetDevice.WinVistaX64]: "win-x64",
	[TargetDevice.WinLegacyX64]: "win-x64",
	[TargetDevice.LinuxX86]: "linux-x86",
	[TargetDevice.IosIshX86]: "linux-x86",
};

/**
 * Explicit opt-in for targets where a dynamically-linked glibc build also exists, for whoever
 * specifically wants that instead of the static-musl default (e.g. matching a glibc-based
 * production image, or a smaller build when musl's own libc growth is not wanted). Static musl
 * stays the default because it is the one build that runs unmodified on both glibc and musl
 * systems; this map is deliberately not a replacement for it, and is not filled in until a target
 * both has a `build.sh` glibc variant and has been run for real.
 */
const NATIVE_HOST_GLIBC_BUILD_TARGET: Partial<Record<TargetDevice, string>> = {
	[TargetDevice.LinuxModernX64]: "linux-x64-glibc",
};

export type NativeHostLibc = "musl" | "glibc";

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
	"segmenter.js",
	"segmenter-tables.js",
	"native-modules.js",
];

export interface QuickJsBuildOptions {
	target: TargetDevice;
	name: string;
	/** Entry file, relative to the project root, POSIX separators (as `ProjectCollector` gives it). */
	entry: string;
	entries: ArchiveEntry[];
	outputPath: string;
	/** Path to a `forgegraal-c`(.exe) built by `ensureNativeHost()`. */
	nativeHostBinary: string;
}

export interface QuickJsBuildResult {
	outputPath: string;
	launcherPath: string;
	nativeHostBinary: string;
	sizeBytes: number;
	/** SHA-256 over the bundled app files and the native host binary, in write order. */
	sha256: string;
	warnings: string[];
}

export class QuickJsPackager {
	/** Whether this target has a wired-up native host build (see the module doc for why so few do). */
	public static supports(target: TargetDevice): boolean {
		return target in NATIVE_HOST_BUILD_TARGET;
	}

	/**
	 * Builds (and caches) the `forgegraal-c` binary for a target by invoking
	 * `quickjs/native/build.sh`. Not a download: there is no published, checksummed release of
	 * this binary yet (unlike `QuickJsRuntime`'s bare engine builds or Node.js itself), so the
	 * only trustworthy source right now is building it from the pinned quickjs-ng/mbedTLS/miniz
	 * versions the script fetches itself. Slow the first time, instant after — same cache
	 * directory convention as `NodeRuntime`.
	 */
	public static async ensureNativeHost(
		target: TargetDevice,
		libc: NativeHostLibc = "musl",
		onLog: (message: string) => void = () => {}
	): Promise<string> {
		const map = libc === "glibc" ? NATIVE_HOST_GLIBC_BUILD_TARGET : NATIVE_HOST_BUILD_TARGET;
		const buildTarget = map[target];
		if (!buildTarget) {
			if (libc === "glibc") {
				throw new RuntimeError(
					`No glibc native host build exists yet for ${target}. Only ${Object.keys(NATIVE_HOST_GLIBC_BUILD_TARGET).join(", ")} ` +
						"do. Drop --native-libc to use the static-musl default instead, which every native-host target has."
				);
			}
			throw new RuntimeError(
				`No native host build is wired up yet for ${target}. Only ${Object.keys(NATIVE_HOST_BUILD_TARGET).join(", ")} ` +
					"are, because those are the ones this build can both compile and actually run."
			);
		}

		const repoRoot = dirname(require.resolve("../../package.json"));
		const buildScript = join(repoRoot, "quickjs/native/build.sh");
		const cacheDir = join(NodeRuntime.cacheDir(), "native-host", buildTarget);
		const exe = join(cacheDir, buildTarget.startsWith("win-") ? "forgegraal-c.exe" : "forgegraal-c");
		if (existsSync(exe)) return exe;

		onLog(`Building the ForgeGraal native host for '${buildTarget}' (first run only; cached at ${exe} after)`);
		mkdirSync(cacheDir, { recursive: true });
		const result = spawnSync("sh", [buildScript, buildTarget, cacheDir], { stdio: "inherit" });
		if (result.status !== 0 || !existsSync(exe)) {
			throw new RuntimeError(
				`Building the native host for '${buildTarget}' failed (exit ${result.status ?? result.signal}). ` +
					"See quickjs/native/build.sh's own output above for the reason."
			);
		}
		chmodSync(exe, 0o755);
		return exe;
	}

	/**
	 * Writes the project, the compatibility layer and the native host into `outputPath`, plus a
	 * launcher script that runs them with no Node.js involved at any point.
	 */
	public static build(options: QuickJsBuildOptions): QuickJsBuildResult {
		const meta = TARGET_METADATA_MAP[options.target];
		if (!meta) throw new RuntimeError(`Unknown target '${options.target}'`);
		const isWindows = meta.nodePlatform === "win32";

		const out = options.outputPath;
		mkdirSync(out, { recursive: true });

		let sizeBytes = 0;
		const hash = createHash("sha256");
		const appDir = join(out, "app");
		for (const entry of options.entries) {
			const dest = join(appDir, entry.path);
			mkdirSync(dirname(dest), { recursive: true });
			const bytes = typeof entry.source === "string" ? readFileSync(entry.source) : entry.source;
			writeFileSync(dest, bytes);
			if (entry.mode) chmodSync(dest, entry.mode);
			sizeBytes += bytes.length;
			hash.update(entry.path).update(bytes);
		}

		const runtimeDir = join(out, "runtime");
		mkdirSync(runtimeDir, { recursive: true });
		const repoRoot = dirname(require.resolve("../../package.json"));
		for (const file of RUNTIME_FILES) {
			const from = join(repoRoot, "quickjs/runtime", file);
			const to = join(runtimeDir, file);
			copyFileSync(from, to);
			const bytes = readFileSync(to);
			sizeBytes += bytes.length;
			hash.update(file).update(bytes);
		}

		const hostDest = join(out, isWindows ? "forgegraal-c.exe" : "forgegraal-c");
		copyFileSync(options.nativeHostBinary, hostDest);
		if (!isWindows) chmodSync(hostDest, 0o755);
		const hostBytes = readFileSync(hostDest);
		sizeBytes += hostBytes.length;
		hash.update("forgegraal-c").update(hostBytes);

		const launcherPath = join(out, isWindows ? `${options.name}.cmd` : options.name);
		const appEntry = `app/${options.entry}`;
		if (isWindows) {
			writeFileSync(
				launcherPath,
				[
					"@echo off",
					"setlocal",
					'set "FORGEGRAAL_DIR=%~dp0"',
					`"%FORGEGRAAL_DIR%forgegraal-c.exe" "%FORGEGRAAL_DIR%runtime\\node-compat.js" "%FORGEGRAAL_DIR%${appEntry.replace(/\//g, "\\")}" %*`,
					"exit /b %ERRORLEVEL%",
					"",
				].join("\r\n")
			);
		} else {
			writeFileSync(
				launcherPath,
				[
					"#!/bin/sh",
					'FORGEGRAAL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1',
					`exec "$FORGEGRAAL_DIR/forgegraal-c" "$FORGEGRAAL_DIR/runtime/node-compat.js" "$FORGEGRAAL_DIR/${appEntry}" "$@"`,
					"",
				].join("\n")
			);
			chmodSync(launcherPath, 0o755);
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

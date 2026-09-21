import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PORTABLE_ARCHIVE_NAME, PORTABLE_LAUNCHER_NAME } from "../runtime/launcher";
import { getTargetMetadata, ProjectError, RuntimeError, type TargetMetadata } from "../structures";

/** POSIX single-quoting: safe for the plain identifier-like argv tokens bootstrap commands use. */
function shQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface PortableBuildOptions {
	target: string;
	name: string;
	launcherSource: string;
	archive: Buffer;
	/** Output directory of the bundle. */
	outputPath: string;
	/** Optional target runtime copied next to the launcher. */
	runtimeBinary?: string | null;
}

export interface PortableBuildResult {
	outputPath: string;
	launcherPath: string;
	sizeBytes: number;
	bundledRuntime: boolean;
	warnings: string[];
}

export const BUNDLE_MARKER = ".graak-bundle";

export class PortablePackager {
	public static windowsLauncher(): string {
		// `where.exe` does not exist on Windows XP, so the PATH search uses the `%~$PATH:i`
		// expansion of a for-loop variable, which every cmd.exe since NT 4 understands.
		return [
			"@echo off",
			"setlocal",
			'set "GRAAK_DIR=%~dp0"',
			'if exist "%GRAAK_DIR%node.exe" goto bundled',
			'set "GRAAK_NODE="',
			'for %%i in (node.exe) do @if not "%%~$PATH:i"=="" set "GRAAK_NODE=%%~$PATH:i"',
			"if not defined GRAAK_NODE goto missing",
			`"%GRAAK_NODE%" "%GRAAK_DIR%${PORTABLE_LAUNCHER_NAME}" %*`,
			"exit /b %ERRORLEVEL%",
			":bundled",
			`"%GRAAK_DIR%node.exe" "%GRAAK_DIR%${PORTABLE_LAUNCHER_NAME}" %*`,
			"exit /b %ERRORLEVEL%",
			":missing",
			"echo [Graak] Node.js was not found. Place node.exe next to this file or install Node.js. 1>&2",
			"exit /b 127",
			"",
		].join("\r\n");
	}

	/**
	 * When `bootstrapInstall` is set (iSH's `apk`, FreeBSD's `pkg`), the launcher runs it
	 * itself instead of just telling the user to — the device already has a real package
	 * manager that ships a real Node.js build for its own platform, so there is nothing to
	 * hunt down or verify a checksum for. Announced on stderr before it runs, since it does
	 * modify the system; not silent.
	 */
	public static unixLauncher(meta: Pick<TargetMetadata, "runtimeHint" | "bootstrapInstall">): string {
		const lines = [
			"#!/bin/sh",
			'GRAAK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1',
			'if [ -x "$GRAAK_DIR/node" ]; then',
			`  exec "$GRAAK_DIR/node" "$GRAAK_DIR/${PORTABLE_LAUNCHER_NAME}" "$@"`,
			"fi",
			"if command -v node >/dev/null 2>&1; then",
			`  exec node "$GRAAK_DIR/${PORTABLE_LAUNCHER_NAME}" "$@"`,
			"fi",
		];

		if (meta.bootstrapInstall) {
			const { command, description } = meta.bootstrapInstall;
			const quoted = command.map(shQuote).join(" ");
			lines.push(
				`echo "[Graak] Node.js was not found; installing ${description} (${quoted})..." >&2`,
				`if ${quoted} >&2; then`,
				"  if command -v node >/dev/null 2>&1; then",
				`    exec node "$GRAAK_DIR/${PORTABLE_LAUNCHER_NAME}" "$@"`,
				"  fi",
				"fi",
				`echo "[Graak] Automatic install failed, or node is still not on PATH. Run manually: ${quoted}" >&2`
			);
		} else {
			const hint = meta.runtimeHint.replace(/[`"$\\]/g, "\\$&");
			lines.push(`echo "[Graak] Node.js was not found. ${hint}" >&2`);
		}

		lines.push("exit 127", "");
		return lines.join("\n");
	}

	public static build(options: PortableBuildOptions): PortableBuildResult {
		const meta = getTargetMetadata(options.target);
		if (!meta) throw new RuntimeError(`Unknown target '${options.target}'`);

		const out = options.outputPath;
		if (existsSync(out)) {
			if (!statSync(out).isDirectory()) {
				throw new ProjectError(`Portable output '${out}' exists and is not a directory`);
			}
			if (readdirSync(out).length > 0 && !existsSync(join(out, BUNDLE_MARKER))) {
				throw new ProjectError(`Refusing to write into non-empty directory '${out}' that is not a Graak bundle`);
			}
		}
		mkdirSync(out, { recursive: true });

		const isWindows = meta.nodePlatform === "win32";
		const warnings: string[] = [];

		writeFileSync(join(out, BUNDLE_MARKER), `${options.target}\n`);
		writeFileSync(join(out, PORTABLE_ARCHIVE_NAME), options.archive);
		writeFileSync(join(out, PORTABLE_LAUNCHER_NAME), options.launcherSource);

		let launcherPath: string;
		if (isWindows) {
			launcherPath = join(out, `${options.name}.cmd`);
			writeFileSync(launcherPath, PortablePackager.windowsLauncher());
		} else {
			launcherPath = join(out, options.name);
			writeFileSync(launcherPath, PortablePackager.unixLauncher(meta));
			chmodSync(launcherPath, 0o755);
		}

		let sizeBytes = options.archive.length + Buffer.byteLength(options.launcherSource);
		if (options.runtimeBinary) {
			const runtimeDest = join(out, isWindows ? "node.exe" : "node");
			copyFileSync(options.runtimeBinary, runtimeDest);
			if (!isWindows) chmodSync(runtimeDest, 0o755);
			sizeBytes += statSync(runtimeDest).size;
		} else if (meta.bootstrapInstall) {
			// Expected, not degraded: the launcher installs a real, current build for its own
			// platform on first run (see unixLauncher), so there is nothing to bundle.
		} else {
			warnings.push(
				`No Node.js runtime bundled for ${meta.name}; the launcher uses the node found on PATH. ` +
					(meta.officialNodeFile || meta.pinnedLegacyNode
						? "Build without --offline or pass --node-binary to bundle one."
						: meta.runtimeHint)
			);
		}

		return {
			outputPath: out,
			launcherPath,
			sizeBytes,
			bundledRuntime: Boolean(options.runtimeBinary),
			warnings,
		};
	}
}

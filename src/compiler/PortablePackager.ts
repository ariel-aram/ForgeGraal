import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PORTABLE_ARCHIVE_NAME, PORTABLE_LAUNCHER_NAME } from "../runtime/launcher";
import { getTargetMetadata, ProjectError, RuntimeError } from "../structures";

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

export const BUNDLE_MARKER = ".forgegraal-bundle";

export class PortablePackager {
	public static windowsLauncher(): string {
		return [
			"@echo off",
			"setlocal",
			'set "FORGEGRAAL_DIR=%~dp0"',
			`if exist "%FORGEGRAAL_DIR%node.exe" goto bundled`,
			"where node >nul 2>nul",
			"if errorlevel 1 goto missing",
			`node "%FORGEGRAAL_DIR%${PORTABLE_LAUNCHER_NAME}" %*`,
			"exit /b %ERRORLEVEL%",
			":bundled",
			`"%FORGEGRAAL_DIR%node.exe" "%FORGEGRAAL_DIR%${PORTABLE_LAUNCHER_NAME}" %*`,
			"exit /b %ERRORLEVEL%",
			":missing",
			"echo [ForgeGraal] Node.js was not found. Place node.exe next to this file or install Node.js. 1>&2",
			"exit /b 127",
			"",
		].join("\r\n");
	}

	public static unixLauncher(runtimeHint: string): string {
		const hint = runtimeHint.replace(/[`"$\\]/g, "\\$&");
		return [
			"#!/bin/sh",
			'FORGEGRAAL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1',
			'if [ -x "$FORGEGRAAL_DIR/node" ]; then',
			`  exec "$FORGEGRAAL_DIR/node" "$FORGEGRAAL_DIR/${PORTABLE_LAUNCHER_NAME}" "$@"`,
			"fi",
			"if command -v node >/dev/null 2>&1; then",
			`  exec node "$FORGEGRAAL_DIR/${PORTABLE_LAUNCHER_NAME}" "$@"`,
			"fi",
			`echo "[ForgeGraal] Node.js was not found. ${hint}" >&2`,
			"exit 127",
			"",
		].join("\n");
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
				throw new ProjectError(`Refusing to write into non-empty directory '${out}' that is not a ForgeGraal bundle`);
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
			writeFileSync(launcherPath, PortablePackager.unixLauncher(meta.runtimeHint));
			chmodSync(launcherPath, 0o755);
		}

		let sizeBytes = options.archive.length + Buffer.byteLength(options.launcherSource);
		if (options.runtimeBinary) {
			const runtimeDest = join(out, isWindows ? "node.exe" : "node");
			copyFileSync(options.runtimeBinary, runtimeDest);
			if (!isWindows) chmodSync(runtimeDest, 0o755);
			sizeBytes += statSync(runtimeDest).size;
		} else {
			warnings.push(
				`No Node.js runtime bundled for ${meta.name}; the launcher uses the node found on PATH. ` +
					(meta.officialNodeFile ? "Build without --offline or pass --node-binary to bundle one." : meta.runtimeHint)
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

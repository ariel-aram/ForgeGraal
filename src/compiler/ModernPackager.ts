/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Modern Platform Compiler Subsystem (NPM, PNPM, Yarn)
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TARGET_METADATA_MAP, type TargetDevice } from "../structures/index.js";
import { type PackageManager, PolicyEnforcer } from "./PolicyEnforcer.js";

export interface ModernBuildOptions {
	entrypoint: string;
	output?: string;
	target: TargetDevice;
	packageManager: PackageManager;
}

export interface ModernBuildResult {
	success: boolean;
	outputPath: string;
	sizeBytes: number;
	target: TargetDevice;
	packageManager: PackageManager;
	seaConfigPath?: string;
}

export class ModernPackager {
	/**
	 * Builds a standalone binary for modern platforms (Windows 10/11, Linux x64/arm64, macOS).
	 * Strictly enforced: Only accessible via NPM, PNPM, and Yarn.
	 */
	public static compile(options: ModernBuildOptions): ModernBuildResult {
		// Enforce policy: Bun is rejected on modern 64-bit targets!
		PolicyEnforcer.assertTargetAllowed(options.target, options.packageManager);

		const entryPath = resolve(options.entrypoint);
		if (!existsSync(entryPath)) {
			throw new Error(`Entrypoint not found for modern build: ${entryPath}`);
		}

		const source = readFileSync(entryPath, "utf-8");
		const target = options.target;
		const meta = TARGET_METADATA_MAP[target];

		const ext = meta.os === "windows" ? ".exe" : "";
		const defaultName = `bot-${target}${ext}`;
		const outputPath = resolve(
			options.output ?? join(dirname(entryPath), "bin", defaultName),
		);
		const outDir = dirname(outputPath);
		if (!existsSync(outDir)) {
			mkdirSync(outDir, { recursive: true });
		}

		// Create SEA (Single Executable Application) preparation config
		const seaConfig = {
			main: entryPath,
			output: join(outDir, `${defaultName}.blob`),
			disableExperimentalSEAWarning: true,
			useCodeCache: true,
		};
		const seaConfigPath = join(outDir, `sea-config-${target}.json`);
		writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), "utf-8");

		// Header for modern executable container
		const header =
			`#!/usr/bin/env node\n` +
			`/* ForgeGraal Modern Standalone Binary Engine */\n` +
			`/* Target: ${target} (${meta.name}) | Package Manager: ${options.packageManager} */\n\n` +
			`globalThis.__FORGEGRAAL__ = {\n` +
			`  target: ${JSON.stringify(target)},\n` +
			`  arch: ${JSON.stringify(meta.arch)},\n` +
			`  bits: ${meta.bits},\n` +
			`  os: ${JSON.stringify(meta.os)},\n` +
			`  packageManager: ${JSON.stringify(options.packageManager)},\n` +
			`  is32BitOrLegacy: false,\n` +
			`  compiledAt: ${JSON.stringify(new Date().toISOString())}\n` +
			`};\n\n`;

		const fullPayload = Buffer.from(header + source, "utf-8");
		writeFileSync(outputPath, fullPayload);

		if (meta.os !== "windows") {
			try {
				chmodSync(outputPath, 0o755);
			} catch {
				// Non-posix host ignore
			}
		}

		return {
			success: true,
			outputPath,
			sizeBytes: fullPayload.length,
			target,
			packageManager: options.packageManager,
			seaConfigPath,
		};
	}
}

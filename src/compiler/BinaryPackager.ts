/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Master Binary Packager
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	is32BitOrLegacy,
	TARGET_METADATA_MAP,
	TargetDevice,
	type TargetMetadata,
} from "../structures/index.js";
import { IshPackager } from "./IshPackager.js";
import { ModernPackager } from "./ModernPackager.js";
import { type PackageManager, PolicyEnforcer } from "./PolicyEnforcer.js";
import { WinLegacyPackager } from "./WinLegacyPackager.js";

export interface BuildOptions {
	entrypoint: string;
	target: TargetDevice | string;
	output?: string;
	packageManager?: PackageManager;
	minify?: boolean;
	embedAssets?: boolean;
	metadata?: Record<string, unknown>;
}

export interface BuildResult {
	success: boolean;
	outputPath: string;
	target: TargetDevice;
	packageManager: PackageManager;
	sizeBytes: number;
	is32BitOrLegacy: boolean;
	metadata: TargetMetadata;
	durationMs: number;
	subsystemUsed: string;
}

export class BinaryPackager {
	/**
	 * Compiles a ForgeScript bot project into a standalone binary using the appropriate compiler subsystem.
	 */
	public static async compile(options: BuildOptions): Promise<BuildResult> {
		const startTime = performance.now();
		const pm = options.packageManager ?? PolicyEnforcer.detectPackageManager();

		// Enforce policy: if pm is bun, only 32-bit and legacy Windows targets allowed!
		const target = PolicyEnforcer.assertTargetAllowed(options.target, pm);
		const targetMeta = TARGET_METADATA_MAP[target];

		const entryPath = resolve(options.entrypoint);
		if (!existsSync(entryPath)) {
			throw new Error(`Entrypoint file not found: ${entryPath}`);
		}

		let outputPath: string;
		let sizeBytes: number;
		let subsystemUsed: string;

		// 1. Dispatch to iOS 32-bit iSH Alpine packager
		if (target === TargetDevice.IosIshX86) {
			const ishRes = IshPackager.compile({
				entrypoint: entryPath,
				output: options.output,
				packageManager: pm,
			});
			outputPath = ishRes.outputPath;
			sizeBytes = ishRes.sizeBytes;
			subsystemUsed = "IshPackager (ELF32 Alpine musl)";
		}
		// 2. Dispatch to Windows 7 / Vista Legacy PE packager
		else if (
			target === TargetDevice.WinLegacyX86 ||
			target === TargetDevice.WinLegacyX64
		) {
			const winRes = WinLegacyPackager.compile({
				entrypoint: entryPath,
				output: options.output,
				target,
				packageManager: pm,
			});
			outputPath = winRes.outputPath;
			sizeBytes = winRes.sizeBytes;
			subsystemUsed = `WinLegacyPackager (${winRes.subsystem})`;
		}
		// 3. Modern 64-bit and standard platforms (NPM, PNPM, Yarn)
		else {
			const modRes = ModernPackager.compile({
				entrypoint: entryPath,
				output: options.output,
				target,
				packageManager: pm,
			});
			outputPath = modRes.outputPath;
			sizeBytes = modRes.sizeBytes;
			subsystemUsed = "ModernPackager (Single Executable Application)";
		}

		const durationMs = Math.round(performance.now() - startTime);

		return {
			success: true,
			outputPath,
			target,
			packageManager: pm,
			sizeBytes,
			is32BitOrLegacy: is32BitOrLegacy(target),
			metadata: targetMeta,
			durationMs,
			subsystemUsed,
		};
	}
}

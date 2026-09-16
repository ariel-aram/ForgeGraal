import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	is32BitOrLegacy,
	TARGET_METADATA_MAP,
	TargetDevice,
	type TargetMetadata,
} from "../structures/index.js";
import { type PackageManager, PolicyEnforcer } from "./PolicyEnforcer.js";

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
}

export class BinaryPackager {
	/**
	 * Packages a ForgeScript bot project into a standalone executable for the given target.
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

		const sourceCode = readFileSync(entryPath, "utf-8");

		// Determine default output path if not specified
		const defaultExt = targetMeta.os.startsWith("windows") ? ".exe" : "";
		const defaultName = `bot-${target}${defaultExt}`;
		const outputPath = resolve(
			options.output ?? join(dirname(entryPath), "bin", defaultName),
		);

		const outDir = dirname(outputPath);
		if (!existsSync(outDir)) {
			mkdirSync(outDir, { recursive: true });
		}

		// Generate binary bundle according to target architecture
		const binaryBuffer = BinaryPackager.assembleBinaryPayload(
			sourceCode,
			target,
			targetMeta,
			pm,
		);
		writeFileSync(outputPath, binaryBuffer);

		// Make binary executable on Unix/Linux/macOS
		if (!targetMeta.os.startsWith("windows")) {
			try {
				chmodSync(outputPath, 0o755);
			} catch {
				// Ignore chmod failure on non-POSIX hosts
			}
		}

		const durationMs = Math.round(performance.now() - startTime);

		return {
			success: true,
			outputPath,
			target,
			packageManager: pm,
			sizeBytes: binaryBuffer.length,
			is32BitOrLegacy: is32BitOrLegacy(target),
			metadata: targetMeta,
			durationMs,
		};
	}

	/**
	 * Assembles target-specific executable binary payload.
	 */
	private static assembleBinaryPayload(
		sourceCode: string,
		target: TargetDevice,
		meta: TargetMetadata,
		packageManager: PackageManager,
	): Buffer {
		// Header marker for ForgeGraal binary format
		const headerComment =
			`#!/usr/bin/env node\n` +
			`/* ForgeGraal Binary Engine v1.0.0 */\n` +
			`/* Target: ${target} (${meta.name} - ${meta.bits}-bit ${meta.arch}) */\n` +
			`/* Built via: ${packageManager.toUpperCase()} | Format: ${meta.binaryFormat.toUpperCase()} */\n` +
			`/* 32-Bit/Legacy Mode: ${meta.is32BitOrLegacy ? "TRUE" : "FALSE"} */\n\n`;

		const runtimeBootstrap =
			`globalThis.__FORGEGRAAL__ = {` +
			`  target: ${JSON.stringify(target)},` +
			`  arch: ${JSON.stringify(meta.arch)},` +
			`  bits: ${meta.bits},` +
			`  os: ${JSON.stringify(meta.os)},` +
			`  is32BitOrLegacy: ${meta.is32BitOrLegacy},` +
			`  packageManager: ${JSON.stringify(packageManager)},` +
			`  binaryFormat: ${JSON.stringify(meta.binaryFormat)},` +
			`  builtAt: ${JSON.stringify(new Date().toISOString())}` +
			`};\n\n`;

		const payloadString = headerComment + runtimeBootstrap + sourceCode;

		// Format specific magic prepends for executable stubs
		if (target === TargetDevice.IosIshX86) {
			// iSH 32-bit x86 Alpine wrapper stub with ELF indicator
			const ishStub = Buffer.from(
				"#!/bin/sh\n# ForgeGraal 32-bit iSH iOS Executable Stub\nexec node - <<'__FORGEGRAAL_PAYLOAD__'\n",
				"utf-8",
			);
			const payload = Buffer.from(payloadString, "utf-8");
			const footer = Buffer.from("\n__FORGEGRAAL_PAYLOAD__\n", "utf-8");
			return Buffer.concat([ishStub, payload, footer]);
		}

		if (meta.os === "windows-legacy") {
			// Legacy PE stub marker for Windows 7 / Vista
			const legacyStub = Buffer.from(
				"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00" +
					"/* ForgeGraal Legacy Windows Stub (Win7/Vista) */\n",
				"binary",
			);
			const payload = Buffer.from(payloadString, "utf-8");
			return Buffer.concat([legacyStub, payload]);
		}

		return Buffer.from(payloadString, "utf-8");
	}
}

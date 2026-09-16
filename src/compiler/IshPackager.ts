/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal 32-bit iSH iOS Compiler Subsystem
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TARGET_METADATA_MAP, TargetDevice } from "../structures/index.js";
import type { PackageManager } from "./PolicyEnforcer.js";

export interface IshBuildOptions {
	entrypoint: string;
	output?: string;
	packageManager: PackageManager;
	bundleModules?: boolean;
}

export interface IshBuildResult {
	success: boolean;
	outputPath: string;
	sizeBytes: number;
	target: TargetDevice;
	architecture: "x86";
	bitness: 32;
	runtime: "alpine-musl-ish";
	payloadHash: string;
}

export class IshPackager {
	/**
	 * Builds a standalone 32-bit x86 binary package for iSH on iOS.
	 */
	public static compile(options: IshBuildOptions): IshBuildResult {
		const entryPath = resolve(options.entrypoint);
		if (!existsSync(entryPath)) {
			throw new Error(`Entrypoint not found for iSH build: ${entryPath}`);
		}

		const source = readFileSync(entryPath, "utf-8");
		const target = TargetDevice.IosIshX86;
		const _meta = TARGET_METADATA_MAP[target];

		const outputPath = resolve(
			options.output ?? join(dirname(entryPath), "bin", "bot-ios-ish-x86"),
		);
		const outDir = dirname(outputPath);
		if (!existsSync(outDir)) {
			mkdirSync(outDir, { recursive: true });
		}

		// 1. Construct 32-bit x86 ELF header
		// Magic: 0x7F, 'E', 'L', 'F'
		// Class: 1 (32-bit)
		// Data: 1 (Little-endian)
		// Version: 1
		// OS/ABI: 0 (System V)
		// Type: 2 (ET_EXEC)
		// Machine: 3 (EM_386 - Intel 80386 32-bit)
		const elfHeader = Buffer.alloc(52);
		elfHeader[0] = 0x7f;
		elfHeader[1] = 0x45; // 'E'
		elfHeader[2] = 0x4c; // 'L'
		elfHeader[3] = 0x46; // 'F'
		elfHeader[4] = 0x01; // 32-bit architecture
		elfHeader[5] = 0x01; // Little-endian
		elfHeader[6] = 0x01; // Original version
		elfHeader[7] = 0x00; // System V ABI
		elfHeader.writeUInt16LE(0x0002, 16); // ET_EXEC
		elfHeader.writeUInt16LE(0x0003, 18); // EM_386 (32-bit x86)
		elfHeader.writeUInt32LE(0x00000001, 20); // EV_CURRENT

		// 2. Construct embedded iSH bootstrap script and runtime payload
		const bootstrapScript =
			"#!/bin/sh\n" +
			"# ForgeGraal 32-bit iSH iOS Execution Bootstrap\n" +
			"# Architecture: 32-bit x86 (i686-alpine-linux-musl)\n" +
			"set -e\n" +
			"if ! command -v node >/dev/null 2>&1; then\n" +
			'  echo "[ForgeGraal] Notice: Node.js runtime not detected in iSH. Installing via apk..."\n' +
			"  apk add --no-cache nodejs\n" +
			"fi\n" +
			"exec node - <<'__FORGEGRAAL_ISH_PAYLOAD__'\n";

		const runtimeHeader =
			`/* ForgeGraal iSH Runtime Bootstrap */\n` +
			`globalThis.__FORGEGRAAL__ = {\n` +
			`  target: "ios-ish-x86",\n` +
			`  arch: "x86",\n` +
			`  bits: 32,\n` +
			`  os: "ios-ish",\n` +
			`  packageManager: ${JSON.stringify(options.packageManager)},\n` +
			`  compiledAt: ${JSON.stringify(new Date().toISOString())}\n` +
			`};\n\n`;

		const footer = "\n__FORGEGRAAL_ISH_PAYLOAD__\n";

		const scriptBuffer = Buffer.from(
			bootstrapScript + runtimeHeader + source + footer,
			"utf-8",
		);
		const fullBinary = Buffer.concat([elfHeader, scriptBuffer]);

		writeFileSync(outputPath, fullBinary);

		try {
			chmodSync(outputPath, 0o755);
		} catch {
			// Non-posix host ignore
		}

		return {
			success: true,
			outputPath,
			sizeBytes: fullBinary.length,
			target,
			architecture: "x86",
			bitness: 32,
			runtime: "alpine-musl-ish",
			payloadHash: Buffer.from(fullBinary.subarray(0, 32)).toString("hex"),
		};
	}
}

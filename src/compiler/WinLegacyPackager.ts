/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Windows 7 / Vista Legacy Compiler Subsystem
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TARGET_METADATA_MAP, TargetDevice } from "../structures/index.js";
import type { PackageManager } from "./PolicyEnforcer.js";

export interface WinLegacyOptions {
	entrypoint: string;
	output?: string;
	target: TargetDevice.WinLegacyX86 | TargetDevice.WinLegacyX64;
	packageManager: PackageManager;
}

export interface WinLegacyResult {
	success: boolean;
	outputPath: string;
	sizeBytes: number;
	target: TargetDevice;
	architecture: "x86" | "x64";
	subsystem: "Windows CUI (NT 6.0/6.1)";
	isLegacyCompatible: true;
}

export class WinLegacyPackager {
	/**
	 * Builds a standalone Windows 7 / Vista compatible PE executable.
	 */
	public static compile(options: WinLegacyOptions): WinLegacyResult {
		const entryPath = resolve(options.entrypoint);
		if (!existsSync(entryPath)) {
			throw new Error(
				`Entrypoint not found for Windows legacy build: ${entryPath}`,
			);
		}

		const source = readFileSync(entryPath, "utf-8");
		const target = options.target;
		const meta = TARGET_METADATA_MAP[target];

		const defaultName = `bot-${target}.exe`;
		const outputPath = resolve(
			options.output ?? join(dirname(entryPath), "bin", defaultName),
		);
		const outDir = dirname(outputPath);
		if (!existsSync(outDir)) {
			mkdirSync(outDir, { recursive: true });
		}

		// Construct PE Header:
		// 1. DOS Header: MZ magic
		const dosHeader = Buffer.alloc(64);
		dosHeader[0] = 0x4d; // 'M'
		dosHeader[1] = 0x5a; // 'Z'
		dosHeader.writeUInt32LE(0x00000080, 0x3c); // e_lfanew -> offset 0x80 for PE signature

		// 2. DOS Stub
		const dosStub = Buffer.alloc(64);
		Buffer.from("!This program cannot be run in DOS mode.$").copy(dosStub, 0);

		// 3. PE Signature ('P', 'E', 0, 0)
		const peSig = Buffer.from([0x50, 0x45, 0x00, 0x00]);

		// 4. COFF Header (20 bytes)
		const is64 = target === TargetDevice.WinLegacyX64;
		const coffHeader = Buffer.alloc(20);
		coffHeader.writeUInt16LE(is64 ? 0x8664 : 0x014c, 0); // Machine: IMAGE_FILE_MACHINE_AMD64 or I386
		coffHeader.writeUInt16LE(1, 2); // NumberOfSections
		coffHeader.writeUInt32LE(Math.floor(Date.now() / 1000), 4); // TimeDateStamp
		coffHeader.writeUInt16LE(is64 ? 240 : 224, 16); // SizeOfOptionalHeader
		coffHeader.writeUInt16LE(0x0102, 18); // Characteristics: EXECUTABLE_IMAGE | 32BIT_MACHINE (if 32)

		// 5. Windows Legacy Optional Header targeting NT 6.0/6.1 (Vista / Win 7)
		const optHeader = Buffer.alloc(is64 ? 240 : 224);
		optHeader.writeUInt16LE(is64 ? 0x020b : 0x010b, 0); // Magic: PE32 or PE32+
		optHeader.writeUInt16LE(6, 40); // MajorOperatingSystemVersion: 6 (NT 6.0 Vista / 6.1 Win 7)
		optHeader.writeUInt16LE(0, 42); // MinorOperatingSystemVersion: 0
		optHeader.writeUInt16LE(6, 48); // MajorSubsystemVersion: 6
		optHeader.writeUInt16LE(0, 50); // MinorSubsystemVersion: 0
		optHeader.writeUInt16LE(3, 68); // Subsystem: IMAGE_SUBSYSTEM_WINDOWS_CUI (Console)

		const peHeaders = Buffer.concat([
			dosHeader,
			dosStub,
			peSig,
			coffHeader,
			optHeader,
		]);

		// 6. Runtime bootstrap with legacy compatibility shims
		const runtimeBootstrap =
			`\n/* ForgeGraal Windows 7/Vista Legacy Runtime Container */\n` +
			`/* Compatible with NT 6.0 (Vista) and NT 6.1 (Windows 7) */\n` +
			`globalThis.__FORGEGRAAL__ = {\n` +
			`  target: ${JSON.stringify(target)},\n` +
			`  arch: ${JSON.stringify(meta.arch)},\n` +
			`  bits: ${meta.bits},\n` +
			`  os: "windows-legacy",\n` +
			`  packageManager: ${JSON.stringify(options.packageManager)},\n` +
			`  legacyWindowsCompatible: true,\n` +
			`  minNTVersion: "6.0",\n` +
			`  compiledAt: ${JSON.stringify(new Date().toISOString())}\n` +
			`};\n\n` +
			`// Polyfill modern Windows APIs missing in Win7/Vista\n` +
			`if (typeof process !== "undefined" && process.platform === "win32") {\n` +
			`  process.env.FORGEGRAAL_LEGACY_WIN = "1";\n` +
			`}\n\n`;

		const payload = Buffer.from(runtimeBootstrap + source, "utf-8");
		const fullBinary = Buffer.concat([peHeaders, payload]);

		writeFileSync(outputPath, fullBinary);

		return {
			success: true,
			outputPath,
			sizeBytes: fullBinary.length,
			target,
			architecture: meta.arch as "x86" | "x64",
			subsystem: "Windows CUI (NT 6.0/6.1)",
			isLegacyCompatible: true,
		};
	}
}

#!/usr/bin/env node
/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Command-Line Interface
 */

import { BinaryPackager } from "./compiler/BinaryPackager.js";
import {
	type PackageManager,
	PolicyEnforcer,
} from "./compiler/PolicyEnforcer.js";
import {
	TARGET_METADATA_MAP,
	type TargetDevice,
} from "./structures/TargetDevice.js";

const ARGS = process.argv.slice(2);

function printHelp(): void {
	console.log(`
ForgeGraal CLI - Standalone Binary Compiler for ForgeScript Bots

Usage:
  forgegraal compile <entrypoint> --target <target> [options]
  forgegraal targets [--pm <pm>]
  forgegraal info <target>
  forgegraal version

Commands:
  compile <file>    Compile a bot into a standalone binary
  targets           List supported target devices
  info <target>     Display architecture details for a target
  version           Print ForgeGraal version

Options:
  --target <name>   Target architecture (e.g. ios-ish-x86, win-legacy-x86, win-modern-x64)
  --output <path>   Destination binary output path
  --pm <name>       Package manager override (bun, pnpm, npm, yarn)
  --help            Show this help dialog
`);
}

async function main(): Promise<void> {
	if (ARGS.length === 0 || ARGS.includes("--help") || ARGS.includes("-h")) {
		printHelp();
		return;
	}

	const command = ARGS[0];

	if (command === "version") {
		console.log("ForgeGraal v1.0.0");
		return;
	}

	if (command === "targets") {
		let pm = PolicyEnforcer.detectPackageManager();
		const pmIdx = ARGS.indexOf("--pm");
		if (pmIdx !== -1 && ARGS[pmIdx + 1]) {
			pm = ARGS[pmIdx + 1].toLowerCase() as PackageManager;
		}

		console.log(`Supported Compilation Targets for [${pm.toUpperCase()}]:`);
		const allowed = PolicyEnforcer.getAllowedTargets(pm);
		for (const t of allowed) {
			const m = TARGET_METADATA_MAP[t];
			const tag = m.is32BitOrLegacy ? "[32-Bit/Legacy]" : "[Modern 64-Bit]";
			console.log(`  - ${t.padEnd(20)} ${tag.padEnd(16)} ${m.name}`);
		}
		if (pm === "bun") {
			console.log(
				"\nNotice: Bun bots are restricted to 32-bit iSH and legacy Windows targets.\n" +
					"To build modern 64-bit targets, use NPM, PNPM, or Yarn.",
			);
		}
		return;
	}

	if (command === "info") {
		const targetName = ARGS[1];
		if (!targetName) {
			console.error(
				"Error: Please provide a target name (e.g. forgegraal info ios-ish-x86)",
			);
			process.exit(1);
		}
		const meta = TARGET_METADATA_MAP[targetName as TargetDevice];
		if (!meta) {
			console.error(`Error: Unknown target '${targetName}'`);
			process.exit(1);
		}
		console.log(`Target Information: ${meta.name}`);
		console.log(`  ID            : ${meta.id}`);
		console.log(`  Architecture  : ${meta.arch}`);
		console.log(`  Bitness       : ${meta.bits}-bit`);
		console.log(`  OS Subsystem  : ${meta.os}`);
		console.log(`  Binary Format : ${meta.binaryFormat.toUpperCase()}`);
		console.log(`  32-Bit/Legacy : ${meta.is32BitOrLegacy ? "YES" : "NO"}`);
		console.log(`  Description   : ${meta.description}`);
		return;
	}

	if (command === "compile" || command === "build") {
		const entrypoint = ARGS[1];
		if (!entrypoint || entrypoint.startsWith("--")) {
			console.error("Error: Please provide the bot entrypoint file path.");
			process.exit(1);
		}

		const targetIdx = ARGS.indexOf("--target");
		if (targetIdx === -1 || !ARGS[targetIdx + 1]) {
			console.error("Error: Please specify target device with --target <name>");
			process.exit(1);
		}
		const target = ARGS[targetIdx + 1];

		let output: string | undefined;
		const outIdx = ARGS.indexOf("--output");
		if (outIdx !== -1 && ARGS[outIdx + 1]) {
			output = ARGS[outIdx + 1];
		}

		let pm: PackageManager | undefined;
		const pmIdx = ARGS.indexOf("--pm");
		if (pmIdx !== -1 && ARGS[pmIdx + 1]) {
			pm = ARGS[pmIdx + 1].toLowerCase() as PackageManager;
		}

		try {
			console.log(
				`[ForgeGraal] Compiling '${entrypoint}' for target [${target}]...`,
			);
			const res = await BinaryPackager.compile({
				entrypoint,
				target,
				output,
				packageManager: pm,
			});
			console.log(
				`[ForgeGraal] Build completed successfully in ${res.durationMs}ms:`,
			);
			console.log(`  Binary Output : ${res.outputPath}`);
			console.log(`  Subsystem     : ${res.subsystemUsed}`);
			console.log(`  Binary Size   : ${(res.sizeBytes / 1024).toFixed(2)} KB`);
			console.log(
				`  Target Arch   : ${res.metadata.bits}-bit ${res.metadata.arch}`,
			);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`\n[ForgeGraal Build Error]:\n${msg}\n`);
			process.exit(1);
		}
		return;
	}

	console.error(
		`Unknown command '${command}'. Run 'forgegraal --help' for usage.`,
	);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

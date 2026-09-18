#!/usr/bin/env node
import { parseArgs } from "node:util";
import { BinaryInspector } from "./compiler/BinaryInspector";
import { BinaryPackager, type BuildStrategy } from "./compiler/BinaryPackager";
import { PolicyEnforcer } from "./compiler/PolicyEnforcer";
import { RuntimeRegistry } from "./compiler/RuntimeRegistry";
import { ExtensionRegistry } from "./integrations/ExtensionRegistry";
import { FORGEDB_DRIVERS, type ForgeDBDriver, ForgeDBIntegration } from "./integrations/ForgeDBIntegration";
import { ALL_TARGETS, getTargetMetadata, parseTargetDevice, TARGET_METADATA_MAP } from "./structures/TargetDevice";

const VERSION: string = require("../package.json").version;

const HELP = `ForgeGraal ${VERSION} - standalone executables for ForgeScript bots

Usage:
  forgegraal compile <entrypoint.js> --target <target> [options]
  forgegraal targets [--pm <package manager>]
  forgegraal info <target> [--db <driver>]
  forgegraal extensions
  forgegraal inspect <file>
  forgegraal runtimes list [--target <target>]
  forgegraal runtimes add <target> <version> <url> --sha256 <hex> [--notes <text>] [--global]
  forgegraal runtimes remove <target> <version> [--global]
  forgegraal version

Compile options:
  -t, --target <name>        Target device (see 'forgegraal targets')
  -o, --output <path>        Output file (sea) or directory (portable)
  -s, --strategy <name>      auto (default), sea or portable
      --pm <name>            Package manager override (bun, pnpm, npm, yarn)
      --node-binary <path>   Node.js runtime for the target (only needed for win-xp-x86 and linux-x86; other legacy targets provision one automatically)
      --node-version <ver>   Official Node.js version to download (e.g. 22 or 22.11.0)
      --offline              Never download runtimes
      --include-dev          Bundle devDependencies too
      --include-env          Bundle .env files (they usually contain your bot token)
      --allow-native-mismatch  Bundle native addons built for another platform
  -h, --help                 Show this help

Legacy targets that need a runtime handle it three different ways, automatically:
  - iSH, FreeBSD          : the compiled executable installs Node.js itself on first run,
                            using the device's own package manager (apk / pkg). Nothing to
                            download or verify ahead of time.
  - Windows 7 / Vista     : the last official Node.js release for Windows 7 (13.14.0) is
                            downloaded and checksum-verified automatically. It predates
                            syntax current discord.js depends on, so the build prints (and
                            keeps printing at every build) a warning about that; see
                            'forgegraal info win-legacy-x86'.
  - win-xp-x86, linux-x86 : no automatable source exists (checked: the last community
                            32-bit Linux build is Node 12.16.3, already below ForgeScript's
                            own floor). Supply a runtime with --node-binary each build, or
                            register one once (checksum-pinned) with 'forgegraal runtimes
                            add' for it to be picked up automatically after that.
`;

function fail(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

async function main(): Promise<void> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse();
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
	const { values, positionals } = parsed;
	const [command, arg] = positionals;

	if (values.help || !command || command === "help") {
		console.log(HELP);
		return;
	}

	switch (command) {
		case "version":
			console.log(`forgegraal ${VERSION}`);
			return;

		case "targets": {
			const pm = PolicyEnforcer.resolvePackageManager(values.pm);
			console.log(`Targets available for ${pm}:`);
			for (const target of PolicyEnforcer.getAllowedTargets(pm)) {
				const meta = TARGET_METADATA_MAP[target];
				const tag = meta.is32BitOrLegacy ? "[32-bit/legacy]" : "[modern 64-bit]";
				const runtime = meta.officialNodeFile
					? "sea, official"
					: meta.bootstrapInstall
						? "portable, auto-installs on device"
						: meta.pinnedLegacyNode
							? `portable, auto (Node ${meta.pinnedLegacyNode.version})`
							: "portable, --node-binary required";
				console.log(`  ${target.padEnd(20)} ${tag.padEnd(16)} ${meta.name.padEnd(32)} ${runtime}`);
			}
			if (pm === "bun") {
				console.log(
					"\nBun projects: every target above is available. TypeScript/JSX entrypoints are transpiled " +
						"automatically with 'bun build' (packages stay external, so your installed node_modules are " +
						"used). bun:sqlite and common Bun globals (env, file, write, serve, sleep, which) work in the " +
						"compiled executable through a Node.js compatibility layer; run 'forgegraal compile --help' " +
						"for details, or use 'bun build --compile' directly if you only need a modern 64-bit binary."
				);
			}
			return;
		}

		case "extensions": {
			console.log("ForgeScript Extensions & Compatibility Matrix:");
			for (const ext of ExtensionRegistry.listExtensions()) {
				console.log(`\n  ${ext.name.padEnd(16)} [${ext.package}]`);
				console.log(`    Description: ${ext.description}`);
				console.log(`    Legacy safe: ${ext.legacySafe ? "yes (polyfilled/pure-js)" : "no"}`);
				console.log(`    Notes      : ${ext.notes}`);
			}
			return;
		}

		case "info": {
			const meta = getTargetMetadata(arg);
			if (!meta) fail(`Unknown target '${arg ?? ""}'. Supported: ${ALL_TARGETS.join(", ")}`);
			console.log(`${meta.name}`);
			console.log(`  ID             : ${meta.id}`);
			console.log(`  Architecture   : ${meta.arch} (${meta.bits}-bit)`);
			console.log(`  OS             : ${meta.os}`);
			console.log(`  Binary format  : ${meta.binaryFormat}`);
			console.log(`  32-bit/legacy  : ${meta.is32BitOrLegacy ? "yes" : "no"}`);
			console.log(`  Official Node  : ${meta.officialNodeFile ?? "none"}`);
			if (meta.pinnedLegacyNode) {
				console.log(
					`  Pinned runtime : Node.js ${meta.pinnedLegacyNode.version} (${meta.pinnedLegacyNode.fileKey}), auto-fetched`
				);
			}
			if (meta.bootstrapInstall) {
				console.log(`  Auto-install   : ${meta.bootstrapInstall.command.join(" ")} (on-device, on first run)`);
			}
			console.log(`  Runtime        : ${meta.runtimeHint}`);
			console.log(`  Description    : ${meta.description}`);
			if (meta.pinnedLegacyNode) console.log(`\n  Warning: ${meta.pinnedLegacyNode.warning}`);
			if (values.db) {
				const driver = ForgeDBIntegration.parseDriver(values.db);
				if (!driver)
					fail(`Unknown ForgeDB driver '${values.db}'. Supported: ${Object.keys(FORGEDB_DRIVERS).join(", ")}`);
				const res = ForgeDBIntegration.checkDriver(driver as ForgeDBDriver, meta.id);
				console.log(`  ForgeDB ${driver.padEnd(7)}: ${res.compatible ? "compatible" : "incompatible"} (${res.reason})`);
				if (!res.compatible) {
					const alt = ForgeDBIntegration.suggestAlternative(driver as ForgeDBDriver);
					if (alt) console.log(`  Suggested driver: ${alt}`);
				}
			}
			return;
		}

		case "inspect": {
			if (!arg) fail("Please provide a file to inspect");
			const info = BinaryInspector.inspect(arg);
			if (!info) fail(`'${arg}' is not an ELF, PE or Mach-O binary`);
			console.log(JSON.stringify(info, null, 2));
			const fits = ALL_TARGETS.filter((t) => BinaryInspector.matchesTarget(info, t));
			console.log(`Runs on: ${fits.length ? fits.join(", ") : "no known target"}`);
			return;
		}

		case "runtimes": {
			const sub = positionals[1];
			const rest = positionals.slice(2);

			if (!sub || sub === "list") {
				const target = rest[0] ? parseTargetDevice(rest[0]) : null;
				if (rest[0] && !target) fail(`Unknown target '${rest[0]}'`);
				const entries = target ? RuntimeRegistry.find(target) : RuntimeRegistry.list();
				if (!entries.length) {
					console.log("No community runtimes registered. Add one with 'forgegraal runtimes add'.");
					return;
				}
				for (const e of entries) {
					console.log(`${e.target.padEnd(20)} ${e.version.padEnd(12)} ${e.url}`);
					console.log(`  sha256: ${e.sha256}${e.notes ? `\n  notes : ${e.notes}` : ""}`);
				}
				return;
			}

			if (sub === "add") {
				const [targetInput, version, url] = rest;
				if (!targetInput || !version || !url) {
					fail("Usage: forgegraal runtimes add <target> <version> <url> --sha256 <hex> [--notes <text>] [--global]");
				}
				const target = parseTargetDevice(targetInput);
				if (!target) fail(`Unknown target '${targetInput}'`);
				if (!values.sha256) {
					fail("--sha256 <hex> is required: ForgeGraal never downloads a community runtime without a pinned checksum");
				}
				try {
					RuntimeRegistry.add(
						{
							target,
							version,
							url,
							sha256: values.sha256,
							notes: values.notes,
						},
						{ global: values.global }
					);
				} catch (err) {
					fail(err instanceof Error ? err.message : String(err));
				}
				console.log(
					`Registered Node.js ${version} for ${target}${values.global ? " (global)" : " (project: .forgegraal/runtimes.json)"}.`
				);
				return;
			}

			if (sub === "remove") {
				const [target, version] = rest;
				if (!target || !version) fail("Usage: forgegraal runtimes remove <target> <version> [--global]");
				const removed = RuntimeRegistry.remove(target, version, {
					global: values.global,
				});
				console.log(removed ? "Removed." : "No matching entry found.");
				return;
			}

			fail(`Unknown 'runtimes' subcommand '${sub}'. Use list, add or remove.`);
			return;
		}

		case "compile":
		case "build": {
			if (!arg) fail("Please provide the bot entrypoint (built .js file)");
			if (!values.target) fail("Please specify the target with --target <name>");

			const result = await BinaryPackager.compile({
				entrypoint: arg,
				target: values.target,
				output: values.output,
				strategy: values.strategy as BuildStrategy | undefined,
				packageManager: values.pm,
				nodeBinary: values["node-binary"],
				nodeVersion: values["node-version"],
				offline: values.offline,
				includeDev: values["include-dev"],
				includeEnv: values["include-env"],
				allowNativeMismatch: values["allow-native-mismatch"],
				onLog: (msg) => console.log(`[ForgeGraal] ${msg}`),
			});

			for (const warning of result.warnings) console.warn(`[ForgeGraal] warning: ${warning}`);
			console.log(`[ForgeGraal] Built ${result.metadata.name} in ${result.durationMs}ms`);
			console.log(`  Strategy : ${result.strategy}`);
			console.log(`  Output   : ${result.outputPath}`);
			console.log(`  Run      : ${result.launcherPath}`);
			console.log(`  Runtime  : ${result.runtimeVersion ? `Node.js ${result.runtimeVersion}` : "system Node.js"}`);
			console.log(`  Size     : ${(result.sizeBytes / 1048576).toFixed(2)} MiB`);
			return;
		}

		default:
			fail(`Unknown command '${command}'. Run 'forgegraal --help' for usage.`);
	}
}

function parse() {
	return parseArgs({
		allowPositionals: true,
		options: {
			target: { type: "string", short: "t" },
			output: { type: "string", short: "o" },
			strategy: { type: "string", short: "s" },
			pm: { type: "string" },
			db: { type: "string" },
			"node-binary": { type: "string" },
			"node-version": { type: "string" },
			offline: { type: "boolean" },
			"include-dev": { type: "boolean" },
			"include-env": { type: "boolean" },
			"allow-native-mismatch": { type: "boolean" },
			sha256: { type: "string" },
			notes: { type: "string" },
			global: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
}

main().catch((err: unknown) => {
	console.error(`\n[ForgeGraal] ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
	process.exit(1);
});

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createLauncherSource,
	IMPORT_HELPER_PATH,
	IMPORT_HELPER_SOURCE,
} from "../runtime/launcher";
import {
	executableExtension,
	is32BitOrLegacy,
	NativeAddonMismatchError,
	RuntimeError,
	TARGET_METADATA_MAP,
	type TargetDevice,
	type TargetMetadata,
} from "../structures";
import { Archive } from "./Archive";
import { BinaryInspector } from "./BinaryInspector";
import { MIN_SEA_NODE_VERSION, NodeRuntime } from "./NodeRuntime";
import { type PackageManager, PolicyEnforcer } from "./PolicyEnforcer";
import { PortablePackager } from "./PortablePackager";
import { compareVersions, ProjectCollector } from "./ProjectCollector";
import { SeaPackager } from "./SeaPackager";

export type BuildStrategy = "auto" | "sea" | "portable";

export interface BuildOptions {
	entrypoint: string;
	target: TargetDevice | string;
	/** File path for SEA builds, directory path for portable builds. */
	output?: string;
	packageManager?: PackageManager | string;
	strategy?: BuildStrategy;
	/** Node.js runtime for the target (required for targets without official builds). */
	nodeBinary?: string;
	/** Official Node.js version to download, e.g. "22" or "22.11.0". */
	nodeVersion?: string;
	/** Disallow network access (no runtime downloads). */
	offline?: boolean;
	includeDev?: boolean;
	includeEnv?: boolean;
	allowNativeMismatch?: boolean;
	onLog?: (message: string) => void;
}

export interface BuildResult {
	success: true;
	strategy: "sea" | "portable";
	outputPath: string;
	/** Executable to start: the SEA binary or the portable launcher script. */
	launcherPath: string;
	target: TargetDevice;
	packageManager: PackageManager;
	sizeBytes: number;
	is32BitOrLegacy: boolean;
	metadata: TargetMetadata;
	runtimeVersion: string | null;
	archiveSha256: string;
	files: number;
	packages: number;
	durationMs: number;
	warnings: string[];
}

export const DEFAULT_OUTPUT_DIR = "forgegraal-out";

interface RuntimeSelection {
	binary: string | null;
	version: string | null;
	seaReady: boolean;
	reason: string | null;
}

export class BinaryPackager {
	/**
	 * Builds a ForgeScript bot into a Node.js Single Executable Application when the target
	 * runtime supports it, otherwise into a portable bundle (launcher + archive + runtime).
	 */
	public static async compile(options: BuildOptions): Promise<BuildResult> {
		const startTime = performance.now();
		const log = options.onLog ?? (() => {});
		const strategy = options.strategy ?? "auto";
		if (!["auto", "sea", "portable"].includes(strategy)) {
			throw new RuntimeError(
				`Unknown strategy '${strategy}' (expected auto, sea or portable)`,
			);
		}

		const root = ProjectCollector.findProjectRoot(resolve(options.entrypoint));
		const pm = PolicyEnforcer.resolvePackageManager(
			options.packageManager,
			root,
		);
		const target = PolicyEnforcer.assertTargetAllowed(options.target, pm);
		const meta = TARGET_METADATA_MAP[target];
		const warnings: string[] = [];

		const defaultOutDir = join(root, DEFAULT_OUTPUT_DIR);
		const excludePaths = [defaultOutDir];
		if (options.output) excludePaths.push(resolve(options.output));

		log(`Collecting project files from ${root} (${pm})`);
		const project = ProjectCollector.collect({
			entrypoint: options.entrypoint,
			includeDev: options.includeDev,
			includeEnv: options.includeEnv,
			excludePaths,
		});

		if (pm === "bun" && project.usesBunApis.length) {
			warnings.push(
				`Bun-only APIs detected (${project.usesBunApis.slice(0, 5).join(", ")}). Executables run on Node.js, where these APIs do not exist.`,
			);
		}
		if (!options.includeEnv) {
			warnings.push(
				".env files were not bundled; provide secrets through the environment at runtime.",
			);
		}
		BinaryPackager.checkNativeAddons(
			project.nativeAddons,
			target,
			options,
			warnings,
		);

		const runtime = await BinaryPackager.selectRuntime(
			target,
			meta,
			project.minNode,
			options,
			log,
		);
		if (
			runtime.version &&
			project.minNode &&
			compareVersions(runtime.version, project.minNode) < 0
		) {
			throw new RuntimeError(
				`The bundled dependencies require Node.js >= ${project.minNode}, but the target runtime is ${runtime.version}.`,
			);
		}

		let chosen: "sea" | "portable";
		if (strategy === "sea") {
			if (!runtime.seaReady)
				throw new RuntimeError(
					`Cannot build a SEA for ${meta.name}: ${runtime.reason}`,
				);
			chosen = "sea";
		} else if (strategy === "portable") {
			chosen = "portable";
		} else {
			chosen = runtime.seaReady ? "sea" : "portable";
			if (!runtime.seaReady && runtime.binary) {
				warnings.push(`Falling back to a portable bundle: ${runtime.reason}`);
			}
		}

		const archive = Archive.pack([
			...project.entries,
			{
				path: IMPORT_HELPER_PATH,
				source: Buffer.from(IMPORT_HELPER_SOURCE),
				mode: 0o644,
			},
		]);
		const launcherSource = createLauncherSource({
			name: project.name,
			entry: project.entry,
			hash: archive.sha256,
			minNode: project.minNode,
			target,
			mode: chosen,
		});
		log(
			`Packed ${archive.files} files from ${project.packages} packages (${(archive.buffer.length / 1048576).toFixed(1)} MiB compressed)`,
		);

		let outputPath: string;
		let launcherPath: string;
		let sizeBytes: number;

		if (chosen === "sea") {
			outputPath = resolve(
				options.output ??
					join(
						defaultOutDir,
						`${project.name}-${target}${executableExtension(target)}`,
					),
			);
			if (existsSync(outputPath) && statSync(outputPath).isDirectory()) {
				throw new RuntimeError(
					`SEA output '${outputPath}' is a directory; pass a file path`,
				);
			}
			const { binary, version } = runtime;
			if (!binary || !version) {
				throw new RuntimeError(
					"SEA builds need a runtime with a known version",
				);
			}
			const generator = await BinaryPackager.selectGenerator(
				target,
				binary,
				version,
				options,
				warnings,
				log,
			);
			log(
				`Injecting SEA blob into Node.js ${runtime.version ?? "(unknown version)"}`,
			);
			const res = await SeaPackager.build({
				target,
				runtimeBinary: binary,
				generatorBinary: generator,
				launcherSource,
				archive: archive.buffer,
				outputPath,
			});
			warnings.push(...res.warnings);
			launcherPath = outputPath;
			sizeBytes = res.sizeBytes;
		} else {
			outputPath = resolve(
				options.output ?? join(defaultOutDir, `${project.name}-${target}`),
			);
			const res = PortablePackager.build({
				target,
				name: project.name,
				launcherSource,
				archive: archive.buffer,
				outputPath,
				runtimeBinary: runtime.binary,
			});
			warnings.push(...res.warnings);
			launcherPath = res.launcherPath;
			sizeBytes = res.sizeBytes;
		}

		return {
			success: true,
			strategy: chosen,
			outputPath,
			launcherPath,
			target,
			packageManager: pm,
			sizeBytes,
			is32BitOrLegacy: is32BitOrLegacy(target),
			metadata: meta,
			runtimeVersion: runtime.version,
			archiveSha256: archive.sha256,
			files: archive.files,
			packages: project.packages,
			durationMs: Math.round(performance.now() - startTime),
			warnings,
		};
	}

	private static checkNativeAddons(
		addons: ReturnType<typeof ProjectCollector.collect>["nativeAddons"],
		target: TargetDevice,
		options: BuildOptions,
		warnings: string[],
	) {
		// Prebuilt packages often ship addons for several platforms: a package is fine
		// as soon as one of its addons fits the target
		const byPackage = new Map<
			string,
			{ usable: boolean; mismatched: string[] }
		>();
		for (const addon of addons) {
			const idx = addon.path.lastIndexOf("node_modules/");
			const rest = idx === -1 ? addon.path : addon.path.slice(idx + 13);
			const pkgName =
				idx === -1
					? "(project)"
					: rest
							.split("/")
							.slice(0, rest.startsWith("@") ? 2 : 1)
							.join("/");
			const key =
				idx === -1 ? pkgName : addon.path.slice(0, idx + 13) + pkgName;
			const entry = byPackage.get(key) ?? { usable: false, mismatched: [] };
			byPackage.set(key, entry);

			if (!addon.info) {
				warnings.push(`Could not identify native addon '${addon.path}'.`);
			} else if (BinaryInspector.matchesTarget(addon.info, target)) {
				entry.usable = true;
			} else {
				entry.mismatched.push(
					`${addon.path} (${addon.info.format} ${addon.info.arch})`,
				);
			}
		}

		const mismatched = [...byPackage.values()]
			.filter((p) => !p.usable)
			.flatMap((p) => p.mismatched);
		if (!mismatched.length) return;
		if (options.allowNativeMismatch) {
			warnings.push(
				`Native addons that cannot run on ${target} were bundled: ${mismatched.join(", ")}`,
			);
			return;
		}
		throw new NativeAddonMismatchError(target, mismatched);
	}

	private static async selectRuntime(
		target: TargetDevice,
		meta: TargetMetadata,
		minNode: string | null,
		options: BuildOptions,
		log: (message: string) => void,
	): Promise<RuntimeSelection> {
		let binary: string | null = null;

		if (options.nodeBinary) {
			binary = resolve(options.nodeBinary);
			if (!existsSync(binary) || !statSync(binary).isFile()) {
				throw new RuntimeError(`Node.js binary not found: ${binary}`);
			}
			if (meta.os === "windows-legacy") {
				log(
					"Make sure the supplied runtime supports Windows 7 / Vista; official Node.js >= 14 does not.",
				);
			}
			const info = BinaryInspector.inspect(binary);
			if (!info || !BinaryInspector.matchesTarget(info, target)) {
				throw new RuntimeError(
					`'${binary}' (${info ? `${info.format} ${info.arch}` : "unknown format"}) cannot run on ${meta.name} (${meta.binaryFormat} ${meta.arch}).`,
				);
			}
		} else if (meta.officialNodeFile && !options.offline) {
			const version = await NodeRuntime.resolveOfficialVersion(
				meta.officialNodeFile,
				options.nodeVersion,
				minNode,
			);
			log(`Downloading official Node.js ${version} (${meta.officialNodeFile})`);
			binary = await NodeRuntime.ensureOfficial(version, meta.officialNodeFile);
		}

		if (!binary) {
			return {
				binary: null,
				version: null,
				seaReady: false,
				reason: meta.officialNodeFile
					? "runtime downloads are disabled (offline) and no --node-binary was given."
					: `no Node.js runtime was given. ${meta.runtimeHint}`,
			};
		}

		const version = NodeRuntime.readVersion(binary);
		const fuse = NodeRuntime.seaFuseState(readFileSync(binary));
		let reason: string | null = null;
		if (!version) reason = "the runtime version could not be determined.";
		else if (compareVersions(version, MIN_SEA_NODE_VERSION) < 0) {
			reason = `Node.js ${version} is older than ${MIN_SEA_NODE_VERSION}, which SEA assets require.`;
		} else if (fuse !== "ready") {
			reason =
				fuse === "absent"
					? "the runtime was built without SEA support."
					: "the runtime is already a SEA.";
		}

		return { binary, version, seaReady: reason === null, reason };
	}

	/**
	 * The SEA blob should be produced by the same Node.js version it is injected into.
	 */
	private static async selectGenerator(
		target: TargetDevice,
		binary: string,
		version: string,
		options: BuildOptions,
		warnings: string[],
		log: (message: string) => void,
	): Promise<string> {
		if (NodeRuntime.canRunOnHost(target)) return binary;

		if (process.versions.node === version) return process.execPath;

		const hostKey = NodeRuntime.hostFileKey();
		if (hostKey && !options.offline) {
			try {
				log(`Downloading host Node.js ${version} to generate the SEA blob`);
				return await NodeRuntime.ensureOfficial(version, hostKey);
			} catch (err) {
				warnings.push(
					`Could not get a host Node.js ${version} (${err instanceof Error ? err.message : String(err)}).`,
				);
			}
		}

		if (compareVersions(process.versions.node, MIN_SEA_NODE_VERSION) < 0) {
			throw new RuntimeError(
				`Generating a SEA blob needs Node.js >= ${MIN_SEA_NODE_VERSION} on the build host.`,
			);
		}
		if (process.versions.node.split(".")[0] !== version.split(".")[0]) {
			warnings.push(
				`SEA blob generated with Node.js ${process.versions.node} for a ${version} runtime; blob formats can differ between major versions. Test the executable on the target.`,
			);
		}
		return process.execPath;
	}
}

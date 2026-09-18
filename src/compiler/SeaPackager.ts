import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SEA_ASSET_NAME } from "../runtime/launcher";
import { getTargetMetadata, RuntimeError } from "../structures";
import { NodeRuntime, SEA_FUSE } from "./NodeRuntime";

export interface SeaBuildOptions {
	target: string;
	/** Node.js runtime for the target platform the blob is injected into. */
	runtimeBinary: string;
	/** Node.js runtime runnable on this host, same version as the target runtime when possible. */
	generatorBinary: string;
	launcherSource: string;
	archive: Buffer;
	outputPath: string;
}

export interface SeaBuildResult {
	outputPath: string;
	sizeBytes: number;
	warnings: string[];
}

export class SeaPackager {
	/**
	 * The SEA configuration consumed by `node --experimental-sea-config`.
	 * Snapshots and code cache are disabled because they are only valid for the exact
	 * platform and binary that generated them, which breaks cross compilation.
	 */
	public static createConfig(main: string, blob: string, assets: Record<string, string> = {}) {
		return {
			main,
			output: blob,
			disableExperimentalSEAWarning: true,
			useSnapshot: false,
			useCodeCache: false,
			assets,
		};
	}

	public static async build(options: SeaBuildOptions): Promise<SeaBuildResult> {
		const meta = getTargetMetadata(options.target);
		if (!meta) throw new RuntimeError(`Unknown target '${options.target}'`);

		const runtime = readFileSync(options.runtimeBinary);
		const fuse = NodeRuntime.seaFuseState(runtime);
		if (fuse === "absent") {
			throw new RuntimeError(`'${options.runtimeBinary}' was built without Single Executable Application support.`);
		}
		if (fuse === "injected") {
			throw new RuntimeError(`'${options.runtimeBinary}' is already a Single Executable Application.`);
		}

		const warnings: string[] = [];
		const work = mkdtempSync(join(tmpdir(), "forgegraal-sea-"));
		const partial = `${options.outputPath}.${process.pid}.partial`;

		try {
			const mainPath = join(work, "boot.cjs");
			const archivePath = join(work, SEA_ASSET_NAME);
			const blobPath = join(work, "sea-prep.blob");
			const configPath = join(work, "sea-config.json");

			writeFileSync(mainPath, options.launcherSource);
			writeFileSync(archivePath, options.archive);
			writeFileSync(
				configPath,
				JSON.stringify(
					SeaPackager.createConfig(mainPath, blobPath, {
						[SEA_ASSET_NAME]: archivePath,
					})
				)
			);

			execFileSync(options.generatorBinary, ["--experimental-sea-config", configPath], {
				cwd: work,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10 * 60_000,
			});

			mkdirSync(dirname(options.outputPath), { recursive: true });
			copyFileSync(options.runtimeBinary, partial);
			chmodSync(partial, 0o755);

			const isMac = meta.nodePlatform === "darwin";
			if (isMac && process.platform === "darwin") {
				execFileSync("codesign", ["--remove-signature", partial]);
			}

			// postject ships as CommonJS with a lazily loaded WebAssembly module
			const { inject } = require("postject") as typeof import("postject");
			await inject(partial, "NODE_SEA_BLOB", readFileSync(blobPath), {
				sentinelFuse: SEA_FUSE,
				machoSegmentName: isMac ? "NODE_SEA" : undefined,
			});

			if (isMac) {
				if (process.platform === "darwin") {
					execFileSync("codesign", ["--sign", "-", partial]);
				} else {
					warnings.push(
						"macOS refuses unsigned modified binaries: run `codesign --sign - <binary>` on a Mac before distributing."
					);
				}
			}
			if (meta.nodePlatform === "win32") {
				warnings.push(
					"The embedded node.exe Authenticode signature is invalidated by injection; re-sign the executable if you distribute it."
				);
			}

			renameSync(partial, options.outputPath);
			return {
				outputPath: options.outputPath,
				sizeBytes: statSync(options.outputPath).size,
				warnings,
			};
		} catch (err) {
			rmSync(partial, { force: true });
			if (err && typeof err === "object" && "stderr" in err && err.stderr) {
				throw new RuntimeError(`SEA blob generation failed: ${String(err.stderr).trim()}`);
			}
			throw err;
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}
}

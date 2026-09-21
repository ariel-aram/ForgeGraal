import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { ProjectError } from "../structures";

/**
 * Extensions Bun bots are commonly authored in that plain Node.js cannot `require()`
 * directly. Graak transpiles these with `bun build` when the project's package manager
 * is Bun, instead of asking the user to pre-build — Bun projects are frequently run straight
 * from `.ts` with no separate build step, unlike npm/pnpm/yarn projects.
 */
export const BUN_TRANSPILABLE_EXTENSIONS = new Set([".ts", ".tsx", ".jsx", ".mts", ".cts"]);

export interface BunTranspileResult {
	/** Path to the transpiled CommonJS entrypoint, written next to the original file. */
	entrypoint: string;
	/** Removes the transpiled file. Safe to call more than once. */
	cleanup: () => void;
}

export class BunTranspiler {
	public static isAvailable(): boolean {
		try {
			execFileSync("bun", ["--version"], { stdio: "ignore", timeout: 5_000 });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Transpiles a Bun-authored entrypoint into plain CommonJS with `bun build`. Local,
	 * relative imports are bundled into the single output file; bare package imports
	 * (`require("discord.js")`) are kept as `--packages=external` so Graak's own
	 * dependency walk resolves them from the real, installed `node_modules` afterward rather
	 * than from a bundler's copy — the same packages the project's lockfile pinned.
	 *
	 * The output is written next to the source file (not a temp directory), because
	 * `ProjectCollector.findProjectRoot` walks up from the entrypoint's directory to find
	 * `package.json`, and the file must be inside the project tree to be collected.
	 */
	public static transpile(entrypoint: string): BunTranspileResult {
		const dir = dirname(entrypoint);
		const name = basename(entrypoint, extname(entrypoint));
		const outfile = join(dir, `${name}.graak-build.cjs`);

		try {
			execFileSync(
				"bun",
				["build", entrypoint, "--target=node", "--format=cjs", "--packages=external", `--outfile=${outfile}`],
				{ stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }
			);
		} catch (err) {
			try {
				unlinkSync(outfile);
			} catch {
				// Nothing was written, or it's already gone
			}
			const stderr =
				err && typeof err === "object" && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
			throw new ProjectError(
				`'bun build' failed to transpile '${entrypoint}':\n${(stderr || (err instanceof Error ? err.message : String(err))).trim()}`
			);
		}

		if (!existsSync(outfile)) {
			throw new ProjectError(`'bun build' did not produce an output file for '${entrypoint}'`);
		}

		let cleaned = false;
		return {
			entrypoint: outfile,
			cleanup: () => {
				if (cleaned) return;
				cleaned = true;
				try {
					unlinkSync(outfile);
				} catch {
					// Already removed, or never created
				}
			},
		};
	}
}

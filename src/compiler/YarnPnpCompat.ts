import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { RuntimeError } from "../structures";
import { isInside } from "./ProjectCollector";

/**
 * Lets Graak build a Yarn Plug'n'Play project without reimplementing Yarn's own resolver.
 *
 * A PnP project has no `node_modules` at all: dependencies live as zip archives (in the project's
 * `.yarn/cache/` or, by default, a global cache outside the project entirely) that `.pnp.cjs`
 * resolves at require() time. `ProjectCollector` -- and pnpm's virtual-store walk right beside it
 * -- both assume a real directory tree to copy, so neither can see a PnP install as-is.
 *
 * Rather than parsing `.pnp.cjs` or the zip cache directly, this asks Yarn itself to produce a
 * normal `node_modules` tree from the exact same `yarn.lock`, by overriding `nodeLinker` for one
 * throwaway install: `YARN_NODE_LINKER=node-modules yarn install`. That install runs in a
 * temporary copy of the project, never the original, so the user's `.pnp.cjs`, lockfile and
 * `.yarnrc.yml` are never touched -- Graak is assisting Yarn's own tooling here, not
 * replacing it or second-guessing how it resolves packages.
 */
export interface MaterializedProject {
	/** Root of the temporary node_modules-linked copy. */
	root: string;
	/** The original entrypoint's path, re-based onto the temporary copy. */
	entrypoint: string;
	/** Removes the temporary copy. Safe to call more than once. */
	cleanup: () => void;
}

export class YarnPnpCompat {
	public static isPnpProject(root: string): boolean {
		return existsSync(join(root, ".pnp.cjs")) || existsSync(join(root, ".pnp.js"));
	}

	/**
	 * Reads the pinned Yarn release out of `.yarnrc.yml`. A PnP project always has one -- it is
	 * how `yarn` on PATH knows which actual Yarn build to run -- so this is more reliable than
	 * hoping a compatible `yarn` is separately installed on the build machine.
	 */
	private static resolveYarnPath(root: string): string {
		const rc = join(root, ".yarnrc.yml");
		const text = existsSync(rc) ? readFileSync(rc, "utf-8") : "";
		const match = text.match(/^yarnPath:\s*(.+)$/m);
		if (!match) {
			throw new RuntimeError(
				"This is a Yarn Plug'n'Play project, but .yarnrc.yml has no `yarnPath` to run it with. " +
					"Pin one (`yarn set version berry` or `stable`), or set `nodeLinker: node-modules` " +
					"yourself and reinstall to bypass PnP entirely."
			);
		}
		return match[1].trim().replace(/^["']|["']$/g, "");
	}

	/**
	 * Copies `root` to a temp directory and installs it there with the node-modules linker, so
	 * the result is a project `ProjectCollector.collect()` already knows how to bundle unchanged.
	 */
	public static materialize(
		root: string,
		entrypoint: string,
		options: { offline?: boolean; excludePaths?: readonly string[]; onLog?: (message: string) => void } = {}
	): MaterializedProject {
		const onLog = options.onLog ?? (() => {});
		const excludePaths = options.excludePaths ?? [];
		const yarnPathRel = YarnPnpCompat.resolveYarnPath(root);
		const yarnScript = join(root, yarnPathRel);
		if (!existsSync(yarnScript)) {
			throw new RuntimeError(`.yarnrc.yml points 'yarnPath' at '${yarnPathRel}', which does not exist.`);
		}

		const tmp = mkdtempSync(join(tmpdir(), "graak-yarn-pnp-"));
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			rmSync(tmp, { recursive: true, force: true });
		};

		try {
			onLog(
				"Yarn Plug'n'Play project detected; materializing a node_modules tree with a throwaway " +
					"'yarn install' (nodeLinker overridden for this run only -- the project's own .pnp.cjs, " +
					"lockfile and .yarnrc.yml are never modified)"
			);
			cpSync(root, tmp, {
				recursive: true,
				filter: (src) =>
					!["node_modules", ".git"].includes(basename(src)) && !excludePaths.some((p) => isInside(src, p)),
			});

			const result = spawnSync(process.execPath, [join(tmp, yarnPathRel), "install"], {
				cwd: tmp,
				env: {
					...process.env,
					YARN_NODE_LINKER: "node-modules",
					...(options.offline ? { YARN_ENABLE_NETWORK: "false" } : {}),
				},
				encoding: "utf-8",
				timeout: 300_000,
			});
			if (result.status !== 0) {
				throw new RuntimeError(
					`Materializing a node_modules tree from the Yarn PnP project failed:\n` +
						`${(result.stderr || result.stdout || "").trim()}`
				);
			}

			return { root: tmp, entrypoint: join(tmp, relative(root, entrypoint)), cleanup };
		} catch (err) {
			cleanup();
			throw err;
		}
	}
}

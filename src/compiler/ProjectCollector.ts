import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { PathOutsideRootError, ProjectError } from "../structures";
import type { ArchiveEntry } from "./Archive";
import { type BinaryInfo, BinaryInspector } from "./BinaryInspector";

export interface CollectOptions {
	entrypoint: string;
	/** Include devDependencies of the root project. */
	includeDev?: boolean;
	/** Include `.env*` files (they usually contain the bot token). */
	includeEnv?: boolean;
	/** Absolute paths that must never be bundled (e.g. the build output). */
	excludePaths?: readonly string[];
}

export interface NativeAddon {
	/** Path inside the bundle. */
	path: string;
	info: BinaryInfo | null;
}

export interface CollectedProject {
	root: string;
	name: string;
	/** Entrypoint relative to the root, POSIX separators. */
	entry: string;
	entries: ArchiveEntry[];
	nativeAddons: NativeAddon[];
	/** Highest `engines.node` lower bound across the bundle, if any. */
	minNode: string | null;
	usesBunApis: string[];
	packages: number;
}

const ALWAYS_EXCLUDED_NAMES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	".DS_Store",
	"Thumbs.db",
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	".yarn",
	".pnpm-store",
	".forgegraal-cache",
	"coverage",
]);

const SUPPORTED_ENTRY_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const BUN_API_PATTERN = /\bBun\.[a-zA-Z]|["']bun:[a-z]/;

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

export function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/**
 * Resolves `input` against `root` and throws when it escapes `root` (symlinks included).
 */
export function resolveInside(root: string, input: string): string {
	const absRoot = resolve(root);
	const abs = resolve(absRoot, input);
	if (!isInside(abs, absRoot)) throw new PathOutsideRootError(input, absRoot);
	if (existsSync(abs) && !isInside(realpathSync(abs), realpathSync(absRoot))) {
		throw new PathOutsideRootError(input, absRoot);
	}
	return abs;
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function parseMinVersion(range: unknown): string | null {
	if (typeof range !== "string") return null;
	// Use the smallest version referenced by the range: good enough for ">=x", "^x", "x || y"
	const versions = [...range.matchAll(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/g)].map(
		(m) => `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}`,
	);
	return versions.sort(compareVersions)[0] ?? null;
}

export function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, "").split(".").map(Number);
	const pb = b.replace(/^v/, "").split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) return d;
	}
	return 0;
}

export class ProjectCollector {
	/**
	 * Finds the closest directory above `start` that contains a package.json.
	 */
	public static findProjectRoot(start: string): string {
		let dir = resolve(start);
		if (existsSync(dir) && statSync(dir).isFile()) dir = dirname(dir);
		for (;;) {
			if (existsSync(join(dir, "package.json"))) return dir;
			const parent = dirname(dir);
			if (parent === dir) {
				throw new ProjectError(`No package.json found above '${start}'`);
			}
			dir = parent;
		}
	}

	public static collect(options: CollectOptions): CollectedProject {
		const entryAbs = resolve(options.entrypoint);
		if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
			throw new ProjectError(`Entrypoint file not found: ${entryAbs}`);
		}
		const ext = extname(entryAbs);
		if (!SUPPORTED_ENTRY_EXTENSIONS.has(ext)) {
			throw new ProjectError(
				`Entrypoint '${basename(entryAbs)}' must be JavaScript (.js, .cjs, .mjs). ` +
					"Compile TypeScript first (e.g. `tsc`, or `bun build --target=node --outdir dist`) and pass the built file.",
			);
		}

		const root = realpathSync(ProjectCollector.findProjectRoot(entryAbs));
		const entryReal = realpathSync(entryAbs);
		if (!isInside(entryReal, root))
			throw new PathOutsideRootError(entryAbs, root);

		if (
			existsSync(join(root, ".pnp.cjs")) ||
			existsSync(join(root, ".pnp.js"))
		) {
			throw new ProjectError(
				"Yarn Plug'n'Play projects have no node_modules to bundle. Set `nodeLinker: node-modules` in .yarnrc.yml and reinstall.",
			);
		}

		const pkg = readJson(join(root, "package.json")) ?? {};
		const excluded = (options.excludePaths ?? []).map((p) => resolve(p));
		const collector = new ProjectCollector(root, options, excluded);

		collector.addProjectFiles(root, "");
		collector.addDependencies(pkg, options.includeDev === true);
		collector.addEngines(pkg);

		const rawName = typeof pkg.name === "string" ? pkg.name : basename(root);
		return {
			root,
			name:
				rawName.replace(/^@[^/]+\//, "").replace(/[^a-zA-Z0-9._-]/g, "-") ||
				"bot",
			entry: toPosix(relative(root, entryReal)),
			entries: collector.entries,
			nativeAddons: collector.nativeAddons,
			minNode: collector.minNode,
			usesBunApis: collector.usesBunApis,
			packages: collector.placed.size,
		};
	}

	private readonly entries: ArchiveEntry[] = [];
	private readonly nativeAddons: NativeAddon[] = [];
	private readonly usesBunApis: string[] = [];
	private minNode: string | null = null;

	/** Destination package dir (e.g. "node_modules/a/node_modules/b") -> real source dir. */
	private readonly placed = new Map<string, string>();
	/** Positions that must stay empty because a package resolves past them. */
	private readonly reserved = new Set<string>();
	private readonly visitedDirs = new Set<string>();

	private constructor(
		private readonly root: string,
		private readonly options: CollectOptions,
		private readonly excluded: readonly string[],
	) {}

	private isExcluded(
		abs: string,
		name: string,
		isProjectFile: boolean,
	): boolean {
		if (ALWAYS_EXCLUDED_NAMES.has(name)) return true;
		if (name.endsWith(".forgegraal")) return true;
		if (
			isProjectFile &&
			!this.options.includeEnv &&
			/^\.env(\..*)?$/.test(name)
		)
			return true;
		return this.excluded.some((p) => isInside(abs, p));
	}

	private addFile(
		abs: string,
		dest: string,
		stats: Stats,
		isProjectFile: boolean,
	) {
		this.entries.push({ path: dest, source: abs, mode: stats.mode });

		if (dest.endsWith(".node")) {
			let info: BinaryInfo | null = null;
			try {
				info = BinaryInspector.inspect(abs);
			} catch {
				// Unreadable addon: reported with unknown info
			}
			this.nativeAddons.push({ path: dest, info });
		} else if (
			isProjectFile &&
			SOURCE_EXTENSIONS.has(extname(dest)) &&
			stats.size < 4 * 1024 * 1024 &&
			BUN_API_PATTERN.test(readFileSync(abs, "utf-8"))
		) {
			this.usesBunApis.push(dest);
		}
	}

	/**
	 * Copies a directory tree, following symlinks while guarding against cycles.
	 */
	private walk(
		dir: string,
		destPrefix: string,
		isProjectFile: boolean,
		skipNodeModules: boolean,
	) {
		const real = realpathSync(dir);
		const visitKey = `${real}\0${destPrefix}`;
		if (this.visitedDirs.has(visitKey)) return;
		this.visitedDirs.add(visitKey);

		for (const name of readdirSync(dir).sort()) {
			const abs = join(dir, name);
			if (name === "node_modules" && skipNodeModules) continue;
			if (this.isExcluded(abs, name, isProjectFile)) continue;

			let stats: Stats;
			try {
				stats = statSync(abs);
			} catch {
				continue; // Broken symlink
			}
			if (lstatSync(abs).isSymbolicLink() && stats.isDirectory()) {
				const target = realpathSync(abs);
				// A link to an ancestor would recurse forever
				if (isInside(real, target)) continue;
			}

			const dest = destPrefix ? `${destPrefix}/${name}` : name;
			if (stats.isDirectory()) this.walk(abs, dest, isProjectFile, true);
			else if (stats.isFile()) this.addFile(abs, dest, stats, isProjectFile);
		}
	}

	private addProjectFiles(root: string, prefix: string) {
		this.walk(root, prefix, true, true);
	}

	private addEngines(pkg: Record<string, unknown>) {
		const engines = pkg.engines as Record<string, unknown> | undefined;
		const min = parseMinVersion(engines?.node);
		if (min && (!this.minNode || compareVersions(min, this.minNode) > 0)) {
			this.minNode = min;
		}
	}

	/**
	 * Node.js resolution: look for `name` in node_modules directories from `fromDir` upwards.
	 */
	private resolvePackageDir(name: string, fromDir: string): string | null {
		let dir = fromDir;
		for (;;) {
			const candidate = join(dir, "node_modules", name);
			if (existsSync(join(candidate, "package.json")))
				return realpathSync(candidate);
			// Also check pnpm / yarn virtual store resolution
			const pnpmCandidate = join(dir, "node_modules", ".pnpm");
			if (existsSync(pnpmCandidate)) {
				// Search inside virtual store
				try {
					const entries = readdirSync(pnpmCandidate);
					for (const entry of entries) {
						if (entry.startsWith(name.replace("/", "+"))) {
							const targetPkg = join(
								pnpmCandidate,
								entry,
								"node_modules",
								name,
							);
							if (existsSync(join(targetPkg, "package.json"))) {
								return realpathSync(targetPkg);
							}
						}
					}
				} catch {}
			}
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	}

	private addDependencies(
		rootPkg: Record<string, unknown>,
		includeDev: boolean,
	) {
		const queue: Array<{
			realDir: string;
			dest: string;
			pkg: Record<string, unknown>;
			isRoot: boolean;
		}> = [{ realDir: this.root, dest: "", pkg: rootPkg, isRoot: true }];

		// Breadth-first so parents claim shallow positions before their children resolve
		for (let item = queue.shift(); item; item = queue.shift()) {
			const { realDir, dest, pkg, isRoot } = item;
			const required = { ...(pkg.dependencies as object) } as Record<
				string,
				string
			>;
			const optional = {
				...(isRoot && includeDev ? (pkg.devDependencies as object) : {}),
				...(pkg.peerDependencies as object),
				...(pkg.optionalDependencies as object),
			} as Record<string, string>;

			const names: Array<[string, boolean]> = [
				...Object.keys(required).map((n): [string, boolean] => [n, true]),
				...Object.keys(optional)
					.filter((n) => !(n in required))
					.map((n): [string, boolean] => [n, false]),
			];

			for (const [name, isRequired] of names) {
				const depReal = this.resolvePackageDir(name, realDir);
				if (!depReal) {
					if (
						isRequired &&
						!(pkg.bundleDependencies || pkg.bundledDependencies)
					) {
						throw new ProjectError(
							`Dependency '${name}' required by '${isRoot ? "project" : dest}' is not installed. Run your package manager's install first.`,
						);
					}
					continue;
				}

				const position = this.place(name, depReal, dest);
				if (position.isNew) {
					const depPkg = readJson(join(depReal, "package.json")) ?? {};
					this.walk(depReal, position.dest, false, true);
					this.addEngines(depPkg);
					queue.push({
						realDir: depReal,
						dest: position.dest,
						pkg: depPkg,
						isRoot: false,
					});
				}
			}
		}
	}

	private place(
		name: string,
		realDir: string,
		parentDest: string,
	): { dest: string; isNew: boolean } {
		// Candidate positions ordered from nearest (inside parent) to the project root
		const candidates: string[] = [];
		let base = parentDest;
		for (;;) {
			candidates.push(
				base ? `${base}/node_modules/${name}` : `node_modules/${name}`,
			);
			if (!base) break;
			const idx = base.lastIndexOf("/node_modules/");
			base = idx === -1 ? "" : base.slice(0, idx);
		}

		let chosen: string | null = null;
		for (const candidate of candidates) {
			const occupant = this.placed.get(candidate);
			if (occupant !== undefined) {
				if (occupant === realDir) {
					this.reserve(candidates, candidate);
					return { dest: candidate, isNew: false };
				}
				break;
			}
			if (this.reserved.has(candidate)) break;
			chosen = candidate;
		}

		if (!chosen) {
			throw new ProjectError(
				`Cannot place '${name}' for '${parentDest || "project"}' without shadowing another version`,
			);
		}

		this.placed.set(chosen, realDir);
		this.reserve(candidates, chosen);
		return { dest: chosen, isNew: true };
	}

	private reserve(candidates: readonly string[], resolved: string) {
		for (const candidate of candidates) {
			if (candidate === resolved) break;
			this.reserved.add(candidate);
		}
	}
}

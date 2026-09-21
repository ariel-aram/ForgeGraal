import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectError } from "../structures";
import { DenoProject } from "./DenoProject";

/**
 * Lets Graak build a Deno project, the way `BunTranspiler` lets it build a Bun one: Deno keeps doing
 * what only Deno can (resolving `jsr:`, `npm:` and `https:` imports, reading `deno.json` and its import
 * map, fetching and caching), and Graak turns the result into something the Graak engine or Node.js
 * runs.
 *
 * Nothing here reimplements Deno's resolver. `deno info --json` reports the module graph Deno itself
 * builds for the entry point: every module with the file it is cached in, what each import resolves
 * to, and every npm package with the directory it was unpacked into. From that graph:
 *
 *  - the program's own code, `jsr:` packages and `https:` modules become one bundle (esbuild, with a
 *    plugin that answers every import from the graph, so an import map, a redirect or a version range
 *    can never resolve differently than it does under Deno);
 *  - `npm:` packages are not inlined but laid out as a real `node_modules` tree beside it, like the
 *    ones a lockfile pins under npm, so native addons, `__dirname` reads and dynamic requires keep
 *    working and the rest of the build (collection, Windows 7 patching, V8 addon rebuilds) treats them
 *    as any other dependency;
 *  - top-level `await`, which Deno programs use freely and CommonJS cannot express, survives because
 *    the bundle runs inside an async function;
 *  - `import.meta.url` and its relatives are answered from where the file sits in the packaged
 *    application, so a program that reads a file next to itself finds it.
 *
 * The Deno namespace itself comes from `quickjs/runtime/deno-shim.js`, inlined ahead of the program.
 * Deno is needed at build time only, never on the device.
 */

const MIN_DENO_MAJOR = 2;

/** The files of the Deno namespace, in the order they are inlined ahead of the program. */
export const DENO_SHIM_FILES = ["deno-shim.js", "deno-test.js", "deno-ffi.js", "deno-kv.js"] as const;

export interface DenoVersion {
	deno: string;
	v8: string;
	typescript: string;
}

interface GraphDependency {
	specifier: string;
	code?: { specifier: string };
	type?: { specifier: string };
}

interface GraphModule {
	kind: string;
	specifier: string;
	local?: string;
	mediaType?: string;
	dependencies?: GraphDependency[];
	error?: string;
}

interface NpmPackage {
	name: string;
	version: string;
	dependencies: string[];
	localPath?: string;
}

interface DenoGraph {
	roots: string[];
	modules: GraphModule[];
	redirects: Record<string, string>;
	npmPackages: Record<string, NpmPackage>;
}

export interface DenoBundleOptions {
	/** Absolute path of the program's entry file. */
	entrypoint: string;
	/** Fetch nothing: every module and npm package must already be in Deno's cache. */
	offline?: boolean;
	/** Absolute paths that must not be copied into the build (the output directory). */
	excludePaths?: readonly string[];
	onLog?: (message: string) => void;
}

export interface DenoBundleResult {
	/** Root of the throwaway project: package.json, node_modules, the bundle and the project's other files. */
	root: string;
	/** The bundle, inside `root`. */
	entrypoint: string;
	/** Files inside `root` that are part of the bundle and must not be shipped a second time. */
	bundled: string[];
	/** Names of the npm packages laid out under `node_modules`. */
	npmPackages: string[];
	/** Things the program uses that Graak cannot provide, worded for the build log. */
	warnings: string[];
	/** Whether the program calls into shared libraries (Deno.dlopen), which a statically linked host cannot do. */
	usesFfi: boolean;
	deno: DenoVersion;
	/** Removes `root`. Safe to call more than once. */
	cleanup: () => void;
}

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx" | "json"> = {
	TypeScript: "ts",
	Mts: "ts",
	Cts: "ts",
	Dts: "ts",
	Dmts: "ts",
	Dcts: "ts",
	Tsx: "tsx",
	JavaScript: "js",
	Mjs: "js",
	Cjs: "js",
	Jsx: "jsx",
	Json: "json",
};

/**
 * What the Deno namespace answers with an explanatory error, worded for a warning. Everything Deno offers is
 * provided on the Graak engine; FFI is the one thing Node.js has no way to do, so it matters only for a Node.js build.
 */
const UNSUPPORTED_DENO_APIS: ReadonlyArray<[RegExp, string]> = [];

/** Deno's foreign function interface, which needs a host that can load shared libraries. */
const FFI_PATTERN = /\bDeno\.(dlopen|UnsafeCallback|UnsafeFnPointer)\b/;

/** Runs a command and returns stdout, or throws with everything the command said. */
function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
	try {
		return execFileSync(command, args, {
			cwd,
			env: env ?? process.env,
			encoding: "utf-8",
			maxBuffer: 1024 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 300_000,
		});
	} catch (err) {
		const stderr =
			err && typeof err === "object" && "stderr" in err ? String((err as { stderr: unknown }).stderr ?? "") : "";
		throw new ProjectError(
			`'${command} ${args.join(" ")}' failed:\n${(stderr || (err instanceof Error ? err.message : String(err))).trim()}`
		);
	}
}

/** `chalk@5.3.0` -> [`chalk`, `5.3.0`]; scoped names keep their `@`. */
function splitPackageKey(key: string): [string, string] {
	const at = key.lastIndexOf("@");
	return [key.slice(0, at), key.slice(at + 1)];
}

/** Links a file to the cache's copy when it can (same volume), copies it when it cannot. */
function linkOrCopy(from: string, to: string) {
	try {
		linkSync(from, to);
	} catch {
		copyFileSync(from, to);
	}
}

function copyTree(from: string, to: string) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const source = join(from, entry.name);
		const dest = join(to, entry.name);
		if (entry.isDirectory()) copyTree(source, dest);
		else if (entry.isFile()) linkOrCopy(source, dest);
		else if (entry.isSymbolicLink()) {
			try {
				const real = statSync(source);
				if (real.isDirectory()) copyTree(source, dest);
				else linkOrCopy(source, dest);
			} catch {
				// A dangling link inside a package is not something the package needs.
			}
		}
	}
}

/** A directory link that needs no privilege on Windows (a junction) and is an ordinary symlink elsewhere. */
function linkDirectory(target: string, at: string) {
	mkdirSync(dirname(at), { recursive: true });
	symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

/** Parses `npm:/name@1.2.3/sub/path` into the package name and the subpath (`""` or `/sub/path`). */
export function parseNpmSpecifier(specifier: string): { name: string; version: string; subpath: string } | null {
	const match = /^npm:\/(@[^/@]+\/[^/@]+|[^/@]+)@([^/]+)(\/.*)?$/.exec(specifier);
	return match ? { name: match[1], version: match[2], subpath: match[3] ?? "" } : null;
}

export class DenoBundler {
	public static isAvailable(): boolean {
		try {
			execFileSync("deno", ["--version"], { stdio: "ignore", timeout: 10_000 });
			return true;
		} catch {
			return false;
		}
	}

	/** The installed Deno's own version strings, which `Deno.version` reports so version checks in code agree. */
	public static version(): DenoVersion {
		const text = run("deno", ["--version"], process.cwd());
		const deno = /deno (\d+\.\d+\.\d+\S*)/.exec(text)?.[1];
		if (!deno) throw new ProjectError(`Could not read the Deno version from: ${text.trim()}`);
		const major = Number.parseInt(deno.split(".")[0], 10);
		if (major < MIN_DENO_MAJOR) {
			throw new ProjectError(
				`Deno ${deno} is too old: Graak reads Deno 2's module graph (\`deno info --json\`). Upgrade with \`deno upgrade\`.`
			);
		}
		return {
			deno,
			v8: /v8 (\S+)/.exec(text)?.[1] ?? "",
			typescript: /typescript (\S+)/.exec(text)?.[1] ?? "",
		};
	}

	/**
	 * Bundles a Deno program into a self-contained CommonJS file inside a throwaway project directory,
	 * ready for `ProjectCollector`. The original project is never written to.
	 */
	public static async bundle(options: DenoBundleOptions): Promise<DenoBundleResult> {
		const log = options.onLog ?? (() => {});
		const entry = resolve(options.entrypoint);
		const deno = DenoBundler.version();

		const configPath = DenoProject.findConfig(dirname(entry));
		const config = configPath ? DenoProject.readConfig(configPath) : null;
		const projectRoot = config ? config.dir : dirname(entry);

		// The graph, exactly as Deno resolves it. `deno info` writes deno.lock next to the config when it meets a
		// specifier the lock lacks, and the project must not change under a build, so it works on a copy of the
		// lock (which still pins every version) in a scratch directory.
		const scratch = mkdtempSync(join(tmpdir(), "graak-deno-lock-"));
		// --allow-import: the program is built as if run with -A, so modules from any host may be imported.
		const infoArgs = ["info", "--json", "--allow-import"];
		if (configPath) infoArgs.push("--config", configPath);
		const lockFile = join(projectRoot, "deno.lock");
		if (existsSync(lockFile)) {
			copyFileSync(lockFile, join(scratch, "deno.lock"));
			infoArgs.push("--lock", join(scratch, "deno.lock"));
		} else infoArgs.push("--no-lock");
		infoArgs.push(entry);
		log(`Reading the module graph with 'deno info --json'`);
		// Offline means Deno may use only what is already cached: with nowhere to fetch from, a missing module fails.
		const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1" };
		if (options.offline) {
			env.HTTPS_PROXY = "http://127.0.0.1:9";
			env.HTTP_PROXY = "http://127.0.0.1:9";
			env.NO_PROXY = "";
		}
		let graph: DenoGraph;
		try {
			graph = JSON.parse(run("deno", infoArgs, projectRoot, env)) as DenoGraph;
		} catch (err) {
			if (options.offline && err instanceof ProjectError) {
				throw new ProjectError(
					`${err.message}\nBuilding with --offline needs every module already in Deno's cache: run the program once with Deno, or build without --offline.`
				);
			}
			throw err;
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
		const modules = new Map<string, GraphModule>();
		for (const m of graph.modules) {
			if (m.error) throw new ProjectError(`Deno could not load ${m.specifier}: ${m.error}`);
			modules.set(m.specifier, m);
		}
		const entrySpecifier = graph.roots[0];
		if (!entrySpecifier || !modules.has(entrySpecifier)) {
			throw new ProjectError(`Deno did not report a module graph for '${entry}'.`);
		}

		const temp = mkdtempSync(join(tmpdir(), "graak-deno-"));
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			rmSync(temp, { recursive: true, force: true });
		};

		try {
			DenoBundler.mirrorProject(projectRoot, temp, options.excludePaths ?? []);

			// The bundle, with npm packages left as require() calls.
			const externals = new Map<string, { name: string; version: string }>();
			const localSources = new Map<string, string>();
			const built = await DenoBundler.build({
				graph,
				modules,
				entrySpecifier,
				projectRoot,
				config,
				externals,
				localSources,
			});

			const npmNames = DenoBundler.layOutPackages(temp, graph, externals);

			const name = `${basename(entry, extname(entry))}.graak-build.cjs`;
			const bundlePath = join(temp, existsSync(join(temp, name)) ? `graak-${name}` : name);
			const entryRel = relative(projectRoot, entry).split(sep).join("/");
			writeFileSync(bundlePath, DenoBundler.wrap(built, entryRel, deno));

			const pkgPath = join(temp, "package.json");
			const existing = existsSync(pkgPath)
				? (JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>)
				: {};
			const dependencies: Record<string, string> = {
				...((existing.dependencies as Record<string, string> | undefined) ?? {}),
			};
			for (const [alias, pkg] of npmNames.direct) dependencies[alias] = pkg;
			const manifest: Record<string, unknown> = {
				...existing,
				name: (existing.name as string | undefined) ?? config?.name ?? basename(projectRoot),
				version: (existing.version as string | undefined) ?? config?.version ?? "0.0.0",
				dependencies,
			};
			delete manifest.type;
			writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`);

			const warnings: string[] = [];
			const unsupported = new Set<string>();
			for (const source of localSources.values()) {
				for (const [pattern, label] of UNSUPPORTED_DENO_APIS) if (pattern.test(source)) unsupported.add(label);
			}
			if (unsupported.size) {
				warnings.push(
					`The program uses ${[...unsupported].join(", ")}, which Graak does not provide: calling it throws Deno.errors.NotSupported.`
				);
			}
			const usesFfi = [...localSources.values()].some((source) => FFI_PATTERN.test(source));
			const remote = [...modules.values()].filter((m) => m.kind === "esm" && !m.specifier.startsWith("file:")).length;
			log(
				`Bundled ${localSources.size} local and ${remote} remote modules; ${npmNames.direct.size} npm package(s) ` +
					`(${npmNames.total} with dependencies) laid out under node_modules`
			);

			return {
				root: temp,
				entrypoint: bundlePath,
				bundled: [...localSources.keys()].map((abs) => join(temp, relative(projectRoot, abs))),
				npmPackages: [...npmNames.direct.values()],
				warnings,
				usesFfi,
				deno,
				cleanup,
			};
		} catch (err) {
			cleanup();
			throw err;
		}
	}

	/**
	 * The throwaway project mirrors the real one, so everything the program reads next to itself is
	 * where the program expects it. Directories are linked, files copied: nothing in the original is
	 * written to, and nothing large is duplicated.
	 */
	private static mirrorProject(projectRoot: string, temp: string, excluded: readonly string[]) {
		for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
			const name = entry.name;
			if (name === "node_modules" || name === ".git" || name === ".deno") continue;
			const source = join(projectRoot, name);
			if (excluded.some((p) => resolve(p) === source)) continue;
			const dest = join(temp, name);
			try {
				if (statSync(source).isDirectory()) linkDirectory(source, dest);
				else copyFileSync(source, dest);
			} catch {
				// A file that cannot be read is not one the program can be relying on.
			}
		}
	}

	/**
	 * Lays the graph's npm packages out as a pnpm-style store: each package once, with its own
	 * dependencies beside it, and the ones the program imports linked at the top. Files come straight
	 * from Deno's cache.
	 */
	private static layOutPackages(
		temp: string,
		graph: DenoGraph,
		externals: Map<string, { name: string; version: string }>
	): { direct: Map<string, string>; total: number } {
		const store = join(temp, "node_modules", ".graak");
		const dirOf = (key: string) => {
			const [name, version] = splitPackageKey(key);
			return join(store, `${name.replace("/", "+")}@${version}`, "node_modules", name);
		};
		const placed = new Set<string>();
		const place = (key: string) => {
			if (placed.has(key)) return;
			placed.add(key);
			const pkg = graph.npmPackages[key];
			if (!pkg?.localPath || !existsSync(pkg.localPath)) {
				throw new ProjectError(
					`npm package ${key} is not in Deno's cache${pkg?.localPath ? ` (${pkg.localPath})` : ""}. ` +
						"Run the program once with Deno, or build without --offline, so Deno downloads it."
				);
			}
			copyTree(pkg.localPath, dirOf(key));
			for (const dep of pkg.dependencies) {
				place(dep);
				const [depName] = splitPackageKey(dep);
				const link = join(dirname(dirOf(key)), ...depName.split("/"));
				if (!existsSync(link)) linkDirectory(dirOf(dep), link);
			}
		};

		// Which name a package is imported by. Two versions of one package get distinct top-level names.
		const direct = new Map<string, string>();
		for (const [alias, { name, version }] of externals) {
			const key = `${name}@${version}`;
			place(key);
			linkDirectory(dirOf(key), join(temp, "node_modules", ...alias.split("/")));
			direct.set(alias, version);
		}
		return { direct, total: placed.size };
	}

	private static async build(input: {
		graph: DenoGraph;
		modules: Map<string, GraphModule>;
		entrySpecifier: string;
		projectRoot: string;
		config: ReturnType<typeof DenoProject.readConfig> | null;
		externals: Map<string, { name: string; version: string }>;
		localSources: Map<string, string>;
	}): Promise<string> {
		const esbuild = require("esbuild") as typeof import("esbuild");
		const { graph, modules, entrySpecifier, projectRoot, config, externals, localSources } = input;
		const NAMESPACE = "deno";
		const SUFFIX = "?graak";
		const EXTERNAL = "graak-external";

		const redirect = (specifier: string): string => {
			let current = specifier;
			for (let hops = 0; hops < 16 && graph.redirects[current]; hops++) current = graph.redirects[current];
			return current;
		};
		const relToRoot = (abs: string) => relative(projectRoot, abs).split(sep).join("/");

		/** Name the program requires an npm package by; a second version of one package gets a distinct alias. */
		const aliasFor = (name: string, version: string): string => {
			const same = [...externals.entries()].find(([, v]) => v.name === name && v.version === version);
			if (same) return same[0];
			const alias = [...externals.values()].some((v) => v.name === name) ? `${name}-graak-v${version}` : name;
			externals.set(alias, { name, version });
			return alias;
		};

		const tsconfig: Record<string, unknown> = {};
		const co = config?.compilerOptions ?? {};
		for (const key of [
			"jsx",
			"jsxFactory",
			"jsxFragmentFactory",
			"jsxImportSource",
			"experimentalDecorators",
			"useDefineForClassFields",
			"verbatimModuleSyntax",
			"target",
		]) {
			if (co[key] !== undefined) tsconfig[key] = co[key];
		}

		const plugin: import("esbuild").Plugin = {
			name: "deno-graph",
			setup(build) {
				build.onResolve({ filter: /.*/ }, (args) => {
					if (args.kind === "entry-point") return { path: entrySpecifier + SUFFIX, namespace: NAMESPACE };
					// The require() a package module makes is answered by the host at run time, not bundled.
					if (args.namespace === EXTERNAL) return { path: args.path, external: true };
					if (args.namespace !== NAMESPACE) return undefined;
					const importer = modules.get(args.importer.slice(0, -SUFFIX.length));
					const dep = importer?.dependencies?.find((d) => d.specifier === args.path);
					const target = dep?.code?.specifier ?? dep?.type?.specifier;
					if (!target) {
						return {
							errors: [{ text: `Deno's module graph has no resolution for "${args.path}" from ${args.importer}` }],
						};
					}
					const final = redirect(target);
					if (final.startsWith("node:")) return { path: final, namespace: EXTERNAL };
					const npm = parseNpmSpecifier(final);
					if (npm) {
						return { path: aliasFor(npm.name, npm.version) + npm.subpath, namespace: EXTERNAL };
					}
					if (!modules.has(final)) return { errors: [{ text: `Deno's module graph does not contain ${final}` }] };
					return { path: final + SUFFIX, namespace: NAMESPACE };
				});

				build.onLoad({ filter: /.*/, namespace: EXTERNAL }, (args) => ({
					contents: `module.exports = require(${JSON.stringify(args.path)});`,
					loader: "js",
				}));

				build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => {
					const specifier = args.path.slice(0, -SUFFIX.length);
					const mod = modules.get(specifier);
					if (!mod?.local) return { errors: [{ text: `No cached source for ${specifier}` }] };
					const loader =
						LOADERS[mod.mediaType ?? ""] ?? LOADERS[extname(mod.local) === ".json" ? "Json" : "JavaScript"];
					if (mod.mediaType === "Wasm") {
						return {
							errors: [{ text: `${specifier} is WebAssembly, which Graak cannot bundle from a module import` }],
						};
					}
					let contents = readFileSync(mod.local, "utf-8");
					if (specifier.startsWith("file:")) {
						const abs = fileURLToPath(specifier);
						const rel = relToRoot(abs);
						if (loader !== "json") localSources.set(abs, contents);
						const q = JSON.stringify(rel);
						const isEntry = specifier === entrySpecifier;
						contents = contents
							.replace(/\bimport\.meta\.url\b/g, `__graak_url(${q})`)
							.replace(/\bimport\.meta\.dirname\b/g, `__graak_dirname(${q})`)
							.replace(/\bimport\.meta\.filename\b/g, `__graak_file(${q})`)
							.replace(/\bimport\.meta\.main\b/g, isEntry ? "true" : "false")
							.replace(/\bimport\.meta\.resolve\(/g, `__graak_resolve(${q}, `);
					} else {
						const q = JSON.stringify(specifier);
						contents = contents
							.replace(/\bimport\.meta\.url\b/g, q)
							.replace(/\bimport\.meta\.main\b/g, "false")
							.replace(/\bimport\.meta\.dirname\b/g, JSON.stringify(specifier.slice(0, specifier.lastIndexOf("/"))))
							.replace(/\bimport\.meta\.filename\b/g, q)
							.replace(/\bimport\.meta\.resolve\(/g, `((s) => new URL(s, ${q}).href)(`);
					}
					return { contents, loader };
				});
			},
		};

		const result = await esbuild.build({
			entryPoints: [entrySpecifier],
			bundle: true,
			write: false,
			format: "esm",
			platform: "node",
			target: "esnext",
			logLevel: "silent",
			legalComments: "none",
			tsconfigRaw: JSON.stringify({ compilerOptions: tsconfig }),
			supported: { "dynamic-import": false },
			plugins: [plugin],
		});
		return result.outputFiles[0].text;
	}

	/**
	 * A bundle is an ES module (top-level await, `export`s); the host loads CommonJS. Running it inside an
	 * async function keeps `await` legal, and the entry's exports, if any, become `module.exports`.
	 */
	private static wrap(bundle: string, entryRel: string, deno: DenoVersion): string {
		const runtime = join(dirname(require.resolve("../../package.json")), "quickjs/runtime");
		// The WebSocket module is shared with the runtime layer: its source is inlined here, minus the ES module export.
		const websocket = readFileSync(join(runtime, "node-websocket.js"), "utf-8").replace(
			/\nexport \{[^}]*\};?\s*$/,
			"\n"
		);
		const websocketSetup = `${websocket}
(function installWebSocket(global) {
	if (global[Symbol.for("graak.websocket")]) return;
	const ws = createWebSocket({ http: require("http"), https: require("https"), crypto: require("crypto"), Buffer, CloseEvent: global.CloseEvent, MessageEvent: global.MessageEvent });
	Object.defineProperty(global, Symbol.for("graak.websocket"), { value: ws, enumerable: false });
	for (const name of ["WebSocket", "CloseEvent", "MessageEvent"]) {
		if (typeof global[name] === "undefined") Object.defineProperty(global, name, { value: ws[name], writable: true, configurable: true });
	}
})(globalThis);`;
		const shim = [websocketSetup, ...DENO_SHIM_FILES.map((file) => readFileSync(join(runtime, file), "utf-8"))]
			.join("\n")
			.replace("__GRAAK_DENO_VERSION__", deno.deno)
			.replace("__GRAAK_V8_VERSION__", deno.v8)
			.replace("__GRAAK_TS_VERSION__", deno.typescript);

		let body = bundle;
		const exportBlock = /\nexport \{([^}]*)\};?\s*$/.exec(body);
		let exportsCode = "";
		if (exportBlock) {
			body = body.slice(0, exportBlock.index);
			for (const item of exportBlock[1].split(",")) {
				const [local, exported] = item.trim().split(/\s+as\s+/);
				if (local) exportsCode += `\nexports[${JSON.stringify(exported ?? local)}] = ${local};`;
			}
		}
		body = body.replace(/\bimport\.meta\b/g, "__graak_meta");

		const q = JSON.stringify(entryRel);
		return `${[
			'"use strict";',
			"// Bundled by Graak from a Deno program. The Deno namespace comes first, then the program.",
			shim,
			'const __graak_path = require("path");',
			'const __graak_urls = require("url");',
			"const __graak_file = (rel) => __graak_path.join(__dirname, rel);",
			"const __graak_dirname = (rel) => __graak_path.dirname(__graak_file(rel));",
			"const __graak_url = (rel) => __graak_urls.pathToFileURL(__graak_file(rel)).href;",
			"const __graak_resolve = (rel, spec) => /^\\.{0,2}\\//.test(spec)",
			"\t? __graak_urls.pathToFileURL(__graak_path.resolve(__graak_dirname(rel), spec)).href",
			"\t: spec;",
			`Deno.mainModule = __graak_url(${q});`,
			`Object.defineProperty(Deno, Symbol.for("graak.entry"), { value: ${q}, enumerable: false });`,
			`const __graak_meta = { url: __graak_url(${q}), dirname: __graak_dirname(${q}), filename: __graak_file(${q}), main: true, resolve: (spec) => __graak_resolve(${q}, spec) };`,
			"(async () => {",
			'"use strict";',
		].join("\n")}\n${body}${exportsCode}\n})().then(() => Deno[Symbol.for("graak.afterMain")]?.());\n`;
	}
}

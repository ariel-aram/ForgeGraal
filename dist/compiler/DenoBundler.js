"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DenoBundler = exports.DENO_SHIM_FILES = void 0;
exports.parseNpmSpecifier = parseNpmSpecifier;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_url_1 = require("node:url");
const structures_1 = require("../structures");
const DenoProject_1 = require("./DenoProject");
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
exports.DENO_SHIM_FILES = ["deno-shim.js", "deno-test.js", "deno-ffi.js", "deno-kv.js"];
const LOADERS = {
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
const UNSUPPORTED_DENO_APIS = [];
/** Deno's foreign function interface, which needs a host that can load shared libraries. */
const FFI_PATTERN = /\bDeno\.(dlopen|UnsafeCallback|UnsafeFnPointer)\b/;
/** Runs a command and returns stdout, or throws with everything the command said. */
function run(command, args, cwd, env) {
    try {
        return (0, node_child_process_1.execFileSync)(command, args, {
            cwd,
            env: env ?? process.env,
            encoding: "utf-8",
            maxBuffer: 1024 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 300_000,
        });
    }
    catch (err) {
        const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr ?? "") : "";
        throw new structures_1.ProjectError(`'${command} ${args.join(" ")}' failed:\n${(stderr || (err instanceof Error ? err.message : String(err))).trim()}`);
    }
}
/** `chalk@5.3.0` -> [`chalk`, `5.3.0`]; scoped names keep their `@`. */
function splitPackageKey(key) {
    const at = key.lastIndexOf("@");
    return [key.slice(0, at), key.slice(at + 1)];
}
/** Links a file to the cache's copy when it can (same volume), copies it when it cannot. */
function linkOrCopy(from, to) {
    try {
        (0, node_fs_1.linkSync)(from, to);
    }
    catch {
        (0, node_fs_1.copyFileSync)(from, to);
    }
}
function copyTree(from, to) {
    (0, node_fs_1.mkdirSync)(to, { recursive: true });
    for (const entry of (0, node_fs_1.readdirSync)(from, { withFileTypes: true })) {
        const source = (0, node_path_1.join)(from, entry.name);
        const dest = (0, node_path_1.join)(to, entry.name);
        if (entry.isDirectory())
            copyTree(source, dest);
        else if (entry.isFile())
            linkOrCopy(source, dest);
        else if (entry.isSymbolicLink()) {
            try {
                const real = (0, node_fs_1.statSync)(source);
                if (real.isDirectory())
                    copyTree(source, dest);
                else
                    linkOrCopy(source, dest);
            }
            catch {
                // A dangling link inside a package is not something the package needs.
            }
        }
    }
}
/** A directory link that needs no privilege on Windows (a junction) and is an ordinary symlink elsewhere. */
function linkDirectory(target, at) {
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(at), { recursive: true });
    (0, node_fs_1.symlinkSync)(target, at, process.platform === "win32" ? "junction" : "dir");
}
/** Parses `npm:/name@1.2.3/sub/path` into the package name and the subpath (`""` or `/sub/path`). */
function parseNpmSpecifier(specifier) {
    const match = /^npm:\/(@[^/@]+\/[^/@]+|[^/@]+)@([^/]+)(\/.*)?$/.exec(specifier);
    return match ? { name: match[1], version: match[2], subpath: match[3] ?? "" } : null;
}
class DenoBundler {
    static isAvailable() {
        try {
            (0, node_child_process_1.execFileSync)("deno", ["--version"], { stdio: "ignore", timeout: 10_000 });
            return true;
        }
        catch {
            return false;
        }
    }
    /** The installed Deno's own version strings, which `Deno.version` reports so version checks in code agree. */
    static version() {
        const text = run("deno", ["--version"], process.cwd());
        const deno = /deno (\d+\.\d+\.\d+\S*)/.exec(text)?.[1];
        if (!deno)
            throw new structures_1.ProjectError(`Could not read the Deno version from: ${text.trim()}`);
        const major = Number.parseInt(deno.split(".")[0], 10);
        if (major < MIN_DENO_MAJOR) {
            throw new structures_1.ProjectError(`Deno ${deno} is too old: Graak reads Deno 2's module graph (\`deno info --json\`). Upgrade with \`deno upgrade\`.`);
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
    static async bundle(options) {
        const log = options.onLog ?? (() => { });
        const entry = (0, node_path_1.resolve)(options.entrypoint);
        const deno = DenoBundler.version();
        const configPath = DenoProject_1.DenoProject.findConfig((0, node_path_1.dirname)(entry));
        const config = configPath ? DenoProject_1.DenoProject.readConfig(configPath) : null;
        const projectRoot = config ? config.dir : (0, node_path_1.dirname)(entry);
        // The graph, exactly as Deno resolves it. `deno info` writes deno.lock next to the config when it meets a
        // specifier the lock lacks, and the project must not change under a build, so it works on a copy of the
        // lock (which still pins every version) in a scratch directory.
        const scratch = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "graak-deno-lock-"));
        // --allow-import: the program is built as if run with -A, so modules from any host may be imported.
        const infoArgs = ["info", "--json", "--allow-import"];
        if (configPath)
            infoArgs.push("--config", configPath);
        const lockFile = (0, node_path_1.join)(projectRoot, "deno.lock");
        if ((0, node_fs_1.existsSync)(lockFile)) {
            (0, node_fs_1.copyFileSync)(lockFile, (0, node_path_1.join)(scratch, "deno.lock"));
            infoArgs.push("--lock", (0, node_path_1.join)(scratch, "deno.lock"));
        }
        else
            infoArgs.push("--no-lock");
        infoArgs.push(entry);
        log(`Reading the module graph with 'deno info --json'`);
        // Offline means Deno may use only what is already cached: with nowhere to fetch from, a missing module fails.
        const env = { ...process.env, NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1" };
        if (options.offline) {
            env.HTTPS_PROXY = "http://127.0.0.1:9";
            env.HTTP_PROXY = "http://127.0.0.1:9";
            env.NO_PROXY = "";
        }
        let graph;
        try {
            graph = JSON.parse(run("deno", infoArgs, projectRoot, env));
        }
        catch (err) {
            if (options.offline && err instanceof structures_1.ProjectError) {
                throw new structures_1.ProjectError(`${err.message}\nBuilding with --offline needs every module already in Deno's cache: run the program once with Deno, or build without --offline.`);
            }
            throw err;
        }
        finally {
            (0, node_fs_1.rmSync)(scratch, { recursive: true, force: true });
        }
        const modules = new Map();
        for (const m of graph.modules) {
            if (m.error)
                throw new structures_1.ProjectError(`Deno could not load ${m.specifier}: ${m.error}`);
            modules.set(m.specifier, m);
        }
        const entrySpecifier = graph.roots[0];
        if (!entrySpecifier || !modules.has(entrySpecifier)) {
            throw new structures_1.ProjectError(`Deno did not report a module graph for '${entry}'.`);
        }
        const temp = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "graak-deno-"));
        let cleaned = false;
        const cleanup = () => {
            if (cleaned)
                return;
            cleaned = true;
            (0, node_fs_1.rmSync)(temp, { recursive: true, force: true });
        };
        try {
            DenoBundler.mirrorProject(projectRoot, temp, options.excludePaths ?? []);
            // The bundle, with npm packages left as require() calls.
            const externals = new Map();
            const localSources = new Map();
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
            const name = `${(0, node_path_1.basename)(entry, (0, node_path_1.extname)(entry))}.graak-build.cjs`;
            const bundlePath = (0, node_path_1.join)(temp, (0, node_fs_1.existsSync)((0, node_path_1.join)(temp, name)) ? `graak-${name}` : name);
            const entryRel = (0, node_path_1.relative)(projectRoot, entry).split(node_path_1.sep).join("/");
            (0, node_fs_1.writeFileSync)(bundlePath, DenoBundler.wrap(built, entryRel, deno));
            const pkgPath = (0, node_path_1.join)(temp, "package.json");
            const existing = (0, node_fs_1.existsSync)(pkgPath)
                ? JSON.parse((0, node_fs_1.readFileSync)(pkgPath, "utf-8"))
                : {};
            const dependencies = {
                ...(existing.dependencies ?? {}),
            };
            for (const [alias, pkg] of npmNames.direct)
                dependencies[alias] = pkg;
            const manifest = {
                ...existing,
                name: existing.name ?? config?.name ?? (0, node_path_1.basename)(projectRoot),
                version: existing.version ?? config?.version ?? "0.0.0",
                dependencies,
            };
            delete manifest.type;
            (0, node_fs_1.writeFileSync)(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`);
            const warnings = [];
            const unsupported = new Set();
            for (const source of localSources.values()) {
                for (const [pattern, label] of UNSUPPORTED_DENO_APIS)
                    if (pattern.test(source))
                        unsupported.add(label);
            }
            if (unsupported.size) {
                warnings.push(`The program uses ${[...unsupported].join(", ")}, which Graak does not provide: calling it throws Deno.errors.NotSupported.`);
            }
            const usesFfi = [...localSources.values()].some((source) => FFI_PATTERN.test(source));
            const remote = [...modules.values()].filter((m) => m.kind === "esm" && !m.specifier.startsWith("file:")).length;
            log(`Bundled ${localSources.size} local and ${remote} remote modules; ${npmNames.direct.size} npm package(s) ` +
                `(${npmNames.total} with dependencies) laid out under node_modules`);
            return {
                root: temp,
                entrypoint: bundlePath,
                bundled: [...localSources.keys()].map((abs) => (0, node_path_1.join)(temp, (0, node_path_1.relative)(projectRoot, abs))),
                npmPackages: [...npmNames.direct.values()],
                warnings,
                usesFfi,
                deno,
                cleanup,
            };
        }
        catch (err) {
            cleanup();
            throw err;
        }
    }
    /**
     * The throwaway project mirrors the real one, so everything the program reads next to itself is
     * where the program expects it. Directories are linked, files copied: nothing in the original is
     * written to, and nothing large is duplicated.
     */
    static mirrorProject(projectRoot, temp, excluded) {
        for (const entry of (0, node_fs_1.readdirSync)(projectRoot, { withFileTypes: true })) {
            const name = entry.name;
            if (name === "node_modules" || name === ".git" || name === ".deno")
                continue;
            const source = (0, node_path_1.join)(projectRoot, name);
            if (excluded.some((p) => (0, node_path_1.resolve)(p) === source))
                continue;
            const dest = (0, node_path_1.join)(temp, name);
            try {
                if ((0, node_fs_1.statSync)(source).isDirectory())
                    linkDirectory(source, dest);
                else
                    (0, node_fs_1.copyFileSync)(source, dest);
            }
            catch {
                // A file that cannot be read is not one the program can be relying on.
            }
        }
    }
    /**
     * Lays the graph's npm packages out as a pnpm-style store: each package once, with its own
     * dependencies beside it, and the ones the program imports linked at the top. Files come straight
     * from Deno's cache.
     */
    static layOutPackages(temp, graph, externals) {
        const store = (0, node_path_1.join)(temp, "node_modules", ".graak");
        const dirOf = (key) => {
            const [name, version] = splitPackageKey(key);
            return (0, node_path_1.join)(store, `${name.replace("/", "+")}@${version}`, "node_modules", name);
        };
        const placed = new Set();
        const place = (key) => {
            if (placed.has(key))
                return;
            placed.add(key);
            const pkg = graph.npmPackages[key];
            if (!pkg?.localPath || !(0, node_fs_1.existsSync)(pkg.localPath)) {
                throw new structures_1.ProjectError(`npm package ${key} is not in Deno's cache${pkg?.localPath ? ` (${pkg.localPath})` : ""}. ` +
                    "Run the program once with Deno, or build without --offline, so Deno downloads it.");
            }
            copyTree(pkg.localPath, dirOf(key));
            for (const dep of pkg.dependencies) {
                place(dep);
                const [depName] = splitPackageKey(dep);
                const link = (0, node_path_1.join)((0, node_path_1.dirname)(dirOf(key)), ...depName.split("/"));
                if (!(0, node_fs_1.existsSync)(link))
                    linkDirectory(dirOf(dep), link);
            }
        };
        // Which name a package is imported by. Two versions of one package get distinct top-level names.
        const direct = new Map();
        for (const [alias, { name, version }] of externals) {
            const key = `${name}@${version}`;
            place(key);
            linkDirectory(dirOf(key), (0, node_path_1.join)(temp, "node_modules", ...alias.split("/")));
            direct.set(alias, version);
        }
        return { direct, total: placed.size };
    }
    static async build(input) {
        const esbuild = require("esbuild");
        const { graph, modules, entrySpecifier, projectRoot, config, externals, localSources } = input;
        const NAMESPACE = "deno";
        const SUFFIX = "?graak";
        const EXTERNAL = "graak-external";
        const redirect = (specifier) => {
            let current = specifier;
            for (let hops = 0; hops < 16 && graph.redirects[current]; hops++)
                current = graph.redirects[current];
            return current;
        };
        const relToRoot = (abs) => (0, node_path_1.relative)(projectRoot, abs).split(node_path_1.sep).join("/");
        /** Name the program requires an npm package by; a second version of one package gets a distinct alias. */
        const aliasFor = (name, version) => {
            const same = [...externals.entries()].find(([, v]) => v.name === name && v.version === version);
            if (same)
                return same[0];
            const alias = [...externals.values()].some((v) => v.name === name) ? `${name}-graak-v${version}` : name;
            externals.set(alias, { name, version });
            return alias;
        };
        const tsconfig = {};
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
            if (co[key] !== undefined)
                tsconfig[key] = co[key];
        }
        const plugin = {
            name: "deno-graph",
            setup(build) {
                build.onResolve({ filter: /.*/ }, (args) => {
                    if (args.kind === "entry-point")
                        return { path: entrySpecifier + SUFFIX, namespace: NAMESPACE };
                    // The require() a package module makes is answered by the host at run time, not bundled.
                    if (args.namespace === EXTERNAL)
                        return { path: args.path, external: true };
                    if (args.namespace !== NAMESPACE)
                        return undefined;
                    const importer = modules.get(args.importer.slice(0, -SUFFIX.length));
                    const dep = importer?.dependencies?.find((d) => d.specifier === args.path);
                    const target = dep?.code?.specifier ?? dep?.type?.specifier;
                    if (!target) {
                        return {
                            errors: [{ text: `Deno's module graph has no resolution for "${args.path}" from ${args.importer}` }],
                        };
                    }
                    const final = redirect(target);
                    if (final.startsWith("node:"))
                        return { path: final, namespace: EXTERNAL };
                    const npm = parseNpmSpecifier(final);
                    if (npm) {
                        return { path: aliasFor(npm.name, npm.version) + npm.subpath, namespace: EXTERNAL };
                    }
                    if (!modules.has(final))
                        return { errors: [{ text: `Deno's module graph does not contain ${final}` }] };
                    return { path: final + SUFFIX, namespace: NAMESPACE };
                });
                build.onLoad({ filter: /.*/, namespace: EXTERNAL }, (args) => ({
                    contents: `module.exports = require(${JSON.stringify(args.path)});`,
                    loader: "js",
                }));
                build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => {
                    const specifier = args.path.slice(0, -SUFFIX.length);
                    const mod = modules.get(specifier);
                    if (!mod?.local)
                        return { errors: [{ text: `No cached source for ${specifier}` }] };
                    const loader = LOADERS[mod.mediaType ?? ""] ?? LOADERS[(0, node_path_1.extname)(mod.local) === ".json" ? "Json" : "JavaScript"];
                    if (mod.mediaType === "Wasm") {
                        return {
                            errors: [{ text: `${specifier} is WebAssembly, which Graak cannot bundle from a module import` }],
                        };
                    }
                    let contents = (0, node_fs_1.readFileSync)(mod.local, "utf-8");
                    if (specifier.startsWith("file:")) {
                        const abs = (0, node_url_1.fileURLToPath)(specifier);
                        const rel = relToRoot(abs);
                        if (loader !== "json")
                            localSources.set(abs, contents);
                        const q = JSON.stringify(rel);
                        const isEntry = specifier === entrySpecifier;
                        contents = contents
                            .replace(/\bimport\.meta\.url\b/g, `__graak_url(${q})`)
                            .replace(/\bimport\.meta\.dirname\b/g, `__graak_dirname(${q})`)
                            .replace(/\bimport\.meta\.filename\b/g, `__graak_file(${q})`)
                            .replace(/\bimport\.meta\.main\b/g, isEntry ? "true" : "false")
                            .replace(/\bimport\.meta\.resolve\(/g, `__graak_resolve(${q}, `);
                    }
                    else {
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
    static wrap(bundle, entryRel, deno) {
        const runtime = (0, node_path_1.join)((0, node_path_1.dirname)(require.resolve("../../package.json")), "quickjs/runtime");
        // The WebSocket module is shared with the runtime layer: its source is inlined here, minus the ES module export.
        const websocket = (0, node_fs_1.readFileSync)((0, node_path_1.join)(runtime, "node-websocket.js"), "utf-8").replace(/\nexport \{[^}]*\};?\s*$/, "\n");
        const websocketSetup = `${websocket}
(function installWebSocket(global) {
	if (global[Symbol.for("graak.websocket")]) return;
	const ws = createWebSocket({ http: require("http"), https: require("https"), crypto: require("crypto"), Buffer, CloseEvent: global.CloseEvent, MessageEvent: global.MessageEvent });
	Object.defineProperty(global, Symbol.for("graak.websocket"), { value: ws, enumerable: false });
	for (const name of ["WebSocket", "CloseEvent", "MessageEvent"]) {
		if (typeof global[name] === "undefined") Object.defineProperty(global, name, { value: ws[name], writable: true, configurable: true });
	}
})(globalThis);`;
        const shim = [websocketSetup, ...exports.DENO_SHIM_FILES.map((file) => (0, node_fs_1.readFileSync)((0, node_path_1.join)(runtime, file), "utf-8"))]
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
                if (local)
                    exportsCode += `\nexports[${JSON.stringify(exported ?? local)}] = ${local};`;
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
exports.DenoBundler = DenoBundler;
//# sourceMappingURL=DenoBundler.js.map
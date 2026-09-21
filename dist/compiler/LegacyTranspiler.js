"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LegacyTranspiler = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * Lowers a collected project to syntax an old Node.js runtime can parse.
 *
 * Targets like Windows 7 (Node.js 12) and Windows Vista (Node.js 5) are pinned to runtimes
 * whose V8 predates syntax that current discord.js and ForgeScript are shipped in. Nothing
 * about a Node.js binary can be picked around that, but the *code* can be rewritten, which is
 * what this does: every bundled JavaScript file is re-emitted for the target's language level
 * before it is packed into the archive.
 *
 * esbuild does the rewriting rather than the TypeScript compiler, which was tried first and
 * rejected on evidence: TypeScript's ES2019 downlevel hoists private class methods out of the
 * class body but leaves their `super.x()` calls behind, emitting
 * `SyntaxError: 'super' keyword unexpected here` (reproduced on undici's decompress
 * interceptor). esbuild emits a `__superGet` helper instead, and is roughly six times faster
 * on a real dependency tree.
 *
 * Source files on disk are never modified. Entries carry either a path or a buffer, so a
 * rewritten file is swapped for an in-memory buffer and the user's `node_modules` is left
 * exactly as their package manager installed it.
 */
/** Files worth handing to esbuild. Anything else is copied into the archive untouched. */
const TRANSPILABLE = /\.(js|cjs|mjs)$/;
function entrySource(entry) {
    return typeof entry.source === "string" ? (0, node_fs_1.readFileSync)(entry.source) : entry.source;
}
class LegacyTranspiler {
    /**
     * Maps every directory in the archive to the module format its nearest `package.json`
     * declares. Resolved from the archive's own entries rather than from disk, so it is correct
     * for generated, in-memory files too.
     *
     * This has to be resolved rather than assumed. Emitting CommonJS into a package that
     * declares `"type": "module"` rewrites its `import`/`export` into `require`/`exports`, and
     * Node then loads those files as ES modules and rejects them.
     */
    static packageTypes(entries) {
        const declared = new Map();
        for (const entry of entries) {
            if (node_path_1.posix.basename(entry.path) !== "package.json")
                continue;
            try {
                const manifest = JSON.parse(entrySource(entry).toString("utf-8"));
                declared.set(node_path_1.posix.dirname(entry.path), manifest.type === "module" ? "module" : "commonjs");
            }
            catch {
                // A package.json that does not parse cannot be declaring "type": "module".
            }
        }
        return declared;
    }
    static formatFor(file, declared) {
        if (file.endsWith(".mjs"))
            return "module";
        if (file.endsWith(".cjs"))
            return "commonjs";
        let dir = node_path_1.posix.dirname(file);
        for (;;) {
            const hit = declared.get(dir);
            if (hit)
                return hit;
            const parent = node_path_1.posix.dirname(dir);
            if (parent === dir)
                return "commonjs";
            dir = parent;
        }
    }
    /**
     * Rewrites every JavaScript entry for `jsTarget`, converting ES modules to CommonJS on the
     * way. The conversion is not optional: `require()` of an ES module only works on Node.js
     * 20.19+/22.12+, and ForgeScript itself `require()`s chalk, which is published as pure ESM.
     */
    static async transpile(entries, options) {
        // Imported lazily so that builds for modern targets, which never transpile, do not pay
        // for loading esbuild at all.
        const esbuild = require("esbuild");
        const declared = LegacyTranspiler.packageTypes(entries);
        const result = {
            entries: [...entries],
            rewritten: 0,
            esmConverted: 0,
            manifestsRewritten: 0,
            failures: [],
        };
        const jobs = [];
        for (let i = 0; i < result.entries.length; i++) {
            const index = i;
            const entry = result.entries[index];
            if (!TRANSPILABLE.test(entry.path))
                continue;
            const wasEsm = LegacyTranspiler.formatFor(entry.path, declared) === "module";
            jobs.push((async () => {
                const original = entrySource(entry).toString("utf-8");
                try {
                    const out = await esbuild.transform(original, {
                        target: options.jsTarget,
                        format: "cjs",
                        platform: "node",
                        loader: "js",
                        sourcefile: entry.path,
                        // Keeps @license / @preserve blocks where they are, which matters for a
                        // bundle that redistributes other people's code.
                        legalComments: "inline",
                    });
                    if (wasEsm)
                        result.esmConverted++;
                    if (out.code !== original) {
                        result.entries[index] = { ...entry, source: Buffer.from(out.code, "utf-8") };
                        result.rewritten++;
                    }
                }
                catch (err) {
                    result.failures.push(`${entry.path}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
                }
            })());
        }
        await Promise.all(jobs);
        // Every ES module in the bundle is CommonJS now, so a surviving "type": "module" would
        // make Node reject files it can otherwise load.
        for (let i = 0; i < result.entries.length; i++) {
            const entry = result.entries[i];
            if (node_path_1.posix.basename(entry.path) !== "package.json")
                continue;
            if (declared.get(node_path_1.posix.dirname(entry.path)) !== "module")
                continue;
            try {
                const manifest = JSON.parse(entrySource(entry).toString("utf-8"));
                delete manifest.type;
                result.entries[i] = { ...entry, source: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8") };
                result.manifestsRewritten++;
            }
            catch {
                // Already skipped above when it failed to parse.
            }
        }
        options.onLog?.(`Lowered ${result.rewritten} files to ${options.jsTarget}` +
            (result.esmConverted ? `, ${result.esmConverted} of them ES modules converted to CommonJS` : "") +
            (result.failures.length ? `, ${result.failures.length} left as-is (unparseable)` : ""));
        return result;
    }
    /**
     * What the native host needs: ES modules become CommonJS and TypeScript/JSX become JavaScript, and nothing else
     * changes. The host's engine parses current syntax directly, so unlike {@link transpile} no downlevelling happens
     * (`target: esnext`), and a file that is already plain CommonJS is left alone without being parsed at all.
     *
     * This is what makes ES-module-only packages (chalk 5, nanoid 5, node-fetch 3, ...) and `.mjs` or TypeScript
     * programs run: the host loads CommonJS. TypeScript and JSX files are renamed to `.js`; the module resolver maps
     * an import of `./x.ts` (or `./x.js` written for an `x.ts`) onto the renamed file.
     */
    static async toCommonJs(entries, options = {}) {
        const esbuild = require("esbuild");
        const declared = LegacyTranspiler.packageTypes(entries);
        const out = [...entries];
        const renamed = new Map();
        const failures = [];
        let converted = 0;
        const ESM_SYNTAX = /(^|[\n;])\s*(import\s*[\w{*'"]|export\s+(default|const|let|var|function|class|async|\{|\*)|export\s*\{)|import\.meta|\bawait\s+import\b/;
        const LOADERS = {
            ".ts": "ts",
            ".mts": "ts",
            ".cts": "ts",
            ".tsx": "tsx",
            ".jsx": "jsx",
        };
        const jobs = [];
        for (let i = 0; i < out.length; i++) {
            const index = i;
            const entry = out[index];
            const ext = node_path_1.posix.extname(entry.path);
            const loader = LOADERS[ext];
            if (!loader && !/\.(js|cjs|mjs)$/.test(entry.path))
                continue;
            if (entry.path.endsWith(".d.ts") || entry.path.endsWith(".d.mts") || entry.path.endsWith(".d.cts"))
                continue;
            jobs.push((async () => {
                const original = entrySource(entry).toString("utf-8");
                const isModule = LegacyTranspiler.formatFor(entry.path, declared) === "module";
                // Plain CommonJS needs no work. A file in a "type": "module" package or a .mjs is converted
                // whether or not it looks like it, since a bare `export {}` still marks it as a module.
                if (!loader && !isModule && !ESM_SYNTAX.test(original))
                    return;
                try {
                    const usesMeta = original.includes("import.meta");
                    const result = await esbuild.transform(original, {
                        target: "esnext",
                        format: "cjs",
                        platform: "node",
                        loader: loader ?? "js",
                        // esbuild reads ".mjs" as "Node ESM importing CommonJS" and then hands `import x from "y"` the whole
                        // module.exports. Everything here was ES modules that are CommonJS now, so the extension is hidden
                        // and a default import is the module's `default` export, as it was.
                        sourcefile: entry.path.replace(/\.mjs$/, ".js").replace(/\.mts$/, ".ts"),
                        jsx: "automatic",
                        legalComments: "inline",
                        // import() becomes Promise.resolve().then(() => require(...)): a real dynamic import would ask the
                        // engine's own module loader, which knows nothing of node_modules resolution or CommonJS interop.
                        supported: { "dynamic-import": false },
                        ...(usesMeta
                            ? {
                                define: {
                                    "import.meta.url": "__fgMetaUrl",
                                    "import.meta.dirname": "__dirname",
                                    "import.meta.filename": "__filename",
                                },
                                banner: 'const __fgMetaUrl = require("url").pathToFileURL(__filename).href;',
                            }
                            : {}),
                    });
                    converted++;
                    let path = entry.path;
                    if (loader) {
                        path = entry.path.slice(0, -ext.length) + (ext === ".mts" ? ".mjs" : ext === ".cts" ? ".cjs" : ".js");
                        renamed.set(entry.path, path);
                    }
                    out[index] = { ...entry, path, source: Buffer.from(result.code, "utf-8") };
                }
                catch (err) {
                    failures.push(`${entry.path}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
                }
            })());
        }
        await Promise.all(jobs);
        // A surviving "type": "module" would mislead tools that read the manifest, and the files are CommonJS now.
        for (let i = 0; i < out.length; i++) {
            const entry = out[i];
            if (node_path_1.posix.basename(entry.path) !== "package.json")
                continue;
            if (declared.get(node_path_1.posix.dirname(entry.path)) !== "module")
                continue;
            try {
                const manifest = JSON.parse(entrySource(entry).toString("utf-8"));
                delete manifest.type;
                out[i] = { ...entry, source: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8") };
            }
            catch {
                // Not a manifest we can rewrite.
            }
        }
        if (converted) {
            options.onLog?.(`Converted ${converted} ES module / TypeScript files to CommonJS for the native host` +
                (failures.length ? `, ${failures.length} left as-is (unparseable)` : ""));
        }
        return { entries: out, renamed, converted, failures };
    }
}
exports.LegacyTranspiler = LegacyTranspiler;
//# sourceMappingURL=LegacyTranspiler.js.map
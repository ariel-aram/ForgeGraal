"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LegacyRuntimeAssets = exports.LEGACY_ASSET_DIR = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const structures_1 = require("../structures");
/**
 * Builds the runtime support files a legacy target needs, and returns them as archive entries.
 *
 * Two things are shipped:
 *
 * - `polyfills.js` — the Web platform implementations the old runtime lacks (Web Streams,
 *   EventTarget, AbortController, Blob/File/FormData), bundled from ForgeGraal's own
 *   dependencies into one file and lowered to the target's language level. Bundling matters:
 *   the packages together are about 10 MiB on disk, almost all of it alternate dist builds and
 *   source maps, and what the bot actually needs is a few hundred KiB of code. They are also
 *   deliberately *not* written into the bundle's `node_modules`, so they can never shadow or
 *   collide with a package the bot itself depends on.
 * - `esbuild-wasm/` — the WebAssembly build of esbuild, copied verbatim, used to lower code the
 *   bot generates at runtime. Only included when the build asks for it.
 */
/** Directory inside the application archive that holds these files. */
exports.LEGACY_ASSET_DIR = ".forgegraal-legacy";
/**
 * Entry bundled into `polyfills.js`. `web-streams-polyfill`'s ponyfill build is used on purpose:
 * the polyfill build installs itself onto the global object as a side effect, which would
 * overwrite whatever the runtime already provides instead of only filling gaps.
 */
const POLYFILL_ENTRY = `
const streams = require("web-streams-polyfill/dist/ponyfill.js");
const eventTarget = require("event-target-shim");
const abort = require("abort-controller");
const formdata = require("formdata-node");

module.exports = {
	ReadableStream: streams.ReadableStream,
	WritableStream: streams.WritableStream,
	TransformStream: streams.TransformStream,
	ByteLengthQueuingStrategy: streams.ByteLengthQueuingStrategy,
	CountQueuingStrategy: streams.CountQueuingStrategy,
	EventTarget: eventTarget.EventTarget,
	Event: eventTarget.Event,
	AbortController: abort.AbortController || abort.default || abort,
	AbortSignal: abort.AbortSignal,
	FormData: formdata.FormData,
	Blob: formdata.Blob,
	File: formdata.File,
};
`;
function collectDirectory(root, archivePrefix, skip) {
    const entries = [];
    const walk = (dir) => {
        for (const item of (0, node_fs_1.readdirSync)(dir, { withFileTypes: true })) {
            const abs = (0, node_path_1.join)(dir, item.name);
            const rel = (0, node_path_1.relative)(root, abs).split(node_path_1.sep).join("/");
            if (skip(rel))
                continue;
            if (item.isDirectory()) {
                walk(abs);
            }
            else if (item.isFile()) {
                entries.push({ path: `${archivePrefix}/${rel}`, source: abs, mode: (0, node_fs_1.statSync)(abs).mode });
            }
        }
    };
    walk(root);
    return entries;
}
class LegacyRuntimeAssets {
    static async build(options) {
        const esbuild = require("esbuild");
        const entries = [];
        // Resolved against this file's own location so the polyfill packages come from
        // ForgeGraal's dependencies, never from the bot's project directory.
        const resolveDir = (0, node_path_1.dirname)(require.resolve("../../package.json"));
        let bundle;
        try {
            bundle = await esbuild.build({
                stdin: { contents: POLYFILL_ENTRY, resolveDir, sourcefile: "forgegraal-polyfills.js", loader: "js" },
                bundle: true,
                write: false,
                format: "cjs",
                platform: "node",
                target: options.jsTarget,
                legalComments: "inline",
            });
        }
        catch (err) {
            throw new structures_1.RuntimeError(`Could not bundle the legacy runtime polyfills: ${err instanceof Error ? err.message : String(err)}`);
        }
        const output = bundle.outputFiles?.[0];
        if (!output)
            throw new structures_1.RuntimeError("Bundling the legacy runtime polyfills produced no output");
        entries.push({
            path: `${exports.LEGACY_ASSET_DIR}/polyfills.js`,
            source: Buffer.from(output.contents),
            mode: 0o644,
        });
        if (options.runtimeCodegen) {
            const wasmRoot = (0, node_path_1.dirname)(require.resolve("esbuild-wasm/package.json"));
            entries.push(...collectDirectory(wasmRoot, `${exports.LEGACY_ASSET_DIR}/esbuild-wasm`, 
            // `esm/` is the browser ES module build and `lib/main.js` is reached through
            // CommonJS here; the rest (package.json, lib/, bin/, esbuild.wasm, wasm_exec*)
            // is what the Node.js path actually loads.
            (rel) => rel === "esm" || rel.startsWith("esm/")));
        }
        let bytes = 0;
        for (const entry of entries) {
            bytes += typeof entry.source === "string" ? (0, node_fs_1.statSync)(entry.source).size : entry.source.length;
        }
        options.onLog?.(`Added ${entries.length} legacy runtime files (${(bytes / 1048576).toFixed(1)} MiB uncompressed)` +
            (options.runtimeCodegen ? ", including esbuild's WebAssembly build for runtime-generated code" : ""));
        return { entries, bytes };
    }
    /** Reads the bundled polyfill file back, used by tests to assert on what was produced. */
    static readEntry(entry) {
        return typeof entry.source === "string" ? (0, node_fs_1.readFileSync)(entry.source) : entry.source;
    }
}
exports.LegacyRuntimeAssets = LegacyRuntimeAssets;
//# sourceMappingURL=LegacyRuntimeAssets.js.map
import type { ArchiveEntry } from "./Archive";
/**
 * Builds the runtime support files a legacy target needs, and returns them as archive entries.
 *
 * Two things are shipped:
 *
 * - `polyfills.js` — the Web platform implementations the old runtime lacks (Web Streams,
 *   EventTarget, AbortController, Blob/File/FormData), bundled from Graak's own
 *   dependencies into one file and lowered to the target's language level. Bundling matters:
 *   the packages together are about 10 MiB on disk, almost all of it alternate dist builds and
 *   source maps, and what the bot actually needs is a few hundred KiB of code. They are also
 *   deliberately *not* written into the bundle's `node_modules`, so they can never shadow or
 *   collide with a package the bot itself depends on.
 * - `esbuild-wasm/` — the WebAssembly build of esbuild, copied verbatim, used to lower code the
 *   bot generates at runtime. Only included when the build asks for it.
 */
/** Directory inside the application archive that holds these files. */
export declare const LEGACY_ASSET_DIR = ".graak-legacy";
export interface LegacyAssetOptions {
    /** esbuild target string, e.g. `node12`. */
    jsTarget: string;
    /** Ship esbuild's WebAssembly build so runtime-generated code can be lowered on the device. */
    runtimeCodegen: boolean;
    onLog?: (message: string) => void;
}
export interface LegacyAssetResult {
    entries: ArchiveEntry[];
    bytes: number;
}
export declare class LegacyRuntimeAssets {
    static build(options: LegacyAssetOptions): Promise<LegacyAssetResult>;
    /** Reads the bundled polyfill file back, used by tests to assert on what was produced. */
    static readEntry(entry: ArchiveEntry): Buffer;
}
//# sourceMappingURL=LegacyRuntimeAssets.d.ts.map
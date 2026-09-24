import type { TargetDevice } from "../structures";
import type { ArchiveEntry } from "./Archive";
/**
 * Drops the files of a native-engine build that the program can never load: packages nothing requires,
 * files of a package that nothing reaches, type declarations, documentation, tests, and binaries built for
 * another platform. A project installs far more than it runs (every dependency's README, `.d.ts`, source maps,
 * ESM and CommonJS copies of the same code, prebuilt addons for every platform), and all of it used to ship.
 *
 * The program's own files are always kept. From them the module graph is followed file by file, with the same
 * resolution rules the host uses at run time (`resolveModule` in quickjs/runtime/node-compat.js: "exports" with
 * the require condition first, "main", index files, extension probing). Files stay files: nothing is bundled or
 * minified, so `__dirname`, stack traces, `require.cache` and module identity are what they were.
 *
 * What a static reading cannot follow is kept whole instead of guessed at:
 * - a package whose reached code builds a path at run time (`__dirname`, `__filename`, `import.meta`, a
 *   `require()` of a computed name, `require.resolve`, `createRequire`, `process.dlopen`) keeps every file but the
 *   ones listed under {@link isNeverLoaded}, and every package it depends on is kept whole too;
 * - a package that ships a native addon keeps all of it (loaders such as `bindings` look for the file themselves);
 * - a `require.resolve()` of a literal keeps the whole package it names.
 * Licence files are kept for every package that ships, since the build redistributes that code.
 */
export interface TrimOptions {
    target: TargetDevice;
    /** Files that were TypeScript sources and were converted to `.js` by the build (their new paths). */
    convertedFromTypeScript?: ReadonlySet<string>;
}
export interface TrimResult {
    entries: ArchiveEntry[];
    before: {
        files: number;
        bytes: number;
    };
    after: {
        files: number;
        bytes: number;
    };
    /** Packages (by install path) that nothing reaches and were left out. */
    droppedPackages: string[];
}
export declare class AppTrimmer {
    /**
     * Whether a file inside an installed package is one no program loads: type declarations, source maps (added back
     * when something reads them), documentation, and the package's own tests, examples and editor settings.
     */
    static isNeverLoaded(path: string, packageRoot: string): boolean;
    static trim(entries: readonly ArchiveEntry[], options: TrimOptions): TrimResult;
}
//# sourceMappingURL=AppTrimmer.d.ts.map
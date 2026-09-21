export interface DenoVersion {
    deno: string;
    v8: string;
    typescript: string;
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
    deno: DenoVersion;
    /** Removes `root`. Safe to call more than once. */
    cleanup: () => void;
}
/** Parses `npm:/name@1.2.3/sub/path` into the package name and the subpath (`""` or `/sub/path`). */
export declare function parseNpmSpecifier(specifier: string): {
    name: string;
    version: string;
    subpath: string;
} | null;
export declare class DenoBundler {
    static isAvailable(): boolean;
    /** The installed Deno's own version strings, which `Deno.version` reports so version checks in code agree. */
    static version(): DenoVersion;
    /**
     * Bundles a Deno program into a self-contained CommonJS file inside a throwaway project directory,
     * ready for `ProjectCollector`. The original project is never written to.
     */
    static bundle(options: DenoBundleOptions): Promise<DenoBundleResult>;
    /**
     * The throwaway project mirrors the real one, so everything the program reads next to itself is
     * where the program expects it. Directories are linked, files copied: nothing in the original is
     * written to, and nothing large is duplicated.
     */
    private static mirrorProject;
    /**
     * Lays the graph's npm packages out as a pnpm-style store: each package once, with its own
     * dependencies beside it, and the ones the program imports linked at the top. Files come straight
     * from Deno's cache.
     */
    private static layOutPackages;
    private static build;
    /**
     * A bundle is an ES module (top-level await, `export`s); the host loads CommonJS. Running it inside an
     * async function keeps `await` legal, and the entry's exports, if any, become `module.exports`.
     */
    private static wrap;
}
//# sourceMappingURL=DenoBundler.d.ts.map
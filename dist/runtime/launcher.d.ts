export interface LauncherConfig {
    /** Application name, used for the data directory next to the executable. */
    name: string;
    /** Entrypoint path relative to the application directory (POSIX separators). */
    entry: string;
    /** SHA-256 of the embedded archive; changes trigger re-extraction. */
    hash: string;
    /** Minimum Node.js version required by the bundled dependencies, e.g. "20.18.1". */
    minNode: string | null;
    target: string;
    mode: "sea" | "portable";
    /**
     * Target traits, resolved from the target metadata at build time. The launcher must not
     * infer them from the target id: substring checks silently miss targets (`win-xp-x86`
     * contains no "legacy", `linux-x86` no "xp").
     */
    windowsLegacy: boolean;
    /** 32-bit or otherwise old CPUs, which may lack the SIMD Wasm undici prefers. */
    simdUnsafe: boolean;
    /** Install the native addon shim (legacy and 32-bit targets). */
    nativeShim: boolean;
}
export declare const SEA_ASSET_NAME = "app.fgar";
export declare const PORTABLE_ARCHIVE_NAME = "app.fgar";
export declare const PORTABLE_LAUNCHER_NAME = "boot.cjs";
/**
 * Builds the CommonJS bootstrap that runs inside the Node.js SEA or portable bundle.
 *
 * It is deliberately written in ES5 without optional APIs so that outdated runtimes
 * (e.g. on Windows XP / Vista or iSH) reach the version check and print a readable error
 * instead of a SyntaxError.
 */
export declare function createLauncherSource(config: LauncherConfig): string;
/** Helper loaded from disk so that dynamic import() works for ESM entrypoints inside a SEA. */
export declare const IMPORT_HELPER_SOURCE = "\"use strict\";\nmodule.exports = function (url) { return import(url); };\n";
export declare const IMPORT_HELPER_PATH = ".forgegraal-import.cjs";
//# sourceMappingURL=launcher.d.ts.map
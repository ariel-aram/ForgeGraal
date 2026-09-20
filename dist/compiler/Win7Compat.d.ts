/**
 * Lets addons built for a newer Windows load on Windows Vista and 7.
 *
 * A native addon is a DLL, and the operating system -- not ForgeGraal -- binds its imports when it is
 * loaded. Prebuilt addons are compiled for whatever Windows their authors target, and the Rust ones
 * (@napi-rs/canvas, davey, mediaplex, ...) and libvips reach for a handful of functions Windows 7 does
 * not have. Measured on the real prebuilds of lmdb, better-sqlite3, msgpackr-extract, @napi-rs/canvas,
 * davey, mediaplex and sharp, the entire gap is five functions:
 *
 *   api-ms-win-core-synch-l1-2-0.dll  WaitOnAddress, WakeByAddressSingle, WakeByAddressAll   (Windows 8)
 *   bcryptprimitives.dll              ProcessPrng                                            (Windows 10)
 *   kernel32.dll                      GetSystemTimePreciseAsFileTime                         (Windows 8)
 *
 * and lmdb, better-sqlite3 and msgpackr-extract need none of them. So instead of giving up on those
 * addons, the bundle is patched at build time: an import that Windows 7 cannot satisfy is pointed at
 * something it can. The edit is in place and never changes a file's layout:
 *
 *   - a whole imported DLL is renamed to one of ForgeGraal's compatibility DLLs (`fgsynch.dll`,
 *     `fgprng.dll`, built from quickjs/native/win-compat/), which ships beside the addon -- Windows looks
 *     next to the loaded DLL first;
 *   - a single imported function is renamed to a signature-compatible one the same DLL does have
 *     (GetSystemTimePreciseAsFileTime -> GetSystemTimeAsFileTime: coarser, same contract).
 *
 * Only imports listed here are touched, and only when the descriptor's whole content is covered, so an
 * addon that needs something else still fails with the system's own message rather than a wrong guess.
 * What this cannot supply is a runtime the addon links dynamically -- the Universal C Runtime
 * (api-ms-win-crt-*) that libvips imports is a Windows update on 7, not a function to reimplement.
 */
interface DllRename {
    dll: string;
    /** Every function the descriptor imports must be one of these for the rename to be safe. */
    functions: readonly string[];
    to: string;
}
interface FunctionRename {
    dll: string;
    from: string;
    to: string;
}
export declare const WIN7_DLL_RENAMES: readonly DllRename[];
export declare const WIN7_FUNCTION_RENAMES: readonly FunctionRename[];
export interface Win7PatchResult {
    /** The patched file. */
    buffer: Buffer;
    /** Human-readable list of what was redirected. */
    changes: string[];
    /** Compatibility DLLs that must ship beside the patched file. */
    shims: string[];
    /** Imports Windows 7 cannot satisfy that nothing here replaces. */
    unresolved: string[];
}
export declare class Win7Compat {
    /**
     * Redirects the imports of a PE file that Windows 7 lacks. Returns null when the file is not a PE or
     * has nothing to change; the input is never modified.
     */
    static patch(input: Buffer): Win7PatchResult | null;
    /** Lower-cased names of the DLLs a PE file imports (empty for anything else). */
    static importedDlls(input: Buffer): string[];
    /**
     * Whether a PE file needs the Universal C Runtime. Windows 7 has it only with update KB2999226, and it
     * is not a function to reimplement, so the answer decides whether to bundle it app-local or warn.
     */
    static needsUcrt(input: Buffer): boolean;
    /** Names of the compatibility DLLs a patched bundle needs. */
    static shimNames(): string[];
    /**
     * Builds (and caches) the compatibility DLLs for one architecture with quickjs/native/win-compat/.
     * Returns the directory that holds fgsynch.dll and fgprng.dll.
     */
    static ensureShims(arch: "x64" | "ia32"): string;
}
export {};
//# sourceMappingURL=Win7Compat.d.ts.map
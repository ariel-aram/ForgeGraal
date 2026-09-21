import { TargetDevice } from "../structures";
/**
 * Obtains a [quickjs-ng](https://github.com/quickjs-ng/quickjs) engine binary for a target.
 *
 * This exists because the Node.js path has a hard ceiling on old hardware, and quickjs-ng does
 * not share it. Node's own platform support decides which *language* a machine can run: Windows 7
 * is stuck on Node 12, and 32-bit Linux on an unofficial Node 12.16.3, both far below what
 * current discord.js is written in. quickjs-ng is a small C99 engine with no such coupling — the
 * project publishes a 32-bit Windows build and a 32-bit Linux build of a *current* JavaScript
 * engine, which is the thing Node cannot offer those platforms at all.
 *
 * Measured against the official v0.16.2 binaries rather than assumed:
 *
 * - Every piece of syntax that fails to parse on the Windows 7 Node pin runs here: optional
 *   chaining, nullish coalescing and its assignment form, private class methods calling `super`,
 *   class static blocks, async generators, `Array.prototype.at`/`findLast`, `Object.hasOwn`,
 *   `String.prototype.replaceAll`/`toWellFormed`, `Promise.any`, `AggregateError`, BigInt.
 * - The 32-bit Linux build is static-pie linked, so it carries no glibc version requirement.
 * - The 32-bit Windows build declares PE subsystem 4.0, but its imports are what actually decide
 *   where it runs: `InitOnceExecuteOnce`, `InitializeConditionVariable`, `WakeConditionVariable`
 *   and `SleepConditionVariableCS`. All four are Windows Vista and later, and all four come from
 *   one block in the engine's `cutils.h` guarded by `JS_HAVE_THREADS`. So Vista and 7 are
 *   expected to work unmodified, and Windows XP needs that single block replaced (or compiled
 *   out) rather than a port.
 *
 * What this does NOT yet provide is a runtime: quickjs-ng is an engine, and a ForgeScript bot
 * needs Node's library surface on top of it. Scanning the real dependency tree, that is 30
 * builtin modules, led by `assert`, `util`, `stream`, `buffer`, `fs`, `process`, `events` and
 * `crypto`, plus sockets and TLS for Discord. Until that layer exists, this module is how the
 * engine is fetched and verified, not a way to run a bot.
 */
/** Release the pinned checksums below were taken from. */
export declare const QUICKJS_VERSION = "v0.16.2";
export interface QuickJsAsset {
    /** Asset file name in the quickjs-ng release. */
    asset: string;
    /**
     * SHA-256 of that asset, pinned the same way community Node.js runtimes are: quickjs-ng
     * publishes no checksum file with its releases, so nothing is downloaded without a hash
     * recorded here first.
     */
    sha256: string | null;
}
/**
 * quickjs-ng assets that match a Graak target. Targets are absent when the release has no
 * build for them, which is not the same as the target being unsupported by the engine — it means
 * it would have to be built from source.
 */
export declare const QUICKJS_TARGET_ASSETS: Partial<Record<TargetDevice, QuickJsAsset>>;
/**
 * Windows APIs the published 32-bit build imports that do not exist before Windows Vista. Kept
 * here because it is the concrete list an XP build has to deal with, and because it is checked
 * by a test: if a future release starts importing something newer, that should be noticed rather
 * than discovered on a user's machine.
 */
export declare const QUICKJS_VISTA_ONLY_IMPORTS: readonly ["InitOnceExecuteOnce", "InitializeConditionVariable", "WakeConditionVariable", "SleepConditionVariableCS"];
export declare class QuickJsRuntime {
    static cacheDir(): string;
    static assetFor(target: TargetDevice): QuickJsAsset | null;
    static downloadUrl(asset: string, version?: string): string;
    /**
     * Downloads an engine binary into the cache, verifying it against the pinned checksum.
     *
     * A missing checksum is refused rather than trusted. quickjs-ng ships no SHASUMS file, so
     * "no hash recorded" means nobody has vouched for that asset, and downloading an executable
     * on that basis is exactly what `RuntimeRegistry` already refuses to do for community Node
     * builds.
     */
    static ensure(target: TargetDevice, options?: {
        version?: string;
        sha256?: string;
    }): Promise<string>;
    /**
     * Reads the DLL function names a Windows build imports. Used to decide how old a Windows a
     * binary can actually run on, which the PE header's declared subsystem version does not tell
     * you: the published 32-bit build claims subsystem 4.0 while importing Vista-only functions.
     *
     * This is a deliberately shallow scan of the file's ASCII contents rather than a full import
     * directory walk. It is used to answer "does this reference something too new", where a false
     * positive is safe and only a false negative would mislead.
     */
    static importedSymbols(binaryPath: string, wanted: readonly string[]): string[];
    /**
     * Oldest Windows a given engine binary can run on, judged by what it imports.
     * Returns `null` for a binary that is not a Windows build.
     */
    static windowsFloor(binaryPath: string): "xp" | "vista" | null;
}
//# sourceMappingURL=QuickJsRuntime.d.ts.map
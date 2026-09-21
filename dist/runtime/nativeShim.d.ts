/**
 * Native addon shim injected into Graak executables.
 *
 * Legacy and 32-bit targets (Windows XP / Vista / 7, iSH, linux-x86, FreeBSD) frequently
 * cannot load prebuilt `.node` addons, so `require()` fails with ERR_DLOPEN_FAILED. This
 * shim intercepts that failure and substitutes a replacement **only when a correct one
 * exists**:
 *
 * - `bufferutil`, `utf-8-validate` — pure JS implementations with identical semantics
 *   (the same algorithms `ws` uses when these optional accelerators are absent).
 * - `sqlite3`, `better-sqlite3` — backed by Node's built-in `node:sqlite`, so data is
 *   really written to the same database file. Unimplemented methods throw instead of
 *   silently doing nothing.
 *
 * Everything else (LMDB, canvas, gifsx, sodium/davey voice crypto, zlib-sync, bcrypt,
 * pg-native, mysql2, msgpackr-extract, mediaplex) is deliberately **not** stubbed. A stub
 * that returns empty images, discards database writes, hashes passwords with unsalted
 * SHA-256, or produces ciphertext with the wrong algorithm is worse than a crash: the bot
 * appears to work while losing data or leaking security guarantees. For those the original
 * error is rethrown with an explanation of what to do about it. Most of them are optional
 * accelerators whose own libraries already fall back to pure JS when the addon is missing.
 */
export interface NativeShimConfig {
    /** Target id, only used in diagnostics. */
    target: string;
}
/**
 * Packages whose absence the calling library already handles, so the load error must be
 * allowed to propagate untouched rather than being answered with a fake module.
 */
export declare const OPTIONAL_ACCELERATORS: readonly ["zlib-sync", "msgpackr-extract", "pg-native", "mediaplex", "@discordjs/opus", "node-opus"];
/**
 * Packages that genuinely need a native addon. Substituting them silently would corrupt
 * data or weaken security, so the build fails or the bot stops with an explanation.
 */
export declare const UNSUBSTITUTABLE_NATIVE: readonly ["lmdb", "canvas", "@napi-rs/canvas", "@gifsx/gifsx", "sodium-native", "@snazzah/davey", "bcrypt", "argon2"];
/**
 * Builds the ES5 shim source embedded in the launcher.
 */
export declare function createNativeShimSource(config: NativeShimConfig): string;
/**
 * @deprecated Use {@link createNativeShimSource}. Kept so existing imports keep working.
 */
export declare const WASM_FALLBACKS_SOURCE: string;
//# sourceMappingURL=nativeShim.d.ts.map
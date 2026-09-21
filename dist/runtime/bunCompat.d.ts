/**
 * Bun runtime compatibility layer.
 *
 * Graak executables always run on Node.js (SEA / portable bundle), even when the bot
 * project itself is authored for and developed with Bun. Code written against Bun's own
 * APIs — `import { Database } from "bun:sqlite"`, `Bun.serve`, `Bun.file`, `Bun.env` — does
 * not exist under Node and would otherwise fail at startup with "Cannot find module
 * 'bun:sqlite'" or "Bun is not defined".
 *
 * This layer intercepts those two failure modes and answers with a real implementation
 * only where one is achievable with the *same behavior*:
 *
 * - `bun:sqlite`'s `Database` — backed by Node's built-in `node:sqlite`, matching Bun's
 *   synchronous, better-sqlite3-shaped API. Rows go to the real database file.
 * - `Bun.file` / `Bun.write` — backed by `node:fs`, same read/write semantics.
 * - `Bun.serve` — a Fetch-API HTTP server bridged onto `node:http`, so `fetch(request)`
 *   handlers written for Bun run unmodified.
 * - `Bun.env`, `Bun.sleep`, `Bun.which`, `Bun.nanoseconds`, `Bun.gc` — thin, exact wrappers.
 *
 * `Bun.password` (argon2id/bcrypt hashing) and `Bun.hash` (a specific non-cryptographic hash
 * function, xxHash/wyhash/CityHash/Murmur variants) are deliberately **not** polyfilled:
 * Node's standard library has no algorithm that produces the same output, and a different
 * algorithm behind the same name is a silent correctness bug (password hashes that don't
 * verify against ones from Bun, cache keys that never hit). Accessing them throws instead.
 * Anything else on `Bun` (`Bun.spawn`, `Bun.build`, `Bun.$`, FFI, ...) throws the same way:
 * an explained error at the point of use, not a crash three files deep in a library.
 */
export interface BunCompatConfig {
    /** Target id, only used in diagnostics. */
    target: string;
}
/** `Bun.*` members intercepted with a genuine, correct implementation. */
export declare const BUN_GLOBAL_SHIMMED: readonly ["env", "file", "write", "serve", "sleep", "sleepSync", "which", "nanoseconds", "gc", "version", "revision"];
/** `Bun.*` members that exist for compatibility but always throw: no correct equivalent. */
export declare const BUN_GLOBAL_UNSAFE: readonly ["password", "hash", "CryptoHasher"];
export declare function createBunCompatSource(config: BunCompatConfig): string;
//# sourceMappingURL=bunCompat.d.ts.map
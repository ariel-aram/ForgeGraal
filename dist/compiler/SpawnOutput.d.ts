import { type SpawnSyncReturns } from "node:child_process";
/**
 * What a finished (or never started) `spawnSync` has to say for itself. A program that cannot be
 * started at all (`sh` on a Windows machine without one) has no `stderr` or `stdout`: both are
 * null/undefined and only `error` explains it, so reading them unguarded fails with a TypeError
 * that hides the real cause.
 */
export declare function spawnOutput(result: Pick<SpawnSyncReturns<string | Buffer>, "stderr" | "stdout" | "error" | "status" | "signal">): string;
/** Whether `sh` can be started here; Windows has none unless Git for Windows, MSYS2 or WSL provides it. */
export declare function hasPosixShell(): boolean;
//# sourceMappingURL=SpawnOutput.d.ts.map
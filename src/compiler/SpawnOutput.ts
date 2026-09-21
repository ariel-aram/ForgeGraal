import { type SpawnSyncReturns, spawnSync } from "node:child_process";

/**
 * What a finished (or never started) `spawnSync` has to say for itself. A program that cannot be
 * started at all (`sh` on a Windows machine without one) has no `stderr` or `stdout`: both are
 * null/undefined and only `error` explains it, so reading them unguarded fails with a TypeError
 * that hides the real cause.
 */
export function spawnOutput(
	result: Pick<SpawnSyncReturns<string | Buffer>, "stderr" | "stdout" | "error" | "status" | "signal">
): string {
	const text = [result.stderr, result.stdout]
		.map((chunk) => (chunk ? String(chunk).trim() : ""))
		.find((chunk) => chunk.length > 0);
	if (text) return text;
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? `the program could not be started (${result.error.message})` : result.error.message;
	}
	return result.signal ? `terminated by ${result.signal}` : `exit status ${result.status ?? "unknown"}`;
}

/** Whether `sh` can be started here; Windows has none unless Git for Windows, MSYS2 or WSL provides it. */
export function hasPosixShell(): boolean {
	return !spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).error;
}

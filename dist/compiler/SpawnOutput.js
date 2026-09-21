"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spawnOutput = spawnOutput;
exports.hasPosixShell = hasPosixShell;
const node_child_process_1 = require("node:child_process");
/**
 * What a finished (or never started) `spawnSync` has to say for itself. A program that cannot be
 * started at all (`sh` on a Windows machine without one) has no `stderr` or `stdout`: both are
 * null/undefined and only `error` explains it, so reading them unguarded fails with a TypeError
 * that hides the real cause.
 */
function spawnOutput(result) {
    const text = [result.stderr, result.stdout]
        .map((chunk) => (chunk ? String(chunk).trim() : ""))
        .find((chunk) => chunk.length > 0);
    if (text)
        return text;
    if (result.error) {
        const code = result.error.code;
        return code === "ENOENT" ? `the program could not be started (${result.error.message})` : result.error.message;
    }
    return result.signal ? `terminated by ${result.signal}` : `exit status ${result.status ?? "unknown"}`;
}
/** Whether `sh` can be started here; Windows has none unless Git for Windows, MSYS2 or WSL provides it. */
function hasPosixShell() {
    return !(0, node_child_process_1.spawnSync)("sh", ["-c", "exit 0"], { stdio: "ignore" }).error;
}
//# sourceMappingURL=SpawnOutput.js.map
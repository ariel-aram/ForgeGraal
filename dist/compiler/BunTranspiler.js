"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BunTranspiler = exports.BUN_TRANSPILABLE_EXTENSIONS = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const structures_1 = require("../structures");
/**
 * Extensions Bun bots are commonly authored in that plain Node.js cannot `require()`
 * directly. Graak transpiles these with `bun build` when the project's package manager
 * is Bun, instead of asking the user to pre-build — Bun projects are frequently run straight
 * from `.ts` with no separate build step, unlike npm/pnpm/yarn projects.
 */
exports.BUN_TRANSPILABLE_EXTENSIONS = new Set([".ts", ".tsx", ".jsx", ".mts", ".cts"]);
class BunTranspiler {
    static isAvailable() {
        try {
            (0, node_child_process_1.execFileSync)("bun", ["--version"], { stdio: "ignore", timeout: 5_000 });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Transpiles a Bun-authored entrypoint into plain CommonJS with `bun build`. Local,
     * relative imports are bundled into the single output file; bare package imports
     * (`require("discord.js")`) are kept as `--packages=external` so Graak's own
     * dependency walk resolves them from the real, installed `node_modules` afterward rather
     * than from a bundler's copy — the same packages the project's lockfile pinned.
     *
     * The output is written next to the source file (not a temp directory), because
     * `ProjectCollector.findProjectRoot` walks up from the entrypoint's directory to find
     * `package.json`, and the file must be inside the project tree to be collected.
     */
    static transpile(entrypoint) {
        const dir = (0, node_path_1.dirname)(entrypoint);
        const name = (0, node_path_1.basename)(entrypoint, (0, node_path_1.extname)(entrypoint));
        const outfile = (0, node_path_1.join)(dir, `${name}.graak-build.cjs`);
        try {
            (0, node_child_process_1.execFileSync)("bun", ["build", entrypoint, "--target=node", "--format=cjs", "--packages=external", `--outfile=${outfile}`], { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
        }
        catch (err) {
            try {
                (0, node_fs_1.unlinkSync)(outfile);
            }
            catch {
                // Nothing was written, or it's already gone
            }
            const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "";
            throw new structures_1.ProjectError(`'bun build' failed to transpile '${entrypoint}':\n${(stderr || (err instanceof Error ? err.message : String(err))).trim()}`);
        }
        if (!(0, node_fs_1.existsSync)(outfile)) {
            throw new structures_1.ProjectError(`'bun build' did not produce an output file for '${entrypoint}'`);
        }
        let cleaned = false;
        return {
            entrypoint: outfile,
            cleanup: () => {
                if (cleaned)
                    return;
                cleaned = true;
                try {
                    (0, node_fs_1.unlinkSync)(outfile);
                }
                catch {
                    // Already removed, or never created
                }
            },
        };
    }
}
exports.BunTranspiler = BunTranspiler;
//# sourceMappingURL=BunTranspiler.js.map
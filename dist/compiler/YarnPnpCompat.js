"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.YarnPnpCompat = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const structures_1 = require("../structures");
const ProjectCollector_1 = require("./ProjectCollector");
class YarnPnpCompat {
    static isPnpProject(root) {
        return (0, node_fs_1.existsSync)((0, node_path_1.join)(root, ".pnp.cjs")) || (0, node_fs_1.existsSync)((0, node_path_1.join)(root, ".pnp.js"));
    }
    /**
     * Reads the pinned Yarn release out of `.yarnrc.yml`. A PnP project always has one -- it is
     * how `yarn` on PATH knows which actual Yarn build to run -- so this is more reliable than
     * hoping a compatible `yarn` is separately installed on the build machine.
     */
    static resolveYarnPath(root) {
        const rc = (0, node_path_1.join)(root, ".yarnrc.yml");
        const text = (0, node_fs_1.existsSync)(rc) ? (0, node_fs_1.readFileSync)(rc, "utf-8") : "";
        const match = text.match(/^yarnPath:\s*(.+)$/m);
        if (!match) {
            throw new structures_1.RuntimeError("This is a Yarn Plug'n'Play project, but .yarnrc.yml has no `yarnPath` to run it with. " +
                "Pin one (`yarn set version berry` or `stable`), or set `nodeLinker: node-modules` " +
                "yourself and reinstall to bypass PnP entirely.");
        }
        return match[1].trim().replace(/^["']|["']$/g, "");
    }
    /**
     * Copies `root` to a temp directory and installs it there with the node-modules linker, so
     * the result is a project `ProjectCollector.collect()` already knows how to bundle unchanged.
     */
    static materialize(root, entrypoint, options = {}) {
        const onLog = options.onLog ?? (() => { });
        const excludePaths = options.excludePaths ?? [];
        const yarnPathRel = YarnPnpCompat.resolveYarnPath(root);
        const yarnScript = (0, node_path_1.join)(root, yarnPathRel);
        if (!(0, node_fs_1.existsSync)(yarnScript)) {
            throw new structures_1.RuntimeError(`.yarnrc.yml points 'yarnPath' at '${yarnPathRel}', which does not exist.`);
        }
        const tmp = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "graak-yarn-pnp-"));
        let cleaned = false;
        const cleanup = () => {
            if (cleaned)
                return;
            cleaned = true;
            (0, node_fs_1.rmSync)(tmp, { recursive: true, force: true });
        };
        try {
            onLog("Yarn Plug'n'Play project detected; materializing a node_modules tree with a throwaway " +
                "'yarn install' (nodeLinker overridden for this run only -- the project's own .pnp.cjs, " +
                "lockfile and .yarnrc.yml are never modified)");
            (0, node_fs_1.cpSync)(root, tmp, {
                recursive: true,
                filter: (src) => !["node_modules", ".git"].includes((0, node_path_1.basename)(src)) && !excludePaths.some((p) => (0, ProjectCollector_1.isInside)(src, p)),
            });
            const result = (0, node_child_process_1.spawnSync)(process.execPath, [(0, node_path_1.join)(tmp, yarnPathRel), "install"], {
                cwd: tmp,
                env: {
                    ...process.env,
                    YARN_NODE_LINKER: "node-modules",
                    ...(options.offline ? { YARN_ENABLE_NETWORK: "false" } : {}),
                },
                encoding: "utf-8",
                timeout: 300_000,
            });
            if (result.status !== 0) {
                throw new structures_1.RuntimeError(`Materializing a node_modules tree from the Yarn PnP project failed:\n` +
                    `${(result.stderr || result.stdout || "").trim()}`);
            }
            return { root: tmp, entrypoint: (0, node_path_1.join)(tmp, (0, node_path_1.relative)(root, entrypoint)), cleanup };
        }
        catch (err) {
            cleanup();
            throw err;
        }
    }
}
exports.YarnPnpCompat = YarnPnpCompat;
//# sourceMappingURL=YarnPnpCompat.js.map
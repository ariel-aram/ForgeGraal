"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeaPackager = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const launcher_1 = require("../runtime/launcher");
const structures_1 = require("../structures");
const NodeRuntime_1 = require("./NodeRuntime");
class SeaPackager {
    /**
     * The SEA configuration consumed by `node --experimental-sea-config`.
     * Snapshots and code cache are disabled because they are only valid for the exact
     * platform and binary that generated them, which breaks cross compilation.
     */
    static createConfig(main, blob, assets = {}) {
        return {
            main,
            output: blob,
            disableExperimentalSEAWarning: true,
            useSnapshot: false,
            useCodeCache: false,
            assets,
        };
    }
    static async build(options) {
        const meta = (0, structures_1.getTargetMetadata)(options.target);
        if (!meta)
            throw new structures_1.RuntimeError(`Unknown target '${options.target}'`);
        const runtime = (0, node_fs_1.readFileSync)(options.runtimeBinary);
        const fuse = NodeRuntime_1.NodeRuntime.seaFuseState(runtime);
        if (fuse === "absent") {
            throw new structures_1.RuntimeError(`'${options.runtimeBinary}' was built without Single Executable Application support.`);
        }
        if (fuse === "injected") {
            throw new structures_1.RuntimeError(`'${options.runtimeBinary}' is already a Single Executable Application.`);
        }
        const warnings = [];
        const work = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "forgegraal-sea-"));
        const partial = `${options.outputPath}.${process.pid}.partial`;
        try {
            const mainPath = (0, node_path_1.join)(work, "boot.cjs");
            const archivePath = (0, node_path_1.join)(work, launcher_1.SEA_ASSET_NAME);
            const blobPath = (0, node_path_1.join)(work, "sea-prep.blob");
            const configPath = (0, node_path_1.join)(work, "sea-config.json");
            (0, node_fs_1.writeFileSync)(mainPath, options.launcherSource);
            (0, node_fs_1.writeFileSync)(archivePath, options.archive);
            (0, node_fs_1.writeFileSync)(configPath, JSON.stringify(SeaPackager.createConfig(mainPath, blobPath, {
                [launcher_1.SEA_ASSET_NAME]: archivePath,
            })));
            (0, node_child_process_1.execFileSync)(options.generatorBinary, ["--experimental-sea-config", configPath], {
                cwd: work,
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 10 * 60_000,
            });
            (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(options.outputPath), { recursive: true });
            (0, node_fs_1.copyFileSync)(options.runtimeBinary, partial);
            (0, node_fs_1.chmodSync)(partial, 0o755);
            const isMac = meta.nodePlatform === "darwin";
            if (isMac && process.platform === "darwin") {
                (0, node_child_process_1.execFileSync)("codesign", ["--remove-signature", partial]);
            }
            // postject ships as CommonJS with a lazily loaded WebAssembly module
            const { inject } = require("postject");
            await inject(partial, "NODE_SEA_BLOB", (0, node_fs_1.readFileSync)(blobPath), {
                sentinelFuse: NodeRuntime_1.SEA_FUSE,
                machoSegmentName: isMac ? "NODE_SEA" : undefined,
            });
            if (isMac) {
                if (process.platform === "darwin") {
                    (0, node_child_process_1.execFileSync)("codesign", ["--sign", "-", partial]);
                }
                else {
                    warnings.push("macOS refuses unsigned modified binaries: run `codesign --sign - <binary>` on a Mac before distributing.");
                }
            }
            if (meta.nodePlatform === "win32") {
                warnings.push("The embedded node.exe Authenticode signature is invalidated by injection; re-sign the executable if you distribute it.");
            }
            (0, node_fs_1.renameSync)(partial, options.outputPath);
            return {
                outputPath: options.outputPath,
                sizeBytes: (0, node_fs_1.statSync)(options.outputPath).size,
                warnings,
            };
        }
        catch (err) {
            (0, node_fs_1.rmSync)(partial, { force: true });
            if (err && typeof err === "object" && "stderr" in err && err.stderr) {
                throw new structures_1.RuntimeError(`SEA blob generation failed: ${String(err.stderr).trim()}`);
            }
            throw err;
        }
        finally {
            (0, node_fs_1.rmSync)(work, { recursive: true, force: true });
        }
    }
}
exports.SeaPackager = SeaPackager;
//# sourceMappingURL=SeaPackager.js.map
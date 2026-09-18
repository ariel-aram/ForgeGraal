"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortablePackager = exports.BUNDLE_MARKER = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const launcher_1 = require("../runtime/launcher");
const structures_1 = require("../structures");
exports.BUNDLE_MARKER = ".forgegraal-bundle";
class PortablePackager {
    static windowsLauncher() {
        return [
            "@echo off",
            "setlocal",
            'set "FORGEGRAAL_DIR=%~dp0"',
            `if exist "%FORGEGRAAL_DIR%node.exe" goto bundled`,
            "where node >nul 2>nul",
            "if errorlevel 1 goto missing",
            `node "%FORGEGRAAL_DIR%${launcher_1.PORTABLE_LAUNCHER_NAME}" %*`,
            "exit /b %ERRORLEVEL%",
            ":bundled",
            `"%FORGEGRAAL_DIR%node.exe" "%FORGEGRAAL_DIR%${launcher_1.PORTABLE_LAUNCHER_NAME}" %*`,
            "exit /b %ERRORLEVEL%",
            ":missing",
            "echo [ForgeGraal] Node.js was not found. Place node.exe next to this file or install Node.js. 1>&2",
            "exit /b 127",
            "",
        ].join("\r\n");
    }
    static unixLauncher(runtimeHint) {
        const hint = runtimeHint.replace(/[`"$\\]/g, "\\$&");
        return [
            "#!/bin/sh",
            'FORGEGRAAL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1',
            'if [ -x "$FORGEGRAAL_DIR/node" ]; then',
            `  exec "$FORGEGRAAL_DIR/node" "$FORGEGRAAL_DIR/${launcher_1.PORTABLE_LAUNCHER_NAME}" "$@"`,
            "fi",
            "if command -v node >/dev/null 2>&1; then",
            `  exec node "$FORGEGRAAL_DIR/${launcher_1.PORTABLE_LAUNCHER_NAME}" "$@"`,
            "fi",
            `echo "[ForgeGraal] Node.js was not found. ${hint}" >&2`,
            "exit 127",
            "",
        ].join("\n");
    }
    static build(options) {
        const meta = (0, structures_1.getTargetMetadata)(options.target);
        if (!meta)
            throw new structures_1.RuntimeError(`Unknown target '${options.target}'`);
        const out = options.outputPath;
        if ((0, node_fs_1.existsSync)(out)) {
            if (!(0, node_fs_1.statSync)(out).isDirectory()) {
                throw new structures_1.ProjectError(`Portable output '${out}' exists and is not a directory`);
            }
            if ((0, node_fs_1.readdirSync)(out).length > 0 && !(0, node_fs_1.existsSync)((0, node_path_1.join)(out, exports.BUNDLE_MARKER))) {
                throw new structures_1.ProjectError(`Refusing to write into non-empty directory '${out}' that is not a ForgeGraal bundle`);
            }
        }
        (0, node_fs_1.mkdirSync)(out, { recursive: true });
        const isWindows = meta.nodePlatform === "win32";
        const warnings = [];
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(out, exports.BUNDLE_MARKER), `${options.target}\n`);
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(out, launcher_1.PORTABLE_ARCHIVE_NAME), options.archive);
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(out, launcher_1.PORTABLE_LAUNCHER_NAME), options.launcherSource);
        let launcherPath;
        if (isWindows) {
            launcherPath = (0, node_path_1.join)(out, `${options.name}.cmd`);
            (0, node_fs_1.writeFileSync)(launcherPath, PortablePackager.windowsLauncher());
        }
        else {
            launcherPath = (0, node_path_1.join)(out, options.name);
            (0, node_fs_1.writeFileSync)(launcherPath, PortablePackager.unixLauncher(meta.runtimeHint));
            (0, node_fs_1.chmodSync)(launcherPath, 0o755);
        }
        let sizeBytes = options.archive.length + Buffer.byteLength(options.launcherSource);
        if (options.runtimeBinary) {
            const runtimeDest = (0, node_path_1.join)(out, isWindows ? "node.exe" : "node");
            (0, node_fs_1.copyFileSync)(options.runtimeBinary, runtimeDest);
            if (!isWindows)
                (0, node_fs_1.chmodSync)(runtimeDest, 0o755);
            sizeBytes += (0, node_fs_1.statSync)(runtimeDest).size;
        }
        else {
            warnings.push(`No Node.js runtime bundled for ${meta.name}; the launcher uses the node found on PATH. ` +
                (meta.officialNodeFile ? "Build without --offline or pass --node-binary to bundle one." : meta.runtimeHint));
        }
        return {
            outputPath: out,
            launcherPath,
            sizeBytes,
            bundledRuntime: Boolean(options.runtimeBinary),
            warnings,
        };
    }
}
exports.PortablePackager = PortablePackager;
//# sourceMappingURL=PortablePackager.js.map
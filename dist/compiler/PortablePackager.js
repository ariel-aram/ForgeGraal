"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortablePackager = exports.BUNDLE_MARKER = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const launcher_1 = require("../runtime/launcher");
const structures_1 = require("../structures");
/** POSIX single-quoting: safe for the plain identifier-like argv tokens bootstrap commands use. */
function shQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
exports.BUNDLE_MARKER = ".graak-bundle";
class PortablePackager {
    static windowsLauncher() {
        // `where.exe` does not exist on Windows XP, so the PATH search uses the `%~$PATH:i`
        // expansion of a for-loop variable, which every cmd.exe since NT 4 understands.
        return [
            "@echo off",
            "setlocal",
            'set "GRAAK_DIR=%~dp0"',
            'if exist "%GRAAK_DIR%node.exe" goto bundled',
            'set "GRAAK_NODE="',
            'for %%i in (node.exe) do @if not "%%~$PATH:i"=="" set "GRAAK_NODE=%%~$PATH:i"',
            "if not defined GRAAK_NODE goto missing",
            `"%GRAAK_NODE%" "%GRAAK_DIR%${launcher_1.PORTABLE_LAUNCHER_NAME}" %*`,
            "exit /b %ERRORLEVEL%",
            ":bundled",
            `"%GRAAK_DIR%node.exe" "%GRAAK_DIR%${launcher_1.PORTABLE_LAUNCHER_NAME}" %*`,
            "exit /b %ERRORLEVEL%",
            ":missing",
            "echo [Graak] Node.js was not found. Place node.exe next to this file or install Node.js. 1>&2",
            "exit /b 127",
            "",
        ].join("\r\n");
    }
    /**
     * When `bootstrapInstall` is set (iSH's `apk`, FreeBSD's `pkg`), the launcher runs it
     * itself instead of just telling the user to — the device already has a real package
     * manager that ships a real Node.js build for its own platform, so there is nothing to
     * hunt down or verify a checksum for. Announced on stderr before it runs, since it does
     * modify the system; not silent.
     */
    static unixLauncher(meta) {
        const lines = [
            "#!/bin/sh",
            'GRAAK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1',
            'if [ -x "$GRAAK_DIR/node" ]; then',
            `  exec "$GRAAK_DIR/node" "$GRAAK_DIR/${launcher_1.PORTABLE_LAUNCHER_NAME}" "$@"`,
            "fi",
            "if command -v node >/dev/null 2>&1; then",
            `  exec node "$GRAAK_DIR/${launcher_1.PORTABLE_LAUNCHER_NAME}" "$@"`,
            "fi",
        ];
        if (meta.bootstrapInstall) {
            const { command, description } = meta.bootstrapInstall;
            const quoted = command.map(shQuote).join(" ");
            lines.push(`echo "[Graak] Node.js was not found; installing ${description} (${quoted})..." >&2`, `if ${quoted} >&2; then`, "  if command -v node >/dev/null 2>&1; then", `    exec node "$GRAAK_DIR/${launcher_1.PORTABLE_LAUNCHER_NAME}" "$@"`, "  fi", "fi", `echo "[Graak] Automatic install failed, or node is still not on PATH. Run manually: ${quoted}" >&2`);
        }
        else {
            const hint = meta.runtimeHint.replace(/[`"$\\]/g, "\\$&");
            lines.push(`echo "[Graak] Node.js was not found. ${hint}" >&2`);
        }
        lines.push("exit 127", "");
        return lines.join("\n");
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
                throw new structures_1.ProjectError(`Refusing to write into non-empty directory '${out}' that is not a Graak bundle`);
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
            (0, node_fs_1.writeFileSync)(launcherPath, PortablePackager.unixLauncher(meta));
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
        else if (meta.bootstrapInstall) {
            // Expected, not degraded: the launcher installs a real, current build for its own
            // platform on first run (see unixLauncher), so there is nothing to bundle.
        }
        else {
            warnings.push(`No Node.js runtime bundled for ${meta.name}; the launcher uses the node found on PATH. ` +
                (meta.officialNodeFile || meta.pinnedLegacyNode
                    ? "Build without --offline or pass --node-binary to bundle one."
                    : meta.runtimeHint));
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
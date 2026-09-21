"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DenoProject = exports.DENO_COMPILE_TARGETS = exports.DENO_CONFIG_FILES = void 0;
exports.parseJsonc = parseJsonc;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const structures_1 = require("../structures");
/**
 * What Graak knows about a Deno project without running Deno: where its configuration is, what
 * that configuration says, and which targets `deno compile` can build by itself (the rest is
 * what Graak is for, the same division of labour as with Bun).
 */
exports.DENO_CONFIG_FILES = ["deno.json", "deno.jsonc"];
/**
 * Targets `deno compile --target` accepts, keyed by the Graak target that runs the same executable.
 * Deno itself needs a 64-bit Linux, macOS or Windows 10+ machine, so it cannot make anything for
 * Windows XP, Vista or 7, 32-bit systems, ARMv7, FreeBSD or iSH: those are Graak's.
 */
exports.DENO_COMPILE_TARGETS = {
    [structures_1.TargetDevice.LinuxModernX64]: "x86_64-unknown-linux-gnu",
    [structures_1.TargetDevice.LinuxModernArm64]: "aarch64-unknown-linux-gnu",
    [structures_1.TargetDevice.WinModernX64]: "x86_64-pc-windows-msvc",
    [structures_1.TargetDevice.DarwinX64]: "x86_64-apple-darwin",
    [structures_1.TargetDevice.DarwinArm64]: "aarch64-apple-darwin",
};
/** Strips comments and trailing commas: deno.jsonc is JSON with both. String contents are left alone. */
function parseJsonc(text) {
    let out = "";
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"')
                j += text[j] === "\\" ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
        }
        else if (c === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n")
                i++;
        }
        else if (c === "/" && text[i + 1] === "*") {
            const end = text.indexOf("*/", i + 2);
            i = end === -1 ? text.length : end + 2;
        }
        else {
            out += c;
            i++;
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1").replace(/^﻿/, ""));
}
function stringRecord(value) {
    const out = {};
    if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value))
            if (typeof v === "string")
                out[k] = v;
    }
    return out;
}
class DenoProject {
    /** The closest deno.json(c) at or above `start`, or null. */
    static findConfig(start) {
        let dir = start;
        for (;;) {
            for (const name of exports.DENO_CONFIG_FILES)
                if ((0, node_fs_1.existsSync)((0, node_path_1.join)(dir, name)))
                    return (0, node_path_1.join)(dir, name);
            const parent = (0, node_path_1.dirname)(dir);
            if (parent === dir)
                return null;
            dir = parent;
        }
    }
    /** Whether `root` is a Deno project: it has a deno.json(c) or a deno.lock. */
    static isDenoProject(root) {
        return (0, node_fs_1.existsSync)((0, node_path_1.join)(root, "deno.lock")) || exports.DENO_CONFIG_FILES.some((name) => (0, node_fs_1.existsSync)((0, node_path_1.join)(root, name)));
    }
    static readConfig(path) {
        const raw = parseJsonc((0, node_fs_1.readFileSync)(path, "utf-8"));
        const scopes = {};
        if (raw.scopes && typeof raw.scopes === "object") {
            for (const [scope, map] of Object.entries(raw.scopes))
                scopes[scope] = stringRecord(map);
        }
        const workspace = Array.isArray(raw.workspace)
            ? raw.workspace.filter((w) => typeof w === "string")
            : Array.isArray(raw.workspace?.members)
                ? raw.workspace.members.filter((w) => typeof w === "string")
                : [];
        return {
            path,
            dir: (0, node_path_1.dirname)(path),
            name: typeof raw.name === "string" ? raw.name : undefined,
            version: typeof raw.version === "string" ? raw.version : undefined,
            imports: stringRecord(raw.imports),
            scopes,
            nodeModulesDir: raw.nodeModulesDir,
            compilerOptions: raw.compilerOptions && typeof raw.compilerOptions === "object"
                ? raw.compilerOptions
                : {},
            tasks: stringRecord(raw.tasks),
            workspace,
            raw,
        };
    }
    /** Whether `deno compile` builds this target itself. */
    static canDenoCompile(target) {
        return target in exports.DENO_COMPILE_TARGETS;
    }
    /** The `--target` value for `deno compile`, or null where only Graak can build the target. */
    static denoTarget(target) {
        return exports.DENO_COMPILE_TARGETS[target] ?? null;
    }
}
exports.DenoProject = DenoProject;
//# sourceMappingURL=DenoProject.js.map
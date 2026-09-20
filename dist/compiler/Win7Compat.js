"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Win7Compat = exports.WIN7_FUNCTION_RENAMES = exports.WIN7_DLL_RENAMES = void 0;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const structures_1 = require("../structures");
const NodeRuntime_1 = require("./NodeRuntime");
/**
 * What api-ms-win-core-synch-l1-2-0.dll exports besides the three functions Windows 7 truly lacks: plain
 * kernel32 synchronisation, which fgsynch.dll forwards (see quickjs/native/win-compat/fgsynch.def). A
 * linker that imports the whole API set (mingw does) puts these in the same descriptor as WaitOnAddress.
 */
const SYNCH_FORWARDED = [
    "AcquireSRWLockExclusive",
    "AcquireSRWLockShared",
    "CreateEventA",
    "CreateEventExA",
    "CreateEventExW",
    "CreateEventW",
    "CreateMutexA",
    "CreateMutexExA",
    "CreateMutexExW",
    "CreateMutexW",
    "CreateSemaphoreExW",
    "CreateSemaphoreW",
    "CreateWaitableTimerExW",
    "CreateWaitableTimerW",
    "DeleteCriticalSection",
    "EnterCriticalSection",
    "InitOnceBeginInitialize",
    "InitOnceComplete",
    "InitOnceExecuteOnce",
    "InitializeConditionVariable",
    "InitializeCriticalSection",
    "InitializeCriticalSectionAndSpinCount",
    "InitializeCriticalSectionEx",
    "InitializeSRWLock",
    "LeaveCriticalSection",
    "OpenEventA",
    "OpenEventW",
    "OpenMutexW",
    "OpenSemaphoreW",
    "OpenWaitableTimerW",
    "ReleaseMutex",
    "ReleaseSRWLockExclusive",
    "ReleaseSRWLockShared",
    "ReleaseSemaphore",
    "ResetEvent",
    "SetCriticalSectionSpinCount",
    "SetEvent",
    "SetWaitableTimer",
    "SetWaitableTimerEx",
    "SignalObjectAndWait",
    "Sleep",
    "SleepConditionVariableCS",
    "SleepConditionVariableSRW",
    "SleepEx",
    "TryAcquireSRWLockExclusive",
    "TryAcquireSRWLockShared",
    "TryEnterCriticalSection",
    "WaitForMultipleObjectsEx",
    "WaitForSingleObject",
    "WaitForSingleObjectEx",
    "WakeAllConditionVariable",
    "WakeConditionVariable",
];
exports.WIN7_DLL_RENAMES = [
    {
        dll: "api-ms-win-core-synch-l1-2-0.dll",
        functions: ["WaitOnAddress", "WakeByAddressSingle", "WakeByAddressAll", ...SYNCH_FORWARDED],
        to: "fgsynch.dll",
    },
    { dll: "bcryptprimitives.dll", functions: ["ProcessPrng"], to: "fgprng.dll" },
];
exports.WIN7_FUNCTION_RENAMES = [
    { dll: "kernel32.dll", from: "GetSystemTimePreciseAsFileTime", to: "GetSystemTimeAsFileTime" },
];
/** Compatibility DLLs each rename brings along. */
const SHIM_FOR_DLL = new Map(exports.WIN7_DLL_RENAMES.map((r) => [r.to, r.to]));
/** Reads the import and delay-import tables of a PE32/PE32+ file. Returns null if it is not one. */
function readImports(buf) {
    if (buf.length < 0x100 || buf.readUInt16LE(0) !== 0x5a4d)
        return null;
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x4550)
        return null;
    const sectionCount = buf.readUInt16LE(pe + 6);
    const optionalSize = buf.readUInt16LE(pe + 20);
    const opt = pe + 24;
    const magic = buf.readUInt16LE(opt);
    if (magic !== 0x10b && magic !== 0x20b)
        return null;
    const is64 = magic === 0x20b;
    const ddBase = opt + (is64 ? 112 : 96);
    const sections = [];
    for (let i = 0; i < sectionCount; i++) {
        const s = opt + optionalSize + i * 40;
        sections.push({
            va: buf.readUInt32LE(s + 12),
            size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)),
            raw: buf.readUInt32LE(s + 20),
        });
    }
    const offsetOf = (rva) => {
        for (const s of sections)
            if (rva >= s.va && rva < s.va + s.size)
                return rva - s.va + s.raw;
        return -1;
    };
    const cstring = (offset) => {
        let end = offset;
        while (end < buf.length && buf[end] !== 0)
            end++;
        return { text: buf.toString("latin1", offset, end), length: end - offset };
    };
    const imports = [];
    const descriptorOffsets = [];
    const walk = (rva, delay) => {
        if (!rva)
            return;
        const stride = delay ? 32 : 20;
        for (let d = offsetOf(rva); d >= 0 && d + stride <= buf.length; d += stride) {
            const nameRva = delay ? buf.readUInt32LE(d + 4) : buf.readUInt32LE(d + 12);
            if (!nameRva)
                break;
            const thunkRva = delay ? buf.readUInt32LE(d + 16) : buf.readUInt32LE(d) || buf.readUInt32LE(d + 16);
            const nameOffset = offsetOf(nameRva);
            if (nameOffset < 0)
                break;
            const name = cstring(nameOffset);
            const functions = [];
            const step = is64 ? 8 : 4;
            for (let t = offsetOf(thunkRva); t >= 0 && t + step <= buf.length; t += step) {
                const value = is64 ? buf.readBigUInt64LE(t) : BigInt(buf.readUInt32LE(t));
                if (value === 0n)
                    break;
                const byOrdinal = ((is64 ? value >> 63n : value >> 31n) & 1n) === 1n;
                if (byOrdinal) {
                    functions.push({ name: null, nameOffset: -1, nameLength: 0 });
                    continue;
                }
                const hintName = offsetOf(Number(value & 0x7fffffffn));
                if (hintName < 0)
                    continue;
                const fn = cstring(hintName + 2);
                functions.push({ name: fn.text, nameOffset: hintName + 2, nameLength: fn.length });
            }
            imports.push({ dll: name.text.toLowerCase(), delay, nameOffset, nameLength: name.length, functions });
            descriptorOffsets.push(d);
        }
    };
    walk(buf.readUInt32LE(ddBase + 8), false);
    walk(buf.readUInt32LE(ddBase + 13 * 8), true);
    return { imports, ddBase, descriptorOffsets };
}
/** Imports that exist on Windows 8 or later and are not covered by any rename above. */
const KNOWN_POST_WIN7 = new Set([
    "api-ms-win-core-synch-l1-2-0.dll",
    "api-ms-win-core-synch-l1-2-1.dll",
    "api-ms-win-core-libraryloader-l1-2-0.dll",
    "api-ms-win-core-file-l2-1-1.dll",
    "api-ms-win-core-processthreads-l1-1-2.dll",
    "api-ms-win-core-sysinfo-l1-2-0.dll",
    "api-ms-win-core-sysinfo-l1-2-1.dll",
].map((s) => s.toLowerCase()));
class Win7Compat {
    /**
     * Redirects the imports of a PE file that Windows 7 lacks. Returns null when the file is not a PE or
     * has nothing to change; the input is never modified.
     */
    static patch(input) {
        const parsed = readImports(input);
        if (!parsed)
            return null;
        const buffer = Buffer.from(input);
        const changes = [];
        const shims = new Set();
        const unresolved = [];
        let bound = false;
        parsed.imports.forEach((imp) => {
            const rename = exports.WIN7_DLL_RENAMES.find((r) => r.dll === imp.dll);
            if (rename) {
                const covered = imp.functions.every((f) => f.name !== null && rename.functions.includes(f.name));
                if (!covered) {
                    unresolved.push(`${imp.dll} (imports functions ${rename.to} does not provide)`);
                    return;
                }
                if (Buffer.byteLength(rename.to) > imp.nameLength) {
                    unresolved.push(`${imp.dll} (name too short to rewrite in place)`);
                    return;
                }
                buffer.fill(0, imp.nameOffset, imp.nameOffset + imp.nameLength);
                buffer.write(rename.to, imp.nameOffset, "latin1");
                changes.push(`${imp.dll} -> ${rename.to}`);
                shims.add(rename.to);
                bound = true;
                return;
            }
            for (const fn of imp.functions) {
                const fr = exports.WIN7_FUNCTION_RENAMES.find((r) => r.dll === imp.dll && r.from === fn.name);
                if (!fr)
                    continue;
                if (fr.to.length > fn.nameLength) {
                    unresolved.push(`${imp.dll}!${fr.from} (name too short to rewrite in place)`);
                    continue;
                }
                buffer.fill(0, fn.nameOffset, fn.nameOffset + fn.nameLength);
                buffer.write(fr.to, fn.nameOffset, "latin1");
                changes.push(`${imp.dll}!${fr.from} -> ${fr.to}`);
                bound = true;
            }
            if (KNOWN_POST_WIN7.has(imp.dll))
                unresolved.push(`${imp.dll} (needs Windows 8 or later)`);
        });
        if (!changes.length && !unresolved.length)
            return null;
        if (bound) {
            // A bound-imports table caches the addresses the imports had when it was linked; the loader
            // would trust it and skip binding the names just rewritten.
            buffer.writeUInt32LE(0, parsed.ddBase + 11 * 8);
            buffer.writeUInt32LE(0, parsed.ddBase + 11 * 8 + 4);
            for (const d of parsed.descriptorOffsets) {
                if (!parsed.imports[parsed.descriptorOffsets.indexOf(d)]?.delay)
                    buffer.writeUInt32LE(0, d + 4);
            }
        }
        return { buffer, changes, shims: [...shims], unresolved };
    }
    /** Lower-cased names of the DLLs a PE file imports (empty for anything else). */
    static importedDlls(input) {
        return readImports(input)?.imports.map((i) => i.dll) ?? [];
    }
    /**
     * Whether a PE file needs the Universal C Runtime. Windows 7 has it only with update KB2999226, and it
     * is not a function to reimplement, so the answer decides whether to bundle it app-local or warn.
     */
    static needsUcrt(input) {
        return Win7Compat.importedDlls(input).some((dll) => dll.startsWith("api-ms-win-crt-") || dll === "ucrtbase.dll");
    }
    /** Names of the compatibility DLLs a patched bundle needs. */
    static shimNames() {
        return [...SHIM_FOR_DLL.keys()];
    }
    /**
     * Builds (and caches) the compatibility DLLs for one architecture with quickjs/native/win-compat/.
     * Returns the directory that holds fgsynch.dll and fgprng.dll.
     */
    static ensureShims(arch) {
        const repoRoot = (0, node_path_1.dirname)(require.resolve("../../package.json"));
        const script = (0, node_path_1.join)(repoRoot, "quickjs/native/win-compat/build.sh");
        const hash = (0, node_crypto_1.createHash)("sha256");
        for (const f of ["fgsynch.c", "fgprng.c", "build.sh"])
            hash.update((0, node_fs_1.readFileSync)((0, node_path_1.join)(repoRoot, "quickjs/native/win-compat", f)));
        const current = hash.digest("hex");
        const cacheDir = (0, node_path_1.join)(NodeRuntime_1.NodeRuntime.cacheDir(), "win-compat", arch === "x64" ? "x64" : "x86");
        const stamp = (0, node_path_1.join)(cacheDir, ".source");
        const built = Win7Compat.shimNames().every((n) => (0, node_fs_1.existsSync)((0, node_path_1.join)(cacheDir, n)));
        if (built && (0, node_fs_1.existsSync)(stamp) && (0, node_fs_1.readFileSync)(stamp, "utf-8") === current)
            return cacheDir;
        (0, node_fs_1.mkdirSync)(cacheDir, { recursive: true });
        const res = (0, node_child_process_1.spawnSync)("sh", [script, arch === "x64" ? "x64" : "x86", cacheDir], { encoding: "utf-8" });
        if (res.status !== 0) {
            throw new structures_1.RuntimeError(`Building the Windows 7 compatibility DLLs failed:\n${(res.stderr || res.stdout).trim()}\n` +
                "They need mingw-w64 (apt install mingw-w64).");
        }
        (0, node_fs_1.writeFileSync)(stamp, current);
        return cacheDir;
    }
}
exports.Win7Compat = Win7Compat;
//# sourceMappingURL=Win7Compat.js.map
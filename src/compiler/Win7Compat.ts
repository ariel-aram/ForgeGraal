import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RuntimeError } from "../structures";
import { NodeRuntime } from "./NodeRuntime";
import { Prebuilt } from "./Prebuilt";
import { hasPosixShell, spawnOutput } from "./SpawnOutput";

/**
 * Lets addons built for a newer Windows load on Windows Vista and 7.
 *
 * A native addon is a DLL, and the operating system -- not Graak -- binds its imports when it is
 * loaded. Prebuilt addons are compiled for whatever Windows their authors target, and the Rust ones
 * (@napi-rs/canvas, davey, mediaplex, ...) and libvips reach for a handful of functions Windows 7 does
 * not have. Measured on the real prebuilds of lmdb, better-sqlite3, msgpackr-extract, @napi-rs/canvas,
 * davey, mediaplex and sharp, the entire gap is five functions:
 *
 *   api-ms-win-core-synch-l1-2-0.dll  WaitOnAddress, WakeByAddressSingle, WakeByAddressAll   (Windows 8)
 *   bcryptprimitives.dll              ProcessPrng                                            (Windows 10)
 *   kernel32.dll                      GetSystemTimePreciseAsFileTime                         (Windows 8)
 *
 * and lmdb, better-sqlite3 and msgpackr-extract need none of them. So instead of giving up on those
 * addons, the bundle is patched at build time: an import that Windows 7 cannot satisfy is pointed at
 * something it can. The edit is in place and never changes a file's layout:
 *
 *   - a whole imported DLL is renamed to one of Graak's compatibility DLLs (`fgsynch.dll`,
 *     `fgprng.dll`, built from quickjs/native/win-compat/), which ships beside the addon -- Windows looks
 *     next to the loaded DLL first;
 *   - a single imported function is renamed to a signature-compatible one the same DLL does have
 *     (GetSystemTimePreciseAsFileTime -> GetSystemTimeAsFileTime: coarser, same contract).
 *
 * Only imports listed here are touched, and only when the descriptor's whole content is covered, so an
 * addon that needs something else still fails with the system's own message rather than a wrong guess.
 * What this cannot supply is a runtime the addon links dynamically -- the Universal C Runtime
 * (api-ms-win-crt-*) that libvips imports is a Windows update on 7, not a function to reimplement.
 */

interface DllRename {
	dll: string;
	/** Every function the descriptor imports must be one of these for the rename to be safe. */
	functions: readonly string[];
	to: string;
}
interface FunctionRename {
	dll: string;
	from: string;
	to: string;
}

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
] as const;

export const WIN7_DLL_RENAMES: readonly DllRename[] = [
	{
		dll: "api-ms-win-core-synch-l1-2-0.dll",
		functions: ["WaitOnAddress", "WakeByAddressSingle", "WakeByAddressAll", ...SYNCH_FORWARDED],
		to: "fgsynch.dll",
	},
	{ dll: "bcryptprimitives.dll", functions: ["ProcessPrng"], to: "fgprng.dll" },
];

export const WIN7_FUNCTION_RENAMES: readonly FunctionRename[] = [
	{ dll: "kernel32.dll", from: "GetSystemTimePreciseAsFileTime", to: "GetSystemTimeAsFileTime" },
];

/** Compatibility DLLs each rename brings along. */
const SHIM_FOR_DLL = new Map(WIN7_DLL_RENAMES.map((r) => [r.to, r.to]));

interface PeImport {
	dll: string;
	delay: boolean;
	/** File offset of the DLL name string, and how many bytes are available for it. */
	nameOffset: number;
	nameLength: number;
	functions: Array<{ name: string | null; nameOffset: number; nameLength: number }>;
}

/** Reads the import and delay-import tables of a PE32/PE32+ file. Returns null if it is not one. */
function readImports(buf: Buffer): { imports: PeImport[]; ddBase: number; descriptorOffsets: number[] } | null {
	if (buf.length < 0x100 || buf.readUInt16LE(0) !== 0x5a4d) return null;
	const pe = buf.readUInt32LE(0x3c);
	if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x4550) return null;
	const sectionCount = buf.readUInt16LE(pe + 6);
	const optionalSize = buf.readUInt16LE(pe + 20);
	const opt = pe + 24;
	const magic = buf.readUInt16LE(opt);
	if (magic !== 0x10b && magic !== 0x20b) return null;
	const is64 = magic === 0x20b;
	const ddBase = opt + (is64 ? 112 : 96);
	const sections: Array<{ va: number; size: number; raw: number }> = [];
	for (let i = 0; i < sectionCount; i++) {
		const s = opt + optionalSize + i * 40;
		sections.push({
			va: buf.readUInt32LE(s + 12),
			size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)),
			raw: buf.readUInt32LE(s + 20),
		});
	}
	const offsetOf = (rva: number): number => {
		for (const s of sections) if (rva >= s.va && rva < s.va + s.size) return rva - s.va + s.raw;
		return -1;
	};
	const cstring = (offset: number): { text: string; length: number } => {
		let end = offset;
		while (end < buf.length && buf[end] !== 0) end++;
		return { text: buf.toString("latin1", offset, end), length: end - offset };
	};

	const imports: PeImport[] = [];
	const descriptorOffsets: number[] = [];
	const walk = (rva: number, delay: boolean) => {
		if (!rva) return;
		const stride = delay ? 32 : 20;
		for (let d = offsetOf(rva); d >= 0 && d + stride <= buf.length; d += stride) {
			const nameRva = delay ? buf.readUInt32LE(d + 4) : buf.readUInt32LE(d + 12);
			if (!nameRva) break;
			const thunkRva = delay ? buf.readUInt32LE(d + 16) : buf.readUInt32LE(d) || buf.readUInt32LE(d + 16);
			const nameOffset = offsetOf(nameRva);
			if (nameOffset < 0) break;
			const name = cstring(nameOffset);
			const functions: PeImport["functions"] = [];
			const step = is64 ? 8 : 4;
			for (let t = offsetOf(thunkRva); t >= 0 && t + step <= buf.length; t += step) {
				const value = is64 ? buf.readBigUInt64LE(t) : BigInt(buf.readUInt32LE(t));
				if (value === 0n) break;
				const byOrdinal = ((is64 ? value >> 63n : value >> 31n) & 1n) === 1n;
				if (byOrdinal) {
					functions.push({ name: null, nameOffset: -1, nameLength: 0 });
					continue;
				}
				const hintName = offsetOf(Number(value & 0x7fffffffn));
				if (hintName < 0) continue;
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

export interface Win7PatchResult {
	/** The patched file. */
	buffer: Buffer;
	/** Human-readable list of what was redirected. */
	changes: string[];
	/** Compatibility DLLs that must ship beside the patched file. */
	shims: string[];
	/** Imports Windows 7 cannot satisfy that nothing here replaces. */
	unresolved: string[];
}

/** Imports that exist on Windows 8 or later and are not covered by any rename above. */
const KNOWN_POST_WIN7 = new Set(
	[
		"api-ms-win-core-synch-l1-2-0.dll",
		"api-ms-win-core-synch-l1-2-1.dll",
		"api-ms-win-core-libraryloader-l1-2-0.dll",
		"api-ms-win-core-file-l2-1-1.dll",
		"api-ms-win-core-processthreads-l1-1-2.dll",
		"api-ms-win-core-sysinfo-l1-2-0.dll",
		"api-ms-win-core-sysinfo-l1-2-1.dll",
	].map((s) => s.toLowerCase())
);

export class Win7Compat {
	/**
	 * Redirects the imports of a PE file that Windows 7 lacks. Returns null when the file is not a PE or
	 * has nothing to change; the input is never modified.
	 */
	public static patch(input: Buffer): Win7PatchResult | null {
		const parsed = readImports(input);
		if (!parsed) return null;
		const buffer = Buffer.from(input);
		const changes: string[] = [];
		const shims = new Set<string>();
		const unresolved: string[] = [];
		let bound = false;

		parsed.imports.forEach((imp) => {
			const rename = WIN7_DLL_RENAMES.find((r) => r.dll === imp.dll);
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
				const fr = WIN7_FUNCTION_RENAMES.find((r) => r.dll === imp.dll && r.from === fn.name);
				if (!fr) continue;
				if (fr.to.length > fn.nameLength) {
					unresolved.push(`${imp.dll}!${fr.from} (name too short to rewrite in place)`);
					continue;
				}
				buffer.fill(0, fn.nameOffset, fn.nameOffset + fn.nameLength);
				buffer.write(fr.to, fn.nameOffset, "latin1");
				changes.push(`${imp.dll}!${fr.from} -> ${fr.to}`);
				bound = true;
			}
			if (KNOWN_POST_WIN7.has(imp.dll)) unresolved.push(`${imp.dll} (needs Windows 8 or later)`);
		});

		if (!changes.length && !unresolved.length) return null;
		if (bound) {
			// A bound-imports table caches the addresses the imports had when it was linked; the loader
			// would trust it and skip binding the names just rewritten.
			buffer.writeUInt32LE(0, parsed.ddBase + 11 * 8);
			buffer.writeUInt32LE(0, parsed.ddBase + 11 * 8 + 4);
			for (const d of parsed.descriptorOffsets) {
				if (!parsed.imports[parsed.descriptorOffsets.indexOf(d)]?.delay) buffer.writeUInt32LE(0, d + 4);
			}
		}
		return { buffer, changes, shims: [...shims], unresolved };
	}

	/** Lower-cased names of the DLLs a PE file imports (empty for anything else). */
	public static importedDlls(input: Buffer): string[] {
		return readImports(input)?.imports.map((i) => i.dll) ?? [];
	}

	/**
	 * Whether a PE file needs the Universal C Runtime. Windows 7 has it only with update KB2999226, and it
	 * is not a function to reimplement, so the answer decides whether to bundle it app-local or warn.
	 */
	public static needsUcrt(input: Buffer): boolean {
		return Win7Compat.importedDlls(input).some((dll) => dll.startsWith("api-ms-win-crt-") || dll === "ucrtbase.dll");
	}

	/** Names of the compatibility DLLs a patched bundle needs. */
	public static shimNames(): string[] {
		return [...SHIM_FOR_DLL.keys()];
	}

	/** Digest of the sources the compatibility DLLs are built from (line endings do not count). */
	public static shimSourceHash(repoRoot: string): string {
		return Prebuilt.digest(
			["fgsynch.c", "fgprng.c", "fgsynch.def", "build.sh"].map(
				(f) => [f, join(repoRoot, "quickjs/native/win-compat", f)] as const
			)
		);
	}

	/**
	 * Returns the directory that holds `fgsynch.dll` and `fgprng.dll` for one architecture: the cache, else
	 * the copy that ships with Graak (`quickjs/prebuilt/win-compat/`), else a fresh build with
	 * quickjs/native/win-compat/, which needs a POSIX shell and mingw-w64.
	 */
	public static ensureShims(arch: "x64" | "ia32"): string {
		const repoRoot = dirname(require.resolve("../../package.json"));
		const folder = arch === "x64" ? "x64" : "x86";
		const current = Win7Compat.shimSourceHash(repoRoot);
		const upToDate = (dir: string) =>
			Win7Compat.shimNames().every((n) => existsSync(join(dir, n))) &&
			existsSync(join(dir, ".source")) &&
			readFileSync(join(dir, ".source"), "utf-8") === current;

		const shipped = join(repoRoot, "quickjs/prebuilt/win-compat", folder);
		if (upToDate(shipped)) return shipped;
		const cacheDir = join(NodeRuntime.cacheDir(), "win-compat", folder);
		if (upToDate(cacheDir)) return cacheDir;

		if (!hasPosixShell()) {
			throw new RuntimeError(
				"The Windows 7 compatibility DLLs have to be built here, which needs a POSIX shell and mingw-w64, and this machine " +
					"has no `sh`. Graak ships them prebuilt (quickjs/prebuilt/win-compat), but those do not match this checkout's " +
					"sources. Reinstall Graak from its published package or a clean checkout, or run the build from WSL or Git Bash."
			);
		}
		mkdirSync(cacheDir, { recursive: true });
		const script = join(repoRoot, "quickjs/native/win-compat/build.sh");
		const res = spawnSync("sh", [script, folder, cacheDir], { encoding: "utf-8" });
		if (res.status !== 0) {
			throw new RuntimeError(
				`Building the Windows 7 compatibility DLLs failed:\n${spawnOutput(res)}\n` +
					"They need mingw-w64 (apt install mingw-w64)."
			);
		}
		writeFileSync(join(cacheDir, ".source"), current);
		return cacheDir;
	}
}

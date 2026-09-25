import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The libuv subset the Windows hosts export to native addons (quickjs/native/fg_uv.c). The addon is a real DLL that
// imports libuv by name from the executable that loads it, as an addon imports it from node.exe; the executable stands
// in for the host, linking fg_uv.c and pumping the default loop the way napi.c does.
const gcc = "i686-w64-mingw32-gcc";
const objdump = "i686-w64-mingw32-objdump";
const mingw = spawnSync(gcc, ["--version"]).status === 0;
const hasWine = spawnSync("docker", ["image", "inspect", "fg-wine"]).status === 0;
const root = process.cwd();
const headerDirs = [join(root, "graak-c-build/libuv/include"), "/usr/include"];
const includeDir = headerDirs.find((d) => existsSync(join(d, "uv/win.h")));

// Windows XP has none of these; the host build script rejects the same list for the XP target.
const POST_XP =
	/InitOnceExecuteOnce|InitializeConditionVariable|WakeConditionVariable|WakeAllConditionVariable|SleepConditionVariableCS|GetTickCount64|InitializeCriticalSectionEx|InitializeSRWLock|AcquireSRWLock|ReleaseSRWLock|BCryptGenRandom|ProcessPrng|WaitOnAddress|GetSystemTimePreciseAsFileTime|GetFinalPathNameByHandleW|GetThreadId\b/;

const variants = [
	{ name: "win-x86", flags: [] as string[] },
	{ name: "win-xp-x86", flags: ["-D_WIN32_WINNT=0x0501", "-DQJS_WINXP_COMPAT"] },
];

function build(dir: string, flags: string[]): void {
	// Only libuv's headers go on the include path: a system /usr/include would drag the host libc in.
	const headers = join(dir, "uvinc");
	mkdirSync(headers);
	cpSync(join(includeDir as string, "uv.h"), join(headers, "uv.h"));
	cpSync(join(includeDir as string, "uv"), join(headers, "uv"), { recursive: true });
	const inc = ["-I", headers];
	const host = spawnSync(
		gcc,
		[
			"-O1",
			"-std=gnu11",
			...flags,
			...inc,
			join(root, "quickjs/native/fg_uv.c"),
			join(root, "test/fixtures/win/uvhost.c"),
			"-o",
			join(dir, "uvhost.exe"),
			`-Wl,--out-implib,${join(dir, "libuvhost.a")}`,
			"-static-libgcc",
		],
		{ encoding: "utf-8" }
	);
	assert.equal(host.status, 0, host.stderr);
	const addon = spawnSync(
		gcc,
		[
			"-shared",
			"-O1",
			...flags,
			...inc,
			join(root, "test/fixtures/win/uvaddon.c"),
			"-o",
			join(dir, "uvaddon.dll"),
			join(dir, "libuvhost.a"),
		],
		{ encoding: "utf-8" }
	);
	assert.equal(addon.status, 0, addon.stderr);
}

for (const variant of variants) {
	test(`the libuv subset binds to an addon and runs (${variant.name}, Wine)`, {
		skip:
			(!mingw && "mingw-w64 (i686) is not installed") ||
			(!includeDir && "libuv headers are not available") ||
			(!hasWine && "no fg-wine Docker image"),
		timeout: 300_000,
	}, () => {
		const dir = mkdtempSync(join(tmpdir(), "graak-uv-"));
		build(dir, variant.flags);

		// Nothing Windows XP lacks may be imported by the host side or by the addon.
		for (const file of ["uvhost.exe", "uvaddon.dll"]) {
			const table = spawnSync(objdump, ["-p", join(dir, file)], { encoding: "utf-8" }).stdout;
			assert.doesNotMatch(table, POST_XP, `${file} imports a post-XP function`);
		}
		// The addon binds its libuv calls to the executable, by name.
		const addonImports = spawnSync(objdump, ["-p", join(dir, "uvaddon.dll")], { encoding: "utf-8" }).stdout;
		assert.match(addonImports, /DLL Name: uvhost\.exe/);
		for (const fn of ["uv_run", "uv_timer_start", "uv_async_send", "uv_queue_work", "uv_fs_open", "uv_rwlock_init"]) {
			assert.match(addonImports, new RegExp(`\\b${fn}\\b`));
		}

		const runOnce = () =>
			spawnSync(
				"docker",
				[
					"run",
					"--rm",
					"-v",
					`${dir}:/w`,
					"-w",
					"/w",
					"-e",
					"WINEDEBUG=-all",
					"-e",
					"WINEPREFIX=/wine",
					"fg-wine",
					"sh",
					"-c",
					"wineboot -u >/dev/null 2>&1; wine uvhost.exe uvaddon.dll",
				],
				{ encoding: "utf-8", timeout: 240_000 }
			);
		// Wine start-up on a machine that is also running the rest of the suite can stall once; a real failure repeats.
		let run = runOnce();
		if (!/ALL OK/.test(run.stdout)) run = runOnce();
		assert.doesNotMatch(run.stdout, /FAIL/, run.stdout + run.stderr);
		assert.match(run.stdout, /pump: live=0/, "the pump is released once nothing referenced is left");
		assert.match(run.stdout, /ALL OK/, run.stdout + run.stderr);
	});
}

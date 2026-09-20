import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BinaryPackager, TargetDevice, WIN7_DLL_RENAMES, Win7Compat } from "../dist/index.js";

const mingw = spawnSync("x86_64-w64-mingw32-gcc", ["--version"]).status === 0;
const hasWine = spawnSync("docker", ["image", "inspect", "fg-wine"]).status === 0;
const fixtures = join(process.cwd(), "test/fixtures/win");

function imports(dll: string): string {
	return spawnSync("x86_64-w64-mingw32-objdump", ["-p", dll], { encoding: "utf-8" }).stdout;
}

function buildFixture(dir: string): string {
	const dll = join(dir, "imports.dll");
	const res = spawnSync(
		"x86_64-w64-mingw32-gcc",
		["-shared", "-O1", "-o", dll, join(fixtures, "imports.c"), "-lsynchronization"],
		{
			encoding: "utf-8",
		}
	);
	assert.equal(res.status, 0, res.stderr);
	return dll;
}

test("Win7Compat redirects exactly the imports Windows 7 lacks, in place", {
	skip: !mingw && "mingw-w64 is not installed",
}, () => {
	const dir = mkdtempSync(join(tmpdir(), "forgegraal-win7-"));
	const dll = buildFixture(dir);
	const original = readFileSync(dll);
	const before = imports(dll);
	assert.match(before, /api-ms-win-core-synch-l1-2-0\.dll/);
	assert.match(before, /GetSystemTimePreciseAsFileTime/);

	const patch = Win7Compat.patch(original);
	assert.ok(patch);
	assert.deepEqual(
		[...patch.changes].sort(),
		[
			"api-ms-win-core-synch-l1-2-0.dll -> fgsynch.dll",
			"kernel32.dll!GetSystemTimePreciseAsFileTime -> GetSystemTimeAsFileTime",
		].sort()
	);
	assert.deepEqual(patch.shims, ["fgsynch.dll"]);
	assert.deepEqual(patch.unresolved, []);
	assert.equal(patch.buffer.length, original.length, "the file layout must not change");
	assert.ok(original.equals(readFileSync(dll)), "the input must not be modified");

	const patched = join(dir, "patched.dll");
	writeFileSync(patched, patch.buffer);
	const after = imports(patched);
	assert.match(after, /DLL Name: fgsynch\.dll/);
	assert.match(after, /GetSystemTimeAsFileTime/);
	assert.doesNotMatch(after, /api-ms-win-core-synch|GetSystemTimePrecise/);
	assert.equal(Win7Compat.patch(patch.buffer), null, "patching twice has nothing left to do");
	assert.equal(Win7Compat.patch(Buffer.from("not a PE file at all, just text".repeat(20))), null);
});

test("Win7Compat leaves a DLL that needs more than the shim provides alone, and says so", () => {
	// A synthetic PE would be laborious; the guard is on the descriptor's contents, which is what
	// makes a rename safe, so it is tested through the exported rule table instead.
	for (const rule of WIN7_DLL_RENAMES) {
		assert.ok(rule.functions.length > 0);
		assert.match(rule.to, /^fg[a-z]+\.dll$/);
	}
});

test("the compatibility DLLs build for both architectures and export what they replace", {
	skip: !mingw && "mingw-w64 is not installed",
}, () => {
	for (const arch of ["x64", "ia32"] as const) {
		const dir = Win7Compat.ensureShims(arch);
		const objdump = arch === "x64" ? "x86_64-w64-mingw32-objdump" : "i686-w64-mingw32-objdump";
		const synch = spawnSync(objdump, ["-p", join(dir, "fgsynch.dll")], { encoding: "utf-8" }).stdout;
		for (const name of ["WaitOnAddress", "WakeByAddressSingle", "WakeByAddressAll"])
			assert.match(synch, new RegExp(`\\b${name}\\b`), `${arch} exports ${name}`);
		assert.match(spawnSync(objdump, ["-p", join(dir, "fgprng.dll")], { encoding: "utf-8" }).stdout, /\bProcessPrng\b/);
	}
});

function wine(dir: string, ...args: string[]) {
	return spawnSync(
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
			`wineboot -u >/dev/null 2>&1; wine ${args.join(" ")}`,
		],
		{ encoding: "utf-8", timeout: 180_000 }
	);
}

// Wine implements the newer functions itself, so it cannot reproduce a Windows 7 load failure; what it
// does prove is that the patched DLL binds to the compatibility DLLs and that their code runs.
test("a patched DLL loads and runs through the compatibility DLLs (Wine)", {
	skip: (!mingw && "mingw-w64 is not installed") || (!hasWine && "no fg-wine Docker image"),
	timeout: 300_000,
}, () => {
	const dir = mkdtempSync(join(tmpdir(), "forgegraal-win7-wine-"));
	const dll = buildFixture(dir);
	const patch = Win7Compat.patch(readFileSync(dll));
	assert.ok(patch);
	writeFileSync(join(dir, "imports.dll"), patch.buffer);
	const harness = spawnSync(
		"x86_64-w64-mingw32-gcc",
		["-O1", "-o", join(dir, "loadtest.exe"), join(fixtures, "loadtest.c")],
		{ encoding: "utf-8" }
	);
	assert.equal(harness.status, 0, harness.stderr);

	const shims = Win7Compat.ensureShims("x64");
	const withoutShim = wine(dir, "loadtest.exe");
	assert.match(withoutShim.stdout, /load failed/, "with the compatibility DLL missing the import cannot bind");

	copyFileSync(join(shims, "fgsynch.dll"), join(dir, "fgsynch.dll"));
	const withShim = wine(dir, "loadtest.exe");
	assert.match(withShim.stdout, /ok/, `${withShim.stdout}${withShim.stderr}`);
});

test("the Windows native host passes the compatibility selftest (Wine)", {
	skip: (!mingw && "mingw-w64 is not installed") || (!hasWine && "no fg-wine Docker image"),
	timeout: 900_000,
}, async () => {
	const { QuickJsPackager, TargetDevice } = await import("../dist/index.js");
	const host = await QuickJsPackager.ensureNativeHost(TargetDevice.WinLegacyX64);
	const dir = mkdtempSync(join(tmpdir(), "forgegraal-winhost-"));
	copyFileSync(host, join(dir, "forgegraal-c.exe"));
	spawnSync("cp", ["-r", join(process.cwd(), "quickjs/runtime"), join(dir, "runtime")]);

	const selftest = wine(
		dir,
		"forgegraal-c.exe",
		"Z:\\\\w\\\\runtime\\\\node-compat.js",
		"Z:\\\\w\\\\runtime\\\\selftest.js"
	);
	assert.match(selftest.stdout, /selftest: (\d+)\/\1 passed/, `${selftest.stdout}${selftest.stderr}`);
});

test("a DLL that needs the Universal C Runtime is flagged, and it ships app-local when given one", {
	skip: !mingw && "mingw-w64 is not installed",
	timeout: 600_000,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "forgegraal-ucrt-"));
	const dll = join(dir, "ucrt.dll");
	const build = spawnSync(
		"x86_64-w64-mingw32-gcc",
		[
			"-shared",
			"-nostartfiles",
			"-nodefaultlibs",
			"-o",
			dll,
			join(fixtures, "ucrt.c"),
			"-lucrtbase",
			"-lkernel32",
			"-Wl,--entry=0",
		],
		{ encoding: "utf-8" }
	);
	assert.equal(build.status, 0, build.stderr);
	assert.equal(Win7Compat.needsUcrt(readFileSync(dll)), true);
	assert.equal(
		Win7Compat.needsUcrt(readFileSync(buildFixture(mkdtempSync(join(tmpdir(), "forgegraal-ucrt-no-"))))),
		false
	);

	const root = mkdtempSync(join(tmpdir(), "forgegraal-ucrt-project-"));
	mkdirSync(join(root, "node_modules/ucrt-fixture"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "bot", dependencies: { "ucrt-fixture": "1" } }));
	writeFileSync(
		join(root, "node_modules/ucrt-fixture/package.json"),
		JSON.stringify({ name: "ucrt-fixture", version: "1.0.0" })
	);
	copyFileSync(dll, join(root, "node_modules/ucrt-fixture/ucrt.dll"));
	writeFileSync(join(root, "index.js"), 'require("ucrt-fixture");');
	const compile = (ucrtDir?: string) =>
		BinaryPackager.compile({
			entrypoint: join(root, "index.js"),
			target: TargetDevice.WinLegacyX64,
			packageManager: "npm",
			offline: true,
			ucrtDir,
		});

	const without = await compile();
	assert.ok(without.warnings.some((w) => /Universal C Runtime.*KB2999226/.test(w)));
	assert.equal(existsSync(join(without.outputPath, "app/node_modules/ucrt-fixture/ucrtbase.dll")), false);

	const redist = mkdtempSync(join(tmpdir(), "forgegraal-redist-"));
	for (const name of ["ucrtbase.dll", "api-ms-win-crt-runtime-l1-1-0.dll", "unrelated.txt"])
		writeFileSync(join(redist, name), "x");
	const withUcrt = await compile(redist);
	assert.ok(existsSync(join(withUcrt.outputPath, "app/node_modules/ucrt-fixture/ucrtbase.dll")));
	assert.ok(existsSync(join(withUcrt.outputPath, "app/node_modules/ucrt-fixture/api-ms-win-crt-runtime-l1-1-0.dll")));
	assert.equal(existsSync(join(withUcrt.outputPath, "app/node_modules/ucrt-fixture/unrelated.txt")), false);
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	addonPackageNames,
	BinaryInspector,
	BinaryPackager,
	classifyNativeAddons,
	QuickJsPackager,
	TargetDevice,
} from "../dist/index.js";

function hasDocker(): boolean {
	try {
		return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 }).status === 0;
	} catch {
		return false;
	}
}

/** Same fixture shape as `createProject()` in compiler.test.ts: nested node_modules must resolve. */
function createProject(): string {
	const root = mkdtempSync(join(tmpdir(), "graak-qjs-project-"));
	mkdirSync(join(root, "node_modules/a"), { recursive: true });
	mkdirSync(join(root, "node_modules/b/node_modules/a"), { recursive: true });
	mkdirSync(join(root, "src/commands"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "qjs-bot", dependencies: { a: "1", b: "1" } }));
	writeFileSync(
		join(root, "src/index.js"),
		`const fs = require("fs");
console.log(JSON.stringify({
	a: require("a"),
	bA: require("b"),
	commands: fs.readdirSync(__dirname + "/commands"),
	target: process.env.GRAAK_TARGET ?? null,
}));`
	);
	writeFileSync(join(root, "src/commands/ping.js"), "module.exports = 1;");
	writeFileSync(join(root, "node_modules/a/package.json"), JSON.stringify({ name: "a", version: "1.0.0" }));
	writeFileSync(join(root, "node_modules/a/index.js"), 'module.exports = "a@1.0.0";');
	writeFileSync(
		join(root, "node_modules/b/package.json"),
		JSON.stringify({ name: "b", version: "1.0.0", dependencies: { a: "2" } })
	);
	writeFileSync(join(root, "node_modules/b/index.js"), 'module.exports = "b uses " + require("a");');
	writeFileSync(
		join(root, "node_modules/b/node_modules/a/package.json"),
		JSON.stringify({ name: "a", version: "2.0.0" })
	);
	writeFileSync(join(root, "node_modules/b/node_modules/a/index.js"), 'module.exports = "a@2.0.0";');
	return root;
}

test("QuickJsPackager.supports covers legacy Windows, iSH/32-bit Linux, and the modern proof target", () => {
	// Default to the native host: everywhere Node.js itself serves this project badly.
	for (const target of [
		TargetDevice.LinuxModernX64,
		TargetDevice.WinXpX86,
		TargetDevice.WinVistaX86,
		TargetDevice.WinVistaX64,
		TargetDevice.WinLegacyX86,
		TargetDevice.WinLegacyX64,
		TargetDevice.IosIshX86,
		TargetDevice.LinuxX86,
	]) {
		assert.equal(QuickJsPackager.supports(target), true, `${target} should default to the native host`);
	}
	// Still on Node.js, deliberately out of scope for this rollout: modern 64-bit targets other
	// than the proof one, and "Android" == LinuxArmV7/LinuxModernArm64, which stay on Node.js with
	// full npm/pnpm/yarn/bun support instead of moving to the native host.
	for (const target of [
		TargetDevice.WinModernX64,
		TargetDevice.WinX86,
		TargetDevice.LinuxArmV7,
		TargetDevice.LinuxModernArm64,
		TargetDevice.DarwinX64,
		TargetDevice.DarwinArm64,
	]) {
		assert.equal(QuickJsPackager.supports(target), false, `${target} should still ship on Node.js`);
	}
});

test("a bot packaged for the Graak native host runs with no Node.js binary anywhere in the output", {
	timeout: 300_000,
}, async () => {
	const root = createProject();
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
	});

	assert.equal(result.strategy, "quickjs");
	assert.equal(result.runtimeVersion, null, "there is no Node.js version to report on this path");

	// The whole point: nothing in the output is Node.js.
	const files = readdirSync(result.outputPath);
	assert.ok(!files.includes("node"), "no Node.js binary must be bundled");
	assert.ok(!files.includes("node.exe"), "no Node.js binary must be bundled");
	assert.ok(files.includes("graak-c"), "the Graak native host must be bundled instead");
	assert.ok(files.includes("runtime"), "node-compat.js/native-modules.js must be bundled");

	// Run it for real: the produced launcher, not node, not the entrypoint directly.
	const output = execFileSync(result.launcherPath, { encoding: "utf-8", timeout: 30_000 });
	const data = JSON.parse(output);
	assert.equal(data.a, "a@1.0.0");
	assert.equal(data.bA, "b uses a@2.0.0");
	assert.deepEqual(data.commands, ["ping.js"]);
});

test("linux-modern-x64 is static musl, not dynamic glibc, and really runs on Alpine", {
	timeout: 300_000,
	skip: hasDocker() ? false : "no docker available to run a real Alpine container",
}, async () => {
	// The gap this closes: build.sh's "native" target links dynamically against the build
	// host's own libc. On this (glibc) machine that produces a binary that fails outright on
	// Alpine -- a very common Docker base for exactly the bot this packages -- with a bare
	// "exec: no such file or directory", the classic symptom of a missing ELF interpreter.
	// linux-modern-x64 must never be that build; it must be the same static musl binary as
	// linux-x86/iSH, just 64-bit.
	const root = createProject();
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
	});

	const bin = join(result.outputPath, "graak-c");
	const ldd = spawnSync("ldd", [bin], { encoding: "utf-8" });
	assert.match(
		`${ldd.stdout}${ldd.stderr}`,
		/statically linked|not a dynamic executable/,
		"the bundled binary must be static, not dynamically linked against the build host's libc"
	);

	// native-selftest.js is deliberately not bundled with a packaged bot (it is a test
	// harness, see RUNTIME_FILES in QuickJsPackager.ts) and imports its sibling
	// native-modules.js relatively, so the whole source directory is mounted here instead.
	const run = spawnSync(
		"docker",
		[
			"run",
			"--rm",
			"--platform",
			"linux/amd64",
			"-v",
			`${bin}:/graak-c:ro`,
			"-v",
			`${join(process.cwd(), "quickjs/runtime")}:/runtime:ro`,
			"alpine:latest",
			"/graak-c",
			"/runtime/node-compat.js",
			"/runtime/native-selftest.js",
		],
		{ encoding: "utf-8", timeout: 60_000 }
	);
	assert.equal(run.status, 0, `graak-c must run on real Alpine (musl):\n${run.stdout}${run.stderr}`);
	assert.match(run.stdout, /tls\.connect status\s+: HTTP\/1\.1 200 OK/, run.stdout);
});

test("--native-libc glibc is an explicit opt-in, dynamically linked and real to run", {
	timeout: 300_000,
}, async () => {
	const root = createProject();
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
		nativeLibc: "glibc",
	});

	assert.equal(result.strategy, "quickjs");
	const bin = join(result.outputPath, "graak-c");
	const ldd = spawnSync("ldd", [bin], { encoding: "utf-8" });
	assert.match(ldd.stdout, /libc\.so\.6/, "an explicit glibc request must actually produce a dynamic glibc binary");

	const output = execFileSync(result.launcherPath, { encoding: "utf-8", timeout: 30_000 });
	const data = JSON.parse(output);
	assert.equal(data.a, "a@1.0.0");
	assert.equal(data.bA, "b uses a@2.0.0");
});

test("--native-libc glibc on a target with no glibc build fails clearly instead of silently falling back", async () => {
	const root = createProject();
	await assert.rejects(
		BinaryPackager.compile({
			entrypoint: join(root, "src/index.js"),
			target: TargetDevice.WinLegacyX86,
			packageManager: "npm",
			offline: true,
			nativeLibc: "glibc",
		}),
		/No glibc native host build exists yet for win-legacy-x86/
	);
});

test("iSH and 32-bit Linux share one static musl binary, and it really runs a bot end to end", {
	timeout: 300_000,
}, async () => {
	// Unlike the Windows targets below, a 32-bit x86 Linux binary runs directly on this (x64)
	// host, so this is executed for real rather than only checked structurally.
	for (const target of [TargetDevice.LinuxX86, TargetDevice.IosIshX86]) {
		const root = createProject();
		const result = await BinaryPackager.compile({
			entrypoint: join(root, "src/index.js"),
			target,
			packageManager: "npm",
			offline: true,
		});

		assert.equal(result.strategy, "quickjs", target);
		const files = readdirSync(result.outputPath);
		assert.ok(!files.includes("node"), `${target}: no Node.js binary must be bundled`);
		assert.ok(files.includes("graak-c"), `${target}: the native host must be bundled instead`);

		const info = BinaryInspector.inspect(join(result.outputPath, "graak-c"));
		assert.ok(info, `${target}: the bundled binary must be a recognizable ELF`);
		assert.ok(
			BinaryInspector.matchesTarget(info, target),
			`${target}: bundled binary is ${info?.format} ${info?.arch}`
		);

		const output = execFileSync(result.launcherPath, { encoding: "utf-8", timeout: 30_000 });
		const data = JSON.parse(output);
		assert.equal(data.a, "a@1.0.0", target);
		assert.equal(data.bA, "b uses a@2.0.0", target);
		assert.deepEqual(data.commands, ["ping.js"], target);
	}
});

test("legacy Windows targets default to the native host, and the bundled binary really matches each one", {
	timeout: 300_000,
}, async () => {
	// Not run: there is no Wine/Windows VM in this sandbox, so the binary is only checked
	// structurally here (right machine type, right bitness) -- same "still unverified on real
	// hardware" caveat the README already carries for these Windows builds.
	for (const target of [
		TargetDevice.WinXpX86,
		TargetDevice.WinVistaX86,
		TargetDevice.WinVistaX64,
		TargetDevice.WinLegacyX86,
		TargetDevice.WinLegacyX64,
	]) {
		const root = createProject();
		const result = await BinaryPackager.compile({
			entrypoint: join(root, "src/index.js"),
			target,
			packageManager: "npm",
			offline: true,
		});

		assert.equal(result.strategy, "quickjs", target);
		const files = readdirSync(result.outputPath);
		assert.ok(!files.includes("node.exe"), `${target}: no Node.js binary must be bundled`);
		assert.ok(files.includes("graak-c.exe"), `${target}: the native host must be bundled instead`);
		assert.ok(files.includes("runtime"), target);

		const info = BinaryInspector.inspect(join(result.outputPath, "graak-c.exe"));
		assert.ok(info, `${target}: the bundled binary must be a recognizable PE`);
		assert.ok(
			BinaryInspector.matchesTarget(info, target),
			`${target}: bundled binary is ${info?.format} ${info?.arch}`
		);
	}
});

function lmdbLikeProject(): string {
	const root = createProject();
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "qjs-bot", dependencies: { a: "1", b: "1", lmdb: "^3" } })
	);
	mkdirSync(join(root, "node_modules/lmdb/build/Release"), { recursive: true });
	writeFileSync(join(root, "node_modules/lmdb/package.json"), JSON.stringify({ name: "lmdb", main: "index.js" }));
	writeFileSync(join(root, "node_modules/lmdb/index.js"), 'module.exports = require("./build/Release/lmdb.node");');
	writeFileSync(join(root, "node_modules/lmdb/build/Release/lmdb.node"), Buffer.from("not a real binary"));
	writeFileSync(join(root, "src/index.js"), 'require("lmdb");');
	return root;
}

test("a bot that needs a native addon gets the dynamically linked host instead of being refused", async () => {
	const root = lmdbLikeProject();
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
	});

	assert.equal(result.strategy, "quickjs");
	assert.ok(result.warnings.some((w) => /dynamically linked glibc host/.test(w)));
	assert.ok(
		existsSync(join(result.outputPath, "app/node_modules/lmdb/build/Release/lmdb.node")),
		"the addon must ship with the bot"
	);
	const ldd = spawnSync("ldd", [join(result.outputPath, "graak-c")], { encoding: "utf-8" });
	assert.match(ldd.stdout, /libc\.so\.6/, "an addon-loading host has to be dynamic, since a static one cannot dlopen");
});

test("--native-libc musl with a native addon explains why it cannot work, rather than building a host that cannot load it", async () => {
	await assert.rejects(
		BinaryPackager.compile({
			entrypoint: join(lmdbLikeProject(), "src/index.js"),
			target: TargetDevice.LinuxModernX64,
			packageManager: "npm",
			nativeLibc: "musl",
			offline: true,
		}),
		/static executable has no dynamic loader/
	);
});

test("32-bit Linux and iSH get the dynamic musl host when an addon needs loading", async () => {
	const result = await BinaryPackager.compile({
		entrypoint: join(lmdbLikeProject(), "src/index.js"),
		target: TargetDevice.IosIshX86,
		packageManager: "npm",
		offline: true,
		allowNativeMismatch: true,
	});
	assert.equal(result.strategy, "quickjs");
	assert.ok(result.warnings.some((w) => /dynamically linked musl host/.test(w)));
	const info = BinaryInspector.inspect(join(result.outputPath, "graak-c"));
	assert.equal(info?.arch, "x86");
	assert.match(
		readFileSync(join(result.outputPath, "graak-c")).toString("latin1"),
		/ld-musl-i386\.so\.1/,
		"it is dynamic, so it can dlopen"
	);
});

const hasGcc = spawnSync("gcc", ["--version"]).status === 0;

test("a real Node-API addon loads and behaves exactly as it does under Node.js", {
	skip: !hasGcc && "gcc is not installed",
	timeout: 300_000,
}, async () => {
	// The addon calls napi_* functions and links against nothing: they resolve from the host at load
	// time, which is precisely the contract the host's Node-API layer has to honour. It covers values,
	// strings, objects, buffers, callbacks, exceptions, wrapped classes, references, BigInt, async work
	// resolving a promise, and a thread-safe function called from a second OS thread.
	const work = mkdtempSync(join(tmpdir(), "graak-napi-"));
	const addon = join(work, "addon.node");
	const build = spawnSync(
		"gcc",
		[
			"-shared",
			"-fPIC",
			"-O1",
			"-I",
			join(process.cwd(), "quickjs/native/include"),
			"-o",
			addon,
			join(process.cwd(), "test/fixtures/napi/addon.c"),
			"-lpthread",
		],
		{ encoding: "utf-8" }
	);
	assert.equal(build.status, 0, build.stderr);

	const root = mkdtempSync(join(tmpdir(), "graak-napi-project-"));
	mkdirSync(join(root, "node_modules/napi-fixture"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "napi-bot", dependencies: { "napi-fixture": "1" } })
	);
	writeFileSync(
		join(root, "node_modules/napi-fixture/package.json"),
		JSON.stringify({ name: "napi-fixture", version: "1.0.0", main: "index.js" })
	);
	writeFileSync(join(root, "node_modules/napi-fixture/index.js"), 'module.exports = require("./addon.node");');
	copyFileSync(addon, join(root, "node_modules/napi-fixture/addon.node"));
	const script = readFileSync(join(process.cwd(), "test/fixtures/napi/run.js"), "utf-8").replace(
		'require("./addon.node")',
		'require("napi-fixture")'
	);
	writeFileSync(join(root, "index.js"), script);

	const expected = spawnSync(process.execPath, [join(root, "index.js")], { cwd: root, encoding: "utf-8" });
	assert.equal(expected.status, 0, `Node baseline failed: ${expected.stderr}`);

	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
	});
	assert.equal(result.strategy, "quickjs");
	assert.equal(
		readdirSync(result.outputPath).some((f) => f === "node" || f === "node.exe"),
		false
	);

	const run = spawnSync(result.launcherPath, [], { cwd: result.outputPath, encoding: "utf-8", timeout: 60_000 });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout.trim(), expected.stdout.trim(), "the host must produce what Node.js produces");
});

test("addon paths map to the package a developer depends on, platform suffix stripped", () => {
	const names = (p: string) => addonPackageNames(p)[0];
	assert.equal(names("node_modules/@lmdb/lmdb-win32-x64/node.napi.node"), "lmdb");
	assert.equal(names("node_modules/mediaplex-win32-x64-msvc/mediaplex.win32-x64-msvc.node"), "mediaplex");
	assert.equal(names("node_modules/@snazzah/davey-win32-x64-msvc/davey.win32-x64-msvc.node"), "@snazzah/davey");
	assert.equal(names("node_modules/bcrypt/lib/binding/bcrypt_lib.node"), "bcrypt");
	assert.equal(names("node_modules/@rollup/rollup-win32-x64-gnu/rollup.win32-x64-gnu.node"), "rollup");
});

test("classifyNativeAddons separates addons a bot needs from optional accelerators", () => {
	const { required, optional } = classifyNativeAddons([
		"node_modules/@lmdb/lmdb-win32-x64/node.napi.node",
		"node_modules/@snazzah/davey-win32-x64-msvc/davey.win32-x64-msvc.node",
		"node_modules/mediaplex-win32-x64-msvc/mediaplex.win32-x64-msvc.node",
		"node_modules/@msgpackr-extract/msgpackr-extract-win32-x64/node.napi.node",
		"node_modules/@msgpackr-extract/msgpackr-extract-win32-x64/node.abi115.node",
	]);
	assert.deepEqual([...required.keys()].sort(), ["@snazzah/davey", "lmdb"]);
	assert.deepEqual([...optional.keys()].sort(), ["mediaplex", "msgpackr-extract"]);
	assert.equal(optional.get("msgpackr-extract")?.length, 2, "both addon files group under one package");
});

test("an optional accelerator's addon warns instead of failing a native-host build", async () => {
	const root = createProject();
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "qjs-bot", dependencies: { a: "1", b: "1", "msgpackr-extract": "^3" } })
	);
	mkdirSync(join(root, "node_modules/msgpackr-extract"), { recursive: true });
	writeFileSync(
		join(root, "node_modules/msgpackr-extract/package.json"),
		JSON.stringify({ name: "msgpackr-extract", main: "index.js" })
	);
	writeFileSync(join(root, "node_modules/msgpackr-extract/index.js"), "module.exports = {};");
	writeFileSync(join(root, "node_modules/msgpackr-extract/node.napi.node"), Buffer.from("not a real binary"));

	const result = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
	});
	assert.equal(result.strategy, "quickjs");
	assert.ok(result.warnings.some((w) => /msgpackr-extract.*fall back to pure JavaScript/.test(w)));
});

const hasMuslGcc = spawnSync("x86_64-linux-musl-gcc", ["--version"]).status === 0;

test("a musl-linked addon gets the dynamic musl host and runs on real Alpine", {
	skip: (!hasGcc && "gcc is not installed") || (!hasMuslGcc && "no musl C compiler") || (!hasDocker() && "no docker"),
	timeout: 600_000,
}, async () => {
	// On Alpine a native addon is a musl-linked shared library, and a static host cannot load it. The
	// addon's own libc decides which dynamic host it gets, so it works there instead of being refused.
	const work = mkdtempSync(join(tmpdir(), "graak-muslnapi-"));
	const addon = join(work, "addon.node");
	const source = join(process.cwd(), "test/fixtures/napi/addon.c");
	const include = join(process.cwd(), "quickjs/native/include");
	const build = spawnSync(
		"x86_64-linux-musl-gcc",
		["-shared", "-fPIC", "-O1", "-I", include, "-o", addon, source, "-lpthread"],
		{ encoding: "utf-8" }
	);
	assert.equal(build.status, 0, build.stderr);

	const root = mkdtempSync(join(tmpdir(), "graak-muslnapi-project-"));
	mkdirSync(join(root, "node_modules/napi-fixture"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "musl-bot", dependencies: { "napi-fixture": "1" } })
	);
	writeFileSync(
		join(root, "node_modules/napi-fixture/package.json"),
		JSON.stringify({ name: "napi-fixture", version: "1.0.0", main: "index.js" })
	);
	writeFileSync(join(root, "node_modules/napi-fixture/index.js"), 'module.exports = require("./addon.node");');
	copyFileSync(addon, join(root, "node_modules/napi-fixture/addon.node"));
	const script = readFileSync(join(process.cwd(), "test/fixtures/napi/run.js"), "utf-8").replace(
		'require("./addon.node")',
		'require("napi-fixture")'
	);
	writeFileSync(join(root, "index.js"), script);

	const glibcAddon = join(work, "oracle.node");
	assert.equal(
		spawnSync("gcc", ["-shared", "-fPIC", "-O1", "-I", include, "-o", glibcAddon, source, "-lpthread"]).status,
		0
	);
	writeFileSync(
		join(work, "oracle.js"),
		readFileSync(join(process.cwd(), "test/fixtures/napi/run.js"), "utf-8").replace("./addon.node", "./oracle.node")
	);
	const expected = spawnSync(process.execPath, [join(work, "oracle.js")], { cwd: work, encoding: "utf-8" });
	assert.equal(expected.status, 0, expected.stderr);

	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
	});
	assert.equal(result.strategy, "quickjs");
	assert.ok(
		result.warnings.some((w) => /dynamically linked musl host/.test(w)),
		result.warnings.join("\n")
	);

	const run = spawnSync(
		"docker",
		[
			"run",
			"--rm",
			"--platform",
			"linux/amd64",
			"-v",
			`${result.outputPath}:/app:ro`,
			"-w",
			"/app",
			"alpine:latest",
			"./graak-c",
			"/app/runtime/node-compat.js",
			"/app/app/index.js",
		],
		{ encoding: "utf-8", timeout: 120_000 }
	);
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout.trim(), expected.stdout.trim());
});

test("QuickJsPackager places package.json at output root and falls back when read from another cwd", async () => {
	const root = mkdtempSync(join(tmpdir(), "graak-pkg-test-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg-bot", version: "3.4.5" }));
	writeFileSync(
		join(root, "index.js"),
		`const fs = require("fs");
const path = require("path");
const p1 = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
const p2 = JSON.parse(fs.readFileSync("package.json", "utf8"));
console.log(JSON.stringify({ v1: p1.version, v2: p2.version }));`
	);

	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
	});

	assert.equal(existsSync(join(result.outputPath, "package.json")), true);

	// 1. Run with cwd = outputPath (user in the dist directory)
	const runFromOut = spawnSync(result.launcherPath, [], {
		cwd: result.outputPath,
		encoding: "utf-8",
		timeout: 30_000,
	});
	assert.equal(runFromOut.status, 0, runFromOut.stderr);
	const data1 = JSON.parse(runFromOut.stdout);
	assert.equal(data1.v1, "3.4.5");
	assert.equal(data1.v2, "3.4.5");

	// 2. Run with cwd = an empty outside dir without package.json (fallback test)
	const outside = mkdtempSync(join(tmpdir(), "graak-outside-"));
	const runFromOutside = spawnSync(result.launcherPath, [], {
		cwd: outside,
		encoding: "utf-8",
		timeout: 30_000,
	});
	assert.equal(runFromOutside.status, 0, runFromOutside.stderr);
	const data2 = JSON.parse(runFromOutside.stdout);
	assert.equal(data2.v1, "3.4.5");
	assert.equal(data2.v2, "3.4.5");
});

test("QuickJs host formats uncaught errors with source line context and error properties without unhandled promise rejection", async () => {
	const root = mkdtempSync(join(tmpdir(), "graak-err-test-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "err-bot", version: "1.0.0" }));
	writeFileSync(
		join(root, "index.js"),
		`const err = new TypeError("not a function");
err.code = "ERR_CALL_FAILED";
throw err;`
	);

	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
	});

	const run = spawnSync(result.launcherPath, [], {
		cwd: result.outputPath,
		encoding: "utf-8",
		timeout: 30_000,
	});

	assert.equal(run.status, 1);
	assert.doesNotMatch(run.stderr, /Possibly unhandled promise rejection:/);
	assert.match(run.stderr, /TypeError: not a function/);
	assert.match(run.stderr, /index\.js:\d+/);
	assert.match(run.stderr, /\^/);
	assert.match(run.stderr, /ERR_CALL_FAILED/);
});

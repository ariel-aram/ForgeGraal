import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BinaryInspector, BinaryPackager, QuickJsPackager, TargetDevice } from "../dist/index.js";

function hasDocker(): boolean {
	try {
		return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 }).status === 0;
	} catch {
		return false;
	}
}

/** Same fixture shape as `createProject()` in compiler.test.ts: nested node_modules must resolve. */
function createProject(): string {
	const root = mkdtempSync(join(tmpdir(), "forgegraal-qjs-project-"));
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
	target: process.env.FORGEGRAAL_TARGET ?? null,
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

test("a bot packaged for the ForgeGraal native host runs with no Node.js binary anywhere in the output", {
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
	assert.ok(files.includes("forgegraal-c"), "the ForgeGraal native host must be bundled instead");
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

	const bin = join(result.outputPath, "forgegraal-c");
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
			"-v",
			`${bin}:/forgegraal-c:ro`,
			"-v",
			`${join(process.cwd(), "quickjs/runtime")}:/runtime:ro`,
			"alpine:latest",
			"/forgegraal-c",
			"/runtime/native-selftest.js",
		],
		{ encoding: "utf-8", timeout: 60_000 }
	);
	assert.equal(run.status, 0, `forgegraal-c must run on real Alpine (musl):\n${run.stdout}${run.stderr}`);
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
	const bin = join(result.outputPath, "forgegraal-c");
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
		assert.ok(files.includes("forgegraal-c"), `${target}: the native host must be bundled instead`);

		const info = BinaryInspector.inspect(join(result.outputPath, "forgegraal-c"));
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
		assert.ok(files.includes("forgegraal-c.exe"), `${target}: the native host must be bundled instead`);
		assert.ok(files.includes("runtime"), target);

		const info = BinaryInspector.inspect(join(result.outputPath, "forgegraal-c.exe"));
		assert.ok(info, `${target}: the bundled binary must be a recognizable PE`);
		assert.ok(
			BinaryInspector.matchesTarget(info, target),
			`${target}: bundled binary is ${info?.format} ${info?.arch}`
		);
	}
});

test("a native addon makes a quickjs-targeted build fail loudly, not silently drop it", async () => {
	const root = createProject();
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "qjs-bot", dependencies: { a: "1", b: "1", lmdb: "^3" } })
	);
	mkdirSync(join(root, "node_modules/lmdb/build/Release"), { recursive: true });
	writeFileSync(join(root, "node_modules/lmdb/package.json"), JSON.stringify({ name: "lmdb", main: "index.js" }));
	writeFileSync(join(root, "node_modules/lmdb/index.js"), 'module.exports = require("./build/Release/lmdb.node");');
	// Content does not matter: quickjs-ng has no dlopen surface, so any .node file must be rejected
	// regardless of whether it would otherwise match the target's architecture.
	writeFileSync(join(root, "node_modules/lmdb/build/Release/lmdb.node"), Buffer.from("not a real binary"));
	writeFileSync(join(root, "src/index.js"), 'require("lmdb");');

	await assert.rejects(
		BinaryPackager.compile({
			entrypoint: join(root, "src/index.js"),
			target: TargetDevice.LinuxModernX64,
			packageManager: "npm",
			offline: true,
		}),
		/dlopen\/N-API surface/
	);
});

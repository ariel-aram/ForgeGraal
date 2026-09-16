import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	Archive,
	BinaryInspector,
	BinaryPackager,
	NativeAddonMismatchError,
	NodeRuntime,
	PathOutsideRootError,
	ProjectCollector,
	ProjectError,
	resolveInside,
	TargetDevice,
} from "../dist/index.js";

function must<T>(value: T | null | undefined): T {
	assert.ok(value != null);
	return value;
}

function write(file: string, content: string | Buffer) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function pkg(dir: string, name: string, version: string, extra: object = {}) {
	write(join(dir, "package.json"), JSON.stringify({ name, version, ...extra }));
	write(
		join(dir, "index.js"),
		`module.exports = ${JSON.stringify(`${name}@${version}`)};`,
	);
}

function elf32(machine: number, interp: string | null, osabi = 0): Buffer {
	const buf = Buffer.alloc(256);
	buf.writeUInt32BE(0x7f454c46, 0);
	buf[4] = 1;
	buf[5] = 1;
	buf[7] = osabi;
	buf.writeUInt16LE(machine, 18);
	if (interp) {
		buf.writeUInt32LE(52, 28); // e_phoff
		buf.writeUInt16LE(32, 42); // e_phentsize
		buf.writeUInt16LE(1, 44); // e_phnum
		buf.writeUInt32LE(3, 52); // PT_INTERP
		buf.writeUInt32LE(100, 56); // p_offset
		buf.writeUInt32LE(interp.length + 1, 68); // p_filesz
		buf.write(interp, 100, "latin1");
	}
	return buf;
}

function pe(machine: number, magic: number): Buffer {
	const buf = Buffer.alloc(256);
	buf.write("MZ", 0, "latin1");
	buf.writeUInt32LE(0x80, 0x3c);
	buf.writeUInt32BE(0x50450000, 0x80);
	buf.writeUInt16LE(machine, 0x84);
	buf.writeUInt16LE(magic, 0x98);
	return buf;
}

/** npm-style project: root depends on a@1 and b; b depends on a@2 (must nest). */
function createProject(): string {
	const root = mkdtempSync(join(tmpdir(), "forgegraal-project-"));
	write(
		join(root, "package.json"),
		JSON.stringify({
			name: "@scope/test-bot",
			dependencies: { a: "1", b: "1" },
			devDependencies: { dev: "1" },
		}),
	);
	write(
		join(root, "src/index.js"),
		`const fs = require("fs");
console.log(JSON.stringify({
	a: require("a"),
	bA: require("b"),
	commands: fs.readdirSync("./src/commands"),
	env: fs.existsSync(".env"),
	target: process.env.FORGEGRAAL_TARGET,
}));`,
	);
	write(join(root, "src/commands/ping.js"), "module.exports = 1;");
	write(join(root, "src/main.ts"), "export {};");
	write(join(root, ".env"), "DISCORD_TOKEN=secret");
	pkg(join(root, "node_modules/a"), "a", "1.0.0");
	pkg(join(root, "node_modules/b"), "b", "1.0.0", { dependencies: { a: "2" } });
	write(
		join(root, "node_modules/b/index.js"),
		`module.exports = "b uses " + require("a");`,
	);
	pkg(join(root, "node_modules/b/node_modules/a"), "a", "2.0.0");
	pkg(join(root, "node_modules/dev"), "dev", "1.0.0");
	return root;
}

test("Archive round-trips files and rejects unsafe paths", () => {
	const packed = Archive.pack([
		{ path: "a/b.txt", source: Buffer.from("hello"), mode: 0o644 },
		{ path: "run", source: Buffer.from("#!/bin/sh"), mode: 0o755 },
	]);
	const files = Archive.unpack(packed.buffer);
	assert.deepEqual(
		files.map((f) => [f.path, f.data.toString(), f.mode]),
		[
			["a/b.txt", "hello", 0o644],
			["run", "#!/bin/sh", 0o755],
		],
	);

	for (const bad of [
		"../x",
		"/etc/passwd",
		"a/../../x",
		"C:/x",
		"a\\b",
		"a//b",
		"",
	]) {
		assert.throws(
			() => Archive.pack([{ path: bad, source: Buffer.from(""), mode: 0o644 }]),
			bad,
		);
	}
	assert.throws(() =>
		Archive.pack([
			{ path: "A.js", source: Buffer.from(""), mode: 0o644 },
			{ path: "a.js", source: Buffer.from(""), mode: 0o644 },
		]),
	);
});

test("BinaryInspector identifies ELF, PE and Mach-O headers", () => {
	const ish = must(BinaryInspector.inspect(elf32(3, "/lib/ld-musl-i386.so.1")));
	assert.equal(ish.format, "elf32");
	assert.equal(ish.arch, "x86");
	assert.equal(ish.interpreter, "/lib/ld-musl-i386.so.1");
	assert.equal(
		BinaryInspector.matchesTarget(ish, TargetDevice.IosIshX86),
		true,
	);
	assert.equal(BinaryInspector.matchesTarget(ish, TargetDevice.LinuxX86), true);
	assert.equal(
		BinaryInspector.matchesTarget(ish, TargetDevice.FreeBsdX86),
		false,
	);

	const glibc = must(BinaryInspector.inspect(elf32(3, "/lib/ld-linux.so.2")));
	assert.equal(
		BinaryInspector.matchesTarget(glibc, TargetDevice.IosIshX86),
		false,
	);

	const bsd = must(BinaryInspector.inspect(elf32(3, null, 9)));
	assert.equal(
		BinaryInspector.matchesTarget(bsd, TargetDevice.FreeBsdX86),
		true,
	);

	const arm = must(BinaryInspector.inspect(elf32(40, null)));
	assert.equal(
		BinaryInspector.matchesTarget(arm, TargetDevice.LinuxArmV7),
		true,
	);

	const win32 = must(BinaryInspector.inspect(pe(0x014c, 0x10b)));
	assert.deepEqual([win32.format, win32.arch, win32.bits], ["pe32", "x86", 32]);
	assert.equal(
		BinaryInspector.matchesTarget(win32, TargetDevice.WinLegacyX86),
		true,
	);
	assert.equal(
		BinaryInspector.matchesTarget(win32, TargetDevice.WinLegacyX64),
		false,
	);

	const win64 = must(BinaryInspector.inspect(pe(0x8664, 0x20b)));
	assert.equal(
		BinaryInspector.matchesTarget(win64, TargetDevice.WinModernX64),
		true,
	);

	const macho = Buffer.alloc(32);
	macho.writeUInt32LE(0xfeedfacf, 0);
	macho.writeUInt32LE(0x0100000c, 4);
	assert.equal(
		BinaryInspector.matchesTarget(
			must(BinaryInspector.inspect(macho)),
			TargetDevice.DarwinArm64,
		),
		true,
	);

	// The old packagers emitted a bare "MZ" + zeroes; that is not a valid PE
	assert.equal(
		BinaryInspector.inspect(Buffer.from("MZ\0\0garbage".padEnd(128, "\0"))),
		null,
	);

	const host = BinaryInspector.inspect(process.execPath);
	assert.ok(host, "host node binary should be recognised");
});

test("ProjectCollector bundles production dependencies with correct nesting", () => {
	const root = createProject();
	const project = ProjectCollector.collect({
		entrypoint: join(root, "src/index.js"),
	});
	const paths = project.entries.map((e) => e.path);

	assert.equal(project.name, "test-bot");
	assert.equal(project.entry, "src/index.js");
	assert.ok(paths.includes("node_modules/a/index.js"));
	assert.ok(paths.includes("node_modules/b/node_modules/a/package.json"));
	assert.ok(!paths.includes(".env"), ".env must not be bundled by default");
	assert.ok(
		!paths.some((p) => p.startsWith("node_modules/dev/")),
		"devDependencies must not be bundled",
	);

	const withExtras = ProjectCollector.collect({
		entrypoint: join(root, "src/index.js"),
		includeEnv: true,
		includeDev: true,
	});
	assert.ok(withExtras.entries.some((e) => e.path === ".env"));
	assert.ok(
		withExtras.entries.some((e) => e.path === "node_modules/dev/index.js"),
	);
});

test("ProjectCollector follows pnpm-style symlinked node_modules", () => {
	const root = mkdtempSync(join(tmpdir(), "forgegraal-pnpm-"));
	write(
		join(root, "package.json"),
		JSON.stringify({ name: "pnpm-bot", dependencies: { a: "1" } }),
	);
	write(join(root, "index.js"), "");
	const store = join(root, "node_modules/.pnpm");
	pkg(join(store, "a@1.0.0/node_modules/a"), "a", "1.0.0", {
		dependencies: { c: "1" },
	});
	pkg(join(store, "c@1.0.0/node_modules/c"), "c", "1.0.0");
	symlinkSync(
		join(store, "c@1.0.0/node_modules/c"),
		join(store, "a@1.0.0/node_modules/c"),
		"dir",
	);
	symlinkSync(
		join(store, "a@1.0.0/node_modules/a"),
		join(root, "node_modules/a"),
		"dir",
	);

	const paths = ProjectCollector.collect({
		entrypoint: join(root, "index.js"),
	}).entries.map((e) => e.path);
	assert.ok(paths.includes("node_modules/a/index.js"));
	assert.ok(
		paths.includes("node_modules/c/index.js"),
		"transitive pnpm dependency must be hoisted",
	);
	assert.ok(
		!paths.some((p) => p.includes(".pnpm")),
		"the pnpm store itself must not be copied",
	);
});

test("ProjectCollector rejects TypeScript entrypoints and missing dependencies", () => {
	const root = createProject();
	assert.throws(
		() => ProjectCollector.collect({ entrypoint: join(root, "src/main.ts") }),
		ProjectError,
	);

	write(
		join(root, "package.json"),
		JSON.stringify({ name: "x", dependencies: { missing: "1" } }),
	);
	assert.throws(
		() => ProjectCollector.collect({ entrypoint: join(root, "src/index.js") }),
		/missing/,
	);
});

test("resolveInside confines paths to the root", () => {
	const root = createProject();
	assert.equal(resolveInside(root, "src/index.js"), join(root, "src/index.js"));
	assert.throws(() => resolveInside(root, "../outside"), PathOutsideRootError);
	assert.throws(() => resolveInside(root, "/etc/passwd"), PathOutsideRootError);
	symlinkSync(tmpdir(), join(root, "escape"), "dir");
	assert.throws(() => resolveInside(root, "escape"), PathOutsideRootError);
});

test("Portable bundles run with the host Node.js and keep the project layout", async () => {
	const root = createProject();
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		target: `linux-modern-${process.arch === "arm64" ? "arm64" : "x64"}`,
		strategy: "portable",
		packageManager: "npm",
		offline: true,
	});
	assert.equal(result.strategy, "portable");
	assert.ok(readdirSync(result.outputPath).includes("boot.cjs"));

	const output = execFileSync(
		process.execPath,
		[join(result.outputPath, "boot.cjs")],
		{
			cwd: tmpdir(),
			encoding: "utf-8",
		},
	);
	const data = JSON.parse(output);
	assert.equal(data.a, "a@1.0.0");
	assert.equal(data.bA, "b uses a@2.0.0");
	assert.deepEqual(data.commands, ["ping.js"]);
	assert.equal(data.env, false);
	assert.equal(data.target, result.target);

	// A rebuild must not bundle the previous output
	const again = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		target: result.target,
		strategy: "portable",
		packageManager: "npm",
		offline: true,
	});
	assert.equal(again.files, result.files);
});

test("Portable bundles support ESM entrypoints", async () => {
	const root = mkdtempSync(join(tmpdir(), "forgegraal-esm-"));
	write(
		join(root, "package.json"),
		JSON.stringify({ name: "esm-bot", type: "module" }),
	);
	write(
		join(root, "index.js"),
		`import { readFileSync } from "node:fs"; console.log("esm", typeof readFileSync);`,
	);
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.IosIshX86,
		packageManager: "bun",
		offline: true,
	});
	assert.equal(result.strategy, "portable");
	const out = execFileSync(
		process.execPath,
		[join(result.outputPath, "boot.cjs")],
		{ encoding: "utf-8" },
	);
	assert.equal(out.trim(), "esm function");
	assert.ok(readFileSync(result.launcherPath, "utf-8").startsWith("#!/bin/sh"));
});

test("Native addons built for another platform are rejected", async () => {
	const root = createProject();
	write(
		join(root, "node_modules/a/build/Release/addon.node"),
		pe(0x8664, 0x20b),
	);
	await assert.rejects(
		BinaryPackager.compile({
			entrypoint: join(root, "src/index.js"),
			target: TargetDevice.IosIshX86,
			packageManager: "npm",
			offline: true,
		}),
		NativeAddonMismatchError,
	);
	const allowed = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		target: TargetDevice.IosIshX86,
		packageManager: "npm",
		offline: true,
		allowNativeMismatch: true,
	});
	assert.ok(allowed.warnings.some((w) => w.includes("addon.node")));
});

test("SEA executables run standalone", { timeout: 300_000 }, async (t) => {
	const hostTarget = {
		"linux-x64": "linux-modern-x64",
		"linux-arm64": "linux-modern-arm64",
	}[`${process.platform}-${process.arch}`];
	const runtime = readFileSync(process.execPath);
	if (!hostTarget || NodeRuntime.seaFuseState(runtime) !== "ready") {
		t.skip("host Node.js cannot be used as a SEA runtime");
		return;
	}

	const root = createProject();
	const output = join(root, "out", "bot");
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		target: hostTarget,
		output,
		packageManager: "npm",
		nodeBinary: process.execPath,
		offline: true,
	});
	assert.equal(result.strategy, "sea");
	assert.equal(NodeRuntime.seaFuseState(readFileSync(output)), "injected");

	const data = JSON.parse(
		execFileSync(output, { cwd: tmpdir(), encoding: "utf-8" }),
	);
	assert.equal(data.bA, "b uses a@2.0.0");
	assert.deepEqual(data.commands, ["ping.js"]);
});

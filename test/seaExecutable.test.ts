import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
	BinaryPackager,
	packSeaPayload,
	SEA_BLOCK_BYTES,
	SEA_HOST_MARKER,
	SEA_TRAILER_BYTES,
	TargetDevice,
	unpackSeaPayload,
	writeSeaExecutable,
} from "../dist/index.js";

const mingw = spawnSync("x86_64-w64-mingw32-gcc", ["--version"]).status === 0;
const hasWine = spawnSync("docker", ["image", "inspect", "fg-wine"]).status === 0;
const hasGcc = spawnSync("gcc", ["--version"]).status === 0;

// What the program reports about its own files. Run under Node.js from the project folder and from inside the single
// file, it must print the same thing: the payload has to be indistinguishable from the folder it came from.
const REPORT = `const fs = require("fs");
const path = require("path");
const data = path.join(__dirname, "data");
const fd = fs.openSync(path.join(data, "greeting.txt"), "r");
const head = Buffer.alloc(5);
fs.readSync(fd, head, 0, 5, 6);
fs.closeSync(fd);
const report = {
	args: process.argv.slice(2),
	greeting: fs.readFileSync(path.join(data, "greeting.txt"), "utf8"),
	head: head.toString(),
	json: require("./data/config.json").name,
	list: fs.readdirSync(data),
	types: fs.readdirSync(__dirname, { withFileTypes: true }).map((d) => d.name + ":" + (d.isDirectory() ? "dir" : "file")),
	deep: fs.readdirSync(data, { recursive: true }).map((p) => p.split(path.sep).join("/")).sort(),
	size: fs.statSync(path.join(data, "greeting.txt")).size,
	isDir: fs.statSync(data).isDirectory(),
	missing: fs.existsSync(path.join(data, "nope.txt")),
	missingCode: (() => { try { fs.readFileSync(path.join(data, "nope.txt")); } catch (e) { return e.code; } })(),
	dirRead: (() => { try { fs.readFileSync(data); } catch (e) { return e.code; } })(),
	real: fs.realpathSync(path.join(data, "..", "data", "greeting.txt")) === path.join(data, "greeting.txt"),
	nested: require("./lib/nested").value,
	stream: null,
};
if (process.platform === "win32") {
	report.cmd = require("child_process").execFileSync("cmd", ["/c", path.join(__dirname, "bin", "hello.cmd"), "wine"]).toString().trim();
}
fs.createReadStream(path.join(data, "greeting.txt"), { encoding: "utf8", highWaterMark: 7 })
	.on("data", (chunk) => (report.stream = (report.stream ?? "") + chunk))
	.on("end", () => console.log(JSON.stringify(report)));
`;

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "graak-sea-project-"));
	mkdirSync(join(root, "data/sub"), { recursive: true });
	mkdirSync(join(root, "lib"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sea-app", version: "1.0.0" }));
	writeFileSync(join(root, "data/greeting.txt"), "hello from inside the executable");
	writeFileSync(join(root, "data/config.json"), JSON.stringify({ name: "configured" }));
	writeFileSync(join(root, "data/sub/deep.txt"), "deep");
	writeFileSync(join(root, "lib/nested.js"), "exports.value = require('../data/config.json').name + '!';");
	writeFileSync(join(root, "index.js"), REPORT);
	return root;
}

async function build(root: string, output: string, target = TargetDevice.LinuxModernX64) {
	return BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target,
		packageManager: "npm",
		offline: true,
		engine: "native",
		strategy: "sea",
		output,
	});
}

/** Every file under `dir`, relative to it. */
function listFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true })
		.map(String)
		.filter((p) => statSync(join(dir, p)).isFile())
		.sort();
}

test("--engine native --strategy sea writes one file that runs from inside itself: nothing is unpacked", {
	timeout: 300_000,
}, async () => {
	const root = project();
	const out = mkdtempSync(join(tmpdir(), "graak-sea-out-"));
	const file = join(out, "app");
	const result = await build(root, file);

	assert.equal(result.strategy, "quickjs");
	assert.equal(result.outputPath, file);
	assert.equal(result.launcherPath, file, "the executable is its own launcher");
	assert.ok(statSync(file).isFile(), "the output is a single file, not a folder");
	assert.ok(statSync(file).size < 12 * 1024 * 1024, "host plus a small program stays small");

	// Run it from somewhere unrelated, with arguments: nothing but the file is needed.
	const elsewhere = mkdtempSync(join(tmpdir(), "graak-sea-cwd-"));
	const run = spawnSync(file, ["one", "two words"], {
		cwd: elsewhere,
		encoding: "utf-8",
		env: { PATH: "/nonexistent" },
	});
	assert.equal(run.status, 0, run.stderr);
	const expected = spawnSync(process.execPath, [join(root, "index.js"), "one", "two words"], { encoding: "utf-8" });
	assert.equal(expected.status, 0, expected.stderr);
	assert.deepEqual(JSON.parse(run.stdout), JSON.parse(expected.stdout), "the payload reads exactly like the folder");

	assert.deepEqual(readdirSync(out), ["app"], "nothing was written beside the executable");
	assert.deepEqual(readdirSync(elsewhere), [], "nor in the working directory");
	const again = spawnSync(file, [], { encoding: "utf-8" });
	assert.equal(again.status, 0, again.stderr);
	assert.deepEqual(readdirSync(out), ["app"]);
});

test("a single-file build writes beside itself where the program writes, and reads its writes back", {
	timeout: 300_000,
}, async () => {
	const root = project();
	writeFileSync(
		join(root, "index.js"),
		`const fs = require("fs");
const path = require("path");
const logs = path.join(__dirname, "logs");
fs.mkdirSync(logs, { recursive: true });
fs.writeFileSync(path.join(logs, "run.txt"), "written");
fs.appendFileSync(path.join(__dirname, "data/greeting.txt"), "!");
fs.writeFileSync(path.join(__dirname, "data/fresh.txt"), "new");
fs.renameSync(path.join(__dirname, "data/sub/deep.txt"), path.join(__dirname, "data/moved.txt"));
fs.unlinkSync(path.join(__dirname, "data/config.json"));
console.log(JSON.stringify({
	run: fs.readFileSync(path.join(logs, "run.txt"), "utf8"),
	greeting: fs.readFileSync(path.join(__dirname, "data/greeting.txt"), "utf8"),
	data: fs.readdirSync(path.join(__dirname, "data")).sort(),
	sub: fs.readdirSync(path.join(__dirname, "data/sub")),
	moved: fs.readFileSync(path.join(__dirname, "data/moved.txt"), "utf8"),
	top: fs.readdirSync(__dirname).sort(),
	config: fs.existsSync(path.join(__dirname, "data/config.json")),
}));
`
	);
	// Node.js runs a copy, since the program changes its own folder.
	const copy = mkdtempSync(join(tmpdir(), "graak-sea-node-"));
	cpSync(root, copy, { recursive: true });
	const expected = spawnSync(process.execPath, [join(copy, "index.js")], { encoding: "utf-8" });
	assert.equal(expected.status, 0, expected.stderr);

	const out = mkdtempSync(join(tmpdir(), "graak-sea-out-"));
	const file = join(out, "app");
	await build(root, file);
	const run = spawnSync(file, [], { encoding: "utf-8" });
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(JSON.parse(run.stdout), JSON.parse(expected.stdout));
	// Only what the program wrote is on disk.
	assert.deepEqual(listFiles(`${file}.graak`), [
		join("app", "data", "fresh.txt"),
		join("app", "data", "greeting.txt"),
		join("app", "data", "moved.txt"),
		join("app", "logs", "run.txt"),
	]);
	assert.equal(
		readFileSync(join(`${file}.graak`, "app/data/greeting.txt"), "utf8"),
		"hello from inside the executable!"
	);
});

test("files that must be real are extracted one by one: a program to run and an SQLite database", {
	timeout: 300_000,
}, async () => {
	const root = project();
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin/hello.sh"), '#!/bin/sh\necho "hello $1"\n', { mode: 0o755 });
	const db = new DatabaseSync(join(root, "data/app.db"));
	db.exec("CREATE TABLE t (name TEXT); INSERT INTO t VALUES ('from the payload')");
	db.close();
	writeFileSync(
		join(root, "index.js"),
		`const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const db = new DatabaseSync(path.join(__dirname, "data/app.db"));
const row = db.prepare("SELECT name FROM t").get();
db.close();
console.log(JSON.stringify({ shell: execFileSync(path.join(__dirname, "bin/hello.sh"), ["world"]).toString().trim(), row: row.name }));
`
	);
	const out = mkdtempSync(join(tmpdir(), "graak-sea-out-"));
	const file = join(out, "app");
	await build(root, file);
	const run = spawnSync(file, [], { encoding: "utf-8", env: { PATH: "/nonexistent" } });
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(JSON.parse(run.stdout), { shell: "hello world", row: "from the payload" });
	assert.deepEqual(
		listFiles(`${file}.graak`),
		[".sea", join("app", "bin", "hello.sh"), join("app", "data", "app.db")],
		"just the two files, and the marker naming the build they came from"
	);
	// A second start reuses them.
	const before = statSync(join(`${file}.graak`, "app/bin/hello.sh")).mtimeMs;
	assert.equal(spawnSync(file, [], { encoding: "utf-8" }).status, 0);
	assert.equal(statSync(join(`${file}.graak`, "app/bin/hello.sh")).mtimeMs, before);
});

test("a single-file build whose folder is read-only still runs, extracting into the temp directory", {
	timeout: 300_000,
	skip: process.getuid?.() === 0 ? "root can write anywhere" : false,
}, async () => {
	const root = project();
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin/hello.sh"), '#!/bin/sh\necho "hello $1"\n', { mode: 0o755 });
	writeFileSync(
		join(root, "index.js"),
		`console.log(require("child_process").execFileSync(require("path").join(__dirname, "bin/hello.sh"), ["ro"]).toString().trim());`
	);
	const out = mkdtempSync(join(tmpdir(), "graak-sea-out-"));
	const built = join(out, "built");
	await build(root, built);
	const locked = join(mkdtempSync(join(tmpdir(), "graak-sea-ro-")), "bin");
	mkdirSync(locked);
	copyFileSync(built, join(locked, "app"));
	chmodSync(join(locked, "app"), 0o755);
	chmodSync(locked, 0o555);
	const temp = mkdtempSync(join(tmpdir(), "graak-sea-tmp-"));
	try {
		const run = spawnSync(join(locked, "app"), [], { encoding: "utf-8", env: { TMPDIR: temp } });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.trim(), "hello ro");
		assert.equal(existsSync(join(locked, "app.graak")), false, "nothing was written beside a read-only executable");
		assert.equal(readdirSync(temp).length, 1, "the file went to the temp directory");
	} finally {
		chmodSync(locked, 0o755);
	}
});

test("a Node-API addon inside a single file is extracted and loaded", {
	skip: !hasGcc && "gcc is not installed",
	timeout: 600_000,
}, async () => {
	const work = mkdtempSync(join(tmpdir(), "graak-sea-napi-"));
	const addon = join(work, "addon.node");
	const compiled = spawnSync(
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
	assert.equal(compiled.status, 0, compiled.stderr);
	const root = mkdtempSync(join(tmpdir(), "graak-sea-napi-project-"));
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
	writeFileSync(
		join(root, "index.js"),
		readFileSync(join(process.cwd(), "test/fixtures/napi/run.js"), "utf-8").replace(
			'require("./addon.node")',
			'require("napi-fixture")'
		)
	);
	const expected = spawnSync(process.execPath, [join(root, "index.js")], { encoding: "utf-8" });
	assert.equal(expected.status, 0, expected.stderr);

	const out = mkdtempSync(join(tmpdir(), "graak-sea-out-"));
	const file = join(out, "bot");
	await build(root, file);
	const run = spawnSync(file, [], { encoding: "utf-8", timeout: 60_000 });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout.trim(), expected.stdout.trim(), "the host must produce what Node.js produces");
	assert.deepEqual(listFiles(`${file}.graak`), [".sea", join("app", "node_modules", "napi-fixture", "addon.node")]);
});

test("a damaged single-file build says so and exits non-zero instead of running half an application", {
	timeout: 300_000,
}, async () => {
	const root = project();
	const out = mkdtempSync(join(tmpdir(), "graak-sea-out-"));
	const file = join(out, "app");
	await build(root, file);
	const bytes = readFileSync(file);
	// Cut into the payload but keep the trailer's offsets, which no longer add up to the file's size.
	const damaged = Buffer.concat([
		bytes.subarray(0, bytes.length - SEA_TRAILER_BYTES - 500),
		bytes.subarray(bytes.length - SEA_TRAILER_BYTES),
	]);
	const bad = join(out, "damaged");
	writeFileSync(bad, damaged, { mode: 0o755 });
	const run = spawnSync(bad, [], { encoding: "utf-8" });
	assert.notEqual(run.status, 0);
	assert.match(run.stderr, /damaged/);

	// Garbage in the index is caught before anything runs.
	const scrambled = Buffer.from(bytes);
	const offset = Number(scrambled.readBigUInt64LE(scrambled.length - SEA_TRAILER_BYTES + 8));
	scrambled.writeUInt32LE(0xfffffff0, offset + 4 + 4);
	writeFileSync(bad, scrambled, { mode: 0o755 });
	const garbled = spawnSync(bad, [], { encoding: "utf-8" });
	assert.notEqual(garbled.status, 0);
	assert.match(garbled.stderr, /damaged/);

	// A payload in the first format (unpacked to disk on start) is refused with a reason, not misread.
	const old = Buffer.from(bytes);
	old[old.length - SEA_TRAILER_BYTES + 7] = 1;
	writeFileSync(bad, old, { mode: 0o755 });
	const refused = spawnSync(bad, [], { encoding: "utf-8" });
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /older single-file format/);
	assert.equal(existsSync(`${bad}.graak`), false);
});

test("the payload format refuses paths that could escape the root, and round-trips what it packs", () => {
	for (const path of ["../evil", "/abs", "a/../../b", "C:/x", "back\\slash", ""]) {
		assert.throws(
			() => packSeaPayload([{ path, data: Buffer.from("x"), mode: 0o644 }], "app/index.js"),
			/unsafe|empty/,
			path
		);
	}
	assert.throws(
		() =>
			packSeaPayload(
				[
					{ path: "a", data: Buffer.from("1"), mode: 0o644 },
					{ path: "a", data: Buffer.from("2"), mode: 0o644 },
				],
				"a"
			),
		/Duplicate/
	);

	// Many small files share blocks, a file larger than a block gets its own, and random bytes are stored as they are.
	const noise = Buffer.alloc(SEA_BLOCK_BYTES + 12345);
	for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
	const entries = [
		...Array.from({ length: 300 }, (_, i) => ({
			path: `app/node_modules/pkg${i % 7}/file-${i}.js`,
			data: Buffer.from(`module.exports = ${JSON.stringify({ i, text: "x".repeat(i) })};\n`),
			mode: 0o644,
		})),
		{ path: "app/big.bin", data: noise, mode: 0o600 },
		{ path: "app/bin/tool", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
		{ path: "runtime/intl-de.js", data: Buffer.from("cold data"), mode: 0o644 },
		{ path: "app/empty.txt", data: Buffer.alloc(0), mode: 0o644 },
		{ path: "app/ünïcode.txt", data: Buffer.from("utf-8 path"), mode: 0o644 },
	];
	const payload = packSeaPayload(entries, "app/index.js");
	const total = entries.reduce((n, e) => n + e.data.length, 0);
	assert.ok(payload.length < total, "it compresses");
	const { entry, files } = unpackSeaPayload(payload);
	assert.equal(entry, "app/index.js");
	assert.equal(files.size, entries.length);
	for (const e of entries) {
		assert.deepEqual(files.get(e.path)?.data, e.data, e.path);
		assert.equal(files.get(e.path)?.mode, e.mode, e.path);
	}
	// The index is sorted by the bytes of each path, which the host's binary search relies on.
	const order = [...files.keys()].map((p) => Buffer.from(p));
	for (let i = 1; i < order.length; i++) assert.ok(Buffer.compare(order[i - 1], order[i]) < 0);
});

test("a single file is only written onto a host that can run its format", () => {
	const dir = mkdtempSync(join(tmpdir(), "graak-sea-host-"));
	const payload = packSeaPayload([{ path: "app/index.js", data: Buffer.from("1"), mode: 0o644 }], "app/index.js");
	writeFileSync(join(dir, "old-host"), Buffer.from("an older host, without the marker"));
	assert.throws(() => writeSeaExecutable(join(dir, "old-host"), payload, join(dir, "out")), /predates/);
	writeFileSync(join(dir, "host"), Buffer.from(`host ${SEA_HOST_MARKER} bytes`));
	writeSeaExecutable(join(dir, "host"), payload, join(dir, "out"));
	const bytes = readFileSync(join(dir, "out"));
	assert.equal(bytes.subarray(bytes.length - SEA_TRAILER_BYTES).toString("latin1", 0, 8), "FGSEA\0\0\u0002");
});

test("--engine is validated, and native is refused where there is no native host", async () => {
	const root = project();
	await assert.rejects(
		BinaryPackager.compile({
			entrypoint: join(root, "index.js"),
			target: TargetDevice.LinuxModernX64,
			offline: true,
			engine: "bogus" as never,
		}),
		/Unknown engine/
	);
	await assert.rejects(
		BinaryPackager.compile({
			entrypoint: join(root, "index.js"),
			target: TargetDevice.WinModernX64,
			offline: true,
			engine: "native",
		}),
		/no Graak native host build for/i
	);
});

// The Windows host reads its own path with GetModuleFileNameA, its payload through CreateFileA and ReadFile, and
// serves the program from a Windows path; Wine runs the real thing, so this is the code path a Windows 7 machine takes.
test("a single-file Windows build runs from inside itself (Wine)", {
	skip: (!mingw && "mingw-w64 is not installed") || (!hasWine && "no fg-wine Docker image"),
	timeout: 600_000,
}, async () => {
	const root = project();
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin/hello.cmd"), "@echo hello %1\r\n");
	const baseline = spawnSync(process.execPath, [join(root, "index.js"), "first", "second"], { encoding: "utf-8" });
	assert.equal(baseline.status, 0, baseline.stderr);
	const out = mkdtempSync(join(tmpdir(), "graak-sea-win-"));
	const results: Record<string, unknown>[] = [];
	for (const [target, name] of [
		[TargetDevice.WinLegacyX64, "app64.exe"],
		[TargetDevice.WinXpX86, "appxp.exe"],
	] as const) {
		const file = join(out, name);
		const result = await build(root, file, target);
		assert.equal(result.launcherPath, file);
		assert.ok(statSync(file).size < 7 * 1024 * 1024, "a small program on the Windows host is a single file under 7 MB");
		const run = spawnSync(
			"docker",
			[
				"run",
				"--rm",
				"-v",
				`${out}:/w`,
				"-w",
				"/w",
				"-e",
				"WINEDEBUG=-all",
				"fg-wine",
				"sh",
				"-c",
				`wineboot -u >/dev/null 2>&1; wine 'Z:\\w\\${name}' first second`,
			],
			{ encoding: "utf-8", timeout: 240_000 }
		);
		const line = run.stdout.split("\n").find((l) => l.startsWith("{")) ?? "";
		assert.ok(line, `no output from ${name}:\n${run.stdout}${run.stderr}`);
		results.push(JSON.parse(line));
	}
	for (const printed of results) {
		const { cmd, ...rest } = printed;
		assert.equal(cmd, "hello wine", "the .cmd was extracted and run");
		assert.deepEqual(rest, JSON.parse(baseline.stdout));
	}
	// Only the script that had to be real is on disk.
	for (const name of ["app64.exe", "appxp.exe"]) {
		assert.deepEqual(listFiles(join(out, `${name}.graak`)), [".sea", join("app", "bin", "hello.cmd")]);
	}
});

test("win-legacy-x64 with --strategy sea defaults to native engine and builds a single .exe without Node bloat", {
	timeout: 300_000,
}, async () => {
	const root = project();
	const out = mkdtempSync(join(tmpdir(), "graak-sea-win7-"));
	const file = join(out, "bot.exe");
	// Note: no `engine: "native"` specified! engine is default "auto".
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.WinLegacyX64,
		packageManager: "npm",
		strategy: "sea",
		output: file,
		offline: true,
	});

	assert.equal(result.strategy, "quickjs");
	assert.equal(result.runtimeVersion, null, "must not fall back to Node.js runtime");
	assert.equal(result.outputPath, file);
	assert.equal(result.launcherPath, file);
	assert.ok(statSync(file).isFile(), "output is a single executable file, not a directory");
	assert.ok(statSync(file).size < 7 * 1024 * 1024, "native SEA binary stays under 7 MB, avoiding +200 MB bloat");
	assert.ok(!existsSync(join(out, "app")), "no loose app folder was generated");
});

test("win-legacy-x64 with .exe output path produces a single binary rather than an app folder", {
	timeout: 300_000,
}, async () => {
	const root = project();
	const out = mkdtempSync(join(tmpdir(), "graak-sea-win7-exe-"));
	const file = join(out, "custom-name.exe");
	// Note: neither engine nor strategy specified! Both default to "auto".
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.WinLegacyX64,
		packageManager: "npm",
		output: file,
		offline: true,
	});

	assert.equal(result.strategy, "quickjs");
	assert.equal(result.runtimeVersion, null);
	assert.equal(result.outputPath, file);
	assert.equal(result.launcherPath, file);
	assert.ok(statSync(file).isFile(), "output must be an actual binary file, not a directory named .exe");
	assert.ok(statSync(file).size < 7 * 1024 * 1024, "single binary is lightweight under 7 MB");
});

test("native single executable build throws when output path is an existing directory", async () => {
	const root = project();
	const outDir = mkdtempSync(join(tmpdir(), "graak-sea-dir-"));
	await assert.rejects(
		BinaryPackager.compile({
			entrypoint: join(root, "index.js"),
			target: TargetDevice.WinLegacyX64,
			packageManager: "npm",
			strategy: "sea",
			output: outDir,
			offline: true,
		}),
		/SEA output '.*' is a directory; pass a file path/
	);
});

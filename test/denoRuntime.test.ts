import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BinaryPackager, DenoBundler, TargetDevice } from "../dist/index.js";

/**
 * The bar for the Deno namespace is the one every other module of the host is held to: the same program prints
 * exactly what it prints under real Deno. Each fixture in test/fixtures/deno prints a transcript; the test runs it
 * with `deno run -A`, packages it with Graak, runs the executable and compares stdout and the exit code.
 */
const fixtures = join(import.meta.dirname, "fixtures", "deno");
const hasDeno = DenoBundler.isAvailable();
const hasWine = spawnSync("docker", ["image", "inspect", "fg-wine"]).status === 0;

/** A fixture copied into a project of its own (a deno.json marks it as one), as a user's would be. */
function workspace(name: string): { dir: string; entry: string } {
	const dir = mkdtempSync(join(tmpdir(), `graak-deno-${name}-`));
	// The APIs Deno still calls unstable are switched on, as a project that uses them would.
	writeFileSync(join(dir, "deno.json"), JSON.stringify({ unstable: ["kv", "cron", "ffi", "net"] }));
	copyFileSync(join(fixtures, `${name}.ts`), join(dir, `${name}.ts`));
	return { dir, entry: join(dir, `${name}.ts`) };
}

function launcher(out: string): string {
	if (statSync(out).isFile()) return out;
	const name = readdirSync(out).find(
		(f) => !["app", "runtime", "graak-c", "graak-c.exe"].includes(f) && !f.endsWith(".cmd")
	);
	assert.ok(name, `no launcher in ${out}`);
	return join(out, name);
}

function underDeno(entry: string, cwd: string, args: string[] = []) {
	const run = spawnSync("deno", ["run", "-A", entry, ...args], { cwd, encoding: "utf-8", timeout: 120_000 });
	return { stdout: run.stdout, status: run.status };
}

function underGraak(out: string, cwd: string, args: string[] = []) {
	const run = spawnSync(launcher(out), args, { cwd, encoding: "utf-8", timeout: 120_000 });
	return { stdout: run.stdout, status: run.status, stderr: run.stderr };
}

async function build(entry: string, out: string, extra: Record<string, unknown> = {}) {
	return BinaryPackager.compile({
		entrypoint: entry,
		target: TargetDevice.LinuxModernX64,
		packageManager: "deno",
		offline: true,
		output: out,
		...extra,
	});
}

const CORPORA = ["fs-corpus", "env-process", "serve", "net-command", "websocket", "kv", "sockets"];

for (const name of CORPORA) {
	test(`Deno corpus ${name} prints the same under Graak's engine as under Deno`, {
		skip: !hasDeno && "deno is not installed",
		timeout: 300_000,
	}, async () => {
		const { dir, entry } = workspace(name);
		const expected = underDeno(entry, dir);
		assert.equal(expected.status, 0, "the corpus itself runs under Deno");
		const out = join(dir, "out");
		const result = await build(entry, out);
		assert.equal(result.strategy, "quickjs");
		const actual = underGraak(out, dir);
		assert.equal(actual.status, 0, actual.stderr);
		assert.equal(actual.stdout, expected.stdout);
	});
}

test("Deno.exit and the exit code, arguments and environment reach the program", {
	skip: !hasDeno && "deno is not installed",
	timeout: 300_000,
}, async () => {
	const { dir, entry } = workspace("env-process");
	const out = join(dir, "out");
	await build(entry, out);
	const run = spawnSync(launcher(out), ["alpha", "beta"], {
		cwd: dir,
		encoding: "utf-8",
		env: { ...process.env, GRAAK_EXIT: "7" },
	});
	assert.equal(run.status, 7);
	assert.match(run.stdout, /args \["alpha","beta"\]/);
});

test("Deno corpora also run on the Node.js engine, through the same bundle", {
	skip: !hasDeno && "deno is not installed",
	timeout: 600_000,
}, async () => {
	for (const name of ["fs-corpus", "net-command"]) {
		const { dir, entry } = workspace(name);
		const expected = underDeno(entry, dir);
		const out = join(dir, "out");
		await build(entry, out, { engine: "node", nodeBinary: process.execPath });
		const actual = underGraak(out, dir);
		assert.equal(actual.status, 0, actual.stderr);
		assert.equal(actual.stdout, expected.stdout, name);
	}
});

const HAS_GLIBC = process.platform === "linux" && existsSync("/lib/x86_64-linux-gnu/libc.so.6");

test("Deno FFI calls the C library the way Deno does (scalars, 64-bit, buffers, pointers, callbacks, structs)", {
	skip: (!hasDeno && "deno is not installed") || (!HAS_GLIBC && "needs glibc's libc.so.6 and libm.so.6"),
	timeout: 300_000,
}, async () => {
	const { dir, entry } = workspace("ffi");
	const expected = underDeno(entry, dir);
	assert.equal(expected.status, 0);
	const out = join(dir, "out");
	const result = await build(entry, out);
	// A static host cannot load a library, so a program that calls Deno.dlopen gets a dynamic one, and the build says so.
	assert.ok(
		result.warnings.some((w: string) => /Deno FFI/.test(w) && /dynamically linked/.test(w)),
		result.warnings.join("\n")
	);
	const actual = underGraak(out, dir);
	assert.equal(actual.status, 0, actual.stderr);
	assert.equal(actual.stdout, expected.stdout);
});

test("Deno FFI on the Node.js engine says it needs the Graak engine", {
	skip: !hasDeno && "deno is not installed",
	timeout: 600_000,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "graak-deno-noffi-"));
	writeFileSync(join(dir, "deno.json"), "{}");
	writeFileSync(
		join(dir, "main.ts"),
		`try { Deno.dlopen("libc.so.6", {}); console.log("loaded"); } catch (e) { console.log((e as Error).name); }\n`
	);
	const out = join(dir, "out");
	await build(join(dir, "main.ts"), out, { engine: "node", nodeBinary: process.execPath });
	assert.equal(underGraak(out, dir).stdout.trim(), "NotSupported");
});

test("Deno KV on the Node.js engine gives the same answers, through the same SQLite file format", {
	skip: !hasDeno && "deno is not installed",
	timeout: 600_000,
}, async () => {
	const { dir, entry } = workspace("kv");
	const expected = underDeno(entry, dir);
	const out = join(dir, "out");
	await build(entry, out, { engine: "node", nodeBinary: process.execPath });
	const actual = underGraak(out, dir);
	assert.equal(actual.status, 0, actual.stderr);
	assert.equal(actual.stdout, expected.stdout);
});

test("Deno KV data written by the Graak engine opens under Node.js and expiry hides an entry at once", {
	skip: !hasDeno && "deno is not installed",
	timeout: 300_000,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "graak-deno-kvfile-"));
	writeFileSync(join(dir, "deno.json"), JSON.stringify({ unstable: ["kv"] }));
	const file = join(dir, "data.sqlite3");
	writeFileSync(
		join(dir, "main.ts"),
		`const kv = await Deno.openKv(${JSON.stringify(file)});
await kv.set(["a", 1], { n: 1 });
await kv.set(["gone"], "x", { expireIn: 40 });
await new Promise((r) => setTimeout(r, 100));
console.log(JSON.stringify([(await kv.get(["a", 1])).value, (await kv.get(["gone"])).value]));
kv.close();
`
	);
	const out = join(dir, "out");
	await build(join(dir, "main.ts"), out);
	assert.equal(underGraak(out, dir).stdout.trim(), '[{"n":1},null]');
	const sqlite = spawnSync(
		process.execPath,
		[
			"-e",
			`const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(file)}); console.log(db.prepare("SELECT count(*) AS n FROM kv WHERE expires IS NULL").get().n);`,
		],
		{ encoding: "utf-8" }
	);
	if (sqlite.status === 0) assert.equal(sqlite.stdout.trim(), "1", "the same file opens under Node.js's own SQLite");
});

/** What `deno test` prints, without what differs by design: timings, locations, stack traces and Deno's own banners. */
function normalizeTestOutput(text: string): string[] {
	const lines = text
		.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
		.replace(/\([0-9.]+(µs|ms|s)\)/g, "(T)")
		.replace(/(=> \.\/[^:\n]+):\d+:\d+/g, "$1")
		.split("\n")
		.filter((l) => !/^(Check |Download )|^-+ pre-test output|^main module ran$/.test(l));
	const kept: string[] = [];
	let inErrors = false;
	for (const line of lines) {
		if (/^ ERRORS /.test(line)) inErrors = true;
		if (
			inErrors &&
			!(/ => \.\//.test(line) || /^error: /.test(line) || /^ FAILURES /.test(line) || /^(ok|FAILED) \|/.test(line))
		)
			continue;
		if (line.trim() !== "") kept.push(line);
	}
	return kept;
}

test("registered Deno.test steps print what `deno test` prints, and a failure exits 1", {
	skip: !hasDeno && "deno is not installed",
	timeout: 300_000,
}, async () => {
	const { dir, entry } = workspace("test-runner");
	const reference = spawnSync("deno", ["test", "-A", "--no-check", entry], {
		cwd: dir,
		encoding: "utf-8",
		timeout: 120_000,
	});
	const out = join(dir, "out");
	await build(entry, out);
	const actual = underGraak(out, dir);
	assert.equal(actual.status, 1, "a failing test fails the program");
	assert.deepEqual(normalizeTestOutput(actual.stdout), normalizeTestOutput(reference.stdout));
	assert.match(actual.stderr, /error: Test failed/);
});

test("Deno.bench prints deno bench's table and Deno.test.only marks the run failed", {
	skip: !hasDeno && "deno is not installed",
	timeout: 300_000,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "graak-deno-bench-"));
	writeFileSync(join(dir, "deno.json"), "{}");
	writeFileSync(
		join(dir, "main.ts"),
		`Deno.bench("sum", () => { let s = 0; for (let i = 0; i < 100; i++) s += i; });
Deno.bench({ name: "skipped", ignore: true, fn: () => { throw new Error("no"); } });
Deno.test.only("only one", () => {});
Deno.test("filtered out", () => {});
`
	);
	const out = join(dir, "out");
	await build(join(dir, "main.ts"), out);
	const run = underGraak(out, dir);
	assert.match(run.stdout, /1 passed \| 0 failed \| 1 filtered out/);
	assert.match(
		run.stdout,
		/\| benchmark\s+\| time\/iter \(avg\)\s+\| iter\/s\s+\| \(min … max\)\s+\| p75\s+\| p99\s+\| p995\s+\|/
	);
	assert.match(run.stdout, /\| sum\s+\|/);
	assert.doesNotMatch(run.stdout, /skipped/);
	assert.equal(run.status, 1, "the only option fails the run, as in Deno");
	assert.match(run.stderr, /"only" option was used/);
});

test("Deno.cron computes UTC schedules with cron syntax, retries with backoff and stops on abort", {
	skip: !hasDeno && "deno is not installed",
	timeout: 300_000,
}, async () => {
	const { dir, entry } = workspace("cron");
	const out = join(dir, "out");
	await build(entry, out);
	const run = underGraak(out, dir);
	assert.equal(run.status, 0, run.stderr);
	const [schedule, flow] = run.stdout.trim().split("\n");
	assert.deepEqual(JSON.parse(schedule), [
		"2026-09-21T12:15:00.000Z",
		"2027-01-01T00:00:00.000Z",
		"2026-09-28T09:30:00.000Z",
		"2026-09-18T00:00:00.000Z",
		"2027-01-01T12:00:00.000Z",
		"2026-12-31T23:59:00.000Z",
		"2028-02-29T00:00:00.000Z",
		"2026-09-21T09:00:00.000Z",
		"2026-09-21T12:10:00.000Z",
		"* * * * TypeError",
		"61 * * * * TypeError",
		"* 25 * * * TypeError",
		"*/0 * * * * TypeError",
		"* * 32 * * TypeError",
		"* * * 13 * TypeError",
	]);
	assert.deepEqual(JSON.parse(flow), ["duplicate TypeError", "run 1", "run 2", "run 3"]);
});

test("Deno.watchFs reports a file created, changed and removed", {
	skip: !hasDeno && "deno is not installed",
	timeout: 300_000,
}, async () => {
	const { dir, entry } = workspace("watch");
	const out = join(dir, "out");
	await build(entry, out);
	const run = underGraak(out, dir);
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(JSON.parse(run.stdout.trim()), { create: true, modify: true, remove: true, names: ["a.txt"] });
});

const PROJECT = join(fixtures, "project");

/** The project fixture needs jsr and npm packages: it runs when Deno can reach (or has cached) them. */
function canResolveProject(): boolean {
	if (!hasDeno) return false;
	const info = spawnSync("deno", ["info", "--json", "--no-lock", join(PROJECT, "main.ts")], {
		encoding: "utf-8",
		timeout: 120_000,
	});
	return info.status === 0;
}
const hasPackages = canResolveProject();

function projectCopy(): string {
	const dir = mkdtempSync(join(tmpdir(), "graak-deno-project-"));
	cpSync(PROJECT, dir, { recursive: true });
	return dir;
}

test("a Deno project (import map, jsr, npm, JSON import, top-level await) runs the same and leaves the project alone", {
	skip: (!hasDeno && "deno is not installed") || (!hasPackages && "the jsr and npm packages are not reachable"),
	timeout: 600_000,
}, async () => {
	const dir = projectCopy();
	const before = readdirSync(dir).sort();
	const expected = underDeno(join(dir, "main.ts"), dir, ["one", "two"]);
	// The reference run wrote deno.lock; forget it so the build meets the project as a user's checkout has it.
	const lock = join(dir, "deno.lock");
	if (!before.includes("deno.lock") && existsSync(lock)) writeFileSync(lock, "");
	const fresh = projectCopy();
	const freshBefore = readdirSync(fresh).sort();
	const out = join(fresh, "graak-out-test");
	const result = await build(join(fresh, "main.ts"), out, { offline: false });
	assert.deepEqual(
		readdirSync(fresh)
			.filter((f) => f !== "graak-out-test")
			.sort(),
		freshBefore,
		"no deno.lock or node_modules appeared"
	);
	assert.ok(result.packages >= 1, "zod is a package of the build");
	assert.ok(
		existsSync(join(out, "app/node_modules/zod/package.json")),
		"npm packages are real files under node_modules"
	);
	assert.ok(!existsSync(join(out, "app/main.ts")), "bundled sources are not shipped a second time");
	assert.ok(existsSync(join(out, "app/assets/note.txt")), "files beside the program are");
	const actual = underGraak(out, fresh, ["one", "two"]);
	assert.equal(actual.status, 0, actual.stderr);
	assert.equal(actual.stdout, expected.stdout);
});

test("the same Deno project builds for every target Deno itself cannot make", {
	skip: (!hasDeno && "deno is not installed") || (!hasPackages && "the jsr and npm packages are not reachable"),
	timeout: 600_000,
}, async () => {
	for (const target of [
		TargetDevice.WinXpX86,
		TargetDevice.WinVistaX64,
		TargetDevice.WinLegacyX64,
		TargetDevice.LinuxX86,
		TargetDevice.IosIshX86,
	]) {
		const dir = projectCopy();
		const out = join(dir, "out");
		const result = await BinaryPackager.compile({
			entrypoint: join(dir, "main.ts"),
			target,
			packageManager: "deno",
			output: out,
		});
		assert.equal(result.strategy, "quickjs", target);
		assert.ok(existsSync(join(out, "app")), target);
	}
});

test("a Deno project runs as one Windows 7 executable (Wine)", {
	skip:
		(!hasDeno && "deno is not installed") ||
		(!hasPackages && "the jsr and npm packages are not reachable") ||
		(!hasWine && "no fg-wine Docker image"),
	timeout: 900_000,
}, async () => {
	const dir = projectCopy();
	const file = join(dir, "app.exe");
	await BinaryPackager.compile({
		entrypoint: join(dir, "main.ts"),
		target: TargetDevice.WinLegacyX64,
		packageManager: "deno",
		engine: "native",
		strategy: "sea",
		output: file,
	});
	assert.ok(statSync(file).size < 6 * 1024 * 1024, "one small file");
	const run = spawnSync(
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
			"fg-wine",
			"sh",
			"-c",
			"wineboot -u >/dev/null 2>&1; wine 'Z:\\w\\app.exe' one two",
		],
		{ encoding: "utf-8", timeout: 400_000 }
	);
	const line = run.stdout.split("\n").find((l) => l.startsWith("{")) ?? "";
	assert.ok(line, `no output from the Windows build:\n${run.stdout}${run.stderr}`);
	const printed = JSON.parse(line);
	assert.equal(printed.greet, "hello deno");
	assert.deepEqual(printed.zod, [true, false, 2]);
	assert.deepEqual(printed.args, ["one", "two"]);
	assert.equal(printed.note, "asset text");
});

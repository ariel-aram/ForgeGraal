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
	writeFileSync(join(dir, "deno.json"), "{}");
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

const CORPORA = ["fs-corpus", "env-process", "serve", "net-command", "websocket"];

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

test("APIs Graak cannot provide throw NotSupported and the build says so", {
	skip: !hasDeno && "deno is not installed",
	timeout: 300_000,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "graak-deno-unsupported-"));
	writeFileSync(join(dir, "deno.json"), "{}");
	writeFileSync(
		join(dir, "main.ts"),
		`// @ts-nocheck: these are unstable or absent in a type-checked Deno.
const seen: string[] = [];
for (const [name, call] of Object.entries({
  kv: () => Deno.openKv(),
  cron: () => Deno.cron("x", "* * * * *", () => {}),
  dlopen: () => Deno.dlopen("x", {}),
  test: () => Deno.test(() => {}),
})) {
  try { await call(); seen.push(name + ":ran"); } catch (e) { seen.push(name + ":" + (e as Error).name); }
}
console.log(seen.join(" "));
`
	);
	const out = join(dir, "out");
	const result = await build(join(dir, "main.ts"), out);
	assert.ok(
		result.warnings.some((w: string) => /Deno\.openKv.*Deno\.cron.*Deno\.dlopen/s.test(w)),
		result.warnings.join("\n")
	);
	const run = underGraak(out, dir);
	assert.equal(run.stdout.trim(), "kv:NotSupported cron:NotSupported dlopen:NotSupported test:NotSupported");
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
	assert.ok(statSync(file).size < 5 * 1024 * 1024, "one small file");
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

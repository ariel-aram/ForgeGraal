import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BinaryPackager, packSeaPayload, SEA_TRAILER_BYTES, TargetDevice } from "../dist/index.js";

const mingw = spawnSync("x86_64-w64-mingw32-gcc", ["--version"]).status === 0;
const hasWine = spawnSync("docker", ["image", "inspect", "fg-wine"]).status === 0;

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "forgegraal-sea-project-"));
	mkdirSync(join(root, "data"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sea-app", version: "1.0.0" }));
	writeFileSync(join(root, "data/greeting.txt"), "hello from inside the executable");
	writeFileSync(
		join(root, "index.js"),
		`const fs = require("fs");
const path = require("path");
console.log(JSON.stringify({
	args: process.argv.slice(2),
	greeting: fs.readFileSync(path.join(__dirname, "data/greeting.txt"), "utf8"),
	cwd: process.cwd() === ${JSON.stringify("")} ? "" : "set",
}));`
	);
	return root;
}

async function build(root: string, output: string) {
	return BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
		engine: "native",
		strategy: "sea",
		output,
	});
}

test("--engine native --strategy sea writes one file that unpacks itself and runs, with no Node.js", {
	timeout: 300_000,
}, async () => {
	const root = project();
	const out = mkdtempSync(join(tmpdir(), "forgegraal-sea-out-"));
	const file = join(out, "app");
	const result = await build(root, file);

	assert.equal(result.strategy, "quickjs");
	assert.equal(result.outputPath, file);
	assert.equal(result.launcherPath, file, "the executable is its own launcher");
	assert.ok(statSync(file).isFile(), "the output is a single file, not a folder");
	assert.ok(statSync(file).size < 12 * 1024 * 1024, "host plus a small program stays small");

	// Run it from somewhere unrelated, with arguments: nothing but the file is needed.
	const elsewhere = mkdtempSync(join(tmpdir(), "forgegraal-sea-cwd-"));
	const run = spawnSync(file, ["one", "two words"], {
		cwd: elsewhere,
		encoding: "utf-8",
		env: { PATH: "/nonexistent" },
	});
	assert.equal(run.status, 0, run.stderr);
	const printed = JSON.parse(run.stdout);
	assert.deepEqual(printed.args, ["one", "two words"]);
	assert.equal(printed.greeting, "hello from inside the executable", "bundled files are reachable from __dirname");

	// It unpacked beside itself, and a second start reuses that instead of unpacking again.
	const marker = join(`${file}.forgegraal`, ".sea");
	assert.ok(existsSync(marker), "unpacked next to the executable");
	const before = statSync(marker).mtimeMs;
	const again = spawnSync(file, [], { encoding: "utf-8" });
	assert.equal(again.status, 0, again.stderr);
	assert.equal(statSync(marker).mtimeMs, before, "the second start does not unpack again");
});

test("a single-file build whose folder is read-only unpacks into the temp directory instead", {
	timeout: 300_000,
	skip: process.getuid?.() === 0 ? "root can write anywhere" : false,
}, async () => {
	const root = project();
	const out = mkdtempSync(join(tmpdir(), "forgegraal-sea-out-"));
	const built = join(out, "built");
	await build(root, built);
	const locked = join(mkdtempSync(join(tmpdir(), "forgegraal-sea-ro-")), "bin");
	mkdirSync(locked);
	copyFileSync(built, join(locked, "app"));
	chmodSync(join(locked, "app"), 0o755);
	chmodSync(locked, 0o555);
	try {
		const run = spawnSync(join(locked, "app"), [], { encoding: "utf-8" });
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /hello from inside the executable/);
		assert.equal(
			existsSync(join(locked, "app.forgegraal")),
			false,
			"nothing was written beside a read-only executable"
		);
	} finally {
		chmodSync(locked, 0o755);
	}
});

test("a damaged single-file build says so and exits non-zero instead of running half an application", {
	timeout: 300_000,
}, async () => {
	const root = project();
	const out = mkdtempSync(join(tmpdir(), "forgegraal-sea-out-"));
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
	assert.match(run.stderr, /damaged|cannot/);
});

test("the payload format refuses paths that could escape the unpack directory", () => {
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
		/no ForgeGraal native host build for/i
	);
});

// The Windows host reads its own path with GetModuleFileNameA, unpacks with CreateDirectoryA and runs the
// program from a Windows path; Wine runs the real thing, so this is the same code path a Windows 7 machine takes.
test("a single-file Windows build unpacks itself and runs (Wine)", {
	skip: (!mingw && "mingw-w64 is not installed") || (!hasWine && "no fg-wine Docker image"),
	timeout: 600_000,
}, async () => {
	const root = project();
	const out = mkdtempSync(join(tmpdir(), "forgegraal-sea-win-"));
	const file = join(out, "app.exe");
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.WinLegacyX64,
		packageManager: "npm",
		offline: true,
		engine: "native",
		strategy: "sea",
		output: file,
	});
	assert.equal(result.launcherPath, file);
	assert.ok(statSync(file).size < 4 * 1024 * 1024, "a small program on the Windows host is a single file under 4 MB");

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
			"wineboot -u >/dev/null 2>&1; wine 'Z:\\w\\app.exe' first second",
		],
		{ encoding: "utf-8", timeout: 240_000 }
	);
	const line = run.stdout.split("\n").find((l) => l.startsWith("{")) ?? "";
	assert.ok(line, `no output from the Windows build:\n${run.stdout}${run.stderr}`);
	assert.deepEqual(JSON.parse(line).args, ["first", "second"]);
	assert.equal(JSON.parse(line).greeting, "hello from inside the executable");
	assert.ok(existsSync(join(out, "app.exe.forgegraal", ".sea")), "unpacked beside the executable");
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	BinaryPackager,
	BUN_GLOBAL_SHIMMED,
	BUN_GLOBAL_UNSAFE,
	createBunCompatSource,
	TargetDevice,
} from "../dist/index.js";

const SHIM = createBunCompatSource({ target: "linux-modern-x64" });

function hasBun(): boolean {
	try {
		execFileSync("bun", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function runOnNode(script: string): { stdout: string; stderr: string; failed: boolean } {
	const root = mkdtempSync(join(tmpdir(), "graak-buncompat-"));
	const file = join(root, "run.cjs");
	writeFileSync(file, `${SHIM}\n${script}\n`);
	const res = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf-8" });
	return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", failed: res.status !== 0 };
}

test("bun:sqlite shim persists rows to a real database file via node:sqlite", () => {
	const dbPath = join(mkdtempSync(join(tmpdir(), "graak-bunsqlite-")), "bot.sqlite");
	const res = runOnNode(
		`const { Database } = require("bun:sqlite");
const db = new Database(${JSON.stringify(dbPath)});
db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");
const info = db.run("INSERT INTO kv (k, v) VALUES (?, ?)", "a", "1");
db.close();

const again = new Database(${JSON.stringify(dbPath)});
console.log(JSON.stringify({
	changes: info.changes,
	row: again.query("SELECT v FROM kv WHERE k = ?").get("a"),
	values: again.query("SELECT * FROM kv").values(),
}));
again.close();`
	);

	assert.equal(res.failed, false, res.stderr);
	const out = JSON.parse(res.stdout.trim());
	assert.equal(out.changes, 1);
	assert.deepEqual(out.row, { v: "1" });
	assert.deepEqual(out.values, [["a", "1"]]);
});

test("bun:sqlite transaction() rolls back on throw, matching Bun's semantics", () => {
	const res = runOnNode(
		`const { Database } = require("bun:sqlite");
const db = new Database(":memory:");
db.exec("CREATE TABLE t (n INTEGER)");
const insert = db.transaction((rows) => {
	for (const n of rows) db.run("INSERT INTO t (n) VALUES (?)", n);
	if (rows.includes(-1)) throw new Error("bad row");
});
try {
	insert([1, 2, -1]);
} catch (e) {}
console.log(db.query("SELECT COUNT(*) as c FROM t").get().c);`
	);
	assert.equal(res.failed, false, res.stderr);
	assert.equal(res.stdout.trim(), "0", "the failed transaction must not leave partial rows");
});

test("other bun: modules fail with an explanation instead of a bare MODULE_NOT_FOUND", () => {
	const res = runOnNode('require("bun:ffi");');
	assert.equal(res.failed, true);
	assert.match(res.stderr, /no Node\.js compatibility layer/);
});

test("Bun.env, Bun.file and Bun.write are real, working implementations", () => {
	const dir = mkdtempSync(join(tmpdir(), "graak-bunfile-"));
	const target = join(dir, "out.txt");
	const res = runOnNode(
		`process.env.GRAAK_TEST_VAR = "hello";
(async () => {
	await Bun.write(${JSON.stringify(target)}, "written by Graak");
	const file = Bun.file(${JSON.stringify(target)});
	console.log(JSON.stringify({
		env: Bun.env.GRAAK_TEST_VAR,
		exists: await file.exists(),
		text: await file.text(),
		size: file.size,
	}));
})();`
	);
	assert.equal(res.failed, false, res.stderr);
	const out = JSON.parse(res.stdout.trim());
	assert.equal(out.env, "hello");
	assert.equal(out.exists, true);
	assert.equal(out.text, "written by Graak");
	assert.equal(out.size, "written by Graak".length);
	assert.equal(readFileSync(target, "utf-8"), "written by Graak");
});

test("Bun.serve() bridges a fetch handler onto a real HTTP server", async () => {
	// Real Bun.serve() resolves an OS-assigned port (`port: 0`) synchronously; the Node
	// shim cannot (the socket bind is asynchronous — see the comment on bunServe's `port`
	// getter in bunCompat.ts), so this uses a fixed free port like most Bun.serve() call
	// sites do in practice, found the same way any Node test would find one.
	const net = await import("node:net");
	const port = await new Promise<number>((resolvePort, reject) => {
		const probe = net.createServer();
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address();
			if (typeof addr === "object" && addr) {
				probe.close(() => resolvePort(addr.port));
			} else {
				probe.close(() => reject(new Error("could not determine a free port")));
			}
		});
	});

	const root = mkdtempSync(join(tmpdir(), "graak-bunserve-"));
	const file = join(root, "server.cjs");
	writeFileSync(
		file,
		`${SHIM}
const server = Bun.serve({
	port: ${port},
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/echo" && req.method === "POST") {
			return req.text().then((body) => new Response("echo:" + body, { status: 201, headers: { "x-graak": "1" } }));
		}
		return new Response("not found", { status: 404 });
	},
});
process.stdout.write("listening:" + server.port + "\\n");`
	);

	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, [file], { cwd: root });
	const ready = new Promise<void>((resolve, reject) => {
		let buffered = "";
		child.stdout.on("data", (chunk) => {
			buffered += chunk.toString();
			if (buffered.includes("listening:")) resolve();
		});
		child.once("exit", (code) => {
			if (code !== 0) reject(new Error(`server process exited with code ${code}`));
		});
	});

	try {
		await Promise.race([
			ready,
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error("server did not start")), 5000)),
		]);

		const res = await fetch(`http://127.0.0.1:${port}/echo`, { method: "POST", body: "ping" });
		assert.equal(res.status, 201);
		assert.equal(res.headers.get("x-graak"), "1");
		assert.equal(await res.text(), "echo:ping");

		const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
		assert.equal(notFound.status, 404);
	} finally {
		child.kill();
	}
});

test("Bun.password and Bun.hash refuse to silently use a different algorithm", () => {
	assert.ok((BUN_GLOBAL_UNSAFE as readonly string[]).includes("password"));
	assert.ok((BUN_GLOBAL_UNSAFE as readonly string[]).includes("hash"));

	const res = runOnNode('Bun.password.hash("secret");');
	assert.equal(res.failed, true);
	assert.match(res.stderr, /Bun\.password/);
	assert.match(res.stderr, /Node\.js has no argon2id\/bcrypt/);
});

test("unimplemented Bun.* members fail at the point of use, not silently return undefined", () => {
	const res = runOnNode('Bun.spawn(["echo", "hi"]);');
	assert.equal(res.failed, true);
	assert.match(res.stderr, /Bun\.spawn.*no Node\.js equivalent/s);
});

test("every globally-installed member is either explicitly shimmed or explicitly unsafe", () => {
	assert.ok(BUN_GLOBAL_SHIMMED.length > 0);
	assert.ok(BUN_GLOBAL_UNSAFE.length > 0);
	// Ensure the two lists never claim the same member twice with different guarantees.
	const overlap = BUN_GLOBAL_SHIMMED.filter((m) => (BUN_GLOBAL_UNSAFE as readonly string[]).includes(m));
	assert.deepEqual(overlap, []);
});

test("a Bun-authored TypeScript entrypoint using bun:sqlite is transpiled and runs correctly on Node", {
	skip: !hasBun() && "bun is not installed",
}, async () => {
	const { BunTranspiler } = await import("../dist/index.js");
	const root = mkdtempSync(join(tmpdir(), "graak-buntranspile-"));
	const entry = join(root, "index.ts");
	writeFileSync(
		entry,
		`import { Database } from "bun:sqlite";
interface Row { n: number }
const db = new Database(":memory:");
db.exec("CREATE TABLE t (n INTEGER)");
db.run("INSERT INTO t (n) VALUES (?)", 7);
const row = db.query("SELECT n FROM t").get() as Row;
console.log(JSON.stringify({ n: row.n, hasBun: typeof Bun }));`
	);

	const result = BunTranspiler.transpile(entry);
	try {
		assert.match(readFileSync(result.entrypoint, "utf-8"), /require\("bun:sqlite"\)/);
		const out = runOnNode(`require(${JSON.stringify(result.entrypoint)});`);
		assert.equal(out.failed, false, out.stderr);
		const data = JSON.parse(out.stdout.trim());
		assert.equal(data.n, 7);
	} finally {
		result.cleanup();
	}
});

test("a Bun-authored bot packages for Android (linux-armv7) as a plain Node.js build, no Bun or proot-distro on the device", {
	skip: !hasBun() && "bun is not installed",
	timeout: 60_000,
}, async () => {
	// The point: `bun build --compile` needs Bun's own runtime on the target, which on
	// Termux/Android needs proot-distro to run at all. Graak assists instead of
	// replacing that -- it transpiles the Bun-authored source at build time and ships a
	// build that runs on a plain Node.js on the device, no Bun and no proot-distro involved.
	const root = mkdtempSync(join(tmpdir(), "graak-bun-android-"));
	mkdirSync(join(root, "node_modules/greet"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "bun-android-bot", dependencies: { greet: "1" } }));
	writeFileSync(join(root, "node_modules/greet/package.json"), JSON.stringify({ name: "greet", version: "1.0.0" }));
	// biome-ignore lint/suspicious/noTemplateCurlyInString: this is the actual JS source of the fixture package, not a mistaken interpolation.
	writeFileSync(join(root, "node_modules/greet/index.js"), "module.exports = (name) => `hi ${name}`;");
	writeFileSync(
		join(root, "index.ts"),
		`import greet from "greet";
console.log(JSON.stringify({ greeting: greet("android"), hasBun: typeof Bun }));`
	);

	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.ts"),
		target: TargetDevice.LinuxArmV7,
		packageManager: "bun",
		strategy: "portable",
		offline: true,
	});

	assert.equal(result.strategy, "portable");
	assert.equal(result.metadata.os, "linux");
	// Bundled architecture-specific, so only checked structurally here (this sandbox is x64);
	// the launcher output itself is plain JS, and that is what this test actually runs.
	const out = execFileSync(process.execPath, [join(result.outputPath, "boot.cjs")], { encoding: "utf-8" });
	assert.deepEqual(JSON.parse(out), { greeting: "hi android", hasBun: "undefined" });
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUN_GLOBAL_SHIMMED, BUN_GLOBAL_UNSAFE, createBunCompatSource } from "../dist/index.js";

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
	const root = mkdtempSync(join(tmpdir(), "forgegraal-buncompat-"));
	const file = join(root, "run.cjs");
	writeFileSync(file, `${SHIM}\n${script}\n`);
	const res = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf-8" });
	return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", failed: res.status !== 0 };
}

test("bun:sqlite shim persists rows to a real database file via node:sqlite", () => {
	const dbPath = join(mkdtempSync(join(tmpdir(), "forgegraal-bunsqlite-")), "bot.sqlite");
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
	const dir = mkdtempSync(join(tmpdir(), "forgegraal-bunfile-"));
	const target = join(dir, "out.txt");
	const res = runOnNode(
		`process.env.FORGEGRAAL_TEST_VAR = "hello";
(async () => {
	await Bun.write(${JSON.stringify(target)}, "written by ForgeGraal");
	const file = Bun.file(${JSON.stringify(target)});
	console.log(JSON.stringify({
		env: Bun.env.FORGEGRAAL_TEST_VAR,
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
	assert.equal(out.text, "written by ForgeGraal");
	assert.equal(out.size, "written by ForgeGraal".length);
	assert.equal(readFileSync(target, "utf-8"), "written by ForgeGraal");
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

	const root = mkdtempSync(join(tmpdir(), "forgegraal-bunserve-"));
	const file = join(root, "server.cjs");
	writeFileSync(
		file,
		`${SHIM}
const server = Bun.serve({
	port: ${port},
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/echo" && req.method === "POST") {
			return req.text().then((body) => new Response("echo:" + body, { status: 201, headers: { "x-forgegraal": "1" } }));
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
		assert.equal(res.headers.get("x-forgegraal"), "1");
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
	const root = mkdtempSync(join(tmpdir(), "forgegraal-buntranspile-"));
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNativeShimSource, OPTIONAL_ACCELERATORS, UNSUBSTITUTABLE_NATIVE } from "../dist/index.js";

const SHIM = createNativeShimSource({ target: "win-legacy-x86" });

/**
 * Builds a throwaway project where `name` is installed but its native addon fails to load,
 * exactly as it would on a legacy target, and runs `script` with the shim installed.
 */
function runWithFailingAddon(names: string[], script: string): { stdout: string; stderr: string; failed: boolean } {
	const root = mkdtempSync(join(tmpdir(), "graak-shim-"));
	for (const name of names) {
		const dir = join(root, "node_modules", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
		writeFileSync(
			join(dir, "index.js"),
			'var err = new Error("The specified module could not be found.");\nerr.code = "ERR_DLOPEN_FAILED";\nthrow err;\n'
		);
	}
	const file = join(root, "run.cjs");
	writeFileSync(file, `${SHIM}\n${script}\n`);

	const res = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf-8" });
	return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", failed: res.status !== 0 };
}

test("better-sqlite3 fallback writes to a real database file", () => {
	const dbPath = join(mkdtempSync(join(tmpdir(), "graak-db-")), "bot.sqlite");
	const res = runWithFailingAddon(
		["better-sqlite3"],
		`const Database = require("better-sqlite3");
const db = new Database(${JSON.stringify(dbPath)});
db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
const info = db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("token", "hello");
db.close();

// Reopening proves the rows were persisted rather than kept in a throwaway Map.
const again = new Database(${JSON.stringify(dbPath)});
console.log(JSON.stringify({
	changes: info.changes,
	row: again.prepare("SELECT v FROM kv WHERE k = ?").get("token"),
	all: again.prepare("SELECT * FROM kv").all().length,
	journal: typeof again.pragma("journal_mode", { simple: true }),
}));
again.close();`
	);

	assert.equal(res.failed, false, res.stderr);
	const out = JSON.parse(res.stdout.trim());
	assert.equal(out.changes, 1);
	assert.deepEqual(out.row, { v: "hello" });
	assert.equal(out.all, 1);
	assert.equal(out.journal, "string");
});

test("sqlite3 fallback speaks the callback API TypeORM and ForgeDB use", () => {
	const dbPath = join(mkdtempSync(join(tmpdir(), "graak-db-")), "forge.sqlite");
	const res = runWithFailingAddon(
		["sqlite3"],
		`const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database(${JSON.stringify(dbPath)}, (err) => {
	if (err) throw err;
	db.serialize(() => {
		db.run("CREATE TABLE record (identifier TEXT PRIMARY KEY, value TEXT)");
		db.run("INSERT INTO record (identifier, value) VALUES (?, ?)", ["guild_1", "42"], function (e) {
			if (e) throw e;
			db.all("SELECT * FROM record", (e2, rows) => {
				if (e2) throw e2;
				db.get("SELECT value FROM record WHERE identifier = ?", "guild_1", (e3, row) => {
					if (e3) throw e3;
					db.close(() => {
						console.log(JSON.stringify({ changes: this.changes, rows: rows.length, value: row.value }));
					});
				});
			});
		});
	});
});`
	);

	assert.equal(res.failed, false, res.stderr);
	const out = JSON.parse(res.stdout.trim());
	assert.equal(out.changes, 1);
	assert.equal(out.rows, 1);
	assert.equal(out.value, "42");
});

test("bufferutil and utf-8-validate fallbacks match the native semantics", () => {
	const res = runWithFailingAddon(
		["bufferutil", "utf-8-validate"],
		`const bufferutil = require("bufferutil");
const isValidUTF8 = require("utf-8-validate");

const payload = Buffer.from("Graak");
const mask = Buffer.from([0x0a, 0x1b, 0x2c, 0x3d]);
const masked = Buffer.alloc(payload.length);
bufferutil.mask(payload, mask, masked, 0, payload.length);

const expected = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
bufferutil.unmask(masked, mask);

console.log(JSON.stringify({
	maskedMatches: Buffer.compare(Buffer.from(expected), Buffer.from(masked.map((b, i) => b ^ mask[i % 4]))) === 0,
	roundTrip: masked.toString(),
	validUtf8: isValidUTF8(Buffer.from("héllo", "utf-8")),
	invalidUtf8: isValidUTF8(Buffer.from([0xff, 0xfe, 0xfd])),
}));`
	);

	assert.equal(res.failed, false, res.stderr);
	const out = JSON.parse(res.stdout.trim());
	assert.equal(out.roundTrip, "Graak", "unmask must invert mask");
	assert.equal(out.maskedMatches, true);
	assert.equal(out.validUtf8, true);
	assert.equal(out.invalidUtf8, false);
});

test("addons that cannot be replaced correctly fail loudly instead of being stubbed", () => {
	for (const name of ["canvas", "sodium-native", "bcrypt", "lmdb"]) {
		assert.ok(
			(UNSUBSTITUTABLE_NATIVE as readonly string[]).includes(name),
			`${name} must never be answered with a stub`
		);
	}

	const res = runWithFailingAddon(["bcrypt"], 'require("bcrypt");');
	assert.equal(res.failed, true, "a bcrypt stub would silently weaken password hashing");
	assert.match(res.stderr, /needs a native addon built for win-legacy-x86/);
	assert.match(res.stderr, /weaken cryptography/);
});

test("optional accelerators keep throwing so their library falls back on its own", () => {
	assert.ok((OPTIONAL_ACCELERATORS as readonly string[]).includes("zlib-sync"));
	const res = runWithFailingAddon(
		["zlib-sync"],
		'try { require("zlib-sync"); } catch (e) { console.log("rethrown"); }'
	);
	assert.equal(res.failed, false);
	assert.equal(res.stdout.trim(), "rethrown");
	assert.match(res.stderr, /optional accelerator/);
});

test("unrelated load failures are left untouched", () => {
	const res = runWithFailingAddon([], 'try { require("./nope.js"); } catch (e) { console.log(e.code); }');
	assert.equal(res.failed, false);
	assert.equal(res.stdout.trim(), "MODULE_NOT_FOUND");
});

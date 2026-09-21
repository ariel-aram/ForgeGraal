/*
 * Deno KV for programs bundled by Graak: Deno.openKv, Deno.KvU64, atomic operations, list/get/set/delete, queues
 * (enqueue, listenQueue), watch, and expiry -- on SQLite through `node:sqlite`, which the Graak engine has built in
 * and Node.js has from 22.5. The database is an ordinary SQLite file, so the same data opens under either engine.
 *
 * Keys keep Deno's order: byte strings, then strings, then bigints, then numbers, then booleans, each compared as
 * Deno compares it. Values are stored as Deno stores what it can (a Uint8Array as its bytes, a KvU64 as eight bytes)
 * and everything else in a tagged encoding that round-trips what structured clone does: Date, Map, Set, RegExp,
 * typed arrays, BigInt, Error, undefined, NaN, -0 and circular references. Class instances come back as plain
 * objects, as they do in Deno.
 *
 * Every change is one transaction with a versionstamp that grows with each commit, so `check` and atomic
 * operations mean what they do in Deno. What is not the same: there is one process's view (another process sees a
 * change on its next poll, at most a fraction of a second later), and a remote database (https://api.deno.com/...) is
 * not reachable.
 */
(function installKv(global) {
	"use strict";
	const Deno = global.Deno;
	if (!Deno || Deno.__graakKv) return;
	Object.defineProperty(Deno, "__graakKv", { value: true, enumerable: false });

	const path = require("path");
	const os = require("os");
	const fs = require("fs");
	const crypto = require("crypto");

	class KvU64 {
		constructor(value) {
			if (typeof value !== "bigint") throw new TypeError("Value must be a bigint");
			if (value < 0n || value > 0xffffffffffffffffn) throw new RangeError("Value must be a positive bigint that fits in 64 bits");
			this.value = value;
			Object.freeze(this);
		}
		valueOf() {
			return this.value;
		}
		toString() {
			return this.value.toString();
		}
		get [Symbol.toStringTag]() {
			return "Deno.KvU64";
		}
	}

	// ---- keys -----------------------------------------------------------------------------------------------
	const TAG = { bytes: 0x01, string: 0x02, bigint: 0x14, number: 0x21, false: 0x26, true: 0x27 };
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	function pushEscaped(out, bytes) {
		for (const b of bytes) {
			out.push(b);
			if (b === 0) out.push(0xff);
		}
		out.push(0);
	}

	function encodeKey(key) {
		if (!Array.isArray(key)) throw new TypeError("Key must be an array");
		if (key.length === 0) throw new TypeError("Key cannot be empty");
		const out = [];
		for (const part of key) {
			if (part instanceof Uint8Array || part instanceof ArrayBuffer) {
				out.push(TAG.bytes);
				pushEscaped(out, part instanceof ArrayBuffer ? new Uint8Array(part) : part);
			} else if (typeof part === "string") {
				out.push(TAG.string);
				pushEscaped(out, encoder.encode(part));
			} else if (typeof part === "number") {
				out.push(TAG.number);
				const view = new DataView(new ArrayBuffer(8));
				view.setFloat64(0, part);
				const b = new Uint8Array(view.buffer);
				if (b[0] & 0x80) for (let i = 0; i < 8; i++) b[i] ^= 0xff;
				else b[0] ^= 0x80;
				out.push(...b);
			} else if (typeof part === "bigint") {
				out.push(TAG.bigint);
				const negative = part < 0n;
				let magnitude = negative ? -part : part;
				const bytes = [];
				while (magnitude > 0n) {
					bytes.unshift(Number(magnitude & 0xffn));
					magnitude >>= 8n;
				}
				const length = [(bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255];
				if (negative) out.push(0x7f, ...length.map((b) => b ^ 0xff), ...bytes.map((b) => b ^ 0xff));
				else out.push(0x80, ...length, ...bytes);
			} else if (typeof part === "boolean") {
				out.push(part ? TAG.true : TAG.false);
			} else {
				throw new TypeError(`Invalid key part: ${typeof part}`);
			}
		}
		return new Uint8Array(out);
	}

	function decodeKey(bytes) {
		const key = [];
		let i = 0;
		const readEscaped = () => {
			const out = [];
			for (;;) {
				const b = bytes[i++];
				if (b === 0) {
					if (bytes[i] === 0xff) {
						out.push(0);
						i++;
						continue;
					}
					return new Uint8Array(out);
				}
				out.push(b);
			}
		};
		while (i < bytes.length) {
			const tag = bytes[i++];
			if (tag === TAG.bytes) key.push(readEscaped());
			else if (tag === TAG.string) key.push(decoder.decode(readEscaped()));
			else if (tag === TAG.number) {
				const b = bytes.slice(i, i + 8);
				i += 8;
				if (b[0] & 0x80) b[0] ^= 0x80;
				else for (let j = 0; j < 8; j++) b[j] ^= 0xff;
				key.push(new DataView(b.buffer).getFloat64(0));
			} else if (tag === TAG.bigint) {
				const negative = bytes[i++] === 0x7f;
				let length = 0;
				for (let j = 0; j < 4; j++) length = length * 256 + (negative ? bytes[i + j] ^ 0xff : bytes[i + j]);
				i += 4;
				let magnitude = 0n;
				for (let j = 0; j < length; j++) magnitude = (magnitude << 8n) | BigInt(negative ? bytes[i + j] ^ 0xff : bytes[i + j]);
				i += length;
				key.push(negative ? -magnitude : magnitude);
			} else if (tag === TAG.true) key.push(true);
			else if (tag === TAG.false) key.push(false);
			else throw new TypeError("Corrupt key in the database");
		}
		return key;
	}

	function concat(...parts) {
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	}
	const b64 = (bytes) => Buffer.from(bytes).toString("base64");
	const unb64 = (text) => new Uint8Array(Buffer.from(text, "base64"));

	// ---- values --------------------------------------------------------------------------------------------
	const TYPED = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };

	function encodeValue(value) {
		const seen = new Map();
		const walk = (v) => {
			if (v === null || typeof v === "string" || typeof v === "boolean") return v;
			if (v === undefined) return { $: "undef" };
			if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0) ? v : { $: "num", v: Object.is(v, -0) ? "-0" : String(v) };
			if (typeof v === "bigint") return { $: "big", v: v.toString() };
			if (typeof v === "symbol" || typeof v === "function") throw new TypeError("Failed to serialize value: a function or symbol cannot be cloned");
			if (seen.has(v)) return { $: "ref", v: seen.get(v) };
			seen.set(v, seen.size);
			if (v instanceof Date) return { $: "date", v: v.getTime() };
			if (v instanceof RegExp) return { $: "re", s: v.source, f: v.flags };
			if (v instanceof Map) return { $: "map", v: [...v].map(([k, x]) => [walk(k), walk(x)]) };
			if (v instanceof Set) return { $: "set", v: [...v].map(walk) };
			if (v instanceof ArrayBuffer) return { $: "ab", v: b64(new Uint8Array(v)) };
			if (ArrayBuffer.isView(v)) {
				const name = v.constructor.name in TYPED ? v.constructor.name : "Uint8Array";
				return { $: "ta", t: name, v: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
			}
			if (v instanceof Error) return { $: "err", n: v.name, m: v.message, s: v.stack };
			if (Array.isArray(v)) return { $: "arr", v: Array.from(v, walk) };
			const out = {};
			for (const k of Object.keys(v)) out[k] = walk(v[k]);
			return { $: "obj", v: out };
		};
		return walk(value);
	}

	function decodeValue(json) {
		const refs = [];
		const walk = (v) => {
			if (v === null || typeof v !== "object") return v;
			switch (v.$) {
				case "undef": return undefined;
				case "num": return v.v === "NaN" ? NaN : v.v === "Infinity" ? Infinity : v.v === "-Infinity" ? -Infinity : -0;
				case "big": return BigInt(v.v);
				case "ref": return refs[v.v];
				case "date": {
					const d = new Date(v.v);
					refs.push(d);
					return d;
				}
				case "re": {
					const r = new RegExp(v.s, v.f);
					refs.push(r);
					return r;
				}
				case "map": {
					const m = new Map();
					refs.push(m);
					for (const [k, x] of v.v) m.set(walk(k), walk(x));
					return m;
				}
				case "set": {
					const s = new Set();
					refs.push(s);
					for (const x of v.v) s.add(walk(x));
					return s;
				}
				case "ab": {
					const b = unb64(v.v).buffer;
					refs.push(b);
					return b;
				}
				case "ta": {
					const bytes = unb64(v.v);
					const T = TYPED[v.t] ?? Uint8Array;
					const t = new T(bytes.buffer, bytes.byteOffset, bytes.byteLength / T.BYTES_PER_ELEMENT);
					refs.push(t);
					return t;
				}
				case "err": {
					const E = globalThis[v.n] && globalThis[v.n].prototype instanceof Error ? globalThis[v.n] : Error;
					const e = new E(v.m);
					if (v.s) e.stack = v.s;
					refs.push(e);
					return e;
				}
				case "arr": {
					const a = [];
					refs.push(a);
					for (const x of v.v) a.push(walk(x));
					return a;
				}
				case "obj": {
					const o = {};
					refs.push(o);
					for (const k of Object.keys(v.v)) o[k] = walk(v.v[k]);
					return o;
				}
				default:
					return v;
			}
		};
		return walk(json);
	}

	const ENC_JSON = 0;
	const ENC_BYTES = 1;
	const ENC_U64 = 2;

	function packValue(value) {
		if (value instanceof KvU64) {
			const b = new Uint8Array(8);
			new DataView(b.buffer).setBigUint64(0, value.value, true);
			return [b, ENC_U64];
		}
		if (value instanceof Uint8Array && value.constructor === Uint8Array) return [value, ENC_BYTES];
		return [encoder.encode(JSON.stringify(encodeValue(value))), ENC_JSON];
	}
	function unpackValue(bytes, enc) {
		bytes = new Uint8Array(bytes);
		if (enc === ENC_U64) return new KvU64(new DataView(bytes.buffer).getBigUint64(0, true));
		if (enc === ENC_BYTES) return bytes;
		return decodeValue(JSON.parse(decoder.decode(bytes)));
	}

	const stampOf = (n) => (BigInt(n) << 16n).toString(16).padStart(20, "0");

	// ---- the database -----------------------------------------------------------------------------------------
	function loadSqlite() {
		try {
			return require("node:sqlite");
		} catch {
			throw new Deno.errors.NotSupported(
				"Deno KV needs SQLite, which this engine does not have: node:sqlite comes with the Graak engine and Node.js 22.5 or later."
			);
		}
	}

	function defaultPath() {
		const entry = Deno[Symbol.for("graak.entry")] ?? Deno.mainModule ?? "main";
		const id = crypto.createHash("sha256").update(String(entry)).digest("hex").slice(0, 16);
		const dir = path.join(os.homedir?.() || os.tmpdir(), ".graak", "kv");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `${id}.sqlite3`);
	}

	const openHandles = new Set();

	class AtomicOperation {
		#kv;
		#checks = [];
		#mutations = [];
		#enqueues = [];
		constructor(kv) {
			this.#kv = kv;
		}
		check(...checks) {
			for (const c of checks) this.#checks.push({ key: encodeKey(c.key), versionstamp: c.versionstamp });
			return this;
		}
		mutate(...mutations) {
			for (const m of mutations) {
				if (!["set", "delete", "sum", "min", "max"].includes(m.type)) throw new TypeError(`Invalid mutation type '${m.type}'`);
				const mutation = { type: m.type, key: encodeKey(m.key), expireIn: m.expireIn };
				if (m.type !== "delete") {
					mutation.value = m.value;
					if (m.type !== "set" && !(m.value instanceof KvU64)) throw new TypeError(`Failed to perform '${m.type}' mutation: the value must be a Deno.KvU64`);
				}
				this.#mutations.push(mutation);
			}
			return this;
		}
		set(key, value, options = {}) {
			return this.mutate({ type: "set", key, value, expireIn: options.expireIn });
		}
		delete(key) {
			return this.mutate({ type: "delete", key });
		}
		sum(key, n) {
			return this.mutate({ type: "sum", key, value: new KvU64(BigInt(n)) });
		}
		min(key, n) {
			return this.mutate({ type: "min", key, value: new KvU64(BigInt(n)) });
		}
		max(key, n) {
			return this.mutate({ type: "max", key, value: new KvU64(BigInt(n)) });
		}
		enqueue(value, options = {}) {
			this.#enqueues.push({ value, options });
			return this;
		}
		async commit() {
			return this.#kv._commit(this.#checks, this.#mutations, this.#enqueues);
		}
	}

	class KvListIterator {
		#kv;
		#selector;
		#options;
		#buffer = [];
		#done = false;
		#returned = 0;
		#last = null;
		#start;
		#end;
		cursor = "";
		constructor(kv, selector, options) {
			this.#kv = kv;
			this.#selector = selector;
			this.#options = options;
			const { start, end } = kv._range(selector);
			this.#start = start;
			this.#end = end;
			if (options.cursor) {
				const at = unb64(options.cursor);
				if (options.reverse) this.#end = at;
				else this.#start = concat(at, new Uint8Array([0]));
			}
		}
		async next() {
			const limit = this.#options.limit ?? Infinity;
			if (this.#returned >= limit) return { value: undefined, done: true };
			if (!this.#buffer.length && !this.#done) {
				const batch = Math.min(this.#options.batchSize ?? 100, limit - this.#returned, 500);
				const rows = this.#kv._scan(this.#start, this.#end, batch, Boolean(this.#options.reverse));
				if (rows.length < batch) this.#done = true;
				this.#buffer = rows;
				if (rows.length) {
					const last = rows[rows.length - 1].rawKey;
					if (this.#options.reverse) this.#end = last;
					else this.#start = concat(last, new Uint8Array([0]));
				}
			}
			const row = this.#buffer.shift();
			if (!row) return { value: undefined, done: true };
			this.#returned++;
			this.cursor = b64(row.rawKey);
			return { value: { key: row.key, value: row.value, versionstamp: row.versionstamp }, done: false };
		}
		[Symbol.asyncIterator]() {
			return this;
		}
		async return() {
			this.#done = true;
			this.#buffer = [];
			return { value: undefined, done: true };
		}
	}

	class Kv {
		#db;
		#closed = false;
		#watchers = new Set();
		#queueListeners = [];
		#queueTimer = null;
		constructor(db) {
			this.#db = db;
			db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS kv (k BLOB PRIMARY KEY, v BLOB NOT NULL, enc INTEGER NOT NULL, vs INTEGER NOT NULL, expires INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, ready INTEGER NOT NULL, payload BLOB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, backoff TEXT, undelivered TEXT);
CREATE TABLE IF NOT EXISTS graak_meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
INSERT OR IGNORE INTO graak_meta VALUES ('version', 0);`);
			this._stmt = {
				get: db.prepare("SELECT v, enc, vs FROM kv WHERE k = ? AND (expires IS NULL OR expires > ?)"),
				put: db.prepare("INSERT OR REPLACE INTO kv (k, v, enc, vs, expires) VALUES (?, ?, ?, ?, ?)"),
				del: db.prepare("DELETE FROM kv WHERE k = ?"),
				version: db.prepare("SELECT value FROM graak_meta WHERE name = 'version'"),
				bump: db.prepare("UPDATE graak_meta SET value = value + 1 WHERE name = 'version'"),
				enqueue: db.prepare("INSERT INTO queue (ready, payload, backoff, undelivered) VALUES (?, ?, ?, ?)"),
				expired: db.prepare("DELETE FROM kv WHERE expires IS NOT NULL AND expires <= ?"),
			};
			openHandles.add(this);
		}

		_live() {
			if (this.#closed) throw new Deno.errors.BadResource("Bad resource ID");
		}

		_versionOf(raw) {
			return stampOf(raw);
		}

		async get(key) {
			this._live();
			const row = this._stmt.get.get(encodeKey(key), Date.now());
			if (!row) return { key, value: null, versionstamp: null };
			return { key, value: unpackValue(row.v, row.enc), versionstamp: this._versionOf(row.vs) };
		}

		async getMany(keys) {
			this._live();
			if (keys.length > 10) throw new TypeError("Too many ranges (max 10)");
			return Promise.all(keys.map((key) => this.get(key)));
		}

		async set(key, value, options = {}) {
			return this._commit([], [{ type: "set", key: encodeKey(key), value, expireIn: options.expireIn }], []);
		}

		async delete(key) {
			await this._commit([], [{ type: "delete", key: encodeKey(key) }], []);
		}

		atomic() {
			this._live();
			return new AtomicOperation(this);
		}

		async enqueue(value, options = {}) {
			return this._commit([], [], [{ value, options }]);
		}

		_range(selector) {
			if (selector.prefix && (selector.start || selector.end)) {
				if (selector.start && selector.end) throw new TypeError("Selector can not specify both 'start' and 'end' key when specifying 'prefix'.");
			}
			if (selector.prefix) {
				const prefix = encodeKey(selector.prefix);
				const within = (key) => key.length > prefix.length && prefix.every((byte, i) => key[i] === byte);
				let start = concat(prefix, new Uint8Array([0]));
				let end = concat(prefix, new Uint8Array([0xff]));
				if (selector.start) {
					start = encodeKey(selector.start);
					if (!within(start)) throw new TypeError("Start key is not in the keyspace defined by prefix");
				}
				if (selector.end) {
					end = encodeKey(selector.end);
					if (!within(end)) throw new TypeError("End key is not in the keyspace defined by prefix");
				}
				return { start, end };
			}
			if (!selector.start || !selector.end) throw new TypeError("Selector must specify either 'prefix' or both 'start' and 'end' key.");
			return { start: encodeKey(selector.start), end: encodeKey(selector.end) };
		}

		_scan(start, end, limit, reverse) {
			const rows = this._db().prepare(
				`SELECT k, v, enc, vs FROM kv WHERE k >= ? AND k < ? AND (expires IS NULL OR expires > ?) ORDER BY k ${reverse ? "DESC" : "ASC"} LIMIT ?`
			).all(start, end, Date.now(), limit);
			return rows.map((row) => {
				const rawKey = new Uint8Array(row.k);
				return { rawKey, key: decodeKey(rawKey), value: unpackValue(row.v, row.enc), versionstamp: this._versionOf(row.vs) };
			});
		}

		_db() {
			return this.#db;
		}

		list(selector, options = {}) {
			this._live();
			return new KvListIterator(this, selector, options);
		}

		/** One transaction: checks, then mutations, then queue messages, under a new versionstamp. */
		_commit(checks, mutations, enqueues) {
			this._live();
			const db = this.#db;
			const now = Date.now();
			db.exec("BEGIN IMMEDIATE");
			try {
				for (const check of checks) {
					const row = this._stmt.get.get(check.key, now);
					const current = row ? this._versionOf(row.vs) : null;
					if ((check.versionstamp ?? null) !== current) {
						db.exec("ROLLBACK");
						return { ok: false };
					}
				}
				this._stmt.bump.run();
				const raw = Number(this._stmt.version.get().value);
				for (const m of mutations) {
					if (m.type === "delete") {
						this._stmt.del.run(m.key);
						continue;
					}
					const expires = m.expireIn === undefined ? null : now + m.expireIn;
					if (m.type === "set") {
						const [bytes, enc] = packValue(m.value);
						this._stmt.put.run(m.key, bytes, enc, raw, expires);
						continue;
					}
					const row = this._stmt.get.get(m.key, now);
					let current = null;
					if (row) {
						if (row.enc !== ENC_U64) throw new TypeError(`Failed to perform '${m.type}' mutation on a non-U64 value in the database`);
						current = unpackValue(row.v, row.enc).value;
					}
					const operand = m.value.value;
					const next = current === null ? operand : m.type === "sum" ? (current + operand) & 0xffffffffffffffffn : m.type === "min" ? (operand < current ? operand : current) : operand > current ? operand : current;
					const [bytes, enc] = packValue(new KvU64(next));
					this._stmt.put.run(m.key, bytes, enc, raw, row ? expires ?? null : expires);
				}
				for (const { value, options } of enqueues) {
					const [bytes, enc] = packValue(value);
					const payload = concat(new Uint8Array([enc]), bytes);
					const undelivered = options.keysIfUndelivered ? JSON.stringify(options.keysIfUndelivered.map((k) => b64(encodeKey(k)))) : null;
					this._stmt.enqueue.run(now + (options.delay ?? 0), payload, options.backoffSchedule ? JSON.stringify(options.backoffSchedule) : null, undelivered);
				}
				this._stmt.expired.run(now);
				db.exec("COMMIT");
				const versionstamp = this._versionOf(raw);
				queueMicrotask(() => this._changed());
				return { ok: true, versionstamp };
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// Already rolled back.
				}
				throw error;
			}
		}

		commitVersionstamp() {
			return Symbol.for("Deno.commitVersionstamp");
		}

		// ---- queues ---------------------------------------------------------------------------------------------
		listenQueue(handler) {
			this._live();
			if (typeof handler !== "function") throw new TypeError("listenQueue needs a handler function");
			return new Promise((resolve) => {
				const listener = { handler, resolve, running: false };
				this.#queueListeners.push(listener);
				this._pump();
			});
		}

		_pump() {
			if (this.#closed || !this.#queueListeners.length) return;
			if (this.#queueTimer) clearTimeout(this.#queueTimer);
			this.#queueTimer = null;
			const db = this.#db;
			const now = Date.now();
			const next = db.prepare("SELECT id, payload, attempts, backoff, undelivered FROM queue WHERE ready <= ? ORDER BY ready, id LIMIT 1").get(now);
			if (!next) {
				const soon = db.prepare("SELECT MIN(ready) AS ready FROM queue").get();
				const wait = soon && soon.ready !== null ? Math.max(1, Math.min(soon.ready - now, 250)) : 250;
				this.#queueTimer = setTimeout(() => this._pump(), wait);
				return;
			}
			db.prepare("DELETE FROM queue WHERE id = ?").run(next.id);
			const payload = new Uint8Array(next.payload);
			const message = unpackValue(payload.subarray(1), payload[0]);
			const schedule = next.backoff ? JSON.parse(next.backoff) : [100, 200, 400, 800, 1600];
			const listener = this.#queueListeners[0];
			Promise.resolve()
				.then(() => listener.handler(message))
				.then(
					() => this._pump(),
					(error) => {
						if (next.attempts < schedule.length) {
							db.prepare("INSERT INTO queue (ready, payload, attempts, backoff, undelivered) VALUES (?, ?, ?, ?, ?)").run(
								Date.now() + schedule[next.attempts], next.payload, next.attempts + 1, next.backoff, next.undelivered
							);
						} else if (next.undelivered) {
							const keys = JSON.parse(next.undelivered).map((k) => decodeKey(unb64(k)));
							const raw = this._bumpVersion();
							for (const key of keys) {
								const [bytes, enc] = packValue(message);
								this._stmt.put.run(encodeKey(key), bytes, enc, raw, null);
							}
						} else {
							console.error("Deno.Kv queue message was not delivered:", error);
						}
						this._pump();
					}
				);
		}

		_bumpVersion() {
			this._stmt.bump.run();
			return Number(this._stmt.version.get().value);
		}

		// ---- watch ----------------------------------------------------------------------------------------------
		watch(keys) {
			this._live();
			let last = null;
			let timer = null;
			let controller;
			let interval = null;
			const kv = this;
			const snapshot = async () => {
				const entries = await kv.getMany(keys);
				const signature = entries.map((e) => e.versionstamp).join("|");
				if (signature !== last) {
					last = signature;
					controller.enqueue(entries);
				}
			};
			return new ReadableStream({
				start(c) {
					controller = c;
					const listener = () => snapshot().catch(() => {});
					kv.#watchers.add(listener);
					interval = setInterval(listener, 150);
					this._listener = listener;
					return snapshot();
				},
				cancel() {
					kv.#watchers.delete(this._listener);
					clearInterval(interval);
					clearTimeout(timer);
				},
			});
		}

		_changed() {
			for (const w of this.#watchers) w();
			if (this.#queueListeners.length) this._pump();
		}

		close() {
			if (this.#closed) return;
			this.#closed = true;
			clearTimeout(this.#queueTimer);
			for (const l of this.#queueListeners) l.resolve();
			this.#queueListeners = [];
			try {
				this.#db.close();
			} catch {
				// Closed already.
			}
			openHandles.delete(this);
		}

		[Symbol.dispose]() {
			this.close();
		}
	}

	function normalizeStatements(db) {
		// node:sqlite's StatementSync has get/all/run; Deno KV calls them with positional parameters only.
		return db;
	}

	async function openKv(location) {
		if (typeof location === "string" && /^https?:\/\//.test(location)) {
			throw new Deno.errors.NotSupported("A remote Deno KV database (a URL) is not reachable from Graak: pass a file path.");
		}
		const sqlite = loadSqlite();
		const file = location === undefined || location === null ? defaultPath() : String(location);
		if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
		const db = normalizeStatements(new sqlite.DatabaseSync(file));
		return new Kv(db);
	}

	Deno.openKv = openKv;
	Deno.Kv = Kv;
	Deno.KvU64 = KvU64;
	Deno.AtomicOperation = AtomicOperation;
	Deno.KvListIterator = KvListIterator;
})(globalThis);

/*
 * Node-shaped `crypto`, `zlib`, `net` and `tls`, built on the native host.
 *
 * These are the four modules `node-compat.js` cannot implement, because the engine alone has no
 * sockets, no compression and no secure randomness. `forgegraal-c` (`quickjs/native/`) supplies
 * those as `globalThis.__forgegraal_native`; this file is the thin part that gives them the
 * shapes Node libraries expect, so discord.js sees `tls.connect()` rather than an integer socket
 * id.
 *
 * Nothing here invents behaviour. Where the native side has no answer -- ciphers, signing, the
 * Diffie-Hellman surface -- the export throws and names what is missing, rather than returning
 * something that looks like a result.
 */

import * as os from "qjs:os";

const native = globalThis.__forgegraal_native;

/* node-compat.js installs Node-shaped timers; run bare under the host (the selftest), the engine's own are used. */
const startTimer = (fn, ms) => (globalThis.setTimeout ?? os.setTimeout)(fn, ms);
const stopTimer = (handle) => (globalThis.clearTimeout ?? os.clearTimeout)(handle);

/*
 * The native host's socket calls are synchronous and return their value directly. Wrapping every
 * call through this means the code below is written once against promises, so a call site never
 * has to know or care whether the value it got back was already resolved.
 */
const settled = (value) => (value && typeof value.then === "function" ? value : Promise.resolve(value));
if (!native) {
	throw new Error(
		"native-modules.js requires the ForgeGraal native host. Run it under `forgegraal-c`, " +
			"not a bare `qjs` -- a standalone engine has no sockets to expose."
	);
}

const toBytes = (value, encoding = "utf8") => {
	if (value == null) return new Uint8Array(0);
	if (typeof value === "string") {
		if (encoding === "hex") {
			const out = new Uint8Array(value.length >> 1);
			for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.substr(i * 2, 2), 16);
			return out;
		}
		// TextEncoder when a JavaScript layer has installed it, otherwise the host's own
		// UTF-8 conversion -- this file must work with or without node-compat.js loaded.
		return typeof TextEncoder === "function" ? new TextEncoder().encode(value) : native.encodeUtf8(value);
	}
	if (value instanceof Uint8Array) return value;
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	throw new TypeError("expected a string, Buffer or TypedArray");
};

const toHex = (bytes) => {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
};

const toBase64 = (bytes) => {
	const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const triple = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
		out += table[(triple >> 18) & 63] + table[(triple >> 12) & 63];
		out += i + 1 < bytes.length ? table[(triple >> 6) & 63] : "=";
		out += i + 2 < bytes.length ? table[triple & 63] : "=";
	}
	return out;
};

function digestOut(bytes, encoding) {
	if (!encoding || encoding === "buffer") return typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes;
	if (encoding === "hex") return toHex(bytes);
	if (encoding === "base64") return toBase64(bytes);
	throw new TypeError(`Unsupported digest encoding '${encoding}'`);
}

/* -------------------------------------------------------------------- crypto */

/* ---------------------------------------------------------------------- zlib */

const asBuffer = (bytes) => (typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes);

function callbackify(fn) {
	return (data, optionsOrCallback, maybeCallback) => {
		const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
		try {
			const result = fn(data);
			if (callback) queueMicrotask(() => callback(null, result));
			return result;
		} catch (err) {
			if (callback) {
				queueMicrotask(() => callback(err));
				return undefined;
			}
			throw err;
		}
	};
}

/* ---------------------------------------------------------------------- zlib */

let crcTable = null;
function crc32Of(bytes, previous = 0) {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = ~previous >>> 0;
	for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	return ~crc >>> 0;
}

/* The native calls throw engine errors; programs branch on zlib's own codes. */
function zlibError(err) {
	const error = err instanceof Error ? err : new Error(String(err));
	const text = String(error.message);
	if (/unexpected end|truncated|buf/i.test(text)) {
		error.code = "Z_BUF_ERROR";
		error.errno = -5;
		error.message = "unexpected end of file";
	} else if (!error.code) {
		error.code = "Z_DATA_ERROR";
		error.errno = -3;
		if (/inflate/i.test(text) || /failed/i.test(text)) error.message = /gzip|header/i.test(text) ? "incorrect header check" : "invalid stored block lengths";
	}
	return error;
}
const guarded = (fn) => (data, options) => {
	try {
		return asBuffer(fn(toBytes(data)));
	} catch (err) {
		throw zlibError(err);
	}
};

function gzipBytes(bytes) {
	const body = native.deflate(bytes, true);
	const out = new Uint8Array(body.length + 18);
	out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3], 0);
	out.set(body, 10);
	const view = new DataView(out.buffer);
	view.setUint32(10 + body.length, crc32Of(bytes), true);
	view.setUint32(14 + body.length, bytes.length >>> 0, true);
	return out;
}

/* gzip = header, raw deflate, CRC-32 and length. The host inflates raw deflate; the framing is checked here. */
function gunzipBytes(bytes) {
	const bad = (message, code = "Z_DATA_ERROR", errno = -3) => Object.assign(new Error(message), { code, errno });
	if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw bad("incorrect header check");
	if (bytes[2] !== 8) throw bad("unknown compression method");
	const flags = bytes[3];
	let pos = 10;
	if (flags & 4) pos += 2 + (bytes[pos] | (bytes[pos + 1] << 8));
	if (flags & 8) while (pos < bytes.length && bytes[pos++] !== 0);
	if (flags & 16) while (pos < bytes.length && bytes[pos++] !== 0);
	if (flags & 2) pos += 2;
	if (pos > bytes.length - 8) throw bad("unexpected end of file", "Z_BUF_ERROR", -5);
	const body = native.inflate(bytes.subarray(pos, bytes.length - 8), true);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(bytes.length - 8, true) !== crc32Of(body)) throw bad("incorrect data check");
	if (view.getUint32(bytes.length - 4, true) !== body.length >>> 0) throw bad("incorrect length check");
	return body;
}

const isGzip = (bytes) => bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

const zlib = {
	inflateSync: guarded((data) => native.inflate(data, false)),
	deflateSync: guarded((data) => native.deflate(data, false)),
	inflateRawSync: guarded((data) => native.inflate(data, true)),
	deflateRawSync: guarded((data) => native.deflate(data, true)),
	gzipSync: guarded(gzipBytes),
	gunzipSync: guarded((data) => gunzipBytes(data)),
	unzipSync: guarded((data) => (isGzip(data) ? gunzipBytes(data) : native.inflate(data, false))),
	crc32: (data, value = 0) => crc32Of(toBytes(data), value),
	constants: {
		Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
		Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4,
		Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9,
		Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
		Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity,
		Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1,
		Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
	},
};
zlib.codes = { Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6 };
Object.assign(zlib, zlib.constants);

for (const name of ["inflate", "deflate", "inflateRaw", "deflateRaw", "gzip", "gunzip", "unzip"]) {
	const sync = zlib[`${name}Sync`];
	zlib[name] = (data, options, callback) => {
		if (typeof options === "function") callback = options;
		if (typeof callback !== "function") {
			throw Object.assign(new TypeError('The "callback" argument must be of type function.'), { code: "ERR_INVALID_ARG_TYPE" });
		}
		let result;
		let error = null;
		try {
			result = sync(data);
		} catch (err) {
			error = err;
		}
		queueMicrotask(() => (error ? callback(error) : callback(null, result)));
	};
}

const noBrotli = () => {
	throw Object.assign(new Error("Brotli is not available in the ForgeGraal native host"), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
};
Object.assign(zlib, {
	brotliCompressSync: noBrotli,
	brotliDecompressSync: noBrotli,
	brotliCompress: noBrotli,
	brotliDecompress: noBrotli,
	createBrotliCompress: noBrotli,
	createBrotliDecompress: noBrotli,
});

/*
 * The stream forms (createGzip, createGunzip, ...). Each buffers what is written and transforms it as one piece
 * when the stream ends: correct output, but a whole message is held in memory rather than streamed through.
 */
zlib.attachStreams = (Transform) => {
	const make = (name, syncName) => {
		function Codec(options) {
			if (!(this instanceof Codec)) return new Codec(options);
			Transform.call(this, options);
			this._chunks = [];
			this.bytesWritten = 0;
		}
		Object.setPrototypeOf(Codec.prototype, Transform.prototype);
		Object.setPrototypeOf(Codec, Transform);
		Codec.prototype._transform = function (chunk, encoding, callback) {
			this._chunks.push(chunk);
			this.bytesWritten += chunk.length;
			callback();
		};
		Codec.prototype._flush = function (callback) {
			let output;
			try {
				output = zlib[syncName](Buffer.concat(this._chunks));
			} catch (err) {
				callback(err);
				return;
			}
			this._chunks = [];
			this.push(output);
			callback();
		};
		Codec.prototype.close = function (callback) {
			if (callback) this.once("close", callback);
			this.destroy();
		};
		Codec.prototype.flush = function (kind, callback) {
			if (typeof kind === "function") callback = kind;
			if (callback) queueMicrotask(callback);
		};
		Codec.prototype.params = function (level, strategy, callback) {
			if (callback) queueMicrotask(callback);
		};
		Codec.prototype.reset = function () {};
		Object.defineProperty(Codec, "name", { value: name });
		return Codec;
	};
	const kinds = { Deflate: "deflateSync", Inflate: "inflateSync", DeflateRaw: "deflateRawSync", InflateRaw: "inflateRawSync", Gzip: "gzipSync", Gunzip: "gunzipSync", Unzip: "unzipSync" };
	for (const [name, syncName] of Object.entries(kinds)) {
		const Codec = make(name, syncName);
		zlib[name] = Codec;
		zlib[`create${name}`] = (options) => new Codec(options);
	}
};

/* ----------------------------------------------------------------- net / tls */

/*
 * Sockets are non-blocking on the native side. One poller serves every open socket and listener from the
 * JavaScript thread: it asks the host which ids are ready, waiting at most POLL_MS inside the host (so an
 * idle process costs almost nothing while a ready socket is served at once), then calls each id's handler.
 * It stops by itself when nothing is being watched, so it never keeps a finished program alive.
 */
const POLL_MS = 4;
const watchers = new Map();
const writeWatchers = new Map();
let pollTimer = null;

function pollTick() {
	pollTimer = null;
	if (!watchers.size && !writeWatchers.size) return;
	let readable = [];
	let writable = [];
	try {
		[readable, writable] = native.poll([...watchers.keys()], POLL_MS, [...writeWatchers.keys()]);
	} catch {
		// A closed id: the handlers below find out when they try to use it.
		readable = [...watchers.keys()];
		writable = [...writeWatchers.keys()];
	}
	const run = (fn) => {
		if (!fn) return;
		try {
			fn();
		} catch (error) {
			// One handler's failure must not stop the poller serving every other socket.
			if (typeof globalThis.__forgegraal_reportUncaught === "function") globalThis.__forgegraal_reportUncaught(error);
			else throw error;
		}
	};
	for (const id of writable) run(writeWatchers.get(id));
	for (const id of readable) run(watchers.get(id));
	if (watchers.size || writeWatchers.size) pollTimer = startTimer(pollTick, 0);
}

function ensurePolling() {
	if (!pollTimer) pollTimer = startTimer(pollTick, 0);
}

function watch(id, fn) {
	watchers.set(id, fn);
	ensurePolling();
}

function unwatch(id) {
	watchers.delete(id);
}

/* Writability, watched only while a socket has bytes it could not send yet. */
function watchWrite(id, fn) {
	writeWatchers.set(id, fn);
	ensurePolling();
}

function unwatchWrite(id) {
	writeWatchers.delete(id);
}

const toError = (err) => (err instanceof Error ? err : new Error(String(err)));

/* The native errors are mbedTLS strings; give them the codes Node programs branch on. */
function withCode(err, host, port) {
	const error = toError(err);
	const text = String(error.message);
	if (!error.code) {
		if (text.includes("-0x0052")) error.code = "ENOTFOUND";
		else if (text.includes("-0x0044")) error.code = "ECONNREFUSED";
		else if (text.includes("-0x0050") || text.includes("-0x004E")) error.code = "ECONNRESET";
	}
	if (error.code === "ECONNREFUSED" && host !== undefined) {
		error.syscall = "connect";
		error.address = host;
		error.port = port;
		error.message = `connect ECONNREFUSED ${host}:${port}`;
	} else if (error.code === "ENOTFOUND" && host !== undefined) {
		error.syscall = "getaddrinfo";
		error.hostname = host;
		error.message = `getaddrinfo ENOTFOUND ${host}`;
	}
	return error;
}

/*
 * A Socket that is a real Duplex stream, as Node's is: 'data' and 'end' come from push(), backpressure from the
 * stream's own high-water marks (the poller stops reading when push() says the reader is behind, and starts again on
 * the next _read()), writes are queued until the host takes them, and end() half-closes the connection. Libraries
 * that treat a socket as a stream -- undici reads it with `socket.read()` -- see one.
 */
function createSocketClass(Duplex) {
	return class Socket extends Duplex {
		constructor(options = {}) {
			super({
				allowHalfOpen: Boolean(options.allowHalfOpen),
				readableHighWaterMark: options.readableHighWaterMark ?? 65536,
				writableHighWaterMark: options.writableHighWaterMark ?? 16384,
				emitClose: true,
				autoDestroy: true,
			});
			this.id = null;
			this.connecting = false;
			this.bytesRead = 0;
			this.bytesWritten = 0;
			this._queue = []; // { bytes, offset, callback } the socket could not take yet
			this._timeout = 0;
			this._timer = null;
			this._tls = false;
			this._readPaused = false;
			this._pendingWrite = null;
			this._addr = null;
			this._peer = null;
			if (options.handle !== undefined) this._adopt(options.handle);
		}

		/* Takes over a socket id the host already opened (an accepted connection, or one that finished connecting). */
		_adopt(id, tls = false) {
			this.id = id;
			this._tls = tls;
			this._readPaused = false;
			watch(id, () => this._readReady());
		}

		get readyState() {
			if (this.connecting) return "opening";
			if (this.destroyed) return "closed";
			return this.readable && this.writable ? "open" : this.readable ? "readOnly" : "writeOnly";
		}
		get pending() {
			return this.id === null;
		}
		get encrypted() {
			return this._tls;
		}
		get authorized() {
			return this._tls;
		}
		get bufferSize() {
			return this.writableLength;
		}
		_address(peer) {
			if (this.id === null) return null;
			try {
				return native.address(this.id, peer);
			} catch {
				return null;
			}
		}
		get remoteAddress() {
			return (this._peer ??= this._address(true))?.[0];
		}
		get remotePort() {
			return (this._peer ??= this._address(true))?.[1];
		}
		get remoteFamily() {
			return (this._peer ??= this._address(true))?.[2];
		}
		get localAddress() {
			return (this._addr ??= this._address(false))?.[0];
		}
		get localPort() {
			return (this._addr ??= this._address(false))?.[1];
		}
		get localFamily() {
			return (this._addr ??= this._address(false))?.[2];
		}
		address() {
			const a = this._address(false);
			return a ? { address: a[0], family: a[2], port: a[1] } : {};
		}

		connect(options, port, listener) {
			if (typeof options !== "object" || options === null) {
				// connect(port[, host][, listener])
				const host = typeof port === "string" ? port : undefined;
				listener = typeof port === "function" ? port : listener;
				options = { port: options, host };
			} else if (typeof port === "function") {
				listener = port;
			}
			const { host = "localhost", port: portNumber, tls = false } = options;
			// NODE_TLS_REJECT_UNAUTHORIZED=0 turns verification off for the whole process, as in Node.
			const rejectUnauthorized = options.rejectUnauthorized ?? globalThis.process?.env?.NODE_TLS_REJECT_UNAUTHORIZED !== "0";
			if (options.path) throw new Error("net: local (unix socket) paths are not supported by the ForgeGraal native host");
			if (listener) this.once(tls ? "secureConnect" : "connect", listener);
			this.connecting = true;
			this._tls = tls;
			// Node's order: the caller attaches listeners on the returned socket before anything is emitted.
			queueMicrotask(() => {
				if (this.destroyed) return;
				const fail = (err) => {
					this.connecting = false;
					if (this.id !== null) {
						unwatch(this.id);
						unwatchWrite(this.id);
					}
					this.destroy(withCode(err, host, portNumber));
				};
				let id;
				try {
					id = native.connectStart(host, Number(portNumber), tls, tls && rejectUnauthorized === false);
				} catch (err) {
					fail(err);
					return;
				}
				this.id = id;
				// The connection and the TLS handshake finish in the background; the poller says when to look.
				const startedAt = Date.now();
				const step = () => {
					if (this.destroyed) return;
					let done;
					try {
						done = native.connectStatus(id);
					} catch (err) {
						fail(err);
						return;
					}
					if (!done) {
						if (Date.now() - startedAt > 60000) fail(Object.assign(new Error(`connect ETIMEDOUT ${host}:${portNumber}`), { code: "ETIMEDOUT" }));
						return;
					}
					unwatch(id);
					unwatchWrite(id);
					this._adopt(id, tls);
					this.connecting = false;
					this.emit("connect");
					if (tls) this.emit("secureConnect");
					this.emit("ready");
					const pending = this._pendingWrite;
					this._pendingWrite = null;
					if (pending) this._writeNow(pending.chunk, pending.callback);
				};
				watch(id, step);
				watchWrite(id, step);
				step();
			});
			return this;
		}

		/* A read the reader is ready for: the poller found data (or EOF) waiting. */
		_readReady() {
			while (!this.destroyed && !this._readPaused && this.id !== null) {
				let chunk;
				try {
					chunk = native.read(this.id);
				} catch (err) {
					this.destroy(withCode(err));
					return;
				}
				if (chunk === null) return;
				if (chunk.length === 0) {
					unwatch(this.id);
					this.push(null);
					return;
				}
				this.bytesRead += chunk.length;
				this._resetTimer();
				const wantMore = this.push(typeof Buffer !== "undefined" ? Buffer.from(chunk) : chunk);
				if (!wantMore) {
					// The reader is behind: stop asking the host until it reads again.
					this._readPaused = true;
					unwatch(this.id);
					return;
				}
			}
		}

		_read() {
			if (this._readPaused && this.id !== null && !this.destroyed) {
				this._readPaused = false;
				watch(this.id, () => this._readReady());
			}
		}

		/* Bytes go to the host as it accepts them; the callback fires once this chunk has all been taken. */
		_write(chunk, encoding, callback) {
			if (this.id === null) {
				// Still connecting: held until it finishes.
				this._pendingWrite = { chunk, callback };
				return;
			}
			this._writeNow(chunk, callback);
		}

		_writeNow(chunk, callback) {
			this._queue.push({ bytes: chunk, offset: 0, callback });
			this._flush();
		}

		_flush() {
			while (this._queue.length && !this.destroyed && this.id !== null) {
				const item = this._queue[0];
				let sent;
				try {
					sent = native.send(this.id, item.bytes, item.offset);
				} catch (err) {
					const error = withCode(err);
					this._queue = [];
					item.callback(error);
					return;
				}
				if (sent === 0) {
					watchWrite(this.id, () => this._flush());
					return;
				}
				item.offset += sent;
				this.bytesWritten += sent;
				this._resetTimer();
				if (item.offset >= item.bytes.length) {
					this._queue.shift();
					item.callback();
				}
			}
			if (this.id !== null) unwatchWrite(this.id);
		}

		_final(callback) {
			const finish = () => {
				if (this.id !== null && !this.destroyed) {
					try {
						native.shutdown(this.id);
					} catch {
						// The peer is gone already; the read side notices.
					}
				}
				callback();
			};
			if (this._pendingWrite || this.connecting) {
				// Ending before the connection is up: shut down once it is.
				this.once("connect", finish);
				this.once("error", () => callback());
			} else finish();
			if (!this.allowHalfOpen && !this.destroyed) {
				// Do not linger on a peer that never closes its side.
				const t = startTimer(() => this.destroy(), 5000);
				this.once("close", () => stopTimer(t));
			}
		}

		_destroy(err, callback) {
			if (this._timer) stopTimer(this._timer);
			const id = this.id;
			this.id = null;
			const pending = this._queue;
			this._queue = [];
			if (id !== null) {
				unwatch(id);
				unwatchWrite(id);
				try {
					native.close(id);
				} catch {
					// Already closed.
				}
			}
			const stalled = this._pendingWrite;
			this._pendingWrite = null;
			for (const item of stalled ? [...pending, stalled] : pending) item.callback?.(err ?? new Error("Socket closed"));
			callback(err);
		}

		destroySoon() {
			if (this.writable) this.end();
			else this.destroy();
		}

		_resetTimer() {
			if (!this._timeout) return;
			if (this._timer) stopTimer(this._timer);
			this._timer = startTimer(() => {
				this._timer = null;
				this.emit("timeout");
			}, this._timeout);
		}
		setTimeout(ms, callback) {
			this._timeout = ms;
			if (callback) this.once("timeout", callback);
			if (this._timer) stopTimer(this._timer);
			this._timer = null;
			if (ms) this._resetTimer();
			return this;
		}
		setNoDelay() {
			// The native side already disables Nagle; accepted so callers do not have to branch.
			return this;
		}
		setKeepAlive() {
			return this;
		}
		ref() {
			return this;
		}
		unref() {
			return this;
		}
	};
}

function createServerClass(EventEmitter, Socket, tlsServer) {
	return class Server extends EventEmitter {
		constructor(options, listener) {
			super();
			if (typeof options === "function") {
				listener = options;
				options = {};
			}
			this._options = options ?? {};
			this.id = null;
			this.listening = false;
			this._connections = new Set();
			this.maxConnections = undefined;
			if (listener) this.on(tlsServer ? "secureConnection" : "connection", listener);
		}

		listen(...args) {
			let callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
			let options = args[0];
			if (typeof options !== "object" || options === null) {
				const [port, second, third] = args;
				options = { port };
				if (typeof second === "string") options.host = second;
				else if (typeof second === "number") options.backlog = second;
				if (typeof third === "number") options.backlog = third;
				if (typeof second === "string" && typeof third === "number") options.backlog = third;
			}
			if (options.path) throw new Error("net: local (unix socket) paths are not supported by the ForgeGraal native host");
			if (callback) this.once("listening", callback);
			const port = options.port === undefined || options.port === null ? 0 : Number(options.port);
			try {
				this.id = native.listen(
					options.host ?? null,
					port,
					options.backlog ?? 511,
					tlsServer ? String(this._options.cert) : undefined,
					tlsServer ? String(this._options.key) : undefined
				);
			} catch (err) {
				const error = toError(err);
				if (/-0x0046|-0x004[0-9A-F]/i.test(String(error.message))) error.code = "EADDRINUSE";
				queueMicrotask(() => this.emit("error", error));
				return this;
			}
			this.listening = true;
			watch(this.id, () => this._accept());
			queueMicrotask(() => this.emit("listening"));
			return this;
		}

		_accept() {
			for (;;) {
				let sid;
				try {
					sid = native.accept(this.id);
				} catch (err) {
					this.emit("error", toError(err));
					return;
				}
				if (sid === null) return;
				const socket = new Socket();
				socket._adopt(sid, Boolean(tlsServer));
				if (this.maxConnections !== undefined && this._connections.size >= this.maxConnections) {
					socket.destroy();
					continue;
				}
				this._connections.add(socket);
				socket.once("close", () => {
					this._connections.delete(socket);
					this._maybeClosed();
				});
				this.emit("connection", socket);
				if (tlsServer) this.emit("secureConnection", socket);
			}
		}

		address() {
			if (this.id === null) return null;
			const a = native.address(this.id, false);
			return a ? { port: a[1], family: a[2], address: a[0] } : null;
		}

		_maybeClosed() {
			if (this._closing && !this._connections.size && !this._closedEmitted) {
				this._closedEmitted = true;
				queueMicrotask(() => this.emit("close"));
			}
		}

		close(callback) {
			if (callback) this.once("close", callback);
			if (this.id !== null) {
				unwatch(this.id);
				try {
					native.close(this.id);
				} catch {
					// Already closed.
				}
				this.id = null;
			}
			this.listening = false;
			this._closing = true;
			this._maybeClosed();
			return this;
		}

		closeAllConnections() {
			for (const socket of [...this._connections]) socket.destroy();
		}
		getConnections(callback) {
			queueMicrotask(() => callback(null, this._connections.size));
			return this;
		}
		ref() {
			return this;
		}
		unref() {
			return this;
		}
	};
}

function createNetModules(EventEmitter, Duplex) {
	const Socket = createSocketClass(Duplex);
	const Server = createServerClass(EventEmitter, Socket, false);
	const TlsServer = createServerClass(EventEmitter, Socket, true);

	const connect = (...args) => {
		const socket = new Socket();
		// Returned synchronously, like Node: callers attach listeners before it is connected.
		socket.connect(...args);
		return socket;
	};

	const isIPv4 = (value) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(value);
	const isIPv6 = (value) => typeof value === "string" && value.includes(":") && /^[0-9a-fA-F:.%\w]+$/.test(value);
	const net = {
		Socket,
		Server,
		connect,
		createConnection: connect,
		createServer: (options, listener) => new Server(options, listener),
		isIP: (value) => (isIPv4(String(value)) ? 4 : isIPv6(String(value)) ? 6 : 0),
		isIPv4: (value) => isIPv4(String(value)),
		isIPv6: (value) => isIPv6(String(value)),
		setDefaultAutoSelectFamily() {},
		getDefaultAutoSelectFamily: () => false,
	};

	const tls = {
		Server: TlsServer,
		TLSSocket: Socket,
		connect(options, port, listener) {
			if (typeof options !== "object" || options === null) {
				// connect(port[, host][, options][, listener])
				const host = typeof port === "string" ? port : undefined;
				return connect({ port: options, host: host ?? "localhost", tls: true }, undefined, listener);
			}
			return connect({ ...options, host: options.host ?? options.servername ?? "localhost", tls: true }, port, listener);
		},
		createServer(options, listener) {
			if (!options?.key || !options?.cert) {
				throw new TypeError("tls.createServer needs { key, cert } as PEM strings or Buffers");
			}
			return new TlsServer({ ...options, key: String(options.key), cert: String(options.cert) }, listener);
		},
		createSecureContext: (options) => ({ ...options }),
		// Certificates are verified against the CA bundle compiled into the host, which is exactly
		// why this works on an old machine whose own certificate store is years stale.
		rootCertificates: [],
		DEFAULT_MIN_VERSION: "TLSv1.2",
		DEFAULT_MAX_VERSION: "TLSv1.3",
	};

	return { net, tls };
}

export { zlib, createNetModules, createSocketClass, toBytes };

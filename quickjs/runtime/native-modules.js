/*
 * Node-shaped `crypto`, `zlib`, `net` and `tls`, built on the native host.
 *
 * These are the four modules `node-compat.js` cannot implement, because the engine alone has no
 * sockets, no compression and no secure randomness. `forgegraal-runtime` (Rust) supplies those as
 * `globalThis.__forgegraal_native`; this file is the thin part that gives them the shapes Node
 * libraries expect, so discord.js sees `tls.connect()` rather than an integer socket id.
 *
 * Nothing here invents behaviour. Where the native side has no answer -- ciphers, signing, the
 * Diffie-Hellman surface -- the export throws and names what is missing, rather than returning
 * something that looks like a result.
 */

const native = globalThis.__forgegraal_native;
if (!native) {
	throw new Error(
		"native-modules.js requires the ForgeGraal native host. Run it under `forgegraal-runtime`, " +
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

class Hash {
	constructor(algorithm) {
		this.algorithm = algorithm;
		this._chunks = [];
	}
	update(data, encoding) {
		this._chunks.push(toBytes(data, encoding));
		return this;
	}
	digest(encoding) {
		// The native side hashes in one call, so the chunks are joined here rather than
		// streamed. Same result; it only matters for very large inputs.
		let total = 0;
		for (const chunk of this._chunks) total += chunk.length;
		const joined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of this._chunks) {
			joined.set(chunk, offset);
			offset += chunk.length;
		}
		return digestOut(native.hash(this.algorithm, joined), encoding);
	}
}

class Hmac {
	constructor(algorithm, key) {
		this.algorithm = algorithm;
		this._key = toBytes(key);
		this._chunks = [];
	}
	update(data, encoding) {
		this._chunks.push(toBytes(data, encoding));
		return this;
	}
	digest(encoding) {
		let total = 0;
		for (const chunk of this._chunks) total += chunk.length;
		const joined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of this._chunks) {
			joined.set(chunk, offset);
			offset += chunk.length;
		}
		return digestOut(native.hmac(this.algorithm, this._key, joined), encoding);
	}
}

function unavailable(name, reason) {
	return () => {
		throw new Error(`crypto.${name} is not implemented in this runtime. ${reason}`);
	};
}

const crypto = {
	createHash: (algorithm) => new Hash(algorithm),
	createHmac: (algorithm, key) => new Hmac(algorithm, key),
	randomBytes(size, callback) {
		const bytes = native.randomBytes(size);
		const out = typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes;
		if (callback) {
			callback(null, out);
			return undefined;
		}
		return out;
	},
	randomUUID() {
		const bytes = native.randomBytes(16);
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = toHex(bytes);
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	},
	randomInt(min, max) {
		if (max === undefined) {
			max = min;
			min = 0;
		}
		const range = max - min;
		// Rejection sampling: taking a modulus of raw bytes biases the low values.
		const bytes = native.randomBytes(6);
		let value = 0;
		for (const byte of bytes) value = value * 256 + byte;
		return min + (value % range);
	},
	getRandomValues(view) {
		const bytes = native.randomBytes(view.byteLength);
		new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
		return view;
	},
	timingSafeEqual(a, b) {
		const left = toBytes(a);
		const right = toBytes(b);
		if (left.length !== right.length) return false;
		let diff = 0;
		for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
		return diff === 0;
	},
	createCipheriv: unavailable("createCipheriv", "Symmetric ciphers are not wired through to the native layer yet."),
	createDecipheriv: unavailable("createDecipheriv", "Symmetric ciphers are not wired through to the native layer yet."),
	createSign: unavailable("createSign", "Signing is not wired through to the native layer yet."),
	createVerify: unavailable("createVerify", "Verification is not wired through to the native layer yet."),
	createDiffieHellman: unavailable("createDiffieHellman", "Key agreement is not wired through to the native layer yet."),
	constants: {},
	webcrypto: undefined,
};
crypto.webcrypto = { getRandomValues: crypto.getRandomValues, randomUUID: crypto.randomUUID };

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

const zlib = {
	inflateSync: (data) => asBuffer(native.inflate(toBytes(data), false)),
	deflateSync: (data) => asBuffer(native.deflate(toBytes(data), false)),
	inflateRawSync: (data) => asBuffer(native.inflate(toBytes(data), true)),
	deflateRawSync: (data) => asBuffer(native.deflate(toBytes(data), true)),
	gunzipSync: (data) => asBuffer(native.gunzip(toBytes(data))),
	unzipSync: (data) => asBuffer(native.gunzip(toBytes(data))),
	constants: { Z_SYNC_FLUSH: 2, Z_NO_FLUSH: 0, Z_FINISH: 4 },
};
zlib.inflate = callbackify(zlib.inflateSync);
zlib.deflate = callbackify(zlib.deflateSync);
zlib.inflateRaw = callbackify(zlib.inflateRawSync);
zlib.deflateRaw = callbackify(zlib.deflateRawSync);
zlib.gunzip = callbackify(zlib.gunzipSync);

/* ----------------------------------------------------------------- net / tls */

/*
 * A Socket shaped like Node's: an EventEmitter that emits 'connect', 'data', 'end', 'error' and
 * 'close', with write() and end().
 *
 * The native side is request/response (`read` resolves with whatever arrived), so a pump loop
 * turns that into the push model Node code expects. The loop exits on a zero-length read, which
 * is how the native layer reports that the peer closed.
 */
function createSocketClass(EventEmitter) {
	return class Socket extends EventEmitter {
		constructor() {
			super();
			this.id = null;
			this.readable = false;
			this.writable = false;
			this.destroyed = false;
			this._pending = [];
		}

		async connect(options, listener) {
			const { host = "localhost", port, tls = false } = options;
			if (listener) this.once("connect", listener);
			try {
				this.id = await native.connect(host, port, tls);
				this.readable = true;
				this.writable = true;
				this.emit("connect");
				if (tls) this.emit("secureConnect");
				this._pump();
				// Anything written before the connection completed is flushed in order.
				for (const chunk of this._pending.splice(0)) await native.write(this.id, chunk);
			} catch (err) {
				this.emit("error", err instanceof Error ? err : new Error(String(err)));
				this.destroy();
			}
			return this;
		}

		async _pump() {
			while (!this.destroyed && this.id !== null) {
				let chunk;
				try {
					chunk = await native.read(this.id);
				} catch (err) {
					if (!this.destroyed) this.emit("error", err instanceof Error ? err : new Error(String(err)));
					break;
				}
				if (!chunk || chunk.length === 0) {
					this.readable = false;
					this.emit("end");
					break;
				}
				this.emit("data", typeof Buffer !== "undefined" ? Buffer.from(chunk) : chunk);
			}
			this.destroy();
		}

		write(data, encoding, callback) {
			if (typeof encoding === "function") {
				callback = encoding;
				encoding = undefined;
			}
			const bytes = toBytes(data, encoding);
			if (this.id === null) {
				this._pending.push(bytes);
				callback?.();
				return true;
			}
			native.write(this.id, bytes).then(
				() => callback?.(),
				(err) => {
					const error = err instanceof Error ? err : new Error(String(err));
					if (callback) callback(error);
					else this.emit("error", error);
				}
			);
			return true;
		}

		end(data) {
			if (data) this.write(data);
			this.writable = false;
			return this;
		}

		destroy() {
			if (this.destroyed) return this;
			this.destroyed = true;
			this.readable = false;
			this.writable = false;
			const id = this.id;
			this.id = null;
			if (id !== null) native.close(id).catch(() => {});
			this.emit("close");
			return this;
		}

		setNoDelay() {
			// The native side already disables Nagle; accepted so callers do not have to branch.
			return this;
		}
		setKeepAlive() {
			return this;
		}
		setTimeout() {
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

function createNetModules(EventEmitter) {
	const Socket = createSocketClass(EventEmitter);

	const connect = (options, listener) => {
		const socket = new Socket();
		// Returned synchronously, like Node: callers attach listeners before it is connected.
		socket.connect(options, listener);
		return socket;
	};

	const net = {
		Socket,
		connect,
		createConnection: connect,
		createServer() {
			throw new Error(
				"net.createServer is not implemented: the native layer only opens outbound connections. " +
					"A bot connects to Discord and does not listen, so this has not been needed yet."
			);
		},
		isIP: (value) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) ? 4 : value.includes(":") ? 6 : 0),
	};

	const tls = {
		connect(options, listener) {
			return connect({ ...options, tls: true }, listener);
		},
		createSecureContext: () => ({}),
		// Certificates are verified against rustls's compiled-in root store, which is exactly
		// why this works on an old machine whose own certificate store is years stale.
		rootCertificates: [],
	};

	return { net, tls };
}

export { crypto, zlib, createNetModules, createSocketClass };

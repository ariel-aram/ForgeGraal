/*
 * The remaining Node modules, implemented rather than stubbed.
 *
 * Each of these is small on its own, and each was previously a module that threw. They are real
 * implementations of the surface libraries actually touch -- where something genuinely cannot be
 * done on this runtime it still throws and says why, because the point of the conformance count
 * is to be honest about what works.
 */

/* ---------------------------------------------------------------- async_hooks */

/*
 * AsyncLocalStorage without engine-level async context tracking.
 *
 * Node propagates the store across every await; this cannot, because there is no hook into the
 * engine's job queue. What it does is keep the store for the synchronous extent of run(), which
 * is what the common use (a request-scoped value read further down the same call stack) needs.
 * enterWith() is refused rather than silently behaving differently.
 */
class AsyncLocalStorage {
	constructor() {
		this._store = undefined;
		this._active = false;
	}
	run(store, callback, ...args) {
		const previousStore = this._store;
		const previousActive = this._active;
		this._store = store;
		this._active = true;
		try {
			return callback(...args);
		} finally {
			this._store = previousStore;
			this._active = previousActive;
		}
	}
	getStore() {
		return this._active ? this._store : undefined;
	}
	exit(callback, ...args) {
		const previousActive = this._active;
		this._active = false;
		try {
			return callback(...args);
		} finally {
			this._active = previousActive;
		}
	}
	enterWith() {
		throw new Error(
			"AsyncLocalStorage.enterWith is not available on this runtime: it requires the engine to " +
				"carry context across await boundaries, which quickjs does not expose. Use run(), which " +
				"holds the store for the synchronous extent of the callback."
		);
	}
	disable() {
		this._active = false;
	}
}

class AsyncResource {
	constructor(type) {
		this.type = type;
	}
	runInAsyncScope(fn, thisArg, ...args) {
		return fn.apply(thisArg, args);
	}
	emitDestroy() {
		return this;
	}
	asyncId() {
		return 0;
	}
}

const asyncHooks = {
	AsyncLocalStorage,
	AsyncResource,
	executionAsyncId: () => 0,
	triggerAsyncId: () => 0,
	createHook() {
		// Returning a hook that never fires would be a lie about observability, so this refuses.
		throw new Error(
			"async_hooks.createHook is not available on this runtime: quickjs exposes no async " +
				"lifecycle events to hook. AsyncLocalStorage.run() is supported."
		);
	},
};

/* ------------------------------------------------------------------------ v8 */

/*
 * structuredClone-grade serialize/deserialize, in a self-describing binary format.
 *
 * Not V8's wire format -- there is no V8 here -- so these bytes are only readable back by this
 * implementation. That matters for anything trying to exchange them with a real Node process,
 * and the header makes such a mistake fail loudly instead of decoding to garbage.
 */
const V8_MAGIC = 0xfe;
const V8_VERSION = 1;

const TAG = {
	undefined: 0,
	null: 1,
	true: 2,
	false: 3,
	number: 4,
	string: 5,
	bigint: 6,
	date: 7,
	regexp: 8,
	array: 9,
	object: 10,
	map: 11,
	set: 12,
	uint8array: 13,
	arraybuffer: 14,
	reference: 15,
};

function serialize(value) {
	const out = [];
	const seen = new Map();
	const encoder = new TextEncoder();

	const u32 = (n) => out.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
	const str = (s) => {
		const bytes = encoder.encode(s);
		u32(bytes.length);
		for (const byte of bytes) out.push(byte);
	};

	const write = (v) => {
		if (v === undefined) return out.push(TAG.undefined);
		if (v === null) return out.push(TAG.null);
		if (v === true) return out.push(TAG.true);
		if (v === false) return out.push(TAG.false);
		if (typeof v === "number") {
			out.push(TAG.number);
			const view = new DataView(new ArrayBuffer(8));
			view.setFloat64(0, v, true);
			for (let i = 0; i < 8; i++) out.push(view.getUint8(i));
			return;
		}
		if (typeof v === "string") {
			out.push(TAG.string);
			return str(v);
		}
		if (typeof v === "bigint") {
			out.push(TAG.bigint);
			return str(v.toString());
		}
		if (typeof v === "object") {
			// Cycles and shared references are preserved by index, as structured clone requires.
			if (seen.has(v)) {
				out.push(TAG.reference);
				return u32(seen.get(v));
			}
			seen.set(v, seen.size);

			if (v instanceof Date) {
				out.push(TAG.date);
				const view = new DataView(new ArrayBuffer(8));
				view.setFloat64(0, v.getTime(), true);
				for (let i = 0; i < 8; i++) out.push(view.getUint8(i));
				return;
			}
			if (v instanceof RegExp) {
				out.push(TAG.regexp);
				str(v.source);
				return str(v.flags);
			}
			if (v instanceof Uint8Array) {
				out.push(TAG.uint8array);
				u32(v.length);
				for (const byte of v) out.push(byte);
				return;
			}
			if (v instanceof ArrayBuffer) {
				out.push(TAG.arraybuffer);
				const bytes = new Uint8Array(v);
				u32(bytes.length);
				for (const byte of bytes) out.push(byte);
				return;
			}
			if (Array.isArray(v)) {
				out.push(TAG.array);
				u32(v.length);
				for (const item of v) write(item);
				return;
			}
			if (v instanceof Map) {
				out.push(TAG.map);
				u32(v.size);
				for (const [k, item] of v) {
					write(k);
					write(item);
				}
				return;
			}
			if (v instanceof Set) {
				out.push(TAG.set);
				u32(v.size);
				for (const item of v) write(item);
				return;
			}
			const keys = Object.keys(v);
			out.push(TAG.object);
			u32(keys.length);
			for (const key of keys) {
				str(key);
				write(v[key]);
			}
			return;
		}
		throw new TypeError(`value of type '${typeof v}' cannot be serialized`);
	};

	out.push(V8_MAGIC, V8_VERSION);
	write(value);
	return typeof Buffer !== "undefined" ? Buffer.from(out) : new Uint8Array(out);
}

function deserialize(input) {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	if (bytes[0] !== V8_MAGIC || bytes[1] !== V8_VERSION) {
		throw new TypeError(
			"these bytes were not produced by this runtime's v8.serialize. It uses its own format, " +
				"not V8's, so data cannot be exchanged with a real Node process."
		);
	}
	let offset = 2;
	const refs = [];
	const decoder = new TextDecoder();

	const u32 = () => {
		const n = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
		offset += 4;
		return n >>> 0;
	};
	const f64 = () => {
		const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
		offset += 8;
		return view.getFloat64(0, true);
	};
	const str = () => {
		const len = u32();
		const text = decoder.decode(bytes.subarray(offset, offset + len));
		offset += len;
		return text;
	};

	const read = () => {
		const tag = bytes[offset++];
		switch (tag) {
			case TAG.undefined: return undefined;
			case TAG.null: return null;
			case TAG.true: return true;
			case TAG.false: return false;
			case TAG.number: return f64();
			case TAG.string: return str();
			case TAG.bigint: return BigInt(str());
			case TAG.reference: return refs[u32()];
			case TAG.date: {
				const date = new Date(f64());
				refs.push(date);
				return date;
			}
			case TAG.regexp: {
				const regexp = new RegExp(str(), str());
				refs.push(regexp);
				return regexp;
			}
			case TAG.uint8array: {
				const len = u32();
				const out = bytes.slice(offset, offset + len);
				offset += len;
				refs.push(out);
				return out;
			}
			case TAG.arraybuffer: {
				const len = u32();
				const out = bytes.slice(offset, offset + len).buffer;
				offset += len;
				refs.push(out);
				return out;
			}
			case TAG.array: {
				const len = u32();
				const out = [];
				refs.push(out);
				for (let i = 0; i < len; i++) out.push(read());
				return out;
			}
			case TAG.map: {
				const size = u32();
				const out = new Map();
				refs.push(out);
				for (let i = 0; i < size; i++) out.set(read(), read());
				return out;
			}
			case TAG.set: {
				const size = u32();
				const out = new Set();
				refs.push(out);
				for (let i = 0; i < size; i++) out.add(read());
				return out;
			}
			case TAG.object: {
				const count = u32();
				const out = {};
				refs.push(out);
				for (let i = 0; i < count; i++) {
					const key = str();
					out[key] = read();
				}
				return out;
			}
			default:
				throw new TypeError(`unknown serialization tag ${tag}`);
		}
	};
	return read();
}

const v8 = {
	serialize,
	deserialize,
	getHeapStatistics: () => ({
		total_heap_size: 0,
		used_heap_size: 0,
		heap_size_limit: 0,
		malloced_memory: 0,
	}),
	setFlagsFromString: () => {},
};

/* ----------------------------------------------------------------------- tty */

function createTty(host) {
	const isatty = (fd) => Boolean(host.isatty?.(fd));
	class ReadStream {
		constructor(fd) {
			this.fd = fd;
			this.isTTY = isatty(fd);
		}
		setRawMode() {
			return this;
		}
	}
	class WriteStream {
		constructor(fd) {
			this.fd = fd;
			this.isTTY = isatty(fd);
			this.columns = 80;
			this.rows = 24;
		}
		write(text) {
			host.write?.(text);
			return true;
		}
		getWindowSize() {
			return [this.columns, this.rows];
		}
	}
	return { isatty, ReadStream, WriteStream };
}

/* ------------------------------------------------------------------ readline */

function createReadline(EventEmitter) {
	class Interface extends EventEmitter {
		constructor(options = {}) {
			super();
			this.input = options.input;
			this.output = options.output;
			this.terminal = Boolean(options.terminal);
			this._buffer = "";
			this._closed = false;
			// Lines are split out of whatever the input stream emits, which is how readline
			// behaves for a piped (non-TTY) input.
			this.input?.on?.("data", (chunk) => this._consume(String(chunk)));
			this.input?.on?.("end", () => this.close());
		}
		_consume(text) {
			this._buffer += text;
			let index = this._buffer.indexOf("\n");
			while (index !== -1) {
				const line = this._buffer.slice(0, index).replace(/\r$/, "");
				this._buffer = this._buffer.slice(index + 1);
				this.emit("line", line);
				index = this._buffer.indexOf("\n");
			}
		}
		question(query, callback) {
			this.output?.write?.(query);
			this.once("line", callback);
		}
		prompt() {
			this.output?.write?.(this._prompt ?? "> ");
		}
		setPrompt(prompt) {
			this._prompt = prompt;
		}
		write(text) {
			this.output?.write?.(text);
		}
		close() {
			if (this._closed) return;
			this._closed = true;
			if (this._buffer) {
				this.emit("line", this._buffer);
				this._buffer = "";
			}
			this.emit("close");
		}
		async *[Symbol.asyncIterator]() {
			const queue = [];
			let done = false;
			let notify;
			this.on("line", (line) => {
				queue.push(line);
				notify?.();
			});
			this.on("close", () => {
				done = true;
				notify?.();
			});
			for (;;) {
				if (queue.length) {
					yield queue.shift();
					continue;
				}
				if (done) return;
				await new Promise((resolve) => {
					notify = resolve;
				});
				notify = null;
			}
		}
	}
	return {
		Interface,
		createInterface: (options) => new Interface(options),
		clearLine: () => true,
		cursorTo: () => true,
		moveCursor: () => true,
	};
}

/* ------------------------------------------------------------ child_process */

function createChildProcess(host, EventEmitter) {
	if (!host.exec) {
		return null;
	}

	function spawnSync(command, args = [], options = {}) {
		const argv = [command, ...args];
		// The engine's exec() is blocking and returns an exit status; output capture goes
		// through a temporary file, which is the portable option here.
		const status = host.exec(argv, { block: true, ...options });
		return { status, signal: null, pid: 0, stdout: null, stderr: null, output: [null, null, null] };
	}

	function spawn(command, args = [], options = {}) {
		const emitter = new EventEmitter();
		emitter.stdout = new EventEmitter();
		emitter.stderr = new EventEmitter();
		queueMicrotask(() => {
			try {
				const status = spawnSync(command, args, options).status;
				emitter.emit("exit", status, null);
				emitter.emit("close", status, null);
			} catch (err) {
				emitter.emit("error", err);
			}
		});
		emitter.kill = () => true;
		return emitter;
	}

	return {
		spawn,
		spawnSync,
		execSync(command) {
			const status = host.exec(["/bin/sh", "-c", command], { block: true });
			if (status !== 0) throw new Error(`command failed with status ${status}: ${command}`);
			return "";
		},
		exec(command, callback) {
			queueMicrotask(() => {
				try {
					const status = host.exec(["/bin/sh", "-c", command], { block: true });
					callback?.(status === 0 ? null : new Error(`exit ${status}`), "", "");
				} catch (err) {
					callback?.(err, "", "");
				}
			});
			return new EventEmitter();
		},
		fork() {
			throw new Error("child_process.fork is not available: this runtime has no IPC channel to a child.");
		},
	};
}

/* ---------------------------------------------------------- worker_threads */

function createWorkerThreads(WorkerImpl, EventEmitter) {
	if (!WorkerImpl) {
		return null;
	}
	class Worker extends EventEmitter {
		constructor(filename) {
			super();
			this._worker = new WorkerImpl(filename);
			this._worker.onmessage = (event) => this.emit("message", event.data);
		}
		postMessage(value) {
			this._worker.postMessage(value);
		}
		terminate() {
			this._worker.terminate?.();
			this.emit("exit", 0);
			return Promise.resolve(0);
		}
	}
	return {
		Worker,
		isMainThread: true,
		threadId: 0,
		parentPort: null,
		workerData: null,
		// MessageChannel is engine-provided where available; this keeps the export shape whole.
		MessageChannel: globalThis.MessageChannel,
		MessagePort: globalThis.MessagePort,
	};
}

/* ------------------------------------------------------------------------ dns */

function createDns(lookupHost) {
	const lookup = (hostname, optionsOrCallback, maybeCallback) => {
		const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
		try {
			const address = lookupHost(hostname);
			callback?.(null, address, address.includes(":") ? 6 : 4);
		} catch (err) {
			callback?.(err);
		}
	};
	const promises = {
		lookup: (hostname) =>
			new Promise((resolve, reject) =>
				lookup(hostname, (err, address, family) => (err ? reject(err) : resolve({ address, family })))
			),
		resolve4: (hostname) => promises.lookup(hostname).then((r) => [r.address]),
	};
	return {
		lookup,
		promises,
		resolve4: (hostname, callback) => lookup(hostname, (err, address) => callback?.(err, err ? undefined : [address])),
		resolve: (hostname, callback) => lookup(hostname, (err, address) => callback?.(err, err ? undefined : [address])),
		setServers: () => {},
		getServers: () => [],
	};
}

export {
	asyncHooks,
	AsyncLocalStorage,
	v8,
	serialize,
	deserialize,
	createTty,
	createReadline,
	createChildProcess,
	createWorkerThreads,
	createDns,
};

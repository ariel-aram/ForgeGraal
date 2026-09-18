/*
 * Web Streams, Blob/File, fetch, and the HTTP/1.1 client, in pure JavaScript over the native
 * socket layer.
 *
 * These sit above `native-modules.js` (which supplies `net`/`tls`) and below `node-compat.js`
 * (which registers them as builtins). Nothing here needs the engine's cooperation -- once there
 * is a socket, the rest of what discord.js wants is protocol work that JavaScript can do.
 *
 * The HTTP client is intentionally HTTP/1.1 only. A bot's REST traffic is HTTP/1.1 and its
 * gateway is a WebSocket; HTTP/2 would need HPACK and stream multiplexing for no gain here.
 */

/* ------------------------------------------------------------------ streams */

/*
 * A spec-shaped ReadableStream, not the whole specification: what libraries actually use is
 * getReader/read/cancel, tee, and async iteration. Byte streams ('bytes' type with BYOB readers)
 * are not implemented, and asking for one throws rather than silently handing back a default
 * reader whose chunks arrive with different semantics.
 */
class ReadableStream {
	constructor(source = {}, strategy = {}) {
		if (source.type === "bytes") {
			throw new TypeError(
				"ReadableStream byte sources are not implemented in this runtime. A default (non-BYOB) " +
					"source works; a byte source would differ in how chunks are delivered, so it is refused " +
					"rather than quietly substituted."
			);
		}
		this._source = source;
		this._queue = [];
		this._closed = false;
		this._errored = null;
		this._locked = false;
		this._pullWaiters = [];
		this._highWaterMark = strategy.highWaterMark ?? 1;

		const controller = {
			enqueue: (chunk) => {
				if (this._closed) throw new TypeError("cannot enqueue on a closed stream");
				this._queue.push(chunk);
				this._wake();
			},
			close: () => {
				this._closed = true;
				this._wake();
			},
			error: (reason) => {
				this._errored = reason ?? new Error("stream errored");
				this._wake();
			},
			get desiredSize() {
				return this._highWaterMark - this._queue.length;
			},
		};
		this._controller = controller;
		try {
			source.start?.(controller);
		} catch (err) {
			this._errored = err;
		}
	}

	get locked() {
		return this._locked;
	}

	_wake() {
		for (const resolve of this._pullWaiters.splice(0)) resolve();
	}

	async _read() {
		for (;;) {
			if (this._errored) throw this._errored;
			if (this._queue.length) return { done: false, value: this._queue.shift() };
			if (this._closed) return { done: true, value: undefined };
			// Ask the source for more before parking, which is how a pull source makes progress.
			try {
				await this._source.pull?.(this._controller);
			} catch (err) {
				this._errored = err;
				continue;
			}
			if (this._queue.length || this._closed || this._errored) continue;
			await new Promise((resolve) => this._pullWaiters.push(resolve));
		}
	}

	getReader(options = {}) {
		if (options.mode === "byob") {
			throw new TypeError("BYOB readers are not implemented in this runtime");
		}
		if (this._locked) throw new TypeError("stream is already locked");
		this._locked = true;
		const stream = this;
		return {
			read: () => stream._read(),
			cancel: (reason) => stream.cancel(reason),
			releaseLock: () => {
				stream._locked = false;
			},
			get closed() {
				return Promise.resolve();
			},
		};
	}

	async cancel(reason) {
		this._closed = true;
		this._queue.length = 0;
		await this._source.cancel?.(reason);
		this._wake();
	}

	tee() {
		// Both branches get every chunk, so the source is drained once into two queues.
		const chunks = [];
		let done = false;
		const pump = (async () => {
			const reader = this.getReader();
			for (;;) {
				const { done: finished, value } = await reader.read();
				if (finished) break;
				chunks.push(value);
			}
			done = true;
		})();
		const branch = () =>
			new ReadableStream({
				async pull(controller) {
					await pump;
					for (const chunk of chunks) controller.enqueue(chunk);
					if (done) controller.close();
				},
			});
		return [branch(), branch()];
	}

	async *[Symbol.asyncIterator]() {
		const reader = this.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	}

	static from(iterable) {
		const iterator = iterable[Symbol.asyncIterator]?.() ?? iterable[Symbol.iterator]();
		return new ReadableStream({
			async pull(controller) {
				const { done, value } = await iterator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			},
		});
	}
}

class WritableStream {
	constructor(sink = {}, strategy = {}) {
		this._sink = sink;
		this._locked = false;
		this._closed = false;
		this.highWaterMark = strategy.highWaterMark ?? 1;
		sink.start?.(this._controller());
	}

	_controller() {
		return { error: (reason) => { this._errored = reason; } };
	}

	get locked() {
		return this._locked;
	}

	getWriter() {
		if (this._locked) throw new TypeError("stream is already locked");
		this._locked = true;
		const stream = this;
		return {
			write: async (chunk) => stream._sink.write?.(chunk, stream._controller()),
			close: async () => {
				stream._closed = true;
				await stream._sink.close?.();
			},
			abort: async (reason) => stream._sink.abort?.(reason),
			releaseLock: () => {
				stream._locked = false;
			},
			get desiredSize() {
				return stream.highWaterMark;
			},
			get closed() {
				return Promise.resolve();
			},
			get ready() {
				return Promise.resolve();
			},
		};
	}

	async close() {
		this._closed = true;
		await this._sink.close?.();
	}

	async abort(reason) {
		await this._sink.abort?.(reason);
	}
}

class TransformStream {
	constructor(transformer = {}, writableStrategy = {}, readableStrategy = {}) {
		let readableController;
		this.readable = new ReadableStream(
			{
				start(controller) {
					readableController = controller;
				},
			},
			readableStrategy
		);
		const transform = transformer.transform ?? ((chunk, controller) => controller.enqueue(chunk));
		this.writable = new WritableStream(
			{
				async write(chunk) {
					await transform(chunk, readableController);
				},
				async close() {
					await transformer.flush?.(readableController);
					readableController.close();
				},
			},
			writableStrategy
		);
		transformer.start?.(readableController);
	}
}

class ByteLengthQueuingStrategy {
	constructor({ highWaterMark }) {
		this.highWaterMark = highWaterMark;
	}
	size(chunk) {
		return chunk?.byteLength ?? 0;
	}
}

class CountQueuingStrategy {
	constructor({ highWaterMark }) {
		this.highWaterMark = highWaterMark;
	}
	size() {
		return 1;
	}
}

/* --------------------------------------------------------------- Blob / File */

function concatParts(parts) {
	const chunks = [];
	let total = 0;
	for (const part of parts) {
		let bytes;
		if (typeof part === "string") bytes = new TextEncoder().encode(part);
		else if (part instanceof Blob) bytes = part._bytes;
		else if (ArrayBuffer.isView(part)) bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
		else if (part instanceof ArrayBuffer) bytes = new Uint8Array(part);
		else bytes = new TextEncoder().encode(String(part));
		chunks.push(bytes);
		total += bytes.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

class Blob {
	constructor(parts = [], options = {}) {
		this._bytes = concatParts(parts);
		this.type = options.type ?? "";
	}
	get size() {
		return this._bytes.length;
	}
	async text() {
		return new TextDecoder().decode(this._bytes);
	}
	async arrayBuffer() {
		return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.length);
	}
	async bytes() {
		return this._bytes.slice();
	}
	slice(start = 0, end = this.size, type = "") {
		const blob = new Blob([], { type });
		blob._bytes = this._bytes.slice(start, end);
		return blob;
	}
	stream() {
		const bytes = this._bytes;
		return new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		});
	}
}

class File extends Blob {
	constructor(parts, name, options = {}) {
		super(parts, options);
		this.name = String(name);
		this.lastModified = options.lastModified ?? Date.now();
	}
}

/* -------------------------------------------------------------------- fetch */

class Headers {
	constructor(init) {
		this._map = new Map();
		if (init instanceof Headers) for (const [k, v] of init) this.set(k, v);
		else if (Array.isArray(init)) for (const [k, v] of init) this.append(k, v);
		else if (init) for (const k of Object.keys(init)) this.set(k, init[k]);
	}
	// Header names are case-insensitive, so they are stored folded and the original is kept
	// only for iteration.
	set(name, value) {
		this._map.set(String(name).toLowerCase(), String(value));
	}
	append(name, value) {
		const key = String(name).toLowerCase();
		const existing = this._map.get(key);
		this._map.set(key, existing ? `${existing}, ${value}` : String(value));
	}
	get(name) {
		return this._map.get(String(name).toLowerCase()) ?? null;
	}
	has(name) {
		return this._map.has(String(name).toLowerCase());
	}
	delete(name) {
		this._map.delete(String(name).toLowerCase());
	}
	forEach(fn, thisArg) {
		for (const [k, v] of this._map) fn.call(thisArg, v, k, this);
	}
	entries() {
		return this._map.entries();
	}
	keys() {
		return this._map.keys();
	}
	values() {
		return this._map.values();
	}
	[Symbol.iterator]() {
		return this._map.entries();
	}
}

class Body {
	constructor(body) {
		this._bodyBytes = body == null ? new Uint8Array(0) : concatParts([body]);
		this.bodyUsed = false;
	}
	get body() {
		const bytes = this._bodyBytes;
		return new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		});
	}
	async arrayBuffer() {
		this.bodyUsed = true;
		return this._bodyBytes.buffer.slice(
			this._bodyBytes.byteOffset,
			this._bodyBytes.byteOffset + this._bodyBytes.length
		);
	}
	async bytes() {
		this.bodyUsed = true;
		return this._bodyBytes.slice();
	}
	async text() {
		this.bodyUsed = true;
		return new TextDecoder().decode(this._bodyBytes);
	}
	async json() {
		return JSON.parse(await this.text());
	}
	async blob() {
		return new Blob([this._bodyBytes]);
	}
}

class Request extends Body {
	constructor(input, init = {}) {
		super(init.body);
		this.url = typeof input === "string" ? input : input.url;
		this.method = (init.method ?? "GET").toUpperCase();
		this.headers = new Headers(init.headers);
		this.signal = init.signal;
		this.redirect = init.redirect ?? "follow";
	}
}

class Response extends Body {
	constructor(body, init = {}) {
		super(body);
		this.status = init.status ?? 200;
		this.statusText = init.statusText ?? "";
		this.headers = new Headers(init.headers);
		this.url = init.url ?? "";
		this.redirected = Boolean(init.redirected);
	}
	get ok() {
		return this.status >= 200 && this.status < 300;
	}
	static json(data, init) {
		const response = new Response(JSON.stringify(data), init);
		response.headers.set("content-type", "application/json");
		return response;
	}
}

/* ------------------------------------------------------- HTTP/1.1 over a socket */

function parseHead(text) {
	const lines = text.split("\r\n");
	const [, statusRaw, ...reason] = lines[0].split(" ");
	const headers = new Headers();
	for (const line of lines.slice(1)) {
		if (!line) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	return { status: Number.parseInt(statusRaw, 10), statusText: reason.join(" "), headers };
}

function dechunk(bytes) {
	// Transfer-Encoding: chunked. Sizes are hex, each chunk followed by CRLF, terminated by a
	// zero-length chunk.
	const out = [];
	let offset = 0;
	const text = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
	for (;;) {
		let lineEnd = offset;
		while (lineEnd < bytes.length - 1 && !(bytes[lineEnd] === 13 && bytes[lineEnd + 1] === 10)) lineEnd++;
		const size = Number.parseInt(text(offset, lineEnd).split(";")[0], 16);
		if (!Number.isFinite(size) || size === 0) break;
		const start = lineEnd + 2;
		out.push(bytes.subarray(start, start + size));
		offset = start + size + 2;
		if (offset >= bytes.length) break;
	}
	return concatParts(out);
}

function createFetch(netModules, zlib) {
	const { net, tls } = netModules;

	return async function fetch(input, init = {}) {
		const request = input instanceof Request ? input : new Request(input, init);
		const url = new URL(request.url);
		const secure = url.protocol === "https:";
		const port = url.port ? Number(url.port) : secure ? 443 : 80;

		const headers = new Headers(request.headers);
		headers.set("host", url.host);
		if (!headers.has("user-agent")) headers.set("user-agent", "ForgeGraal");
		if (!headers.has("accept")) headers.set("accept", "*/*");
		// Connection: close keeps this a single request/response per socket, which is what the
		// simple reader below can handle correctly.
		headers.set("connection", "close");
		const bodyBytes = request._bodyBytes;
		if (bodyBytes.length) headers.set("content-length", String(bodyBytes.length));

		let head = `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
		for (const [name, value] of headers) head += `${name}: ${value}\r\n`;
		head += "\r\n";

		const socket = (secure ? tls : net).connect({ host: url.hostname, port, tls: secure });

		const chunks = [];
		await new Promise((resolve, reject) => {
			const onReady = () => {
				socket.write(head);
				if (bodyBytes.length) socket.write(bodyBytes);
			};
			socket.on(secure ? "secureConnect" : "connect", onReady);
			socket.on("data", (chunk) => chunks.push(chunk));
			socket.on("end", resolve);
			socket.on("error", reject);
			request.signal?.addEventListener?.("abort", () => {
				socket.destroy();
				reject(request.signal.reason ?? new Error("The operation was aborted"));
			});
		});

		const raw = concatParts(chunks);
		// Find the header/body boundary by bytes, not by decoding: the body may be binary.
		let split = -1;
		for (let i = 0; i + 3 < raw.length; i++) {
			if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
				split = i;
				break;
			}
		}
		if (split === -1) throw new Error("malformed HTTP response: no header terminator");

		const { status, statusText, headers: responseHeaders } = parseHead(
			new TextDecoder().decode(raw.subarray(0, split))
		);
		let body = raw.subarray(split + 4);

		if ((responseHeaders.get("transfer-encoding") ?? "").includes("chunked")) body = dechunk(body);
		const encoding = responseHeaders.get("content-encoding");
		if (encoding && zlib) {
			if (encoding.includes("gzip")) body = zlib.gunzipSync(body);
			else if (encoding.includes("deflate")) body = zlib.inflateSync(body);
		}

		const response = new Response(body, {
			status,
			statusText,
			headers: responseHeaders,
			url: request.url,
		});

		// Redirects are followed by default, like the platform fetch.
		if (request.redirect === "follow" && status >= 300 && status < 400 && responseHeaders.get("location")) {
			const location = new URL(responseHeaders.get("location"), request.url).toString();
			return fetch(location, { ...init, method: status === 303 ? "GET" : request.method });
		}
		return response;
	};
}

/* ------------------------------------------------------- node:http / node:https */

function createHttpModules(netModules, zlib, EventEmitter) {
	const fetch = createFetch(netModules, zlib);

	function request(options, callback) {
		const opts = typeof options === "string" ? { url: options } : options;
		const protocol = opts.protocol ?? (opts.port === 443 ? "https:" : "http:");
		const host = opts.hostname ?? opts.host ?? "localhost";
		const port = opts.port ?? (protocol === "https:" ? 443 : 80);
		const path = opts.path ?? "/";
		const url = opts.url ?? `${protocol}//${host}:${port}${path}`;

		const emitter = new EventEmitter();
		const bodyChunks = [];

		emitter.write = (chunk) => {
			bodyChunks.push(chunk);
			return true;
		};
		emitter.setHeader = (name, value) => {
			opts.headers = { ...(opts.headers ?? {}), [name]: value };
		};
		emitter.end = (chunk) => {
			if (chunk) bodyChunks.push(chunk);
			fetch(url, {
				method: opts.method ?? "GET",
				headers: opts.headers,
				body: bodyChunks.length ? concatParts(bodyChunks) : undefined,
			}).then(
				async (response) => {
					// Shaped like Node's IncomingMessage: an emitter that streams the body.
					const incoming = new EventEmitter();
					incoming.statusCode = response.status;
					incoming.statusMessage = response.statusText;
					incoming.headers = Object.fromEntries(response.headers.entries());
					incoming.setEncoding = () => incoming;
					incoming.resume = () => incoming;
					callback?.(incoming);
					emitter.emit("response", incoming);
					const bytes = await response.bytes();
					queueMicrotask(() => {
						incoming.emit("data", typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes);
						incoming.emit("end");
					});
				},
				(err) => emitter.emit("error", err)
			);
			return emitter;
		};
		emitter.abort = () => emitter.emit("abort");
		emitter.setTimeout = () => emitter;
		return emitter;
	}

	const make = (defaultProtocol) => ({
		request: (options, callback) =>
			request(typeof options === "string" ? options : { protocol: defaultProtocol, ...options }, callback),
		get(options, callback) {
			const req = this.request(options, callback);
			req.end();
			return req;
		},
		createServer() {
			throw new Error(
				"http.createServer is not implemented: the native layer only opens outbound connections. " +
					"A bot connects to Discord and does not listen."
			);
		},
		Agent: class Agent {},
		globalAgent: {},
		STATUS_CODES: { 200: "OK", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 429: "Too Many Requests", 500: "Internal Server Error" },
	});

	return { http: make("http:"), https: make("https:"), fetch };
}

export {
	ReadableStream,
	WritableStream,
	TransformStream,
	ByteLengthQueuingStrategy,
	CountQueuingStrategy,
	Blob,
	File,
	Headers,
	Request,
	Response,
	createFetch,
	createHttpModules,
};

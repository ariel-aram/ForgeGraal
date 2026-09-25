/*
 * Node-shaped `http` and `https`: a real HTTP/1.1 implementation, client and server, on the host's
 * sockets (`net`/`tls` from native-modules.js).
 *
 * The server is what lets a web application run on the native host: Express, Fastify, Hono and every
 * other framework that calls `http.createServer` sees the objects they expect -- an IncomingMessage
 * that is a Readable, a ServerResponse with headers, chunked encoding, keep-alive and 'upgrade' -- and
 * never a stub. The client speaks the same protocol, including 'upgrade' (WebSocket handshakes).
 *
 * One parser serves both directions. Bodies are framed by Content-Length, chunked encoding, or the end
 * of the connection, exactly as RFC 9112 says; a message that cannot be framed is a 400, not a guess.
 */

const CRLF = new Uint8Array([13, 10]);
const HEADER_END = [13, 10, 13, 10];
const MAX_HEADER_BYTES = 65536;

const METHODS = [
	"ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE",
	"MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH",
	"PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK",
	"UNLOCK", "UNSUBSCRIBE",
];

const STATUS_CODES = {
	100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints",
	200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content",
	205: "Reset Content", 206: "Partial Content", 207: "Multi-Status", 208: "Already Reported", 226: "IM Used",
	300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
	305: "Use Proxy", 307: "Temporary Redirect", 308: "Permanent Redirect",
	400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found",
	405: "Method Not Allowed", 406: "Not Acceptable", 407: "Proxy Authentication Required", 408: "Request Timeout",
	409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large",
	414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable", 417: "Expectation Failed",
	418: "I'm a Teapot", 421: "Misdirected Request", 422: "Unprocessable Entity", 423: "Locked",
	424: "Failed Dependency", 425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required",
	429: "Too Many Requests", 431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
	500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable",
	504: "Gateway Timeout", 505: "HTTP Version Not Supported", 506: "Variant Also Negotiates",
	507: "Insufficient Storage", 508: "Loop Detected", 509: "Bandwidth Limit Exceeded", 510: "Not Extended",
	511: "Network Authentication Required",
};

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BAD_VALUE = /[^\t\x20-\x7e\x80-\xff]/;

function latin1(bytes, start = 0, end = bytes.length) {
	let out = "";
	for (let i = start; i < end; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 8192)));
	return out;
}

function concat(a, b) {
	if (!a || !a.length) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function indexOfSeq(bytes, seq, from = 0) {
	const n = seq.length;
	outer: for (let i = from; i <= bytes.length - n; i++) {
		for (let j = 0; j < n; j++) if (bytes[i + j] !== seq[j]) continue outer;
		return i;
	}
	return -1;
}

const utf8 = (text) => (typeof TextEncoder === "function" ? new TextEncoder().encode(text) : globalThis.Buffer.from(text, "utf8"));

function toBytes(data, encoding) {
	if (typeof data === "string") {
		if (encoding && encoding !== "utf8" && encoding !== "utf-8") return new Uint8Array(globalThis.Buffer.from(data, encoding));
		return utf8(data);
	}
	if (data instanceof Uint8Array) return data;
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	throw Object.assign(new TypeError('The "chunk" argument must be of type string or an instance of Buffer or Uint8Array'), {
		code: "ERR_INVALID_ARG_TYPE",
	});
}

function validateHeaderName(name) {
	if (typeof name !== "string" || !TOKEN.test(name)) {
		throw Object.assign(new TypeError(`Header name must be a valid HTTP token ["${name}"]`), { code: "ERR_INVALID_HTTP_TOKEN" });
	}
}

function validateHeaderValue(name, value) {
	if (value === undefined) {
		throw Object.assign(new TypeError(`Invalid value "${value}" for header "${name}"`), { code: "ERR_HTTP_INVALID_HEADER_VALUE" });
	}
	if (BAD_VALUE.test(String(value))) {
		throw Object.assign(new TypeError(`Invalid character in header content ["${name}"]`), { code: "ERR_INVALID_CHAR" });
	}
}

/* ------------------------------------------------------------------ parser */

/*
 * Incremental HTTP/1.x parser. `mode` is "request" or "response". The handler receives
 * head({...}), body(Uint8Array), end() and, for a protocol switch, upgrade(rest). It never throws on
 * bad input: it calls handler.error(err) once and stops.
 */
class HttpParser {
	constructor(mode, handler) {
		this.mode = mode;
		this.handler = handler;
		this.buf = null;
		this.state = "head";
		this.remaining = 0;
		this.dead = false;
		this.headRequest = false; // client side: the request was HEAD, so no body follows
	}

	fail(message, code = "HPE_INVALID_CONSTANT") {
		if (this.dead) return;
		this.dead = true;
		this.state = "dead";
		this.handler.error(Object.assign(new Error(`Parse Error: ${message}`), { code, bytesParsed: 0 }));
	}

	feed(chunk) {
		if (this.dead || this.state === "upgrade") return;
		this.buf = concat(this.buf, chunk);
		this.run();
	}

	/* The connection ended: a body that runs to end-of-connection is now complete. */
	finish() {
		if (this.dead) return;
		if (this.state === "body-eof") {
			this.state = "head";
			this.handler.end();
		} else if (this.state !== "head" || (this.buf && this.buf.length)) {
			this.fail("Unexpected end of message", "HPE_INVALID_EOF_STATE");
		}
	}

	run() {
		while (!this.dead && this.buf) {
			if (this.state === "head") {
				if (!this.readHead()) return;
			} else if (this.state === "body-length") {
				if (!this.buf.length) return;
				const take = Math.min(this.remaining, this.buf.length);
				this.handler.body(this.buf.subarray(0, take));
				this.buf = this.buf.length > take ? this.buf.subarray(take) : null;
				this.remaining -= take;
				if (this.remaining === 0) {
					this.state = "head";
					this.handler.end();
				}
			} else if (this.state === "body-eof") {
				if (!this.buf.length) return;
				this.handler.body(this.buf);
				this.buf = null;
				return;
			} else if (this.state === "chunk-size") {
				const at = indexOfSeq(this.buf, CRLF);
				if (at < 0) {
					if (this.buf.length > 1024) this.fail("Invalid chunk size", "HPE_INVALID_CHUNK_SIZE");
					return;
				}
				const line = latin1(this.buf, 0, at).split(";")[0].trim();
				if (!/^[0-9a-fA-F]+$/.test(line)) return this.fail("Invalid chunk size", "HPE_INVALID_CHUNK_SIZE");
				this.remaining = Number.parseInt(line, 16);
				this.buf = this.buf.subarray(at + 2);
				this.state = this.remaining === 0 ? "trailers" : "chunk-data";
			} else if (this.state === "chunk-data") {
				if (!this.buf.length) return;
				const take = Math.min(this.remaining, this.buf.length);
				this.handler.body(this.buf.subarray(0, take));
				this.buf = this.buf.length > take ? this.buf.subarray(take) : null;
				this.remaining -= take;
				if (this.remaining === 0) this.state = "chunk-crlf";
			} else if (this.state === "chunk-crlf") {
				if (this.buf.length < 2) return;
				if (this.buf[0] !== 13 || this.buf[1] !== 10) return this.fail("Missing chunk terminator", "HPE_STRICT");
				this.buf = this.buf.length > 2 ? this.buf.subarray(2) : null;
				this.state = "chunk-size";
			} else if (this.state === "trailers") {
				// Zero or more trailer lines, then a blank line. They are read and dropped.
				const at = indexOfSeq(this.buf, CRLF);
				if (at < 0) return;
				const blank = at === 0;
				this.buf = this.buf.length > at + 2 ? this.buf.subarray(at + 2) : null;
				if (blank) {
					this.state = "head";
					this.handler.end();
				}
			} else {
				return;
			}
		}
	}

	readHead() {
		// Tolerate blank lines before a message, as servers must.
		while (this.buf && this.buf.length >= 2 && this.buf[0] === 13 && this.buf[1] === 10) {
			this.buf = this.buf.length > 2 ? this.buf.subarray(2) : null;
		}
		if (!this.buf) return false;
		const end = indexOfSeq(this.buf, HEADER_END);
		if (end < 0) {
			if (this.buf.length > MAX_HEADER_BYTES) this.fail("Header overflow", "HPE_HEADER_OVERFLOW");
			return false;
		}
		const text = latin1(this.buf, 0, end);
		let rest = this.buf.subarray(end + 4);
		rest = rest.length ? rest : null;
		const lines = text.split("\r\n");
		const first = lines.shift();
		const head = { rawHeaders: [], headers: {}, upgrade: false };

		if (this.mode === "request") {
			const m = /^([A-Za-z-]+) (\S+) HTTP\/(\d)\.(\d)$/.exec(first);
			if (!m) return this.fail("Invalid request line", "HPE_INVALID_METHOD"), false;
			head.method = m[1].toUpperCase();
			head.url = m[2];
			head.httpVersionMajor = Number(m[3]);
			head.httpVersionMinor = Number(m[4]);
		} else {
			const m = /^HTTP\/(\d)\.(\d) (\d{3})(?: (.*))?$/.exec(first);
			if (!m) return this.fail("Invalid status line", "HPE_INVALID_CONSTANT"), false;
			head.httpVersionMajor = Number(m[1]);
			head.httpVersionMinor = Number(m[2]);
			head.statusCode = Number(m[3]);
			head.statusMessage = m[4] ?? "";
		}

		for (const line of lines) {
			if (line[0] === " " || line[0] === "\t") {
				// obs-fold: continues the previous value.
				const n = head.rawHeaders.length;
				if (n) head.rawHeaders[n - 1] += ` ${line.trim()}`;
				continue;
			}
			const colon = line.indexOf(":");
			if (colon <= 0) return this.fail("Invalid header token", "HPE_INVALID_HEADER_TOKEN"), false;
			const name = line.slice(0, colon);
			if (!TOKEN.test(name)) return this.fail("Invalid header token", "HPE_INVALID_HEADER_TOKEN"), false;
			head.rawHeaders.push(name, line.slice(colon + 1).trim());
		}
		for (let i = 0; i < head.rawHeaders.length; i += 2) addHeader(head.headers, head.rawHeaders[i], head.rawHeaders[i + 1]);

		const h = head.headers;
		const connection = String(h.connection ?? "").toLowerCase();
		head.shouldKeepAlive =
			head.httpVersionMajor === 1 && head.httpVersionMinor >= 1 ? !connection.includes("close") : connection.includes("keep-alive");
		const chunked = /(^|,)\s*chunked\s*$/i.test(String(h["transfer-encoding"] ?? ""));
		const length = h["content-length"] === undefined ? null : Number(h["content-length"]);
		if (length !== null && (!Number.isInteger(length) || length < 0)) return this.fail("Invalid Content-Length", "HPE_INVALID_CONTENT_LENGTH"), false;

		const isUpgrade =
			this.mode === "request"
				? head.method === "CONNECT" || (connection.includes("upgrade") && h.upgrade !== undefined)
				: head.statusCode === 101 || (head.statusCode === 200 && this.connectRequest);
		head.upgrade = isUpgrade;

		let framing;
		if (isUpgrade) framing = "upgrade";
		else if (this.mode === "response" && (head.statusCode < 200 || head.statusCode === 204 || head.statusCode === 304 || this.headRequest)) {
			framing = "none";
		} else if (chunked) framing = "chunked";
		else if (length !== null) framing = length === 0 ? "none" : "length";
		else framing = this.mode === "request" ? "none" : "eof";

		this.buf = rest;
		if (this.mode === "response" && head.statusCode >= 100 && head.statusCode < 200 && head.statusCode !== 101) {
			this.handler.information?.(head);
			return true;
		}
		this.handler.head(head);
		if (this.dead) return false;
		if (framing === "upgrade") {
			this.state = "upgrade";
			const remainder = this.buf;
			this.buf = null;
			this.handler.upgrade(remainder ?? new Uint8Array(0));
			return false;
		}
		if (framing === "none") {
			this.handler.end();
			return true;
		}
		if (framing === "length") {
			this.remaining = length;
			this.state = "body-length";
		} else if (framing === "chunked") this.state = "chunk-size";
		else this.state = "body-eof";
		return true;
	}
}

const JOIN_WITH_SEMICOLON = new Set(["cookie"]);
const KEEP_FIRST = new Set([
	"content-type", "content-length", "user-agent", "referer", "host", "authorization", "proxy-authorization",
	"if-modified-since", "if-unmodified-since", "from", "location", "max-forwards", "retry-after", "etag",
	"last-modified", "server", "age", "expires",
]);

function addHeader(headers, rawName, value) {
	const name = rawName.toLowerCase();
	if (name === "set-cookie") {
		if (headers[name]) headers[name].push(value);
		else headers[name] = [value];
	} else if (headers[name] === undefined) headers[name] = value;
	else if (KEEP_FIRST.has(name)) return;
	else headers[name] += `${JOIN_WITH_SEMICOLON.has(name) ? "; " : ", "}${value}`;
}

/* ---------------------------------------------------------------- messages */

/* The options an https request hands on to the TLS layer. */
const TLS_OPTION_NAMES = ["ca", "cert", "key", "passphrase", "minVersion", "maxVersion", "ALPNProtocols", "checkServerIdentity", "secureContext", "pfx", "ciphers"];
function tlsOptionsOf(opts) {
	const out = {};
	for (const name of TLS_OPTION_NAMES) if (opts[name] !== undefined) out[name] = opts[name];
	return out;
}

function createHttpModules({ net, tls }, EventEmitter, stream, ForgeBuffer) {
	const { Readable, Stream } = stream;
	const Buf = () => ForgeBuffer ?? globalThis.Buffer;

	class Agent extends EventEmitter {
		constructor(options = {}) {
			super();
			this.options = options;
			this.keepAlive = Boolean(options.keepAlive);
			this.maxSockets = options.maxSockets ?? Number.POSITIVE_INFINITY;
			this.maxFreeSockets = options.maxFreeSockets ?? 256;
			this.sockets = {};
			this.freeSockets = {};
			this.requests = {};
			this.defaultPort = 80;
			this.protocol = "http:";
		}
		destroy() {}
	}

	class IncomingMessage extends Readable {
		constructor(socket) {
			super();
			this.socket = socket;
			this.connection = socket;
			this.httpVersion = "1.1";
			this.httpVersionMajor = 1;
			this.httpVersionMinor = 1;
			this.headers = {};
			this.rawHeaders = [];
			this.trailers = {};
			this.rawTrailers = [];
			this.method = undefined;
			this.url = "";
			this.statusCode = null;
			this.statusMessage = null;
			this.complete = false;
			this.aborted = false;
		}
		_read() {
			// Bytes are pushed by the parser as they arrive; there is nothing to pull.
		}
		_fill(head) {
			this.httpVersionMajor = head.httpVersionMajor;
			this.httpVersionMinor = head.httpVersionMinor;
			this.httpVersion = `${head.httpVersionMajor}.${head.httpVersionMinor}`;
			this.headers = head.headers;
			this.rawHeaders = head.rawHeaders;
			this.method = head.method;
			this.url = head.url ?? "";
			this.statusCode = head.statusCode ?? null;
			this.statusMessage = head.statusMessage ?? null;
			this.shouldKeepAlive = head.shouldKeepAlive;
		}
		get headersDistinct() {
			const out = {};
			for (let i = 0; i < this.rawHeaders.length; i += 2) (out[this.rawHeaders[i].toLowerCase()] ??= []).push(this.rawHeaders[i + 1]);
			return out;
		}
		setTimeout(ms, callback) {
			this.socket?.setTimeout(ms, callback);
			return this;
		}
		_destroy(err, callback) {
			// Reading a body through to its end leaves the socket to the connection; destroying a response
			// that is still unfinished (or aborted) takes the socket down with it.
			if (!this.readableEnded || !this.complete) {
				this.aborted = true;
				if (this.socket && !this.socket.destroyed) this.socket.destroy(err);
			}
			callback(this.listenerCount("error") === 0 ? null : err);
		}
	}

	/* ---------------------------------------------------------- outgoing */

	class OutgoingMessage extends Stream {
		constructor() {
			super();
			this._headers = new Map(); // lowercase name -> [name, value]
			this._header = null; // the serialised head, once written
			this._headerSent = false;
			this._chunked = false;
			this._hasBody = true;
			this.finished = false;
			this.writableEnded = false;
			this.writableFinished = false;
			this.socket = null;
			this.connection = null;
			this.sendDate = false;
			this.useChunkedEncodingByDefault = true;
			this.chunkedEncoding = false;
			this.shouldKeepAlive = true;
			this.strictContentLength = false;
			this._trailers = null;
			this._closeEmitted = false;
		}
		get headersSent() {
			return this._headerSent || this._header !== null;
		}
		get writable() {
			return !this.writableEnded && !this.destroyed;
		}
		get writableLength() {
			return 0;
		}
		get writableHighWaterMark() {
			return 16384;
		}
		get writableNeedDrain() {
			return false;
		}
		get destroyed() {
			return Boolean(this.socket?.destroyed);
		}

		setHeader(name, value) {
			if (this.headersSent) {
				throw Object.assign(new Error("Cannot set headers after they are sent to the client"), { code: "ERR_HTTP_HEADERS_SENT" });
			}
			validateHeaderName(name);
			validateHeaderValue(name, value);
			this._headers.set(name.toLowerCase(), [name, value]);
			return this;
		}
		appendHeader(name, value) {
			const key = name.toLowerCase();
			const current = this._headers.get(key);
			if (!current) return this.setHeader(name, value);
			const list = Array.isArray(current[1]) ? current[1] : [current[1]];
			this._headers.set(key, [current[0], list.concat(value)]);
			return this;
		}
		getHeader(name) {
			return this._headers.get(String(name).toLowerCase())?.[1];
		}
		getHeaders() {
			const out = Object.create(null);
			for (const [key, [, value]] of this._headers) out[key] = value;
			return out;
		}
		getHeaderNames() {
			return [...this._headers.keys()];
		}
		getRawHeaderNames() {
			return [...this._headers.values()].map(([name]) => name);
		}
		hasHeader(name) {
			return this._headers.has(String(name).toLowerCase());
		}
		removeHeader(name) {
			if (this.headersSent) {
				throw Object.assign(new Error("Cannot remove headers after they are sent to the client"), { code: "ERR_HTTP_HEADERS_SENT" });
			}
			this._headers.delete(String(name).toLowerCase());
		}
		setHeaders(headers) {
			for (const [name, value] of headers instanceof Map || typeof headers.entries === "function" ? headers.entries() : Object.entries(headers)) {
				this.setHeader(name, value);
			}
			return this;
		}
		addTrailers(headers) {
			this._trailers = Object.entries(headers);
		}
		setTimeout(ms, callback) {
			this.socket?.setTimeout(ms, callback);
			return this;
		}
		cork() {}
		uncork() {}
		setNoDelay() {}
		setSocketKeepAlive() {}

		_headerLines(extra) {
			let text = "";
			const push = (name, value) => {
				if (Array.isArray(value)) for (const v of value) text += `${name}: ${v}\r\n`;
				else text += `${name}: ${value}\r\n`;
			};
			for (const [name, value] of this._headers.values()) push(name, value);
			for (const [name, value] of extra) push(name, value);
			return text;
		}

		/* Bytes go to the socket; subclasses decide when (a pipelined response waits its turn). */
		_write(bytes, callback) {
			if (!this.socket) {
				callback?.();
				return true;
			}
			const accepted = this.socket.write(bytes, callback);
			if (accepted === false && !this._drainHooked) {
				// The socket is backed up: tell whoever is writing to wait for 'drain', as Node does.
				this._drainHooked = true;
				this.socket.once("drain", () => {
					this._drainHooked = false;
					this.emit("drain");
				});
			}
			return accepted !== false;
		}

		write(chunk, encoding, callback) {
			if (typeof encoding === "function") {
				callback = encoding;
				encoding = undefined;
			}
			if (this.writableEnded) {
				const err = Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
				queueMicrotask(() => (callback ? callback(err) : this.emit("error", err)));
				return false;
			}
			if (chunk === undefined || chunk === null) {
				throw Object.assign(new TypeError('The "chunk" argument must be of type string or an instance of Buffer or Uint8Array'), {
					code: "ERR_STREAM_NULL_VALUES",
				});
			}
			const bytes = toBytes(chunk, encoding);
			const accepted = this._sendBody(bytes, false);
			if (callback) queueMicrotask(callback);
			return accepted;
		}

		/* head + body in one socket write where possible. */
		_sendBody(bytes, last) {
			let out = null;
			if (!this.headersSent) {
				this._storeHeader(last ? bytes.length : undefined);
			}
			if (!this._headerSent) {
				out = utf8(this._header);
				this._headerSent = true;
			}
			if (this._hasBody && bytes.length) {
				const body = this._chunked ? concat(concat(utf8(`${bytes.length.toString(16)}\r\n`), bytes), CRLF) : bytes;
				out = out ? concat(out, body) : body;
			}
			return out ? this._write(out) : true;
		}

		flushHeaders() {
			if (!this.headersSent) this._storeHeader(undefined);
			if (!this._headerSent) {
				this._headerSent = true;
				this._write(utf8(this._header));
			}
		}

		end(chunk, encoding, callback) {
			if (typeof chunk === "function") {
				callback = chunk;
				chunk = undefined;
			} else if (typeof encoding === "function") {
				callback = encoding;
				encoding = undefined;
			}
			if (this.writableEnded) {
				if (callback) queueMicrotask(callback);
				return this;
			}
			const bytes = chunk === undefined || chunk === null ? new Uint8Array(0) : toBytes(chunk, encoding);
			if (!this.headersSent) this._storeHeader(bytes.length);
			// A last chunk goes out with the terminator in the same write.
			let out = null;
			if (!this._headerSent) {
				out = utf8(this._header);
				this._headerSent = true;
			}
			if (this._hasBody && bytes.length) {
				const body = this._chunked ? concat(concat(utf8(`${bytes.length.toString(16)}\r\n`), bytes), CRLF) : bytes;
				out = out ? concat(out, body) : body;
			}
			if (this._chunked && this._hasBody) {
				let tail = "0\r\n";
				if (this._trailers) for (const [n, v] of this._trailers) tail += `${n}: ${v}\r\n`;
				tail += "\r\n";
				out = out ? concat(out, utf8(tail)) : utf8(tail);
			}
			this.finished = true;
			this.writableEnded = true;
			if (callback) this.once("finish", callback);
			this._writeLast(out);
			return this;
		}

		_writeLast(out) {
			const done = () => {
				this.writableFinished = true;
				this.emit("finish");
				this._afterFinish();
			};
			if (out) this._write(out, done);
			else queueMicrotask(done);
		}

		_afterFinish() {}
		destroy(err) {
			this.socket?.destroy(err);
			return this;
		}
		_storeHeader() {
			throw new Error("not implemented");
		}
	}

	/* ------------------------------------------------------------ server */

	class ServerResponse extends OutgoingMessage {
		constructor(req, connection) {
			super();
			this.req = req;
			this.socket = connection.socket;
			this.connection = connection.socket;
			this._conn = connection;
			this.statusCode = 200;
			this.statusMessage = undefined;
			this.sendDate = true;
			this._queued = [];
			this._turn = false;
			if (req.method === "HEAD") this._hasBody = false;
			this.shouldKeepAlive = req.shouldKeepAlive !== false;
			this.useChunkedEncodingByDefault = !(req.httpVersionMajor === 1 && req.httpVersionMinor === 0);
			if (req.httpVersionMajor === 1 && req.httpVersionMinor === 0) this.shouldKeepAlive = Boolean(req.shouldKeepAlive);
		}

		writeHead(statusCode, statusMessage, headers) {
			if (this.headersSent) {
				throw Object.assign(new Error("Cannot write headers after they are sent to the client"), { code: "ERR_HTTP_HEADERS_SENT" });
			}
			if (typeof statusMessage !== "string" && statusMessage !== undefined) {
				headers = statusMessage;
				statusMessage = undefined;
			}
			statusCode |= 0;
			if (statusCode < 100 || statusCode > 999) {
				throw Object.assign(new RangeError(`Invalid status code: ${statusCode}`), { code: "ERR_HTTP_INVALID_STATUS_CODE" });
			}
			this.statusCode = statusCode;
			if (statusMessage) this.statusMessage = statusMessage;
			if (headers) {
				if (Array.isArray(headers)) {
					if (headers.length && Array.isArray(headers[0])) for (const [n, v] of headers) this.setHeader(n, v);
					else for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
				} else for (const [n, v] of Object.entries(headers)) this.setHeader(n, v);
			}
			this._storeHeader(undefined);
			return this;
		}

		writeContinue(callback) {
			this._write(utf8("HTTP/1.1 100 Continue\r\n\r\n"), callback);
		}
		writeProcessing(callback) {
			this._write(utf8("HTTP/1.1 102 Processing\r\n\r\n"), callback);
		}
		writeEarlyHints(hints, callback) {
			let text = "HTTP/1.1 103 Early Hints\r\n";
			for (const [k, v] of Object.entries(hints)) text += `${k === "link" ? "Link" : k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`;
			this._write(utf8(`${text}\r\n`), callback);
		}

		assignSocket() {}
		detachSocket() {}

		_storeHeader(contentLength) {
			const code = this.statusCode;
			const message = this.statusMessage ?? STATUS_CODES[code] ?? "unknown";
			const extra = [];
			const bodyless = code === 204 || code === 304 || (code >= 100 && code < 200);
			if (bodyless) this._hasBody = false;
			if (this.sendDate && !this.hasHeader("date")) extra.push(["Date", new Date().toUTCString()]);

			const hasLength = this.hasHeader("content-length");
			const te = String(this.getHeader("transfer-encoding") ?? "");
			this._chunked = false;
			let closeAfter = !this.shouldKeepAlive || this._conn.server._closing === true;
			if (bodyless) {
				// No framing at all.
			} else if (hasLength) {
				// The handler chose the length.
			} else if (/chunked/i.test(te)) {
				this._chunked = this._hasBody;
			} else if (this._hasBody && contentLength !== undefined) {
				extra.push(["Content-Length", contentLength]);
			} else if (!this._hasBody && contentLength === undefined && !this.hasHeader("content-length") && this.req.method !== "HEAD") {
				extra.push(["Content-Length", 0]);
			} else if (this._hasBody && this.useChunkedEncodingByDefault) {
				extra.push(["Transfer-Encoding", "chunked"]);
				this._chunked = true;
			} else if (this._hasBody) {
				closeAfter = true; // HTTP/1.0 with no length: the end of the connection ends the body
			}
			this.chunkedEncoding = this._chunked;
			if (!this.hasHeader("connection")) {
				if (closeAfter) extra.push(["Connection", "close"]);
				else if (this.req.httpVersionMinor === 0) extra.push(["Connection", "keep-alive"]);
				else extra.push(["Connection", "keep-alive"], ["Keep-Alive", `timeout=${Math.ceil((this._conn.server.keepAliveTimeout ?? 5000) / 1000)}`]);
			} else if (/close/i.test(String(this.getHeader("connection")))) {
				closeAfter = true;
			}
			this._closeAfter = closeAfter;
			this._header = `HTTP/1.1 ${code} ${message}\r\n${this._headerLines(extra)}\r\n`;
		}

		/* Pipelined responses wait for the ones before them. */
		_write(bytes, callback) {
			if (!this._turn && this._conn.responses[0] !== this) {
				this._queued.push([bytes, callback]);
				return true;
			}
			return super._write(bytes, callback);
		}

		_writeLast(out) {
			if (!this._turn && this._conn.responses[0] !== this) {
				this._queued.push([out, () => {}]);
				this._lastQueued = true;
				return;
			}
			super._writeLast(out);
		}

		_startTurn() {
			this._turn = true;
			const queued = this._queued.splice(0);
			if (this._lastQueued) {
				const last = queued.pop();
				for (const [bytes, cb] of queued) super._write(bytes, cb);
				super._writeLast(last[0]);
			} else {
				for (const [bytes, cb] of queued) super._write(bytes, cb);
			}
		}

		_afterFinish() {
			if (!this._closeEmitted) {
				this._closeEmitted = true;
				queueMicrotask(() => this.emit("close"));
			}
			this._conn._responseDone(this);
		}
	}

	class ServerConnection {
		constructor(server, socket) {
			this.server = server;
			this.socket = socket;
			socket._http = this;
			this.responses = [];
			this.req = null; // the request whose body is being received
			this.closed = false;
			this.parser = new HttpParser("request", {
				head: (head) => this.onHead(head),
				body: (bytes) => this.req?.push(Buf().from(bytes)),
				end: () => this.onEnd(),
				upgrade: (rest) => this.onUpgrade(rest),
				error: (err) => this.onError(err),
			});
			this.onData = (chunk) => this.parser.feed(chunk);
			this.onSocketEnd = () => {
				this.parser.finish();
				// The peer has nothing more to say; answer what is owed, then go.
				if (!this.responses.length) socket.end();
			};
			this.onClose = () => this.onSocketClose();
			this.onSocketError = (err) => {
				if (err?.code === "ECONNRESET") return;
				this.server.emit("clientError", err, socket);
			};
			socket.on("data", this.onData);
			socket.on("end", this.onSocketEnd);
			socket.on("close", this.onClose);
			socket.on("error", this.onSocketError);
			this.armIdle();
		}

		armIdle() {
			const timeout = this.server.keepAliveTimeout ?? 5000;
			if (timeout > 0) this.socket.setTimeout(timeout, () => (this.responses.length || this.req ? undefined : this.socket.destroy()));
		}

		detach() {
			this.socket.off?.("data", this.onData);
			this.socket.removeListener("data", this.onData);
			this.socket.removeListener("end", this.onSocketEnd);
			this.socket.removeListener("close", this.onClose);
			this.socket.removeListener("error", this.onSocketError);
			this.socket.setTimeout(0);
		}

		onHead(head) {
			const req = new IncomingMessage(this.socket);
			req._fill(head);
			this.req = req;
			const res = new ServerResponse(req, this);
			res.shouldKeepAlive = res.shouldKeepAlive && !this.server._closing;
			this.responses.push(res);
			this.socket.setTimeout(0);
			if (head.upgrade) {
				this.pendingUpgrade = req;
				return;
			}
			const expect = String(head.headers.expect ?? "").toLowerCase();
			if (expect === "100-continue") {
				if (this.server.listenerCount("checkContinue")) this.server.emit("checkContinue", req, res);
				else {
					res.writeContinue();
					this.server.emit("request", req, res);
				}
			} else if (expect && this.server.listenerCount("checkExpectation")) {
				this.server.emit("checkExpectation", req, res);
			} else {
				this.server.emit("request", req, res);
			}
			res.once("finish", () => {
				// A handler that never read the body must not leave it to clog the socket.
				if (!req.complete) req.resume();
			});
		}

		onEnd() {
			const req = this.req;
			this.req = null;
			if (req) {
				req.complete = true;
				req.push(null);
			}
		}

		onUpgrade(rest) {
			const req = this.pendingUpgrade;
			this.pendingUpgrade = null;
			const res = this.responses.pop();
			this.detach();
			const event = req.method === "CONNECT" ? "connect" : "upgrade";
			if (this.server.listenerCount(event)) {
				this.server.emit(event, req, this.socket, Buf().from(rest));
			} else {
				this.socket.destroy();
			}
			res?.emit("close");
		}

		onError(err) {
			this.detach();
			this.socket.on("error", () => {});
			if (this.server.listenerCount("clientError")) {
				this.server.emit("clientError", err, this.socket);
				return;
			}
			if (this.socket.writable) {
				const status = err.code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
				this.socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
			}
			this.socket.destroy();
		}

		_responseDone(res) {
			const i = this.responses.indexOf(res);
			if (i >= 0) this.responses.splice(i, 1);
			if (res._closeAfter || this.closed || this.socket.destroyed) {
				if (!this.responses.length) this.socket.end();
				else if (this.responses[0]) this.responses[0]._startTurn();
				return;
			}
			if (this.responses[0]) this.responses[0]._startTurn();
			else this.armIdle();
		}

		onSocketClose() {
			this.closed = true;
			const req = this.req;
			if (req && !req.complete) {
				req.aborted = true;
				req.emit("aborted");
				// As in Node, the error is emitted only when someone is listening for it.
				req.destroy(req.listenerCount("error") ? Object.assign(new Error("aborted"), { code: "ECONNRESET" }) : undefined);
			}
			for (const res of this.responses) {
				if (!res._closeEmitted) {
					res._closeEmitted = true;
					res.emit("close");
				}
			}
		}
	}

	function makeServer(Base, event, prepare = (options) => options) {
		return class HttpServer extends Base {
			constructor(options, requestListener) {
				if (typeof options === "function") {
					requestListener = options;
					options = {};
				}
				super(prepare(options));
				this.keepAliveTimeout = options?.keepAliveTimeout ?? 5000;
				this.headersTimeout = options?.headersTimeout ?? 60000;
				this.requestTimeout = options?.requestTimeout ?? 300000;
				this.maxHeadersCount = null;
				this.timeout = 0;
				this.maxRequestsPerSocket = 0;
				this._closing = false;
				if (requestListener) this.on("request", requestListener);
				this.on(event, (socket) => new ServerConnection(this, socket));
			}
			setTimeout(ms, callback) {
				this.timeout = ms;
				if (callback) this.on("timeout", callback);
				return this;
			}
			close(callback) {
				this._closing = true;
				this.closeIdleConnections();
				return super.close(callback);
			}
			closeIdleConnections() {
				for (const socket of [...this._connections]) {
					if (socket._http && !socket._http.responses.length && !socket._http.req) socket.destroy();
				}
			}
		};
	}

	const httpServerBase = net.Server;
	const HttpServer = makeServer(httpServerBase, "connection");
	const HttpsServer = makeServer(tls.Server, "secureConnection", (options) => {
		if ((!options?.key || !options?.cert) && options?.pfx === undefined) throw new TypeError("https.createServer needs { key, cert } as PEM strings or Buffers, or a pfx");
		return options?.pfx !== undefined ? { ...options } : { ...options, key: String(options.key), cert: String(options.cert) };
	});

	/* ------------------------------------------------------------ client */

	class ClientRequest extends OutgoingMessage {
		constructor(defaultProtocol, input, options, callback) {
			super();
			if (typeof input === "string") input = urlToOptions(new URL(input));
			else if (input instanceof URL) input = urlToOptions(input);
			else {
				callback = options;
				options = input;
				input = null;
			}
			if (typeof options === "function") {
				callback = options;
				options = null;
			}
			const opts = { ...(input ?? {}), ...(options ?? {}) };
			const protocol = opts.protocol ?? defaultProtocol;
			const secure = protocol === "https:";
			this.agent = opts.agent === undefined ? (secure ? httpsGlobalAgent : httpGlobalAgent) : opts.agent;
			this.protocol = protocol;
			this.method = (opts.method ?? "GET").toUpperCase();
			this.path = opts.path ?? "/";
			if (/[\u0000- ]/.test(this.path)) {
				throw Object.assign(new TypeError(`Request path contains unescaped characters`), { code: "ERR_UNESCAPED_CHARACTERS" });
			}
			this.host = String(opts.hostname ?? opts.host ?? "localhost").replace(/^\[|\]$/g, "");
			this.port = Number(opts.port ?? opts.defaultPort ?? (secure ? 443 : 80));
			this.aborted = false;
			this.reusedSocket = false;
			this.maxHeadersCount = null;
			this.timeout = opts.timeout;
			this._opts = opts;
			this._secure = secure;
			this._response = null;
			this._connected = false;
			this.useChunkedEncodingByDefault = !["GET", "HEAD", "DELETE", "OPTIONS", "TRACE", "CONNECT"].includes(this.method);
			this.shouldKeepAlive = false;

			const headers = opts.headers ?? {};
			if (Array.isArray(headers)) {
				if (headers.length && Array.isArray(headers[0])) for (const [n, v] of headers) this.setHeader(n, v);
				else for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
			} else for (const [n, v] of Object.entries(headers)) if (v !== undefined) this.setHeader(n, v);
			if (opts.auth && !this.hasHeader("authorization")) {
				this.setHeader("Authorization", `Basic ${Buf().from(opts.auth).toString("base64")}`);
			}
			if (opts.setHost !== false && !this.hasHeader("host")) {
				const defaultPort = secure ? 443 : 80;
				const host = this.host.includes(":") ? `[${this.host}]` : this.host;
				this.setHeader("Host", this.port === defaultPort ? host : `${host}:${this.port}`);
			}
			if (callback) this.once("response", callback);
			if (opts.signal) {
				if (opts.signal.aborted) queueMicrotask(() => this.destroy(abortError()));
				else opts.signal.addEventListener("abort", () => this.destroy(abortError()), { once: true });
			}

			const connect = secure ? tls.connect : net.connect;
			const socket = opts.createConnection
				? opts.createConnection(opts, () => {})
				: connect({
						host: this.host,
						port: this.port,
						servername: opts.servername ?? this.host,
						rejectUnauthorized: opts.rejectUnauthorized !== false,
						...(secure ? tlsOptionsOf(opts) : {}),
				  });
			this._bind(socket);
			// 'socket' is announced after the caller could attach to the request.
			queueMicrotask(() => this.emit("socket", socket));
		}

		_bind(socket) {
			this.socket = socket;
			this.connection = socket;
			if (this.timeout) socket.setTimeout(this.timeout, () => this.emit("timeout"));
			this.parser = new HttpParser("response", {
				head: (head) => this._onHead(head),
				information: (head) => {
					this.emit("information", { statusCode: head.statusCode, statusMessage: head.statusMessage, headers: head.headers });
				},
				body: (bytes) => this._response?.push(Buf().from(bytes)),
				end: () => this._onEnd(),
				upgrade: (rest) => this._onUpgrade(rest),
				error: (err) => this._fail(err),
			});
			this.parser.headRequest = this.method === "HEAD";
			this.parser.connectRequest = this.method === "CONNECT";
			this._onData = (chunk) => this.parser.feed(chunk);
			this._onSockEnd = () => this.parser.finish();
			this._onSockClose = () => {
				if (this._done) return;
				if (this._response && !this._response.complete) {
					this._response.aborted = true;
					this._response.emit("aborted");
					this._response.destroy(
						this._response.listenerCount("error") ? Object.assign(new Error("aborted"), { code: "ECONNRESET" }) : undefined
					);
				} else if (!this._response && !this.aborted) {
					this._fail(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
				}
				if (!this._closeEmitted) {
					this._closeEmitted = true;
					this.emit("close");
				}
			};
			this._onSockError = (err) => this._fail(err);
			socket.on("data", this._onData);
			socket.on("end", this._onSockEnd);
			socket.on("close", this._onSockClose);
			socket.on("error", this._onSockError);
		}

		_fail(err) {
			if (this._failed) return;
			this._failed = true;
			if (this._response && !this._response.complete) {
				this._response.emit("error", err);
			} else if (!this._response) {
				this.emit("error", err);
			}
			this.socket?.destroy();
		}

		_onHead(head) {
			const res = new IncomingMessage(this.socket);
			res._fill(head);
			res.req = this;
			this._response = res;
			if (head.upgrade) {
				this._upgradeResponse = res;
				return;
			}
			if (!this.emit("response", res)) res.resume();
		}

		_onEnd() {
			const res = this._response;
			this._done = true;
			if (res) {
				res.complete = true;
				res.push(null);
			}
			this._detach();
			// One request per connection: the server was told so, and it is done with us.
			this.socket.end();
			queueMicrotask(() => {
				if (!this._closeEmitted) {
					this._closeEmitted = true;
					this.emit("close");
				}
			});
		}

		_onUpgrade(rest) {
			const res = this._upgradeResponse;
			this._done = true;
			this._detach();
			const event = this.method === "CONNECT" ? "connect" : "upgrade";
			if (this.listenerCount(event)) this.emit(event, res, this.socket, Buf().from(rest));
			else this.socket.destroy();
		}

		_detach() {
			this.socket.removeListener("data", this._onData);
			this.socket.removeListener("end", this._onSockEnd);
			this.socket.removeListener("close", this._onSockClose);
			this.socket.removeListener("error", this._onSockError);
			this.socket.on("error", () => {});
		}

		_storeHeader(contentLength) {
			const extra = [];
			const hasLength = this.hasHeader("content-length");
			const te = String(this.getHeader("transfer-encoding") ?? "");
			this._chunked = false;
			if (hasLength) {
				// chosen by the caller
			} else if (/chunked/i.test(te)) this._chunked = true;
			else if (contentLength !== undefined) {
				if (contentLength > 0 || this.method === "POST" || this.method === "PUT" || this.method === "PATCH") extra.push(["Content-Length", contentLength]);
			} else if (this.useChunkedEncodingByDefault || this._bodyStarted) {
				extra.push(["Transfer-Encoding", "chunked"]);
				this._chunked = true;
			}
			if (!this.hasHeader("connection")) extra.push(["Connection", "close"]);
			this._header = `${this.method} ${this.path} HTTP/1.1\r\n${this._headerLines(extra)}\r\n`;
		}

		write(chunk, encoding, callback) {
			// A body streamed before end() cannot be given a length up front.
			if (!this.headersSent) this._bodyStarted = true;
			return super.write(chunk, encoding, callback);
		}

		_writeLast(out) {
			// The request is sent; the response, not the write, completes the exchange.
			super._writeLast(out);
		}

		abort() {
			this.destroy();
		}
		destroy(err) {
			if (this.aborted) return this;
			this.aborted = true;
			if (err && !this._response) queueMicrotask(() => this.emit("error", err));
			if (!err) queueMicrotask(() => this.emit("abort"));
			this.socket?.destroy();
			return this;
		}
		setNoDelay(v) {
			this.socket?.setNoDelay?.(v);
		}
		setSocketKeepAlive(...a) {
			this.socket?.setKeepAlive?.(...a);
		}
		onSocket() {}
	}

	const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });

	function urlToOptions(url) {
		const options = {
			protocol: url.protocol,
			hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
			hash: url.hash,
			search: url.search,
			pathname: url.pathname,
			path: `${url.pathname || ""}${url.search || ""}`,
			href: url.href,
		};
		if (url.port !== "") options.port = Number(url.port);
		if (url.username || url.password) options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
		return options;
	}

	const httpGlobalAgent = new Agent();
	const httpsGlobalAgent = new Agent();
	httpsGlobalAgent.defaultPort = 443;
	httpsGlobalAgent.protocol = "https:";
	class HttpsAgent extends Agent {
		constructor(options) {
			super(options);
			this.defaultPort = 443;
			this.protocol = "https:";
		}
	}

	const make = (protocol, Server, GlobalAgent, AgentClass) => {
		const request = (input, options, callback) => new ClientRequest(protocol, input, options, callback);
		return {
			request,
			get(input, options, callback) {
				const req = request(input, options, callback);
				req.end();
				return req;
			},
			createServer: (options, listener) => new Server(options, listener),
			Server,
			Agent: AgentClass,
			globalAgent: GlobalAgent,
			IncomingMessage,
			OutgoingMessage,
			ServerResponse,
			ClientRequest,
			METHODS,
			STATUS_CODES,
			maxHeaderSize: 16384,
			validateHeaderName,
			validateHeaderValue,
			setMaxIdleHTTPParsers() {},
		};
	};

	const http = make("http:", HttpServer, httpGlobalAgent, Agent);
	const https = make("https:", HttpsServer, httpsGlobalAgent, HttpsAgent);
	return { http, https };
}

export { createHttpModules, HttpParser, STATUS_CODES, METHODS };

/*
 * Node's `http2` on the native host: HPACK, framing, multiplexed streams with flow control, settings, ping and goaway,
 * a server (createServer, createSecureServer) with the core `stream` API and the compatibility `request`/`response`
 * API, and a client (connect). It runs over the host's sockets: cleartext (h2c with prior knowledge, as Node) and TLS
 * with ALPN `h2`.
 *
 * Not provided, and said so when used: the HTTP/1.1 Upgrade to h2c (Node has no server side for it either),
 * `respondWithFD` on descriptors that are not regular files, stream priority (accepted, ignored, as nghttp2 does by
 * default) and `origin` frames.
 */

import { HPACK_STATIC, HTTP2_CONSTANTS, HUFFMAN_CODES, HUFFMAN_LENGTHS } from "./node-http2-data.js";

const C = HTTP2_CONSTANTS;
const FRAME = { DATA: 0, HEADERS: 1, PRIORITY: 2, RST_STREAM: 3, SETTINGS: 4, PUSH_PROMISE: 5, PING: 6, GOAWAY: 7, WINDOW_UPDATE: 8, CONTINUATION: 9 };
const FLAG = { END_STREAM: 1, ACK: 1, END_HEADERS: 4, PADDED: 8, PRIORITY: 0x20 };
const PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
const MAX_WINDOW = 2147483647;
const SETTING_IDS = {
	headerTableSize: 1,
	enablePush: 2,
	maxConcurrentStreams: 3,
	initialWindowSize: 4,
	maxFrameSize: 5,
	maxHeaderListSize: 6,
	enableConnectProtocol: 8,
};
const DEFAULT_SETTINGS = {
	headerTableSize: 4096,
	enablePush: true,
	initialWindowSize: 65535,
	maxFrameSize: 16384,
	maxConcurrentStreams: 4294967295,
	maxHeaderListSize: 65535,
	enableConnectProtocol: false,
};
const ERROR_NAMES = {};
for (const [name, value] of Object.entries(C)) {
	if (/^NGHTTP2_(NO_ERROR|PROTOCOL_ERROR|INTERNAL_ERROR|FLOW_CONTROL_ERROR|SETTINGS_TIMEOUT|STREAM_CLOSED|FRAME_SIZE_ERROR|REFUSED_STREAM|CANCEL|COMPRESSION_ERROR|CONNECT_ERROR|ENHANCE_YOUR_CALM|INADEQUATE_SECURITY|HTTP_1_1_REQUIRED)$/.test(name)) {
		ERROR_NAMES[value] = name;
	}
}
const ERR = {
	NO_ERROR: 0,
	PROTOCOL_ERROR: 1,
	INTERNAL_ERROR: 2,
	FLOW_CONTROL_ERROR: 3,
	SETTINGS_TIMEOUT: 4,
	STREAM_CLOSED: 5,
	FRAME_SIZE_ERROR: 6,
	REFUSED_STREAM: 7,
	CANCEL: 8,
	COMPRESSION_ERROR: 9,
};

/* ------------------------------------------------------------------------------------------- errors */

const messages = {
	ERR_HTTP2_HEADERS_SENT: () => "Response has already been initiated.",
	ERR_HTTP2_HEADERS_AFTER_RESPOND: () => "Cannot specify additional headers after response initiated",
	ERR_HTTP2_INVALID_STREAM: () => "The stream has been destroyed",
	ERR_HTTP2_INFO_STATUS_NOT_ALLOWED: () => "Informational status codes cannot be used",
	ERR_HTTP2_STATUS_INVALID: (code) => `Invalid status code: ${code}`,
	ERR_HTTP2_STATUS_101: () => "HTTP status code 101 (Switching Protocols) is forbidden in HTTP/2",
	ERR_HTTP2_INVALID_CONNECTION_HEADERS: (name) => `HTTP/1 Connection specific headers are forbidden: "${name}"`,
	ERR_HTTP2_INVALID_PSEUDOHEADER: (name) => `"${name}" is an invalid pseudoheader or is used incorrectly`,
	ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED: () => "Cannot set HTTP/2 pseudo-headers",
	ERR_HTTP2_STREAM_ERROR: (name) => `Stream closed with error code ${name}`,
	ERR_HTTP2_SESSION_ERROR: (name) => `Session closed with error code ${name}`,
	ERR_HTTP2_GOAWAY_SESSION: () => "New streams cannot be created after receiving a GOAWAY",
	ERR_HTTP2_INVALID_SESSION: () => "The session has been destroyed",
	ERR_HTTP2_STREAM_CANCEL: () => "The pending stream has been canceled",
	ERR_HTTP2_PUSH_DISABLED: () => "HTTP/2 client has disabled push streams",
	ERR_HTTP2_TRAILERS_ALREADY_SENT: () => "Trailing headers have already been sent",
	ERR_HTTP2_TRAILERS_NOT_READY: () => "Trailing headers cannot be sent until after the wantTrailers event is emitted",
	ERR_HTTP2_SEND_FILE: () => "Only regular files can be sent",
	ERR_HTTP2_SEND_FILE_NOSEEK: () => "Offsets or lengths can only be specified for regular files",
	ERR_HTTP2_PAYLOAD_FORBIDDEN: (code) => `Responses with ${code} status must not have a payload`,
	ERR_HTTP2_OUT_OF_STREAMS: () => "No stream ID is available because maximum stream ID has been reached",
	ERR_HTTP2_INVALID_SETTING_VALUE: (name, value) => `Invalid value for setting "${name}": ${value}`,
	ERR_HTTP2_ERROR: (text) => text ?? "Protocol error",
	ERR_HTTP2_PING_LENGTH: () => "HTTP2 ping payload must be 8 bytes",
	ERR_HTTP2_PING_CANCEL: () => "HTTP2 ping cancelled",
	ERR_HTTP2_SOCKET_UNBOUND: () => "The socket has been disconnected from the Http2Session",
	ERR_HTTP2_INVALID_HEADER_VALUE: (value, name) => `Invalid value "${value}" for header "${name}"`,
	ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS: () => "Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS",
	ERR_HTTP2_CONNECT_AUTHORITY: () => ":authority header is required for CONNECT requests",
	ERR_HTTP2_CONNECT_PATH: () => "The :path header is forbidden for CONNECT requests",
	ERR_HTTP2_CONNECT_SCHEME: () => "The :scheme header is forbidden for CONNECT requests",
	ERR_HTTP2_SETTINGS_CANCEL: () => "HTTP2 session settings canceled",
	ERR_HTTP2_ALTSVC_INVALID_ORIGIN: () => "HTTP/2 ALTSVC frames require a valid origin",
	ERR_HTTP2_UNSUPPORTED_PROTOCOL: (p) => `protocol "${p}" is unsupported.`,
	ERR_HTTP2_STREAM_SELF_DEPENDENCY: () => "A stream cannot depend on itself",
};
/* Which class Node gives each error: most are plain Errors, a few are TypeErrors or RangeErrors. */
const TYPE_ERRORS = new Set([
	"ERR_HTTP2_INVALID_PSEUDOHEADER",
	"ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED",
	"ERR_HTTP2_INVALID_HEADER_VALUE",
	"ERR_HTTP2_ALTSVC_INVALID_ORIGIN",
	"ERR_HTTP2_INVALID_CONNECTION_HEADERS",
	"ERR_HTTP2_INFO_STATUS_NOT_ALLOWED",
	"ERR_HTTP2_STATUS_101",
]);
const RANGE_ERRORS = new Set(["ERR_HTTP2_PING_LENGTH", "ERR_HTTP2_STATUS_INVALID"]);
/* h2Error(code, ...args); `ERR_HTTP2_INVALID_SETTING_VALUE` takes (name, value, isTypeProblem). */
function h2Error(code, ...args) {
	const make = messages[code];
	const error = new Error(make ? make(...args) : code);
	error.code = code;
	if (code === "ERR_HTTP2_INVALID_SETTING_VALUE") {
		Object.setPrototypeOf(error, args[2] ? TypeError.prototype : RangeError.prototype);
	} else if (TYPE_ERRORS.has(code)) {
		Object.setPrototypeOf(error, TypeError.prototype);
	} else if (RANGE_ERRORS.has(code)) {
		Object.setPrototypeOf(error, RangeError.prototype);
	}
	// Node prints the class name and code in the stack, e.g. "TypeError [ERR_HTTP2_...]: message"
	const name = Object.getPrototypeOf(error).name;
	Object.defineProperty(error, "stack", { value: `${name} [${code}]: ${error.message}\n    at http2`, configurable: true, writable: true });
	return error;
}
const invalidArg = (name, expected, value) =>
	Object.assign(new TypeError(`The "${name}" argument must be ${expected}. Received ${value === null ? "null" : value === undefined ? "undefined" : typeof value}`), { code: "ERR_INVALID_ARG_TYPE" });

/* -------------------------------------------------------------------------------------------- HPACK */

let huffmanTrie = null;
function buildTrie() {
	const nodes = [[-1, -1, -1]];
	for (let symbol = 0; symbol < 257; symbol++) {
		const code = HUFFMAN_CODES[symbol];
		const length = HUFFMAN_LENGTHS[symbol];
		let at = 0;
		for (let bit = length - 1; bit >= 0; bit--) {
			const branch = (code >>> bit) & 1;
			if (nodes[at][branch] === -1) {
				nodes.push([-1, -1, -1]);
				nodes[at][branch] = nodes.length - 1;
			}
			at = nodes[at][branch];
		}
		nodes[at][2] = symbol;
	}
	return nodes;
}
function huffmanDecode(bytes) {
	huffmanTrie ??= buildTrie();
	const out = [];
	let at = 0;
	let depth = 0;
	let allOnes = true;
	for (let i = 0; i < bytes.length; i++) {
		for (let bit = 7; bit >= 0; bit--) {
			const branch = (bytes[i] >> bit) & 1;
			const next = huffmanTrie[at][branch];
			if (next === -1) throw compressionError();
			at = next;
			depth++;
			if (branch === 0) allOnes = false;
			const symbol = huffmanTrie[at][2];
			if (symbol !== -1) {
				if (symbol === 256) throw compressionError();
				out.push(symbol);
				at = 0;
				depth = 0;
				allOnes = true;
			}
		}
	}
	// What is left over must be padding: fewer than 8 bits, all ones (a prefix of EOS).
	if (depth > 7 || (depth > 0 && !allOnes)) throw compressionError();
	return Uint8Array.from(out);
}
function huffmanEncode(bytes) {
	let bits = 0;
	for (const byte of bytes) bits += HUFFMAN_LENGTHS[byte];
	const out = new Uint8Array((bits + 7) >> 3);
	let acc = 0;
	let have = 0;
	let pos = 0;
	for (const byte of bytes) {
		acc = (acc * 2 ** HUFFMAN_LENGTHS[byte]) + HUFFMAN_CODES[byte];
		have += HUFFMAN_LENGTHS[byte];
		while (have >= 8) {
			have -= 8;
			out[pos++] = Math.floor(acc / 2 ** have) & 255;
			acc %= 2 ** have;
		}
	}
	if (have > 0) out[pos] = ((acc << (8 - have)) | (0xff >> have)) & 255;
	return out;
}
const compressionError = () => Object.assign(new Error("Compression error"), { hpack: true, code: "ERR_HTTP2_COMPRESSION_ERROR" });

class HpackTable {
	constructor(maxSize) {
		this.entries = []; // newest first
		this.size = 0;
		this.maxSize = maxSize;
		this.limit = maxSize;
	}
	get(index) {
		if (index < 1) throw compressionError();
		if (index <= 61) return HPACK_STATIC[index - 1];
		const entry = this.entries[index - 62];
		if (!entry) throw compressionError();
		return entry;
	}
	add(name, value) {
		const size = name.length + value.length + 32;
		if (size > this.maxSize) {
			this.entries.length = 0;
			this.size = 0;
			return;
		}
		this.entries.unshift([name, value]);
		this.size += size;
		this.evict();
	}
	evict() {
		while (this.size > this.maxSize && this.entries.length) {
			const [name, value] = this.entries.pop();
			this.size -= name.length + value.length + 32;
		}
	}
	resize(maxSize) {
		this.maxSize = maxSize;
		this.evict();
	}
}

class HpackDecoder {
	constructor(maxTableSize) {
		this.table = new HpackTable(maxTableSize);
		this.limit = maxTableSize; // what our SETTINGS allow the peer to use
	}
	setLimit(size) {
		this.limit = size;
	}
	decode(bytes, textDecoder, maxListSize) {
		const headers = [];
		let pos = 0;
		let total = 0;
		const readInt = (prefix) => {
			const max = (1 << prefix) - 1;
			let value = bytes[pos++] & max;
			if (value < max) return value;
			let shift = 0;
			for (;;) {
				if (pos >= bytes.length) throw compressionError();
				const byte = bytes[pos++];
				value += (byte & 127) * 2 ** shift;
				if (!(byte & 128)) return value;
				shift += 7;
				if (shift > 35) throw compressionError();
			}
		};
		const readString = () => {
			if (pos >= bytes.length) throw compressionError();
			const huffman = (bytes[pos] & 0x80) !== 0;
			const length = readInt(7);
			if (pos + length > bytes.length) throw compressionError();
			let raw = bytes.subarray(pos, pos + length);
			pos += length;
			if (huffman) raw = huffmanDecode(raw);
			return textDecoder(raw);
		};
		let sawField = false;
		while (pos < bytes.length) {
			const first = bytes[pos];
			if (first & 0x80) {
				const [name, value] = this.table.get(readInt(7));
				headers.push([name, value, false]);
				total += name.length + value.length + 32;
				sawField = true;
			} else if (first & 0x40) {
				const index = readInt(6);
				const name = index ? this.table.get(index)[0] : readString();
				const value = readString();
				this.table.add(name, value);
				headers.push([name, value, false]);
				total += name.length + value.length + 32;
				sawField = true;
			} else if (first & 0x20) {
				if (sawField) throw compressionError();
				const size = readInt(5);
				if (size > this.limit) throw compressionError();
				this.table.resize(size);
			} else {
				const never = (first & 0x10) !== 0;
				const index = readInt(4);
				const name = index ? this.table.get(index)[0] : readString();
				const value = readString();
				headers.push([name, value, never]);
				total += name.length + value.length + 32;
				sawField = true;
			}
			if (maxListSize && total > maxListSize * 4) throw Object.assign(new Error("header list too large"), { tooLarge: true });
		}
		return headers;
	}
}

class HpackEncoder {
	constructor(maxTableSize) {
		this.table = new HpackTable(maxTableSize);
		this.pendingResize = null;
	}
	setTableSize(size) {
		// The peer's SETTINGS_HEADER_TABLE_SIZE is an upper bound; announce a smaller table in the next block.
		this.pendingResize = Math.min(size, 4096);
		this.table.resize(this.pendingResize);
	}
	findIndex(name, value) {
		let nameIndex = 0;
		for (let i = 0; i < HPACK_STATIC.length; i++) {
			if (HPACK_STATIC[i][0] === name) {
				if (HPACK_STATIC[i][1] === value) return { index: i + 1, exact: true };
				if (!nameIndex) nameIndex = i + 1;
			}
		}
		const entries = this.table.entries;
		for (let i = 0; i < entries.length; i++) {
			if (entries[i][0] === name) {
				if (entries[i][1] === value) return { index: i + 62, exact: true };
				if (!nameIndex) nameIndex = i + 62;
			}
		}
		return { index: nameIndex, exact: false };
	}
	encode(headers, textEncoder) {
		const parts = [];
		const writeInt = (prefix, mask, value) => {
			const max = (1 << prefix) - 1;
			if (value < max) {
				parts.push(Uint8Array.of(mask | value));
				return;
			}
			const bytes = [mask | max];
			value -= max;
			while (value >= 128) {
				bytes.push((value & 127) | 128);
				value = Math.floor(value / 128);
			}
			bytes.push(value);
			parts.push(Uint8Array.from(bytes));
		};
		const writeString = (text) => {
			const raw = textEncoder(text);
			const packed = huffmanEncode(raw);
			if (packed.length < raw.length) {
				writeInt(7, 0x80, packed.length);
				parts.push(packed);
			} else {
				writeInt(7, 0, raw.length);
				parts.push(raw);
			}
		};
		if (this.pendingResize !== null) {
			writeInt(5, 0x20, this.pendingResize);
			this.pendingResize = null;
		}
		for (const [name, value, sensitive] of headers) {
			const { index, exact } = this.findIndex(name, value);
			if (exact && !sensitive) {
				writeInt(7, 0x80, index);
				continue;
			}
			const dynamic = !sensitive && name.length + value.length + 32 <= this.table.maxSize / 2;
			if (dynamic) {
				writeInt(6, 0x40, index);
			} else {
				writeInt(4, sensitive ? 0x10 : 0, index);
			}
			if (!index) writeString(name);
			writeString(value);
			if (dynamic) this.table.add(name, value);
		}
		let total = 0;
		for (const part of parts) total += part.length;
		const out = new Uint8Array(total);
		let offset = 0;
		for (const part of parts) {
			out.set(part, offset);
			offset += part.length;
		}
		return out;
	}
}

/* ------------------------------------------------------------------------------------- header helpers */

const SINGLE_VALUE = new Set([
	"age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host", "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards", "proxy-authorization", "referer", "retry-after", "server", "user-agent",
]);
const CONNECTION_HEADERS = new Set(["connection", "upgrade", "http2-settings", "keep-alive", "proxy-connection", "transfer-encoding"]);
const sensitiveHeaders = Symbol("nodejs.http2.sensitiveHeaders");
const kRawHeaders = Symbol("rawHeaders");

/* [[name, value, never], ...] -> the headers object Node gives programs. */
function headersToObject(list) {
	const headers = { __proto__: null };
	const sensitive = [];
	for (const [name, value, never] of list) {
		if (never) sensitive.push(name);
		if (name === ":status") {
			if (headers[name] === undefined) headers[name] = Number(value);
		} else if (name === "set-cookie") {
			if (headers[name] === undefined) headers[name] = [value];
			else headers[name].push(value);
		} else if (headers[name] === undefined) {
			headers[name] = value;
		} else if (name === "cookie") {
			headers[name] += `; ${value}`;
		} else if (name[0] === ":" || SINGLE_VALUE.has(name)) {
			// the first value wins
		} else {
			headers[name] += `, ${value}`;
		}
	}
	Object.defineProperty(headers, sensitiveHeaders, { value: sensitive, enumerable: false });
	return headers;
}

/* The headers object (or array of pairs) a program hands us -> [[name, value, never]] with validation. */
function headersToList(input, { allowPseudo = true, kind } = {}) {
	const list = [];
	const never = new Set(Array.isArray(input?.[sensitiveHeaders]) ? input[sensitiveHeaders].map((n) => String(n).toLowerCase()) : []);
	const add = (rawName, rawValue) => {
		const name = String(rawName).toLowerCase();
		if (rawValue === undefined || rawValue === null) return;
		if (name[0] === ":" && !allowPseudo) throw h2Error("ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED");
		if (CONNECTION_HEADERS.has(name) || (name === "te" && String(rawValue) !== "trailers")) throw h2Error("ERR_HTTP2_INVALID_CONNECTION_HEADERS", name);
		if (!/^:?[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
			throw Object.assign(new TypeError(`Header name must be a valid HTTP token ["${rawName}"]`), { code: "ERR_INVALID_HTTP_TOKEN" });
		}
		const values = Array.isArray(rawValue) ? rawValue : [rawValue];
		for (const value of values) {
			const text = String(value);
			if (/[^\t\x20-\x7e\x80-\xff]/.test(text)) throw Object.assign(new TypeError(`Invalid character in header content ["${name}"]`), { code: "ERR_INVALID_CHAR" });
			list.push([name, text, never.has(name) || (name === "cookie" && text.length < 20 && false)]);
		}
	};
	if (Array.isArray(input)) {
		if (input.length && Array.isArray(input[0])) for (const [n, v] of input) add(n, v);
		else for (let i = 0; i + 1 < input.length; i += 2) add(input[i], input[i + 1]);
	} else if (input) {
		for (const key of Object.keys(input)) add(key, input[key]);
	}
	// Pseudo-headers first, as the protocol requires.
	const pseudo = list.filter((h) => h[0][0] === ":");
	return [...pseudo, ...list.filter((h) => h[0][0] !== ":")];
}

/* -------------------------------------------------------------------------------------------- factory */

function createHttp2({ net, tls, http, fs, url: urlModule }, EventEmitter, stream, Buffer) {
	const { Duplex, Readable, Writable } = stream;
	const textEncoder = (text) => new Uint8Array(Buffer.from(text, "latin1").length === text.length ? Buffer.from(text, "latin1") : Buffer.from(text, "utf8"));
	const textDecoder = (bytes) => {
		const s = Buffer.from(bytes).toString("latin1");
		// Header values are bytes; anything that is valid UTF-8 and not plain ASCII is shown as such.
		if (/[\x80-\xff]/.test(s)) {
			const utf8 = Buffer.from(bytes).toString("utf8");
			if (!utf8.includes("�")) return utf8;
		}
		return s;
	};
	const asBuffer = (data, encoding) => (typeof data === "string" ? Buffer.from(data, encoding) : Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data));

	const SETTING_ORDER = ["headerTableSize", "enablePush", "initialWindowSize", "maxFrameSize", "maxConcurrentStreams", "maxHeaderListSize", "maxHeaderSize", "enableConnectProtocol"];
	const settingsObject = (values) => {
		const out = {};
		for (const key of SETTING_ORDER) {
			const id = key === "maxHeaderSize" ? SETTING_IDS.maxHeaderListSize : SETTING_IDS[key];
			if (values[id] !== undefined) out[key] = key === "enablePush" || key === "enableConnectProtocol" ? Boolean(values[id]) : values[id];
		}
		return out;
	};
	const validateSettings = (settings, allowPush = true) => {
		if (settings === null || typeof settings !== "object") throw invalidArg("settings", "of type object", settings);
		const checks = {
			headerTableSize: [0, 4294967295],
			initialWindowSize: [0, 4294967295],
			maxFrameSize: [16384, 16777215],
			maxConcurrentStreams: [0, 4294967295],
			maxHeaderListSize: [0, 4294967295],
			maxHeaderSize: [0, 4294967295],
		};
		for (const [key, value] of Object.entries(settings)) {
			if (value === undefined) continue;
			if (checks[key]) {
				if (!Number.isInteger(value) || value < checks[key][0] || value > checks[key][1]) throw h2Error("ERR_HTTP2_INVALID_SETTING_VALUE", key, value);
			} else if (key === "enablePush" || key === "enableConnectProtocol") {
				if (typeof value !== "boolean") throw h2Error("ERR_HTTP2_INVALID_SETTING_VALUE", key, value, true);
			}
		}
	};
	const packSettings = (settings) => {
		const entries = [];
		for (const [key, value] of Object.entries(settings)) {
			if (value === undefined) continue;
			const id = key === "maxHeaderSize" ? SETTING_IDS.maxHeaderListSize : SETTING_IDS[key];
			if (id) entries.push([id, typeof value === "boolean" ? Number(value) : value]);
		}
		if (Array.isArray(settings.customSettings)) for (const [id, value] of settings.customSettings) entries.push([id, value]);
		const out = Buffer.alloc(entries.length * 6);
		entries.forEach(([id, value], i) => {
			out.writeUInt16BE(id, i * 6);
			out.writeUInt32BE(value >>> 0, i * 6 + 2);
		});
		return out;
	};

	/* ------------------------------------------------------------------------------------ session */

	const NO_CLIENT = 0;
	const SESSION_SERVER = 0;
	const SESSION_CLIENT = 1;

	class Http2Session extends EventEmitter {
		constructor(type, socket, options = {}) {
			super();
			this._type = type;
			this._socket = socket;
			this._options = options;
			this._streams = new Map();
			this._nextStreamId = type === SESSION_CLIENT ? 1 : 2;
			this._lastProcessed = 0;
			this._lastPeerStream = 0;
			this._recv = [];
			this._recvLength = 0;
			this._prefaceSeen = type === SESSION_CLIENT;
			this._closing = false;
			this._destroyed = false;
			this._goawayReceived = null;
			this._goawaySent = false;
			this._outgoing = [];
			this._flushScheduled = false;
			this._headerBlock = null;
			this._pendingSettings = [];
			this._pings = [];
			this._sendQueue = [];
			this._pumping = false;
			this._socketReady = !socket.connecting;
			this._connected = false;
			this._timeout = 0;

			const local = { ...DEFAULT_SETTINGS, ...(options.settings ?? {}) };
			if (local.maxHeaderSize !== undefined) local.maxHeaderListSize = local.maxHeaderSize;
			delete local.maxHeaderSize;
			// nghttp2's own defaults, which are not the ones getDefaultSettings() reports.
			this._local = { ...DEFAULT_SETTINGS, maxHeaderListSize: 4294967295 };
			// Until the peer's SETTINGS arrive, nghttp2 assumes it accepts 100 concurrent streams.
			this._remote = { ...DEFAULT_SETTINGS, maxHeaderListSize: 4294967295, maxConcurrentStreams: 100 };
			this._localRequested = { ...options.settings };
			this._sendWindow = 65535;
			this._recvWindow = 65535;
			this._recvUnacked = 0;
			this._decoder = new HpackDecoder(this._local.headerTableSize);
			this._encoder = new HpackEncoder(4096);
			this._maxHeaderPairs = options.maxHeaderListPairs ?? 128;
			this._remoteSettingsReceived = false;
			this.encrypted = Boolean(socket.encrypted);
			this.alpnProtocol = socket.alpnProtocol || (this.encrypted ? undefined : "h2c");
			this.originSet = undefined;
			this.pendingSettingsAck = false;
			this.type = type;
			this.destroyed = false;
			this.closed = false;
			this.connecting = Boolean(socket.connecting);
			this.frameError = undefined;

			this._onData = (chunk) => this._receive(chunk);
			this._onSocketEnd = () => {
				if (!this._destroyed) this._socketGone(null);
			};
			this._onSocketError = (err) => {
				if (this._destroyed) return;
				this._socketGone(err);
			};
			this._onSocketClose = () => {
				if (!this._destroyed) this._socketGone(null);
			};
			this._onDrain = () => this._pump();
			socket.on("data", this._onData);
			socket.on("end", this._onSocketEnd);
			socket.on("error", this._onSocketError);
			socket.on("close", this._onSocketClose);
			socket.on("drain", this._onDrain);
			socket.on("timeout", () => this.emit("timeout"));
			if (options.unref) socket.unref?.();

			if (type === SESSION_CLIENT) this._writeRaw(Buffer.from(PREFACE, "latin1"));
			// Our SETTINGS go out first, whichever side we are.
			this._sendSettings(options.settings ?? {}, true);
			const initialWindow = options.initialWindowSize ?? undefined;
			if (options.windowSize !== undefined && options.windowSize > 65535) this._sendWindowUpdate(0, options.windowSize - 65535, true);
			void initialWindow;
		}

		/* ---- properties Node exposes */
		get socket() {
			return this._socket;
		}
		get state() {
			return {
				effectiveLocalWindowSize: this._recvWindow,
				effectiveRecvDataLength: this._recvWindow,
				nextStreamID: this._nextStreamId,
				localWindowSize: this._recvWindow,
				lastProcStreamID: this._lastProcessed,
				remoteWindowSize: this._sendWindow,
				outboundQueueSize: this._outgoing.length,
				deflateDynamicTableSize: this._encoder.table.size,
				inflateDynamicTableSize: this._decoder.table.size,
			};
		}
		get localSettings() {
			return settingsObject(this._localAsIds());
		}
		get remoteSettings() {
			return settingsObject(this._remoteAsIds());
		}
		_localAsIds() {
			const out = {};
			for (const [key, id] of Object.entries(SETTING_IDS)) out[id] = this._local[key];
			return out;
		}
		_remoteAsIds() {
			const out = {};
			for (const [key, id] of Object.entries(SETTING_IDS)) out[id] = this._remote[key];
			return out;
		}
		get pendingSettingsAckCount() {
			return this._pendingSettings.length;
		}

		/* ---- output */
		_writeRaw(bytes) {
			if (this._destroyed && !this._closing) return;
			this._outgoing.push(bytes);
			if (!this._flushScheduled) {
				this._flushScheduled = true;
				queueMicrotask(() => this._flushOut());
			}
		}
		_flushOut() {
			this._flushScheduled = false;
			if (!this._outgoing.length || (this._socket.destroyed && !this._socket.writable)) {
				this._outgoing.length = 0;
				return;
			}
			if (!this._socketReady && (this._socket.connecting || !this._socket.writable)) {
				// A client session writes before the connection is up: hold everything until it is.
				if (this._socket.connecting) return;
			}
			const data = Buffer.concat(this._outgoing);
			this._outgoing.length = 0;
			try {
				this._socket.write(data);
			} catch {
				// the socket is gone; its 'close' handler tears the session down
			}
		}
		_socketConnected() {
			this._socketReady = true;
			this.connecting = false;
			if (!this._connected && this._type === SESSION_CLIENT) {
				this._connected = true;
				queueMicrotask(() => this.emit("connect", this, this._socket));
			}
			this._flushOut();
			this._pump();
		}
		_frame(type, flags, streamId, payload) {
			const length = payload ? payload.length : 0;
			const header = Buffer.alloc(9);
			header[0] = (length >> 16) & 255;
			header[1] = (length >> 8) & 255;
			header[2] = length & 255;
			header[3] = type;
			header[4] = flags;
			header.writeUInt32BE(streamId & 0x7fffffff, 5);
			this._writeRaw(length ? Buffer.concat([header, payload]) : header);
		}
		_sendSettings(settings, initial) {
			const wanted = { ...settings };
			if (wanted.maxHeaderSize !== undefined && wanted.maxHeaderListSize === undefined) wanted.maxHeaderListSize = wanted.maxHeaderSize;
			delete wanted.maxHeaderSize;
			this._frame(FRAME.SETTINGS, 0, 0, packSettings(wanted));
			this._pendingSettings.push({ settings: wanted, callback: initial ? null : undefined, sent: Date.now() });
			this.pendingSettingsAck = true;
		}
		_sendWindowUpdate(streamId, increment, quiet) {
			if (increment <= 0) return;
			const payload = Buffer.alloc(4);
			payload.writeUInt32BE(increment >>> 0, 0);
			this._frame(FRAME.WINDOW_UPDATE, 0, streamId, payload);
			if (streamId === 0 && quiet) this._recvWindow += increment;
		}
		_sendRst(streamId, code) {
			const payload = Buffer.alloc(4);
			payload.writeUInt32BE(code >>> 0, 0);
			this._frame(FRAME.RST_STREAM, 0, streamId, payload);
		}
		_sendGoaway(code, opaque) {
			const extra = opaque ? asBuffer(opaque) : Buffer.alloc(0);
			const payload = Buffer.alloc(8 + extra.length);
			payload.writeUInt32BE(this._lastPeerStream & 0x7fffffff, 0);
			payload.writeUInt32BE(code >>> 0, 4);
			extra.copy(payload, 8);
			this._frame(FRAME.GOAWAY, 0, 0, payload);
			this._goawaySent = true;
		}
		_sendHeaderBlock(streamId, list, flags, extra) {
			const block = this._encoder.encode(list, textEncoder);
			const max = this._remote.maxFrameSize;
			const prefix = extra ?? Buffer.alloc(0);
			const first = Math.min(block.length, max - prefix.length);
			const done = first >= block.length;
			this._frame(FRAME.HEADERS, flags | (done ? FLAG.END_HEADERS : 0), streamId, Buffer.concat([prefix, block.subarray(0, first)]));
			for (let at = first; at < block.length; at += max) {
				const chunk = block.subarray(at, at + max);
				this._frame(FRAME.CONTINUATION, at + max >= block.length ? FLAG.END_HEADERS : 0, streamId, chunk);
			}
		}

		/* ---- public methods */
		settings(settings, callback) {
			if (this._destroyed) throw h2Error("ERR_HTTP2_INVALID_SESSION");
			validateSettings(settings);
			if (callback !== undefined && typeof callback !== "function") throw invalidArg("callback", "of type function", callback);
			const wanted = { ...settings };
			if (wanted.maxHeaderSize !== undefined && wanted.maxHeaderListSize === undefined) wanted.maxHeaderListSize = wanted.maxHeaderSize;
			delete wanted.maxHeaderSize;
			this._frame(FRAME.SETTINGS, 0, 0, packSettings(wanted));
			this._pendingSettings.push({ settings: wanted, callback, sent: Date.now() });
			this.pendingSettingsAck = true;
		}
		ping(payload, callback) {
			if (typeof payload === "function") {
				callback = payload;
				payload = undefined;
			}
			if (this._destroyed) throw h2Error("ERR_HTTP2_INVALID_SESSION");
			if (typeof callback !== "function") throw invalidArg("callback", "of type function", callback);
			let data;
			if (payload === undefined) {
				data = Buffer.alloc(8);
				for (let i = 0; i < 8; i++) data[i] = Math.floor(Math.random() * 256);
			} else {
				if (!ArrayBuffer.isView(payload)) throw invalidArg("payload", "an instance of Buffer, TypedArray, or DataView", payload);
				data = asBuffer(payload);
				if (data.length !== 8) throw h2Error("ERR_HTTP2_PING_LENGTH");
			}
			this._pings.push({ data, callback, started: Date.now() });
			this._frame(FRAME.PING, 0, 0, data);
			return true;
		}
		goaway(code = 0, lastStreamID = this._lastPeerStream, opaqueData) {
			if (this._destroyed) throw h2Error("ERR_HTTP2_INVALID_SESSION");
			const extra = opaqueData ? asBuffer(opaqueData) : Buffer.alloc(0);
			const payload = Buffer.alloc(8 + extra.length);
			payload.writeUInt32BE(lastStreamID & 0x7fffffff, 0);
			payload.writeUInt32BE(code >>> 0, 4);
			extra.copy(payload, 8);
			this._frame(FRAME.GOAWAY, 0, 0, payload);
			this._goawaySent = true;
		}
		setLocalWindowSize(size) {
			if (!Number.isInteger(size) || size < 0 || size > MAX_WINDOW) throw Object.assign(new RangeError(`The value of "windowSize" is out of range. It must be >= 0 && <= ${MAX_WINDOW}. Received ${size}`), { code: "ERR_OUT_OF_RANGE" });
			if (size > this._recvWindow) this._sendWindowUpdate(0, size - this._recvWindow, true);
		}
		setTimeout(ms, callback) {
			if (callback) this.once("timeout", callback);
			this._timeout = ms;
			this._socket.setTimeout(ms);
			return this;
		}
		ref() {
			this._socket.ref?.();
		}
		unref() {
			this._socket.unref?.();
		}
		close(callback) {
			if (callback) this.once("close", callback);
			if (this._closing) return;
			this._closing = true;
			this.closed = true;
			if (!this._goawaySent) this._sendGoaway(ERR.NO_ERROR);
			this._maybeFinish();
		}
		destroy(error, code) {
			if (this._destroyed) return;
			if (typeof error === "number") {
				code = error;
				error = undefined;
			}
			if (code === undefined) code = error ? ERR.INTERNAL_ERROR : ERR.NO_ERROR;
			if (!this._goawaySent && this._socketReady) this._sendGoaway(code);
			this._finishDestroy(error);
		}
		_maybeFinish() {
			if (this._closing && !this._destroyed && this._streams.size === 0 && !this._sendQueue.length) {
				this._flushOut();
				this._finishDestroy(undefined, true);
			}
		}
		_finishDestroy(error, graceful) {
			if (this._destroyed) return;
			this._destroyed = true;
			this.destroyed = true;
			this.closed = true;
			this.connecting = false;
			for (const stream of [...this._streams.values()]) {
				stream._sessionGone(error);
			}
			for (const ping of this._pings.splice(0)) ping.callback(h2Error("ERR_HTTP2_PING_CANCEL"), 0, ping.data);
			for (const pending of this._pendingSettings.splice(0)) if (typeof pending.callback === "function") pending.callback(h2Error("ERR_HTTP2_SETTINGS_CANCEL"));
			this._flushOut();
			const socket = this._socket;
			const detach = () => {
				socket.removeListener("data", this._onData);
				socket.removeListener("drain", this._onDrain);
			};
			if (graceful && !socket.destroyed) {
				socket.end();
				detach();
			} else {
				detach();
				socket.destroy();
			}
			if (error) this.emit("error", error);
			queueMicrotask(() => this.emit("close"));
		}
		_socketGone(err) {
			if (this._destroyed) return;
			if (err) {
				this._finishDestroy(err);
			} else if (this._streams.size && !this._goawayReceived) {
				const error = h2Error("ERR_HTTP2_SESSION_ERROR", "NGHTTP2_INTERNAL_ERROR");
				this._finishDestroy(this._type === SESSION_CLIENT ? error : undefined);
			} else {
				this._finishDestroy(undefined);
			}
		}

		/* ---- data out */
		_queueData(stream, chunk, callback) {
			stream._outChunks.push({ chunk, callback, offset: 0 });
			this._schedule(stream);
		}
		_queueEnd(stream, callback) {
			stream._endPending = true;
			stream._endCallback = callback;
			this._schedule(stream);
		}
		_schedule(stream) {
			if (!stream._scheduled) {
				stream._scheduled = true;
				this._sendQueue.push(stream);
			}
			if (this._socketReady) this._pump();
		}
		_pump() {
			if (this._pumping || this._destroyed || !this._socketReady) return;
			this._pumping = true;
			try {
				let progress = true;
				while (progress && this._sendQueue.length) {
					progress = false;
					for (let i = 0; i < this._sendQueue.length; ) {
						const stream = this._sendQueue[i];
						if (stream.destroyed && !stream._closedByProtocol) {
							stream._scheduled = false;
							this._sendQueue.splice(i, 1);
							continue;
						}
						if (!stream._headersSent && stream._session && stream._defaultRespond) stream._defaultRespond();
						if (!stream._headersSent) {
							i++;
							continue;
						}
						let sentSomething = false;
						while (stream._outChunks.length) {
							const window = Math.min(stream._sendWindow, this._sendWindow);
							const item = stream._outChunks[0];
							const remaining = item.chunk.length - item.offset;
							if (remaining === 0) {
								stream._outChunks.shift();
								item.callback?.();
								continue;
							}
							if (window <= 0) break;
							const size = Math.min(remaining, window, this._remote.maxFrameSize);
							const last = size === remaining && stream._outChunks.length === 1 && stream._endPending && !stream._waitForTrailers;
							this._frame(FRAME.DATA, last ? FLAG.END_STREAM : 0, stream.id, item.chunk.subarray(item.offset, item.offset + size));
							item.offset += size;
							stream._sendWindow -= size;
							this._sendWindow -= size;
							stream.bytesWritten += size;
							sentSomething = true;
							if (item.offset >= item.chunk.length) {
								stream._outChunks.shift();
								item.callback?.();
							}
							if (last) {
								stream._localClosed = true;
								stream._endPending = false;
								const done = stream._endCallback;
								stream._endCallback = null;
								done?.();
								stream._maybeClosed();
							}
							if (this._socket.writableNeedDrain) {
								this._flushOut();
								if (this._socket.writableNeedDrain) {
									this._pumping = false;
									return;
								}
							}
						}
						if (!stream._outChunks.length && stream._endPending && !stream._localClosed) {
							if (stream._waitForTrailers) {
								stream._endPending = false;
								const done = stream._endCallback;
								stream._endCallback = null;
								done?.();
								stream._wantTrailers();
							} else {
								this._frame(FRAME.DATA, FLAG.END_STREAM, stream.id, null);
								stream._localClosed = true;
								stream._endPending = false;
								const done = stream._endCallback;
								stream._endCallback = null;
								done?.();
								stream._maybeClosed();
							}
							sentSomething = true;
						}
						if (sentSomething) progress = true;
						if (!stream._outChunks.length && !stream._endPending) {
							stream._scheduled = false;
							this._sendQueue.splice(i, 1);
						} else {
							i++;
						}
					}
				}
			} finally {
				this._pumping = false;
			}
			this._maybeFinish();
		}

		/* ---- input */
		_receive(chunk) {
			if (this._destroyed) return;
			this._recv.push(chunk);
			this._recvLength += chunk.length;
			try {
				this._parse();
			} catch (err) {
				if (err && err.h2code !== undefined) {
					this._connectionError(err.h2code, err.message);
				} else {
					this._connectionError(ERR.INTERNAL_ERROR, String(err && err.message));
				}
			}
		}
		_take(count) {
			if (this._recv.length > 1) {
				this._recv = [Buffer.concat(this._recv)];
			}
			const whole = this._recv[0];
			const out = whole.subarray(0, count);
			const rest = whole.subarray(count);
			this._recv = rest.length ? [rest] : [];
			this._recvLength -= count;
			return out;
		}
		_peek(count) {
			if (this._recv.length > 1) this._recv = [Buffer.concat(this._recv)];
			return this._recv[0].subarray(0, count);
		}
		_connectionError(code, text) {
			if (this._destroyed) return;
			const error = h2Error("ERR_HTTP2_SESSION_ERROR", ERROR_NAMES[code] ?? code);
			if (text) error.detail = text;
			if (!this._goawaySent) this._sendGoaway(code);
			this._flushOut();
			this._finishDestroy(error);
		}
		_parse() {
			if (!this._prefaceSeen) {
				if (this._recvLength < PREFACE.length) {
					const have = this._peek(this._recvLength).toString("latin1");
					if (!PREFACE.startsWith(have)) throw Object.assign(new Error("bad preface"), { h2code: ERR.PROTOCOL_ERROR });
					return;
				}
				if (this._take(PREFACE.length).toString("latin1") !== PREFACE) throw Object.assign(new Error("bad preface"), { h2code: ERR.PROTOCOL_ERROR });
				this._prefaceSeen = true;
			}
			while (this._recvLength >= 9) {
				const header = this._peek(9);
				const length = (header[0] << 16) | (header[1] << 8) | header[2];
				if (length > this._local.maxFrameSize) throw Object.assign(new Error("frame too large"), { h2code: ERR.FRAME_SIZE_ERROR });
				if (this._recvLength < 9 + length) return;
				this._take(9);
				const type = header[3];
				const flags = header[4];
				const streamId = header.readUInt32BE(5) & 0x7fffffff;
				const payload = length ? Buffer.from(this._take(length)) : Buffer.alloc(0);
				this._handleFrame(type, flags, streamId, payload);
				if (this._destroyed) return;
			}
		}
		_handleFrame(type, flags, streamId, payload) {
			if (this._headerBlock && type !== FRAME.CONTINUATION) throw Object.assign(new Error("expected CONTINUATION"), { h2code: ERR.PROTOCOL_ERROR });
			switch (type) {
				case FRAME.DATA:
					return this._onDataFrame(flags, streamId, payload);
				case FRAME.HEADERS:
					return this._onHeaders(flags, streamId, payload);
				case FRAME.PRIORITY:
					if (streamId === 0) throw Object.assign(new Error("PRIORITY on stream 0"), { h2code: ERR.PROTOCOL_ERROR });
					if (payload.length !== 5) throw Object.assign(new Error("bad PRIORITY"), { h2code: ERR.FRAME_SIZE_ERROR });
					return undefined;
				case FRAME.RST_STREAM:
					return this._onRst(streamId, payload);
				case FRAME.SETTINGS:
					return this._onSettings(flags, streamId, payload);
				case FRAME.PUSH_PROMISE:
					return this._onPushPromise(flags, streamId, payload);
				case FRAME.PING:
					return this._onPing(flags, streamId, payload);
				case FRAME.GOAWAY:
					return this._onGoaway(streamId, payload);
				case FRAME.WINDOW_UPDATE:
					return this._onWindowUpdate(streamId, payload);
				case FRAME.CONTINUATION:
					return this._onContinuation(flags, streamId, payload);
				default:
					return undefined; // unknown frame types are ignored
			}
		}
		_unpad(flags, payload) {
			if (!(flags & FLAG.PADDED)) return payload;
			if (!payload.length) throw Object.assign(new Error("bad padding"), { h2code: ERR.FRAME_SIZE_ERROR });
			const pad = payload[0];
			if (pad >= payload.length) throw Object.assign(new Error("bad padding"), { h2code: ERR.PROTOCOL_ERROR });
			return payload.subarray(1, payload.length - pad);
		}
		_onDataFrame(flags, streamId, payload) {
			if (streamId === 0) throw Object.assign(new Error("DATA on stream 0"), { h2code: ERR.PROTOCOL_ERROR });
			const counted = payload.length;
			const data = this._unpad(flags, payload);
			this._recvWindow -= counted;
			if (this._recvWindow < 0) throw Object.assign(new Error("flow control"), { h2code: ERR.FLOW_CONTROL_ERROR });
			this._recvUnacked += counted;
			const stream = this._streams.get(streamId);
			if (!stream || stream._remoteClosed) {
				if (streamId > this._lastPeerStream && this._type === SESSION_SERVER && streamId % 2 === 1) throw Object.assign(new Error("DATA on idle stream"), { h2code: ERR.PROTOCOL_ERROR });
				this._sendRst(streamId, ERR.STREAM_CLOSED);
				this._creditConnection();
				return;
			}
			stream._recvWindow -= counted;
			if (stream._recvWindow < 0) {
				stream._reset(ERR.FLOW_CONTROL_ERROR);
				this._creditConnection();
				return;
			}
			stream._onData(data, counted, Boolean(flags & FLAG.END_STREAM));
			this._creditConnection();
		}
		_creditConnection() {
			// The connection window is replenished as data arrives; each stream's window follows what its reader consumes.
			if (this._recvUnacked >= 16384 || this._recvWindow < 16384) {
				this._sendWindowUpdate(0, this._recvUnacked);
				this._recvWindow += this._recvUnacked;
				this._recvUnacked = 0;
			}
		}
		_onHeaders(flags, streamId, payload) {
			if (streamId === 0) throw Object.assign(new Error("HEADERS on stream 0"), { h2code: ERR.PROTOCOL_ERROR });
			let data = this._unpad(flags, payload);
			if (flags & FLAG.PRIORITY) {
				if (data.length < 5) throw Object.assign(new Error("bad priority"), { h2code: ERR.FRAME_SIZE_ERROR });
				data = data.subarray(5);
			}
			this._headerBlock = { streamId, chunks: [data], endStream: Boolean(flags & FLAG.END_STREAM), push: false };
			if (flags & FLAG.END_HEADERS) this._finishHeaders();
		}
		_onPushPromise(flags, streamId, payload) {
			if (this._type !== SESSION_CLIENT || !this._local.enablePush) throw Object.assign(new Error("PUSH_PROMISE not allowed"), { h2code: ERR.PROTOCOL_ERROR });
			const data = this._unpad(flags, payload);
			const promised = data.readUInt32BE(0) & 0x7fffffff;
			this._headerBlock = { streamId, promised, chunks: [data.subarray(4)], endStream: false, push: true };
			if (flags & FLAG.END_HEADERS) this._finishHeaders();
		}
		_onContinuation(flags, streamId, payload) {
			if (!this._headerBlock || this._headerBlock.streamId !== streamId) throw Object.assign(new Error("unexpected CONTINUATION"), { h2code: ERR.PROTOCOL_ERROR });
			this._headerBlock.chunks.push(payload);
			if (flags & FLAG.END_HEADERS) this._finishHeaders();
		}
		_finishHeaders() {
			const block = this._headerBlock;
			this._headerBlock = null;
			const bytes = block.chunks.length === 1 ? block.chunks[0] : Buffer.concat(block.chunks);
			let list;
			try {
				list = this._decoder.decode(bytes, textDecoder, this._local.maxHeaderListSize);
			} catch (err) {
				if (err.tooLarge) {
					if (block.streamId) this._sendRst(block.streamId, ERR.REFUSED_STREAM);
					return;
				}
				throw Object.assign(new Error("compression error"), { h2code: ERR.COMPRESSION_ERROR });
			}
			if (this._maxHeaderPairs && list.length > this._maxHeaderPairs + 16) {
				this._sendRst(block.streamId, ERR.ENHANCE_YOUR_CALM ?? 11);
				return;
			}
			if (block.push) return this._onPushHeaders(block, list);
			const stream = this._streams.get(block.streamId);
			if (!stream) {
				if (this._type === SESSION_SERVER && block.streamId % 2 === 1 && block.streamId > this._lastPeerStream) {
					if (this._closing || this._goawaySent) {
						this._lastPeerStream = block.streamId;
						this._sendRst(block.streamId, ERR.REFUSED_STREAM);
						return;
					}
					return this._newRemoteStream(block.streamId, list, block.endStream);
				}
				if (block.streamId <= this._lastPeerStream || this._type === SESSION_CLIENT) {
					this._sendRst(block.streamId, ERR.STREAM_CLOSED);
					return;
				}
				throw Object.assign(new Error("HEADERS on unexpected stream"), { h2code: ERR.PROTOCOL_ERROR });
			}
			stream._onHeaders(list, block.endStream);
		}
		_newRemoteStream(id, list, endStream) {
			this._lastPeerStream = id;
			this._lastProcessed = id;
			const limit = this._local.maxConcurrentStreams;
			let open = 0;
			for (const s of this._streams.values()) if (s._remoteInitiated) open++;
			if (open >= limit) {
				this._sendRst(id, ERR.REFUSED_STREAM);
				return;
			}
			const stream = new ServerHttp2Stream(this, id);
			stream._remoteInitiated = true;
			this._streams.set(id, stream);
			const headers = headersToObject(list);
			const problem = validateRequestHeaders(headers, list);
			if (problem) {
				stream._reset(ERR.PROTOCOL_ERROR);
				return;
			}
			stream.endAfterHeaders = endStream;
			let flags = 4;
			if (endStream) flags |= 1;
			const rawHeaders = [];
			for (const [name, value] of list) rawHeaders.push(name, value);
			if (endStream) stream._remoteEnded();
			this.emit("stream", stream, headers, flags, rawHeaders);
			if (!stream.destroyed && !endStream) stream.resume?.call;
		}
		_onPushHeaders(block, list) {
			const parent = this._streams.get(block.streamId);
			// A push nobody is listening for, or one for a stream that is gone, is refused.
			if (!parent || this.listenerCount("stream") === 0) {
				this._sendRst(block.promised, ERR.REFUSED_STREAM);
				return;
			}
			const stream = new ClientHttp2Stream(this, block.promised);
			stream._isPush = true;
			stream._remoteInitiated = true;
			stream._localClosed = true;
			stream._headersSent = true;
			this._streams.set(block.promised, stream);
			const headers = headersToObject(list);
			stream.sentHeaders = headers;
			const rawHeaders = [];
			for (const [name, value] of list) rawHeaders.push(name, value);
			stream.end();
			this.emit("stream", stream, headers, 4, rawHeaders);
		}
		_onRst(streamId, payload) {
			if (streamId === 0) throw Object.assign(new Error("RST_STREAM on stream 0"), { h2code: ERR.PROTOCOL_ERROR });
			if (payload.length !== 4) throw Object.assign(new Error("bad RST_STREAM"), { h2code: ERR.FRAME_SIZE_ERROR });
			const stream = this._streams.get(streamId);
			if (stream) stream._onRst(payload.readUInt32BE(0));
		}
		_onSettings(flags, streamId, payload) {
			if (streamId !== 0) throw Object.assign(new Error("SETTINGS on a stream"), { h2code: ERR.PROTOCOL_ERROR });
			if (flags & FLAG.ACK) {
				if (payload.length) throw Object.assign(new Error("bad SETTINGS ACK"), { h2code: ERR.FRAME_SIZE_ERROR });
				const pending = this._pendingSettings.shift();
				if (pending) {
					for (const [key, value] of Object.entries(pending.settings)) if (key in this._local) this._local[key] = value;
					if (pending.settings.headerTableSize !== undefined) this._decoder.setLimit(pending.settings.headerTableSize);
					this.pendingSettingsAck = this._pendingSettings.length > 0;
					if (pending.callback !== null) {
						this.emit("localSettings", this.localSettings);
						if (typeof pending.callback === "function") pending.callback(null, this.localSettings, Date.now() - pending.sent);
					} else {
						this.emit("localSettings", this.localSettings);
					}
				}
				return;
			}
			if (payload.length % 6) throw Object.assign(new Error("bad SETTINGS"), { h2code: ERR.FRAME_SIZE_ERROR });
			// The 100 assumed until now is replaced by the protocol default once the peer has spoken.
			if (!this._remoteSettingsReceived) this._remote.maxConcurrentStreams = 4294967295;
			for (let i = 0; i < payload.length; i += 6) {
				const id = payload.readUInt16BE(i);
				const value = payload.readUInt32BE(i + 2);
				switch (id) {
					case 1:
						this._remote.headerTableSize = value;
						this._encoder.setTableSize(value);
						break;
					case 2:
						if (value > 1) throw Object.assign(new Error("bad ENABLE_PUSH"), { h2code: ERR.PROTOCOL_ERROR });
						this._remote.enablePush = value === 1;
						break;
					case 3:
						this._remote.maxConcurrentStreams = value;
						break;
					case 4: {
						if (value > MAX_WINDOW) throw Object.assign(new Error("bad INITIAL_WINDOW_SIZE"), { h2code: ERR.FLOW_CONTROL_ERROR });
						const delta = value - this._remote.initialWindowSize;
						this._remote.initialWindowSize = value;
						for (const stream of this._streams.values()) stream._sendWindow += delta;
						break;
					}
					case 5:
						if (value < 16384 || value > 16777215) throw Object.assign(new Error("bad MAX_FRAME_SIZE"), { h2code: ERR.PROTOCOL_ERROR });
						this._remote.maxFrameSize = value;
						break;
					case 6:
						this._remote.maxHeaderListSize = value;
						break;
					case 8:
						this._remote.enableConnectProtocol = value === 1;
						break;
					default:
						break;
				}
			}
			this._frame(FRAME.SETTINGS, FLAG.ACK, 0, null);
			this._remoteSettingsReceived = true;
			this.emit("remoteSettings", this.remoteSettings);
			this._pump();
		}
		_onPing(flags, streamId, payload) {
			if (streamId !== 0) throw Object.assign(new Error("PING on a stream"), { h2code: ERR.PROTOCOL_ERROR });
			if (payload.length !== 8) throw Object.assign(new Error("bad PING"), { h2code: ERR.FRAME_SIZE_ERROR });
			if (flags & FLAG.ACK) {
				const index = this._pings.findIndex((p) => p.data.equals(payload));
				if (index >= 0) {
					const [ping] = this._pings.splice(index, 1);
					ping.callback(null, Date.now() - ping.started, ping.data);
				}
				this.emit("pingack", payload);
				return;
			}
			this._frame(FRAME.PING, FLAG.ACK, 0, payload);
			this.emit("ping", payload);
		}
		_onGoaway(streamId, payload) {
			if (payload.length < 8) throw Object.assign(new Error("bad GOAWAY"), { h2code: ERR.FRAME_SIZE_ERROR });
			const lastStreamID = payload.readUInt32BE(0) & 0x7fffffff;
			const code = payload.readUInt32BE(4);
			const opaque = payload.subarray(8);
			this._goawayReceived = { lastStreamID, code };
			this.emit("goaway", code, lastStreamID, opaque.length ? Buffer.from(opaque) : undefined);
			for (const stream of [...this._streams.values()]) {
				if (this._type === SESSION_CLIENT && stream.id > lastStreamID && !stream._remoteInitiated) stream._sessionGone(h2Error("ERR_HTTP2_STREAM_CANCEL"), ERR.REFUSED_STREAM);
			}
			if (!this._closing) {
				this._closing = true;
				this.closed = true;
				this._maybeFinish();
			}
		}
		_onWindowUpdate(streamId, payload) {
			if (payload.length !== 4) throw Object.assign(new Error("bad WINDOW_UPDATE"), { h2code: ERR.FRAME_SIZE_ERROR });
			const increment = payload.readUInt32BE(0) & 0x7fffffff;
			if (streamId === 0) {
				if (increment === 0) throw Object.assign(new Error("zero WINDOW_UPDATE"), { h2code: ERR.PROTOCOL_ERROR });
				this._sendWindow += increment;
				if (this._sendWindow > MAX_WINDOW) throw Object.assign(new Error("window overflow"), { h2code: ERR.FLOW_CONTROL_ERROR });
			} else {
				const stream = this._streams.get(streamId);
				if (!stream) return;
				if (increment === 0) {
					stream._reset(ERR.PROTOCOL_ERROR);
					return;
				}
				stream._sendWindow += increment;
				if (stream._sendWindow > MAX_WINDOW) {
					stream._reset(ERR.FLOW_CONTROL_ERROR);
					return;
				}
			}
			this._pump();
		}

		/* ---- streams */
		_removeStream(stream) {
			this._streams.delete(stream.id);
			this._maybeFinish();
		}
	}

	function validateRequestHeaders(headers) {
		const method = headers[":method"];
		if (!method) return "missing :method";
		if (method !== "CONNECT" && (!headers[":path"] || !headers[":scheme"])) return "missing :path or :scheme";
		for (const name of Object.keys(headers)) {
			if (name !== name.toLowerCase()) return "uppercase header";
			if (CONNECTION_HEADERS.has(name) || (name === "te" && headers[name] !== "trailers")) return "connection header";
		}
		return null;
	}

	/* ------------------------------------------------------------------------------------- streams */

	class Http2Stream extends Duplex {
		constructor(session, id) {
			super({ allowHalfOpen: true, decodeStrings: false, autoDestroy: false, emitClose: true, readableHighWaterMark: 65536, writableHighWaterMark: 16384 });
			this._session = session;
			this.id = id;
			this._sendWindow = session._remote.initialWindowSize;
			this._recvWindow = session._local.initialWindowSize;
			this._recvUnacked = 0;
			this._outChunks = [];
			this._endPending = false;
			this._endCallback = null;
			this._scheduled = false;
			this._headersSent = false;
			this._localClosed = false;
			this._remoteClosed = false;
			this._closedByProtocol = false;
			this._waitForTrailers = false;
			this._trailersSent = false;
			this._wantTrailersEmitted = false;
			this._remoteInitiated = false;
			this.rstCode = undefined;
			this.aborted = false;
			this.closedByRst = false;
			this.bytesWritten = 0;
			this.sentHeaders = undefined;
			this.sentInfoHeaders = [];
			this.sentTrailers = undefined;
			this.endAfterHeaders = false;
			this._timeoutMs = 0;
			this.on("finish", () => this._maybeClosed());
			this.on("end", () => this._maybeClosed());
		}
		get session() {
			return this._session?.destroyed ? undefined : this._session;
		}
		get pending() {
			return this.id === undefined;
		}
		get headersSent() {
			return this._headersSent;
		}
		get closed() {
			return this._closedByProtocol;
		}
		get state() {
			const open = !this._closedByProtocol;
			return {
				state: !open ? C.NGHTTP2_STREAM_STATE_CLOSED : this._localClosed && this._remoteClosed ? C.NGHTTP2_STREAM_STATE_CLOSED : this._localClosed ? C.NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL : this._remoteClosed ? C.NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE : C.NGHTTP2_STREAM_STATE_OPEN,
				weight: 16,
				sumDependencyWeight: 0,
				localClose: this._localClosed ? 1 : 0,
				remoteClose: this._remoteClosed ? 1 : 0,
				localWindowSize: this._recvWindow,
			};
		}
		get bufferSize() {
			let n = this.writableLength;
			for (const item of this._outChunks) n += item.chunk.length - item.offset;
			return n;
		}
		get sentTrailersValue() {
			return this.sentTrailers;
		}
		setTimeout(ms, callback) {
			if (callback) this.once("timeout", callback);
			this._timeoutMs = ms;
			clearTimeout(this._timeoutTimer);
			if (ms > 0) {
				this._timeoutTimer = setTimeout(() => this.emit("timeout"), ms);
				this._timeoutTimer.unref?.();
			}
			return this;
		}
		priority() {}
		sendTrailers(headers) {
			if (this._trailersSent) throw h2Error("ERR_HTTP2_TRAILERS_ALREADY_SENT");
			if (!this._wantTrailersEmitted) throw h2Error("ERR_HTTP2_TRAILERS_NOT_READY");
			const list = headersToList(headers, { allowPseudo: false });
			this._trailersSent = true;
			this.sentTrailers = headersToObject(list);
			this._session._sendHeaderBlock(this.id, list, FLAG.END_STREAM);
			this._localClosed = true;
			this._maybeClosed();
		}
		_wantTrailers() {
			this._wantTrailersEmitted = true;
			this.emit("wantTrailers");
			// A program that never sends trailers still has to end the stream.
			queueMicrotask(() => {
				if (!this._trailersSent && !this._localClosed && !this._closedByProtocol && this.listenerCount("wantTrailers") === 0) {
					this._session._frame(FRAME.DATA, FLAG.END_STREAM, this.id, null);
					this._localClosed = true;
					this._maybeClosed();
				}
			});
		}
		close(code = ERR.NO_ERROR, callback) {
			if (callback) this.once("close", callback);
			if (this._closedByProtocol) return;
			this._reset(code);
		}
		/* Send RST_STREAM and finish the stream locally. */
		_reset(code) {
			if (this._closedByProtocol) return;
			if (this.id !== undefined && this._session && !this._session._destroyed) this._session._sendRst(this.id, code);
			this._protocolClose(code, true);
		}
		_protocolClose(code, byUs) {
			if (this._closedByProtocol) return;
			this._closedByProtocol = true;
			this.rstCode = code;
			this._localClosed = true;
			this._remoteClosed = true;
			clearTimeout(this._timeoutTimer);
			const session = this._session;
			if (session) session._removeStream(this);
			for (const item of this._outChunks.splice(0)) item.callback?.(h2Error("ERR_HTTP2_INVALID_STREAM"));
			this._endCallback?.();
			this._endCallback = null;
			if (code !== ERR.NO_ERROR && !byUs) this.closedByRst = true;
			if (!this.readableEnded && !this._readableState?.ended) this.push(null);
			const error = code !== ERR.NO_ERROR && code !== ERR.CANCEL ? h2Error("ERR_HTTP2_STREAM_ERROR", ERROR_NAMES[code] ?? code) : undefined;
			// Wait for buffered data to be read before closing, unless there is an error to report.
			if (error) this.destroy(error);
			else if (byUs || code === ERR.CANCEL || this.readableEnded || !this.readable) this.destroy();
			else this._destroyAfterEnd = true;
		}
		/* Both directions done: the stream ends cleanly. */
		_maybeClosed() {
			if (this._closedByProtocol) return;
			if (this._localClosed && this._remoteClosed) {
				this._closedByProtocol = true;
				this.rstCode = ERR.NO_ERROR;
				clearTimeout(this._timeoutTimer);
				this._session?._removeStream(this);
				if (this.readableEnded || this._readableState?.endEmitted) this.destroy();
				else this._destroyAfterEnd = true;
				if (this.readableFlowing === null && !this._readableState?.length) this.resume();
			}
		}
		_remoteEnded() {
			if (this._remoteClosed) return;
			this._remoteClosed = true;
			this.push(null);
			this._maybeClosed();
		}
		_sessionGone(error, code = ERR.CANCEL) {
			if (this._closedByProtocol) return;
			this._closedByProtocol = true;
			this.rstCode = code;
			this._localClosed = true;
			this._remoteClosed = true;
			this._session._streams.delete(this.id);
			for (const item of this._outChunks.splice(0)) item.callback?.(error ?? h2Error("ERR_HTTP2_INVALID_STREAM"));
			if (!this._readableState?.ended) this.push(null);
			this.destroy(error && error.code === "ERR_HTTP2_STREAM_CANCEL" ? error : undefined);
		}

		/* incoming DATA */
		_onData(data, counted, end) {
			// Padding counts against the window but is never read: return it at once.
			if (counted > data.length) this._consumed(counted - data.length);
			if (data.length) {
				this.bytesRead = (this.bytesRead ?? 0) + data.length;
				this.push(data);
			}
			if (end) this._remoteEnded();
		}
		_read() {}
		/* The reader took `count` bytes: give the peer that much window back, in batches. */
		_consumed(count) {
			const session = this._session;
			this._pendingCredit = (this._pendingCredit ?? 0) + count;
			if (session && !this._closedByProtocol && !session._destroyed && (this._pendingCredit >= 8192 || this._recvWindow < 32768)) {
				const credit = this._pendingCredit;
				this._pendingCredit = 0;
				this._recvWindow += credit;
				session._sendWindowUpdate(this.id, credit);
			}
		}
		_write(chunk, encoding, callback) {
			if (this._closedByProtocol) {
				callback(h2Error("ERR_HTTP2_INVALID_STREAM"));
				return;
			}
			if (this._localClosed) {
				callback(Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" }));
				return;
			}
			if (!this._headersSent && this._defaultRespond) this._defaultRespond();
			this._session._queueData(this, asBuffer(chunk, encoding), callback);
		}
		_final(callback) {
			if (this._closedByProtocol || this._localClosed) {
				callback();
				return;
			}
			if (!this._headersSent && this._defaultRespond) this._defaultRespond();
			this._session._queueEnd(this, callback);
		}
		_destroy(error, callback) {
			clearTimeout(this._timeoutTimer);
			// The writable side was still open when the stream ended: the peer went away mid-response.
			if (!this.writableEnded && !this.aborted) {
				this.aborted = true;
				this.emit("aborted");
			}
			if (!this._closedByProtocol) {
				const code = error ? ERR.INTERNAL_ERROR : ERR.CANCEL;
				if (this.id !== undefined && this._session && !this._session._destroyed) this._session._sendRst(this.id, code);
				this._closedByProtocol = true;
				this.rstCode = this.rstCode ?? code;
				this._session?._removeStream(this);
			}
			this._destroyAfterEnd = false;
			callback(error);
		}
		_onRst(code) {
			this._protocolClose(code, false);
		}
		emit(event, ...args) {
			if (event === "data" && args[0] && typeof args[0].length === "number") this._consumed(args[0].length);
			const result = super.emit(event, ...args);
			if (event === "end" && this._destroyAfterEnd && !this.destroyed) {
				this._destroyAfterEnd = false;
				this.destroy();
			}
			return result;
		}
	}

	class ServerHttp2Stream extends Http2Stream {
		constructor(session, id) {
			super(session, id);
			this._pushAllowed = session._remote.enablePush && session._type === SESSION_SERVER;
			this._responded = false;
			this._request = undefined;
		}
		get pushAllowed() {
			return this._pushAllowed && this._session?._remote.enablePush;
		}
		_defaultRespond() {
			if (!this._headersSent) this.respond();
		}
		_onHeaders(list, endStream) {
			// Trailers from the client.
			const headers = headersToObject(list);
			this.emit("trailers", headers, endStream ? 5 : 4, list.flat());
			if (endStream) this._remoteEnded();
		}
		respond(headers, options = {}) {
			if (this.destroyed || this._closedByProtocol) throw h2Error("ERR_HTTP2_INVALID_STREAM");
			if (this._headersSent) throw h2Error("ERR_HTTP2_HEADERS_SENT");
			const list = headersToList(headers ?? {}, { allowPseudo: true });
			for (const [name] of list) if (name[0] === ":" && name !== ":status") throw h2Error("ERR_HTTP2_INVALID_PSEUDOHEADER", name);
			let statusEntry = list.find((h) => h[0] === ":status");
			if (!statusEntry) {
				statusEntry = [":status", "200", false];
				list.unshift(statusEntry);
			}
			const status = Number(statusEntry[1]);
			if (!Number.isInteger(status) || status < 100 || status > 999) throw h2Error("ERR_HTTP2_STATUS_INVALID", statusEntry[1]);
			if (status < 200) throw h2Error("ERR_HTTP2_INFO_STATUS_NOT_ALLOWED");
			statusEntry[1] = String(status);
			list.sort((a, b) => (a[0] === ":status" ? -1 : b[0] === ":status" ? 1 : 0));
			let endStream = Boolean(options.endStream);
			const method = this.sentMethod ?? this._requestMethod;
			if (status === 204 || status === 205 || status === 304 || method === "HEAD") endStream = endStream || this._payloadless(status);
			this._waitForTrailers = Boolean(options.waitForTrailers);
			this._headersSent = true;
			this.sentHeaders = headersToObject(list);
			this._session._sendHeaderBlock(this.id, list, endStream && !this._waitForTrailers ? FLAG.END_STREAM : 0);
			this._responded = true;
			if (endStream) {
				if (this._waitForTrailers) {
					this.end();
					return;
				}
				this._localClosed = true;
				this.endAfterHeaders = true;
				// Nothing more may be written: finish the writable side without a DATA frame.
				this._session._sendQueue = this._session._sendQueue.filter((s) => s !== this);
				this._writableEndedByHeaders = true;
				this.end();
				this._maybeClosed();
			}
			this._session._pump();
		}
		_payloadless(status) {
			return status === 204 || status === 205 || status === 304 || this._requestMethod === "HEAD";
		}
		additionalHeaders(headers) {
			if (this.destroyed || this._closedByProtocol) throw h2Error("ERR_HTTP2_INVALID_STREAM");
			if (this._headersSent) throw h2Error("ERR_HTTP2_HEADERS_AFTER_RESPOND");
			const list = headersToList(headers ?? {}, { allowPseudo: true });
			const status = list.find((h) => h[0] === ":status");
			if (!status) throw h2Error("ERR_HTTP2_INVALID_PSEUDOHEADER", ":status");
			const code = Number(status[1]);
			if (code === 101) throw h2Error("ERR_HTTP2_STATUS_101");
			if (code < 100 || code >= 200) throw h2Error("ERR_HTTP2_INVALID_INFO_STATUS", code);
			this.sentInfoHeaders.push(headersToObject(list));
			this._session._sendHeaderBlock(this.id, list, 0);
		}
		pushStream(headers, options, callback) {
			if (typeof options === "function") {
				callback = options;
				options = {};
			}
			if (typeof callback !== "function") throw invalidArg("callback", "of type function", callback);
			if (!this._session._remote.enablePush) throw h2Error("ERR_HTTP2_PUSH_DISABLED");
			if (this.destroyed || this._closedByProtocol) throw h2Error("ERR_HTTP2_INVALID_STREAM");
			const list = headersToList(headers ?? {}, { allowPseudo: true });
			if (!list.find((h) => h[0] === ":path")) list.push([":path", "/", false]);
			if (!list.find((h) => h[0] === ":method")) list.unshift([":method", "GET", false]);
			if (!list.find((h) => h[0] === ":scheme")) list.push([":scheme", this._session.encrypted ? "https" : "http", false]);
			if (!list.find((h) => h[0] === ":authority")) {
				const authority = this._requestAuthority;
				if (authority) list.push([":authority", authority, false]);
			}
			const session = this._session;
			const id = session._nextStreamId;
			session._nextStreamId += 2;
			const pushed = new ServerHttp2Stream(session, id);
			pushed._pushAllowed = false;
			pushed._remoteClosed = true;
			pushed._requestMethod = "GET";
			session._streams.set(id, pushed);
			const block = session._encoder.encode(list, textEncoder);
			const payload = Buffer.alloc(4 + block.length);
			payload.writeUInt32BE(id, 0);
			Buffer.from(block).copy(payload, 4);
			session._frame(FRAME.PUSH_PROMISE, FLAG.END_HEADERS, this.id, payload);
			pushed.sentHeaders = undefined;
			pushed._pushedRequestHeaders = headersToObject(list);
			pushed.end0 = true;
			queueMicrotask(() => {
				pushed.push(null);
				callback(null, pushed, headersToObject(list));
			});
		}
		respondWithFile(path, headers, options = {}) {
			if (this.destroyed || this._closedByProtocol) throw h2Error("ERR_HTTP2_INVALID_STREAM");
			if (this._headersSent) throw h2Error("ERR_HTTP2_HEADERS_SENT");
			let stat;
			try {
				stat = fs.statSync(path);
			} catch (err) {
				if (typeof options.onError === "function") {
					options.onError(err);
					return;
				}
				this.destroy(err);
				return;
			}
			if (!stat.isFile()) {
				const err = h2Error("ERR_HTTP2_SEND_FILE");
				if (typeof options.onError === "function") options.onError(err);
				else this.destroy(err);
				return;
			}
			const offset = options.offset ?? 0;
			const length = options.length !== undefined && options.length >= 0 ? options.length : stat.size - offset;
			const out = { ...headers };
			if (options.statCheck) {
				if (options.statCheck(stat, out, { offset, length }) === false) return;
			}
			if (out["content-length"] === undefined) out["content-length"] = length;
			const data = fs.readFileSync(path);
			this.respond(out, { endStream: false, waitForTrailers: options.waitForTrailers });
			this.end(data.subarray(offset, offset + length));
		}
		respondWithFD(fd, headers, options = {}) {
			if (typeof fd === "object" && fd !== null && typeof fd.fd === "number") fd = fd.fd;
			let stat;
			try {
				stat = fs.fstatSync(fd);
			} catch (err) {
				this.destroy(err);
				return;
			}
			if (!stat.isFile()) {
				this.destroy(h2Error("ERR_HTTP2_SEND_FILE"));
				return;
			}
			const offset = options.offset ?? 0;
			const length = options.length !== undefined && options.length >= 0 ? options.length : stat.size - offset;
			const out = { ...headers };
			if (options.statCheck && options.statCheck(stat, out, { offset, length }) === false) return;
			if (out["content-length"] === undefined) out["content-length"] = length;
			const data = Buffer.alloc(length);
			fs.readSync(fd, data, 0, length, offset);
			this.respond(out, { endStream: false, waitForTrailers: options.waitForTrailers });
			this.end(data);
		}
	}

	class ClientHttp2Stream extends Http2Stream {
		constructor(session, id) {
			super(session, id);
			this._remoteHeaders = false;
			this._isPush = false;
		}
		_onHeaders(list, endStream) {
			const headers = headersToObject(list);
			const raw = [];
			for (const [name, value] of list) raw.push(name, value);
			const status = headers[":status"];
			if (!this._remoteHeaders) {
				const code = Number(status);
				if (code >= 100 && code < 200) {
					this.emit("headers", headers, 4, raw);
					if (endStream) this._remoteEnded();
					return;
				}
				this._remoteHeaders = true;
				this.emit(this._isPush ? "push" : "response", headers, endStream ? 5 : 4, raw);
			} else {
				this.emit("trailers", headers, endStream ? 5 : 4, raw);
			}
			if (endStream) this._remoteEnded();
		}
	}

	/* ---------------------------------------------------------------------------------------- server */

	function setupServerSession(server, socket, options) {
		const session = new Http2Session(SESSION_SERVER, socket, { ...options, settings: options.settings });
		session._server = server;
		server._sessions.add(session);
		session.once("close", () => server._sessions.delete(session));
		session.on("stream", (stream, headers, flags, rawHeaders) => {
			stream._requestMethod = headers[":method"];
			stream._requestAuthority = headers[":authority"];
			if (server.listenerCount("stream") > 0) server.emit("stream", stream, headers, flags, rawHeaders);
			if (server.listenerCount("request") > 0) {
				const request = new Http2ServerRequest(stream, headers, rawHeaders);
				const response = new Http2ServerResponse(stream, options);
				request._response = response;
				stream._compat = { request, response };
				if (headers.expect !== undefined && String(headers.expect).toLowerCase() === "100-continue") {
					if (server.listenerCount("checkContinue")) {
						server.emit("checkContinue", request, response);
						return;
					}
					response.writeContinue();
				}
				server.emit("request", request, response);
			}
		});
		session.on("error", (err) => {
			if (server.listenerCount("sessionError")) server.emit("sessionError", err, session);
		});
		if (options.timeout) session.setTimeout(options.timeout);
		session.on("timeout", () => server.emit("timeout", session));
		server.emit("session", session);
		return session;
	}

	const alpnList = (options, allowHTTP1) => {
		const given = options.ALPNProtocols;
		if (given) return given;
		return allowHTTP1 ? ["h2", "http/1.1"] : ["h2"];
	};

	function mixinServer(Base, secure) {
		return class Http2ServerBase extends Base {
			constructor(options, onRequestHandler) {
				if (typeof options === "function") {
					onRequestHandler = options;
					options = {};
				}
				options = { ...(options ?? {}) };
				if (options.settings !== undefined) validateSettings(options.settings);
				super(secure ? { ...options, ALPNProtocols: alpnList(options, options.allowHTTP1) } : options);
				this._h2options = options;
				this._sessions = new Set();
				this._allowHTTP1 = Boolean(options.allowHTTP1);
				this.timeout = options.timeout ?? 0;
				if (typeof onRequestHandler === "function") this.on("request", onRequestHandler);
				this.on(secure ? "secureConnection" : "connection", (socket) => this._accepted(socket));
			}
			_accepted(socket) {
				if (secure) {
					const alpn = socket.alpnProtocol;
					if (alpn === "h2") {
						setupServerSession(this, socket, this._h2options);
						return;
					}
					if (this._allowHTTP1 && (alpn === "http/1.1" || !alpn)) {
						this._http1().emit("connection", socket);
						return;
					}
					if (this.listenerCount("unknownProtocol")) {
						this.emit("unknownProtocol", socket);
						return;
					}
					socket.destroy();
					return;
				}
				// Cleartext HTTP/2 with prior knowledge: anything else is not ours.
				const session = setupServerSession(this, socket, this._h2options);
				void session;
			}
			_http1() {
				if (!this._http1Server) {
					const inner = http.Server ? new http.Server({}) : http.createServer();
					inner.on("request", (req, res) => this.emit("request", req, res));
					this._http1Server = inner;
				}
				return this._http1Server;
			}
			setTimeout(ms, callback) {
				this.timeout = ms;
				if (callback) this.on("timeout", callback);
				return this;
			}
			updateSettings(settings) {
				validateSettings(settings);
				this._h2options.settings = { ...this._h2options.settings, ...settings };
				for (const session of this._sessions) session.settings(settings);
			}
			close(callback) {
				for (const session of this._sessions) session.close();
				return super.close(callback);
			}
		};
	}

	const Http2Server = mixinServer(net.Server, false);
	const Http2SecureServer = mixinServer(tls.Server, true);

	/* -------------------------------------------------------------------------- compat request/response */

	class Http2ServerRequest extends Readable {
		constructor(stream, headers, rawHeaders) {
			super({ highWaterMark: 65536 });
			this[kRawHeaders] = rawHeaders;
			this.stream = stream;
			this.headers = headers;
			this.rawHeaders = rawHeaders;
			this.trailers = {};
			this.rawTrailers = [];
			this.aborted = false;
			this.complete = false;
			this.httpVersionMajor = 2;
			this.httpVersionMinor = 0;
			this.httpVersion = "2.0";
			this.scheme = headers[":scheme"];
			this.authority = headers[":authority"] ?? headers.host;
			this.method = headers[":method"];
			this.url = headers[":path"];
			this._response = null;
			stream.on("data", (chunk) => {
				if (!this.push(chunk)) stream.pause();
			});
			stream.on("end", () => {
				this.complete = true;
				this.push(null);
			});
			stream.on("trailers", (trailers, flags, raw) => {
				this.trailers = trailers;
				this.rawTrailers = raw;
			});
			stream.on("aborted", () => {
				this.aborted = true;
				this.emit("aborted");
			});
			stream.on("close", () => {
				this.emit("close");
			});
			stream.on("error", (err) => this.emit("error", err));
		}
		get socket() {
			return this.stream.session?.socket;
		}
		get connection() {
			return this.socket;
		}
		_read() {
			this.stream.resume();
		}
		setTimeout(ms, callback) {
			this.stream.setTimeout(ms, callback);
			return this;
		}
	}

	class Http2ServerResponse extends EventEmitter {
		constructor(stream, options) {
			super();
			this.stream = stream;
			this._headers = { __proto__: null };
			this._names = { __proto__: null };
			this._statusCode = 200;
			this.sendDate = true;
			this._finished = false;
			this._ended = false;
			this._options = options;
			this.req = undefined;
			this._trailers = null;
			stream.once("finish", () => {
				this._finished = true;
				this.emit("finish");
			});
			stream.once("close", () => {
				this.emit("close");
			});
			stream.on("error", (err) => this.emit("error", err));
			stream.on("drain", () => this.emit("drain"));
		}
		get socket() {
			return this.stream.session?.socket;
		}
		get connection() {
			return this.socket;
		}
		get finished() {
			return this._ended;
		}
		get writableEnded() {
			return this._ended;
		}
		get writableFinished() {
			return this._finished;
		}
		get headersSent() {
			return this.stream.headersSent;
		}
		get writable() {
			return !this._ended && !this.stream.destroyed;
		}
		get statusCode() {
			return this._statusCode;
		}
		set statusCode(code) {
			code = Number(code);
			if (!Number.isInteger(code) || code < 100 || code > 999) throw h2Error("ERR_HTTP2_STATUS_INVALID", code);
			this._statusCode = code;
		}
		get statusMessage() {
			return "";
		}
		set statusMessage(_) {}
		setHeader(name, value) {
			this._assertNotSent();
			const lower = String(name).toLowerCase();
			// Connection-specific headers mean nothing in HTTP/2: the compatibility API drops them (Node warns).
			if (CONNECTION_HEADERS.has(lower)) return this;
			if (value === undefined) throw Object.assign(new TypeError(`Invalid value "undefined" for header "${name}"`), { code: "ERR_HTTP2_INVALID_HEADER_VALUE" });
			this._headers[lower] = value;
			this._names[lower] = String(name);
			return this;
		}
		appendHeader(name, value) {
			this._assertNotSent();
			const lower = String(name).toLowerCase();
			const existing = this._headers[lower];
			if (existing === undefined) return this.setHeader(name, value);
			this._headers[lower] = [].concat(existing, value);
			return this;
		}
		setHeaders(headers) {
			for (const [name, value] of headers instanceof Map || typeof headers.entries === "function" ? headers.entries() : Object.entries(headers)) this.setHeader(name, value);
			return this;
		}
		getHeader(name) {
			return this._headers[String(name).toLowerCase()];
		}
		getHeaders() {
			return { ...this._headers };
		}
		getHeaderNames() {
			return Object.keys(this._headers);
		}
		hasHeader(name) {
			return String(name).toLowerCase() in this._headers;
		}
		removeHeader(name) {
			this._assertNotSent();
			delete this._headers[String(name).toLowerCase()];
			return this;
		}
		_assertNotSent() {
			if (this.stream.headersSent) throw h2Error("ERR_HTTP2_HEADERS_SENT");
		}
		writeHead(statusCode, statusMessage, headers) {
			if (typeof statusMessage !== "string") {
				headers = statusMessage;
				statusMessage = undefined;
			}
			if (this._ended || this.stream.headersSent) throw h2Error("ERR_HTTP2_HEADERS_SENT");
			this.statusCode = statusCode;
			if (Array.isArray(headers)) {
				for (let i = 0; i + 1 < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
			} else if (headers) {
				for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
			}
			this._sendHeaders(false);
			return this;
		}
		_sendHeaders(endStream) {
			if (this.stream.headersSent) return;
			const headers = { ...this._headers };
			if (this.sendDate && headers.date === undefined) headers.date = new Date().toUTCString();
			headers[":status"] = this._statusCode;
			if (this.stream.destroyed || this.stream.closed) return;
			this.stream.respond(headers, { endStream, waitForTrailers: this._trailers !== null });
		}
		flushHeaders() {
			this._sendHeaders(false);
		}
		writeContinue() {
			if (this.stream.headersSent) return;
			this.stream.additionalHeaders({ ":status": 100 });
		}
		writeEarlyHints(hints) {
			const headers = { ":status": 103 };
			for (const [name, value] of Object.entries(hints ?? {})) if (name.toLowerCase() === "link" || name.toLowerCase().startsWith("link")) headers[name] = value;
			this.stream.additionalHeaders(headers);
		}
		write(chunk, encoding, callback) {
			if (typeof encoding === "function") {
				callback = encoding;
				encoding = undefined;
			}
			if (this._ended) {
				const err = Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
				if (callback) queueMicrotask(() => callback(err));
				else queueMicrotask(() => this.emit("error", err));
				return false;
			}
			if (!this.stream.headersSent) this._sendHeaders(false);
			return this.stream.write(chunk, encoding, callback);
		}
		end(chunk, encoding, callback) {
			if (typeof chunk === "function") {
				callback = chunk;
				chunk = undefined;
				encoding = undefined;
			} else if (typeof encoding === "function") {
				callback = encoding;
				encoding = undefined;
			}
			if (this._ended) {
				if (callback) queueMicrotask(callback);
				return this;
			}
			this._ended = true;
			if (callback) this.once("finish", callback);
			const status = this._statusCode;
			const bodyless = status === 204 || status === 205 || status === 304 || this.stream._requestMethod === "HEAD";
			if (!this.stream.headersSent) {
				if (chunk === undefined || chunk === null || bodyless) {
					this._sendHeaders(true);
					if (!this.stream.destroyed) this.stream.end();
					return this;
				}
				this._sendHeaders(false);
			}
			if (this.stream.destroyed) return this;
			if (chunk !== undefined && chunk !== null && !bodyless) this.stream.end(chunk, encoding);
			else this.stream.end();
			return this;
		}
		addTrailers(headers) {
			this._trailers = { ...this._trailers, ...headers };
			this.stream.once("wantTrailers", () => this.stream.sendTrailers(this._trailers));
		}
		createPushResponse(headers, callback) {
			this.stream.pushStream(headers, {}, (err, pushStream) => {
				if (err) {
					callback(err);
					return;
				}
				callback(null, new Http2ServerResponse(pushStream, this._options));
			});
		}
		setTimeout(ms, callback) {
			this.stream.setTimeout(ms, callback);
			return this;
		}
		destroy(err) {
			this.stream.destroy(err);
		}
		get writableLength() {
			return this.stream.writableLength;
		}
		cork() {
			this.stream.cork?.();
		}
		uncork() {
			this.stream.uncork?.();
		}
	}

	/* ---------------------------------------------------------------------------------------- client */

	function parseAuthority(authority) {
		if (typeof authority === "string") return new urlModule.URL(authority);
		if (authority instanceof urlModule.URL) return authority;
		if (authority && typeof authority === "object") {
			const protocol = authority.protocol ?? "http:";
			const host = authority.hostname ?? authority.host ?? "localhost";
			return new urlModule.URL(`${protocol}//${host.includes(":") ? `[${host}]` : host}${authority.port ? `:${authority.port}` : ""}`);
		}
		throw invalidArg("authority", "of type string or an instance of URL", authority);
	}

	function connect(authority, options, listener) {
		if (typeof options === "function") {
			listener = options;
			options = undefined;
		}
		options = { ...(options ?? {}) };
		if (options.settings !== undefined) validateSettings(options.settings);
		const url = parseAuthority(authority);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw h2Error("ERR_HTTP2_UNSUPPORTED_PROTOCOL", url.protocol);
		const secure = url.protocol === "https:";
		const host = url.hostname.replace(/^\[|\]$/g, "") || "localhost";
		const port = Number(url.port || (secure ? 443 : 80));
		let socket;
		if (typeof options.createConnection === "function") {
			socket = options.createConnection(url, options);
		} else if (secure) {
			socket = tls.connect({ ...options, host, port, servername: options.servername ?? (net.isIP(host) ? undefined : host), ALPNProtocols: options.ALPNProtocols ?? ["h2"] });
		} else {
			socket = net.connect({ ...options, host, port });
		}
		const session = new Http2Session(SESSION_CLIENT, socket, options);
		session._authority = url;
		session._secure = secure;
		session.connecting = true;
		session._socketReady = false;
		const ready = () => {
			session.encrypted = Boolean(socket.encrypted);
			session.alpnProtocol = secure ? socket.alpnProtocol || undefined : "h2c";
			if (secure && session.alpnProtocol !== "h2") {
				session._finishDestroy(Object.assign(new Error("Unsupported ALPN protocol: the server did not choose h2"), { code: "ERR_HTTP2_ERROR" }));
				return;
			}
			session._socketConnected();
		};
		if (secure) socket.once("secureConnect", ready);
		else if (socket.connecting) socket.once("connect", ready);
		else queueMicrotask(ready);
		if (listener) session.once("connect", listener);
		return session;
	}

	Http2Session.prototype.request = function request(headers = {}, options = {}) {
		if (this._type !== SESSION_CLIENT) throw h2Error("ERR_HTTP2_INVALID_SESSION");
		if (this._destroyed || this._goawayReceived || this._closing) {
			// Node hands back a stream that fails on the next tick rather than throwing.
			const dead = new ClientHttp2Stream(this, undefined);
			dead._closedByProtocol = true;
			queueMicrotask(() => dead.destroy(h2Error("ERR_HTTP2_INVALID_SESSION")));
			return dead;
		}
		const list = headersToList(headers, { allowPseudo: true });
		const has = (name) => list.find((h) => h[0] === name);
		if (!has(":method")) list.unshift([":method", "GET", false]);
		const method = has(":method")[1];
		if (method === "CONNECT") {
			if (!has(":authority")) throw h2Error("ERR_HTTP2_CONNECT_AUTHORITY");
			if (has(":scheme")) throw h2Error("ERR_HTTP2_CONNECT_SCHEME");
			if (has(":path")) throw h2Error("ERR_HTTP2_CONNECT_PATH");
		} else {
			if (!has(":path")) list.push([":path", "/", false]);
			if (!has(":scheme")) list.push([":scheme", this._secure ? "https" : "http", false]);
			if (!has(":authority") && !has("host")) list.push([":authority", this._authority.host, false]);
		}
		for (const [name] of list) {
			if (name[0] === ":" && ![":method", ":path", ":scheme", ":authority", ":protocol"].includes(name)) throw h2Error("ERR_HTTP2_INVALID_PSEUDOHEADER", name);
		}
		const pseudo = list.filter((h) => h[0][0] === ":");
		const rest = list.filter((h) => h[0][0] !== ":");
		const ordered = [...pseudo.sort((a, b) => order(a[0]) - order(b[0])), ...rest];
		const noPayload = method === "GET" || method === "HEAD" || method === "DELETE";
		const endStream = options.endStream !== undefined ? Boolean(options.endStream) : noPayload;
		const id = this._nextStreamId;
		if (id > 2147483647) throw h2Error("ERR_HTTP2_OUT_OF_STREAMS");
		this._nextStreamId += 2;
		const stream = new ClientHttp2Stream(this, id);
		stream._requestMethod = method;
		stream.sentHeaders = headersToObject(ordered);
		stream._headersSent = true;
		stream._waitForTrailers = Boolean(options.waitForTrailers);
		this._streams.set(id, stream);
		this._sendHeaderBlock(id, ordered, endStream && !stream._waitForTrailers ? FLAG.END_STREAM : 0);
		if (endStream) {
			if (stream._waitForTrailers) {
				stream.end();
			} else {
				stream._localClosed = true;
				stream.end();
				this._sendQueue = this._sendQueue.filter((s) => s !== stream);
			}
		}
		if (options.signal) {
			const abort = () => stream.destroy(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
			if (options.signal.aborted) queueMicrotask(abort);
			else options.signal.addEventListener("abort", abort, { once: true });
		}
		return stream;
	};
	const order = (name) => ({ ":method": 0, ":scheme": 1, ":authority": 2, ":path": 3, ":protocol": 4 })[name] ?? 5;

	/* ------------------------------------------------------------------------------- module surface */

	const http2 = {
		Http2Session,
		ServerHttp2Session: Http2Session,
		ClientHttp2Session: Http2Session,
		Http2Stream,
		ServerHttp2Stream,
		ClientHttp2Stream,
		Http2ServerRequest,
		Http2ServerResponse,
		Http2Server,
		Http2SecureServer,
		constants: C,
		sensitiveHeaders,
		connect,
		createServer(options, onRequestHandler) {
			return new Http2Server(options, onRequestHandler);
		},
		createSecureServer(options, onRequestHandler) {
			if (typeof options === "function") {
				onRequestHandler = options;
				options = {};
			}
			const merged = { ...(options?.secureContext?._options ?? {}), ...options };
			if (!merged.key || !merged.cert) throw new TypeError("http2.createSecureServer needs { key, cert } as PEM strings or Buffers");
			return new Http2SecureServer(options, onRequestHandler);
		},
		getDefaultSettings: () => ({ headerTableSize: 4096, enablePush: true, initialWindowSize: 65535, maxFrameSize: 16384, maxConcurrentStreams: 4294967295, maxHeaderSize: 65535, maxHeaderListSize: 65535, enableConnectProtocol: false }),
		getPackedSettings(settings = {}) {
			validateSettings(settings);
			return packSettings(settings);
		},
		getUnpackedSettings(buffer) {
			if (!ArrayBuffer.isView(buffer)) throw invalidArg("buf", "an instance of Buffer, TypedArray, or DataView", buffer);
			const bytes = asBuffer(buffer);
			if (bytes.length % 6 !== 0) throw Object.assign(new RangeError("Packed settings length must be a multiple of six"), { code: "ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH" });
			const names = { 1: "headerTableSize", 2: "enablePush", 3: "maxConcurrentStreams", 4: "initialWindowSize", 5: "maxFrameSize", 6: "maxHeaderListSize", 8: "enableConnectProtocol" };
			const out = {};
			for (let i = 0; i < bytes.length; i += 6) {
				const key = names[bytes.readUInt16BE(i)];
				const value = bytes.readUInt32BE(i + 2);
				if (!key) continue;
				out[key] = key === "enablePush" || key === "enableConnectProtocol" ? value === 1 : value;
				if (key === "maxHeaderListSize") out.maxHeaderSize = value;
			}
			return out;
		},
		performServerHandshake(socket, options) {
			return new Http2Session(SESSION_SERVER, socket, options ?? {});
		},
	};
	Object.defineProperty(http2, "__hpack", { value: { HpackEncoder, HpackDecoder, huffmanEncode, huffmanDecode }, enumerable: false });
	void NO_CLIENT;
	void Writable;
	return http2;
}

export { createHttp2 };

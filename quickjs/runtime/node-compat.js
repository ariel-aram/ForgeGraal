/*
 * A Node.js compatibility layer for quickjs-ng.
 *
 * quickjs-ng is an engine, not a runtime: it implements the language completely (it passes every
 * syntax and builtin check in tools/engine-conformance.js, including everything that fails to
 * parse on the Windows 7 Node.js pin) but provides none of Node's library surface. This file is
 * the part of that surface that can be written in JavaScript, built on the primitives the engine's
 * own `qjs:os` and `qjs:std` modules already expose — files, directories, timers, environment,
 * process control and I/O readiness callbacks.
 *
 * What is deliberately NOT here: `net`, `tls`, `http`, `crypto` and `zlib`. Those need real native
 * work — `qjs:os` has no socket API at all — and a bot cannot reach Discord without them. They are
 * registered as modules that throw an explanation when required, rather than being stubbed into
 * something that looks present and then fails somewhere confusing. That follows the same rule as
 * the native addon shim: a stub that lies is worse than a clear stop.
 *
 * Load it before anything else:
 *
 *     qjs --std quickjs/runtime/node-compat.js your-entry.js
 */

import * as os from "qjs:os";
import * as std from "qjs:std";
import * as web from "./node-web.js";
import * as misc from "./node-misc.js";
import { Segmenter } from "./segmenter.js";

const globalObject = globalThis;

/*
 * Timers. The stock `qjs` binary puts these on the global object; the ForgeGraal host embeds only the
 * engine's `os` module, where they live as os.setTimeout and friends. Node hands back an object rather
 * than a number, and libraries call .unref() on it, so the same shape is returned here. The engine has
 * no unref'd timers, so ref/unref are accepted and keep the loop alive either way.
 */
if (typeof globalObject.setTimeout === "undefined" && typeof os.setTimeout === "function") {
	class Timeout {
		constructor(handle) {
			this._handle = handle;
		}
		ref() {
			return this;
		}
		unref() {
			return this;
		}
		hasRef() {
			return true;
		}
		refresh() {
			return this;
		}
		close() {
			os.clearTimeout(this._handle);
			return this;
		}
		[Symbol.toPrimitive]() {
			return 0;
		}
	}
	const start = (create) => (fn, ms, ...args) => {
		if (typeof fn !== "function") {
			throw new TypeError('The "callback" argument must be of type function.');
		}
		const run = args.length ? () => fn(...args) : fn;
		return new Timeout(create(run, Math.max(1, Number(ms) || 1)));
	};
	const clear = (timer) => {
		if (timer instanceof Timeout) os.clearTimeout(timer._handle);
		else if (timer != null) os.clearTimeout(timer);
	};
	globalObject.setTimeout = start((fn, ms) => os.setTimeout(fn, ms));
	globalObject.setInterval = start((fn, ms) => os.setInterval(fn, ms));
	globalObject.clearTimeout = clear;
	globalObject.clearInterval = clear;
}

/*
 * V8's stack-trace API. `Error.captureStackTrace` exists in the engine, but `Error.prepareStackTrace`
 * and CallSite objects do not, and a good deal of published code depends on them: `bindings` finds the
 * calling module's directory this way, and `depd` and `source-map-support` read file and line out of it.
 * The engine's own stack text is parsed into CallSites when a custom prepareStackTrace is installed.
 */
{
	const captureNative = Error.captureStackTrace;
	const FRAME = /^\s*at (?:(.*?) \()?(.*?)(?::(\d+):(\d+))?\)?$/;
	class CallSite {
		constructor(frame) {
			this._frame = frame;
		}
		getThis() {
			return undefined;
		}
		getTypeName() {
			return null;
		}
		getFunction() {
			return undefined;
		}
		getFunctionName() {
			return this._frame.fn || null;
		}
		getMethodName() {
			return null;
		}
		getFileName() {
			return this._frame.file === "native" ? undefined : this._frame.file;
		}
		getLineNumber() {
			return this._frame.line;
		}
		getColumnNumber() {
			return this._frame.column;
		}
		getEvalOrigin() {
			return undefined;
		}
		getScriptNameOrSourceURL() {
			return this.getFileName();
		}
		isToplevel() {
			return !this._frame.fn;
		}
		isEval() {
			return false;
		}
		isNative() {
			return this._frame.file === "native";
		}
		isConstructor() {
			return false;
		}
		isAsync() {
			return false;
		}
		isPromiseAll() {
			return false;
		}
		getPromiseIndex() {
			return null;
		}
		toString() {
			const where = this._frame.file + (this._frame.line ? `:${this._frame.line}:${this._frame.column}` : "");
			return this._frame.fn ? `${this._frame.fn} (${where})` : where;
		}
	}
	Object.defineProperty(Error, "prepareStackTrace", { value: undefined, writable: true, configurable: true, enumerable: false });
	if (typeof captureNative === "function") {
		Error.captureStackTrace = function captureStackTrace(target, constructorOpt) {
			// Frames above and including constructorOpt are left out; this wrapper is one more of them.
			captureNative.call(this, target, constructorOpt ?? Error.captureStackTrace);
			if (typeof Error.prepareStackTrace !== "function") return;
			const lines = String(target.stack).split("\n");
			const frames = lines
				.filter((line) => /^\s*at /.test(line))
				.map((line) => {
					const m = FRAME.exec(line);
					return {
						fn: m?.[1] ?? "",
						file: m?.[2] ?? "",
						line: m?.[3] ? Number(m[3]) : null,
						column: m?.[4] ? Number(m[4]) : null,
					};
				});
			const sites = frames.map((frame) => new CallSite(frame));
			// Evaluated on first read, as V8 does, so a caller can install its hook, capture, read, restore.
			Object.defineProperty(target, "stack", {
				configurable: true,
				enumerable: false,
				get() {
					const value = Error.prepareStackTrace(target, sites);
					Object.defineProperty(target, "stack", { value, writable: true, configurable: true, enumerable: false });
					return value;
				},
				set(value) {
					Object.defineProperty(target, "stack", { value, writable: true, configurable: true, enumerable: false });
				},
			});
		};
	}
}

/* ------------------------------------------------------------------ helpers */

function notImplemented(moduleName, reason) {
	return new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "__forgegraalUnavailable") return true;
				throw new Error(
					`'${moduleName}' is not available on the quickjs-ng runtime yet. ${reason} ` +
						"ForgeGraal does not stub it, because a module that appears to load and then misbehaves is " +
						"harder to diagnose than one that says what is missing."
				);
			},
		}
	);
}

/* --------------------------------------------------- TextEncoder / Decoder */

/*
 * The engine ships neither, and Buffer's utf8 path needs both. Written out rather than
 * approximated with escape/unescape tricks, which mangle anything outside the BMP: a lone
 * surrogate has to become U+FFFD, and a valid pair has to encode as one 4-byte sequence.
 */
class TextEncoderImpl {
	get encoding() {
		return "utf-8";
	}
	encode(input = "") {
		const str = String(input);
		const out = [];
		for (let i = 0; i < str.length; i++) {
			let code = str.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
				if (next >= 0xdc00 && next <= 0xdfff) {
					code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
					i++;
				} else {
					code = 0xfffd;
				}
			} else if (code >= 0xdc00 && code <= 0xdfff) {
				code = 0xfffd;
			}

			if (code < 0x80) {
				out.push(code);
			} else if (code < 0x800) {
				out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
			} else if (code < 0x10000) {
				out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
			} else {
				out.push(
					0xf0 | (code >> 18),
					0x80 | ((code >> 12) & 0x3f),
					0x80 | ((code >> 6) & 0x3f),
					0x80 | (code & 0x3f)
				);
			}
		}
		return new Uint8Array(out);
	}
	encodeInto(source, destination) {
		const encoded = this.encode(source);
		const written = Math.min(encoded.length, destination.length);
		destination.set(encoded.subarray(0, written));
		return { read: source.length, written };
	}
}

class TextDecoderImpl {
	constructor(encoding = "utf-8") {
		this.encoding = String(encoding).toLowerCase();
		this._pending = [];
	}
	decode(input, options = {}) {
		if (input === undefined) return "";
		const bytes = ArrayBuffer.isView(input)
			? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
			: new Uint8Array(input);

		if (this.encoding === "latin1" || this.encoding === "binary" || this.encoding === "iso-8859-1") {
			let out = "";
			for (const byte of bytes) out += String.fromCharCode(byte);
			return out;
		}

		// Bytes left over from a previous streaming call complete their sequence here.
		const all = this._pending.length ? [...this._pending, ...bytes] : bytes;
		this._pending = [];

		let out = "";
		let i = 0;
		while (i < all.length) {
			const byte = all[i];
			let needed;
			let code;
			if (byte < 0x80) {
				out += String.fromCharCode(byte);
				i++;
				continue;
			}
			if ((byte & 0xe0) === 0xc0) {
				needed = 1;
				code = byte & 0x1f;
			} else if ((byte & 0xf0) === 0xe0) {
				needed = 2;
				code = byte & 0x0f;
			} else if ((byte & 0xf8) === 0xf0) {
				needed = 3;
				code = byte & 0x07;
			} else {
				out += "�";
				i++;
				continue;
			}

			if (i + needed >= all.length + (options.stream ? 0 : 1) && i + needed > all.length - 1) {
				if (options.stream) {
					// Hold an incomplete tail until the next chunk instead of emitting U+FFFD.
					this._pending = Array.from(all.slice(i));
					return out;
				}
				out += "�";
				break;
			}

			let valid = true;
			for (let k = 1; k <= needed; k++) {
				const cont = all[i + k];
				if ((cont & 0xc0) !== 0x80) {
					valid = false;
					break;
				}
				code = (code << 6) | (cont & 0x3f);
			}
			if (!valid) {
				out += "�";
				i++;
				continue;
			}

			// UTF-8 forbids surrogate code points, overlong encodings and anything above
			// U+10FFFF. Emitting them anyway is how mojibake and lone surrogates get into
			// strings that later fail to round-trip.
			const minimum = needed === 1 ? 0x80 : needed === 2 ? 0x800 : 0x10000;
			if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
				out += "�";
				i += needed + 1;
				continue;
			}

			if (code > 0xffff) {
				code -= 0x10000;
				out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
			} else {
				out += String.fromCharCode(code);
			}
			i += needed + 1;
		}
		return out;
	}
}

const TextEncoder = globalObject.TextEncoder ?? TextEncoderImpl;
const TextDecoder = globalObject.TextDecoder ?? TextDecoderImpl;
globalObject.TextEncoder = TextEncoder;
globalObject.TextDecoder = TextDecoder;

/* ------------------------------------------------------------------- buffer */

/*
 * Buffer over Uint8Array. Node's Buffer is a Uint8Array subclass, so inheriting gives the
 * indexing, iteration and byte semantics for free; what is added here is the encoding surface
 * that libraries actually call.
 */
class Buffer extends Uint8Array {
	static alloc(size, fill = 0) {
		const buf = new Buffer(size);
		if (fill !== 0) buf.fill(fill);
		return buf;
	}

	static allocUnsafe(size) {
		return new Buffer(size);
	}

	static from(value, encodingOrOffset, length) {
		if (typeof value === "string") return Buffer._fromString(value, encodingOrOffset || "utf8");
		if (value instanceof ArrayBuffer) {
			// Shares memory with the ArrayBuffer rather than copying it, as Node does. Native addons
			// rely on it: they write into the buffer they created after handing it back to JavaScript.
			return new Buffer(value, encodingOrOffset || 0, length);
		}
		if (ArrayBuffer.isView(value)) {
			const out = new Buffer(value.byteLength);
			out.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
			return out;
		}
		if (Array.isArray(value) || typeof value?.length === "number") {
			const out = new Buffer(value.length);
			for (let i = 0; i < value.length; i++) out[i] = value[i] & 0xff;
			return out;
		}
		throw new TypeError("Buffer.from expects a string, ArrayBuffer, view or array-like");
	}

	static _fromString(str, encoding) {
		const enc = String(encoding).toLowerCase();
		if (enc === "utf8" || enc === "utf-8") {
			const bytes = new TextEncoder().encode(str);
			const out = new Buffer(bytes.length);
			out.set(bytes);
			return out;
		}
		if (enc === "hex") {
			const clean = str.length % 2 ? str.slice(0, -1) : str;
			const out = new Buffer(clean.length / 2);
			for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
			return out;
		}
		if (enc === "base64") return Buffer._fromBase64(str);
		if (enc === "latin1" || enc === "binary" || enc === "ascii") {
			const out = new Buffer(str.length);
			for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
			return out;
		}
		throw new TypeError(`Unsupported encoding '${encoding}'`);
	}

	static _fromBase64(str) {
		const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		const clean = str.replace(/[^A-Za-z0-9+/]/g, "");
		const out = new Buffer(Math.floor((clean.length * 3) / 4));
		let bits = 0;
		let acc = 0;
		let pos = 0;
		for (const ch of clean) {
			acc = (acc << 6) | table.indexOf(ch);
			bits += 6;
			if (bits >= 8) {
				bits -= 8;
				out[pos++] = (acc >> bits) & 0xff;
			}
		}
		return out.subarray(0, pos);
	}

	static concat(list, totalLength) {
		let total = totalLength;
		if (total === undefined) {
			total = 0;
			for (const item of list) total += item.length;
		}
		const out = new Buffer(total);
		let offset = 0;
		for (const item of list) {
			if (offset >= total) break;
			out.set(item.subarray(0, Math.min(item.length, total - offset)), offset);
			offset += item.length;
		}
		return out;
	}

	static isBuffer(value) {
		return value instanceof Buffer;
	}

	static byteLength(value, encoding = "utf8") {
		return typeof value === "string" ? Buffer._fromString(value, encoding).length : value.byteLength;
	}

	toString(encoding = "utf8", start = 0, end = this.length) {
		const slice = this.subarray(start, end);
		const enc = String(encoding).toLowerCase();
		if (enc === "utf8" || enc === "utf-8") return new TextDecoder().decode(slice);
		if (enc === "hex") {
			let out = "";
			for (const byte of slice) out += byte.toString(16).padStart(2, "0");
			return out;
		}
		if (enc === "base64") {
			const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
			let out = "";
			for (let i = 0; i < slice.length; i += 3) {
				const triple = (slice[i] << 16) | ((slice[i + 1] ?? 0) << 8) | (slice[i + 2] ?? 0);
				out += table[(triple >> 18) & 63] + table[(triple >> 12) & 63];
				out += i + 1 < slice.length ? table[(triple >> 6) & 63] : "=";
				out += i + 2 < slice.length ? table[triple & 63] : "=";
			}
			return out;
		}
		if (enc === "latin1" || enc === "binary" || enc === "ascii") {
			let out = "";
			for (const byte of slice) out += String.fromCharCode(byte);
			return out;
		}
		throw new TypeError(`Unsupported encoding '${encoding}'`);
	}

	equals(other) {
		if (this.length !== other.length) return false;
		for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
		return true;
	}

	slice(start, end) {
		return Buffer.from(this.subarray(start, end));
	}
}

/* ------------------------------------------------------------------- events */

function initEventEmitter() {
	this._events = Object.create(null);
	this._maxListeners = 10;
}

class EventEmitter {
	constructor() {
		initEventEmitter.call(this);
	}

	on(name, fn) {
		(this._events[name] ||= []).push(fn);
		return this;
	}

	addListener(name, fn) {
		return this.on(name, fn);
	}

	once(name, fn) {
		const wrapper = (...args) => {
			this.off(name, wrapper);
			fn.apply(this, args);
		};
		wrapper.listener = fn;
		return this.on(name, wrapper);
	}

	prependListener(name, fn) {
		(this._events[name] ||= []).unshift(fn);
		return this;
	}

	off(name, fn) {
		const list = this._events[name];
		if (!list) return this;
		const index = list.findIndex((entry) => entry === fn || entry.listener === fn);
		if (index !== -1) list.splice(index, 1);
		return this;
	}

	removeListener(name, fn) {
		return this.off(name, fn);
	}

	removeAllListeners(name) {
		if (name === undefined) this._events = Object.create(null);
		else delete this._events[name];
		return this;
	}

	emit(name, ...args) {
		const list = this._events[name];
		if (!list || !list.length) {
			// Node throws on an unhandled 'error' event rather than swallowing it, and code
			// depends on that being how a failure surfaces.
			if (name === "error") throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error. (${args[0]})`);
			return false;
		}
		for (const fn of [...list]) fn.apply(this, args);
		return true;
	}

	listenerCount(name) {
		return this._events[name]?.length ?? 0;
	}

	listeners(name) {
		return [...(this._events[name] ?? [])];
	}

	eventNames() {
		return Reflect.ownKeys(this._events);
	}

	setMaxListeners(n) {
		this._maxListeners = n;
		return this;
	}

	getMaxListeners() {
		return this._maxListeners;
	}
}
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.defaultMaxListeners = 10;

/* --------------------------------------------------------------------- path */

const isWindows = os.platform === "win32";

function makePath(sep) {
	const isAbsolute = (p) => (sep === "\\" ? /^([a-zA-Z]:)?[\\/]/.test(p) : p.startsWith("/"));

	function normalizeParts(parts, allowAboveRoot) {
		const out = [];
		for (const part of parts) {
			if (!part || part === ".") continue;
			if (part === "..") {
				if (out.length && out[out.length - 1] !== "..") out.pop();
				else if (allowAboveRoot) out.push("..");
			} else {
				out.push(part);
			}
		}
		return out;
	}

	const path = {
		sep,
		delimiter: sep === "\\" ? ";" : ":",
		isAbsolute,
		normalize(p) {
			const absolute = isAbsolute(p);
			const trailing = /[\\/]$/.test(p);
			let result = normalizeParts(p.split(/[\\/]+/), !absolute).join(sep);
			if (!result && !absolute) result = ".";
			if (result && trailing) result += sep;
			return absolute ? sep + result : result;
		},
		join(...parts) {
			const joined = parts.filter((p) => p !== "" && p !== undefined).join(sep);
			return joined ? path.normalize(joined) : ".";
		},
		resolve(...parts) {
			let resolved = "";
			for (let i = parts.length - 1; i >= 0; i--) {
				const part = parts[i];
				if (!part) continue;
				resolved = resolved ? `${part}${sep}${resolved}` : part;
				if (isAbsolute(part)) break;
			}
			if (!isAbsolute(resolved)) resolved = `${os.getcwd()[0]}${sep}${resolved}`;
			return path.normalize(resolved).replace(/[\\/]$/, "") || sep;
		},
		dirname(p) {
			const parts = p.split(/[\\/]/);
			parts.pop();
			const head = parts.join(sep);
			if (!head) return isAbsolute(p) ? sep : ".";
			return head;
		},
		basename(p, ext) {
			const base = p.split(/[\\/]/).pop() ?? "";
			return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
		},
		extname(p) {
			const base = path.basename(p);
			const dot = base.lastIndexOf(".");
			return dot > 0 ? base.slice(dot) : "";
		},
		relative(from, to) {
			const fromParts = path.resolve(from).split(/[\\/]/);
			const toParts = path.resolve(to).split(/[\\/]/);
			while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
				fromParts.shift();
				toParts.shift();
			}
			return [...fromParts.map(() => ".."), ...toParts].join(sep);
		},
		parse(p) {
			const dir = path.dirname(p);
			const base = path.basename(p);
			const ext = path.extname(p);
			return { root: isAbsolute(p) ? sep : "", dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
		},
		format(obj) {
			return path.join(obj.dir || obj.root || "", obj.base || `${obj.name || ""}${obj.ext || ""}`);
		},
	};
	return path;
}

const posixPath = makePath("/");
const win32Path = makePath("\\");
const pathModule = isWindows ? win32Path : posixPath;
pathModule.posix = posixPath;
pathModule.win32 = win32Path;

/* ----------------------------------------------------------------------- fs */

function throwErrno(errno, syscall, target) {
	const err = new Error(`${syscall} failed for '${target}': ${std.strerror(errno)}`);
	err.errno = -errno;
	err.syscall = syscall;
	err.path = target;
	err.code = errno === 2 ? "ENOENT" : errno === 13 ? "EACCES" : errno === 17 ? "EEXIST" : `E${errno}`;
	return err;
}

const fs = {
	readFileSync(file, options) {
		const encoding = typeof options === "string" ? options : options?.encoding;
		if (encoding) {
			const text = std.loadFile(file);
			if (text === null) throw throwErrno(2, "open", file);
			return text;
		}
		const handle = std.open(file, "rb");
		if (!handle) throw throwErrno(2, "open", file);
		handle.seek(0, std.SEEK_END);
		const size = handle.tell();
		handle.seek(0, std.SEEK_SET);
		const buf = Buffer.alloc(size);
		if (size > 0) handle.read(buf.buffer, 0, size);
		handle.close();
		return buf;
	},
	writeFileSync(file, data) {
		const handle = std.open(file, "wb");
		if (!handle) throw throwErrno(13, "open", file);
		const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
		if (bytes.length) handle.write(bytes.buffer, bytes.byteOffset, bytes.length);
		handle.close();
	},
	appendFileSync(file, data) {
		const handle = std.open(file, "ab");
		if (!handle) throw throwErrno(13, "open", file);
		const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
		if (bytes.length) handle.write(bytes.buffer, bytes.byteOffset, bytes.length);
		handle.close();
	},
	existsSync(file) {
		return os.stat(file)[1] === 0;
	},
	statSync(file) {
		const [info, errno] = os.stat(file);
		if (errno !== 0) throw throwErrno(errno, "stat", file);
		return fs._toStats(info);
	},
	lstatSync(file) {
		const [info, errno] = os.lstat(file);
		if (errno !== 0) throw throwErrno(errno, "lstat", file);
		return fs._toStats(info);
	},
	_toStats(info) {
		const isDir = (info.mode & os.S_IFMT) === os.S_IFDIR;
		return {
			...info,
			size: info.size,
			mode: info.mode,
			mtimeMs: info.mtime,
			isDirectory: () => isDir,
			isFile: () => (info.mode & os.S_IFMT) === os.S_IFREG,
			isSymbolicLink: () => (info.mode & os.S_IFMT) === os.S_IFLNK,
		};
	},
	readdirSync(dir, options) {
		const [names, errno] = os.readdir(dir);
		if (errno !== 0) throw throwErrno(errno, "scandir", dir);
		const filtered = names.filter((n) => n !== "." && n !== "..");
		if (!options?.withFileTypes) return filtered;
		return filtered.map((name) => {
			const stats = fs.statSync(pathModule.join(dir, name));
			return { name, isDirectory: stats.isDirectory, isFile: stats.isFile, isSymbolicLink: stats.isSymbolicLink };
		});
	},
	mkdirSync(dir, options) {
		if (options?.recursive) {
			const parts = pathModule.resolve(dir).split(/[\\/]/);
			let current = pathModule.isAbsolute(dir) ? pathModule.sep : "";
			for (const part of parts) {
				if (!part) continue;
				current = current === pathModule.sep ? pathModule.sep + part : current ? current + pathModule.sep + part : part;
				if (!fs.existsSync(current)) os.mkdir(current);
			}
			return;
		}
		const errno = os.mkdir(dir);
		if (errno !== 0) throw throwErrno(-errno, "mkdir", dir);
	},
	unlinkSync(file) {
		const errno = os.remove(file);
		if (errno !== 0) throw throwErrno(-errno, "unlink", file);
	},
	rmSync(target) {
		os.remove(target);
	},
	renameSync(from, to) {
		const errno = os.rename(from, to);
		if (errno !== 0) throw throwErrno(-errno, "rename", from);
	},
	realpathSync(p) {
		const [resolved, errno] = os.realpath(p);
		if (errno !== 0) throw throwErrno(errno, "realpath", p);
		return resolved;
	},
	chmodSync() {
		/* quickjs-ng exposes no chmod; permissions are left as the OS created them. */
	},
};
fs.promises = {
	readFile: async (...a) => fs.readFileSync(...a),
	writeFile: async (...a) => fs.writeFileSync(...a),
	mkdir: async (...a) => fs.mkdirSync(...a),
	readdir: async (...a) => fs.readdirSync(...a),
	stat: async (...a) => fs.statSync(...a),
	unlink: async (...a) => fs.unlinkSync(...a),
};

/* ------------------------------------------------------------------ process */

const processModule = new EventEmitter();
Object.assign(processModule, {
	argv: ["qjs", ...(globalObject.scriptArgs ?? []).slice(1)],
	env: std.getenviron(),
	platform: os.platform === "win32" ? "win32" : os.platform,
	arch: globalThis.__forgegraal_native?.arch ?? "ia32",
	version: "v18.0.0-forgegraal-quickjs",
	versions: { node: "18.0.0", quickjs: "0.16.2" },
	pid: os.getpid(),
	execPath: os.exePath?.()[0] ?? "qjs",
	cwd: () => os.getcwd()[0],
	chdir: (dir) => os.chdir(dir),
	exit: (code) => std.exit(code ?? 0),
	hrtime: Object.assign(
		(prev) => {
			const now = os.now() * 1e6;
			const ns = prev ? now - (prev[0] * 1e9 + prev[1]) : now;
			return [Math.floor(ns / 1e9), Math.floor(ns % 1e9)];
		},
		{ bigint: () => BigInt(Math.floor(os.now() * 1e6)) }
	),
	nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
	uptime: () => os.now() / 1000,
	memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
	stdout: { write: (s) => (std.out.puts(s), true), isTTY: false, fd: 1 },
	stderr: { write: (s) => (std.err.puts(s), true), isTTY: false, fd: 2 },
	emitWarning: (warning) => std.err.puts(`Warning: ${warning}\n`),
});

/* --------------------------------------------------------------------- util */

const util = {
	inherits(ctor, superCtor) {
		Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
		Object.setPrototypeOf(ctor, superCtor);
	},
	promisify(fn) {
		return (...args) =>
			new Promise((resolve, reject) => {
				fn(...args, (err, value) => (err ? reject(err) : resolve(value)));
			});
	},
	callbackify(fn) {
		return (...args) => {
			const cb = args.pop();
			fn(...args).then((value) => cb(null, value), cb);
		};
	},
	format(...args) {
		if (typeof args[0] !== "string") return args.map((a) => util.inspect(a)).join(" ");
		let index = 1;
		const formatted = args[0].replace(/%[sdifjoO%]/g, (token) => {
			if (token === "%%") return "%";
			if (index >= args.length) return token;
			const value = args[index++];
			if (token === "%s") return String(value);
			if (token === "%d" || token === "%i") return String(Number.parseInt(value, 10));
			if (token === "%f") return String(Number.parseFloat(value));
			if (token === "%j") return JSON.stringify(value);
			return util.inspect(value);
		});
		return [formatted, ...args.slice(index).map((a) => (typeof a === "string" ? a : util.inspect(a)))].join(" ");
	},
	inspect(value, _options) {
		if (typeof value === "string") return `'${value}'`;
		if (typeof value === "bigint") return `${value}n`;
		if (value instanceof Error) return value.stack ?? String(value);
		if (value === null || typeof value !== "object") return String(value);
		try {
			return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)) ?? String(value);
		} catch {
			return String(value);
		}
	},
	isDeepStrictEqual(a, b) {
		return deepEqual(a, b);
	},
	types: {
		isDate: (v) => v instanceof Date,
		isRegExp: (v) => v instanceof RegExp,
		isPromise: (v) => v instanceof Promise,
		isMap: (v) => v instanceof Map,
		isSet: (v) => v instanceof Set,
		isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
		isArrayBuffer: (v) => v instanceof ArrayBuffer,
		isUint8Array: (v) => v instanceof Uint8Array,
	},
	deprecate(fn) {
		return fn;
	},
	// NODE_DEBUG=section[,section...] turns a section's log on, as in Node.js.
	debuglog(section) {
		const wanted = (std.getenv("NODE_DEBUG") ?? "")
			.split(",")
			.map((name) => name.trim().toUpperCase())
			.filter(Boolean);
		const enabled = wanted.includes(String(section).toUpperCase()) || wanted.includes("*");
		const log = (...args) => {
			if (enabled) std.err.puts(`${String(section).toUpperCase()} ${processModule.pid ?? 0}: ${util.format(...args)}\n`);
		};
		log.enabled = enabled;
		return log;
	},
	TextEncoder,
	TextDecoder,
};

function deepEqual(a, b) {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b);
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every((k) => deepEqual(a[k], b[k]));
}

/* ------------------------------------------------------------------- assert */

class AssertionError extends Error {
	constructor(options) {
		super(options.message ?? `${util.inspect(options.actual)} ${options.operator} ${util.inspect(options.expected)}`);
		this.name = "AssertionError";
		this.actual = options.actual;
		this.expected = options.expected;
		this.operator = options.operator;
	}
}

function assert(value, message) {
	if (!value) throw new AssertionError({ message: message ?? "Assertion failed", actual: value, expected: true, operator: "==" });
}
Object.assign(assert, {
	AssertionError,
	ok: assert,
	equal: (a, b, m) => {
		// biome-ignore lint/suspicious/noDoubleEquals: assert.equal is specified as loose equality
		if (!(a == b)) throw new AssertionError({ message: m, actual: a, expected: b, operator: "==" });
	},
	strictEqual: (a, b, m) => {
		if (!Object.is(a, b)) throw new AssertionError({ message: m, actual: a, expected: b, operator: "strictEqual" });
	},
	notStrictEqual: (a, b, m) => {
		if (Object.is(a, b)) throw new AssertionError({ message: m, actual: a, expected: b, operator: "notStrictEqual" });
	},
	deepEqual: (a, b, m) => {
		if (!deepEqual(a, b)) throw new AssertionError({ message: m, actual: a, expected: b, operator: "deepEqual" });
	},
	deepStrictEqual: (a, b, m) => {
		if (!deepEqual(a, b)) throw new AssertionError({ message: m, actual: a, expected: b, operator: "deepStrictEqual" });
	},
	throws: (fn, _expected, m) => {
		try {
			fn();
		} catch {
			return;
		}
		throw new AssertionError({ message: m ?? "Missing expected exception", operator: "throws" });
	},
	fail: (m) => {
		throw new AssertionError({ message: m ?? "Failed" });
	},
});
assert.strict = assert;

/* --------------------------------------------------------- web-ish globals */

class Event {
	constructor(type, init = {}) {
		this.type = type;
		this.defaultPrevented = false;
		this.cancelable = Boolean(init.cancelable);
		this.target = null;
	}
	preventDefault() {
		if (this.cancelable) this.defaultPrevented = true;
	}
	stopPropagation() {}
	stopImmediatePropagation() {}
}

class EventTarget {
	constructor() {
		this._listeners = Object.create(null);
	}
	addEventListener(type, fn, options = {}) {
		(this._listeners[type] ||= []).push({ fn, once: Boolean(options.once) });
	}
	removeEventListener(type, fn) {
		const list = this._listeners[type];
		if (!list) return;
		const index = list.findIndex((entry) => entry.fn === fn);
		if (index !== -1) list.splice(index, 1);
	}
	dispatchEvent(event) {
		event.target = this;
		for (const entry of [...(this._listeners[event.type] ?? [])]) {
			if (entry.once) this.removeEventListener(event.type, entry.fn);
			typeof entry.fn === "function" ? entry.fn.call(this, event) : entry.fn.handleEvent(event);
		}
		return !event.defaultPrevented;
	}
}

class AbortSignal extends EventTarget {
	constructor() {
		super();
		this.aborted = false;
		this.reason = undefined;
		this.onabort = null;
	}
	throwIfAborted() {
		if (this.aborted) throw this.reason;
	}
	static abort(reason) {
		const signal = new AbortSignal();
		signal.aborted = true;
		signal.reason = reason ?? new Error("This operation was aborted");
		return signal;
	}
	static timeout(ms) {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("The operation was aborted due to timeout")), ms);
		return controller.signal;
	}
}

class AbortController {
	constructor() {
		this.signal = new AbortSignal();
	}
	abort(reason) {
		if (this.signal.aborted) return;
		this.signal.aborted = true;
		this.signal.reason = reason ?? new Error("This operation was aborted");
		const event = new Event("abort");
		this.signal.onabort?.call(this.signal, event);
		this.signal.dispatchEvent(event);
	}
}

/*
 * A real structured clone, not a JSON round-trip: binary data has to survive, or anything built
 * on it silently loses bytes. Handles the cases the algorithm actually guarantees.
 */
function structuredClone(value, seen = new Map()) {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return seen.get(value);
	if (value instanceof Date) return new Date(value.getTime());
	if (value instanceof RegExp) return new RegExp(value.source, value.flags);
	if (value instanceof ArrayBuffer) return value.slice(0);
	if (ArrayBuffer.isView(value)) {
		const copy = new value.constructor(value.length);
		copy.set(value);
		return copy;
	}
	if (value instanceof Map) {
		const copy = new Map();
		seen.set(value, copy);
		for (const [k, v] of value) copy.set(structuredClone(k, seen), structuredClone(v, seen));
		return copy;
	}
	if (value instanceof Set) {
		const copy = new Set();
		seen.set(value, copy);
		for (const v of value) copy.add(structuredClone(v, seen));
		return copy;
	}
	const copy = Array.isArray(value) ? [] : {};
	seen.set(value, copy);
	for (const key of Object.keys(value)) copy[key] = structuredClone(value[key], seen);
	return copy;
}

/* ------------------------------------------------------------ small modules */

const querystring = {
	parse(str) {
		const out = Object.create(null);
		for (const pair of String(str).split("&")) {
			if (!pair) continue;
			const eq = pair.indexOf("=");
			const key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
			const value = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
			if (key in out) out[key] = [].concat(out[key], value);
			else out[key] = value;
		}
		return out;
	},
	stringify(obj) {
		return Object.entries(obj)
			.flatMap(([k, v]) => [].concat(v).map((item) => `${encodeURIComponent(k)}=${encodeURIComponent(item)}`))
			.join("&");
	},
	escape: encodeURIComponent,
	unescape: decodeURIComponent,
};

class StringDecoder {
	constructor(encoding = "utf8") {
		this.encoding = encoding;
		this._decoder = new TextDecoder(encoding === "utf8" ? "utf-8" : encoding);
	}
	write(buf) {
		return this._decoder.decode(buf, { stream: true });
	}
	end(buf) {
		return buf ? this._decoder.decode(buf) : this._decoder.decode();
	}
}

const osModule = {
	platform: () => processModule.platform,
	arch: () => processModule.arch,
	type: () => (processModule.platform === "win32" ? "Windows_NT" : "Linux"),
	release: () => "",
	homedir: () => processModule.env.HOME ?? processModule.env.USERPROFILE ?? "",
	tmpdir: () => processModule.env.TMPDIR ?? processModule.env.TEMP ?? "/tmp",
	hostname: () => "localhost",
	cpus: () => [],
	totalmem: () => 0,
	freemem: () => 0,
	uptime: () => processModule.uptime(),
	EOL: processModule.platform === "win32" ? "\r\n" : "\n",
	endianness: () => "LE",
};

const timers = {
	setTimeout: globalObject.setTimeout,
	clearTimeout: globalObject.clearTimeout,
	setInterval: globalObject.setInterval,
	clearInterval: globalObject.clearInterval,
	setImmediate: (fn, ...args) => globalObject.setTimeout(() => fn(...args), 0),
	clearImmediate: (handle) => globalObject.clearTimeout(handle),
};

/* ------------------------------------------------------- diagnostics_channel */

const diagnosticsChannels = Object.create(null);

class Channel {
	constructor(name) {
		this.name = name;
		this._subscribers = [];
	}
	get hasSubscribers() {
		return this._subscribers.length > 0;
	}
	publish(message) {
		for (const fn of [...this._subscribers]) fn(message, this.name);
	}
	subscribe(fn) {
		this._subscribers.push(fn);
	}
	unsubscribe(fn) {
		const index = this._subscribers.indexOf(fn);
		if (index === -1) return false;
		this._subscribers.splice(index, 1);
		return true;
	}
}

const diagnosticsChannel = {
	Channel,
	channel(name) {
		return (diagnosticsChannels[name] ||= new Channel(name));
	},
	hasSubscribers(name) {
		return Boolean(diagnosticsChannels[name]?.hasSubscribers);
	},
	subscribe(name, fn) {
		diagnosticsChannel.channel(name).subscribe(fn);
	},
	unsubscribe(name, fn) {
		return diagnosticsChannel.channel(name).unsubscribe(fn);
	},
};

/* ------------------------------------------------------------------- stream */

/*
 * Object-mode-capable streams, in memory. This covers the shape libraries actually use --
 * push/read, 'data'/'end'/'error', write/end, pipe, and Transform -- on top of EventEmitter.
 *
 * It is not a port of Node's implementation and does not reproduce its backpressure accounting:
 * highWaterMark is tracked and `write()` reports false past it, but nothing here talks to a
 * socket, so the pressure it models is only between JavaScript producers and consumers. That is
 * enough for the stream plumbing inside libraries and not enough to call this finished.
 */
class Stream extends EventEmitter {}

function initReadable(options = {}) {
	this._buffer = [];
	this._flowing = false;
	this._ended = false;
	this._destroyed = false;
	this.readable = true;
	this.readableObjectMode = Boolean(options.objectMode);
	this.readableHighWaterMark = options.highWaterMark ?? 16384;
	if (options.read) this._read = options.read;
}

class Readable extends Stream {
	constructor(options = {}) {
		super();
		initReadable.call(this, options);
	}

	_read() {}

	push(chunk) {
		if (chunk === null) {
			this._ended = true;
			// 'end' only fires once everything buffered has been handed out.
			if (!this._buffer.length) queueMicrotask(() => this.emit("end"));
			return false;
		}
		const value = this.readableObjectMode || typeof chunk !== "string" ? chunk : Buffer.from(chunk, "utf8");
		this._buffer.push(value);
		if (this._flowing) queueMicrotask(() => this._drain());
		else this.emit("readable");
		return this._buffer.length < this.readableHighWaterMark;
	}

	read() {
		return this._buffer.length ? this._buffer.shift() : null;
	}

	_drain() {
		while (this._flowing && this._buffer.length) this.emit("data", this._buffer.shift());
		if (this._ended && !this._buffer.length) this.emit("end");
	}

	on(name, fn) {
		super.on(name, fn);
		if (name === "data") {
			this._flowing = true;
			queueMicrotask(() => this._drain());
		}
		return this;
	}

	resume() {
		this._flowing = true;
		queueMicrotask(() => this._drain());
		return this;
	}

	pause() {
		this._flowing = false;
		return this;
	}

	pipe(destination) {
		this.on("data", (chunk) => destination.write(chunk));
		this.on("end", () => destination.end());
		this.on("error", (err) => destination.emit("error", err));
		return destination;
	}

	destroy(err) {
		this._destroyed = true;
		this.readable = false;
		if (err) this.emit("error", err);
		this.emit("close");
		return this;
	}

	async *[Symbol.asyncIterator]() {
		const queue = [];
		let done = false;
		let notify;
		this.on("data", (chunk) => {
			queue.push(chunk);
			notify?.();
		});
		this.on("end", () => {
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

	static from(iterable) {
		const readable = new Readable({ objectMode: true });
		(async () => {
			try {
				for await (const item of iterable) readable.push(item);
				readable.push(null);
			} catch (err) {
				readable.destroy(err);
			}
		})();
		return readable;
	}
}

function initWritable(options = {}) {
	this.writable = true;
	this._chunks = [];
	this.writableObjectMode = Boolean(options.objectMode);
	this.writableHighWaterMark = options.highWaterMark ?? 16384;
	if (options.write) this._write = options.write;
	if (options.final) this._final = options.final;
}

class Writable extends Stream {
	constructor(options = {}) {
		super();
		initWritable.call(this, options);
	}

	_write(chunk, _encoding, callback) {
		this._chunks.push(chunk);
		callback();
	}

	_final(callback) {
		callback();
	}

	write(chunk, encoding, callback) {
		if (typeof encoding === "function") {
			callback = encoding;
			encoding = undefined;
		}
		if (!this.writable) {
			this.emit("error", new Error("write after end"));
			return false;
		}
		const value = this.writableObjectMode || typeof chunk !== "string" ? chunk : Buffer.from(chunk, encoding || "utf8");
		this._write(value, encoding, (err) => {
			if (err) this.emit("error", err);
			callback?.(err);
		});
		return this._chunks.length < this.writableHighWaterMark;
	}

	end(chunk, encoding, callback) {
		if (typeof chunk === "function") {
			callback = chunk;
			chunk = undefined;
		}
		if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
		this.writable = false;
		this._final(() => {
			this.emit("finish");
			this.emit("close");
			callback?.();
		});
		return this;
	}

	destroy(err) {
		this.writable = false;
		if (err) this.emit("error", err);
		this.emit("close");
		return this;
	}
}

/*
 * Duplex is a Readable that is also a Writable. The writable half is mixed in as methods on the
 * prototype rather than held as a separate object, so `_write` and `_final` resolve on the instance:
 * a subclass overriding them, as sharp and most stream libraries do, is honoured.
 */
class Duplex extends Readable {
	constructor(options = {}) {
		super(options);
		initWritable.call(this, options);
	}
}
for (const name of Object.getOwnPropertyNames(Writable.prototype)) {
	if (name === "constructor" || name === "destroy" || Object.hasOwn(Duplex.prototype, name)) continue;
	Object.defineProperty(Duplex.prototype, name, Object.getOwnPropertyDescriptor(Writable.prototype, name));
}

function initTransform(options = {}) {
	if (options.transform) this._transform = options.transform;
	if (options.flush) this._flush = options.flush;
}

class Transform extends Duplex {
	constructor(options = {}) {
		super(options);
		initTransform.call(this, options);
	}

	_write(chunk, encoding, callback) {
		this._transform(chunk, encoding, (err, value) => {
			if (err) return callback(err);
			if (value !== undefined && value !== null) this.push(value);
			callback();
		});
	}

	_final(callback) {
		this._flush((err, value) => {
			if (value !== undefined && value !== null) this.push(value);
			this.push(null);
			callback(err);
		});
	}

	_transform(chunk, _encoding, callback) {
		callback(null, chunk);
	}

	_flush(callback) {
		callback();
	}
}

class PassThrough extends Transform {}

/*
 * ES classes cannot be invoked without `new`, but a great deal of published code inherits the old
 * way: `util.inherits(Sharp, Duplex)` and then `Duplex.call(this, options)`. Wrapping the exported
 * constructor lets that call run the same initialisation on the caller's `this`.
 */
function callable(Class, ...inits) {
	return new Proxy(Class, {
		apply(_target, thisArg, args) {
			for (const init of inits) init.apply(thisArg, args);
		},
	});
}

const CallableEventEmitter = callable(EventEmitter, initEventEmitter);
EventEmitter.EventEmitter = CallableEventEmitter;
const CallableStream = callable(Stream, initEventEmitter);
const CallableReadable = callable(Readable, initEventEmitter, initReadable);
const CallableWritable = callable(Writable, initEventEmitter, initWritable);
const CallableDuplex = callable(Duplex, initEventEmitter, initReadable, initWritable);
const CallableTransform = callable(Transform, initEventEmitter, initReadable, initWritable, initTransform);
const CallablePassThrough = callable(PassThrough, initEventEmitter, initReadable, initWritable, initTransform);

const streamModule = {
	Stream: CallableStream,
	Readable: CallableReadable,
	Writable: CallableWritable,
	Duplex: CallableDuplex,
	Transform: CallableTransform,
	PassThrough: CallablePassThrough,
	pipeline(...args) {
		const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
		const [source, ...rest] = args;
		let current = source;
		for (const next of rest) current = current.pipe(next);
		current.on("finish", () => callback?.(null));
		current.on("error", (err) => callback?.(err));
		return current;
	},
	finished(stream, callback) {
		stream.on("end", () => callback(null));
		stream.on("finish", () => callback(null));
		stream.on("error", (err) => callback(err));
	},
	isDisturbed: (stream) => Boolean(stream?._flowing || stream?._ended),
	isReadable: (stream) => Boolean(stream?.readable),
	isErrored: () => false,
};
streamModule.promises = {
	pipeline: (...args) => new Promise((resolve, reject) => streamModule.pipeline(...args, (err) => (err ? reject(err) : resolve()))),
	finished: (stream) => new Promise((resolve, reject) => streamModule.finished(stream, (err) => (err ? reject(err) : resolve()))),
};

/* ---------------------------------------------------------- module registry */

const NEEDS_NATIVE_WORK =
	"It needs native support the engine does not have yet (quickjs-ng exposes no socket API), " +
	"so ForgeGraal cannot provide it in JavaScript.";

/*
 * Modules that need the native layer. Present only when running under a ForgeGraal host (the C
 * build or the Rust one); on a bare `qjs` there are no sockets, so these stay unavailable and say
 * so rather than half-working.
 */
const nativeLayer = globalThis.__forgegraal_native ?? null;
let nativeModules = null;
if (nativeLayer) {
	const nm = await import("./native-modules.js");
	const { net, tls } = nm.createNetModules(EventEmitter);
	const { http, https, fetch } = web.createHttpModules({ net, tls }, nm.zlib, EventEmitter);
	nativeModules = { net, tls, http, https, fetch, crypto: nm.crypto, zlib: nm.zlib };

	// Loaders for native addons choose between glibc and musl prebuilts by reading this, exactly as
	// they do under Node.js.
	processModule.report = {
		getReport: () => ({
			header: {
				glibcVersionRuntime: nativeLayer.glibc,
				glibcVersionCompiler: nativeLayer.glibc,
				platform: processModule.platform,
				arch: processModule.arch,
			},
		}),
	};

	// Native addons. A `.node` file is a shared library speaking Node-API, which the host implements
	// itself (quickjs/native/napi.c). Async work and thread-safe functions finish on other threads, so
	// while any is outstanding a timer drains their results on this one; it backs off when idle.
	if (typeof nativeLayer.dlopen === "function") {
		let timer = null;
		let pumping = false;
		let delay = 1;
		const tick = () => {
			timer = null;
			delay = nativeLayer.napiDrain() > 0 ? 1 : Math.min(delay * 2, 25);
			if (pumping) timer = globalObject.setTimeout(tick, delay);
		};
		nativeLayer.napiInit({
			Buffer,
			start() {
				pumping = true;
				delay = 1;
				if (!timer) timer = globalObject.setTimeout(tick, delay);
			},
			stop() {
				pumping = false;
				if (timer) globalObject.clearTimeout(timer);
				timer = null;
			},
		});
		processModule.dlopen = (module, filename) => {
			module.exports = nativeLayer.dlopen(filename, module.exports);
		};
	}

	// Web globals that only become real once there is a socket and a compressor behind them.
	defGlobal("fetch", fetch);
	defGlobal("Headers", web.Headers);
	defGlobal("Request", web.Request);
	defGlobal("Response", web.Response);
}

function defGlobal(name, value) {
	if (typeof globalObject[name] === "undefined" && value) globalObject[name] = value;
}

// Web Streams and Blob/File do not need the native layer at all, so they are installed either way.
defGlobal("ReadableStream", web.ReadableStream);
defGlobal("WritableStream", web.WritableStream);
defGlobal("TransformStream", web.TransformStream);
defGlobal("ByteLengthQueuingStrategy", web.ByteLengthQueuingStrategy);
defGlobal("CountQueuingStrategy", web.CountQueuingStrategy);
defGlobal("Blob", web.Blob);
defGlobal("File", web.File);

/*
 * Intl.Segmenter, implemented per UAX #29 in segmenter.js rather than approximated: grapheme and
 * word granularity pass Unicode's own conformance suites in full (GraphemeBreakTest 1187/1187,
 * WordBreakTest 1826/1826). Sentence granularity throws, because those rules are locale-tailorable
 * and a single untailored implementation would be wrong for the locales that need tailoring.
 */
// quickjs-ng ships no Intl namespace at all, so it is created rather than extended. Only
// Segmenter is provided; the other Intl constructors need CLDR data this runtime does not carry,
// and inventing them would be the approximation this implementation exists to avoid.
if (typeof globalObject.Intl === "undefined") {
	globalObject.Intl = {};
}
if (typeof globalObject.Intl.Segmenter === "undefined") {
	globalObject.Intl.Segmenter = Segmenter;
}

/*
 * Name resolution. The native layer resolves a host as part of connect(), so the only thing
 * needed here is a way to ask it without opening a connection; where the host exposes no
 * resolver, dns.lookup reports that rather than inventing an address.
 */
function dnsLookup(hostname) {
	if (hostname === "localhost") return "127.0.0.1";
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname;
	if (nativeLayer?.lookup) return nativeLayer.lookup(hostname);
	throw new Error(
		`cannot resolve '${hostname}': this runtime's native layer exposes no resolver. Connecting by ` +
			"hostname still works, because the connect() call resolves it itself."
	);
}

function createReadlineModule() {
	const readline = misc.createReadline(EventEmitter);
	return readline;
}

const builtins = {
	assert,
	"assert/strict": assert,
	buffer: { Buffer, atob: (s) => Buffer.from(s, "base64").toString("latin1"), btoa: (s) => Buffer.from(s, "latin1").toString("base64") },
	events: CallableEventEmitter,
	fs,
	"fs/promises": fs.promises,
	os: osModule,
	path: pathModule,
	"path/posix": posixPath,
	"path/win32": win32Path,
	process: processModule,
	querystring,
	string_decoder: { StringDecoder },
	timers,
	"timers/promises": {
		setTimeout: (ms, value) => new Promise((resolve) => globalObject.setTimeout(() => resolve(value), ms)),
		setImmediate: (value) => new Promise((resolve) => globalObject.setTimeout(() => resolve(value), 0)),
	},
	util,
	"util/types": util.types,
	console: globalObject.console,
	perf_hooks: { performance: globalObject.performance },
	url: { URL: globalObject.URL, URLSearchParams: globalObject.URLSearchParams },

	// Backed by the native layer when there is one; otherwise they say what is missing.
	net: nativeModules?.net ?? notImplemented("net", NEEDS_NATIVE_WORK),
	tls: nativeModules?.tls ?? notImplemented("tls", NEEDS_NATIVE_WORK),
	http: nativeModules?.http ?? notImplemented("http", NEEDS_NATIVE_WORK),
	https: nativeModules?.https ?? notImplemented("https", NEEDS_NATIVE_WORK),
	dns: nativeModules ? misc.createDns(dnsLookup) : notImplemented("dns", NEEDS_NATIVE_WORK),
	"dns/promises": nativeModules ? misc.createDns(dnsLookup).promises : notImplemented("dns/promises", NEEDS_NATIVE_WORK),
	http2: notImplemented(
		"http2",
		"An HTTP/2 client needs HPACK header compression and stream multiplexing, which is a protocol " +
			"implementation in its own right. Nothing a bot does requires it: Discord's REST API is " +
			"HTTP/1.1 and its gateway is a WebSocket, both of which are supported."
	),
	crypto: nativeModules?.crypto ?? notImplemented("crypto", "It needs a native crypto library (hashing, HMAC and the TLS primitives)."),
	zlib: nativeModules?.zlib ?? notImplemented("zlib", "It needs a native compression library."),
	worker_threads:
		misc.createWorkerThreads(os.Worker, EventEmitter) ??
		notImplemented("worker_threads", "This engine build has no Worker implementation."),
	child_process:
		misc.createChildProcess(os, EventEmitter, {
			Buffer,
			readText: (path) => std.loadFile(path),
			tmpdir: () => std.getenv("TMPDIR") ?? std.getenv("TEMP") ?? "/tmp",
			writeStderr: (text) => std.err.puts(text),
		}) ??
		notImplemented("child_process", "This engine build exposes no exec()."),
	async_hooks: misc.asyncHooks,
	v8: misc.v8,
	tty: misc.createTty({ isatty: os.isatty, write: (text) => std.out.puts(text) }),
	readline: createReadlineModule(),
	"readline/promises": createReadlineModule(),
	stream: streamModule,
	"stream/promises": streamModule.promises,
	diagnostics_channel: diagnosticsChannel,
};

/* -------------------------------------------------------- CommonJS require */

const moduleCache = new Map();

function moduleNotFound(specifier, fromDir) {
	const err = new Error(`Cannot find module '${specifier}' from '${fromDir}'`);
	err.code = "MODULE_NOT_FOUND";
	return err;
}

/** `@scope/pkg/sub/path` -> { name: "@scope/pkg", sub: "./sub/path" }; a bare package gets sub ".". */
function splitSpecifier(specifier) {
	const parts = specifier.split("/");
	const nameLength = specifier.startsWith("@") ? 2 : 1;
	return {
		name: parts.slice(0, nameLength).join("/"),
		sub: parts.length > nameLength ? `./${parts.slice(nameLength).join("/")}` : ".",
	};
}

/**
 * Resolves `sub` ("." or "./x") against a package's "exports": an exact key first, then the
 * longest matching "./dir/*" pattern. Returns null when the package does not export it.
 */
function matchExports(exports, sub) {
	if (typeof exports === "string" || Array.isArray(exports)) return sub === "." ? resolveExports(exports) : null;
	if (!exports || typeof exports !== "object") return null;

	const keys = Object.keys(exports);
	// No key starts with ".", so this object is a condition map for the root export alone.
	if (!keys.some((key) => key.startsWith("."))) return sub === "." ? resolveExports(exports) : null;
	if (Object.hasOwn(exports, sub)) return resolveExports(exports[sub]);

	let best = null;
	for (const key of keys) {
		const star = key.indexOf("*");
		if (star < 0) continue;
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (sub.length >= key.length - 1 && sub.startsWith(prefix) && sub.endsWith(suffix)) {
			if (!best || prefix.length > best.prefix.length) best = { key, prefix, suffix };
		}
	}
	if (!best) return null;
	const target = resolveExports(exports[best.key]);
	const middle = sub.slice(best.prefix.length, sub.length - best.suffix.length);
	return target ? target.replaceAll("*", middle) : null;
}

function resolveInstalledPackage(dir, specifier) {
	const { name, sub } = splitSpecifier(specifier);
	const packageDir = pathModule.join(dir, "node_modules", name);
	const manifestPath = pathModule.join(packageDir, "package.json");
	if (fs.existsSync(manifestPath)) {
		let exports;
		try {
			exports = JSON.parse(fs.readFileSync(manifestPath, "utf8")).exports;
		} catch {
			exports = undefined;
		}
		if (exports !== undefined && exports !== null) {
			const target = matchExports(exports, sub);
			if (target) {
				const found = resolvePackage(pathModule.join(packageDir, target));
				if (found) return found;
			} else if (sub !== ".") {
				const err = new Error(`Package subpath '${sub}' is not defined by "exports" in ${manifestPath}`);
				err.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
				throw err;
			}
		}
	}
	return resolvePackage(pathModule.join(dir, "node_modules", specifier));
}

function resolveModule(specifier, fromDir) {
	const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
	if (bare in builtins) return { builtin: bare };

	let base;
	if (specifier.startsWith("./") || specifier.startsWith("../") || pathModule.isAbsolute(specifier)) {
		base = pathModule.resolve(fromDir, specifier);
	} else {
		// Walk up node_modules the way Node does, so an installed dependency tree resolves.
		let dir = fromDir;
		for (;;) {
			const found = resolveInstalledPackage(dir, specifier);
			if (found) return { file: found };
			const parent = pathModule.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		throw moduleNotFound(specifier, fromDir);
	}

	const found = resolvePackage(base);
	if (!found) throw moduleNotFound(specifier, fromDir);
	return { file: found };
}

/**
 * Picks the CommonJS entry out of a package's "exports" field.
 *
 * Only the root export and the conditions this runtime satisfies are considered: "require" and
 * "node" before "default", and "import" last, because everything here is loaded through require().
 */
function resolveExports(exports) {
	if (!exports) return null;
	if (typeof exports === "string") return exports;
	if (Array.isArray(exports)) {
		for (const candidate of exports) {
			const resolved = resolveExports(candidate);
			if (resolved) return resolved;
		}
		return null;
	}
	if (typeof exports !== "object") return null;

	const root = Object.hasOwn(exports, ".") ? exports["."] : exports;
	if (typeof root === "string") return root;
	if (!root || typeof root !== "object") return null;

	for (const condition of ["require", "node", "default", "import"]) {
		if (Object.hasOwn(root, condition)) {
			const resolved = resolveExports(root[condition]);
			if (resolved) return resolved;
		}
	}
	return null;
}

function resolvePackage(base) {
	for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.json`, `${base}.node`]) {
		if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) return candidate;
	}
	if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
		const manifestPath = pathModule.join(base, "package.json");
		if (fs.existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
				// "exports" wins over "main", as in Node. Most current packages ship only
				// "exports", so a resolver that reads just "main" cannot load them at all.
				const entry = resolveExports(manifest.exports) ?? (typeof manifest.main === "string" ? manifest.main : null);
				if (entry) {
					const resolved = resolvePackage(pathModule.join(base, entry));
					if (resolved) return resolved;
				}
			} catch {
				/* an unreadable manifest just means falling through to index.js */
			}
		}
		const index = pathModule.join(base, "index.js");
		if (fs.existsSync(index)) return index;
	}
	return null;
}

function createRequire(fromFile) {
	const fromDir = pathModule.dirname(pathModule.resolve(fromFile));
	const require = (specifier) => {
		const resolved = resolveModule(specifier, fromDir);
		if (resolved.builtin) return builtins[resolved.builtin];

		const file = resolved.file;
		if (moduleCache.has(file)) return moduleCache.get(file).exports;

		if (file.endsWith(".json")) {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			moduleCache.set(file, { exports: parsed });
			return parsed;
		}

		const module = { exports: {}, id: file, filename: file, loaded: false };
		moduleCache.set(file, module);
		if (file.endsWith(".node")) {
			if (typeof processModule.dlopen !== "function") {
				moduleCache.delete(file);
				throw new Error(
					`Cannot load native addon '${file}': this ForgeGraal runtime has no native host to load it with.`
				);
			}
			try {
				processModule.dlopen(module, file);
			} catch (err) {
				moduleCache.delete(file);
				throw err;
			}
			module.loaded = true;
			return module.exports;
		}
		const source = fs.readFileSync(file, "utf8");
		const text = `(function (exports, require, module, __filename, __dirname) {${source}\n})`;
		const wrapper = nativeLayer?.evalScript ? nativeLayer.evalScript(text, file) : std.evalScript(text);
		wrapper(module.exports, createRequire(file), module, file, pathModule.dirname(file));
		module.loaded = true;
		return module.exports;
	};
	require.resolve = (specifier) => {
		const resolved = resolveModule(specifier, fromDir);
		return resolved.builtin ?? resolved.file;
	};
	require.cache = moduleCache;
	return require;
}

/* ---------------------------------------------------------------- install */

Object.assign(globalObject, {
	Buffer,
	process: processModule,
	global: globalObject,
	EventTarget,
	Event,
	AbortController,
	AbortSignal,
	structuredClone,
	require: createRequire(`${os.getcwd()[0]}/`),
});
globalObject.setImmediate = timers.setImmediate;
globalObject.clearImmediate = timers.clearImmediate;
if (typeof globalObject.performance === "undefined") {
	globalObject.performance = { now: () => os.now(), timeOrigin: Date.now() };
}

export { Buffer, builtins, createRequire, EventEmitter, fs, pathModule as path, processModule as process, util };

/*
 * When given a script argument, run it as the entry point. This is what makes
 * `qjs node-compat.js app.js` behave like `node app.js`.
 */
const entry = (globalObject.scriptArgs ?? [])[1];
if (entry) {
	const resolved = pathModule.resolve(entry);
	createRequire(resolved)(resolved.startsWith("/") || /^[a-zA-Z]:/.test(resolved) ? resolved : `./${entry}`);
}

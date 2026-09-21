/*
 * Node's Buffer, over Uint8Array: the encodings, the integer/float readers and writers, search, copy,
 * fill, compare and swap that libraries actually call. `slice()` shares memory (as Node's does), and a
 * Buffer made from an ArrayBuffer shares it too, which native addons rely on.
 *
 * TextEncoder/TextDecoder are looked up when used, not when this file loads: node-compat.js installs
 * them after importing it.
 */

const kMaxLength = 2 ** 32;
const INSPECT_MAX_BYTES = 50;

let encoder = null;
let decoder = null;
const utf8Bytes = (text) => (encoder ??= new globalThis.TextEncoder()).encode(text);
const utf8Text = (bytes) => (decoder ??= new globalThis.TextDecoder("utf-8")).decode(bytes);

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) {
	B64_LOOKUP[B64.charCodeAt(i)] = i;
	B64_LOOKUP[B64URL.charCodeAt(i)] = i; // both alphabets decode either way, as in Node
}

function normalizeEncoding(encoding) {
	if (encoding === undefined || encoding === null || encoding === "") return "utf8";
	switch (String(encoding).toLowerCase()) {
		case "utf8":
		case "utf-8":
			return "utf8";
		case "hex":
			return "hex";
		case "base64":
			return "base64";
		case "base64url":
			return "base64url";
		case "latin1":
		case "binary":
			return "latin1";
		case "ascii":
			return "ascii";
		case "ucs2":
		case "ucs-2":
		case "utf16le":
		case "utf-16le":
			return "utf16le";
		default:
			return null;
	}
}

function encodingOrThrow(encoding) {
	const normalized = normalizeEncoding(encoding);
	if (normalized === null) {
		throw Object.assign(new TypeError(`Unknown encoding: ${encoding}`), { code: "ERR_UNKNOWN_ENCODING" });
	}
	return normalized;
}

function outOfRange(name, range, value) {
	return Object.assign(new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${value}`), {
		code: "ERR_OUT_OF_RANGE",
	});
}

function checkOffset(buf, offset, size) {
	if (offset === undefined) offset = 0;
	if (typeof offset !== "number") {
		throw Object.assign(new TypeError(`The "offset" argument must be of type number. Received ${typeof offset}`), { code: "ERR_INVALID_ARG_TYPE" });
	}
	if (!Number.isInteger(offset)) throw outOfRange("offset", "an integer", offset);
	if (offset < 0 || offset + size > buf.length) {
		if (buf.length - size < 0) {
			throw Object.assign(new RangeError("Attempt to access memory outside buffer bounds"), { code: "ERR_BUFFER_OUT_OF_BOUNDS" });
		}
		throw outOfRange("offset", `>= 0 and <= ${buf.length - size}`, offset);
	}
	return offset;
}

function checkInt(value, min, max) {
	if (typeof value !== "number" && typeof value !== "bigint") value = Number(value);
	if (value > max || value < min) throw outOfRange("value", `>= ${min} and <= ${max}`, value);
}

function decodeBase64(str) {
	let n = 0;
	const out = new Uint8Array(Math.ceil((str.length * 3) / 4));
	let acc = 0;
	let bits = 0;
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		if (c === 61) break; // '='
		const v = c < 256 ? B64_LOOKUP[c] : -1;
		if (v < 0) continue; // whitespace and stray characters are skipped, as Node does
		acc = (acc << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[n++] = (acc >> bits) & 0xff;
			acc &= (1 << bits) - 1;
		}
	}
	return out.subarray(0, n);
}

function encodeBase64(bytes, alphabet, pad) {
	let out = "";
	const n = bytes.length;
	for (let i = 0; i < n; i += 3) {
		const triple = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
		out += alphabet[(triple >> 18) & 63] + alphabet[(triple >> 12) & 63];
		if (i + 1 < n) out += alphabet[(triple >> 6) & 63];
		else if (pad) out += "=";
		if (i + 2 < n) out += alphabet[triple & 63];
		else if (pad) out += "=";
	}
	return out;
}

/* String -> bytes, for the encodings that are not UTF-8. */
function stringBytes(str, encoding) {
	switch (encoding) {
		case "utf8":
			return utf8Bytes(str);
		case "hex": {
			const len = str.length >> 1;
			const out = new Uint8Array(len);
			let i = 0;
			for (; i < len; i++) {
				const byte = Number.parseInt(str.substr(i * 2, 2), 16);
				if (Number.isNaN(byte) || !/^[0-9a-fA-F]{2}$/.test(str.substr(i * 2, 2))) break;
				out[i] = byte;
			}
			return out.subarray(0, i);
		}
		case "base64":
		case "base64url":
			return decodeBase64(str);
		case "latin1":
		case "ascii": {
			const out = new Uint8Array(str.length);
			for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
			return out;
		}
		case "utf16le": {
			const out = new Uint8Array(str.length * 2);
			for (let i = 0; i < str.length; i++) {
				const c = str.charCodeAt(i);
				out[i * 2] = c & 0xff;
				out[i * 2 + 1] = c >> 8;
			}
			return out;
		}
		default:
			throw Object.assign(new TypeError(`Unknown encoding: ${encoding}`), { code: "ERR_UNKNOWN_ENCODING" });
	}
}

/* Bytes -> string. */
function bytesString(bytes, encoding) {
	switch (encoding) {
		case "utf8":
			return utf8Text(bytes);
		case "hex": {
			let out = "";
			for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
			return out;
		}
		case "base64":
			return encodeBase64(bytes, B64, true);
		case "base64url":
			return encodeBase64(bytes, B64URL, false);
		case "latin1": {
			let out = "";
			for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
			return out;
		}
		case "ascii": {
			let out = "";
			for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] & 0x7f);
			return out;
		}
		case "utf16le": {
			let out = "";
			for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
			return out;
		}
		default:
			throw Object.assign(new TypeError(`Unknown encoding: ${encoding}`), { code: "ERR_UNKNOWN_ENCODING" });
	}
}

const dataView = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

class Buffer extends Uint8Array {
	static poolSize = 8192;

	static alloc(size, fill, encoding) {
		if (typeof size !== "number" || size < 0 || Number.isNaN(size)) {
			throw Object.assign(new RangeError(`The argument 'size' is invalid. Received ${size}`), { code: "ERR_INVALID_ARG_VALUE" });
		}
		const buf = new Buffer(size);
		if (fill !== undefined && fill !== 0 && size > 0) buf.fill(fill, 0, size, encoding);
		return buf;
	}

	static allocUnsafe(size) {
		return Buffer.alloc(size);
	}

	static allocUnsafeSlow(size) {
		return Buffer.alloc(size);
	}

	static from(value, encodingOrOffset, length) {
		if (typeof value === "string") return Buffer._fromString(value, encodingOrOffset);
		if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) {
			// Shares memory with the ArrayBuffer rather than copying it, as Node does. Native addons
			// rely on it: they write into the buffer they created after handing it back to JavaScript.
			const offset = encodingOrOffset === undefined ? 0 : +encodingOrOffset;
			return new Buffer(value, offset, length === undefined ? value.byteLength - offset : length);
		}
		if (ArrayBuffer.isView(value)) {
			const out = new Buffer(value.length);
			if (value instanceof Uint8Array || value instanceof Uint8ClampedArray || value instanceof Int8Array) {
				out.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
			} else {
				for (let i = 0; i < value.length; i++) out[i] = Number(value[i]) & 0xff; // element values, truncated
			}
			return out;
		}
		if (value === null || value === undefined) {
			throw Object.assign(
				new TypeError(
					"The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. " +
						`Received ${value === null ? "null" : "undefined"}`
				),
				{ code: "ERR_INVALID_ARG_TYPE" }
			);
		}
		if (typeof value === "object") {
			if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
			if (typeof value.length === "number") {
				const out = new Buffer(value.length);
				for (let i = 0; i < value.length; i++) out[i] = value[i] & 0xff;
				return out;
			}
			const primitive = value.valueOf?.();
			if (primitive !== undefined && primitive !== value && (typeof primitive === "string" || typeof primitive === "object")) {
				return Buffer.from(primitive, encodingOrOffset, length);
			}
			if (typeof value[Symbol.toPrimitive] === "function") {
				return Buffer.from(value[Symbol.toPrimitive]("string"), encodingOrOffset, length);
			}
		}
		throw Object.assign(
			new TypeError(
				"The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. " +
					`Received type ${typeof value}`
			),
			{ code: "ERR_INVALID_ARG_TYPE" }
		);
	}

	static _fromString(str, encoding) {
		const bytes = stringBytes(str, encodingOrThrow(encoding));
		const out = new Buffer(bytes.length);
		out.set(bytes);
		return out;
	}

	static concat(list, totalLength) {
		if (!Array.isArray(list)) {
			throw Object.assign(new TypeError('The "list" argument must be an instance of Array.'), { code: "ERR_INVALID_ARG_TYPE" });
		}
		if (list.length === 0) return Buffer.alloc(0);
		let total = totalLength;
		if (total === undefined) {
			total = 0;
			for (const item of list) total += item.length;
		}
		const out = Buffer.alloc(total);
		let offset = 0;
		for (const item of list) {
			if (offset >= total) break;
			if (!(item instanceof Uint8Array)) {
				throw Object.assign(new TypeError('The "list[i]" argument must be an instance of Buffer or Uint8Array.'), { code: "ERR_INVALID_ARG_TYPE" });
			}
			out.set(item.length > total - offset ? item.subarray(0, total - offset) : item, offset);
			offset += item.length;
		}
		return out;
	}

	static isBuffer(value) {
		return value instanceof Buffer;
	}

	static isEncoding(encoding) {
		return typeof encoding === "string" && encoding.length !== 0 && normalizeEncoding(encoding) !== null;
	}

	static byteLength(value, encoding) {
		if (typeof value === "string") {
			const enc = normalizeEncoding(encoding) ?? "utf8";
			if (enc === "utf8") return utf8Bytes(value).length;
			return stringBytes(value, enc).length;
		}
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength;
		throw Object.assign(
			new TypeError('The "string" argument must be of type string or an instance of Buffer or ArrayBuffer.'),
			{ code: "ERR_INVALID_ARG_TYPE" }
		);
	}

	static compare(a, b) {
		if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
			throw Object.assign(new TypeError('The "buf1" and "buf2" arguments must be an instance of Buffer or Uint8Array.'), { code: "ERR_INVALID_ARG_TYPE" });
		}
		const n = Math.min(a.length, b.length);
		for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
		return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
	}

	static copyBytesFrom(view, offset = 0, length) {
		const size = view.BYTES_PER_ELEMENT ?? 1;
		const count = length === undefined ? view.length - offset : length;
		return Buffer.from(view.buffer.slice(view.byteOffset + offset * size, view.byteOffset + (offset + count) * size));
	}

	get parent() {
		return this.buffer;
	}
	get offset() {
		return this.byteOffset;
	}

	toString(encoding, start = 0, end = this.length) {
		const enc = encodingOrThrow(encoding);
		start = Math.max(0, start | 0);
		end = Math.min(this.length, end === undefined ? this.length : end | 0);
		if (end <= start) return "";
		return bytesString(start === 0 && end === this.length ? this : this.subarray(start, end), enc);
	}

	toLocaleString(encoding, start, end) {
		return this.toString(encoding, start, end);
	}

	toJSON() {
		return { type: "Buffer", data: Array.from(this) };
	}

	equals(other) {
		if (!(other instanceof Uint8Array)) {
			throw Object.assign(new TypeError('The "otherBuffer" argument must be an instance of Buffer or Uint8Array.'), { code: "ERR_INVALID_ARG_TYPE" });
		}
		return Buffer.compare(this, other) === 0;
	}

	compare(target, targetStart = 0, targetEnd = target.length, sourceStart = 0, sourceEnd = this.length) {
		return Buffer.compare(this.subarray(sourceStart, sourceEnd), target.subarray(targetStart, targetEnd));
	}

	/* Shares memory with the original, unlike Uint8Array.prototype.slice. */
	slice(start, end) {
		return this.subarray(start, end);
	}

	_search(value, byteOffset, encoding, forward) {
		if (typeof byteOffset === "string") {
			encoding = byteOffset;
			byteOffset = undefined;
		}
		let needle;
		if (typeof value === "string") needle = stringBytes(value, encodingOrThrow(encoding));
		else if (typeof value === "number") needle = Uint8Array.of(value & 0xff);
		else if (value instanceof Uint8Array) needle = value;
		else {
			throw Object.assign(new TypeError('The "value" argument must be one of type number or string or an instance of Buffer or Uint8Array.'), {
				code: "ERR_INVALID_ARG_TYPE",
			});
		}
		const len = this.length;
		let start = byteOffset === undefined || Number.isNaN(+byteOffset) ? (forward ? 0 : len) : Math.trunc(+byteOffset);
		if (start < 0) start = Math.max(0, len + start);
		if (needle.length === 0) return Math.min(start, len);
		if (forward) {
			outer: for (let i = start; i <= len - needle.length; i++) {
				for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
				return i;
			}
		} else {
			outer2: for (let i = Math.min(start, len - needle.length); i >= 0; i--) {
				for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer2;
				return i;
			}
		}
		return -1;
	}
	indexOf(value, byteOffset, encoding) {
		return this._search(value, byteOffset, encoding, true);
	}
	lastIndexOf(value, byteOffset, encoding) {
		return this._search(value, byteOffset, encoding, false);
	}
	includes(value, byteOffset, encoding) {
		return this._search(value, byteOffset, encoding, true) !== -1;
	}

	copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
		targetStart = targetStart | 0;
		sourceStart = Math.max(0, sourceStart | 0);
		sourceEnd = Math.min(this.length, sourceEnd | 0);
		if (targetStart >= target.length || sourceStart >= sourceEnd) return 0;
		const count = Math.min(sourceEnd - sourceStart, target.length - targetStart);
		// copyWithin semantics: correct even when both ranges overlap in the same memory.
		const source = new Uint8Array(this.buffer, this.byteOffset + sourceStart, count);
		const dest = new Uint8Array(target.buffer, target.byteOffset + targetStart, count);
		dest.set(source.slice());
		return count;
	}

	write(string, offset, length, encoding) {
		if (typeof offset === "string") {
			encoding = offset;
			offset = 0;
			length = undefined;
		} else if (typeof length === "string") {
			encoding = length;
			length = undefined;
		}
		offset = offset === undefined ? 0 : offset >>> 0;
		if (offset > this.length) throw outOfRange("offset", `>= 0 and <= ${this.length}`, offset);
		const remaining = this.length - offset;
		const max = length === undefined ? remaining : Math.min(length >>> 0, remaining);
		let bytes = stringBytes(String(string), encodingOrThrow(encoding));
		if (bytes.length > max) {
			// Never write half of a multi-byte UTF-8 character.
			let n = max;
			if (normalizeEncoding(encoding) === "utf8") while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--;
			else if (normalizeEncoding(encoding) === "utf16le") n -= n % 2;
			bytes = bytes.subarray(0, n);
		}
		this.set(bytes, offset);
		return bytes.length;
	}

	fill(value, offset, end, encoding) {
		if (typeof offset === "string") {
			encoding = offset;
			offset = 0;
			end = this.length;
		} else if (typeof end === "string") {
			encoding = end;
			end = this.length;
		}
		offset = offset === undefined ? 0 : offset >>> 0;
		end = end === undefined ? this.length : end >>> 0;
		if (offset > end || end > this.length) throw outOfRange("offset", `>= 0 and <= ${this.length}`, offset);
		if (offset === end) return this;
		if (typeof value === "number" || typeof value === "boolean") {
			super.fill(Number(value) & 0xff, offset, end);
			return this;
		}
		let pattern;
		if (typeof value === "string") pattern = stringBytes(value, encodingOrThrow(encoding));
		else if (value instanceof Uint8Array) pattern = value;
		else {
			super.fill(0, offset, end);
			return this;
		}
		if (pattern.length === 0) {
			if (typeof value === "string") {
				super.fill(0, offset, end);
				return this;
			}
			throw Object.assign(new TypeError(`The argument 'value' is invalid. Received ${value}`), { code: "ERR_INVALID_ARG_VALUE" });
		}
		for (let i = offset, j = 0; i < end; i++, j = (j + 1) % pattern.length) this[i] = pattern[j];
		return this;
	}

	swap16() {
		if (this.length % 2) throw Object.assign(new RangeError("Buffer size must be a multiple of 16-bits"), { code: "ERR_INVALID_BUFFER_SIZE" });
		for (let i = 0; i < this.length; i += 2) [this[i], this[i + 1]] = [this[i + 1], this[i]];
		return this;
	}
	swap32() {
		if (this.length % 4) throw Object.assign(new RangeError("Buffer size must be a multiple of 32-bits"), { code: "ERR_INVALID_BUFFER_SIZE" });
		for (let i = 0; i < this.length; i += 4) {
			[this[i], this[i + 3]] = [this[i + 3], this[i]];
			[this[i + 1], this[i + 2]] = [this[i + 2], this[i + 1]];
		}
		return this;
	}
	swap64() {
		if (this.length % 8) throw Object.assign(new RangeError("Buffer size must be a multiple of 64-bits"), { code: "ERR_INVALID_BUFFER_SIZE" });
		for (let i = 0; i < this.length; i += 8) for (let j = 0; j < 4; j++) [this[i + j], this[i + 7 - j]] = [this[i + 7 - j], this[i + j]];
		return this;
	}

	/* ---- integers and floats ---- */

	readUInt8(offset) {
		return this[checkOffset(this, offset, 1)];
	}
	readInt8(offset) {
		return dataView(this).getInt8(checkOffset(this, offset, 1));
	}
	readUInt16LE(offset) {
		return dataView(this).getUint16(checkOffset(this, offset, 2), true);
	}
	readUInt16BE(offset) {
		return dataView(this).getUint16(checkOffset(this, offset, 2), false);
	}
	readInt16LE(offset) {
		return dataView(this).getInt16(checkOffset(this, offset, 2), true);
	}
	readInt16BE(offset) {
		return dataView(this).getInt16(checkOffset(this, offset, 2), false);
	}
	readUInt32LE(offset) {
		return dataView(this).getUint32(checkOffset(this, offset, 4), true);
	}
	readUInt32BE(offset) {
		return dataView(this).getUint32(checkOffset(this, offset, 4), false);
	}
	readInt32LE(offset) {
		return dataView(this).getInt32(checkOffset(this, offset, 4), true);
	}
	readInt32BE(offset) {
		return dataView(this).getInt32(checkOffset(this, offset, 4), false);
	}
	readFloatLE(offset) {
		return dataView(this).getFloat32(checkOffset(this, offset, 4), true);
	}
	readFloatBE(offset) {
		return dataView(this).getFloat32(checkOffset(this, offset, 4), false);
	}
	readDoubleLE(offset) {
		return dataView(this).getFloat64(checkOffset(this, offset, 8), true);
	}
	readDoubleBE(offset) {
		return dataView(this).getFloat64(checkOffset(this, offset, 8), false);
	}
	readBigUInt64LE(offset) {
		return dataView(this).getBigUint64(checkOffset(this, offset, 8), true);
	}
	readBigUInt64BE(offset) {
		return dataView(this).getBigUint64(checkOffset(this, offset, 8), false);
	}
	readBigInt64LE(offset) {
		return dataView(this).getBigInt64(checkOffset(this, offset, 8), true);
	}
	readBigInt64BE(offset) {
		return dataView(this).getBigInt64(checkOffset(this, offset, 8), false);
	}
	readUIntLE(offset, byteLength) {
		offset = checkOffset(this, offset, byteLength);
		let value = 0;
		for (let i = byteLength - 1; i >= 0; i--) value = value * 256 + this[offset + i];
		return value;
	}
	readUIntBE(offset, byteLength) {
		offset = checkOffset(this, offset, byteLength);
		let value = 0;
		for (let i = 0; i < byteLength; i++) value = value * 256 + this[offset + i];
		return value;
	}
	readIntLE(offset, byteLength) {
		const value = this.readUIntLE(offset, byteLength);
		const limit = 2 ** (8 * byteLength - 1);
		return value >= limit ? value - limit * 2 : value;
	}
	readIntBE(offset, byteLength) {
		const value = this.readUIntBE(offset, byteLength);
		const limit = 2 ** (8 * byteLength - 1);
		return value >= limit ? value - limit * 2 : value;
	}

	writeUInt8(value, offset) {
		offset = checkOffset(this, offset, 1);
		checkInt(value, 0, 0xff);
		this[offset] = value;
		return offset + 1;
	}
	writeInt8(value, offset) {
		offset = checkOffset(this, offset, 1);
		checkInt(value, -0x80, 0x7f);
		dataView(this).setInt8(offset, value);
		return offset + 1;
	}
	writeUInt16LE(value, offset) {
		offset = checkOffset(this, offset, 2);
		checkInt(value, 0, 0xffff);
		dataView(this).setUint16(offset, value, true);
		return offset + 2;
	}
	writeUInt16BE(value, offset) {
		offset = checkOffset(this, offset, 2);
		checkInt(value, 0, 0xffff);
		dataView(this).setUint16(offset, value, false);
		return offset + 2;
	}
	writeInt16LE(value, offset) {
		offset = checkOffset(this, offset, 2);
		checkInt(value, -0x8000, 0x7fff);
		dataView(this).setInt16(offset, value, true);
		return offset + 2;
	}
	writeInt16BE(value, offset) {
		offset = checkOffset(this, offset, 2);
		checkInt(value, -0x8000, 0x7fff);
		dataView(this).setInt16(offset, value, false);
		return offset + 2;
	}
	writeUInt32LE(value, offset) {
		offset = checkOffset(this, offset, 4);
		checkInt(value, 0, 0xffffffff);
		dataView(this).setUint32(offset, value, true);
		return offset + 4;
	}
	writeUInt32BE(value, offset) {
		offset = checkOffset(this, offset, 4);
		checkInt(value, 0, 0xffffffff);
		dataView(this).setUint32(offset, value, false);
		return offset + 4;
	}
	writeInt32LE(value, offset) {
		offset = checkOffset(this, offset, 4);
		checkInt(value, -0x80000000, 0x7fffffff);
		dataView(this).setInt32(offset, value, true);
		return offset + 4;
	}
	writeInt32BE(value, offset) {
		offset = checkOffset(this, offset, 4);
		checkInt(value, -0x80000000, 0x7fffffff);
		dataView(this).setInt32(offset, value, false);
		return offset + 4;
	}
	writeFloatLE(value, offset) {
		offset = checkOffset(this, offset, 4);
		dataView(this).setFloat32(offset, value, true);
		return offset + 4;
	}
	writeFloatBE(value, offset) {
		offset = checkOffset(this, offset, 4);
		dataView(this).setFloat32(offset, value, false);
		return offset + 4;
	}
	writeDoubleLE(value, offset) {
		offset = checkOffset(this, offset, 8);
		dataView(this).setFloat64(offset, value, true);
		return offset + 8;
	}
	writeDoubleBE(value, offset) {
		offset = checkOffset(this, offset, 8);
		dataView(this).setFloat64(offset, value, false);
		return offset + 8;
	}
	writeBigUInt64LE(value, offset) {
		offset = checkOffset(this, offset, 8);
		checkInt(value, 0n, 0xffffffffffffffffn);
		dataView(this).setBigUint64(offset, value, true);
		return offset + 8;
	}
	writeBigUInt64BE(value, offset) {
		offset = checkOffset(this, offset, 8);
		checkInt(value, 0n, 0xffffffffffffffffn);
		dataView(this).setBigUint64(offset, value, false);
		return offset + 8;
	}
	writeBigInt64LE(value, offset) {
		offset = checkOffset(this, offset, 8);
		checkInt(value, -(2n ** 63n), 2n ** 63n - 1n);
		dataView(this).setBigInt64(offset, value, true);
		return offset + 8;
	}
	writeBigInt64BE(value, offset) {
		offset = checkOffset(this, offset, 8);
		checkInt(value, -(2n ** 63n), 2n ** 63n - 1n);
		dataView(this).setBigInt64(offset, value, false);
		return offset + 8;
	}
	writeUIntLE(value, offset, byteLength) {
		offset = checkOffset(this, offset, byteLength);
		checkInt(value, 0, 2 ** (8 * byteLength) - 1);
		let v = value;
		for (let i = 0; i < byteLength; i++) {
			this[offset + i] = v % 256;
			v = Math.floor(v / 256);
		}
		return offset + byteLength;
	}
	writeUIntBE(value, offset, byteLength) {
		offset = checkOffset(this, offset, byteLength);
		checkInt(value, 0, 2 ** (8 * byteLength) - 1);
		let v = value;
		for (let i = byteLength - 1; i >= 0; i--) {
			this[offset + i] = v % 256;
			v = Math.floor(v / 256);
		}
		return offset + byteLength;
	}
	writeIntLE(value, offset, byteLength) {
		const limit = 2 ** (8 * byteLength - 1);
		checkInt(value, -limit, limit - 1);
		return this.writeUIntLE(value < 0 ? value + limit * 2 : value, offset, byteLength);
	}
	writeIntBE(value, offset, byteLength) {
		const limit = 2 ** (8 * byteLength - 1);
		checkInt(value, -limit, limit - 1);
		return this.writeUIntBE(value < 0 ? value + limit * 2 : value, offset, byteLength);
	}

	/* Node's slice/write helpers, which some libraries call directly. */
	utf8Slice(start = 0, end = this.length) {
		return this.toString("utf8", start, end);
	}
	latin1Slice(start = 0, end = this.length) {
		return this.toString("latin1", start, end);
	}
	asciiSlice(start = 0, end = this.length) {
		return this.toString("ascii", start, end);
	}
	hexSlice(start = 0, end = this.length) {
		return this.toString("hex", start, end);
	}
	base64Slice(start = 0, end = this.length) {
		return this.toString("base64", start, end);
	}
	base64urlSlice(start = 0, end = this.length) {
		return this.toString("base64url", start, end);
	}
	ucs2Slice(start = 0, end = this.length) {
		return this.toString("utf16le", start, end);
	}
	utf8Write(string, offset, length) {
		return this.write(string, offset, length, "utf8");
	}
	latin1Write(string, offset, length) {
		return this.write(string, offset, length, "latin1");
	}
	asciiWrite(string, offset, length) {
		return this.write(string, offset, length, "ascii");
	}
	hexWrite(string, offset, length) {
		return this.write(string, offset, length, "hex");
	}
	base64Write(string, offset, length) {
		return this.write(string, offset, length, "base64");
	}
	ucs2Write(string, offset, length) {
		return this.write(string, offset, length, "utf16le");
	}
}

/* The lowercase-"int" spellings Node keeps as aliases. */
for (const name of Object.getOwnPropertyNames(Buffer.prototype)) {
	if (/UInt/.test(name)) Object.defineProperty(Buffer.prototype, name.replace("UInt", "Uint"), { value: Buffer.prototype[name], writable: true, configurable: true });
}
Object.defineProperty(Buffer.prototype, "readUintLE", { value: Buffer.prototype.readUIntLE, writable: true, configurable: true });
Object.defineProperty(Buffer.prototype, "readUintBE", { value: Buffer.prototype.readUIntBE, writable: true, configurable: true });
Object.defineProperty(Buffer.prototype, "writeUintLE", { value: Buffer.prototype.writeUIntLE, writable: true, configurable: true });
Object.defineProperty(Buffer.prototype, "writeUintBE", { value: Buffer.prototype.writeUIntBE, writable: true, configurable: true });

/* `Buffer(x)` without `new` is deprecated in Node but still called by old packages. */
function SlowBuffer(size) {
	return Buffer.alloc(size);
}

const bufferConstants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: 2 ** 29 - 24 };

const isUtf8 = (input) => {
	try {
		new globalThis.TextDecoder("utf-8", { fatal: true }).decode(input);
		return true;
	} catch {
		return false;
	}
};
const isAscii = (input) => {
	const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
	for (let i = 0; i < bytes.length; i++) if (bytes[i] > 127) return false;
	return true;
};

export { Buffer, SlowBuffer, kMaxLength, INSPECT_MAX_BYTES, bufferConstants, isUtf8, isAscii, normalizeEncoding };

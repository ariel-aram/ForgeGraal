/*
 * A small ASN.1 DER writer and reader, and PEM armour: what the key, certificate and PKCS#12 code needs.
 */

export const join = (parts) => {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};
export const derLength = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255]);
export const tlv = (tag, ...parts) => {
	const body = join(parts);
	return join([Uint8Array.of(tag, ...derLength(body.length)), body]);
};
export const derSeq = (...parts) => tlv(0x30, ...parts);
export const derInt = (bytes) => {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) start++;
	const trimmed = bytes.subarray(start);
	return tlv(2, trimmed[0] & 0x80 ? join([Uint8Array.of(0), trimmed]) : trimmed);
};
export const derOctets = (bytes) => tlv(4, bytes);
export const derBits = (bytes) => tlv(3, Uint8Array.of(0), bytes);
export const derNull = () => Uint8Array.of(5, 0);
export const derOid = (dotted) => {
	const parts = dotted.split(".").map(Number);
	const bytes = [parts[0] * 40 + parts[1]];
	for (const part of parts.slice(2)) {
		const stack = [part & 127];
		for (let v = part >>> 7; v > 0; v >>>= 7) stack.push((v & 127) | 128);
		bytes.push(...stack.reverse());
	}
	return tlv(6, Uint8Array.from(bytes));
};
/* One element at `pos`: its tag, where its content starts and ends, and where the next element begins. */
export const readTlv = (bytes, pos) => {
	const tag = bytes[pos];
	let length = bytes[pos + 1];
	let start = pos + 2;
	if (length === 0x80) {
		// BER indefinite length: the content runs to the end-of-contents marker (00 00).
		let at = start;
		while (at + 1 < bytes.length && !(bytes[at] === 0 && bytes[at + 1] === 0)) at = readTlv(bytes, at).next;
		return { tag, pos, start, end: at, next: at + 2, indefinite: true };
	}
	if (length & 0x80) {
		const count = length & 0x7f;
		length = 0;
		for (let i = 0; i < count; i++) length = length * 256 + bytes[start + i];
		start += count;
	}
	return { tag, pos, start, end: start + length, next: start + length };
};
export const readChildren = (bytes, element) => {
	const out = [];
	for (let pos = element.start; pos < element.end; ) {
		const child = readTlv(bytes, pos);
		out.push(child);
		pos = child.next;
	}
	return out;
};
export const unsignedBytes = (bytes, element) => {
	let start = element.start;
	while (start < element.end - 1 && bytes[start] === 0) start++;
	return bytes.subarray(start, element.end);
};

export const PEM_LINE = 64;
export const toPem = (label, der, Buffer) => {
	const b64 = Buffer.from(der).toString("base64");
	const lines = [];
	for (let i = 0; i < b64.length; i += PEM_LINE) lines.push(b64.slice(i, i + PEM_LINE));
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};


export const derSet = (...parts) => tlv(0x31, ...parts);
export const derUtf8 = (text, Buffer) => tlv(0x0c, new Uint8Array(Buffer.from(text, "utf8")));
export const derContext = (index, ...parts) => tlv(0xa0 | index, ...parts);
/* Dotted text of an OID's content bytes. */
export const oidText = (bytes, element) => {
	const body = element ? bytes.subarray(element.start, element.end) : bytes;
	const parts = [Math.floor(body[0] / 40), body[0] % 40];
	let value = 0;
	for (let i = 1; i < body.length; i++) {
		value = value * 128 + (body[i] & 127);
		if (!(body[i] & 128)) {
			parts.push(value);
			value = 0;
		}
	}
	return parts.join(".");
};
/* The DER inside a PEM block (or bytes that are DER already), with its label and any header lines. */
export const fromPem = (input, Buffer) => {
	const text = typeof input === "string" ? input : Buffer.from(input).toString("latin1");
	const m = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([\s\S]*?)-----END \1-----/.exec(text);
	if (!m) return null;
	const headers = {};
	let body = m[2];
	const headerEnd = /^((?:[A-Za-z0-9-]+: .*\r?\n)+)\r?\n/.exec(body);
	if (headerEnd) {
		for (const lineText of headerEnd[1].split(/\r?\n/)) {
			const kv = /^([A-Za-z0-9-]+): (.*)$/.exec(lineText);
			if (kv) headers[kv[1]] = kv[2];
		}
		body = body.slice(headerEnd[0].length);
	}
	return { label: m[1], headers, der: new Uint8Array(Buffer.from(body.replace(/\s+/g, ""), "base64")) };
};

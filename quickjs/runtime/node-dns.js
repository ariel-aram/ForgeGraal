/*
 * dns and dns/promises: a DNS client written in JavaScript, in place of the c-ares that Node.js ships.
 *
 * Queries go out as UDP datagrams through the host's `dgram` and fall back to TCP (`net`) when the answer comes back
 * truncated. The wire format is RFC 1035 (compression pointers included). What is observable from a program follows
 * Node.js 24/26: the record shapes for every type, `ttl: true`, the error codes and messages (`queryA ENOTFOUND
 * example.com`), the rules for which server is asked next, `cancel()`, `setLocalAddress()`, and the argument checks.
 *
 * Where the servers come from: POSIX reads /etc/resolv.conf. Windows has no such file and the host has no native call
 * for it, so the list is read from the output of `ipconfig /all` (then `nslookup`), matched by shape and not by the
 * display language. When nothing is found the local machine is asked, as c-ares does.
 */

const TYPES = {
	A: 1,
	NS: 2,
	CNAME: 5,
	SOA: 6,
	PTR: 12,
	MX: 15,
	TXT: 16,
	AAAA: 28,
	SRV: 33,
	NAPTR: 35,
	TLSA: 52,
	CAA: 257,
};
const ERROR_NAMES = [
	"NODATA",
	"FORMERR",
	"SERVFAIL",
	"NOTFOUND",
	"NOTIMP",
	"REFUSED",
	"BADQUERY",
	"BADNAME",
	"BADFAMILY",
	"BADRESP",
	"CONNREFUSED",
	"TIMEOUT",
	"EOF",
	"FILE",
	"NOMEM",
	"DESTRUCTION",
	"BADSTR",
	"BADFLAGS",
	"NONAME",
	"BADHINTS",
	"NOTINITIALIZED",
	"LOADIPHLPAPI",
	"ADDRGETNETWORKPARAMS",
	"CANCELLED",
];
const RCODE_ERRORS = { 1: "EFORMERR", 2: "ESERVFAIL", 3: "ENOTFOUND", 4: "ENOTIMP", 5: "EREFUSED" };
const ADDRCONFIG = 32;
const V4MAPPED = 8;
const ALL = 16;
const RESULT_ORDERS = ["verbatim", "ipv4first", "ipv6first"];
const DEFAULT_TIMEOUT = 2000;
const DEFAULT_TRIES = 4;

/* ------------------------------------------------------------------------------------------ errors and checks */

const nodeError = (Ctor, code, message) => Object.assign(new Ctor(message), { code });

function makeChecks(inspect) {
	const show = (value, limit) => {
		const text = inspect(value, { colors: false });
		return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
	};
	const received = (value) => {
		if (value == null) return `${value}`;
		if (typeof value === "function") return `function ${value.name}`;
		if (typeof value === "object") {
			return value.constructor?.name ? `an instance of ${value.constructor.name}` : inspect(value, { depth: -1 });
		}
		return `type ${typeof value} (${show(value, 28)})`;
	};
	const kind = (name) => (name.includes(".") ? "property" : "argument");
	const typeError = (name, expected, value) =>
		nodeError(
			TypeError,
			"ERR_INVALID_ARG_TYPE",
			`The "${name}" ${kind(name)} must be ${expected}. Received ${received(value)}`
		);
	const valueError = (name, value, reason = "is invalid") =>
		nodeError(
			TypeError,
			"ERR_INVALID_ARG_VALUE",
			`The ${kind(name)} '${name}' ${reason}. Received ${show(value, 128)}`
		);
	const separators = (digits) => {
		let out = "";
		for (let i = digits.length; i > 0; i -= 3) out = `${digits.slice(Math.max(0, i - 3), i)}${out ? `_${out}` : ""}`;
		return out;
	};
	const rangeError = (name, range, value) => {
		let text = String(value);
		if (Number.isInteger(value) && Math.abs(value) > 2 ** 32) {
			text = `${value < 0 ? "-" : ""}${separators(String(Math.abs(value)))}`;
		}
		return nodeError(
			RangeError,
			"ERR_OUT_OF_RANGE",
			`The value of "${name}" is out of range. It must be ${range}. Received ${text}`
		);
	};
	const list = (names) => {
		const quoted = names.map((n) => `"${n}"`);
		return quoted.length === 2
			? `${quoted[0]} and ${quoted[1]}`
			: `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
	};
	return {
		received,
		typeError,
		valueError,
		rangeError,
		string(value, name) {
			if (typeof value !== "string") throw typeError(name, "of type string", value);
		},
		fn(value, name) {
			if (typeof value !== "function") throw typeError(name, "of type function", value);
		},
		bool(value, name) {
			if (typeof value !== "boolean") throw typeError(name, "of type boolean", value);
		},
		number(value, name) {
			if (typeof value !== "number") throw typeError(name, "of type number", value);
		},
		integer(value, name, min, max) {
			if (typeof value !== "number") throw typeError(name, "of type number", value);
			if (!Number.isInteger(value)) throw rangeError(name, "an integer", value);
			if (value < min || value > max) throw rangeError(name, `>= ${min} && <= ${max}`, value);
		},
		oneOf(value, name, allowed) {
			if (!allowed.includes(value)) {
				const shown = allowed.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ");
				throw valueError(name, value, `must be one of: ${shown}`);
			}
		},
		port(port, name = "Port") {
			if (
				(typeof port !== "number" && typeof port !== "string") ||
				(typeof port === "string" && port.trim().length === 0) ||
				+port !== +port >>> 0 ||
				port > 0xffff
			) {
				throw nodeError(
					RangeError,
					"ERR_SOCKET_BAD_PORT",
					`${name} should be >= 0 and < 65536. Received ${received(port)}.`
				);
			}
		},
		missing(names) {
			return nodeError(
				TypeError,
				"ERR_MISSING_ARGS",
				`The ${list(names)} argument${names.length > 1 ? "s" : ""} must be specified`
			);
		},
	};
}

/** The error of a failed query: `queryA ENOTFOUND example.com`. */
function dnsError(code, syscall, hostname, errno) {
	const error = new Error(`${syscall} ${code}${hostname ? ` ${hostname}` : ""}`);
	error.errno = errno;
	error.code = code;
	error.syscall = syscall;
	if (hostname) error.hostname = hostname;
	return error;
}

/* ------------------------------------------------------------------------------------------ addresses */

function parseIPv4(text) {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	if (!match) return null;
	const bytes = [];
	for (let i = 1; i <= 4; i++) {
		const part = match[i];
		if ((part.length > 1 && part[0] === "0") || Number(part) > 255) return null;
		bytes.push(Number(part));
	}
	return bytes;
}

/** Eight 16-bit words and the zone id, or null. */
function parseIPv6(input) {
	let text = input;
	let zone = null;
	const percent = text.indexOf("%");
	if (percent !== -1) {
		zone = text.slice(percent + 1);
		if (!/^[0-9a-zA-Z\-.:]+$/.test(zone)) return null;
		text = text.slice(0, percent);
	}
	if (!/^[0-9a-fA-F:.]+$/.test(text) || text.includes(":::")) return null;
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const side = (part) => {
		if (part === "") return [];
		const words = [];
		const pieces = part.split(":");
		for (let i = 0; i < pieces.length; i++) {
			const piece = pieces[i];
			if (piece.includes(".")) {
				const v4 = parseIPv4(piece);
				if (!v4 || i !== pieces.length - 1) return null;
				words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
			} else {
				if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
				words.push(parseInt(piece, 16));
			}
		}
		return words;
	};
	const head = side(halves[0]);
	const tail = halves.length === 2 ? side(halves[1]) : [];
	if (!head || !tail) return null;
	if (halves.length === 1) return head.length === 8 ? { words: head, zone } : null;
	if (head.length + tail.length > 7) return null;
	return { words: [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail], zone };
}

/** inet_ntop for IPv6, as libuv and c-ares print it. */
function formatIPv6(words) {
	let best = { base: -1, len: 0 };
	let cur = { base: -1, len: 0 };
	for (let i = 0; i < 8; i++) {
		if (words[i] === 0) {
			if (cur.base === -1) cur = { base: i, len: 1 };
			else cur.len++;
		} else if (cur.base !== -1) {
			if (best.base === -1 || cur.len > best.len) best = cur;
			cur = { base: -1, len: 0 };
		}
	}
	if (cur.base !== -1 && (best.base === -1 || cur.len > best.len)) best = cur;
	if (best.base !== -1 && best.len < 2) best = { base: -1, len: 0 };
	let out = "";
	for (let i = 0; i < 8; i++) {
		if (best.base !== -1 && i >= best.base && i < best.base + best.len) {
			if (i === best.base) out += ":";
			continue;
		}
		if (i !== 0) out += ":";
		if (
			i === 6 &&
			best.base === 0 &&
			(best.len === 6 || (best.len === 7 && words[7] !== 1) || (best.len === 5 && words[5] === 0xffff))
		) {
			out += `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
			break;
		}
		out += words[i].toString(16);
	}
	if (best.base !== -1 && best.base + best.len === 8) out += ":";
	return out;
}

/** {family, text, zone, bytes} for an address literal, or null. */
function parseIP(text) {
	if (typeof text !== "string") return null;
	const v4 = parseIPv4(text);
	if (v4) return { family: 4, text, zone: null, bytes: v4 };
	const v6 = parseIPv6(text);
	if (!v6) return null;
	const bytes = v6.words.flatMap((w) => [w >> 8, w & 255]);
	return { family: 6, text: formatIPv6(v6.words), zone: v6.zone, bytes, words: v6.words };
}

const isIP = (text) => parseIP(text)?.family ?? 0;

function reverseName(ip) {
	if (ip.family === 4) return `${[...ip.bytes].reverse().join(".")}.in-addr.arpa`;
	const nibbles = ip.bytes.flatMap((b) => [b >> 4, b & 15]).reverse();
	return `${nibbles.map((n) => n.toString(16)).join(".")}.ip6.arpa`;
}

/* ------------------------------------------------------------------------------------------ the wire format */

const latin1 = (bytes, start, end) => {
	let out = "";
	for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
	return out;
};

/** Labels of a query name as byte arrays, or null when the name is not one c-ares would send (EBADNAME). */
function nameToLabels(name, toASCII) {
	let text = name;
	// Node lowercases the name and converts a non-ASCII one to punycode before it reaches the resolver.
	if (/[^\x00-\x7f]/.test(text) && toASCII) {
		try {
			text = toASCII(text.normalize("NFC").toLowerCase());
		} catch {
			return null;
		}
	} else {
		text = text.toLowerCase();
	}
	if (text.length > 255) return null;
	if (text === "" || text === ".") return [];
	const labels = [];
	let current = [];
	let pieces = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 0x5c) {
			const digits = /^\d{3}/.exec(text.slice(i + 1));
			if (digits) {
				const value = Number(digits[0]);
				if (value > 255) return null;
				current.push(value);
				i += 3;
			} else if (i + 1 < text.length) {
				current.push(text.charCodeAt(++i) & 255);
			} else {
				return null;
			}
			pieces++;
		} else if (ch === 0x2e) {
			if (current.length === 0 && pieces === 0) return null;
			labels.push(current);
			current = [];
			pieces = 0;
		} else if (ch <= 0x20 || ch >= 0x7f) {
			return null;
		} else {
			current.push(ch);
			pieces++;
		}
	}
	if (current.length || pieces) labels.push(current);
	for (const label of labels) if (label.length === 0 || label.length > 63) return null;
	return labels;
}

function buildQuery(id, labels, type) {
	const out = [id >> 8, id & 255, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
	for (const label of labels) out.push(label.length, ...label);
	out.push(0, type >> 8, type & 255, 0, 1);
	return Uint8Array.from(out);
}

class BadResponse extends Error {}

const presentByte = (b) =>
	b < 0x20 || b >= 0x7f
		? `\\${String(b).padStart(3, "0")}`
		: '".;\\()@$'.includes(String.fromCharCode(b))
			? `\\${String.fromCharCode(b)}`
			: String.fromCharCode(b);

/** An RFC 1035 name at `pos`, in presentation form (labels joined by dots, special bytes escaped). */
function readName(bytes, pos) {
	let out = "";
	let cursor = pos;
	let end = -1;
	let total = 0;
	for (let guard = 0; guard < 128; guard++) {
		if (cursor >= bytes.length) throw new BadResponse("name runs off the message");
		const len = bytes[cursor];
		if ((len & 0xc0) === 0xc0) {
			if (cursor + 1 >= bytes.length) throw new BadResponse("cut pointer");
			const target = ((len & 0x3f) << 8) | bytes[cursor + 1];
			if (end === -1) end = cursor + 2;
			// Pointers only ever point backwards; one that does not is a loop.
			if (target >= cursor) throw new BadResponse("bad compression pointer");
			cursor = target;
			continue;
		}
		if (len & 0xc0) throw new BadResponse("bad label");
		if (len === 0) {
			return [out, end === -1 ? cursor + 1 : end];
		}
		if (cursor + 1 + len > bytes.length) throw new BadResponse("label runs off the message");
		total += len + 1;
		if (total > 255) throw new BadResponse("name too long");
		if (out) out += ".";
		for (let i = cursor + 1; i <= cursor + len; i++) out += presentByte(bytes[i]);
		cursor += 1 + len;
	}
	throw new BadResponse("too many compression jumps");
}

/** Header, question and the three record sections of a message; throws BadResponse when it is malformed. */
function parseMessage(bytes) {
	if (bytes.length < 12) throw new BadResponse("short message");
	const u16 = (at) => (bytes[at] << 8) | bytes[at + 1];
	const message = {
		id: u16(0),
		flags: u16(2),
		rcode: bytes[3] & 15,
		tc: (bytes[2] & 2) !== 0,
		questions: [],
		answers: [],
		bytes,
	};
	const counts = [u16(4), u16(6), u16(8), u16(10)];
	let pos = 12;
	for (let i = 0; i < counts[0]; i++) {
		const [name, next] = readName(bytes, pos);
		if (next + 4 > bytes.length) throw new BadResponse("cut question");
		message.questions.push({ name, type: u16(next), class: u16(next + 2) });
		pos = next + 4;
	}
	const sections = [message.answers, [], []];
	for (let s = 0; s < 3; s++) {
		for (let i = 0; i < counts[s + 1]; i++) {
			const [name, next] = readName(bytes, pos);
			if (next + 10 > bytes.length) throw new BadResponse("cut record");
			const length = u16(next + 8);
			const start = next + 10;
			if (start + length > bytes.length) throw new BadResponse("cut record data");
			sections[s].push({
				name,
				type: u16(next),
				class: u16(next + 2),
				ttl: ((bytes[next + 4] << 24) | (bytes[next + 5] << 16) | (bytes[next + 6] << 8) | bytes[next + 7]) >>> 0,
				start,
				end: start + length,
			});
			pos = start + length;
		}
	}
	return message;
}

/* ------------------------------------------------------------------------------------------ record shapes */

function createRecordReaders() {
	const u16 = (b, at) => (b[at] << 8) | b[at + 1];
	const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
	/** One length-prefixed character string; c-ares hands the bytes over and Node reads each as a Latin-1 character. */
	const charString = (b, at, end) => {
		if (at >= end || at + 1 + b[at] > end) throw new BadResponse("cut string");
		return [latin1(b, at + 1, at + 1 + b[at]), at + 1 + b[at]];
	};
	const readers = {
		address(m, r, family) {
			const b = m.bytes;
			if (family === 4) {
				if (r.end - r.start !== 4) throw new BadResponse("bad A");
				return `${b[r.start]}.${b[r.start + 1]}.${b[r.start + 2]}.${b[r.start + 3]}`;
			}
			if (r.end - r.start !== 16) throw new BadResponse("bad AAAA");
			const words = [];
			for (let i = 0; i < 8; i++) words.push(u16(b, r.start + i * 2));
			return formatIPv6(words);
		},
		name: (m, r) => readName(m.bytes, r.start)[0],
		mx(m, r) {
			if (r.end - r.start < 3) throw new BadResponse("bad MX");
			return { exchange: readName(m.bytes, r.start + 2)[0], priority: u16(m.bytes, r.start), type: "MX" };
		},
		txt(m, r) {
			const chunks = [];
			let at = r.start;
			while (at < r.end) {
				const [text, next] = charString(m.bytes, at, r.end);
				chunks.push(text);
				at = next;
			}
			return chunks;
		},
		srv(m, r) {
			if (r.end - r.start < 7) throw new BadResponse("bad SRV");
			const b = m.bytes;
			return {
				name: readName(b, r.start + 6)[0],
				port: u16(b, r.start + 4),
				priority: u16(b, r.start),
				weight: u16(b, r.start + 2),
				type: "SRV",
			};
		},
		soa(m, r) {
			const [nsname, at] = readName(m.bytes, r.start);
			const [hostmaster, next] = readName(m.bytes, at);
			if (next + 20 > r.end) throw new BadResponse("bad SOA");
			const b = m.bytes;
			return {
				nsname,
				hostmaster,
				serial: u32(b, next),
				refresh: u32(b, next + 4),
				retry: u32(b, next + 8),
				expire: u32(b, next + 12),
				minttl: u32(b, next + 16),
				type: undefined,
			};
		},
		naptr(m, r) {
			if (r.end - r.start < 4) throw new BadResponse("bad NAPTR");
			const b = m.bytes;
			let at = r.start + 4;
			const [flags, a] = charString(b, at, r.end);
			const [service, c] = charString(b, a, r.end);
			const [regexp, d] = charString(b, c, r.end);
			at = d;
			return {
				flags,
				service,
				regexp,
				replacement: readName(b, at)[0],
				order: u16(b, r.start),
				preference: u16(b, r.start + 2),
				type: undefined,
			};
		},
		caa(m, r) {
			const b = m.bytes;
			if (r.end - r.start < 2 || r.start + 2 + b[r.start + 1] > r.end) throw new BadResponse("bad CAA");
			const tagEnd = r.start + 2 + b[r.start + 1];
			const out = { critical: b[r.start], type: "CAA" };
			out[latin1(b, r.start + 2, tagEnd)] = latin1(b, tagEnd, r.end);
			return out;
		},
		tlsa(m, r) {
			if (r.end - r.start < 3) throw new BadResponse("bad TLSA");
			const b = m.bytes;
			const data = new Uint8Array(b.subarray(r.start + 3, r.end)).buffer;
			return { certUsage: b[r.start], selector: b[r.start + 1], match: b[r.start + 2], data };
		},
	};
	return readers;
}

const readers = createRecordReaders();
const ofType = (message, type) => message.answers.filter((r) => r.type === type);

/**
 * A and AAAA records, following the CNAME chain from the queried name as c-ares does. Their TTL is the smallest one
 * on the way there, the aliases' included.
 */
function addressRecords(message, qname, type) {
	const all = ofType(message, type);
	const cnames = ofType(message, TYPES.CNAME);
	if (cnames.length === 0) return all.map((record) => ({ record, ttl: record.ttl }));
	let owner = qname.toLowerCase();
	let ttl = 0xffffffff;
	for (let hops = 0; hops < 16; hops++) {
		const next = cnames.find((r) => r.name.toLowerCase() === owner);
		if (!next) break;
		ttl = Math.min(ttl, next.ttl);
		owner = readName(message.bytes, next.start)[0].toLowerCase();
	}
	return all
		.filter((r) => r.name.toLowerCase() === owner)
		.map((record) => ({ record, ttl: Math.min(ttl, record.ttl) }));
}

/**
 * What each query method returns for a parsed answer. `empty` says what it means when records are there but none
 * of the asked type: most types then answer an empty list, the ones listed as "error" report ENODATA (or EBADRESP for
 * SOA), which is what Node does.
 */
function shapeFor(method) {
	const list = (type, read, empty) => ({
		type,
		empty,
		build: (m) => ofType(m, type).map((r) => read(m, r)),
	});
	switch (method) {
		case "resolve4":
		case "resolve6": {
			const family = method === "resolve4" ? 4 : 6;
			const type = family === 4 ? TYPES.A : TYPES.AAAA;
			return {
				type,
				empty: "error",
				build: (m, qname, options) =>
					addressRecords(m, qname, type).map(({ record, ttl }) => {
						const address = readers.address(m, record, family);
						return options.ttl ? { address, ttl } : address;
					}),
			};
		}
		case "resolveCname":
			return list(TYPES.CNAME, readers.name, "error");
		case "resolveNs":
			return list(TYPES.NS, readers.name, "error");
		case "resolvePtr":
			return list(TYPES.PTR, readers.name, "error");
		case "resolveMx":
			return list(TYPES.MX, readers.mx, "list");
		case "resolveTxt":
			return list(TYPES.TXT, readers.txt, "list");
		case "resolveSrv":
			return list(TYPES.SRV, readers.srv, "list");
		case "resolveNaptr":
			return list(TYPES.NAPTR, readers.naptr, "list");
		case "resolveCaa":
			return list(TYPES.CAA, readers.caa, "list");
		case "resolveTlsa":
			return list(TYPES.TLSA, readers.tlsa, "list");
		case "resolveSoa":
			return {
				type: TYPES.SOA,
				empty: "badresp",
				build: (m) => ofType(m, TYPES.SOA).map((r) => readers.soa(m, r)),
				single: true,
			};
		case "resolveAny":
			return {
				type: 255,
				empty: "list",
				build(m) {
					const out = [];
					const add = (type, read, tag) => {
						for (const r of ofType(m, type)) out.push({ ...tag(read(m, r), r), type: TYPE_LABELS[type] });
					};
					const keep = (value) => (typeof value === "object" && !Array.isArray(value) ? value : null);
					add(TYPES.CNAME, readers.name, (v) => ({ value: v }));
					add(
						TYPES.A,
						(mm, r) => readers.address(mm, r, 4),
						(v, r) => ({ address: v, ttl: r.ttl })
					);
					add(
						TYPES.AAAA,
						(mm, r) => readers.address(mm, r, 6),
						(v, r) => ({ address: v, ttl: r.ttl })
					);
					add(TYPES.MX, readers.mx, (v) => keep(v));
					add(TYPES.NS, readers.name, (v) => ({ value: v }));
					add(TYPES.TXT, readers.txt, (v) => ({ entries: v }));
					add(TYPES.SRV, readers.srv, (v) => keep(v));
					add(TYPES.PTR, readers.name, (v) => ({ value: v }));
					add(TYPES.NAPTR, readers.naptr, (v) => keep(v));
					add(TYPES.SOA, readers.soa, (v) => keep(v));
					add(TYPES.CAA, readers.caa, (v) => keep(v));
					return out;
				},
			};
		default:
			throw new Error(`no shape for ${method}`);
	}
}

const TYPE_LABELS = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));

/** Turns a parsed answer into the value a method reports, or into an error code. */
function answerFor(method, message, qname, options) {
	if (message.rcode !== 0) return { code: RCODE_ERRORS[message.rcode] ?? "ESERVFAIL" };
	if (message.answers.length === 0) return { code: "ENODATA" };
	const shape = shapeFor(method);
	let built;
	try {
		built = shape.build(message, qname, options);
	} catch (err) {
		if (err instanceof BadResponse) return { code: "EBADRESP" };
		throw err;
	}
	if (built.length === 0) {
		if (shape.empty === "error") return { code: "ENODATA" };
		if (shape.empty === "badresp") return { code: "EBADRESP" };
	}
	return { value: shape.single ? built[0] : built };
}

/* ------------------------------------------------------------------------------------------ system settings */

function parseResolvConf(text) {
	const servers = [];
	let timeout;
	let tries;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/[#;].*$/, "").trim();
		const nameserver = /^nameserver\s+(\S+)/.exec(line);
		if (nameserver) {
			servers.push(nameserver[1]);
			continue;
		}
		if (/^options\s/.test(line)) {
			for (const option of line.split(/\s+/).slice(1)) {
				const t = /^timeout:(\d+)$/.exec(option);
				const a = /^attempts:(\d+)$/.exec(option);
				if (t) timeout = Number(t[1]) * 1000;
				if (a && Number(a[1]) > 0) tries = Number(a[1]);
			}
		}
	}
	return { servers, timeout, tries };
}

const ADDRESS_ONLY = /^\s*(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]*:[0-9a-fA-F:.]*)(?:%[0-9A-Za-z._-]+)?\s*$/;

/**
 * The DNS servers in the text of `ipconfig /all`, whatever language it is in. The header of the list ("DNS Servers",
 * "DNS-Server", "Serveurs DNS", "DNS 服务器") always carries the letters DNS and is followed, on the same line, by the
 * first address; further servers are lines that hold nothing but an address. The "DNS Suffix" lines carry a name, not
 * an address, and so end a list rather than start one. Windows also lists the placeholder site-local servers
 * fec0:0:0:ffff::1, ::2 and ::3 for adapters that have no IPv6 DNS; nothing answers there, so they are dropped.
 */
function parseIpconfig(text) {
	const servers = [];
	let inList = false;
	const take = (value) => {
		const address = value.trim();
		if (!ADDRESS_ONLY.test(address)) return false;
		const parsed = parseIP(address);
		if (!parsed) return false;
		if (parsed.family === 6 && /^fec0:0?:0?:ffff:/i.test(parsed.text)) return true;
		const shown = parsed.zone && !/^fe80:/i.test(parsed.text) ? parsed.text : address;
		if (!servers.includes(shown)) servers.push(shown);
		return true;
	};
	for (const raw of text.split(/\r?\n/)) {
		if (!raw.trim()) {
			inList = false;
			continue;
		}
		const header = /^\s*(.*?)[ .]*:(?:\s+(.*))?$/.exec(raw);
		const indented = /^\s/.test(raw);
		if (header && indented && !ADDRESS_ONLY.test(raw)) {
			inList = /dns/i.test(header[1]) && take(header[2] ?? "");
			continue;
		}
		if (inList && indented && ADDRESS_ONLY.test(raw)) {
			take(raw);
			continue;
		}
		inList = false;
	}
	// Servers with a zone id come last: they need the interface, and the plain ones almost always work.
	return [...servers.filter((s) => !s.includes("%")), ...servers.filter((s) => s.includes("%"))];
}

/** The server named in the output of `nslookup` (its "Default Server" block), in any language. */
function parseNslookup(text) {
	const servers = [];
	for (const raw of text.split(/\r?\n/)) {
		if (raw.trimStart().startsWith("***")) continue;
		for (const token of raw.split(/[\s,]+/)) {
			const parsed = parseIP(token);
			if (parsed && !servers.includes(parsed.text)) servers.push(parsed.text);
		}
	}
	return servers.slice(0, 2);
}

function parseHosts(text) {
	const entries = [];
	for (const raw of text.split(/\r?\n/)) {
		const parts = raw.replace(/#.*$/, "").trim().split(/\s+/);
		if (parts.length < 2) continue;
		const ip = parseIP(parts[0]);
		if (ip) entries.push({ ip, names: parts.slice(1) });
	}
	return entries;
}

// Names from the IANA registry that a services file usually has, for machines that have none (Windows before Vista's
// full file, containers). The first name of a port is what getnameinfo reports.
const WELL_KNOWN_SERVICES = {
	7: "echo",
	9: "discard",
	13: "daytime",
	19: "chargen",
	20: "ftp-data",
	21: "ftp",
	22: "ssh",
	23: "telnet",
	25: "smtp",
	37: "time",
	43: "whois",
	53: "domain",
	67: "bootps",
	68: "bootpc",
	69: "tftp",
	70: "gopher",
	79: "finger",
	80: "http",
	88: "kerberos",
	110: "pop3",
	111: "sunrpc",
	113: "auth",
	119: "nntp",
	123: "ntp",
	135: "epmap",
	137: "netbios-ns",
	138: "netbios-dgm",
	139: "netbios-ssn",
	143: "imap",
	161: "snmp",
	162: "snmptrap",
	179: "bgp",
	194: "irc",
	389: "ldap",
	443: "https",
	445: "microsoft-ds",
	465: "submissions",
	500: "isakmp",
	514: "shell",
	515: "printer",
	543: "klogin",
	544: "kshell",
	546: "dhcpv6-client",
	547: "dhcpv6-server",
	587: "submission",
	631: "ipp",
	636: "ldaps",
	873: "rsync",
	993: "imaps",
	995: "pop3s",
	1080: "socks",
	1433: "ms-sql-s",
	1521: "ncube-lm",
	2049: "nfs",
	3128: "ndl-aas",
	3306: "mysql",
	3389: "ms-wbt-server",
	5060: "sip",
	5432: "postgresql",
	5900: "rfb",
	6379: "redis",
	8080: "http-alt",
};

function parseServices(text) {
	const byPort = new Map();
	for (const raw of text.split(/\r?\n/)) {
		const match = /^\s*([^\s#]+)\s+(\d+)\/tcp\b/.exec(raw);
		if (match && !byPort.has(Number(match[2]))) byPort.set(Number(match[2]), match[1]);
	}
	return byPort;
}

/* ------------------------------------------------------------------------------------------ the resolver core */

/** A server as the resolver uses it. `host` is what a socket is given (with a zone id when there is one). */
function makeServer(ip, port) {
	const parsed = parseIP(ip);
	return {
		ip: parsed.text,
		port,
		family: parsed.family,
		host: parsed.zone ? `${parsed.text}%${parsed.zone}` : parsed.text,
	};
}

const serverKey = (server) => `${server.ip}:${server.port}`;

function createCore(env) {
	const { dgram, net, Buffer, nextTick, toASCII } = env;

	class Channel {
		constructor(options, defaults) {
			this.options = options;
			this.defaults = defaults;
			this._servers = null;
			this.pending = new Set();
			this.byId = new Map();
			this.sockets = new Map();
			this.failures = new Map();
			this.local4 = null;
			this.local6 = null;
		}
		get timeout() {
			return this.options.timeout >= 0 ? this.options.timeout : (this.defaults().timeout ?? DEFAULT_TIMEOUT);
		}
		get tries() {
			return this.options.tries ?? this.defaults().tries ?? DEFAULT_TRIES;
		}
		get servers() {
			return this._servers ?? this.defaults().servers;
		}
		setServers(servers) {
			this._servers = servers;
		}

		/** Sends one question; `done(code, message)` gets a code (an E... string) or the parsed response. */
		query(name, type, done) {
			const labels = nameToLabels(name, toASCII);
			if (!labels) {
				nextTick(() => done("EBADNAME"));
				return { cancel() {} };
			}
			let id;
			do id = Math.floor(Math.random() * 65536);
			while (this.byId.has(id));
			const q = {
				id,
				packet: buildQuery(id, labels, type),
				question: { text: labels.map((l) => l.map(presentByte).join("")).join("."), type },
				attempt: 0,
				sentTo: new Set(),
				families: new Set(),
				timer: null,
				tcp: null,
				server: null,
				lastError: null,
				done,
				finished: false,
			};
			this.pending.add(q);
			this.byId.set(id, q);
			nextTick(() => this._attempt(q));
			return q;
		}

		cancel() {
			for (const q of [...this.pending]) nextTick(() => this._finish(q, "ECANCELLED"));
		}

		_pick(servers) {
			let best = 0;
			for (let i = 1; i < servers.length; i++) {
				if ((this.failures.get(serverKey(servers[i])) ?? 0) < (this.failures.get(serverKey(servers[best])) ?? 0))
					best = i;
			}
			return servers[best];
		}

		_fail(server) {
			this.failures.set(serverKey(server), (this.failures.get(serverKey(server)) ?? 0) + 1);
		}

		_attempt(q) {
			if (q.finished) return;
			const servers = this.servers;
			if (servers.length === 0) return this._finish(q, "UNKNOWN_ARES_ERROR");
			if (q.attempt >= this.tries * servers.length) return this._finish(q, q.lastError ?? "ETIMEOUT");
			const server = this._pick(servers);
			const round = Math.floor(q.attempt / servers.length);
			let wait = this.timeout * 2 ** Math.min(round, 30);
			if (this.options.maxTimeout > 0) wait = Math.min(wait, this.options.maxTimeout);
			q.server = server;
			q.mode = "udp";
			clearTimeout(q.timer);
			q.timer = setTimeout(() => this._timedOut(q, server), wait);
			const rec = this._socket(server.family);
			if (!rec) return this._connectionFailed(q, server);
			q.families.add(server.family);
			q.sentTo.add(serverKey(server));
			try {
				rec.sock.send(Buffer.from(q.packet), server.port, server.host, (err) => {
					if (err && !q.finished && q.server === server && q.mode === "udp") this._connectionFailed(q, server);
				});
			} catch {
				this._connectionFailed(q, server);
			}
		}

		_timedOut(q, server) {
			if (q.finished) return;
			this._fail(server);
			q.lastError = "ETIMEOUT";
			this._closeTcp(q);
			q.attempt++;
			this._attempt(q);
		}

		_connectionFailed(q, server) {
			if (q.finished) return;
			clearTimeout(q.timer);
			this._fail(server);
			q.lastError = "ECONNREFUSED";
			this._closeTcp(q);
			q.attempt++;
			nextTick(() => this._attempt(q));
		}

		/** The datagram socket for a family, created on first use and closed once no query needs it. */
		_socket(family) {
			let rec = this.sockets.get(family);
			if (!rec) {
				const sock = dgram.createSocket(family === 6 ? "udp6" : "udp4");
				rec = { sock, refs: 0, family };
				sock.on("error", () => this._socketFailed(rec));
				sock.on("message", (msg, rinfo) => this._datagram(msg, rinfo));
				const local = family === 6 ? this.local6 : this.local4;
				try {
					sock.bind(0, local ?? (family === 6 ? "::" : "0.0.0.0"));
					sock.address();
				} catch {
					try {
						sock.close();
					} catch {
						// Never opened.
					}
					return null;
				}
				this.sockets.set(family, rec);
			}
			return rec;
		}

		_socketFailed(rec) {
			if (this.sockets.get(rec.family) !== rec) return;
			this.sockets.delete(rec.family);
			try {
				rec.sock.close();
			} catch {
				// Already closed.
			}
			for (const q of [...this.pending]) {
				if (q.mode === "udp" && q.server?.family === rec.family) this._connectionFailed(q, q.server);
			}
		}

		_release(q) {
			for (const family of q.families) {
				const rec = this.sockets.get(family);
				if (!rec) continue;
				if (![...this.pending].some((other) => other !== q && other.families.has(family))) {
					this.sockets.delete(family);
					try {
						rec.sock.close();
					} catch {
						// Already closed.
					}
				}
			}
			q.families.clear();
		}

		_datagram(msg, rinfo) {
			if (msg.length < 2) return;
			const q = this.byId.get((msg[0] << 8) | msg[1]);
			if (!q || q.finished || q.mode !== "udp") return;
			const from = parseIP(String(rinfo.address).replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1"));
			if (!from || !q.sentTo.has(`${from.text}:${rinfo.port}`)) return;
			const server = this.servers.find((s) => s.ip === from.text && s.port === rinfo.port) ?? q.server;
			this._response(q, msg, server, false);
		}

		_response(q, bytes, server, overTcp) {
			let message;
			try {
				message = parseMessage(bytes);
				if (message.questions.length === 0) throw new BadResponse("no question");
			} catch (err) {
				if (err instanceof BadResponse) return this._finish(q, "EBADRESP");
				throw err;
			}
			// A reply to some other question (a stale or forged one) is not an answer to this query.
			const asked = message.questions[0];
			if (asked.type !== q.question.type || asked.class !== 1) return;
			if (asked.name.toLowerCase() !== q.question.text.toLowerCase()) return;
			this.failures.set(serverKey(server), 0);
			if (message.tc && !overTcp) return this._startTcp(q, server);
			this._finish(q, null, message);
		}

		_startTcp(q, server) {
			this._closeTcp(q);
			q.mode = "tcp";
			let chunks = Buffer.alloc(0);
			let socket;
			try {
				const options = { host: server.host, port: server.port };
				const local = server.family === 6 ? this.local6 : this.local4;
				if (local) options.localAddress = local;
				socket = net.connect(options);
			} catch {
				return this._connectionFailed(q, server);
			}
			q.tcp = socket;
			const failed = () => {
				if (q.tcp === socket && !q.finished) this._connectionFailed(q, server);
			};
			socket.on("connect", () => {
				const frame = Buffer.alloc(2 + q.packet.length);
				frame.writeUInt16BE(q.packet.length, 0);
				frame.set(q.packet, 2);
				socket.write(frame);
			});
			socket.on("data", (chunk) => {
				if (q.tcp !== socket || q.finished) return;
				chunks = Buffer.concat([chunks, chunk]);
				while (chunks.length >= 2 && chunks.length >= 2 + chunks.readUInt16BE(0)) {
					const length = chunks.readUInt16BE(0);
					const body = new Uint8Array(chunks.subarray(2, 2 + length));
					chunks = chunks.subarray(2 + length);
					if (body.length >= 2 && ((body[0] << 8) | body[1]) === q.id) return this._response(q, body, server, true);
				}
			});
			socket.on("error", failed);
			socket.on("close", failed);
		}

		_closeTcp(q) {
			const socket = q.tcp;
			q.tcp = null;
			if (socket) {
				try {
					socket.destroy();
				} catch {
					// Already gone.
				}
			}
		}

		_finish(q, code, message) {
			if (q.finished) return;
			q.finished = true;
			clearTimeout(q.timer);
			this._closeTcp(q);
			this.pending.delete(q);
			this.byId.delete(q.id);
			this._release(q);
			q.done(code, message);
		}
	}

	return { Channel };
}

/* ------------------------------------------------------------------------------------------ the module */

function createDns(env) {
	const { fs, platform, exec, inspect } = env;
	const environment = env.env ?? {};
	const nextTick = env.nextTick ?? ((fn) => queueMicrotask(fn));
	const checks = makeChecks(inspect ?? ((v) => JSON.stringify(v)));
	const { Channel } = createCore({ ...env, nextTick });
	const isWindows = platform === "win32";

	/* ---- what the machine is configured with, read once */

	let systemCache = null;
	const system = () => {
		if (systemCache) return systemCache;
		let addresses = [];
		let timeout;
		let tries;
		if (isWindows) {
			addresses = windowsServers();
		} else {
			try {
				const parsed = parseResolvConf(String(fs.readFileSync("/etc/resolv.conf", "utf8")));
				addresses = parsed.servers;
				timeout = parsed.timeout;
				tries = parsed.tries;
			} catch {
				// No resolv.conf: the resolver's own default, the local machine, as c-ares has it.
			}
			if (addresses.length === 0) addresses = ["127.0.0.1"];
		}
		const servers = [];
		for (const address of addresses) {
			if (parseIP(address)) servers.push(makeServer(address, 53));
		}
		systemCache = { servers: dedupe(servers), timeout, tries };
		return systemCache;
	};

	function windowsServers() {
		const run = (file, args, input) => {
			try {
				const out = exec?.(file, args, input);
				return out == null ? "" : String(out);
			} catch {
				return "";
			}
		};
		let found = parseIpconfig(run("ipconfig", ["/all"]));
		if (found.length === 0) found = parseNslookup(run("nslookup", [], "exit\r\n"));
		// Nothing found: the local machine, which is c-ares' own default as well.
		return found.length ? found : ["127.0.0.1"];
	}

	const dedupe = (servers) => {
		const seen = new Set();
		return servers.filter((s) => !seen.has(serverKey(s)) && seen.add(serverKey(s)));
	};

	const etcFile = (name) => {
		if (!isWindows) return `/etc/${name}`;
		return `${environment.SystemRoot ?? environment.windir ?? "C:\\Windows"}\\System32\\drivers\\etc\\${name}`;
	};
	const readEtc = (name) => {
		try {
			return String(fs.readFileSync(etcFile(name), "latin1"));
		} catch {
			return "";
		}
	};
	const hostEntries = () => parseHosts(readEtc("hosts"));

	let servicesCache = null;
	const serviceName = (port) => {
		servicesCache ??= parseServices(readEtc("services"));
		return servicesCache.get(port) ?? WELL_KNOWN_SERVICES[port] ?? String(port);
	};

	/* ---- servers */

	function parseServerList(servers) {
		if (!Array.isArray(servers)) throw checks.typeError("servers", "an instance of Array", servers);
		const parsed = [];
		servers.forEach((serv, index) => {
			checks.string(serv, `servers[${index}]`);
			const literal = parseIP(serv);
			if (literal) return parsed.push({ ip: literal, port: 53 });
			const bracket = /^\[([^[\]]*)\]/.exec(serv);
			if (bracket) {
				const ip = parseIP(bracket[1]);
				if (ip && ip.family === 6) {
					const port = parseInt(serv.replace(/(^.+?)(?::(\d+))?$/, "$2"), 10) || 53;
					return parsed.push({ ip, port });
				}
			}
			const split = /(^.+?)(?::(\d+))?$/.exec(serv);
			if (split) {
				const ip = parseIP(split[1]);
				if (ip) return parsed.push({ ip, port: parseInt(split[2] || "53", 10) });
			}
			throw nodeError(TypeError, "ERR_INVALID_IP_ADDRESS", `Invalid IP address: ${serv}`);
		});
		for (const { port } of parsed) checks.port(port);
		return dedupe(
			parsed.map(({ ip, port }) => makeServer(ip.zone ? `${ip.text}%${ip.zone}` : ip.text, port === 0 ? 53 : port))
		);
	}

	const showServer = (s) => (s.port === 53 ? s.ip : s.family === 6 ? `[${s.ip}]:${s.port}` : `${s.ip}:${s.port}`);

	let resultOrder = "verbatim";
	const setResultOrder = (order) => {
		checks.oneOf(order, "dnsOrder", RESULT_ORDERS);
		resultOrder = order;
	};

	/* ---- the resolvers */

	const QUERY_METHODS = [
		["resolveAny", "queryAny"],
		["resolve4", "queryA"],
		["resolve6", "queryAaaa"],
		["resolveCaa", "queryCaa"],
		["resolveCname", "queryCname"],
		["resolveMx", "queryMx"],
		["resolveNs", "queryNs"],
		["resolveTlsa", "queryTlsa"],
		["resolveTxt", "queryTxt"],
		["resolveSrv", "querySrv"],
		["resolvePtr", "queryPtr"],
		["resolveNaptr", "queryNaptr"],
		["resolveSoa", "querySoa"],
	];
	const RRTYPES = {
		A: "resolve4",
		AAAA: "resolve6",
		ANY: "resolveAny",
		CAA: "resolveCaa",
		CNAME: "resolveCname",
		MX: "resolveMx",
		NAPTR: "resolveNaptr",
		NS: "resolveNs",
		PTR: "resolvePtr",
		SOA: "resolveSoa",
		SRV: "resolveSrv",
		TLSA: "resolveTlsa",
		TXT: "resolveTxt",
	};

	/** Runs one lookup on a channel and reports (error, value) the way the callback API does. */
	function runQuery(channel, method, binding, name, options, callback) {
		const shape = shapeFor(method);
		channel.query(name, shape.type, (code, message) => {
			if (code) return callback(dnsError(code, binding, name));
			const answer = answerFor(method, message, name, options);
			if (answer.code) return callback(dnsError(answer.code, binding, name));
			callback(null, answer.value);
		});
	}

	function reverseLookup(channel, ip, callback) {
		const parsed = parseIP(ip);
		if (!parsed) throw dnsError("EINVAL", "getHostByAddr", ip, isWindows ? -4071 : -22);
		const fromHosts = () => {
			// c-ares reads the hosts file when the name servers have nothing; what it hands back is the aliases.
			for (const entry of hostEntries()) {
				if (entry.ip.family === parsed.family && entry.ip.text === parsed.text) return entry.names.slice(1);
			}
			return null;
		};
		channel.query(reverseName(parsed), TYPES.PTR, (code, message) => {
			if (!code && message.rcode === 0) {
				const names = ofType(message, TYPES.PTR);
				if (names.length) {
					try {
						return callback(
							null,
							names.map((r) => readName(message.bytes, r.start)[0])
						);
					} catch (err) {
						if (!(err instanceof BadResponse)) throw err;
						return callback(dnsError("EBADRESP", "getHostByAddr", ip));
					}
				}
			}
			const hosts = fromHosts();
			if (hosts) return callback(null, hosts);
			const reported =
				code ??
				(message.rcode !== 0 && message.rcode !== 3 ? (RCODE_ERRORS[message.rcode] ?? "ESERVFAIL") : "ENOTFOUND");
			callback(dnsError(reported, "getHostByAddr", ip));
		});
	}

	function makeResolverClass(promiseStyle) {
		const kChannel = Symbol("channel");
		class Resolver {
			constructor(options) {
				const opts = {};
				if (typeof options === "object" && options !== null) {
					if (options.timeout !== undefined) {
						checks.integer(options.timeout, "options.timeout", -1, 2 ** 31 - 1);
						opts.timeout = options.timeout;
					}
					if (options.tries !== undefined) {
						checks.integer(options.tries, "options.tries", 1, 2 ** 31 - 1);
						opts.tries = options.tries;
					}
					if (options.maxTimeout !== undefined) {
						checks.integer(options.maxTimeout, "options.maxTimeout", 0, 2 ** 32 - 1);
						opts.maxTimeout = options.maxTimeout;
					}
				}
				Object.defineProperty(this, kChannel, { value: new Channel(opts, system) });
			}
			cancel() {
				this[kChannel].cancel();
			}
			getServers() {
				return this[kChannel].servers.map(showServer);
			}
			setServers(servers) {
				this[kChannel].setServers(parseServerList(servers));
			}
			setLocalAddress(ipv4, ipv6) {
				checks.string(ipv4, "ipv4");
				if (ipv6 !== undefined) checks.string(ipv6, "ipv6");
				const invalid = () => nodeError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid IP address.");
				const first = parseIP(ipv4);
				if (!first) throw invalid();
				const second = ipv6 === undefined ? null : parseIP(ipv6);
				if (ipv6 !== undefined && !second) throw invalid();
				if (second && second.family === first.family) {
					throw nodeError(TypeError, "ERR_INVALID_ARG_VALUE", `Cannot specify two IPv${first.family} addresses.`);
				}
				const channel = this[kChannel];
				for (const ip of [first, second]) {
					if (ip?.family === 4) channel.local4 = ip.text;
					if (ip?.family === 6) channel.local6 = ip.zone ? `${ip.text}%${ip.zone}` : ip.text;
				}
				// Sockets open for queries in flight keep the address they have; the next ones are bound to the new one.
			}
			resolve(name, rrtype, callback) {
				if (promiseStyle) {
					try {
						if (rrtype !== undefined) checks.string(rrtype, "rrtype");
						if (rrtype !== undefined && !Object.hasOwn(RRTYPES, rrtype)) throw checks.valueError("rrtype", rrtype);
						return this[RRTYPES[rrtype ?? "A"]](name);
					} catch (err) {
						return Promise.reject(err);
					}
				}
				if (typeof rrtype === "string") {
					if (!Object.hasOwn(RRTYPES, rrtype)) throw checks.valueError("rrtype", rrtype);
					return this[RRTYPES[rrtype]](name, callback);
				}
				if (typeof rrtype === "function") return this.resolve4(name, rrtype);
				throw checks.typeError("rrtype", "of type string", rrtype);
			}
			reverse(ip, callback) {
				checks.string(ip, "name");
				if (promiseStyle) {
					return new Promise((resolve, reject) => {
						try {
							reverseLookup(this[kChannel], ip, (err, names) => (err ? reject(err) : resolve(names)));
						} catch (err) {
							reject(err);
						}
					});
				}
				checks.fn(callback, "callback");
				reverseLookup(this[kChannel], ip, callback);
			}
		}
		for (const [method, binding] of QUERY_METHODS) {
			const impl = promiseStyle
				? function (name, options) {
						return new Promise((resolve, reject) => {
							try {
								checks.string(name, "name");
							} catch (err) {
								return reject(err);
							}
							runQuery(this[kChannel], method, binding, name, options ?? {}, (err, value) =>
								err ? reject(err) : resolve(value)
							);
						});
					}
				: function (name, ...rest) {
						// (name, callback) or (name, options, callback): with two arguments the second is the callback.
						const [options, callback] = rest.length > 1 ? rest : [null, rest[0]];
						checks.string(name, "name");
						checks.fn(callback, "callback");
						runQuery(this[kChannel], method, binding, name, { ttl: !!options?.ttl }, callback);
					};
			Object.defineProperty(Resolver.prototype, method, {
				value: impl,
				writable: true,
				configurable: true,
				enumerable: false,
			});
			Object.defineProperty(impl, "name", { value: method, configurable: true });
		}
		return Resolver;
	}

	const CallbackResolver = makeResolverClass(false);
	const PromiseResolver = makeResolverClass(true);
	Object.defineProperty(CallbackResolver, "name", { value: "Resolver" });
	Object.defineProperty(PromiseResolver, "name", { value: "Resolver" });

	const defaultResolver = new CallbackResolver();
	const promisesDefault = new PromiseResolver();

	/* ---- lookup, which asks the machine's own servers and hosts file, not the ones set with setServers */

	const systemChannel = new Channel({}, system);
	const dnsOnlyQuery = (name, type, cb) => {
		const method = type === TYPES.A ? "resolve4" : "resolve6";
		systemChannel.query(name, type, (code, message) => {
			if (code) return cb(code);
			const answer = answerFor(method, message, name, { ttl: false });
			if (answer.code) return cb(answer.code);
			cb(null, answer.value);
		});
	};

	const stripDot = (host) => (host.endsWith(".") && host.length > 1 ? host.slice(0, -1) : host);

	function resolveHost(hostname, family, hints, done) {
		const name = stripDot(hostname).toLowerCase();
		const mapped = family === 6 && (hints & V4MAPPED) !== 0;
		const wantV4 = family !== 6 || mapped;
		const wantV6 = family !== 4;
		const fromHosts = hostEntries()
			.filter((e) => e.names.some((n) => n.toLowerCase() === name))
			.map((e) => ({ address: e.ip.zone ? `${e.ip.text}%${e.ip.zone}` : e.ip.text, family: e.ip.family }));
		if (fromHosts.length === 0 && (name === "localhost" || name.endsWith(".localhost"))) {
			fromHosts.push({ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 });
		}
		if (fromHosts.length) {
			const hosted = fromHosts.filter((a) => (a.family === 4 ? wantV4 : wantV6));
			return hosted.length ? done(null, hosted) : done("ENOTFOUND");
		}
		let waiting = (wantV4 ? 1 : 0) + (wantV6 ? 1 : 0);
		const found = { 4: [], 6: [] };
		const errors = [];
		const arrived = () => {
			if (--waiting > 0) return;
			const all = [...found[4], ...found[6]];
			if (all.length === 0) {
				return done(
					errors.some((c) => c === "ETIMEOUT" || c === "ECONNREFUSED" || c === "ESERVFAIL") ? "EAI_AGAIN" : "ENOTFOUND"
				);
			}
			done(null, all);
		};
		const ask = (type, fam) =>
			dnsOnlyQuery(hostname, type, (code, addresses) => {
				if (code) errors.push(code);
				else found[fam] = addresses.map((address) => ({ address, family: fam }));
				arrived();
			});
		if (wantV4) ask(TYPES.A, 4);
		if (wantV6) ask(TYPES.AAAA, 6);
	}

	function orderResults(list, order) {
		if (order === "verbatim") return list;
		const first = order === "ipv6first" ? 6 : 4;
		return [...list.filter((a) => a.family === first), ...list.filter((a) => a.family !== first)];
	}

	function v4mapped(list, family, hints) {
		if (family !== 6 || !(hints & V4MAPPED)) return list;
		const has6 = list.some((a) => a.family === 6);
		if (has6 && !(hints & ALL)) return list.filter((a) => a.family === 6);
		return [
			...list.filter((a) => a.family === 6),
			...list.filter((a) => a.family === 4).map((a) => ({ address: `::ffff:${a.address}`, family: 6 })),
		];
	}

	function lookupError(code, hostname) {
		return dnsError(code, "getaddrinfo", hostname, code === "EAI_AGAIN" ? -3001 : -3008);
	}

	function doLookup(hostname, opts, callback) {
		const { family, hints, all, order } = opts;
		const literal = parseIP(hostname);
		if (literal) {
			const one = { address: hostname, family: literal.family };
			return nextTick(() => (all ? callback(null, [one]) : callback(null, one.address, one.family)));
		}
		const finish = (list) => {
			list = orderResults(v4mapped(list, family, hints), order);
			if (all) return callback(null, list);
			callback(null, list[0].address, list[0].family);
		};
		nextTick(() =>
			resolveHost(hostname, family, hints, (code, list) =>
				code ? callback(lookupError(code, hostname)) : finish(list)
			)
		);
	}

	function parseLookupArgs(hostname, options, callback, promiseStyle) {
		let hints = 0;
		let family = 0;
		let all = false;
		let order = resultOrder;
		if (hostname) checks.string(hostname, "hostname");
		if (typeof options === "function" && !promiseStyle) {
			callback = options;
			family = 0;
		} else if (typeof options === "number") {
			if (!promiseStyle) checks.fn(callback, "callback");
			checks.oneOf(options, "family", [0, 4, 6]);
			family = options;
		} else if (options !== undefined && options !== null && typeof options !== "object") {
			if (!promiseStyle) checks.fn(callback === undefined ? options : callback, "callback");
			throw checks.typeError("options", "of type object or integer", options);
		} else {
			if (!promiseStyle) checks.fn(callback, "callback");
			if (options?.hints != null) checks.number(options.hints, "options.hints");
			hints = (options?.hints ?? 0) >>> 0;
			if ((hints & ~(ADDRCONFIG | V4MAPPED | ALL)) !== 0) throw checks.valueError("hints", hints);
			if (options?.family != null) {
				if (options.family === "IPv4") family = 4;
				else if (options.family === "IPv6") family = 6;
				else {
					checks.oneOf(options.family, "options.family", [0, 4, 6]);
					family = options.family;
				}
			}
			if (options?.all != null) checks.bool(options.all, "options.all");
			all = options?.all === true;
			if (options?.verbatim != null) {
				checks.bool(options.verbatim, "options.verbatim");
				order = options.verbatim ? "verbatim" : "ipv4first";
			}
			if (options?.order != null) {
				checks.oneOf(options.order, "options.order", RESULT_ORDERS);
				order = options.order;
			}
		}
		if (!hostname) throw checks.valueError("hostname", hostname, "must be a non-empty string");
		return { callback, opts: { family, hints, all, order } };
	}

	function lookup(hostname, options, callback) {
		const parsed = parseLookupArgs(hostname, options, callback, false);
		doLookup(hostname, parsed.opts, parsed.callback);
		return {};
	}
	function lookupPromise(hostname, options) {
		return new Promise((resolve, reject) => {
			const parsed = parseLookupArgs(hostname, options, undefined, true);
			doLookup(hostname, parsed.opts, (err, address, family) => {
				if (err) return reject(err);
				resolve(parsed.opts.all ? address : { address, family });
			});
		});
	}

	function lookupServiceImpl(address, port, callback) {
		const parsed = parseIP(address);
		const ptr = new Promise((resolve) => {
			const done = (name) => resolve(name);
			const fromHosts = hostEntries().find((e) => e.ip.family === parsed.family && e.ip.text === parsed.text);
			if (fromHosts) return done(fromHosts.names[0]);
			if (parsed.text === "127.0.0.1" || parsed.text === "::1") return done("localhost");
			systemChannel.query(reverseName(parsed), TYPES.PTR, (code, message) => {
				if (!code && message.rcode === 0) {
					const record = ofType(message, TYPES.PTR)[0];
					if (record) {
						try {
							return done(readName(message.bytes, record.start)[0]);
						} catch {
							// Fall through to the numeric form.
						}
					}
				}
				done(address);
			});
		});
		ptr.then((hostname) => callback(null, hostname, serviceName(Number(port))));
	}

	function lookupService(address, port, callback) {
		if (arguments.length !== 3) throw checks.missing(["address", "port", "callback"]);
		if (isIP(address) === 0) throw checks.valueError("address", address);
		checks.port(port);
		checks.fn(callback, "callback");
		lookupServiceImpl(address, port, callback);
	}
	function lookupServicePromise(address, port) {
		return new Promise((resolve, reject) => {
			if (arguments.length !== 2) return reject(checks.missing(["address", "port"]));
			if (isIP(address) === 0) return reject(checks.valueError("address", address));
			try {
				checks.port(port);
			} catch (err) {
				return reject(err);
			}
			lookupServiceImpl(address, port, (_, hostname, service) => resolve({ hostname, service }));
		});
	}

	/* ---- the two modules */

	const setDefaultServers = (servers, both) => {
		defaultResolver.setServers(servers);
		if (both) promisesDefault.setServers(servers);
	};
	const errorConstants = Object.fromEntries(ERROR_NAMES.map((n) => [n, `E${n}`]));
	const bind = (resolver, name) => resolver[name].bind(resolver);

	const promises = {
		lookup: lookupPromise,
		lookupService: lookupServicePromise,
		Resolver: PromiseResolver,
		getDefaultResultOrder: () => resultOrder,
		setDefaultResultOrder: setResultOrder,
		setServers: (servers) => promisesDefault.setServers(servers),
		...errorConstants,
		getServers: () => promisesDefault.getServers(),
	};
	for (const name of [...QUERY_METHODS.map(([m]) => m), "resolve", "reverse"])
		promises[name] = bind(promisesDefault, name);

	const dns = {
		lookup,
		lookupService,
		Resolver: CallbackResolver,
		getDefaultResultOrder: () => resultOrder,
		setDefaultResultOrder: setResultOrder,
		// The callback module's servers are also the promise module's, but not the other way round.
		setServers: (servers) => setDefaultServers(servers, true),
		ADDRCONFIG,
		ALL,
		V4MAPPED,
		...errorConstants,
		getServers: () => defaultResolver.getServers(),
	};
	for (const name of [...QUERY_METHODS.map(([m]) => m), "resolve", "reverse"]) dns[name] = bind(defaultResolver, name);
	dns.promises = promises;

	const custom = Symbol.for("nodejs.util.promisify.custom");
	Object.defineProperty(lookup, custom, { value: lookupPromise, configurable: true });
	Object.defineProperty(lookupService, custom, { value: lookupServicePromise, configurable: true });
	Object.defineProperty(lookup, "name", { value: "lookup" });
	return dns;
}

export {
	buildQuery,
	createDns,
	formatIPv6,
	nameToLabels,
	parseHosts,
	parseIP,
	parseIpconfig,
	parseMessage,
	parseNslookup,
	parseResolvConf,
	parseServices,
};

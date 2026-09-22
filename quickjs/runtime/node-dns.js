/*
 * `node:dns` and `node:dns/promises` for the Graak native host.
 *
 * Implements pure JS RFC 1035 DNS client over UDP (dgram) with TCP fallback,
 * system resolver discovery (/etc/resolv.conf on POSIX, ipconfig /all on Windows),
 * and the complete Node.js dns / dns/promises API surface.
 */

function extractIp(str) {
	const words = str.trim().split(/\s+/);
	for (const w of words) {
		const clean = w.replace(/^[^0-9a-fA-F:]+|[^0-9a-fA-F%:]+$/g, "");
		const withoutScope = clean.split("%")[0];
		if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(withoutScope)) {
			return withoutScope;
		}
		if (withoutScope.includes(":") && /^[0-9a-fA-F:]+$/.test(withoutScope) && withoutScope.length >= 3) {
			return withoutScope;
		}
	}
	return null;
}

function isDnsServerHeader(label) {
	if (/suffix/i.test(label) || /sufijo/i.test(label) || /suffixe/i.test(label)) {
		return false;
	}
	return (
		/DNS/i.test(label) &&
		(/server/i.test(label) ||
			/servidor/i.test(label) ||
			/serveur/i.test(label) ||
			/сервер/i.test(label) ||
			/服务/i.test(label) ||
			/サー/i.test(label))
	);
}

function isNewFieldLine(line) {
	if (line.includes(". :") || line.includes(". .")) return true;
	const m = /^\s*([^\s:][^:]*):/.exec(line);
	if (m) {
		const beforeColon = m[1].trim();
		if (/^[0-9a-fA-F]{1,4}$/.test(beforeColon)) return false;
		return true;
	}
	return false;
}

function parseIpconfigDns(output) {
	const servers = [];
	const lines = output.split(/\r?\n/);
	let inDnsSection = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			inDnsSection = false;
			continue;
		}
		if (isNewFieldLine(line)) {
			const colonIdx = line.indexOf(":");
			const label = line.slice(0, colonIdx);
			const value = line.slice(colonIdx + 1);
			if (isDnsServerHeader(label)) {
				inDnsSection = true;
				const ip = extractIp(value);
				if (ip && !servers.includes(ip)) servers.push(ip);
			} else {
				inDnsSection = false;
			}
			continue;
		}
		if (inDnsSection) {
			const ip = extractIp(trimmed);
			if (ip && !servers.includes(ip)) servers.push(ip);
		}
	}
	return servers;
}

function parseResolvConf(text) {
	const servers = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
		const m = /^nameserver\s+([^\s]+)/.exec(trimmed);
		if (m) {
			const ip = m[1].split("%")[0];
			if (!servers.includes(ip)) servers.push(ip);
		}
	}
	return servers;
}

function compressIpv6(groups) {
	let bestStart = -1;
	let bestLen = 0;
	let curStart = -1;
	let curLen = 0;
	for (let i = 0; i < groups.length; i++) {
		if (groups[i] === "0") {
			if (curStart === -1) {
				curStart = i;
				curLen = 1;
			} else {
				curLen++;
			}
			if (curLen > bestLen) {
				bestStart = curStart;
				bestLen = curLen;
			}
		} else {
			curStart = -1;
			curLen = 0;
		}
	}
	if (bestLen > 1) {
		const head = groups.slice(0, bestStart).join(":");
		const tail = groups.slice(bestStart + bestLen).join(":");
		return `${head}::${tail}`;
	}
	return groups.join(":");
}

function parseServerAddress(server) {
	let host = server;
	let port = 53;
	if (server.startsWith("[")) {
		const closing = server.indexOf("]");
		if (closing !== -1) {
			host = server.slice(1, closing);
			if (server[closing + 1] === ":") {
				port = parseInt(server.slice(closing + 2), 10) || 53;
			}
		}
	} else if (server.includes(":") && server.split(":").length === 2) {
		const parts = server.split(":");
		host = parts[0];
		port = parseInt(parts[1], 10) || 53;
	}
	return { host, port };
}

const RR_TYPES = {
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
	ANY: 255,
	CAA: 257,
};

const SYSCALL_NAMES = {
	A: "queryA",
	AAAA: "queryAaaa",
	CNAME: "queryCname",
	MX: "queryMx",
	NS: "queryNs",
	PTR: "queryPtr",
	SOA: "querySoa",
	SRV: "querySrv",
	TXT: "queryTxt",
	CAA: "queryCaa",
	NAPTR: "queryNaptr",
	ANY: "queryAny",
};

const ERROR_CODES = {
	NODATA: "ENODATA",
	FORMERR: "EFORMERR",
	SERVFAIL: "ESERVFAIL",
	NOTFOUND: "ENOTFOUND",
	NOTIMP: "ENOTIMP",
	REFUSED: "EREFUSED",
	BADQUERY: "EBADQUERY",
	BADNAME: "EBADNAME",
	BADFAMILY: "EBADFAMILY",
	BADRESP: "EBADRESP",
	CONNREFUSED: "ECONNREFUSED",
	TIMEOUT: "ETIMEOUT",
	EOF: "EOF",
	FILE: "EFILE",
	NOMEM: "ENOMEM",
	DESTRUCTION: "EDESTRUCTION",
	BADSTR: "EBADSTR",
	BADFLAGS: "EBADFLAGS",
	NONAME: "ENONAME",
	BADHINTS: "EBADHINTS",
	NOTINITIALIZED: "ENOTINITIALIZED",
	LOADIPHLPAPI: "ELOADIPHLPAPI",
	ADDRGETNETWORKPARAMS: "EADDRGETNETWORKPARAMS",
	CANCELLED: "ECANCELLED",
};

const SERVICES = {
	21: "ftp",
	22: "ssh",
	23: "telnet",
	25: "smtp",
	53: "domain",
	80: "http",
	110: "pop3",
	143: "imap",
	443: "https",
	993: "imaps",
	995: "pop3s",
};

function createDnsModule({ dgram, net, fs, child_process, process, Buffer, EventEmitter }) {
	function createDnsError(code, syscall, hostname, message) {
		const text = message || `${syscall} ${code} ${hostname}`;
		const err = new Error(text);
		err.code = code;
		err.syscall = syscall;
		err.hostname = hostname;
		return err;
	}

	function encodeDnsQuery(name, rrtype, id = Math.floor(Math.random() * 65535)) {
		const parts = name.split(".");
		let nameLen = 1; // Trailing zero
		for (const p of parts) {
			nameLen += 1 + Buffer.byteLength(p);
		}
		const buf = Buffer.alloc(12 + nameLen + 4);
		buf.writeUInt16BE(id, 0);
		buf.writeUInt16BE(0x0100, 2); // RD = 1
		buf.writeUInt16BE(1, 4); // QDCOUNT = 1
		buf.writeUInt16BE(0, 6);
		buf.writeUInt16BE(0, 8);
		buf.writeUInt16BE(0, 10);

		let offset = 12;
		for (const p of parts) {
			const byteLen = Buffer.byteLength(p);
			buf.writeUInt8(byteLen, offset++);
			buf.write(p, offset, byteLen, "utf8");
			offset += byteLen;
		}
		buf.writeUInt8(0, offset++);

		buf.writeUInt16BE(rrtype, offset);
		offset += 2;
		buf.writeUInt16BE(1, offset); // IN = 1
		return buf;
	}

	function readDomainName(buf, offset) {
		const parts = [];
		let jumped = false;
		let nextOffset = -1;
		let steps = 0;
		while (offset < buf.length && steps++ < 100) {
			const len = buf[offset];
			if (len === 0) {
				if (!jumped) nextOffset = offset + 1;
				break;
			}
			if ((len & 0xc0) === 0xc0) {
				if (!jumped) nextOffset = offset + 2;
				jumped = true;
				offset = ((len & 0x3f) << 8) | buf[offset + 1];
				continue;
			}
			offset++;
			parts.push(buf.toString("utf8", offset, offset + len));
			offset += len;
		}
		if (!jumped && nextOffset === -1) nextOffset = offset + 1;
		return { name: parts.join("."), nextOffset };
	}

	function decodeDnsResponse(buf, expectedId, hostname, syscall) {
		if (buf.length < 12) {
			throw createDnsError(ERROR_CODES.BADRESP, syscall, hostname, "DNS response too short");
		}
		const id = buf.readUInt16BE(0);
		const flags = buf.readUInt16BE(2);
		const qdcount = buf.readUInt16BE(4);
		const ancount = buf.readUInt16BE(6);

		const tc = Boolean(flags & 0x0200);
		const rcode = flags & 0x000f;

		if (rcode === 3) {
			throw createDnsError(ERROR_CODES.NOTFOUND, syscall, hostname);
		}
		if (rcode === 1) {
			throw createDnsError(ERROR_CODES.FORMERR, syscall, hostname);
		}
		if (rcode === 2) {
			throw createDnsError(ERROR_CODES.SERVFAIL, syscall, hostname);
		}
		if (rcode === 5) {
			throw createDnsError(ERROR_CODES.REFUSED, syscall, hostname);
		}
		if (rcode !== 0) {
			throw createDnsError(ERROR_CODES.BADRESP, syscall, hostname);
		}

		let offset = 12;
		for (let i = 0; i < qdcount; i++) {
			const q = readDomainName(buf, offset);
			offset = q.nextOffset + 4; // Skip QTYPE (2) + QCLASS (2)
		}

		const answers = [];
		for (let i = 0; i < ancount && offset < buf.length; i++) {
			const n = readDomainName(buf, offset);
			offset = n.nextOffset;
			if (offset + 10 > buf.length) break;
			const type = buf.readUInt16BE(offset);
			offset += 2;
			const cls = buf.readUInt16BE(offset);
			offset += 2;
			const ttl = buf.readUInt32BE(offset);
			offset += 4;
			const rdlength = buf.readUInt16BE(offset);
			offset += 2;

			const rdataEnd = offset + rdlength;
			let record = null;

			if (type === RR_TYPES.A && rdlength === 4) {
				const ip = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
				record = { type: "A", address: ip, ttl };
			} else if (type === RR_TYPES.AAAA && rdlength === 16) {
				const groups = [];
				for (let g = 0; g < 16; g += 2) {
					groups.push(buf.readUInt16BE(offset + g).toString(16));
				}
				const ip = compressIpv6(groups);
				record = { type: "AAAA", address: ip, ttl };
			} else if (type === RR_TYPES.CNAME) {
				const target = readDomainName(buf, offset).name;
				record = { type: "CNAME", value: target, ttl };
			} else if (type === RR_TYPES.PTR) {
				const target = readDomainName(buf, offset).name;
				record = { type: "PTR", value: target, ttl };
			} else if (type === RR_TYPES.NS) {
				const target = readDomainName(buf, offset).name;
				record = { type: "NS", value: target, ttl };
			} else if (type === RR_TYPES.MX && rdlength >= 3) {
				const priority = buf.readUInt16BE(offset);
				const exchange = readDomainName(buf, offset + 2).name;
				record = { type: "MX", priority, exchange, ttl };
			} else if (type === RR_TYPES.TXT) {
				const entries = [];
				let txtPos = offset;
				while (txtPos < rdataEnd) {
					const tlen = buf[txtPos++];
					const str = buf.toString("utf8", txtPos, Math.min(txtPos + tlen, rdataEnd));
					entries.push(str);
					txtPos += tlen;
				}
				record = { type: "TXT", entries, ttl };
			} else if (type === RR_TYPES.SRV && rdlength >= 7) {
				const priority = buf.readUInt16BE(offset);
				const weight = buf.readUInt16BE(offset + 2);
				const port = buf.readUInt16BE(offset + 4);
				const name = readDomainName(buf, offset + 6).name;
				record = { type: "SRV", priority, weight, port, name, ttl };
			} else if (type === RR_TYPES.SOA) {
				const mname = readDomainName(buf, offset);
				const rname = readDomainName(buf, mname.nextOffset);
				let pos = rname.nextOffset;
				const serial = buf.readUInt32BE(pos);
				pos += 4;
				const refresh = buf.readUInt32BE(pos);
				pos += 4;
				const retry = buf.readUInt32BE(pos);
				pos += 4;
				const expire = buf.readUInt32BE(pos);
				pos += 4;
				const minttl = buf.readUInt32BE(pos);
				record = {
					type: "SOA",
					nsname: mname.name,
					hostmaster: rname.name,
					serial,
					refresh,
					retry,
					expire,
					minttl,
					ttl,
				};
			} else if (type === RR_TYPES.CAA && rdlength >= 2) {
				const critical = buf[offset] & 0x80 ? 128 : 0;
				const tagLen = buf[offset + 1];
				const tag = buf.toString("utf8", offset + 2, offset + 2 + tagLen);
				const val = buf.toString("utf8", offset + 2 + tagLen, rdataEnd);
				record = { type: "CAA", critical, [tag]: val, ttl };
			} else if (type === RR_TYPES.NAPTR && rdlength >= 7) {
				const order = buf.readUInt16BE(offset);
				const preference = buf.readUInt16BE(offset + 2);
				let pos = offset + 4;
				const flagsLen = buf[pos++];
				const flags = buf.toString("utf8", pos, pos + flagsLen);
				pos += flagsLen;
				const serviceLen = buf[pos++];
				const service = buf.toString("utf8", pos, pos + serviceLen);
				pos += serviceLen;
				const regexpLen = buf[pos++];
				const regexp = buf.toString("utf8", pos, pos + regexpLen);
				pos += regexpLen;
				const replacement = readDomainName(buf, pos).name;
				record = { type: "NAPTR", order, preference, flags, service, regexp, replacement, ttl };
			}

			if (record) answers.push(record);
			offset = rdataEnd;
		}

		return { tc, answers };
	}

	function queryUdp(server, port, packet, timeoutMs) {
		return new Promise((resolve, reject) => {
			const isIpv6 = server.includes(":");
			let socket;
			try {
				socket = dgram.createSocket(isIpv6 ? "udp6" : "udp4");
			} catch (err) {
				return reject(err);
			}

			let timer = null;
			let settled = false;

			const cleanup = () => {
				if (timer) clearTimeout(timer);
				try {
					socket.close();
				} catch {}
			};

			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				const err = new Error("query timed out");
				err.code = ERROR_CODES.TIMEOUT;
				reject(err);
			}, timeoutMs);

			socket.on("error", (err) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			});

			socket.on("message", (msg) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(msg);
			});

			socket.send(packet, 0, packet.length, port, server, (err) => {
				if (err && !settled) {
					settled = true;
					cleanup();
					reject(err);
				}
			});
		});
	}

	function queryTcp(server, port, packet, timeoutMs) {
		return new Promise((resolve, reject) => {
			const tcpPacket = Buffer.alloc(2 + packet.length);
			tcpPacket.writeUInt16BE(packet.length, 0);
			packet.copy(tcpPacket, 2);

			let socket;
			try {
				socket = net.connect(port, server);
			} catch (err) {
				return reject(err);
			}

			let timer = null;
			let settled = false;
			const chunks = [];
			let expectedLen = -1;
			let receivedLen = 0;

			const cleanup = () => {
				if (timer) clearTimeout(timer);
				try {
					socket.destroy();
				} catch {}
			};

			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				const err = new Error("query timed out");
				err.code = ERROR_CODES.TIMEOUT;
				reject(err);
			}, timeoutMs);

			socket.on("error", (err) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			});

			socket.on("data", (chunk) => {
				chunks.push(chunk);
				receivedLen += chunk.length;
				if (expectedLen === -1 && receivedLen >= 2) {
					const combined = Buffer.concat(chunks);
					expectedLen = combined.readUInt16BE(0);
				}
				if (expectedLen !== -1 && receivedLen - 2 >= expectedLen) {
					settled = true;
					cleanup();
					const total = Buffer.concat(chunks);
					resolve(total.slice(2, 2 + expectedLen));
				}
			});

			socket.write(tcpPacket);
		});
	}

	async function queryDns(servers, packet, id, hostname, syscall, timeoutMs = 5000) {
		let lastError = null;
		for (const serverStr of servers) {
			const { host, port } = parseServerAddress(serverStr);
			try {
				let resp = await queryUdp(host, port, packet, timeoutMs);
				let decoded = decodeDnsResponse(resp, id, hostname, syscall);
				if (decoded.tc) {
					resp = await queryTcp(host, port, packet, timeoutMs);
					decoded = decodeDnsResponse(resp, id, hostname, syscall);
				}
				return decoded.answers;
			} catch (err) {
				lastError = err;
				if (err.code === ERROR_CODES.NOTFOUND) {
					throw err; // Authoritative NXDOMAIN
				}
			}
		}
		throw lastError || createDnsError(ERROR_CODES.SERVFAIL, syscall, hostname);
	}

	function loadSystemDnsServers() {
		try {
			if (process.platform === "win32") {
				const out = child_process.execSync("ipconfig /all", { encoding: "utf8", timeout: 2000 });
				const parsed = parseIpconfigDns(out);
				if (parsed.length > 0) return parsed;
			} else {
				if (fs.existsSync("/etc/resolv.conf")) {
					const content = fs.readFileSync("/etc/resolv.conf", "utf8");
					const parsed = parseResolvConf(content);
					if (parsed.length > 0) return parsed;
				}
			}
		} catch {}
		return ["127.0.0.1"];
	}

	let systemServers = loadSystemDnsServers();
	let defaultResultOrder = "verbatim";

	class Resolver {
		constructor(options = {}) {
			this._servers = [...systemServers];
			this._timeout = options.timeout ?? 5000;
			this._tries = options.tries ?? 4;
		}

		getServers() {
			return [...this._servers];
		}

		setServers(servers) {
			if (!Array.isArray(servers)) {
				throw new TypeError("The 'servers' argument must be an array of strings");
			}
			const list = [];
			for (const s of servers) {
				if (typeof s !== "string") {
					throw new TypeError("Server address must be a string");
				}
				list.push(s);
			}
			this._servers = list.length > 0 ? list : ["127.0.0.1"];
		}

		cancel() {}

		async _resolveType(name, rrtype, syscall) {
			if (typeof name !== "string") {
				throw new TypeError("The 'name' argument must be a string");
			}
			const id = Math.floor(Math.random() * 65535);
			const packet = encodeDnsQuery(name, rrtype, id);
			const answers = await queryDns(this._servers, packet, id, name, syscall, this._timeout);
			return answers;
		}

		resolve(name, rrtypeOrCallback, maybeCallback) {
			let rrtype = "A";
			let cb = null;
			if (typeof rrtypeOrCallback === "function") {
				cb = rrtypeOrCallback;
			} else if (typeof rrtypeOrCallback === "string") {
				rrtype = rrtypeOrCallback.toUpperCase();
				if (typeof maybeCallback === "function") cb = maybeCallback;
			}

			const promise = (async () => {
				switch (rrtype) {
					case "A":
						return await this.resolve4(name);
					case "AAAA":
						return await this.resolve6(name);
					case "CNAME":
						return await this.resolveCname(name);
					case "MX":
						return await this.resolveMx(name);
					case "NS":
						return await this.resolveNs(name);
					case "PTR":
						return await this.resolvePtr(name);
					case "SOA":
						return await this.resolveSoa(name);
					case "SRV":
						return await this.resolveSrv(name);
					case "TXT":
						return await this.resolveTxt(name);
					case "CAA":
						return await this.resolveCaa(name);
					case "NAPTR":
						return await this.resolveNaptr(name);
					case "ANY":
						return await this.resolveAny(name);
					default:
						throw new TypeError(`Unknown rrtype: ${rrtype}`);
				}
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolve4(name, optionsOrCallback, maybeCallback) {
			let options = {};
			let cb = null;
			if (typeof optionsOrCallback === "function") {
				cb = optionsOrCallback;
			} else if (optionsOrCallback && typeof optionsOrCallback === "object") {
				options = optionsOrCallback;
				if (typeof maybeCallback === "function") cb = maybeCallback;
			}

			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.A, SYSCALL_NAMES.A);
				const aRecords = answers.filter((a) => a.type === "A");
				if (aRecords.length === 0) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.A, name);
				}
				if (options.ttl) {
					return aRecords.map((a) => ({ address: a.address, ttl: a.ttl }));
				}
				return aRecords.map((a) => a.address);
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolve6(name, optionsOrCallback, maybeCallback) {
			let options = {};
			let cb = null;
			if (typeof optionsOrCallback === "function") {
				cb = optionsOrCallback;
			} else if (optionsOrCallback && typeof optionsOrCallback === "object") {
				options = optionsOrCallback;
				if (typeof maybeCallback === "function") cb = maybeCallback;
			}

			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.AAAA, SYSCALL_NAMES.AAAA);
				const aRecords = answers.filter((a) => a.type === "AAAA");
				if (aRecords.length === 0) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.AAAA, name);
				}
				if (options.ttl) {
					return aRecords.map((a) => ({ address: a.address, ttl: a.ttl }));
				}
				return aRecords.map((a) => a.address);
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolveCname(name, cb) {
			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.CNAME, SYSCALL_NAMES.CNAME);
				const records = answers.filter((a) => a.type === "CNAME");
				if (records.length === 0) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.CNAME, name);
				}
				return records.map((r) => r.value);
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolveMx(name, cb) {
			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.MX, SYSCALL_NAMES.MX);
				const records = answers.filter((a) => a.type === "MX");
				if (records.length === 0) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.MX, name);
				}
				return records.map((r) => ({ exchange: r.exchange, priority: r.priority, type: "MX" }));
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolveNs(name, cb) {
			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.NS, SYSCALL_NAMES.NS);
				const records = answers.filter((a) => a.type === "NS");
				if (records.length === 0) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.NS, name);
				}
				return records.map((r) => r.value);
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolveTxt(name, cb) {
			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.TXT, SYSCALL_NAMES.TXT);
				const records = answers.filter((a) => a.type === "TXT");
				if (records.length === 0) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.TXT, name);
				}
				return records.map((r) => r.entries);
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolveSrv(name, cb) {
			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.SRV, SYSCALL_NAMES.SRV);
				const records = answers.filter((a) => a.type === "SRV");
				if (records.length === 0) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.SRV, name);
				}
				return records.map((r) => ({
					priority: r.priority,
					weight: r.weight,
					port: r.port,
					name: r.name,
				}));
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolvePtr(name, cb) {
			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.PTR, SYSCALL_NAMES.PTR);
				const records = answers.filter((a) => a.type === "PTR");
				if (records.length === 0) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.PTR, name);
				}
				return records.map((r) => r.value);
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolveSoa(name, cb) {
			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.SOA, SYSCALL_NAMES.SOA);
				const r = answers.find((a) => a.type === "SOA");
				if (!r) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.SOA, name);
				}
				return {
					nsname: r.nsname,
					hostmaster: r.hostmaster,
					serial: r.serial,
					refresh: r.refresh,
					retry: r.retry,
					expire: r.expire,
					minttl: r.minttl,
				};
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolveCaa(name, cb) {
			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.CAA, SYSCALL_NAMES.CAA);
				const records = answers.filter((a) => a.type === "CAA");
				if (records.length === 0) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.CAA, name);
				}
				return records.map((r) => {
					const out = { critical: r.critical };
					for (const k of Object.keys(r)) {
						if (k !== "type" && k !== "critical" && k !== "ttl") {
							out[k] = r[k];
						}
					}
					return out;
				});
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolveNaptr(name, cb) {
			const promise = (async () => {
				const answers = await this._resolveType(name, RR_TYPES.NAPTR, SYSCALL_NAMES.NAPTR);
				const records = answers.filter((a) => a.type === "NAPTR");
				if (records.length === 0) {
					throw createDnsError(ERROR_CODES.NODATA, SYSCALL_NAMES.NAPTR, name);
				}
				return records.map((r) => ({
					order: r.order,
					preference: r.preference,
					flags: r.flags,
					service: r.service,
					regexp: r.regexp,
					replacement: r.replacement,
				}));
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		resolveAny(name, cb) {
			const promise = (async () => {
				throw createDnsError(ERROR_CODES.NOTIMP, SYSCALL_NAMES.ANY, name);
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}

		reverse(ip, cb) {
			const promise = (async () => {
				let arpaName = "";
				if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
					const parts = ip.split(".").reverse();
					arpaName = `${parts.join(".")}.in-addr.arpa`;
				} else if (ip.includes(":")) {
					// Expand IPv6 and reverse nibbles
					const hexParts = [];
					const segments = ip.split(":");
					// Handle ::
					let fullSegments = [];
					const dblIdx = segments.indexOf("");
					if (dblIdx !== -1) {
						const pre = segments.slice(0, dblIdx);
						const post = segments.slice(dblIdx + 1);
						if (post.length > 0 && post[0] === "") post.shift();
						const fill = 8 - (pre.length + post.length);
						fullSegments = [...pre, ...Array(fill).fill("0"), ...post];
					} else {
						fullSegments = segments;
					}
					for (const seg of fullSegments) {
						const padded = seg.padStart(4, "0");
						for (const ch of padded) hexParts.push(ch);
					}
					arpaName = `${hexParts.reverse().join(".")}.ip6.arpa`;
				} else {
					throw createDnsError(ERROR_CODES.BADNAME, "reverse", ip);
				}
				return await this.resolvePtr(arpaName);
			})();

			if (cb) {
				promise.then((res) => cb(null, res), cb);
				return;
			}
			return promise;
		}
	}

	const defaultResolver = new Resolver();

	function getServers() {
		return defaultResolver.getServers();
	}

	function setServers(servers) {
		defaultResolver.setServers(servers);
		systemServers = [...defaultResolver.getServers()];
	}

	function lookup(hostname, optionsOrCallback, maybeCallback) {
		let options = {};
		let cb = null;
		if (typeof optionsOrCallback === "function") {
			cb = optionsOrCallback;
		} else if (typeof optionsOrCallback === "number") {
			options = { family: optionsOrCallback };
			if (typeof maybeCallback === "function") cb = maybeCallback;
		} else if (optionsOrCallback && typeof optionsOrCallback === "object") {
			options = optionsOrCallback;
			if (typeof maybeCallback === "function") cb = maybeCallback;
		}

		const promise = (async () => {
			if (!hostname) {
				if (options.all) return [];
				return { address: null, family: 4 };
			}

			// IPv4 literal
			if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
				if (options.all) return [{ address: hostname, family: 4 }];
				return { address: hostname, family: 4 };
			}

			// IPv6 literal
			if (hostname.includes(":") && /^[0-9a-fA-F:]+$/.test(hostname)) {
				if (options.all) return [{ address: hostname, family: 6 }];
				return { address: hostname, family: 6 };
			}

			// Localhost
			if (hostname === "localhost") {
				const fam = options.family === 6 ? 6 : 4;
				const addr = fam === 6 ? "::1" : "127.0.0.1";
				if (options.all) {
					return [{ address: addr, family: fam }];
				}
				return { address: addr, family: fam };
			}

			// Try query
			const wantFamily = options.family || 0;
			const wantAll = Boolean(options.all);
			const results = [];

			if (wantFamily === 0 || wantFamily === 4) {
				try {
					const v4 = await defaultResolver.resolve4(hostname);
					for (const a of v4) results.push({ address: a, family: 4 });
				} catch {}
			}
			if (wantFamily === 0 || wantFamily === 6) {
				try {
					const v6 = await defaultResolver.resolve6(hostname);
					for (const a of v6) results.push({ address: a, family: 6 });
				} catch {}
			}

			if (results.length === 0) {
				throw createDnsError(ERROR_CODES.NOTFOUND, "getaddrinfo", hostname);
			}

			if (wantAll) {
				const order = options.order || defaultResultOrder;
				if (order === "ipv6first") {
					results.sort((a, b) => b.family - a.family);
				} else if (order === "ipv4first") {
					results.sort((a, b) => a.family - b.family);
				}
				return results;
			}

			return results[0];
		})();

		if (cb) {
			promise.then(
				(res) => {
					if (Array.isArray(res)) cb(null, res);
					else cb(null, res.address, res.family);
				},
				(err) => cb(err)
			);
			return;
		}
		return promise;
	}

	function lookupService(address, port, cb) {
		const promise = (async () => {
			if (!address || typeof address !== "string") {
				throw new TypeError("The 'address' argument must be a string");
			}
			const p = parseInt(port, 10);
			if (Number.isNaN(p) || p < 0 || p > 65535) {
				throw new RangeError("The 'port' argument must be a number between 0 and 65535");
			}
			let hostname = address;
			if (address === "127.0.0.1" || address === "::1") {
				hostname = "localhost";
			} else {
				try {
					const ptr = await defaultResolver.reverse(address);
					if (ptr.length > 0) hostname = ptr[0];
				} catch {}
			}
			const service = SERVICES[p] || String(p);
			return { hostname, service };
		})();

		if (cb) {
			promise.then((res) => cb(null, res.hostname, res.service), cb);
			return;
		}
		return promise;
	}

	class PromisesResolver {
		constructor(options) {
			this._resolver = new Resolver(options);
		}
		getServers() {
			return this._resolver.getServers();
		}
		setServers(servers) {
			this._resolver.setServers(servers);
		}
		cancel() {
			this._resolver.cancel();
		}
		resolve(name, rrtype) {
			return this._resolver.resolve(name, rrtype);
		}
		resolve4(name, options) {
			return this._resolver.resolve4(name, options);
		}
		resolve6(name, options) {
			return this._resolver.resolve6(name, options);
		}
		resolveCname(name) {
			return this._resolver.resolveCname(name);
		}
		resolveMx(name) {
			return this._resolver.resolveMx(name);
		}
		resolveNs(name) {
			return this._resolver.resolveNs(name);
		}
		resolveTxt(name) {
			return this._resolver.resolveTxt(name);
		}
		resolveSrv(name) {
			return this._resolver.resolveSrv(name);
		}
		resolvePtr(name) {
			return this._resolver.resolvePtr(name);
		}
		resolveSoa(name) {
			return this._resolver.resolveSoa(name);
		}
		resolveCaa(name) {
			return this._resolver.resolveCaa(name);
		}
		resolveNaptr(name) {
			return this._resolver.resolveNaptr(name);
		}
		resolveAny(name) {
			return this._resolver.resolveAny(name);
		}
		reverse(ip) {
			return this._resolver.reverse(ip);
		}
	}

	const dnsPromisesModule = {
		Resolver: PromisesResolver,
		getServers,
		setServers,
		getDefaultResultOrder: () => defaultResultOrder,
		setDefaultResultOrder: (order) => {
			if (order !== "verbatim" && order !== "ipv4first") {
				throw new Error(`invalid order: ${order}`);
			}
			defaultResultOrder = order;
		},
		lookup: (hostname, options) => lookup(hostname, options),
		lookupService: (address, port) => lookupService(address, port),
		resolve: (name, rrtype) => defaultResolver.resolve(name, rrtype),
		resolve4: (name, options) => defaultResolver.resolve4(name, options),
		resolve6: (name, options) => defaultResolver.resolve6(name, options),
		resolveCname: (name) => defaultResolver.resolveCname(name),
		resolveMx: (name) => defaultResolver.resolveMx(name),
		resolveNs: (name) => defaultResolver.resolveNs(name),
		resolveTxt: (name) => defaultResolver.resolveTxt(name),
		resolveSrv: (name) => defaultResolver.resolveSrv(name),
		resolvePtr: (name) => defaultResolver.resolvePtr(name),
		resolveSoa: (name) => defaultResolver.resolveSoa(name),
		resolveCaa: (name) => defaultResolver.resolveCaa(name),
		resolveNaptr: (name) => defaultResolver.resolveNaptr(name),
		resolveAny: (name) => defaultResolver.resolveAny(name),
		reverse: (ip) => defaultResolver.reverse(ip),
		...ERROR_CODES,
	};

	const dnsModule = {
		Resolver,
		getServers,
		setServers,
		getDefaultResultOrder: () => defaultResultOrder,
		setDefaultResultOrder: (order) => {
			if (order !== "verbatim" && order !== "ipv4first") {
				throw new Error(`invalid order: ${order}`);
			}
			defaultResultOrder = order;
		},
		lookup,
		lookupService,
		resolve: (name, rrtype, cb) => defaultResolver.resolve(name, rrtype, cb),
		resolve4: (name, opt, cb) => defaultResolver.resolve4(name, opt, cb),
		resolve6: (name, opt, cb) => defaultResolver.resolve6(name, opt, cb),
		resolveCname: (name, cb) => defaultResolver.resolveCname(name, cb),
		resolveMx: (name, cb) => defaultResolver.resolveMx(name, cb),
		resolveNs: (name, cb) => defaultResolver.resolveNs(name, cb),
		resolveTxt: (name, cb) => defaultResolver.resolveTxt(name, cb),
		resolveSrv: (name, cb) => defaultResolver.resolveSrv(name, cb),
		resolvePtr: (name, cb) => defaultResolver.resolvePtr(name, cb),
		resolveSoa: (name, cb) => defaultResolver.resolveSoa(name, cb),
		resolveCaa: (name, cb) => defaultResolver.resolveCaa(name, cb),
		resolveNaptr: (name, cb) => defaultResolver.resolveNaptr(name, cb),
		resolveAny: (name, cb) => defaultResolver.resolveAny(name, cb),
		reverse: (ip, cb) => defaultResolver.reverse(ip, cb),
		promises: dnsPromisesModule,
		ADDRCONFIG: 1,
		V4MAPPED: 2,
		ALL: 4,
		...ERROR_CODES,
	};

	return { dnsModule, dnsPromisesModule };
}

export { createDnsModule, parseIpconfigDns, parseResolvConf };

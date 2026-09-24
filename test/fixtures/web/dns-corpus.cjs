// dns: a deterministic DNS server on 127.0.0.1 (UDP, plus TCP for truncated answers), and every record type, option
// and failure mode of dns and dns/promises checked against it. It has its own encoder and parser, so nothing here
// depends on the implementation being tested.
const dns = require("dns");
const dgram = require("dgram");
const net = require("net");
const { Resolver } = dns;

const out = [];
const mockPorts = new Set();
const say = (...a) =>
  out.push(
    a
      .map((x) => (typeof x === "string" ? x : plain(x)))
      .join(" ")
      .replace(/127\.0\.0\.1:(\d+)/g, (m, port) => (mockPorts.has(Number(port)) ? "127.0.0.1:MOCK" : m))
      .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
  );

/* ---------------------------------------------------------------- the wire format, written from the RFCs */

const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, NAPTR: 35, TLSA: 52, CAA: 257 };
const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));
TYPE_NAME[255] = "ANY";

function ip6bytes(text) {
  const [head, tail = null] = text.split("::");
  const side = (s) => (s === "" ? [] : s.split(":"));
  const a = side(head);
  const b = tail === null ? [] : side(tail);
  const groups = [...a, ...Array(8 - a.length - b.length).fill("0"), ...b].map((g) => parseInt(g, 16));
  return groups.flatMap((g) => [g >> 8, g & 255]);
}

class Message {
  constructor() {
    this.bytes = [];
    this.names = new Map();
  }
  u8(v) {
    this.bytes.push(v & 255);
  }
  u16(v) {
    this.bytes.push((v >> 8) & 255, v & 255);
  }
  u32(v) {
    this.bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  }
  raw(list) {
    for (const b of list) this.bytes.push(b);
  }
  name(text, compress = true) {
    const labels = text === "" ? [] : text.split(".");
    for (let i = 0; i < labels.length; i++) {
      const key = labels.slice(i).join(".").toLowerCase();
      if (compress && this.names.has(key)) return this.u16(0xc000 | this.names.get(key));
      if (this.bytes.length < 0x3fff) this.names.set(key, this.bytes.length);
      this.u8(labels[i].length);
      this.raw(Buffer.from(labels[i], "latin1"));
    }
    this.u8(0);
  }
  string(value) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    this.u8(data.length);
    this.raw(data);
  }
}

function writeRecord(m, name, rec) {
  m.name(name);
  m.u16(TYPE[rec.t]);
  m.u16(1);
  m.u32(rec.ttl ?? 60);
  const lengthAt = m.bytes.length;
  m.u16(0);
  const v = rec.v;
  switch (rec.t) {
    case "A":
      m.raw(v.split(".").map(Number));
      break;
    case "AAAA":
      m.raw(ip6bytes(v));
      break;
    case "NS":
    case "CNAME":
    case "PTR":
      m.name(v);
      break;
    case "MX":
      m.u16(v[0]);
      m.name(v[1]);
      break;
    case "SOA":
      m.name(v[0]);
      m.name(v[1]);
      for (const n of v.slice(2)) m.u32(n);
      break;
    case "TXT":
      for (const chunk of v) m.string(chunk);
      break;
    case "SRV":
      m.u16(v[0]);
      m.u16(v[1]);
      m.u16(v[2]);
      m.name(v[3], false);
      break;
    case "NAPTR":
      m.u16(v[0]);
      m.u16(v[1]);
      m.string(v[2]);
      m.string(v[3]);
      m.string(v[4]);
      m.name(v[5], false);
      break;
    case "CAA":
      m.u8(v[0]);
      m.u8(v[1].length);
      m.raw(Buffer.from(v[1]));
      m.raw(Buffer.from(v[2]));
      break;
    case "TLSA":
      m.u8(v[0]);
      m.u8(v[1]);
      m.u8(v[2]);
      m.raw(v[3]);
      break;
    default:
      throw new Error(`no encoder for ${rec.t}`);
  }
  const length = m.bytes.length - lengthAt - 2;
  m.bytes[lengthAt] = (length >> 8) & 255;
  m.bytes[lengthAt + 1] = length & 255;
}

function parseQuery(buf) {
  if (buf.length < 17) return null;
  let at = 12;
  const labels = [];
  while (buf[at] !== 0) {
    labels.push(buf.toString("latin1", at + 1, at + 1 + buf[at]));
    at += 1 + buf[at];
  }
  at += 1;
  return {
    id: buf.readUInt16BE(0),
    flags: buf.readUInt16BE(2),
    name: labels.join("."),
    type: buf.readUInt16BE(at),
    class: buf.readUInt16BE(at + 2),
  };
}

/* ---------------------------------------------------------------- the zone */

const sha = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
const ZONE = {
  "a.test": [
    { t: "A", ttl: 300, v: "192.0.2.1" },
    { t: "A", ttl: 60, v: "192.0.2.2" },
  ],
  "dual.test": [
    { t: "A", ttl: 30, v: "198.51.100.7" },
    { t: "AAAA", ttl: 120, v: "2001:db8::1" },
    { t: "AAAA", ttl: 45, v: "2001:db8:0:0:1:0:0:2" },
  ],
  "www.test": [{ t: "CNAME", ttl: 100, v: "a.test" }],
  "chain.test": [{ t: "CNAME", ttl: 90, v: "www.test" }],
  "mx.test": [
    { t: "MX", ttl: 300, v: [20, "mail2.mx.test"] },
    { t: "MX", ttl: 300, v: [10, "mail1.mx.test"] },
    { t: "MX", ttl: 300, v: [5, "mail0.example.org"] },
  ],
  "ns.test": [
    { t: "NS", ttl: 3600, v: "ns1.ns.test" },
    { t: "NS", ttl: 3600, v: "ns2.ns.test" },
  ],
  "txt.test": [
    { t: "TXT", ttl: 10, v: ["v=spf1 include:_spf.txt.test -all"] },
    { t: "TXT", ttl: 10, v: ["part one, ", "part two"] },
    { t: "TXT", ttl: 10, v: [""] },
    { t: "TXT", ttl: 10, v: ["café ✓"] },
    { t: "TXT", ttl: 10, v: ["x".repeat(255), "y".repeat(3)] },
  ],
  "_sip._tcp.srv.test": [
    { t: "SRV", ttl: 200, v: [10, 60, 5060, "sip1.srv.test"] },
    { t: "SRV", ttl: 200, v: [20, 0, 5061, "sip2.srv.test"] },
    { t: "SRV", ttl: 200, v: [30, 5, 0, "."] },
  ],
  "soa.test": [{ t: "SOA", ttl: 900, v: ["ns1.soa.test", "hostmaster.soa.test", 2024010101, 7200, 3600, 1209600, 300] }],
  "naptr.test": [
    { t: "NAPTR", ttl: 50, v: [100, 10, "S", "SIP+D2U", "", "_sip._udp.naptr.test"] },
    { t: "NAPTR", ttl: 50, v: [200, 20, "u", "E2U+sip", "!^.*$!sip:info@naptr.test!", ""] },
  ],
  "caa.test": [
    { t: "CAA", ttl: 400, v: [0, "issue", "letsencrypt.org"] },
    { t: "CAA", ttl: 400, v: [128, "iodef", "mailto:security@caa.test"] },
    { t: "CAA", ttl: 400, v: [0, "issuewild", ";"] },
  ],
  "_443._tcp.tlsa.test": [{ t: "TLSA", ttl: 500, v: [3, 1, 1, sha] }],
  "1.2.0.192.in-addr.arpa": [
    { t: "PTR", ttl: 70, v: "host1.test" },
    { t: "PTR", ttl: 70, v: "host1-alias.test" },
  ],
  "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa": [{ t: "PTR", ttl: 70, v: "host6.test" }],
  "ptr.test": [{ t: "PTR", ttl: 70, v: "target.ptr.test" }],
  "any.test": [
    { t: "A", ttl: 11, v: "192.0.2.10" },
    { t: "AAAA", ttl: 12, v: "2001:db8::a" },
    { t: "MX", ttl: 13, v: [10, "mail.any.test"] },
    { t: "NS", ttl: 14, v: "ns.any.test" },
    { t: "TXT", ttl: 15, v: ["any", "text"] },
    { t: "SOA", ttl: 16, v: ["ns.any.test", "root.any.test", 1, 2, 3, 4, 5] },
    { t: "SRV", ttl: 17, v: [1, 2, 3, "srv.any.test"] },
    { t: "NAPTR", ttl: 18, v: [1, 2, "s", "svc", "", "repl.any.test"] },
    { t: "CAA", ttl: 19, v: [0, "issue", "ca.any.test"] },
  ],
  "cname-any.test": [
    { t: "CNAME", ttl: 20, v: "a.test" },
  ],
  "esc.test": [
    { t: "NS", ttl: 1, v: "a b.te$t" },
    { t: "NS", ttl: 1, v: 'q"r.(x);@.test' },
    { t: "NS", ttl: 1, v: "\u00fc.test" },
  ],
  "nodata.test": [{ t: "TXT", ttl: 10, v: ["only text here"] }],
  "trunc.test": [
    { t: "A", ttl: 25, v: "203.0.113.1" },
    { t: "A", ttl: 25, v: "203.0.113.2" },
    { t: "A", ttl: 25, v: "203.0.113.3" },
  ],
  "trunc-txt.test": Array.from({ length: 6 }, (_, i) => ({ t: "TXT", ttl: 5, v: [String(i).repeat(200), `end${i}`] })),
  "badid.test": [{ t: "A", ttl: 5, v: "203.0.113.50" }],
};

const RCODE = { "formerr.test": 1, "servfail.test": 2, "nx.test": 3, "notimp.test": 4, "refused.test": 5 };

/* ---------------------------------------------------------------- the server */

function respond(query, proto, ctx) {
  const name = query.name.toLowerCase();
  ctx.log.push(`${proto} ${TYPE_NAME[query.type] ?? query.type} ${name}`);
  if (ctx.behavior) {
    const special = ctx.behavior(name, query, proto);
    if (special !== undefined) return special;
  }
  if (name.endsWith("drop.test")) return null;
  const m = new Message();
  let rcode = RCODE[name] ?? 0;
  let tc = false;
  let answers = [];
  if (name === "trunc.test" || name === "trunc-txt.test") tc = proto === "udp";
  if (rcode === 0 && !tc) {
    let owner = name;
    for (let hops = 0; hops < 8 && ZONE[owner]; hops++) {
      const own = ZONE[owner].filter((r) => query.type === 255 || r.t === TYPE_NAME[query.type]);
      const cname = ZONE[owner].find((r) => r.t === "CNAME");
      for (const r of own) answers.push([owner, r]);
      if (cname && (query.type === 255 || TYPE_NAME[query.type] !== "CNAME") && !own.length) {
        answers.push([owner, cname]);
        owner = cname.v;
      } else break;
    }
    if (!ZONE[name] && !(name in RCODE)) rcode = 3;
  }
  if (tc) answers = [];
  m.u16(query.id);
  m.u16(0x8000 | 0x0100 | 0x0080 | (tc ? 0x0200 : 0) | rcode);
  m.u16(1);
  m.u16(answers.length);
  m.u16(0);
  m.u16(0);
  m.name(query.name);
  m.u16(query.type);
  m.u16(query.class);
  for (const [owner, r] of answers) writeRecord(m, owner, r);
  const reply = Buffer.from(m.bytes);
  if (name === "badid.test" && proto === "udp") {
    const wrong = Buffer.from(reply);
    wrong.writeUInt16BE((query.id + 1) & 0xffff, 0);
    return [wrong, reply];
  }
  return reply;
}

function startServer(behavior) {
  return new Promise((resolve, reject) => {
    const ctx = { log: [], behavior };
    const tcp = net.createServer((socket) => {
      let pending = Buffer.alloc(0);
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 2 && pending.length >= 2 + pending.readUInt16BE(0)) {
          const length = pending.readUInt16BE(0);
          const query = parseQuery(pending.subarray(2, 2 + length));
          pending = pending.subarray(2 + length);
          const reply = query && respond(query, "tcp", ctx);
          for (const r of [].concat(reply ?? [])) {
            const framed = Buffer.alloc(2 + r.length);
            framed.writeUInt16BE(r.length, 0);
            r.copy(framed, 2);
            socket.write(framed);
          }
        }
      });
    });
    const udp = dgram.createSocket("udp4");
    udp.on("message", (msg, rinfo) => {
      const query = parseQuery(msg);
      const reply = query && respond(query, "udp", ctx);
      for (const r of [].concat(reply ?? [])) udp.send(r, rinfo.port, rinfo.address);
    });
    tcp.on("error", reject);
    tcp.listen(0, "127.0.0.1", () => {
      const port = tcp.address().port;
      mockPorts.add(port);
      udp.on("error", reject);
      udp.bind(port, "127.0.0.1", () =>
        resolve({
          port,
          log: ctx.log,
          address: `127.0.0.1:${port}`,
          close: () => new Promise((done) => tcp.close(() => udp.close(done))),
        })
      );
    });
  });
}

/* ---------------------------------------------------------------- printing */

const plain = (value) =>
  JSON.stringify(value, (key, x) => {
    if (x instanceof ArrayBuffer) return { arrayBuffer: Buffer.from(x).toString("hex") };
    if (typeof x === "bigint") return String(x);
    if (x === undefined) return "<undefined>";
    return x;
  });
const failure = (e) => ({
  name: e.name,
  code: e.code,
  message: e.message,
  syscall: e.syscall,
  hostname: e.hostname,
  errno: e.errno === undefined ? "<undefined>" : e.errno,
  keys: Object.keys(e),
});

/** Runs a callback-style method and reports its outcome as one line. */
function call(label, target, method, ...args) {
  return new Promise((resolve) => {
    try {
      target[method](...args, (err, ...values) => {
        say(label, err ? ["error", failure(err)] : ["ok", ...values]);
        resolve();
      });
    } catch (e) {
      say(label, ["threw", failure(e)]);
      resolve();
    }
  });
}

async function promised(label, target, method, ...args) {
  try {
    const value = await target[method](...args);
    say(label, ["ok", value]);
  } catch (e) {
    say(label, ["error", failure(e)]);
  }
}

const sync = (label, fn) => {
  try {
    say(label, ["ok", fn()]);
  } catch (e) {
    say(label, ["threw", failure(e)]);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A server that answers every question with the given response code and nothing else. */
const answering = (rcode) => (name, query) => {
  const m = new Message();
  m.u16(query.id);
  m.u16(0x8000 | 0x0100 | rcode);
  m.u16(1);
  m.u16(0);
  m.u16(0);
  m.u16(0);
  m.name(query.name);
  m.u16(query.type);
  m.u16(query.class);
  return Buffer.from(m.bytes);
};

/* ---------------------------------------------------------------- the checks */

const METHODS = [
  ["resolve4", "a.test"],
  ["resolve6", "dual.test"],
  ["resolveAny", "any.test"],
  ["resolveCaa", "caa.test"],
  ["resolveCname", "www.test"],
  ["resolveMx", "mx.test"],
  ["resolveNaptr", "naptr.test"],
  ["resolveNs", "ns.test"],
  ["resolvePtr", "ptr.test"],
  ["resolveSoa", "soa.test"],
  ["resolveSrv", "_sip._tcp.srv.test"],
  ["resolveTlsa", "_443._tcp.tlsa.test"],
  ["resolveTxt", "txt.test"],
];

async function main() {
  const good = await startServer();

  say("--- module shape");
  const fns = [
    "lookup", "lookupService", "Resolver", "getDefaultResultOrder", "setDefaultResultOrder", "setServers", "getServers",
    "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs",
    "resolvePtr", "resolveSoa", "resolveSrv", "resolveTlsa", "resolveTxt", "reverse",
  ];
  say("functions", fns.map((k) => `${k}:${typeof dns[k]}`).join(" "));
  say("promises", fns.map((k) => `${k}:${typeof dns.promises[k]}`).join(" "));
  say("keys", Object.keys(dns).sort().join(" "));
  say("promise keys", Object.keys(dns.promises).sort().join(" "));
  say("constants", [dns.ADDRCONFIG, dns.V4MAPPED, dns.ALL, dns.NODATA, dns.NOTFOUND, dns.TIMEOUT, dns.CONNREFUSED, dns.CANCELLED]);
  say("same constants", dns.promises.NOTFOUND === dns.NOTFOUND, dns.promises.Resolver === dns.Resolver);
  say(
    "resolver methods",
    ["cancel", "getServers", "setServers", "setLocalAddress", "resolve", "reverse", ...fns.filter((k) => /^resolve./.test(k))]
      .map((k) => `${k}:${typeof Resolver.prototype[k]}:${typeof dns.promises.Resolver.prototype[k]}`)
      .join(" ")
  );
  say("resolver names", new Resolver().constructor.name, new dns.promises.Resolver().constructor.name);
  say("default order", dns.getDefaultResultOrder());
  say("promisified", typeof require("util").promisify(dns.lookup), typeof require("util").promisify(dns.lookupService));

  say("--- setServers, getServers");
  const r = new Resolver();
  r.setServers([good.address]);
  say("plain", r.getServers());
  r.setServers([
    "1.2.3.4", "8.8.8.8:53", "9.9.9.9:5353", "::1", "[::1]:5353", "[2001:db8::1]:53", "2001:0DB8:0:0:0:0:0:2", "[::1]",
    "::ffff:1.2.3.4", "0:0:0:0:0:0:0:1", "1:0:0:2:0:0:0:3", "1:0:0:2:0:0:3:4", "::", "1.2.3.4:0", "1.2.3.4:053", "::1:53",
    "fe80::1%eth0", "10.0.0.1", "10.0.0.1",
  ]);
  say("formats", r.getServers());
  r.setServers(["1.2.3.4", , "1.2.3.5"]);
  say("holes", r.getServers());
  r.setServers([]);
  say("empty", r.getServers());
  for (const bad of [
    ["not an address"], ["1.2.3.4:"], ["1.2.3.4:99999"], ["[::1]:65536"], [""], [42], "1.2.3.4", null, [["1.2.3.4"]],
    ["01.2.3.4"], ["localhost"], [" 1.2.3.4"], ["[::1"], ["[not]:53"], ["1.2.3.4:-1"],
  ]) {
    sync(`bad ${plain(bad)}`, () => r.setServers(bad));
  }
  say("kept after failure", r.getServers());
  r.setServers([good.address]);
  const twin = new Resolver();
  twin.setServers(["127.0.0.2:5300"]);
  say("independent", r.getServers().length, twin.getServers());

  say("--- Resolver options");
  for (const opts of [
    { timeout: -1 }, { timeout: "1" }, { timeout: 0 }, { timeout: -2 }, { tries: 0 }, { tries: 1.5 }, { tries: "2" },
    { timeout: 2 ** 31 }, { maxTimeout: 5000 }, { maxTimeout: -5 }, { maxTimeout: "x" }, { maxTimeout: 2 ** 33 }, "x", null, undefined, {},
  ]) {
    sync(`options ${plain(opts)}`, () => {
      new Resolver(opts);
      return "constructed";
    });
  }

  say("--- record types, callback API");
  for (const [method, name] of METHODS) await call(method, r, method, name);
  await call("A ttl", r, "resolve4", "a.test", { ttl: true });
  await call("A ttl truthy", r, "resolve4", "a.test", { ttl: 1 });
  await call("A ttl false", r, "resolve4", "a.test", { ttl: false });
  await call("A null options", r, "resolve4", "a.test", null);
  await call("A odd options", r, "resolve4", "a.test", 5);
  await call("A via cname", r, "resolve4", "www.test");
  await call("A via cname chain, ttl", r, "resolve4", "chain.test", { ttl: true });
  await call("A uppercase name", r, "resolve4", "A.TEST");
  await call("A trailing dot", r, "resolve4", "a.test.");
  await call("AAAA ttl", r, "resolve6", "dual.test", { ttl: true });
  await call("A of dual, ttl", r, "resolve4", "dual.test", { ttl: true });
  await call("CNAME chain", r, "resolveCname", "chain.test");
  await call("ANY of a.test", r, "resolveAny", "a.test");
  await call("ANY cname", r, "resolveAny", "cname-any.test");
  await call("TXT ttl is ignored", r, "resolveTxt", "txt.test", { ttl: true });
  await call("reverse v4", r, "reverse", "192.0.2.1");
  await call("reverse v6", r, "reverse", "2001:db8::1");
  await call("reverse v6 long", r, "reverse", "2001:0db8:0000:0000:0000:0000:0000:0001");
  say("escapes in names", await new Promise((done) => r.resolveNs("esc.test", (e, x) => done(e ? failure(e) : x))));

  say("--- resolve(name, rrtype)");
  await call("default", r, "resolve", "a.test");
  await call("callback second", r, "resolve", "mx.test", "MX");
  for (const [method, name] of METHODS) {
    await call(`resolve ${method.slice(7)}`, r, "resolve", name, method === "resolve4" ? "A" : method === "resolve6" ? "AAAA" : method.slice(7).toUpperCase());
  }
  await call("resolve lower-case type", r, "resolve", "a.test", "a");
  await call("resolve bad type", r, "resolve", "a.test", "BOGUS");
  await call("resolve prototype key", r, "resolve", "a.test", "constructor");

  say("--- record types, promise API");
  const pr = new dns.promises.Resolver();
  pr.setServers([good.address]);
  say("promise servers", pr.getServers().length);
  for (const [method, name] of METHODS) await promised(method, pr, method, name);
  await promised("A ttl", pr, "resolve4", "a.test", { ttl: true });
  await promised("AAAA ttl", pr, "resolve6", "dual.test", { ttl: true });
  await promised("resolve", pr, "resolve", "a.test");
  await promised("resolve MX", pr, "resolve", "mx.test", "MX");
  await promised("resolve ANY", pr, "resolve", "any.test", "ANY");
  await promised("reverse", pr, "reverse", "192.0.2.1");
  await promised("reverse v6", pr, "reverse", "2001:db8::1");

  say("--- failure modes");
  for (const [label, name] of [
    ["NXDOMAIN", "nx.test"],
    ["SERVFAIL", "servfail.test"],
    ["REFUSED", "refused.test"],
    ["NOTIMP", "notimp.test"],
    ["FORMERR", "formerr.test"],
    ["unknown name", "missing.test"],
    ["NODATA", "nodata.test"],
  ]) {
    for (const [method] of METHODS) await call(`${method} ${label}`, r, method, name);
    await promised(`A ${label} promise`, pr, "resolve4", name);
  }
  await call("A NODATA (other type only)", r, "resolve4", "nodata.test");
  await call("TXT NODATA", r, "resolveTxt", "a.test");
  await call("reverse NXDOMAIN", r, "reverse", "192.0.2.99");
  await call("reverse NODATA", r, "reverse", "192.0.2.98");
  await call("bad id then good", r, "resolve4", "badid.test");
  await call("empty name", r, "resolve4", "");
  await call("root name", r, "resolve4", ".");
  await call("long label", r, "resolve4", `${"x".repeat(64)}.test`);
  await call("longest label", r, "resolve4", `${"x".repeat(63)}.test`);
  await call("dotted", r, "resolve4", "a..test");
  await call("leading dot", r, "resolve4", ".a.test");
  await call("space", r, "resolve4", "a b.test");
  await call("too long", r, "resolve4", `${"a.".repeat(128)}x`);
  const nowhere = new Resolver();
  nowhere.setServers([]);
  await call("no servers", nowhere, "resolve4", "a.test");

  say("--- names on the wire");
  const names = [];
  const spy = await startServer((name, query) => void names.push(query.name));
  const sp = new Resolver({ timeout: 300, tries: 1 });
  sp.setServers([spy.address]);
  for (const name of ["UPPER.Case.TEST", "bücher.test", "x.test.", "_dmarc.a.test", "*.a.test", "-.test", "a.b.c.d.e.f.test"]) {
    await call(`sent ${name}`, sp, "resolve4", name);
  }
  say("server saw", names);
  await spy.close();

  say("--- argument checks");
  sync("no callback", () => r.resolve4("a.test"));
  sync("no callback, options", () => r.resolve4("a.test", { ttl: true }));
  sync("number name", () => r.resolve4(1234, () => {}));
  sync("both bad", () => r.resolve4(1234));
  sync("null name", () => r.resolve4(null, () => {}));
  sync("object name", () => r.resolve4({}, () => {}));
  sync("bad type arg", () => r.resolve("a.test", 5, () => {}));
  sync("resolve name only", () => r.resolve(1234));
  sync("resolve options object", () => r.resolve("a.test", { ttl: true }, () => {}));
  sync("reverse bad ip", () => r.reverse("not-an-ip", () => {}));
  for (const ip of ["1.2.3", "256.1.1.1", "1.2.3.4.5", " 192.0.2.1", "0177.0.0.1", "2001:db8:::1"]) {
    sync(`reverse ${plain(ip)}`, () => r.reverse(ip, () => {}));
  }
  sync("reverse no cb", () => r.reverse("192.0.2.1"));
  sync("reverse number", () => r.reverse(12, () => {}));
  await promised("promise number name", pr, "resolve4", 1234);
  await promised("promise reverse bad ip", pr, "reverse", "not-an-ip");
  await promised("promise reverse number", pr, "reverse", 5);
  await promised("promise bad type", pr, "resolve", "a.test", 5);
  await promised("promise unknown type", pr, "resolve", "a.test", "bogus");
  sync("bad order", () => dns.setDefaultResultOrder("sideways"));
  sync("order ipv4first", () => {
    dns.setDefaultResultOrder("ipv4first");
    return dns.getDefaultResultOrder();
  });
  sync("order ipv6first", () => {
    dns.setDefaultResultOrder("ipv6first");
    return dns.getDefaultResultOrder();
  });
  sync("order verbatim", () => {
    dns.setDefaultResultOrder("verbatim");
    return dns.getDefaultResultOrder();
  });
  sync("promises order", () => {
    dns.promises.setDefaultResultOrder("ipv4first");
    const seen = dns.promises.getDefaultResultOrder();
    dns.promises.setDefaultResultOrder("verbatim");
    return [seen, dns.getDefaultResultOrder()];
  });

  say("--- truncation, then TCP");
  good.log.length = 0;
  await call("trunc A", r, "resolve4", "trunc.test", { ttl: true });
  say("trunc queries", good.log.filter((l) => l.endsWith("trunc.test")));
  good.log.length = 0;
  await promised("trunc TXT", pr, "resolveTxt", "trunc-txt.test");
  say("trunc queries", good.log.filter((l) => l.endsWith("trunc-txt.test")));
  const udpOnly = require("dgram").createSocket("udp4");
  await new Promise((resolve) => udpOnly.bind(0, "127.0.0.1", resolve));
  udpOnly.on("message", (msg, rinfo) => {
    const q = parseQuery(msg);
    udpOnly.send(respond(q, "udp", { log: [] }), rinfo.port, rinfo.address);
  });
  const noTcp = new Resolver({ timeout: 300, tries: 1 });
  noTcp.setServers([`127.0.0.1:${udpOnly.address().port}`]);
  await call("truncated, nothing on TCP", noTcp, "resolve4", "trunc.test");
  udpOnly.close();

  say("--- one answer settles it");
  for (const [label, rcode] of [["SERVFAIL", 2], ["REFUSED", 5], ["NOTIMP", 4], ["FORMERR", 1], ["NXDOMAIN", 3]]) {
    const bad = await startServer(answering(rcode));
    const multi = new Resolver({ timeout: 200, tries: 2 });
    multi.setServers([bad.address, good.address]);
    good.log.length = 0;
    await call(`${label} first`, multi, "resolve4", "a.test");
    say(`${label} server saw`, bad.log.length, "good server saw", good.log.length);
    await bad.close();
  }

  say("--- timeouts and the next server");
  const drops = await startServer();
  const patient = new Resolver({ timeout: 120, tries: 2 });
  patient.setServers([drops.address]);
  const started = Date.now();
  await call("silent server", patient, "resolve4", "drop.test");
  const waited = Date.now() - started;
  say("waited between 100ms and 8s", waited >= 100 && waited < 8000);
  say("silent server saw", drops.log.length, "queries");
  const promiseTimeout = new dns.promises.Resolver({ timeout: 100, tries: 1 });
  promiseTimeout.setServers([drops.address]);
  await promised("silent server promise", promiseTimeout, "resolveMx", "drop.test");
  const both = new Resolver({ timeout: 150, tries: 2 });
  both.setServers([drops.address, good.address]);
  for (const name of ["a.test", "www.test", "mx.test"]) {
    drops.log.length = 0;
    good.log.length = 0;
    await call(`silent first, ${name}`, both, "resolve4", name);
    say("silent saw", drops.log.length, "answering saw", good.log.length);
  }
  const bothSilent = new Resolver({ timeout: 80, tries: 2 });
  const second = await startServer();
  bothSilent.setServers([drops.address, second.address]);
  drops.log.length = 0;
  second.log.length = 0;
  await call("two silent servers", bothSilent, "resolve4", "drop.test");
  say("each saw", drops.log.length, second.log.length);
  await drops.close();
  await second.close();

  say("--- odd answers");
  const odd = await startServer((name, query) => {
    const header = (flags, questions = 1, answers = 0) => {
      const m = new Message();
      m.u16(query.id);
      m.u16(flags);
      m.u16(questions);
      m.u16(answers);
      m.u16(0);
      m.u16(0);
      return m;
    };
    const question = (m, qname = query.name, qtype = query.type) => {
      m.name(qname);
      m.u16(qtype);
      m.u16(query.class);
    };
    if (name === "wrongq.test") {
      const m = header(0x8180, 1, 1);
      question(m, "other.test");
      writeRecord(m, "other.test", { t: "A", v: "1.1.1.1" });
      return Buffer.from(m.bytes);
    }
    if (name === "wrongt.test") {
      const m = header(0x8180, 1, 1);
      question(m, query.name, 28);
      writeRecord(m, name, { t: "A", v: "1.1.1.1" });
      return Buffer.from(m.bytes);
    }
    if (name === "short.test") return Buffer.from([query.id >> 8, query.id & 255, 0x81, 0x80]);
    if (name === "cut.test") {
      const m = header(0x8180, 1, 1);
      question(m);
      writeRecord(m, name, { t: "A", v: "1.1.1.1" });
      return Buffer.from(m.bytes.slice(0, -2));
    }
    if (name === "loop.test") {
      const m = header(0x8180, 1, 1);
      question(m);
      const at = m.bytes.length;
      m.u16(0xc000 | at);
      m.u16(1);
      m.u16(1);
      m.u32(5);
      m.u16(4);
      m.raw([1, 2, 3, 4]);
      return Buffer.from(m.bytes);
    }
    if (name === "zeroq.test") return Buffer.from(header(0x8180, 0).bytes);
    if (name === "aaaa-for-a.test") {
      const m = header(0x8180, 1, 1);
      question(m);
      writeRecord(m, name, { t: "AAAA", v: "::1" });
      return Buffer.from(m.bytes);
    }
    if (name === "other.test" || name === "othertxt.test") {
      const m = header(0x8180, 1, 1);
      question(m);
      if (query.type === 16) writeRecord(m, name, { t: "A", v: "1.2.3.4" });
      else writeRecord(m, name, { t: "TXT", v: ["x"] });
      return Buffer.from(m.bytes);
    }
    if (name === "two.test") {
      const m = header(0x8180, 1, 2);
      question(m);
      writeRecord(m, name, { t: "A", v: "1.1.1.1" });
      writeRecord(m, name, { t: "A", v: "2.2.2.2", ttl: 9 });
      return Buffer.from(m.bytes);
    }
    return undefined;
  });
  const o = new Resolver({ timeout: 250, tries: 1 });
  o.setServers([odd.address]);
  for (const n of ["wrongq.test", "wrongt.test", "short.test", "cut.test", "loop.test", "zeroq.test", "aaaa-for-a.test", "two.test"]) {
    await call(`A ${n}`, o, "resolve4", n);
  }
  for (const [method] of METHODS) await call(`${method} other`, o, method, "other.test");
  await call("TXT of an A answer", o, "resolveTxt", "othertxt.test");
  await odd.close();

  say("--- cancel");
  const slow = await startServer();
  const canceller = new Resolver({ timeout: 5000, tries: 1 });
  canceller.setServers([slow.address]);
  let ranInCancel = "not run";
  const waiting = [
    call("cancelled A", canceller, "resolve4", "drop.test"),
    call("cancelled MX", canceller, "resolveMx", "drop.test"),
  ];
  const pc = new dns.promises.Resolver({ timeout: 5000, tries: 1 });
  pc.setServers([slow.address]);
  const pending = promised("cancelled TXT promise", pc, "resolveTxt", "drop.test");
  await sleep(50);
  const probe = new Resolver({ timeout: 5000, tries: 1 });
  probe.setServers([slow.address]);
  probe.resolve4("drop.test", () => {
    ranInCancel = "ran";
  });
  await sleep(30);
  probe.cancel();
  say("callback ran inside cancel()", ranInCancel);
  canceller.cancel();
  pc.cancel();
  await Promise.all([...waiting, pending]);
  await sleep(10);
  say("callback ran after cancel()", ranInCancel);
  say("cancel with nothing pending", (() => {
    try {
      canceller.cancel();
      return "ok";
    } catch (e) {
      return e.code;
    }
  })());
  await call("usable after cancel", canceller, "resolve4", "a.test");
  await slow.close();

  say("--- setLocalAddress");
  const local = new Resolver();
  local.setServers([good.address]);
  sync("local v4", () => local.setLocalAddress("127.0.0.1"));
  await call("through local address", local, "resolve4", "a.test");
  for (const args of [
    ["127.0.0.1", "::1"], ["::1", "127.0.0.1"], ["127.0.0.1", undefined], ["0.0.0.0"], ["127.0.0.1", ""], ["", ""], ["1.2.3.4", "1.2.3.4"],
    ["::1", "::1"], ["127.0.0.1", null], ["127.0.0.1", "nope"], ["nope"], ["1.2.3"], [" 127.0.0.1"], [5], [], [undefined, "::1"],
  ]) {
    sync(`local ${plain(args)}`, () => local.setLocalAddress(...args));
  }
  local.setLocalAddress("127.0.0.1");
  await call("through local address again", local, "resolve4", "mx.test");

  say("--- module-level functions and the default servers");
  dns.setServers([good.address]);
  say("module servers", dns.getServers().length, dns.promises.getServers().length);
  await call("dns.resolve4", dns, "resolve4", "a.test");
  await call("dns.resolve", dns, "resolve", "mx.test", "MX");
  await call("dns.resolveTxt", dns, "resolveTxt", "txt.test");
  await call("dns.reverse", dns, "reverse", "192.0.2.1");
  await promised("dns.promises.resolve4", dns.promises, "resolve4", "a.test");
  await promised("dns.promises.reverse", dns.promises, "reverse", "192.0.2.1");
  const alt = await startServer();
  dns.promises.setServers([alt.address]);
  say("after promises.setServers", dns.getServers()[0] === good.address, dns.promises.getServers()[0] === alt.address);
  good.log.length = 0;
  alt.log.length = 0;
  await call("callback module still uses its own", dns, "resolve4", "a.test");
  await promised("promise module uses its own", dns.promises, "resolve4", "a.test");
  say("saw", good.log.length, alt.log.length);
  dns.setServers([good.address]);
  say("dns.setServers sets both", dns.promises.getServers()[0] === good.address);
  await alt.close();
  const fresh = new Resolver();
  say("a new Resolver is not affected", fresh.getServers()[0] === good.address);

  say("--- lookup, without touching the network");
  await call("lookup ipv4 literal", dns, "lookup", "127.0.0.1");
  await call("lookup ipv6 literal", dns, "lookup", "::1");
  await call("lookup literal all", dns, "lookup", "192.0.2.5", { all: true });
  await call("lookup literal family 4", dns, "lookup", "192.0.2.5", { family: 4 });
  await call("lookup literal wrong family", dns, "lookup", "192.0.2.5", { family: 6 });
  await call("lookup literal family string", dns, "lookup", "::1", { family: "IPv6" });
  await call("lookup literal numeric option", dns, "lookup", "192.0.2.5", 4);
  await call("lookup literal with zone", dns, "lookup", "fe80::1%eth0");
  await call("lookup localhost v4", dns, "lookup", "localhost", { family: 4 });
  await promised("lookup promise literal", dns.promises, "lookup", "203.0.113.9");
  await promised("lookup promise all", dns.promises, "lookup", "203.0.113.9", { all: true });
  await promised("lookup promise localhost", dns.promises, "lookup", "localhost", { family: 4 });
  sync("lookup bad family", () => dns.lookup("localhost", { family: 5 }, () => {}));
  sync("lookup bad family string", () => dns.lookup("localhost", { family: "IPv7" }, () => {}));
  sync("lookup bad family number", () => dns.lookup("localhost", 7, () => {}));
  sync("lookup fractional family", () => dns.lookup("localhost", { family: 4.5 }, () => {}));
  sync("lookup bad hints", () => dns.lookup("localhost", { hints: 1024 }, () => {}));
  sync("lookup hints type", () => dns.lookup("localhost", { hints: "x" }, () => {}));
  sync("lookup no callback", () => dns.lookup("localhost"));
  sync("lookup bad hostname", () => dns.lookup(5, () => {}));
  sync("lookup bad options", () => dns.lookup("localhost", "x", () => {}));
  sync("lookup bad all", () => dns.lookup("localhost", { all: "yes" }, () => {}));
  sync("lookup bad verbatim", () => dns.lookup("localhost", { verbatim: "x" }, () => {}));
  sync("lookup bad order", () => dns.lookup("localhost", { order: "sideways" }, () => {}));
  sync("lookup null options", () => dns.lookup("127.0.0.1", null, () => {}) && "accepted");
  sync("lookup verbatim false", () => dns.lookup("127.0.0.1", { verbatim: false }, () => {}) && "accepted");
  sync("lookup all hints", () => dns.lookup("127.0.0.1", { hints: dns.ADDRCONFIG | dns.V4MAPPED | dns.ALL }, () => {}) && "accepted");

  say("--- lookupService");
  await call("service ssh", dns, "lookupService", "127.0.0.1", 22);
  await call("service unassigned port", dns, "lookupService", "127.0.0.1", 65000);
  await call("service string port", dns, "lookupService", "127.0.0.1", "80");
  await promised("service promise", dns.promises, "lookupService", "127.0.0.1", 443);
  sync("service bad address", () => dns.lookupService("nope", 80, () => {}));
  sync("service bad port", () => dns.lookupService("127.0.0.1", 70000, () => {}));
  sync("service string port", () => dns.lookupService("127.0.0.1", "abc", () => {}));
  sync("service blank port", () => dns.lookupService("127.0.0.1", " ", () => {}));
  sync("service negative port", () => dns.lookupService("127.0.0.1", -1, () => {}));
  sync("service no args", () => dns.lookupService());
  sync("service no callback", () => dns.lookupService("127.0.0.1", 80));
  sync("service no callback, one arg", () => dns.lookupService("127.0.0.1"));
  sync("service not a function", () => dns.lookupService("127.0.0.1", 80, 5));
  await promised("service promise bad port", dns.promises, "lookupService", "127.0.0.1", -1);
  await promised("service promise bad address", dns.promises, "lookupService", "x", 1);
  await promised("service promise no port", dns.promises, "lookupService", "127.0.0.1");

  say("--- everything closed");
  await good.close();
  for (const l of out) console.log(l);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log(out.join("\n"));
    console.log("FAILED", e && e.stack);
    process.exit(1);
  }
);

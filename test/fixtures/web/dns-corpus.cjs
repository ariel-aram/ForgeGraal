// dns and dns/promises differential corpus with in-process mock DNS server. Must match Node.js.
const dgram = require("node:dgram");
const dns = require("node:dns");

const out = [];
const say = (...args) =>
	out.push(
		args
			.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
			.join(" ")
	);

function encodeName(name) {
	const parts = name.split(".");
	const buf = [];
	for (const p of parts) {
		buf.push(p.length);
		for (let i = 0; i < p.length; i++) buf.push(p.charCodeAt(i));
	}
	buf.push(0);
	return Buffer.from(buf);
}

const server = dgram.createSocket("udp4");
server.on("message", (msg, rinfo) => {
	const id = msg.readUInt16BE(0);
	let pos = 12;
	const labels = [];
	while (pos < msg.length && msg[pos] !== 0) {
		const len = msg[pos++];
		labels.push(msg.toString("utf8", pos, pos + len));
		pos += len;
	}
	pos++;
	const qname = labels.join(".");
	const qtype = msg.readUInt16BE(pos);
	pos += 4;
	const question = msg.slice(12, pos);

	if (qname.startsWith("notfound")) {
		const resp = Buffer.alloc(12 + question.length);
		resp.writeUInt16BE(id, 0);
		resp.writeUInt16BE(0x8183, 2); // NXDOMAIN
		resp.writeUInt16BE(1, 4);
		question.copy(resp, 12);
		return server.send(resp, rinfo.port, rinfo.address);
	}

	if (qname.startsWith("nodata")) {
		const resp = Buffer.alloc(12 + question.length);
		resp.writeUInt16BE(id, 0);
		resp.writeUInt16BE(0x8180, 2); // NoError, ANCOUNT = 0
		resp.writeUInt16BE(1, 4);
		question.copy(resp, 12);
		return server.send(resp, rinfo.port, rinfo.address);
	}

	let rdata = null;
	if (qtype === 1) {
		// A
		rdata = Buffer.from([192, 0, 2, 1]);
	} else if (qtype === 28) {
		// AAAA
		rdata = Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
	} else if (qtype === 5) {
		// CNAME
		rdata = encodeName("target.example.com");
	} else if (qtype === 15) {
		// MX
		rdata = Buffer.concat([Buffer.from([0, 10]), encodeName("smtp.example.com")]);
	} else if (qtype === 16) {
		// TXT
		const txt1 = Buffer.from("v=spf1 ~all");
		const txt2 = Buffer.from("extra");
		rdata = Buffer.concat([Buffer.from([txt1.length]), txt1, Buffer.from([txt2.length]), txt2]);
	} else if (qtype === 2) {
		// NS
		rdata = encodeName("ns1.example.com");
	} else if (qtype === 12) {
		// PTR
		rdata = encodeName("ptr.example.com");
	}

	if (!rdata) return;

	const header = Buffer.alloc(12);
	header.writeUInt16BE(id, 0);
	header.writeUInt16BE(0x8180, 2);
	header.writeUInt16BE(1, 4);
	header.writeUInt16BE(1, 6);

	const answerHead = Buffer.alloc(10);
	answerHead.writeUInt16BE(0xc00c, 0);
	answerHead.writeUInt16BE(qtype, 2);
	answerHead.writeUInt16BE(1, 4);
	answerHead.writeUInt32BE(300, 6);

	const answerLen = Buffer.alloc(2);
	answerLen.writeUInt16BE(rdata.length, 0);

	const total = Buffer.concat([header, question, answerHead, answerLen, rdata]);
	server.send(total, rinfo.port, rinfo.address);
});

server.bind(0, "127.0.0.1", async () => {
	const port = server.address().port;
	dns.setServers(["127.0.0.1:" + port]);
	say("getServers", dns.getServers().map((s) => s.replace(/:\d+$/, ":PORT")));

	// Callback methods
	await new Promise((resolve) => {
		dns.resolve4("test.example.com", (err, res) => {
			say("resolve4", err, res);
			dns.resolve4("test.example.com", { ttl: true }, (err, res) => {
				say("resolve4-ttl", err, res);
				dns.resolve6("test.example.com", (err, res) => {
					say("resolve6", err, res);
					dns.resolve6("test.example.com", { ttl: true }, (err, res) => {
						say("resolve6-ttl", err, res);
						dns.resolveCname("cname.example.com", (err, res) => {
							say("resolveCname", err, res);
							dns.resolveMx("mail.example.com", (err, res) => {
								say("resolveMx", err, res);
								dns.resolveTxt("txt.example.com", (err, res) => {
									say("resolveTxt", err, res);
									dns.resolveNs("ns.example.com", (err, res) => {
										say("resolveNs", err, res);
										dns.resolvePtr("1.2.0.192.in-addr.arpa", (err, res) => {
											say("resolvePtr", err, res);
											dns.reverse("192.0.2.1", (err, res) => {
												say("reverse", err, res);
												dns.resolve4("notfound.example.com", (err) => {
													say("notfound", err?.code, err?.syscall);
													dns.resolve4("nodata.example.com", (err) => {
														say("nodata", err?.code, err?.syscall);
														resolve();
													});
												});
											});
										});
									});
								});
							});
						});
					});
				});
			});
		});
	});

	// Lookup
	await new Promise((resolve) => {
		dns.lookup("localhost", (err, address, family) => {
			say("lookup-localhost", err, address, family);
			dns.lookup("localhost", { all: true }, (err, addresses) => {
				say("lookup-localhost-all", err, addresses);
				dns.lookup("192.0.2.99", (err, address, family) => {
					say("lookup-ipv4", err, address, family);
					dns.lookup("::1", (err, address, family) => {
						say("lookup-ipv6", err, address, family);
						dns.lookupService("127.0.0.1", 80, (err, host, service) => {
							say("lookupService-80", err, host, service);
							dns.lookupService("127.0.0.1", 443, (err, host, service) => {
								say("lookupService-443", err, host, service);
								resolve();
							});
						});
					});
				});
			});
		});
	});

	// Promises API
	const p = dns.promises;
	say("p-resolve4", await p.resolve4("test.example.com"));
	say("p-resolve6", await p.resolve6("test.example.com"));
	say("p-resolveTxt", await p.resolveTxt("txt.example.com"));
	say("p-lookup", await p.lookup("localhost"));

	// Resolver class
	const resolver = new dns.Resolver();
	resolver.setServers(["127.0.0.1:" + port]);
	say("resolver-servers", resolver.getServers().map((s) => s.replace(/:\d+$/, ":PORT")));
	await new Promise((resolve) => {
		resolver.resolve4("test.example.com", (err, res) => {
			say("resolver-resolve4", err, res);
			resolve();
		});
	});

	// Promises Resolver class
	const pResolver = new dns.promises.Resolver();
	pResolver.setServers(["127.0.0.1:" + port]);
	say("pResolver-resolve4", await pResolver.resolve4("test.example.com"));

	// Result orders
	say("defaultResultOrder", dns.getDefaultResultOrder());
	dns.setDefaultResultOrder("ipv4first");
	say("after-setDefaultResultOrder", dns.getDefaultResultOrder());
	dns.setDefaultResultOrder("verbatim");

	// Constants
	say("constants", dns.NOTFOUND, dns.NODATA, dns.SERVFAIL, dns.TIMEOUT, typeof dns.ADDRCONFIG);

	server.close(() => {
		for (const line of out) console.log(line);
	});
});

// Exercises the http server and client end to end. Every line printed must be identical under Node.js.
const http = require("http");
const net = require("net");
const crypto = require("crypto");

const out = [];
const log = (...parts) => out.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));

const big = Buffer.alloc(1024 * 1024 + 123);
for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
const bigHash = crypto.createHash("sha256").update(big).digest("hex");

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		const body = Buffer.concat(chunks);
		const url = new URL(req.url, "http://x");
		if (url.pathname === "/echo") {
			res.writeHead(200, { "Content-Type": "application/json", "X-Method": req.method });
			res.end(JSON.stringify({ method: req.method, len: body.length, text: body.toString("utf8").slice(0, 40), ct: req.headers["content-type"] || null, q: url.search }));
		} else if (url.pathname === "/hash") {
			res.end(crypto.createHash("sha256").update(body).digest("hex"));
		} else if (url.pathname === "/big") {
			res.setHeader("Content-Length", big.length);
			res.end(big);
		} else if (url.pathname === "/stream") {
			res.write("one,");
			setTimeout(() => {
				res.write("two,");
				res.end("three");
			}, 10);
		} else if (url.pathname === "/headers") {
			res.setHeader("Set-Cookie", ["a=1", "b=2"]);
			res.setHeader("X-Multi", ["x", "y"]);
			res.removeHeader("X-Nope");
			res.statusCode = 201;
			res.statusMessage = "Made It";
			res.end(JSON.stringify({ has: res.hasHeader("set-cookie"), names: res.getHeaderNames().sort(), sent: res.headersSent }));
		} else if (url.pathname === "/head") {
			res.setHeader("Content-Length", 5);
			res.end("hello");
		} else if (url.pathname === "/204") {
			res.statusCode = 204;
			res.end();
		} else if (url.pathname === "/redirect") {
			res.writeHead(302, { Location: "/echo?redirected=1" });
			res.end();
		} else {
			res.statusCode = 404;
			res.end("nope");
		}
	});
});

function request(options, body) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: server.address().port, ...options }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, message: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks), raw: res.rawHeaders.length }));
			res.on("error", reject);
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

function raw(text) {
	return new Promise((resolve) => {
		const socket = net.connect(server.address().port, "127.0.0.1", () => socket.write(text));
		const chunks = [];
		socket.on("data", (c) => chunks.push(c));
		socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
		socket.on("error", () => resolve(Buffer.concat(chunks).toString("latin1")));
	});
}

const strip = (text) => text.replace(/Date: [^\r]*/g, "Date: -").replace(/Keep-Alive: [^\r]*\r\n/g, "");

server.listen(0, "127.0.0.1", async () => {
	try {
		let r = await request({ path: "/echo?a=1" });
		log("GET", r.status, r.message, r.body.toString(), r.headers["x-method"], r.headers["content-type"]);

		r = await request({ path: "/echo", method: "POST", headers: { "Content-Type": "text/plain" } }, "hello world");
		log("POST", r.status, r.body.toString(), r.headers["content-length"] || r.headers["transfer-encoding"]);

		r = await request({ path: "/hash", method: "PUT", headers: { "Content-Length": big.length } }, big);
		log("PUT big", r.body.toString() === bigHash);

		r = await request({ path: "/big" });
		log("GET big", r.status, r.body.length, crypto.createHash("sha256").update(r.body).digest("hex") === bigHash, r.headers["content-length"]);

		r = await request({ path: "/stream" });
		log("stream", r.body.toString(), r.headers["transfer-encoding"]);

		r = await request({ path: "/headers" });
		log("headers", r.status, r.message, r.body.toString(), r.headers["set-cookie"], r.headers["x-multi"]);

		r = await request({ path: "/head", method: "HEAD" });
		log("HEAD", r.status, r.body.length, r.headers["content-length"]);

		r = await request({ path: "/204" });
		log("204", r.status, r.body.length);

		r = await request({ path: "/missing" });
		log("404", r.status, r.body.toString());

		r = await request({ path: "/redirect" });
		log("redirect", r.status, r.headers.location);

		log("raw http/1.0", strip(await raw("GET /echo HTTP/1.0\r\n\r\n")).split("\r\n\r\n")[0]);
		log("raw pipelined", (strip(await raw("GET /echo?n=1 HTTP/1.1\r\nHost: x\r\n\r\nGET /echo?n=2 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")).match(/"q":"\?n=\d"/g) || []).join(","));
		log("raw chunked upload", strip(await raw("POST /hash HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n")).split("\r\n\r\n")[1]);
		log("raw garbage", strip(await raw("THIS IS NOT HTTP\r\n\r\n")).split("\r\n")[0]);
		log("raw 100-continue", strip(await raw("POST /hash HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc")).split("\r\n")[0]);
	} catch (error) {
		log("FAILED", String(error && error.stack));
	}
	server.close(() => {
		log("closed");
		console.log(out.join("\n"));
	});
});

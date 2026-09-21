// An https server with a self-signed certificate, and clients that talk to it. Identical under Node.js.
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const options = {
	key: fs.readFileSync(path.join(__dirname, "test-key.pem")),
	cert: fs.readFileSync(path.join(__dirname, "test-cert.pem")),
};
const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));

const server = https.createServer(options, (req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ secure: Boolean(req.socket.encrypted), method: req.method, body: Buffer.concat(chunks).toString(), url: req.url }));
	});
});

server.listen(0, "127.0.0.1", async () => {
	const port = server.address().port;
	const get = (opts, body) =>
		new Promise((resolve, reject) => {
			const req = https.request({ host: "127.0.0.1", port, rejectUnauthorized: false, ...opts }, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
			});
			req.on("error", reject);
			req.end(body);
		});
	try {
		log("get", await get({ path: "/hello" }));
		log("post", await get({ path: "/p", method: "POST" }, "secret payload"));
		const big = "x".repeat(200000);
		const r = await get({ path: "/big", method: "POST" }, big);
		log("big", JSON.parse(r.body).body.length);
		try {
			await get({ path: "/", rejectUnauthorized: true });
		} catch (e) {
			log("untrusted certificate rejected", Boolean(e.code || e.message));
		}
		// raw TLS socket
		await new Promise((resolve) => {
			const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
				socket.write("GET /raw HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
			});
			const chunks = [];
			socket.on("data", (c) => chunks.push(c));
			socket.on("close", () => {
				const text = Buffer.concat(chunks).toString();
				log("raw tls", text.split("\r\n")[0], text.includes('"secure":true'));
				resolve();
			});
		});
	} catch (error) {
		log("FAILED", String(error && error.stack));
	}
	server.close(() => {
		console.log(out.join("\n"));
		process.exit(0);
	});
	server.closeAllConnections?.();
});

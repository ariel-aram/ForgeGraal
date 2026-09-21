// The Fetch API against a local server. Every line printed must be identical under Node.js.
const http = require("http");
const zlib = require("zlib");

const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		const body = Buffer.concat(chunks);
		const path = req.url.split("?")[0];
		if (path === "/json") {
			res.setHeader("Content-Type", "application/json");
			res.setHeader("Set-Cookie", ["a=1", "b=2"]);
			res.end(JSON.stringify({ hello: "world", n: [1, 2, 3] }));
		} else if (path === "/echo") {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ method: req.method, body: body.toString(), ct: req.headers["content-type"] || null, len: req.headers["content-length"] || null, x: req.headers["x-test"] || null }));
		} else if (path === "/r1") {
			res.writeHead(302, { Location: "/r2" });
			res.end();
		} else if (path === "/r2") {
			res.writeHead(301, { Location: "/json" });
			res.end();
		} else if (path === "/post-redirect") {
			res.writeHead(303, { Location: "/echo" });
			res.end();
		} else if (path === "/gzip") {
			res.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "text/plain" });
			res.end(zlib.gzipSync("compressed ".repeat(50)));
		} else if (path === "/slow") {
			res.write("part1");
			setTimeout(() => res.end("part2"), 200);
		} else if (path === "/status/404") {
			res.writeHead(404, "Nope", { "Content-Type": "text/plain" });
			res.end("missing");
		} else if (path === "/empty") {
			res.statusCode = 204;
			res.end();
		} else if (path === "/form") {
			res.end(JSON.stringify({ ct: (req.headers["content-type"] || "").split(";")[0], hasBoundary: /boundary=/.test(req.headers["content-type"] || ""), body: body.toString().replace(/----[^\r\n]*/g, "--B").replace(/\r\n/g, "|") }));
		} else {
			res.end("ok");
		}
	});
});

server.listen(0, "127.0.0.1", async () => {
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		let r = await fetch(`${base}/json`);
		log("json", r.status, r.statusText, r.ok, r.headers.get("content-type"), r.headers.getSetCookie(), await r.json(), r.bodyUsed, r.redirected, r.url.replace(base, ""));

		r = await fetch(`${base}/echo`, { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "Content-Type": "application/json", "X-Test": "yes" } });
		log("post json", await r.json());

		r = await fetch(`${base}/echo`, { method: "PUT", body: new URLSearchParams({ a: "1", b: "x y" }) });
		log("urlsearchparams", await r.json());

		r = await fetch(`${base}/echo`, { method: "POST", body: "plain" });
		log("string body", await r.json());

		r = await fetch(`${base}/echo`, { method: "POST", body: new Uint8Array([104, 105]) });
		log("bytes body", await r.json());

		const form = new FormData();
		form.append("field", "value");
		form.append("file", new Blob(["file-content"], { type: "text/plain" }), "a.txt");
		r = await fetch(`${base}/form`, { method: "POST", body: form });
		log("formdata", await r.json());

		r = await fetch(`${base}/r1`);
		log("redirect follow", r.status, r.redirected, r.url.replace(base, ""), (await r.json()).hello);

		r = await fetch(`${base}/r1`, { redirect: "manual" });
		log("redirect manual", r.status, r.headers.get("location"));

		try { await fetch(`${base}/r1`, { redirect: "error" }); } catch (e) { log("redirect error", e.name, e.message); }

		r = await fetch(`${base}/post-redirect`, { method: "POST", body: "data" });
		log("303 becomes GET", (await r.json()).method);

		r = await fetch(`${base}/gzip`);
		log("gzip", (await r.text()).length, r.headers.get("content-encoding"));

		r = await fetch(`${base}/status/404`);
		log("404", r.status, r.statusText, r.ok, await r.text());

		r = await fetch(`${base}/empty`);
		log("204", r.status, await r.text());

		// streaming body
		r = await fetch(`${base}/slow`);
		const seen = [];
		for await (const chunk of r.body) seen.push(Buffer.from(chunk).toString());
		log("stream", seen.join(""), seen.length >= 1);

		// clone and body reuse
		r = await fetch(`${base}/json`);
		const c = r.clone();
		log("clone", (await r.json()).hello, (await c.text()).length);
		try { await r.text(); } catch (e) { log("reuse", e.name, e.message.includes("used") || e.message.includes("unusable")); }

		// abort
		const controller = new AbortController();
		const p = fetch(`${base}/slow`, { signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		try { await p; log("abort: resolved"); } catch (e) { log("abort", e.name); }

		// network failure
		try { await fetch("http://127.0.0.1:1/"); } catch (e) { log("refused", e.name, e.message, Boolean(e.cause)); }

		// Request / Response / Headers unit behaviour
		const req = new Request("http://example.com/a?b=1", { method: "post", headers: { A: "1" }, body: "x" });
		log("Request", req.method, req.url, req.headers.get("a"), await req.text());
		log("Response.json", await Response.json({ a: 1 }, { status: 201 }).text(), Response.json({}).headers.get("content-type"));
		log("Response.redirect", Response.redirect("http://e.com/x", 301).status, Response.redirect("http://e.com/x").headers.get("location"));
		const h = new Headers({ b: "2", A: "1" });
		h.append("a", "3");
		h.append("Set-Cookie", "x=1");
		h.append("Set-Cookie", "y=2");
		log("Headers", [...h], h.get("A"), h.has("B"), h.getSetCookie());
		try { new Headers({ "bad name": "x" }); } catch (e) { log("bad header", e.name); }
		try { new Response("x", { status: 99 }); } catch (e) { log("bad status", e.name); }
		try { new Request("/relative"); } catch (e) { log("relative", e.name); }
		const blob = await new Response("blobby", { headers: { "content-type": "text/x-t" } }).blob();
		log("blob", blob.size, blob.type);
		log("text encodings", await new Response(new TextEncoder().encode("héllo")).text(), (await new Response("héllo").arrayBuffer()).byteLength);
	} catch (error) {
		log("FAILED", String(error && error.stack));
	}
	server.close(() => {
		console.log(out.join("\n"));
		process.exit(0);
	});
	server.closeAllConnections?.();
});

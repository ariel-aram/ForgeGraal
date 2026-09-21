const out: string[] = [];
const say = (...a: unknown[]) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
let listening: Deno.NetAddr | undefined;
const server = Deno.serve(
	{ port: 0, hostname: "127.0.0.1", onListen: (a) => (listening = a as Deno.NetAddr) },
	async (req, info) => {
		const url = new URL(req.url);
		if (url.pathname === "/json") return Response.json({ method: req.method, q: url.searchParams.get("q") });
		if (url.pathname === "/echo")
			return new Response(await req.text(), { status: 201, headers: { "x-echo": "1", "content-type": "text/plain" } });
		if (url.pathname === "/stream") {
			const enc = new TextEncoder();
			return new Response(
				new ReadableStream({
					async start(c) {
						for (let i = 0; i < 3; i++) {
							c.enqueue(enc.encode(`chunk${i};`));
							await new Promise((r) => setTimeout(r, 5));
						}
						c.close();
					},
				})
			);
		}
		if (url.pathname === "/headers") {
			const h = new Headers({ "content-type": "text/html" });
			h.append("set-cookie", "a=1");
			h.append("set-cookie", "b=2");
			return new Response("<p>hi</p>", { headers: h });
		}
		if (url.pathname === "/ip") return new Response(String(typeof info.remoteAddr.port));
		if (url.pathname === "/throw") throw new Error("boom");
		if (url.pathname === "/redirect") return Response.redirect(new URL("/json?q=r", req.url), 302);
		return new Response("not found", { status: 404 });
	}
);
await new Promise((r) => setTimeout(r, 50));
const base = `http://127.0.0.1:${listening!.port}`;
say("addr", server.addr.port === listening!.port, server.addr.transport);
const j = await fetch(`${base}/json?q=x`);
say("json", j.status, j.headers.get("content-type"), await j.json());
const e = await fetch(`${base}/echo`, { method: "POST", body: "payload" });
say("echo", e.status, e.headers.get("x-echo"), await e.text());
say("stream", await (await fetch(`${base}/stream`)).text());
const h = await fetch(`${base}/headers`);
say("headers", h.headers.get("content-type"), h.headers.getSetCookie(), await h.text());
say("ip", await (await fetch(`${base}/ip`)).text());
const t = await fetch(`${base}/throw`);
say("throw", t.status, await t.text());
const r = await fetch(`${base}/redirect`);
say("redirect", r.status, r.redirected, await r.json());
say("404", (await fetch(`${base}/nope`)).status);
say("head", (await fetch(`${base}/json`, { method: "HEAD" })).status);
await server.shutdown();
say("shutdown", (await server.finished) === undefined);
for (const l of out) console.log(l);

const out: string[] = [];
const say = (...a: unknown[]) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
let port = 0;
const server = Deno.serve(
	{ port: 0, hostname: "127.0.0.1", onListen: (a) => (port = (a as Deno.NetAddr).port) },
	(req) => {
		if (req.headers.get("upgrade") !== "websocket") return new Response("plain");
		const { socket, response } = Deno.upgradeWebSocket(req);
		socket.onopen = () => socket.send("welcome");
		socket.onmessage = (e) => {
			if (typeof e.data === "string") socket.send(`echo:${e.data}`);
			else socket.send(new Uint8Array(e.data as ArrayBuffer).length.toString());
			if (e.data === "bye") socket.close(1000, "done");
		};
		return response;
	}
);
await new Promise((r) => setTimeout(r, 50));
const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
ws.binaryType = "arraybuffer";
const got: string[] = [];
await new Promise<void>((resolve, reject) => {
	ws.onerror = () => reject(new Error("ws error"));
	ws.onmessage = (e) => {
		got.push(String(e.data));
		if (got.length === 1) {
			ws.send("one");
			ws.send(new Uint8Array(70000));
			ws.send("bye");
		}
		if (got.length === 4) resolve();
	};
});
say("messages", got);
const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
	ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
});
say("close", closed, ws.readyState);
say("plain", await (await fetch(`http://127.0.0.1:${port}/`)).text());
await server.shutdown();
for (const l of out) console.log(l);

// Deno.listen/connect over a unix-domain socket, and UDP datagrams.
const out: string[] = [];
const dir = await Deno.makeTempDir({ prefix: "graak-sock-" });
const say = (...a: unknown[]) =>
	out.push(
		a
			.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
			.join(" ")
			.replaceAll(dir, "<dir>")
	);
const path = `${dir}/echo.sock`;
const listener = Deno.listen({ transport: "unix", path });
say("listener", listener.addr);
let serverSaw = "";
const serving = (async () => {
	for await (const conn of listener) {
		const buf = new Uint8Array(64);
		const n = await conn.read(buf);
		await conn.write(new TextEncoder().encode(`echo:${new TextDecoder().decode(buf.subarray(0, n!))}`));
		serverSaw = `${conn.remoteAddr.transport} ${(await Deno.stat(path)).isSocket ?? "stat"}`;
		conn.close();
		break;
	}
})();
const conn = await Deno.connect({ transport: "unix", path });
await conn.write(new TextEncoder().encode("over unix"));
const buf = new Uint8Array(64);
const n = await conn.read(buf);
say("client got", new TextDecoder().decode(buf.subarray(0, n!)), conn.remoteAddr);
say("eof", await conn.read(buf));
conn.close();
await serving;
say("server sees", serverSaw);
try {
	await Deno.connect({ transport: "unix", path: `${dir}/absent.sock` });
} catch (e) {
	say("absent", (e as Error).name);
}
try {
	Deno.listen({ transport: "unix", path: `${dir}/x/y/z.sock` });
	await new Promise((r) => setTimeout(r, 50));
	say("bad dir", "accepted");
} catch (e) {
	say("bad dir", (e as Error).name);
}

// UDP
const server = Deno.listenDatagram({ port: 0, hostname: "127.0.0.1", transport: "udp" });
await new Promise((r) => setTimeout(r, 50));
const port = (server.addr as Deno.NetAddr).port;
say("udp bound", (server.addr as Deno.NetAddr).hostname, port > 0);
const client = Deno.listenDatagram({ port: 0, hostname: "127.0.0.1", transport: "udp" });
await new Promise((r) => setTimeout(r, 50));
const sent = await client.send(new TextEncoder().encode("ping"), { transport: "udp", hostname: "127.0.0.1", port });
say("sent", sent);
const [data, from] = await server.receive();
say(
	"server received",
	new TextDecoder().decode(data),
	(from as Deno.NetAddr).hostname,
	(from as Deno.NetAddr).port === (client.addr as Deno.NetAddr).port
);
await server.send(new TextEncoder().encode("pong"), from);
const [reply] = await client.receive();
say("client received", new TextDecoder().decode(reply));
const big = new Uint8Array(8000).fill(7);
await client.send(big, { transport: "udp", hostname: "127.0.0.1", port });
const [bigData] = await server.receive(new Uint8Array(9000));
say("large datagram", bigData.length, bigData[0], bigData[7999]);
client.close();
server.close();
try {
	await server.receive();
} catch (e) {
	say("closed", (e as Error).name);
}
await Deno.remove(dir, { recursive: true });
for (const l of out) console.log(l);

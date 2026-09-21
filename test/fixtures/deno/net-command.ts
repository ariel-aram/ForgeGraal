const out: string[] = [];
const say = (...a: unknown[]) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
// TCP echo server and client
const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
const port = (listener.addr as Deno.NetAddr).port;
const serverDone = (async () => {
	for await (const conn of listener) {
		const buf = new Uint8Array(64);
		const n = await conn.read(buf);
		await conn.write(new TextEncoder().encode(`echo:${new TextDecoder().decode(buf.subarray(0, n!))}`));
		conn.close();
		break;
	}
})();
const conn = await Deno.connect({ hostname: "127.0.0.1", port });
await conn.write(new TextEncoder().encode("ping"));
const reply = new Uint8Array(64);
const n = await conn.read(reply);
say("tcp", new TextDecoder().decode(reply.subarray(0, n!)), (conn.remoteAddr as Deno.NetAddr).port === port);
say("eof", await conn.read(reply));
conn.close();
await serverDone;
try {
	await Deno.connect({ hostname: "127.0.0.1", port: 1 });
} catch (e) {
	say("refused", (e as Error).name, e instanceof Deno.errors.ConnectionRefused);
}

// Deno.Command
const echo = await new Deno.Command("sh", { args: ["-c", "echo out; echo err >&2; exit 3"] }).output();
say(
	"output",
	echo.success,
	echo.code,
	new TextDecoder().decode(echo.stdout).trim(),
	new TextDecoder().decode(echo.stderr).trim()
);
const sync = new Deno.Command("sh", { args: ["-c", "printf abc"], stdout: "piped" }).outputSync();
say("sync", sync.code, new TextDecoder().decode(sync.stdout));
const child = new Deno.Command("cat", { stdin: "piped", stdout: "piped" }).spawn();
const w = child.stdin.getWriter();
await w.write(new TextEncoder().encode("through cat"));
await w.close();
const status = await child.status;
say("spawn", status.code, typeof child.pid);
const env = await new Deno.Command("sh", { args: ["-c", "echo $GRAAK_CHILD"], env: { GRAAK_CHILD: "yes" } }).output();
say("env", new TextDecoder().decode(env.stdout).trim());
try {
	new Deno.Command("graak-no-such-program").outputSync();
} catch (e) {
	say("missing", (e as Error).name);
}
for (const l of out) console.log(l);

// child_process streaming stdio and fork(): live pipes, stdin, signals, ordering and the IPC channel.
// Must print exactly what Node.js prints. The same file is the forked child (`process.argv[2] === "child"`).
const cp = require("child_process");

if (process.argv[2] === "child") {
	// The forked side: report what it sees, echo what it is sent, leave when told to.
	process.send({
		ready: true,
		args: process.argv.slice(2),
		execArgv: process.execArgv,
		connected: process.connected,
		send: typeof process.send,
		disconnect: typeof process.disconnect,
		channelEnv: process.env.NODE_CHANNEL_FD === undefined,
	});
	process.on("message", (m) => {
		if (m === "bye") process.disconnect();
		else if (m === "exit7") process.exit(7);
		else if (m === "log") {
			console.log("child says hi");
			console.error("child says oops");
			process.send("logged");
		} else if (m === "spin") setInterval(() => {}, 1000);
		else process.send({ echo: m });
	});
	process.on("disconnect", () => {
		// Nothing to print: the parent observes the end of this process.
	});
} else {
	main().catch((error) => {
		console.log("FAILED", error && error.stack);
	});
}

async function main() {
	const out = [];
	const say = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
	const wait = (emitter, event) => new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const closed = (child) => wait(child, "close");
	// Resolves with the 'exit' arguments once the child has also closed; call it before the events can happen.
	const exited = (child) =>
		new Promise((resolve) => {
			let args;
			child.once("exit", (...a) => (args = a));
			child.once("close", () => resolve(args));
		});

	// ---- spawn: output arrives while the child runs ---------------------------------------------------------------
	{
		const child = cp.spawn("sh", ["-c", "echo first; sleep 0.4; echo second"]);
		const t0 = Date.now();
		const seen = [];
		child.stdout.on("data", (d) => seen.push([String(d), Date.now() - t0]));
		await closed(child);
		say("live", seen.map((s) => s[0]), seen.length, seen[0][1] < 300, seen[1][1] >= 300);
		say("pid", typeof child.pid, child.pid > 0, child.spawnfile, child.spawnargs);
	}

	// ---- spawn: stdin fed while the child runs ---------------------------------------------------------------------
	{
		const child = cp.spawn("cat");
		let got = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d) => (got += d));
		child.stdin.write("one ");
		await sleep(80);
		child.stdin.write("two ");
		await sleep(80);
		child.stdin.end("three");
		const [code, signal] = await closed(child);
		say("stdin", got, code, signal);
	}
	{
		const child = cp.spawn("sh", ["-c", "read a; read b; echo got:$a:$b"]);
		let got = "";
		child.stdout.on("data", (d) => (got += d));
		child.stdin.write("x\n");
		child.stdin.end("y\n");
		await closed(child);
		say("read lines", got.trim());
	}

	// ---- events: 'exit' then 'close', data before close ------------------------------------------------------------
	{
		const child = cp.spawn("sh", ["-c", "echo x; echo y >&2; exit 4"]);
		const order = [];
		child.stdout.on("data", () => order.push("out"));
		child.stderr.on("data", () => order.push("err"));
		child.on("exit", (code, signal) => order.push(`exit ${code} ${signal}`));
		child.on("close", (code, signal) => order.push(`close ${code} ${signal}`));
		await closed(child);
		say("order", order.filter((e) => e.startsWith("exit") || e.startsWith("close")), order.slice(-1)[0].startsWith("close"));
		say("codes", child.exitCode, child.signalCode, child.killed);
	}

	// ---- signals ---------------------------------------------------------------------------------------------------
	{
		const child = cp.spawn("sleep", ["30"]);
		const done = exited(child);
		await sleep(50);
		const sent = child.kill();
		const [code, signal] = await done;
		say("kill", sent, code, signal, child.killed, child.signalCode, child.kill());
	}
	{
		const child = cp.spawn("sleep", ["30"]);
		const done = exited(child);
		await sleep(50);
		child.kill("SIGKILL");
		say("sigkill", await done);
	}
	{
		const child = cp.spawn("sleep", ["30"]);
		const done = exited(child);
		await sleep(50);
		child.kill(2);
		say("numeric", await done);
		try {
			cp.spawn("sleep", ["1"]).kill("SIGNOPE");
		} catch (error) {
			say("bad signal", error.code, error.message);
		}
	}
	{
		const child = cp.spawn("sh", ["-c", "kill -TERM $$"]);
		say("self signal", await closed(child));
	}
	{
		const child = cp.spawn("sh", ["-c", "trap 'echo trapped; exit 9' USR1; echo ready; while :; do sleep 0.05; done"]);
		let got = "";
		child.stdout.on("data", (d) => {
			got += d;
			if (got === "ready\n") child.kill("SIGUSR1");
		});
		const [code, signal] = await closed(child);
		say("caught", got, code, signal);
	}

	// ---- stdio modes -----------------------------------------------------------------------------------------------
	{
		const child = cp.spawn("sh", ["-c", "echo ignored; echo ignored >&2; exit 2"], { stdio: "ignore" });
		say("ignore", child.stdin, child.stdout, child.stderr, await closed(child));
	}
	{
		const child = cp.spawn("sh", ["-c", "echo inherited"], { stdio: ["ignore", "inherit", "inherit"] });
		say("inherit", child.stdout, await closed(child));
	}
	{
		const child = cp.spawn("sh", ["-c", "echo out; echo err >&2"], { stdio: ["ignore", "pipe", "ignore"] });
		let got = "";
		child.stdout.on("data", (d) => (got += d));
		await closed(child);
		say("mixed", got.trim(), child.stdin, child.stderr);
	}
	{
		const child = cp.spawn("cat", { stdio: ["pipe", "pipe", "inherit"] });
		child.stdin.end("");
		say("empty stdin", await closed(child), child.stdio.length);
	}

	// ---- volume, encodings, async iteration --------------------------------------------------------------------------
	{
		const child = cp.spawn("sh", ["-c", "head -c 3000000 /dev/zero; echo done >&2"]);
		let bytes = 0;
		child.stdout.on("data", (d) => (bytes += d.length));
		let err = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (d) => (err += d));
		await closed(child);
		say("volume", bytes, err.trim());
	}
	{
		const child = cp.spawn("cat");
		const done = closed(child);
		child.stdout.setEncoding("utf8");
		const big = "é".repeat(200000);
		child.stdin.end(big);
		let got = "";
		for await (const chunk of child.stdout) got += chunk;
		say("big echo", got.length, got === big);
		await done;
	}
	{
		const child = cp.spawn("sh", ["-c", "printf 'a\\nb\\nc\\n'"]);
		const done = closed(child);
		const lines = [];
		let buffered = "";
		child.stdout.setEncoding("utf8");
		for await (const chunk of child.stdout) buffered += chunk;
		lines.push(...buffered.trim().split("\n"));
		say("iterate", lines);
		await done;
	}
	{
		const child = cp.spawn("sh", ["-c", "yes | head -n 2000 | wc -l"]);
		let got = "";
		child.stdout.on("data", (d) => (got += d));
		say("sigpipe default", (await closed(child))[0], got.trim());
	}
	{
		const child = cp.spawn("sh", ["-c", "echo $GRAAK_SPAWN_ENV; pwd"], { cwd: "/", env: { ...process.env, GRAAK_SPAWN_ENV: "seen" } });
		let got = "";
		child.stdout.on("data", (d) => (got += d));
		await closed(child);
		say("env cwd", got.trim().split("\n"));
	}
	{
		const child = cp.spawn("echo $((6*7))", { shell: true });
		let got = "";
		child.stdout.on("data", (d) => (got += d));
		await closed(child);
		say("shell", got.trim());
	}

	// ---- spawn errors ----------------------------------------------------------------------------------------------
	{
		const child = cp.spawn("graak-no-such-program", ["a"]);
		const events = [];
		child.on("error", (e) => events.push(["error", e.code, e.syscall, e.path, e.errno, e.spawnargs, e.message]));
		child.on("close", (code) => events.push(["close", code]));
		await closed(child);
		say("missing", events, child.pid);
	}
	{
		const child = cp.spawn("sh", ["-c", "exit 0"], { cwd: "/graak-no-such-dir" });
		const events = [];
		child.on("error", (e) => events.push(["error", e.code]));
		await closed(child);
		say("bad cwd", events);
	}

	// ---- fork ------------------------------------------------------------------------------------------------------
	say("top level", typeof process.send, process.connected, typeof process.disconnect);
	{
		const child = cp.fork(__filename, ["child", "arg two"], { execArgv: ["--no-warnings"] });
		const messages = [];
		child.on("message", (m) => messages.push(m));
		say("fork", typeof child.pid, child.connected, typeof child.send, child instanceof cp.ChildProcess);
		const [first] = await wait(child, "message");
		say("ready", first);
		const samples = [
			"plain",
			42,
			null,
			true,
			{ nested: { list: [1, "two", { three: 3 }] }, text: "line\nbreak é 中 😀" },
			[1, 2, 3],
			"",
		];
		for (const sample of samples) {
			child.send(sample);
			const [reply] = await wait(child, "message");
			say("echo", reply);
		}
		const big = "x".repeat(300000);
		child.send(big);
		const [bigReply] = await wait(child, "message");
		say("big", bigReply.echo.length, bigReply.echo === big);
		const before = messages.length;
		for (let i = 0; i < 50; i++) child.send({ i });
		while (messages.length < before + 50) await wait(child, "message");
		say("ordered", messages.slice(before).map((m) => m.echo.i).every((v, i) => v === i), messages.length - before);
		const acked = await new Promise((resolve) => child.send("cb", (error) => resolve(error)));
		say("send callback", acked);
		await wait(child, "message");
		try {
			child.send(undefined);
		} catch (error) {
			say("send undefined", error.code);
		}
		const events = [];
		child.on("disconnect", () => events.push("disconnect"));
		child.on("exit", (code, signal) => events.push(`exit ${code} ${signal}`));
		child.on("close", (code, signal) => events.push(`close ${code} ${signal}`));
		child.send("bye");
		await closed(child);
		say("bye", events.filter((e) => e !== "disconnect"), events.includes("disconnect"), events.at(-1).startsWith("close"), child.connected);
		const failure = await new Promise((resolve) => child.send("late", (error) => resolve(error && error.code)));
		say("send after", failure);
	}
	{
		const child = cp.fork(__filename, ["child"], { silent: true });
		await wait(child, "message");
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.send("log");
		await wait(child, "message");
		const done = exited(child);
		child.send("exit7");
		const [code, signal] = await done;
		say("silent", out, err, code, signal, child.connected);
	}
	{
		const child = cp.fork(__filename, ["child"]);
		await wait(child, "message");
		const done = exited(child);
		child.send("spin");
		await sleep(50);
		child.kill();
		const [code, signal] = await done;
		say("kill fork", code, signal, child.killed);
	}
	{
		const child = cp.fork(__filename, ["child"]);
		await wait(child, "message");
		// (Node never emits 'close' after the parent's own disconnect(), so only 'exit' is awaited.)
		const done = wait(child, "exit");
		child.disconnect();
		say("disconnect", child.connected);
		const [code] = await done;
		say("child left", code);
	}
	{
		const child = cp.fork(__filename, ["child"], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
		await wait(child, "message");
		say("stdio pipes", child.stdin !== null, child.stdout !== null, child.stderr !== null, child.connected);
		child.send("bye");
		await closed(child);
	}
	try {
		cp.fork(__filename, ["child"], { stdio: ["inherit", "inherit", "inherit"] });
	} catch (error) {
		say("no ipc", error.code);
	}

	for (const line of out) console.log(line);
}

// child_process streaming stdio and fork() written to run on Windows as well as POSIX: the same output must come from Node.js on
// Linux and from the Windows host under Wine. Only `spawn` differs by platform (cmd.exe against sh), and it prints normalised results.
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

	const win = process.platform === "win32";
	const norm = (text) => String(text).replace(/\r\n/g, "\n");
	// ---- spawn: output arrives while the child runs -----------------------------------------------------------------
	{
		const child = win
			? cp.spawn("cmd", ["/d", "/c", "echo first& ping -n 2 127.0.0.1 >nul& echo second"])
			: cp.spawn("sh", ["-c", "echo first; sleep 1; echo second"]);
		let text = "";
		child.stdout.on("data", (d) => (text += d));
		const [code, signal] = await closed(child);
		say("live", norm(text).replace(/ \n/g, "\n"), code, signal);
	}
	// ---- spawn: stdin is fed while the child runs ---------------------------------------------------------------------
	{
		// The child reads a line, then leaves: output only after the parent has written, so stdin reached it.
		const child = win ? cp.spawn("cmd", ["/d", "/c", "set /p a=& echo got"]) : cp.spawn("sh", ["-c", "read a; echo got"]);
		let got = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d) => (got += d));
		await sleep(150);
		child.stdin.end("one\n");
		const [code, signal] = await closed(child);
		say("stdin", JSON.stringify(norm(got).trim()), code, signal);
	}
	// ---- spawn: exit code and a program that is not there -------------------------------------------------------------
	{
		const child = win ? cp.spawn("cmd", ["/d", "/c", "exit 4"]) : cp.spawn("sh", ["-c", "exit 4"]);
		const args = await exited(child);
		say("exit", args);
		const missing = cp.spawn("no-such-program-graak");
		const [error] = await wait(missing, "error");
		say("enoent", error.code, error.syscall);
	}
	// ---- kill ---------------------------------------------------------------------------------------------------------
	{
		const child = win ? cp.spawn("cmd", ["/d", "/c", "set /p x="]) : cp.spawn("sleep", ["30"]);
		await sleep(300);
		say("kill", child.kill(), child.killed);
		const [code, signal] = await closed(child);
		say("killed", [code, signal]);
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

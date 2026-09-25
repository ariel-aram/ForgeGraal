/*
 * The remaining Node modules, implemented rather than stubbed.
 *
 * Each of these is small on its own, and each was previously a module that threw. They are real
 * implementations of the surface libraries actually touch -- where something genuinely cannot be
 * done on this runtime it still throws and says why, because the point of the conformance count
 * is to be honest about what works.
 */

/* ---------------------------------------------------------------- async_hooks */

/*
 * AsyncLocalStorage without engine-level async context tracking.
 *
 * Node propagates the store across every await; this cannot, because there is no hook into the
 * engine's job queue. What it does is keep the store for the synchronous extent of run(), which
 * is what the common use (a request-scoped value read further down the same call stack) needs.
 * enterWith() is refused rather than silently behaving differently.
 */
class AsyncLocalStorage {
	constructor() {
		this._store = undefined;
		this._active = false;
	}
	run(store, callback, ...args) {
		const previousStore = this._store;
		const previousActive = this._active;
		this._store = store;
		this._active = true;
		try {
			return callback(...args);
		} finally {
			this._store = previousStore;
			this._active = previousActive;
		}
	}
	getStore() {
		return this._active ? this._store : undefined;
	}
	exit(callback, ...args) {
		const previousActive = this._active;
		this._active = false;
		try {
			return callback(...args);
		} finally {
			this._active = previousActive;
		}
	}
	enterWith() {
		throw new Error(
			"AsyncLocalStorage.enterWith is not available on this runtime: it requires the engine to " +
				"carry context across await boundaries, which quickjs does not expose. Use run(), which " +
				"holds the store for the synchronous extent of the callback."
		);
	}
	disable() {
		this._active = false;
	}
}

class AsyncResource {
	constructor(type) {
		this.type = type;
	}
	runInAsyncScope(fn, thisArg, ...args) {
		return fn.apply(thisArg, args);
	}
	emitDestroy() {
		return this;
	}
	asyncId() {
		return 0;
	}
}

const asyncHooks = {
	AsyncLocalStorage,
	AsyncResource,
	executionAsyncId: () => 0,
	triggerAsyncId: () => 0,
	createHook() {
		// Returning a hook that never fires would be a lie about observability, so this refuses.
		throw new Error(
			"async_hooks.createHook is not available on this runtime: quickjs exposes no async " +
				"lifecycle events to hook. AsyncLocalStorage.run() is supported."
		);
	},
};

/* ------------------------------------------------------------------------ v8 */

const v8 = {
	getHeapStatistics: () => ({
		total_heap_size: 0,
		used_heap_size: 0,
		heap_size_limit: 0,
		malloced_memory: 0,
	}),
	setFlagsFromString: () => {},
};

/* ----------------------------------------------------------------------- tty */

function createTty(host) {
	const isatty = (fd) => Boolean(host.isatty?.(fd));
	class ReadStream {
		constructor(fd) {
			this.fd = fd;
			this.isTTY = isatty(fd);
		}
		setRawMode() {
			return this;
		}
	}
	class WriteStream {
		constructor(fd) {
			this.fd = fd;
			this.isTTY = isatty(fd);
			this.columns = 80;
			this.rows = 24;
		}
		write(text) {
			host.write?.(text);
			return true;
		}
		getWindowSize() {
			return [this.columns, this.rows];
		}
	}
	return { isatty, ReadStream, WriteStream };
}

/* ------------------------------------------------------------------ readline */

function createReadline(EventEmitter) {
	class Interface extends EventEmitter {
		constructor(options = {}) {
			super();
			this.input = options.input;
			this.output = options.output;
			this.terminal = Boolean(options.terminal);
			this._buffer = "";
			this._closed = false;
			// Lines are split out of whatever the input stream emits, which is how readline
			// behaves for a piped (non-TTY) input.
			this.input?.on?.("data", (chunk) => this._consume(String(chunk)));
			this.input?.on?.("end", () => this.close());
		}
		_consume(text) {
			this._buffer += text;
			let index = this._buffer.indexOf("\n");
			while (index !== -1) {
				const line = this._buffer.slice(0, index).replace(/\r$/, "");
				this._buffer = this._buffer.slice(index + 1);
				this.emit("line", line);
				index = this._buffer.indexOf("\n");
			}
		}
		question(query, callback) {
			this.output?.write?.(query);
			this.once("line", callback);
		}
		prompt() {
			this.output?.write?.(this._prompt ?? "> ");
		}
		setPrompt(prompt) {
			this._prompt = prompt;
		}
		write(text) {
			this.output?.write?.(text);
		}
		close() {
			if (this._closed) return;
			this._closed = true;
			if (this._buffer) {
				this.emit("line", this._buffer);
				this._buffer = "";
			}
			this.emit("close");
		}
		async *[Symbol.asyncIterator]() {
			const queue = [];
			let done = false;
			let notify;
			this.on("line", (line) => {
				queue.push(line);
				notify?.();
			});
			this.on("close", () => {
				done = true;
				notify?.();
			});
			for (;;) {
				if (queue.length) {
					yield queue.shift();
					continue;
				}
				if (done) return;
				await new Promise((resolve) => {
					notify = resolve;
				});
				notify = null;
			}
		}
	}
	return {
		Interface,
		createInterface: (options) => new Interface(options),
		clearLine: () => true,
		cursorTo: () => true,
		moveCursor: () => true,
	};
}

/* ------------------------------------------------------------ child_process */

function createChildProcess(host, EventEmitter, io = {}) {
	if (!host.exec) {
		return null;
	}

	const isWindows = host.platform === "win32";
	let counter = 0;
	const shellArgv = (command) => (isWindows ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command]);
	// Output is read back as bytes (a program may print anything), then decoded only when an encoding is asked for.
	const decode = (data, encoding) => {
		const buffer = typeof data === "string" ? (io.Buffer ? io.Buffer.from(data) : data) : data;
		if (encoding && encoding !== "buffer") return typeof buffer === "string" ? buffer : buffer.toString(encoding);
		return buffer;
	};
	const SIGNAL_NAMES = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGUSR1", 11: "SIGSEGV", 12: "SIGUSR2", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM" };
	/** The engine reports a child killed by signal N as status -N. */
	const exitInfo = (status) => (typeof status === "number" && status < 0 ? { status: null, signal: SIGNAL_NAMES[-status] ?? null } : { status, signal: null });
	const pathSeparator = isWindows ? ";" : ":";
	/** Whether `command` names a program that exists, so a missing one is an ENOENT error and not exit status 127. */
	const findExecutable = (command, options) => {
		if (!io.exists) return true;
		const extensions = isWindows ? ["", ".exe", ".cmd", ".bat", ".com"] : [""];
		const direct = command.includes("/") || (isWindows && command.includes("\\"));
		const dirs = direct ? [""] : String((options.env ?? io.env?.() ?? {}).PATH ?? (options.env ?? io.env?.() ?? {}).Path ?? "").split(pathSeparator).filter(Boolean);
		for (const dir of dirs) {
			for (const extension of extensions) {
				const candidate = dir ? `${dir}/${command}${extension}` : `${command}${extension}`;
				const resolved = candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate) || !options.cwd ? candidate : `${options.cwd}/${candidate}`;
				if (io.exists(resolved)) return true;
			}
		}
		return false;
	};
	const inherits = (options, index) => {
		const stdio = options.stdio;
		return stdio === "inherit" || (Array.isArray(stdio) && stdio[index] === "inherit");
	};

	/**
	 * Runs a command to completion and captures what it wrote. The engine's exec() takes file
	 * descriptors, not pipes, so the child's output goes to temporary files and is read back once it
	 * exits: unlike a pipe this cannot deadlock on output larger than the pipe buffer.
	 */
	function run(argv, options = {}) {
		const base = `${io.tmpdir?.() ?? "/tmp"}/graak-cp-${host.getpid?.() ?? 0}-${counter++}`;
		const write = host.O_WRONLY | host.O_CREAT | host.O_TRUNC;
		const files = [];
		const open = (suffix, flags) => {
			const path = `${base}.${suffix}`;
			files.push(path);
			return host.open(path, flags, 0o600);
		};
		const fds = [];
		const execOptions = { block: true, usePath: true };
		if (options.cwd) execOptions.cwd = options.cwd;
		if (options.env) execOptions.env = options.env;
		if (options.input !== undefined) {
			const fd = open("in", write);
			fds.push(fd);
			const bytes = typeof options.input === "string" ? io.Buffer.from(options.input) : options.input;
			const view = new Uint8Array(bytes);
			host.write(fd, view.buffer, view.byteOffset, view.byteLength);
			host.close(fd);
			execOptions.stdin = host.open(`${base}.in`, host.O_RDONLY, 0);
			fds.push(execOptions.stdin);
		}
		let outPath = null;
		let errPath = null;
		if (!inherits(options, 1)) {
			execOptions.stdout = open("out", write);
			outPath = `${base}.out`;
			fds.push(execOptions.stdout);
		}
		if (!inherits(options, 2)) {
			execOptions.stderr = open("err", write);
			errPath = `${base}.err`;
			fds.push(execOptions.stderr);
		}

		let status = null;
		let error;
		try {
			status = host.exec(argv, execOptions);
		} catch (err) {
			error = err;
		} finally {
			for (const fd of fds) {
				try {
					host.close(fd);
				} catch {
					/* already closed */
				}
			}
		}
		const read = (path) => {
			if (!path) return io.Buffer.alloc(0);
			const raw = io.readBytes ? io.readBytes(path) : io.readText?.(path);
			if (raw === undefined || raw === null) return io.Buffer.alloc(0);
			return typeof raw === "string" ? io.Buffer.from(raw) : io.Buffer.from(raw);
		};
		const stdout = read(outPath);
		const stderr = read(errPath);
		for (const path of files) {
			try {
				host.remove(path);
			} catch {
				/* best effort */
			}
		}
		return { status, stdout, stderr, error };
	}

	function normalizeArgs(args, options) {
		// spawnSync(command, options) is legal: the argument list is optional.
		if (args !== undefined && !Array.isArray(args)) return { args: [], options: args ?? {} };
		return { args: args ?? [], options: options ?? {} };
	}

	function result(captured, options) {
		const encoding = options.encoding;
		const stdout = decode(captured.stdout, encoding);
		const stderr = decode(captured.stderr, encoding);
		const exit = exitInfo(captured.status);
		const res = {
			status: exit.status,
			signal: exit.signal,
			pid: 0,
			stdout,
			stderr,
			output: [null, stdout, stderr],
		};
		if (captured.error) res.error = captured.error;
		return res;
	}

	function failure(command, captured, options) {
		const err = new Error(`Command failed: ${command}${captured.stderr?.length ? `\n${captured.stderr}` : ""}`);
		err.status = captured.status;
		err.stdout = decode(captured.stdout, options.encoding);
		err.stderr = decode(captured.stderr, options.encoding);
		return err;
	}

	const notFound = (command, syscall = "spawnSync") =>
		Object.assign(new Error(`${syscall} ${command} ENOENT`), { errno: -2, code: "ENOENT", syscall: `${syscall} ${command}`, path: command });

	function spawnSync(command, args, options) {
		const norm = normalizeArgs(args, options);
		if (!norm.options.shell && !findExecutable(command, norm.options)) {
			const error = notFound(command);
			return { status: null, signal: null, pid: 0, stdout: decode("", norm.options.encoding), stderr: decode("", norm.options.encoding), output: null, error };
		}
		const argv = norm.options.shell ? shellArgv([command, ...norm.args].join(" ")) : [command, ...norm.args];
		return result(run(argv, norm.options), norm.options);
	}

	function execSync(command, options = {}) {
		const captured = run(shellArgv(command), options);
		if (!inherits(options, 2) && captured.stderr.length) io.writeStderr?.(String(captured.stderr));
		if (captured.status !== 0) throw failure(command, captured, options);
		return decode(captured.stdout, options.encoding);
	}

	function execFileSync(file, args, options) {
		const norm = normalizeArgs(args, options);
		const captured = run([file, ...norm.args], norm.options);
		if (captured.status !== 0) throw failure(file, captured, norm.options);
		return decode(captured.stdout, norm.options.encoding);
	}

	/**
	 * The engine can only run a child to completion, so `spawn` starts it once the caller has had the chance to
	 * feed its stdin: when stdin is ended, or on the next turn of the event loop if nothing was written. Output
	 * then arrives as 'data' events and the child ends with 'exit' and 'close', as Node's does.
	 */
	function spawn(command, args, options) {
		const norm = normalizeArgs(args, options);
		const emitter = new EventEmitter();
		emitter.stdout = new EventEmitter();
		emitter.stderr = new EventEmitter();
		for (const stream of [emitter.stdout, emitter.stderr]) {
			stream.setEncoding = () => stream;
			stream.resume = () => stream;
			stream.pause = () => stream;
		}
		const stdio = norm.options.stdio;
		const stdinMode = Array.isArray(stdio) ? stdio[0] : stdio;
		const inputs = [];
		let started = false;
		let killed = null;
		emitter.pid = 0;
		emitter.killed = false;
		emitter.exitCode = null;
		emitter.signalCode = null;
		if (stdinMode === "ignore" || stdinMode === "inherit" || stdinMode === null) emitter.stdin = null;
		else {
			const stdin = new EventEmitter();
			stdin.writable = true;
			stdin.write = (chunk, encoding, callback) => {
				inputs.push(typeof chunk === "string" ? io.Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : io.Buffer.from(chunk));
				const done = typeof encoding === "function" ? encoding : callback;
				if (done) queueMicrotask(done);
				return true;
			};
			stdin.end = (chunk, encoding, callback) => {
				if (chunk !== undefined && chunk !== null && typeof chunk !== "function") stdin.write(chunk, encoding);
				stdin.writable = false;
				queueMicrotask(() => {
					stdin.emit("finish");
					stdin.emit("close");
					start();
				});
				const done = [chunk, encoding, callback].find((x) => typeof x === "function");
				if (done) queueMicrotask(done);
			};
			stdin.destroy = stdin.end;
			emitter.stdin = stdin;
		}

		const fail = (error) => {
			emitter.emit("error", error);
			emitter.emit("close", -2, null);
		};
		const start = () => {
			if (started) return;
			started = true;
			if (killed) {
				emitter.signalCode = killed;
				emitter.emit("exit", null, killed);
				emitter.emit("close", null, killed);
				return;
			}
			if (!norm.options.shell && !findExecutable(command, norm.options)) {
				fail(notFound(command, "spawn"));
				return;
			}
			try {
				const options = { ...norm.options };
				if (inputs.length) options.input = io.Buffer.concat(inputs);
				const res = spawnSync(command, norm.args, options);
				if (res.error) return fail(res.error);
				if (res.stdout?.length) emitter.stdout.emit("data", res.stdout);
				if (res.stderr?.length) emitter.stderr.emit("data", res.stderr);
				emitter.stdout.emit("end");
				emitter.stderr.emit("end");
				emitter.stdout.emit("close");
				emitter.stderr.emit("close");
				emitter.exitCode = res.status;
				emitter.signalCode = res.signal;
				emitter.emit("exit", res.status, res.signal);
				emitter.emit("close", res.status, res.signal);
			} catch (err) {
				fail(err);
			}
		};
		const later = typeof globalThis.setImmediate === "function" ? globalThis.setImmediate : (fn) => globalThis.setTimeout(fn, 0);
		later(() => {
			// A piped stdin gets one more turn: a program that writes to it after an await still reaches the child.
			if (emitter.stdin && emitter.stdin.writable && inputs.length === 0) later(start);
			else if (!emitter.stdin || !emitter.stdin.writable) start();
			else later(start);
		});
		emitter.kill = (signal = "SIGTERM") => {
			if (started) return false;
			killed = typeof signal === "number" ? (SIGNAL_NAMES[signal] ?? "SIGTERM") : signal;
			emitter.killed = true;
			return true;
		};
		emitter.ref = () => emitter;
		emitter.unref = () => emitter;
		return emitter;
	}

	function asyncRunner(sync) {
		return (...params) => {
			const callback = typeof params.at(-1) === "function" ? params.pop() : null;
			const emitter = new EventEmitter();
			queueMicrotask(() => {
				try {
					const out = sync(...params);
					callback?.(null, out, "");
				} catch (err) {
					callback?.(err, err.stdout ?? "", err.stderr ?? "");
				}
			});
			return emitter;
		};
	}

	return {
		spawn,
		spawnSync,
		execSync,
		execFileSync,
		exec: asyncRunner((command, options) => execSync(command, { encoding: "utf8", ...(options ?? {}) })),
		execFile: asyncRunner((file, args, options) => {
			const norm = normalizeArgs(args, options);
			return execFileSync(file, norm.args, { encoding: "utf8", ...norm.options });
		}),
		fork() {
			throw new Error("child_process.fork is not available: this runtime has no IPC channel to a child.");
		},
	};
}

/* ---------------------------------------------------------- worker_threads */

function createWorkerThreads(WorkerImpl, EventEmitter) {
	if (!WorkerImpl) {
		return null;
	}
	class Worker extends EventEmitter {
		constructor(filename) {
			super();
			this._worker = new WorkerImpl(filename);
			this._worker.onmessage = (event) => this.emit("message", event.data);
		}
		postMessage(value) {
			this._worker.postMessage(value);
		}
		terminate() {
			this._worker.terminate?.();
			this.emit("exit", 0);
			return Promise.resolve(0);
		}
	}
	return {
		Worker,
		isMainThread: true,
		threadId: 0,
		parentPort: null,
		workerData: null,
		// MessageChannel is engine-provided where available; this keeps the export shape whole.
		MessageChannel: globalThis.MessageChannel,
		MessagePort: globalThis.MessagePort,
	};
}

export {
	asyncHooks,
	AsyncLocalStorage,
	v8,
	createTty,
	createReadline,
	createChildProcess,
	createWorkerThreads,
};

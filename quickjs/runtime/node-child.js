/*
 * child_process on the native host: spawn() with live pipes, fork() and the IPC channel.
 *
 * The C side (fg_proc.c) starts a child without waiting for it and hands back non-blocking pipes. Here one
 * scheduler polls every live child and channel from the JavaScript thread, the way native-modules.js polls
 * sockets: it asks the host which pipes can be read (waiting a few milliseconds inside the host, so an idle
 * child costs almost nothing), moves the bytes into streams, reaps children that ended and emits the events
 * in Node's order. It stops by itself when nothing needs serving, so it never keeps a finished program alive.
 *
 * fork() talks JSON, one message per line, over descriptor 3 (POSIX; the same wire Node uses) or a pair of
 * anonymous pipes (Windows, which before 10 has no AF_UNIX). 'advanced' serialization and sending handles
 * are not available and say so.
 */

const SIGNALS = {
	SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10,
	SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18,
	SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26,
	SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
};
const SIGNAL_NAMES = Object.fromEntries(Object.entries(SIGNALS).map(([name, number]) => [number, name]));

const CHANNEL_ENV = ["NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "GRAAK_CHANNEL_OUT", "GRAAK_FORK_ENTRY", "GRAAK_EXEC_ARGV"];

const ERRNO = { 2: "ENOENT", 12: "ENOMEM", 13: "EACCES", 20: "ENOTDIR", 24: "EMFILE", 8: "ENOEXEC", 22: "EINVAL", 7: "E2BIG", 11: "EAGAIN" };

function codedError(Ctor, code, message) {
	const error = new Ctor(message);
	error.code = code;
	return error;
}

export function createChildProcess({ native, EventEmitter, stream, Buffer, process, isSea, shellArgv }) {
	const { Readable, Writable } = stream;

	// ---- the scheduler ---------------------------------------------------------------------------------------------
	const active = new Set();
	let timer = null;
	const report = (error) => {
		if (typeof globalThis.__graak_reportUncaught === "function") globalThis.__graak_reportUncaught(error);
		else throw error;
	};

	function run() {
		timer = null;
		const items = [...active];
		const ids = [];
		for (const item of items) ids.push(...item.readIds());
		let ready = [];
		try {
			ready = native.pipePoll(ids, 4);
		} catch {
			ready = ids;
		}
		const set = new Set(ready);
		for (const item of items) {
			if (!active.has(item)) continue;
			try {
				item.tick(set);
			} catch (error) {
				report(error);
			}
		}
		schedule();
	}

	/** Keeps polling while any item still needs serving. */
	function schedule() {
		if (timer) return;
		for (const item of active) {
			if (item.wants()) {
				timer = globalThis.setTimeout(run, 0);
				return;
			}
		}
	}

	// ---- the IPC channel -------------------------------------------------------------------------------------------
	const ipcClosed = () => codedError(Error, "ERR_IPC_CHANNEL_CLOSED", "Channel closed");

	/** One end of the line-delimited JSON channel. `target` is the emitter that gets 'message' and 'disconnect'. */
	class Channel {
		constructor(id, target, wants) {
			this.id = id;
			this.target = target;
			this.connected = true;
			this.extraWants = wants;
			this.input = [];
			this.pending = [];
			this.ref = true;
			active.add(this);
		}

		readIds() {
			return this.connected ? [this.id] : [];
		}

		wants() {
			return this.connected && this.ref && (this.pending.length > 0 || this.extraWants());
		}

		tick(ready) {
			if (!this.connected) return;
			this.flush();
			if (ready.has(this.id)) this.readAvailable();
		}

		readAvailable() {
			for (;;) {
				const data = native.pipeRead(this.id, 65536);
				if (data === undefined) return;
				if (data === null) {
					this.close(true);
					return;
				}
				this.input.push(Buffer.from(data));
				this.split();
				if (!this.connected) return;
			}
		}

		split() {
			let buffer = this.input.length === 1 ? this.input[0] : Buffer.concat(this.input);
			let newline = buffer.indexOf(10);
			while (newline >= 0) {
				const line = buffer.subarray(0, newline).toString("utf8");
				buffer = buffer.subarray(newline + 1);
				this.dispatch(line);
				newline = buffer.indexOf(10);
			}
			this.input = buffer.length ? [buffer] : [];
		}

		dispatch(line) {
			if (!line) return;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			// Messages Node's own machinery exchanges (handle passing) carry a NODE_ command and are not the program's.
			if (message && typeof message === "object" && typeof message.cmd === "string" && message.cmd.startsWith("NODE_")) return;
			this.target.emit("message", message);
		}

		send(message, callback) {
			this.pending.push({ bytes: Buffer.from(`${JSON.stringify(message)}\n`), offset: 0, callback });
			this.flush();
			schedule();
		}

		flush() {
			while (this.pending.length && this.connected) {
				const item = this.pending[0];
				const view = item.bytes;
				const n = native.pipeWrite(this.id, view.buffer, view.byteOffset + item.offset, view.length - item.offset);
				if (n < 0) {
					// The reader is gone: nothing more can be delivered.
					this.pending.shift();
					const error = ipcClosed();
					if (item.callback) process.nextTick(item.callback, error);
					this.close(true);
					return;
				}
				item.offset += n;
				if (item.offset < view.length) return;
				this.pending.shift();
				if (item.callback) process.nextTick(item.callback, null);
			}
		}

		/** Ends the channel; `remote` says the other side ended it. */
		close(remote) {
			if (!this.connected) return;
			if (!remote) {
				// Give what is queued a last chance to go out before the descriptor is closed.
				for (let attempt = 0; attempt < 50 && this.pending.length; attempt++) {
					this.flush();
					if (this.pending.length) native.pipePoll([], 2);
				}
			}
			this.connected = false;
			active.delete(this);
			native.pipeClose(this.id, 2);
			const pending = this.pending.splice(0);
			for (const item of pending) if (item.callback) process.nextTick(item.callback, ipcClosed());
			this.target.connected = false;
			process.nextTick(() => this.target.emit("disconnect"));
		}
	}

	function checkMessage(message) {
		if (message === undefined) {
			throw codedError(TypeError, "ERR_MISSING_ARGS", 'The "message" argument must be specified');
		}
		const type = typeof message;
		if (message !== null && type !== "string" && type !== "object" && type !== "number" && type !== "boolean") {
			throw codedError(
				TypeError,
				"ERR_INVALID_ARG_TYPE",
				'The "message" argument must be one of type string, object, number, or boolean.'
			);
		}
	}

	/** The send() shared by a ChildProcess and the child's own `process`. */
	function sendOn(target, getChannel, message, handle, options, callback) {
		if (typeof handle === "function") {
			callback = handle;
			handle = undefined;
			options = undefined;
		} else if (typeof options === "function") {
			callback = options;
			options = undefined;
		}
		checkMessage(message);
		if (handle !== undefined && handle !== null) {
			throw codedError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "Sending handles over the IPC channel is not supported by this host");
		}
		const channel = getChannel();
		if (!channel || !channel.connected) {
			const error = ipcClosed();
			if (typeof callback === "function") process.nextTick(callback, error);
			else process.nextTick(() => target.emit("error", error));
			return false;
		}
		channel.send(message, typeof callback === "function" ? callback : undefined);
		return channel.pending.length === 0;
	}

	function disconnectOn(target, getChannel) {
		const channel = getChannel();
		if (!channel || !channel.connected) {
			target.emit("error", codedError(Error, "ERR_IPC_DISCONNECTED", "IPC channel is already disconnected"));
			return;
		}
		channel.close(false);
	}

	// ---- stdio normalisation ---------------------------------------------------------------------------------------
	function normalizeStdio(stdio) {
		const modes = ["pipe", "pipe", "pipe"];
		let ipc = false;
		if (stdio === undefined || stdio === null) return { modes, ipc };
		if (typeof stdio === "string") {
			if (!["pipe", "inherit", "ignore", "overlapped"].includes(stdio)) {
				throw codedError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'stdio' is invalid. Received '${stdio}'`);
			}
			const mode = stdio === "overlapped" ? "pipe" : stdio;
			return { modes: [mode, mode, mode], ipc };
		}
		if (!Array.isArray(stdio)) {
			throw codedError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'stdio' is invalid");
		}
		stdio.forEach((entry, index) => {
			let mode;
			if (entry === undefined || entry === null || entry === "pipe" || entry === "overlapped") mode = "pipe";
			else if (entry === "inherit" || entry === "ignore") mode = entry;
			else if (entry === "ipc") {
				if (ipc) throw codedError(Error, "ERR_IPC_ONE_PIPE", "Child process can have only one IPC pipe");
				ipc = true;
				return;
			} else if (typeof entry === "number") mode = entry;
			else if (entry && typeof entry.fd === "number") mode = entry.fd;
			else throw codedError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'stdio' is invalid. Received ${String(entry)}`);
			if (index > 2) {
				throw codedError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "stdio entries after stderr other than 'ipc' are not supported by this host");
			}
			modes[index] = mode;
		});
		return { modes, ipc };
	}

	const signalNumber = (signal) => {
		if (signal === undefined || signal === null) return SIGNALS.SIGTERM;
		if (typeof signal === "number") {
			if (Number.isInteger(signal) && signal >= 0) return signal;
		} else if (typeof signal === "string" && Object.hasOwn(SIGNALS, signal)) return SIGNALS[signal];
		throw codedError(TypeError, "ERR_UNKNOWN_SIGNAL", `Unknown signal: ${String(signal)}`);
	};

	// ---- the ChildProcess ------------------------------------------------------------------------------------------
	class ChildProcess extends EventEmitter {
		constructor() {
			super();
			this._proc = -1;
			this.pid = undefined;
			this.connected = false;
			this.killed = false;
			this.exitCode = null;
			this.signalCode = null;
			this.spawnfile = undefined;
			this.spawnargs = [];
			this.stdin = null;
			this.stdout = null;
			this.stderr = null;
			this.stdio = [null, null, null];
			this._channel = null;
			this._exited = false;
			this._refed = true;
			this._closesNeeded = 1;
			this._closesGot = 0;
			this._readers = [];
			this._writer = null;
			this._closeEmitted = false;
		}

		_spawn(file, args, options) {
			const { modes, ipc } = normalizeStdio(options.stdio);
			this.spawnfile = file;
			this.spawnargs = [file, ...args];
			const env = {};
			for (const [key, value] of Object.entries(options.env ?? process.env)) if (value !== undefined) env[key] = String(value);
			if (options.env === undefined || options.env === process.env) for (const key of CHANNEL_ENV) delete env[key];
			for (const [key, value] of Object.entries(options.extraEnv ?? {})) env[key] = value;
			const argv = options.shell ? shellArgv([file, ...args].join(" ")) : [file, ...args];
			this._streams(modes);
			const started = native.procSpawn(argv, {
				cwd: options.cwd ? String(options.cwd) : undefined,
				env,
				stdio: modes,
				ipc,
				detached: Boolean(options.detached),
			});
			if (typeof started === "number") {
				const code = ERRNO[-started] ?? "EINVAL";
				const error = Object.assign(new Error(`spawn ${file} ${code}`), {
					errno: -Math.abs(started),
					code,
					syscall: `spawn ${file}`,
					path: file,
					spawnargs: args,
				});
				process.nextTick(() => {
					this.exitCode = started;
					this.emit("error", error);
					this._streamsEnded();
					this._maybeClose();
				});
				return;
			}
			this._proc = started.proc;
			this.pid = started.pid;
			this._pipes = started.stdio;
			if (started.stdio[0] >= 0) this._makeStdin(started.stdio[0]);
			for (const index of [1, 2]) if (started.stdio[index] >= 0) this._readers.push({ index, id: started.stdio[index], stream: index === 1 ? this.stdout : this.stderr, done: false });
			if (started.ipc >= 0) {
				this._channel = new Channel(started.ipc, this, () => true);
				this.connected = true;
			}
			this.stdio = [this.stdin, this.stdout, this.stderr];
			active.add(this);
			process.nextTick(() => this.emit("spawn"));
			this._timers(options);
			schedule();
		}

		/** The three stdio streams exist from the start (null for a mode that has none), as in Node. */
		_streams(modes) {
			for (const index of [1, 2]) {
				if (modes[index] !== "pipe") continue;
				const readable = new Readable({
					read() {},
					destroy: (error, callback) => {
						const reader = this._readers.find((r) => r.stream === readable);
						if (reader && !reader.done) {
							reader.done = true;
							native.pipeClose(reader.id, 0);
						}
						callback(error);
					},
				});
				if (index === 1) this.stdout = readable;
				else this.stderr = readable;
				this._closesNeeded++;
				readable.on("close", () => {
					this._closesGot++;
					this._maybeClose();
				});
			}
		}

		_streamsEnded() {
			for (const readable of [this.stdout, this.stderr]) if (readable && !readable.destroyed) readable.destroy();
			if (this.stdin && !this.stdin.destroyed) this.stdin.destroy();
		}

		_makeStdin(id) {
			const write = (chunk, callback) => {
				const attempt = () => {
					for (;;) {
						if (this._writer.offset >= chunk.length) return true;
						const n = native.pipeWrite(id, chunk.buffer, chunk.byteOffset + this._writer.offset, chunk.length - this._writer.offset);
						if (n < 0) {
							callback(Object.assign(new Error("write EPIPE"), { errno: -32, code: "EPIPE", syscall: "write" }));
							this._writer = null;
							return false;
						}
						if (n === 0) return false;
						this._writer.offset += n;
					}
				};
				this._writer = { offset: 0, attempt: null };
				if (attempt()) {
					this._writer = null;
					callback();
				} else if (this._writer) {
					this._writer.attempt = () => {
						const alive = this._writer;
						if (attempt()) {
							if (this._writer === alive) this._writer = null;
							callback();
						}
					};
				}
			};
			const stdin = new Writable({
				write: (chunk, encoding, callback) => write(chunk, callback),
				final: (callback) => {
					native.pipeClose(id, 1);
					callback();
				},
				destroy: (error, callback) => {
					this._writer = null;
					native.pipeClose(id, 1);
					callback(error);
				},
			});
			this.stdin = stdin;
		}

		_timers(options) {
			const killSignal = options.killSignal ?? "SIGTERM";
			if (options.timeout > 0) {
				this._timeout = globalThis.setTimeout(() => {
					this._timeout = null;
					this.kill(killSignal);
				}, options.timeout);
			}
			const abort = options.signal;
			if (abort) {
				const onAbort = () => {
					this.kill(killSignal);
					this.emit("error", codedError(Error, "ABORT_ERR", "The operation was aborted"));
				};
				if (abort.aborted) process.nextTick(onAbort);
				else abort.addEventListener("abort", onAbort, { once: true });
			}
		}

		readIds() {
			const ids = [];
			for (const reader of this._readers) if (!reader.done) ids.push(reader.id);
			if (this._channel) ids.push(...this._channel.readIds());
			return ids;
		}

		wants() {
			return this._refed && (!this._exited || this._readers.some((r) => !r.done) || Boolean(this._writer));
		}

		tick(ready) {
			if (this._channel?.connected) this._channel.tick(ready);
			if (this._writer?.attempt) this._writer.attempt();
			for (const reader of this._readers) if (!reader.done && (ready.has(reader.id) || this._exited)) this._drain(reader);
			if (!this._exited) {
				const status = native.procPoll(this._proc);
				if (status !== undefined) this._onExit(status);
			}
			if (this._exited && this._readers.every((r) => r.done) && !this._writer) {
				if (!this._channel?.connected) active.delete(this);
			}
		}

		_drain(reader) {
			for (;;) {
				const data = native.pipeRead(reader.id, 65536);
				if (data === undefined) return;
				if (data === null) {
					reader.done = true;
					native.pipeClose(reader.id, 0);
					if (!reader.stream.destroyed) reader.stream.push(null);
					return;
				}
				if (!reader.stream.destroyed) reader.stream.push(Buffer.from(data));
			}
		}

		_onExit(status) {
			this._exited = true;
			for (const reader of this._readers) if (!reader.done) this._drain(reader);
			native.procRelease(this._proc);
			if (status < 0) this.signalCode = SIGNAL_NAMES[-status] ?? `SIG${-status}`;
			else this.exitCode = status;
			if (this._timeout) globalThis.clearTimeout(this._timeout);
			this.emit("exit", this.exitCode, this.signalCode);
			// Output nobody is reading is discarded so that 'close' can happen, as in Node.
			for (const readable of [this.stdout, this.stderr]) {
				if (readable && readable.readable && readable.listenerCount("readable") === 0) readable.resume();
			}
			if (this._channel?.connected) {
				// The child took its end of the channel with it.
				this._channel.readAvailable();
				this._channel.close(true);
			}
			this._maybeClose();
		}

		_maybeClose() {
			if (this._closeEmitted) return;
			const ended = this._exited || this._proc < 0;
			if (ended && this._closesGot >= this._closesNeeded - 1) {
				this._closeEmitted = true;
				active.delete(this);
				process.nextTick(() => this.emit("close", this.exitCode, this.signalCode));
			}
		}

		kill(signal) {
			const number = signalNumber(signal);
			if (this._exited || this._proc < 0) return false;
			const sent = native.procKill(this._proc, number);
			if (sent && number !== 0) this.killed = true;
			return sent;
		}

		send(message, handle, options, callback) {
			return sendOn(this, () => this._channel, message, handle, options, callback);
		}

		disconnect() {
			disconnectOn(this, () => this._channel);
		}

		ref() {
			this._refed = true;
			if (this._channel) this._channel.ref = true;
			schedule();
		}

		unref() {
			this._refed = false;
			if (this._channel) this._channel.ref = false;
		}

		get [Symbol.toStringTag]() {
			return "ChildProcess";
		}

		[Symbol.dispose]() {
			if (!this._exited) this.kill();
		}
	}

	// A ChildProcess is only alive-tracked in `active` once it has started; a failed one is settled by its nextTick.
	// ---- spawn and fork --------------------------------------------------------------------------------------------
	function normalizeArgs(args, options) {
		if (args !== undefined && !Array.isArray(args)) return { args: [], options: args ?? {} };
		return { args: (args ?? []).map(String), options: options ?? {} };
	}

	function spawn(file, args, options) {
		if (typeof file !== "string") {
			throw codedError(TypeError, "ERR_INVALID_ARG_TYPE", `The "file" argument must be of type string. Received ${typeof file}`);
		}
		const norm = normalizeArgs(args, options);
		const child = new ChildProcess();
		child._spawn(file, norm.args, norm.options);
		return child;
	}

	function fork(modulePath, args, options) {
		if (typeof modulePath !== "string") {
			throw codedError(TypeError, "ERR_INVALID_ARG_TYPE", `The "modulePath" argument must be of type string. Received ${typeof modulePath}`);
		}
		const norm = normalizeArgs(args, options);
		const opts = { ...norm.options };
		if (opts.serialization !== undefined && opts.serialization !== "json") {
			throw codedError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", `fork() serialization '${opts.serialization}' is not supported by this host; use 'json'`);
		}
		const execArgv = opts.execArgv ?? process.execArgv;
		const execPath = opts.execPath ?? process.execPath;
		let stdio = opts.stdio;
		if (stdio === undefined) stdio = opts.silent ? ["pipe", "pipe", "pipe", "ipc"] : ["inherit", "inherit", "inherit", "ipc"];
		else if (typeof stdio === "string") stdio = [stdio, stdio, stdio, "ipc"];
		else if (Array.isArray(stdio)) {
			if (!stdio.includes("ipc")) {
				throw codedError(Error, "ERR_CHILD_PROCESS_IPC_REQUIRED", "Forked processes must have an IPC channel, missing value 'ipc' in stdio");
			}
		}
		opts.stdio = stdio;
		let argv;
		opts.extraEnv = {};
		if (execPath === process.execPath) {
			// The program forks itself. The host runs a program from its argument list, or from its own payload in a
			// single-file build, where the entry cannot be named on the command line: it travels in the environment.
			opts.extraEnv.GRAAK_EXEC_ARGV = JSON.stringify(execArgv);
			if (isSea) {
				opts.extraEnv.GRAAK_FORK_ENTRY = modulePath;
				argv = norm.args;
			} else {
				argv = [globalThis.scriptArgs[0], modulePath, ...norm.args];
			}
		} else {
			argv = [...execArgv, modulePath, ...norm.args];
		}
		const child = new ChildProcess();
		child._spawn(execPath, argv, opts);
		return child;
	}

	// ---- the child's side of the channel ---------------------------------------------------------------------------
	/** Turns this process's own `process` into the child end of a fork() channel, when it was forked. */
	function installChannel() {
		const id = native.channelOpen();
		const env = process.env;
		try {
			if (env.GRAAK_EXEC_ARGV) process.execArgv = JSON.parse(env.GRAAK_EXEC_ARGV);
		} catch {
			/* not ours */
		}
		for (const key of CHANNEL_ENV) if (key !== "GRAAK_FORK_ENTRY") delete env[key];
		if (id < 0) return;
		let channel = null;
		channel = new Channel(id, process, () => process.listenerCount("message") + process.listenerCount("disconnect") > 0);
		process.connected = true;
		process.channel = {
			ref() {
				channel.ref = true;
				schedule();
			},
			unref() {
				channel.ref = false;
			},
		};
		process.send = (message, handle, options, callback) => sendOn(process, () => channel, message, handle, options, callback);
		process.disconnect = () => disconnectOn(process, () => channel);
		process.on("newListener", (event) => {
			if (event === "message" || event === "disconnect") queueMicrotask(schedule);
		});
		// Messages that arrived before the program listened are held by the pipe, so read them once it does.
		schedule();
	}

	return { ChildProcess, spawn, fork, installChannel };
}

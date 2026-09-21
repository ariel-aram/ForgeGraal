/*
 * The `Deno` namespace for programs written for Deno, built on the Node.js API. Graak inlines this
 * file at the top of a bundled Deno program (see src/compiler/DenoBundler.ts), so it runs the same on
 * the Graak engine and on Node.js. Nothing in it is Graak specific: every function is a thin,
 * behaviour-preserving adapter over `fs`, `net`, `http`, `child_process`, `os` and `process`.
 *
 * What it cannot do is said aloud rather than faked: Deno KV, cron, FFI, `Deno.test` and file watching
 * throw `Deno.errors.NotSupported` naming the API, because a stand-in that returned plausible values would
 * lose data or hide the gap.
 *
 * Every permission is granted: a compiled program has no prompts, the same as `deno compile -A`.
 */
(function installDeno(global) {
	"use strict";
	if (typeof global.Deno !== "undefined") return;

	const fs = require("fs");
	const path = require("path");
	const os = require("os");
	const util = require("util");
	const { pathToFileURL, fileURLToPath } = require("url");

	const VERSION = "__GRAAK_DENO_VERSION__";
	const V8_VERSION = "__GRAAK_V8_VERSION__";
	const TS_VERSION = "__GRAAK_TS_VERSION__";

	// ---- errors -------------------------------------------------------------------------------------------
	const ERRNO = {
		EPERM: [1, "Operation not permitted"],
		ENOENT: [2, "No such file or directory"],
		EINTR: [4, "Interrupted system call"],
		EIO: [5, "Input/output error"],
		EBADF: [9, "Bad file descriptor"],
		EACCES: [13, "Permission denied"],
		EEXIST: [17, "File exists"],
		ENOTDIR: [20, "Not a directory"],
		EISDIR: [21, "Is a directory"],
		EINVAL: [22, "Invalid argument"],
		EPIPE: [32, "Broken pipe"],
		ENOTEMPTY: [39, "Directory not empty"],
		EADDRINUSE: [98, "Address already in use"],
		EADDRNOTAVAIL: [99, "Cannot assign requested address"],
		ECONNABORTED: [103, "Software caused connection abort"],
		ECONNRESET: [104, "Connection reset by peer"],
		ENOTCONN: [107, "Transport endpoint is not connected"],
		ETIMEDOUT: [110, "Connection timed out"],
		ECONNREFUSED: [111, "Connection refused"],
	};

	function defineError(name, code) {
		const E = class extends Error {
			constructor(message) {
				super(message);
				if (code) this.code = code;
			}
		};
		Object.defineProperty(E, "name", { value: name });
		Object.defineProperty(E.prototype, "name", { value: name, configurable: true, writable: true });
		return E;
	}
	const errors = {
		NotFound: defineError("NotFound", "ENOENT"),
		PermissionDenied: defineError("PermissionDenied", "EACCES"),
		ConnectionRefused: defineError("ConnectionRefused", "ECONNREFUSED"),
		ConnectionReset: defineError("ConnectionReset", "ECONNRESET"),
		ConnectionAborted: defineError("ConnectionAborted", "ECONNABORTED"),
		NotConnected: defineError("NotConnected", "ENOTCONN"),
		AddrInUse: defineError("AddrInUse", "EADDRINUSE"),
		AddrNotAvailable: defineError("AddrNotAvailable", "EADDRNOTAVAIL"),
		BrokenPipe: defineError("BrokenPipe", "EPIPE"),
		AlreadyExists: defineError("AlreadyExists", "EEXIST"),
		InvalidData: defineError("InvalidData"),
		TimedOut: defineError("TimedOut", "ETIMEDOUT"),
		Interrupted: defineError("Interrupted", "EINTR"),
		WriteZero: defineError("WriteZero"),
		UnexpectedEof: defineError("UnexpectedEof"),
		BadResource: defineError("BadResource"),
		Http: defineError("Http"),
		Busy: defineError("Busy"),
		NotSupported: defineError("NotSupported"),
		FilesystemLoop: defineError("FilesystemLoop"),
		IsADirectory: defineError("IsADirectory", "EISDIR"),
		NetworkUnreachable: defineError("NetworkUnreachable"),
		NotADirectory: defineError("NotADirectory", "ENOTDIR"),
	};
	const CODE_TO_ERROR = {
		ENOENT: errors.NotFound,
		EACCES: errors.PermissionDenied,
		EPERM: errors.PermissionDenied,
		EEXIST: errors.AlreadyExists,
		EISDIR: errors.IsADirectory,
		ENOTDIR: errors.NotADirectory,
		ECONNREFUSED: errors.ConnectionRefused,
		ECONNRESET: errors.ConnectionReset,
		ECONNABORTED: errors.ConnectionAborted,
		ENOTCONN: errors.NotConnected,
		EADDRINUSE: errors.AddrInUse,
		EADDRNOTAVAIL: errors.AddrNotAvailable,
		EPIPE: errors.BrokenPipe,
		ETIMEDOUT: errors.TimedOut,
		EINTR: errors.Interrupted,
	};

	/** A Node.js system error as the Deno error a program expects: same class, code and message shape. */
	function denoError(err, op, target) {
		if (!err || typeof err !== "object" || typeof err.code !== "string") return err;
		const known = ERRNO[err.code];
		const Ctor = CODE_TO_ERROR[err.code] ?? Error;
		const text = known ? `${known[1]} (os error ${known[0]})` : err.message;
		const e = new Ctor(`${text}${op ? `: ${op}${target !== undefined ? ` '${target}'` : ""}` : ""}`);
		if (Ctor === Error) e.name = "Error";
		e.code = err.code;
		return e;
	}
	function unsupported(what, why) {
		return new errors.NotSupported(`${what} is not supported by Graak${why ? `: ${why}` : ""}`);
	}
	function toPath(p) {
		return p instanceof URL ? fileURLToPath(p) : String(p);
	}
	function bytes(buf) {
		return new Uint8Array(buf);
	}
	function guard(op, target, fn) {
		try {
			return fn();
		} catch (e) {
			throw denoError(e, op, target);
		}
	}
	async function guardAsync(op, target, fn) {
		try {
			return await fn();
		} catch (e) {
			throw denoError(e, op, target);
		}
	}
	function checkAborted(signal) {
		if (signal?.aborted) throw signal.reason ?? new DOMException("The signal has been aborted", "AbortError");
	}

	// ---- files ---------------------------------------------------------------------------------------------
	function toFileInfo(s) {
		return {
			isFile: s.isFile(),
			isDirectory: s.isDirectory(),
			isSymlink: s.isSymbolicLink(),
			size: Number(s.size),
			mtime: s.mtime ?? null,
			atime: s.atime ?? null,
			birthtime: s.birthtime ?? null,
			ctime: s.ctime ?? null,
			dev: Number(s.dev),
			ino: s.ino === undefined ? null : Number(s.ino),
			mode: Number(s.mode),
			nlink: Number(s.nlink),
			uid: Number(s.uid),
			gid: Number(s.gid),
			rdev: Number(s.rdev),
			blksize: Number(s.blksize),
			blocks: s.blocks === undefined ? null : Number(s.blocks),
			isBlockDevice: s.isBlockDevice ? s.isBlockDevice() : false,
			isCharDevice: s.isCharacterDevice ? s.isCharacterDevice() : false,
			isFifo: s.isFIFO ? s.isFIFO() : false,
			isSocket: s.isSocket ? s.isSocket() : false,
		};
	}

	function openFd(p, options, op) {
		const target = toPath(p);
		const o = options ?? {};
		let flags;
		if (o.createNew) flags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL;
		else {
			const writing = o.write || o.append || o.truncate || o.create;
			flags = writing ? (o.read ? fs.constants.O_RDWR : fs.constants.O_WRONLY) : fs.constants.O_RDONLY;
			if (o.create) flags |= fs.constants.O_CREAT;
			if (o.truncate) flags |= fs.constants.O_TRUNC;
		}
		if (o.append) flags |= fs.constants.O_APPEND;
		return guard(op, target, () => fs.openSync(target, flags, o.mode ?? 0o666));
	}

	class FsFile {
		#fd;
		#closed = false;
		constructor(fd) {
			this.#fd = fd;
			Object.defineProperty(this, "rid", { value: fd, enumerable: false });
		}
		get fd() {
			return this.#fd;
		}
		#live() {
			if (this.#closed) throw new errors.BadResource("Bad resource ID");
			return this.#fd;
		}
		readSync(buf) {
			if (buf.byteLength === 0) return 0;
			const n = guard("read", undefined, () => fs.readSync(this.#live(), buf, 0, buf.byteLength, null));
			return n === 0 ? null : n;
		}
		async read(buf) {
			return this.readSync(buf);
		}
		writeSync(buf) {
			return guard("write", undefined, () => fs.writeSync(this.#live(), buf, 0, buf.byteLength, null));
		}
		async write(buf) {
			return this.writeSync(buf);
		}
		seekSync(offset, whence) {
			const fd = this.#live();
			const size = fs.fstatSync(fd).size;
			this._pos = this._pos ?? 0;
			const base = whence === 1 ? this._pos : whence === 2 ? size : 0;
			this._pos = base + Number(offset);
			return this._pos;
		}
		async seek(offset, whence) {
			return this.seekSync(offset, whence);
		}
		statSync() {
			return toFileInfo(guard("fstat", undefined, () => fs.fstatSync(this.#live())));
		}
		async stat() {
			return this.statSync();
		}
		truncateSync(len = 0) {
			guard("ftruncate", undefined, () => fs.ftruncateSync(this.#live(), len));
		}
		async truncate(len) {
			this.truncateSync(len);
		}
		syncSync() {
			fs.fsyncSync(this.#live());
		}
		async sync() {
			this.syncSync();
		}
		syncDataSync() {
			fs.fsyncSync(this.#live());
		}
		async syncData() {
			this.syncDataSync();
		}
		isTerminal() {
			return require("tty").isatty(this.#fd);
		}
		close() {
			if (this.#closed) throw new errors.BadResource("Bad resource ID");
			this.#closed = true;
			fs.closeSync(this.#fd);
		}
		get readable() {
			const self = this;
			return new ReadableStream({
				pull(controller) {
					const chunk = new Uint8Array(64 * 1024);
					const n = self.readSync(chunk);
					if (n === null) {
						controller.close();
						try {
							self.close();
						} catch {}
					} else controller.enqueue(chunk.subarray(0, n));
				},
				cancel() {
					try {
						self.close();
					} catch {}
				},
			});
		}
		get writable() {
			const self = this;
			return new WritableStream({
				write(chunk) {
					let off = 0;
					while (off < chunk.byteLength) off += self.writeSync(chunk.subarray(off));
				},
				close() {
					try {
						self.close();
					} catch {}
				},
			});
		}
		[Symbol.dispose]() {
			try {
				this.close();
			} catch {}
		}
	}
	// A seekable file keeps its own position, so reads and writes go through positional calls once seeked.
	{
		const readSync = FsFile.prototype.readSync;
		const writeSync = FsFile.prototype.writeSync;
		FsFile.prototype.readSync = function (buf) {
			if (this._pos === undefined) return readSync.call(this, buf);
			if (buf.byteLength === 0) return 0;
			const n = guard("read", undefined, () => fs.readSync(this.fd, buf, 0, buf.byteLength, this._pos));
			this._pos += n;
			return n === 0 ? null : n;
		};
		FsFile.prototype.writeSync = function (buf) {
			if (this._pos === undefined) return writeSync.call(this, buf);
			const n = guard("write", undefined, () => fs.writeSync(this.fd, buf, 0, buf.byteLength, this._pos));
			this._pos += n;
			return n;
		};
	}

	const SeekMode = { Start: 0, Current: 1, End: 2 };

	function stdStream(fd, readable) {
		const isTTY = () => require("tty").isatty(fd);
		const target = readable ? process.stdin : fd === 1 ? process.stdout : process.stderr;
		const obj = {
			rid: fd,
			fd,
			isTerminal: isTTY,
			close() {},
			[Symbol.dispose]() {},
		};
		if (readable) {
			obj.readSync = (buf) => {
				try {
					const n = fs.readSync(0, buf, 0, buf.byteLength, null);
					return n === 0 ? null : n;
				} catch (e) {
					if (e.code === "EAGAIN") return 0;
					if (e.code === "EOF") return null;
					throw denoError(e);
				}
			};
			obj.read = async (buf) => {
				if (buf.byteLength === 0) return 0;
				return await new Promise((resolve, reject) => {
					const attempt = () => {
						try {
							const n = fs.readSync(0, buf, 0, buf.byteLength, null);
							resolve(n === 0 ? null : n);
						} catch (e) {
							if (e.code === "EAGAIN") setTimeout(attempt, 5);
							else if (e.code === "EOF") resolve(null);
							else reject(denoError(e));
						}
					};
					attempt();
				});
			};
			Object.defineProperty(obj, "readable", {
				get() {
					return new ReadableStream({
						async pull(controller) {
							const chunk = new Uint8Array(16 * 1024);
							const n = await obj.read(chunk);
							if (n === null) controller.close();
							else controller.enqueue(chunk.subarray(0, n));
						},
					});
				},
			});
		} else {
			obj.writeSync = (buf) => {
				target.write(buf);
				return buf.byteLength;
			};
			obj.write = async (buf) => obj.writeSync(buf);
			Object.defineProperty(obj, "writable", {
				get() {
					return new WritableStream({
						write(chunk) {
							target.write(chunk);
						},
					});
				},
			});
		}
		return obj;
	}

	// ---- file system API -----------------------------------------------------------------------------------
	const fsApi = {
		readFileSync: (p) => guard("readfile", toPath(p), () => bytes(fs.readFileSync(toPath(p)))),
		readFile: async (p, o) => {
			checkAborted(o?.signal);
			return guardAsync("readfile", toPath(p), async () => bytes(await fs.promises.readFile(toPath(p))));
		},
		readTextFileSync: (p) => guard("readfile", toPath(p), () => fs.readFileSync(toPath(p), "utf8")),
		readTextFile: async (p, o) => {
			checkAborted(o?.signal);
			return guardAsync("readfile", toPath(p), () => fs.promises.readFile(toPath(p), "utf8"));
		},
		writeFileSync: (p, data, o = {}) => {
			const target = toPath(p);
			guard("writefile", target, () => {
				if (o.create === false && !fs.existsSync(target)) {
					const e = new Error("ENOENT");
					e.code = "ENOENT";
					throw e;
				}
				const flag = o.createNew ? "wx" : o.append ? "a" : "w";
				fs.writeFileSync(target, data, { flag, mode: o.mode });
			});
		},
		writeFile: async (p, data, o = {}) => {
			checkAborted(o.signal);
			const target = toPath(p);
			if (data && typeof data.getReader === "function") {
				const chunks = [];
				const reader = data.getReader();
				for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
				data = Buffer.concat(chunks.map((c) => Buffer.from(c)));
			}
			return guardAsync("writefile", target, async () => {
				if (o.create === false && !fs.existsSync(target)) {
					const e = new Error("ENOENT");
					e.code = "ENOENT";
					throw e;
				}
				const flag = o.createNew ? "wx" : o.append ? "a" : "w";
				await fs.promises.writeFile(target, data, { flag, mode: o.mode });
			});
		},
		writeTextFileSync: (p, text, o) => fsApi.writeFileSync(p, String(text), o),
		writeTextFile: (p, text, o) => fsApi.writeFile(p, String(text), o),
		statSync: (p) => toFileInfo(guard("stat", toPath(p), () => fs.statSync(toPath(p)))),
		stat: async (p) => toFileInfo(await guardAsync("stat", toPath(p), () => fs.promises.stat(toPath(p)))),
		lstatSync: (p) => toFileInfo(guard("lstat", toPath(p), () => fs.lstatSync(toPath(p)))),
		lstat: async (p) => toFileInfo(await guardAsync("lstat", toPath(p), () => fs.promises.lstat(toPath(p)))),
		readDirSync: function* (p) {
			const entries = guard("readdir", toPath(p), () => fs.readdirSync(toPath(p), { withFileTypes: true }));
			for (const d of entries) {
				yield { name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory(), isSymlink: d.isSymbolicLink() };
			}
		},
		readDir: async function* (p) {
			const entries = await guardAsync("readdir", toPath(p), () =>
				fs.promises.readdir(toPath(p), { withFileTypes: true })
			);
			for (const d of entries) {
				yield { name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory(), isSymlink: d.isSymbolicLink() };
			}
		},
		mkdirSync: (p, o = {}) => {
			guard("mkdir", toPath(p), () => {
				fs.mkdirSync(toPath(p), { recursive: Boolean(o.recursive), mode: o.mode });
			});
		},
		mkdir: async (p, o = {}) => {
			await guardAsync("mkdir", toPath(p), () =>
				fs.promises.mkdir(toPath(p), { recursive: Boolean(o.recursive), mode: o.mode })
			);
		},
		removeSync: (p, o = {}) => {
			const target = toPath(p);
			guard("remove", target, () => {
				const st = fs.lstatSync(target);
				if (st.isDirectory()) {
					if (o.recursive) fs.rmSync(target, { recursive: true });
					else fs.rmdirSync(target);
				} else fs.unlinkSync(target);
			});
		},
		remove: async (p, o = {}) => {
			const target = toPath(p);
			await guardAsync("remove", target, async () => {
				const st = await fs.promises.lstat(target);
				if (st.isDirectory()) {
					if (o.recursive) await fs.promises.rm(target, { recursive: true });
					else await fs.promises.rmdir(target);
				} else await fs.promises.unlink(target);
			});
		},
		renameSync: (a, b) => guard("rename", toPath(a), () => fs.renameSync(toPath(a), toPath(b))),
		rename: (a, b) => guardAsync("rename", toPath(a), () => fs.promises.rename(toPath(a), toPath(b))),
		copyFileSync: (a, b) => guard("copy", toPath(a), () => fs.copyFileSync(toPath(a), toPath(b))),
		copyFile: (a, b) => guardAsync("copy", toPath(a), () => fs.promises.copyFile(toPath(a), toPath(b))),
		truncateSync: (p, len = 0) => guard("truncate", toPath(p), () => fs.truncateSync(toPath(p), len)),
		truncate: (p, len = 0) => guardAsync("truncate", toPath(p), () => fs.promises.truncate(toPath(p), len)),
		realPathSync: (p) => guard("realpath", toPath(p), () => fs.realpathSync(toPath(p))),
		realPath: (p) => guardAsync("realpath", toPath(p), () => fs.promises.realpath(toPath(p))),
		readLinkSync: (p) => guard("readlink", toPath(p), () => fs.readlinkSync(toPath(p))),
		readLink: (p) => guardAsync("readlink", toPath(p), () => fs.promises.readlink(toPath(p))),
		symlinkSync: (target, p, o) =>
			guard("symlink", toPath(p), () => fs.symlinkSync(toPath(target), toPath(p), o?.type === "dir" ? "dir" : undefined)),
		symlink: (target, p, o) =>
			guardAsync("symlink", toPath(p), () =>
				fs.promises.symlink(toPath(target), toPath(p), o?.type === "dir" ? "dir" : undefined)
			),
		linkSync: (a, b) => guard("link", toPath(a), () => fs.linkSync(toPath(a), toPath(b))),
		link: (a, b) => guardAsync("link", toPath(a), () => fs.promises.link(toPath(a), toPath(b))),
		chmodSync: (p, mode) => guard("chmod", toPath(p), () => fs.chmodSync(toPath(p), mode)),
		chmod: (p, mode) => guardAsync("chmod", toPath(p), () => fs.promises.chmod(toPath(p), mode)),
		chownSync: (p, uid, gid) => guard("chown", toPath(p), () => fs.chownSync(toPath(p), uid ?? -1, gid ?? -1)),
		chown: (p, uid, gid) => guardAsync("chown", toPath(p), () => fs.promises.chown(toPath(p), uid ?? -1, gid ?? -1)),
		utimeSync: (p, a, m) => guard("utime", toPath(p), () => fs.utimesSync(toPath(p), a, m)),
		utime: (p, a, m) => guardAsync("utime", toPath(p), () => fs.promises.utimes(toPath(p), a, m)),
		makeTempDirSync: (o = {}) => {
			const base = o.dir ? toPath(o.dir) : os.tmpdir();
			const dir = guard("makedtemp", base, () => fs.mkdtempSync(path.join(base, o.prefix ?? "")));
			if (!o.suffix) return dir;
			fs.renameSync(dir, dir + o.suffix);
			return dir + o.suffix;
		},
		makeTempDir: async (o) => fsApi.makeTempDirSync(o),
		makeTempFileSync: (o = {}) => {
			const base = o.dir ? toPath(o.dir) : os.tmpdir();
			const name = `${o.prefix ?? ""}${Math.random().toString(36).slice(2, 12)}${o.suffix ?? ""}`;
			const file = path.join(base, name);
			guard("maketemp", base, () => fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 }));
			return file;
		},
		makeTempFile: async (o) => fsApi.makeTempFileSync(o),
		openSync: (p, o = { read: true }) => new FsFile(openFd(p, o.read === undefined && !o.write ? { ...o, read: true } : o, "open")),
		open: async (p, o) => fsApi.openSync(p, o),
		createSync: (p) => new FsFile(openFd(p, { read: true, write: true, create: true, truncate: true }, "open")),
		create: async (p) => fsApi.createSync(p),
	};
	// Every operation needs `read` true unless it writes: an FsFile opened for reading only.
	const openOriginal = fsApi.openSync;
	fsApi.openSync = (p, o) => openOriginal(p, o ?? { read: true });

	// ---- environment and process ---------------------------------------------------------------------------
	const envApi = {
		get: (k) => process.env[k],
		set: (k, v) => {
			process.env[k] = String(v);
		},
		delete: (k) => {
			delete process.env[k];
		},
		has: (k) => k in process.env,
		toObject: () => ({ ...process.env }),
	};
	const OS = { linux: "linux", darwin: "darwin", win32: "windows", freebsd: "freebsd" }[process.platform] ?? process.platform;
	const ARCH = { x64: "x86_64", arm64: "aarch64", ia32: "x86", arm: "arm" }[process.arch] ?? process.arch;
	const TARGET =
		OS === "windows"
			? `${ARCH}-pc-windows-msvc`
			: OS === "darwin"
				? `${ARCH}-apple-darwin`
				: `${ARCH}-unknown-${OS}-gnu`;

	const signalNames = { SIGABRT: 1, SIGALRM: 1, SIGBREAK: 1, SIGCHLD: 1, SIGCONT: 1, SIGEMT: 1, SIGFPE: 1, SIGHUP: 1, SIGILL: 1, SIGINFO: 1, SIGINT: 1, SIGIO: 1, SIGPOLL: 1, SIGUNUSED: 1, SIGKILL: 1, SIGPIPE: 1, SIGPROF: 1, SIGPWR: 1, SIGQUIT: 1, SIGSEGV: 1, SIGSTKFLT: 1, SIGSTOP: 1, SIGSYS: 1, SIGTERM: 1, SIGTRAP: 1, SIGTSTP: 1, SIGTTIN: 1, SIGTTOU: 1, SIGURG: 1, SIGUSR1: 1, SIGUSR2: 1, SIGVTALRM: 1, SIGWINCH: 1, SIGXCPU: 1, SIGXFSZ: 1 };
	const signalHandlers = new Map();

	// ---- network: TCP and TLS -----------------------------------------------------------------------------
	function addrOf(socket, remote) {
		const hostname = remote ? socket.remoteAddress : socket.localAddress;
		const port = remote ? socket.remotePort : socket.localPort;
		return { transport: "tcp", hostname: hostname === "::ffff:127.0.0.1" ? "127.0.0.1" : hostname, port };
	}

	class Conn {
		#socket;
		#queue = [];
		#waiting = null;
		#ended = false;
		#error = null;
		constructor(socket) {
			this.#socket = socket;
			Object.defineProperty(this, "rid", { value: 0, enumerable: false });
			socket.on("data", (chunk) => {
				this.#queue.push(chunk);
				this.#wake();
			});
			socket.on("end", () => {
				this.#ended = true;
				this.#wake();
			});
			socket.on("close", () => {
				this.#ended = true;
				this.#wake();
			});
			socket.on("error", (e) => {
				this.#error = denoError(e);
				this.#wake();
			});
		}
		#wake() {
			const w = this.#waiting;
			if (w) {
				this.#waiting = null;
				w();
			}
		}
		get localAddr() {
			return addrOf(this.#socket, false);
		}
		get remoteAddr() {
			return addrOf(this.#socket, true);
		}
		async read(buf) {
			if (buf.byteLength === 0) return 0;
			for (;;) {
				if (this.#queue.length) {
					const chunk = this.#queue[0];
					const n = Math.min(chunk.length, buf.byteLength);
					buf.set(chunk.subarray(0, n));
					if (n === chunk.length) this.#queue.shift();
					else this.#queue[0] = chunk.subarray(n);
					return n;
				}
				if (this.#error) throw this.#error;
				if (this.#ended) return null;
				await new Promise((resolve) => {
					this.#waiting = resolve;
				});
			}
		}
		write(buf) {
			return new Promise((resolve, reject) => {
				this.#socket.write(buf, (err) => (err ? reject(denoError(err)) : resolve(buf.byteLength)));
			});
		}
		closeWrite() {
			this.#socket.end();
			return Promise.resolve();
		}
		close() {
			this.#socket.destroy();
		}
		setNoDelay(v = true) {
			this.#socket.setNoDelay(v);
		}
		setKeepAlive(v = true) {
			this.#socket.setKeepAlive(v);
		}
		ref() {
			this.#socket.ref?.();
		}
		unref() {
			this.#socket.unref?.();
		}
		get readable() {
			const self = this;
			return new ReadableStream({
				async pull(controller) {
					const chunk = new Uint8Array(16 * 1024);
					const n = await self.read(chunk);
					if (n === null) controller.close();
					else controller.enqueue(chunk.subarray(0, n));
				},
				cancel() {
					self.close();
				},
			});
		}
		get writable() {
			const self = this;
			return new WritableStream({
				async write(chunk) {
					await self.write(chunk);
				},
				close() {
					return self.closeWrite();
				},
			});
		}
		[Symbol.dispose]() {
			try {
				this.close();
			} catch {}
		}
	}

	class Listener {
		#server;
		#pending = [];
		#waiting = null;
		#closed = false;
		constructor(server) {
			this.#server = server;
			server.on("connection", (socket) => {
				if (this.filter && !this.filter(socket)) {
					socket.destroy();
					return;
				}
				this.#pending.push(new Conn(socket));
				const w = this.#waiting;
				if (w) {
					this.#waiting = null;
					w();
				}
			});
			server.on("close", () => {
				this.#closed = true;
				const w = this.#waiting;
				if (w) {
					this.#waiting = null;
					w();
				}
			});
		}
		get addr() {
			const a = this.#server.address();
			return { transport: "tcp", hostname: a.address === "::" ? "0.0.0.0" : a.address, port: a.port };
		}
		async accept() {
			for (;;) {
				if (this.#pending.length) return this.#pending.shift();
				if (this.#closed) throw new errors.BadResource("Listener has been closed");
				await new Promise((resolve) => {
					this.#waiting = resolve;
				});
			}
		}
		close() {
			if (this.#closed) throw new errors.BadResource("Bad resource ID");
			this.#server.close();
			this.#closed = true;
			const w = this.#waiting;
			if (w) {
				this.#waiting = null;
				w();
			}
		}
		ref() {
			this.#server.ref?.();
		}
		unref() {
			this.#server.unref?.();
		}
		async *[Symbol.asyncIterator]() {
			try {
				for (;;) {
					try {
						yield await this.accept();
					} catch (e) {
						if (e instanceof errors.BadResource) return;
						throw e;
					}
				}
			} finally {
				// Leaving the loop closes the listener, as it does in Deno.
				if (!this.#closed) this.close();
			}
		}
		[Symbol.dispose]() {
			try {
				this.close();
			} catch {}
		}
	}

	function listenWith(create, options) {
		const server = create();
		return new Promise((resolve, reject) => {
			server.once("error", (e) => reject(denoError(e, "listen", `${options.hostname ?? "0.0.0.0"}:${options.port}`)));
			server.listen(options.port ?? 0, options.hostname ?? "0.0.0.0", () => resolve(new Listener(server)));
		});
	}
	let bindsAtOnceResult;
	/** Whether this engine's `server.listen(port, host)` has bound by the time it returns. */
	function bindsAtOnce() {
		if (bindsAtOnceResult === undefined) {
			const probe = require("net").createServer();
			probe.on("error", () => {});
			probe.listen(0, "127.0.0.1");
			bindsAtOnceResult = probe.address() !== null;
			probe.close();
		}
		return bindsAtOnceResult;
	}

	function listenSync(create, options) {
		// Deno.listen is synchronous; the socket is bound before the first accept, which this adapts by
		// returning the listener immediately and deferring accept() until the bind finished.
		const server = create();
		let ready = false;
		let failure = null;
		const listener = new Listener(server);
		const waiters = [];
		const accept = listener.accept.bind(listener);
		listener.accept = async () => {
			if (failure) throw failure;
			return accept();
		};
		server.once("error", (e) => {
			failure = denoError(e, "listen", `${options.hostname ?? "0.0.0.0"}:${options.port}`);
			for (const w of waiters) w();
		});
		const requested = options.hostname ?? "0.0.0.0";
		const onListening = () => {
			ready = true;
			for (const w of waiters) w();
		};
		// Node binds a host name asynchronously, but Deno.listen returns a bound listener whose `addr.port` is
		// known at once, and port 0 leaves no other way to know it. So a specific host with port 0 binds to every
		// interface (which does bind at once) and drops any connection that did not arrive on the requested one.
		if ((options.port ?? 0) === 0 && requested !== "0.0.0.0" && requested !== "::" && !bindsAtOnce()) {
			listener.filter = (socket) => {
				const local = String(socket.localAddress ?? "").replace(/^::ffff:/, "");
				return local === requested || (requested === "localhost" && (local === "127.0.0.1" || local === "::1"));
			};
			server.listen(0, onListening);
		} else server.listen(options.port ?? 0, requested, onListening);
		Object.defineProperty(listener, "addr", {
			get() {
				const a = server.address();
				if (!a) return { transport: "tcp", hostname: requested, port: options.port ?? 0 };
				return { transport: "tcp", hostname: listener.filter ? requested : a.address === "::" ? "0.0.0.0" : a.address, port: a.port };
			},
		});
		listener.ready = new Promise((resolve, reject) => {
			if (ready) resolve();
			else waiters.push(() => (failure ? reject(failure) : resolve()));
		});
		listener.ready.catch(() => {});
		return listener;
	}

	function connectSocket(mod, options) {
		return new Promise((resolve, reject) => {
			const socket = mod.connect({ host: options.hostname ?? "127.0.0.1", port: options.port, ...(options.tls ?? {}) });
			socket.once("error", (e) => reject(denoError(e, "connect", `${options.hostname ?? "127.0.0.1"}:${options.port}`)));
			socket.once(mod === require("tls") ? "secureConnect" : "connect", () => resolve(new Conn(socket)));
		});
	}

	// ---- HTTP server -----------------------------------------------------------------------------------------
	function requestFrom(req, secure, port, bodyBytes) {
		const host = req.headers.host ?? `localhost:${port}`;
		const url = `${secure ? "https" : "http"}://${host}${req.url}`;
		const headers = new Headers();
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			try {
				headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
			} catch {}
		}
		const hasBody = req.method !== "GET" && req.method !== "HEAD" && bodyBytes.length > 0;
		return new Request(url, { method: req.method, headers, body: hasBody ? bodyBytes : undefined });
	}

	async function sendResponse(res, response) {
		if (!(response instanceof Response)) {
			throw new TypeError("Return value from serve handler must be a response or a promise resolving to a response");
		}
		const headers = [];
		response.headers.forEach((value, name) => {
			if (name !== "set-cookie") headers.push([name, value]);
		});
		const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
		for (const c of cookies) headers.push(["set-cookie", c]);
		res.statusCode = response.status;
		if (response.statusText) res.statusMessage = response.statusText;
		for (const [name, value] of headers) res.setHeader(name, [...(res.getHeader(name) ? [].concat(res.getHeader(name)) : []), value]);
		if (!response.body) {
			res.end();
			return;
		}
		const reader = response.body.getReader();
		try {
			for (let r = await reader.read(); !r.done; r = await reader.read()) {
				const chunk = typeof r.value === "string" ? Buffer.from(r.value) : Buffer.from(r.value);
				if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
			}
		} finally {
			reader.releaseLock?.();
		}
		res.end();
	}

	/** A response for an Upgrade request: the connection is raw, so the reply is written to it directly. */
	class RawResponse extends require("events").EventEmitter {
		constructor(socket) {
			super();
			this.socket = socket;
			this.statusCode = 200;
			this.statusMessage = undefined;
			this.headersSent = false;
			this._headers = new Map();
			this._chunks = [];
			socket.once("close", () => this.emit("close"));
		}
		setHeader(name, value) {
			this._headers.set(String(name).toLowerCase(), [String(name), value]);
		}
		getHeader(name) {
			return this._headers.get(String(name).toLowerCase())?.[1];
		}
		write(chunk) {
			this._chunks.push(Buffer.from(chunk));
			return true;
		}
		destroy() {
			this.socket.destroy();
		}
		end() {
			const body = Buffer.concat(this._chunks);
			let head = `HTTP/1.1 ${this.statusCode} ${this.statusMessage ?? require("http").STATUS_CODES[this.statusCode] ?? ""}\r\n`;
			for (const [name, value] of this._headers.values()) {
				for (const v of [].concat(value)) head += `${name}: ${v}\r\n`;
			}
			head += `content-length: ${body.length}\r\nconnection: close\r\n\r\n`;
			this.headersSent = true;
			this.socket.end(Buffer.concat([Buffer.from(head), body]));
		}
	}

	function serve(...args) {
		let options = {};
		let handler;
		if (typeof args[0] === "function") handler = args[0];
		else {
			options = args[0] ?? {};
			handler = typeof args[1] === "function" ? args[1] : options.handler ?? options.fetch;
		}
		if (typeof handler !== "function") throw new TypeError("Deno.serve requires a handler function");
		const secure = Boolean(options.cert && options.key);
		const mod = secure ? require("https") : require("http");
		const serverOptions = secure ? { cert: options.cert, key: options.key } : {};
		const onError =
			options.onError ??
			((err) => {
				console.error(err);
				return new Response("Internal Server Error", { status: 500 });
			});
		const hostname = options.hostname ?? "0.0.0.0";
		const inflight = new Set();
		let resolveFinished;
		const finished = new Promise((resolve) => {
			resolveFinished = resolve;
		});
		let shuttingDown = false;
		const handle = async (req, res, upgrade) => {
			try {
				const chunks = [];
				// An Upgrade request has no body to wait for: the connection carries the new protocol.
				if (!upgrade) for await (const c of req) chunks.push(c);
				const request = requestFrom(req, secure, server.address()?.port, Buffer.concat(chunks));
				Object.defineProperty(request, "__graakSocket", { value: req.socket, enumerable: false });
				const completed = new Promise((resolve) => res.once("close", resolve));
				const info = { remoteAddr: { transport: "tcp", hostname: req.socket.remoteAddress, port: req.socket.remotePort }, completed };
				let response;
				try {
					response = await handler(request, info);
				} catch (err) {
					response = await onError(err);
				}
				if (response && response.__graakUpgrade) return response.__graakUpgrade(req, res);
				await sendResponse(res, response);
			} catch (err) {
				if (!res.headersSent) {
					res.statusCode = 500;
					res.end("Internal Server Error");
				} else res.destroy();
				console.error(err);
			}
		};
		const server = mod.createServer(serverOptions, (req, res) => {
			const job = handle(req, res);
			inflight.add(job);
			job.finally(() => inflight.delete(job));
		});
		server.on("upgrade", (req, socket, head) => {
			const res = new RawResponse(socket);
			res.__graakHead = head;
			const job = handle(req, res, true);
			inflight.add(job);
			job.finally(() => inflight.delete(job));
		});
		const addrPromise = new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 8000, hostname, () => resolve(server.address()));
		});
		const serverObj = {
			finished,
			get addr() {
				const a = server.address();
				return { transport: "tcp", hostname: a && a.address === "::" ? "0.0.0.0" : a?.address ?? hostname, port: a?.port ?? options.port ?? 8000 };
			},
			async shutdown() {
				if (shuttingDown) return finished;
				shuttingDown = true;
				await new Promise((resolve) => {
					server.close(resolve);
					server.closeIdleConnections?.();
				});
				await Promise.allSettled([...inflight]);
				resolveFinished();
			},
			ref() {
				server.ref?.();
			},
			unref() {
				server.unref?.();
			},
			[Symbol.asyncDispose]() {
				return serverObj.shutdown();
			},
		};
		addrPromise.then(
			(a) => {
				const info = { hostname: a.address === "::" ? "0.0.0.0" : a.address, port: a.port, transport: "tcp" };
				if (options.onListen) options.onListen(info);
				else {
					const shown = info.hostname === "0.0.0.0" || info.hostname === "::" ? "0.0.0.0" : info.hostname;
					const scheme = secure ? "https" : "http";
					console.log(`Listening on ${scheme}://${shown}:${info.port}/${shown === "0.0.0.0" ? ` (${scheme}://localhost:${info.port}/)` : ""}`);
				}
			},
			(err) => {
				throw denoError(err, "listen", `${hostname}:${options.port ?? 8000}`);
			}
		);
		if (options.signal) {
			if (options.signal.aborted) serverObj.shutdown();
			else options.signal.addEventListener("abort", () => serverObj.shutdown(), { once: true });
		}
		return serverObj;
	}

	// ---- WebSocket (RFC 6455): the client the global lacks, and the server side of Deno.upgradeWebSocket ----
	const crypto = require("crypto");
	const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

	function encodeFrame(opcode, payload, mask) {
		const len = payload.length;
		const head = [0x80 | opcode];
		const maskBit = mask ? 0x80 : 0;
		if (len < 126) head.push(maskBit | len);
		else if (len < 65536) head.push(maskBit | 126, (len >> 8) & 255, len & 255);
		else {
			head.push(maskBit | 127, 0, 0, 0, 0, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255);
		}
		if (!mask) return Buffer.concat([Buffer.from(head), payload]);
		const key = crypto.randomBytes(4);
		const masked = Buffer.allocUnsafe(len);
		for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
		return Buffer.concat([Buffer.from(head), key, masked]);
	}

	/** Shared WebSocket endpoint over a connected socket; `client` frames are masked, `server` ones are not. */
	class SocketWebSocket extends EventTarget {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;
		CONNECTING = 0;
		OPEN = 1;
		CLOSING = 2;
		CLOSED = 3;
		#socket = null;
		#client;
		#buffer = Buffer.alloc(0);
		#fragments = [];
		#fragmentOpcode = 0;
		#closeSent = false;
		binaryType = "blob";
		readyState = 0;
		url = "";
		protocol = "";
		extensions = "";
		bufferedAmount = 0;
		onopen = null;
		onmessage = null;
		onclose = null;
		onerror = null;
		constructor(client) {
			super();
			this.#client = client;
		}
		_attach(socket) {
			this.#socket = socket;
			this.readyState = 1;
			socket.on("data", (chunk) => this.#onData(chunk));
			socket.on("close", () => this.#finish(1006, "", false));
			socket.on("error", () => {});
		}
		/** Bytes that arrived with the handshake, handled after "open" so no message precedes it. */
		_feed(head) {
			if (head && head.length) this.#onData(head);
		}
		/** Events are delivered one per task, as in a browser, so a handler set after an await still sees the next one. */
		_emit(type, init) {
			setTimeout(() => {
				const event = type === "message" ? new MessageEvent("message", init) : type === "close" ? new CloseEvent("close", init) : new Event(type);
				const handler = this["on" + type];
				if (typeof handler === "function") handler.call(this, event);
				this.dispatchEvent(event);
			}, 0);
		}
		#onData(chunk) {
			this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
			for (;;) {
				const b = this.#buffer;
				if (b.length < 2) return;
				const opcode = b[0] & 15;
				const fin = (b[0] & 0x80) !== 0;
				const masked = (b[1] & 0x80) !== 0;
				let len = b[1] & 127;
				let off = 2;
				if (len === 126) {
					if (b.length < 4) return;
					len = b.readUInt16BE(2);
					off = 4;
				} else if (len === 127) {
					if (b.length < 10) return;
					len = b.readUInt32BE(2) * 4294967296 + b.readUInt32BE(6);
					off = 10;
				}
				const total = off + (masked ? 4 : 0) + len;
				if (b.length < total) return;
				let payload = b.subarray(off + (masked ? 4 : 0), total);
				if (masked) {
					const key = b.subarray(off, off + 4);
					const out = Buffer.allocUnsafe(len);
					for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
					payload = out;
				}
				this.#buffer = b.subarray(total);
				this.#frame(opcode, fin, payload);
			}
		}
		#frame(opcode, fin, payload) {
			if (opcode === 0x8) {
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
				const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
				if (!this.#closeSent) this.#sendClose(code === 1005 ? 1000 : code, "");
				this.#finish(code, reason, true);
			} else if (opcode === 0x9) this.#write(0xa, payload);
			else if (opcode === 0xa) return;
			else {
				if (opcode !== 0) {
					this.#fragmentOpcode = opcode;
					this.#fragments = [];
				}
				this.#fragments.push(payload);
				if (!fin) return;
				const whole = Buffer.concat(this.#fragments);
				this.#fragments = [];
				if (this.#fragmentOpcode === 1) this._emit("message", { data: whole.toString("utf8") });
				else {
					const data = this.binaryType === "arraybuffer" ? whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.length) : new Blob([whole]);
					this._emit("message", { data });
				}
			}
		}
		#write(opcode, payload) {
			if (this.#socket && !this.#socket.destroyed) this.#socket.write(encodeFrame(opcode, payload, this.#client));
		}
		#sendClose(code, reason) {
			this.#closeSent = true;
			const body = Buffer.alloc(2 + Buffer.byteLength(reason));
			body.writeUInt16BE(code, 0);
			body.write(reason, 2);
			this.#write(0x8, body);
		}
		#finish(code, reason, wasClean) {
			if (this.readyState === 3) return;
			this.readyState = 3;
			try {
				this.#socket?.end();
			} catch {}
			this._emit("close", { code, reason, wasClean });
		}
		send(data) {
			if (this.readyState !== 1) throw new DOMException("readyState not OPEN", "InvalidStateError");
			if (typeof data === "string") this.#write(0x1, Buffer.from(data));
			else if (data instanceof Blob) data.arrayBuffer().then((ab) => this.#write(0x2, Buffer.from(ab)));
			else if (ArrayBuffer.isView(data)) this.#write(0x2, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
			else this.#write(0x2, Buffer.from(data));
		}
		close(code = 1000, reason = "") {
			if (this.readyState >= 2) return;
			this.readyState = 2;
			this.#sendClose(code, reason);
			setTimeout(() => this.#finish(code, reason, true), 1000).unref?.();
		}
		ping() {}
	}
	class WebSocketClient extends SocketWebSocket {
		constructor(url, protocols) {
			super(true);
			const parsed = new URL(url);
			if (parsed.protocol === "http:") parsed.protocol = "ws:";
			if (parsed.protocol === "https:") parsed.protocol = "wss:";
			if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new DOMException(`The URL's scheme must be either 'ws' or 'wss'. '${parsed.protocol}' is not allowed.`, "SyntaxError");
			this.url = parsed.href;
			const secure = parsed.protocol === "wss:";
			const key = crypto.randomBytes(16).toString("base64");
			const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
			const mod = secure ? require("https") : require("http");
			const req = mod.request({
				host: parsed.hostname,
				port: parsed.port || (secure ? 443 : 80),
				path: `${parsed.pathname}${parsed.search}`,
				headers: {
					Connection: "Upgrade",
					Upgrade: "websocket",
					"Sec-WebSocket-Key": key,
					"Sec-WebSocket-Version": "13",
					...(list.length ? { "Sec-WebSocket-Protocol": list.join(", ") } : {}),
				},
			});
			req.on("upgrade", (res, socket, head) => {
				const expected = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
				if (res.headers["sec-websocket-accept"] !== expected) {
					socket.destroy();
					this._emit("error");
					this._finishFailed();
					return;
				}
				this.protocol = res.headers["sec-websocket-protocol"] ?? "";
				this._attach(socket);
				this._emit("open");
				this._feed(head);
			});
			req.on("response", () => {
				this._emit("error");
				this._finishFailed();
			});
			req.on("error", () => {
				this._emit("error");
				this._finishFailed();
			});
			req.end();
		}
		_finishFailed() {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this._emit("close", { code: 1006, reason: "", wasClean: false });
		}
	}

	if (typeof global.WebSocket === "undefined") {
		Object.defineProperty(global, "WebSocket", { value: WebSocketClient, writable: true, configurable: true });
	}
	if (typeof global.CloseEvent === "undefined") {
		global.CloseEvent = class CloseEvent extends Event {
			constructor(type, init = {}) {
				super(type);
				this.code = init.code ?? 0;
				this.reason = init.reason ?? "";
				this.wasClean = init.wasClean ?? false;
			}
		};
	}
	if (typeof global.MessageEvent === "undefined") {
		global.MessageEvent = class MessageEvent extends Event {
			constructor(type, init = {}) {
				super(type);
				this.data = init.data;
				this.origin = init.origin ?? "";
				this.lastEventId = init.lastEventId ?? "";
			}
		};
	}

	function upgradeWebSocket(request, options = {}) {
		const upgrade = request.headers.get("upgrade");
		if (!upgrade || upgrade.toLowerCase() !== "websocket") {
			throw new TypeError("Invalid Header: 'upgrade' header must contain 'websocket'");
		}
		const key = request.headers.get("sec-websocket-key");
		if (!key) throw new TypeError("Invalid Header: 'sec-websocket-key' header must be set");
		const socket = new SocketWebSocket(false);
		socket.binaryType = "arraybuffer";
		const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
		const chosen = options.protocol && protocols.includes(options.protocol) ? options.protocol : "";
		socket.protocol = chosen;
		socket.url = request.url.replace(/^http/, "ws");
		const response = new Response(null, { status: 200 });
		Object.defineProperty(response, "__graakUpgrade", {
			value: (req, res) => {
				const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
				const conn = req.socket;
				conn.write(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${chosen ? `Sec-WebSocket-Protocol: ${chosen}\r\n` : ""}\r\n`
				);
				socket._attach(conn);
				socket._emit("open");
				socket._feed(res.__graakHead);
			},
		});
		return { socket, response };
	}

	// ---- subprocesses ------------------------------------------------------------------------------------------
	class Command {
		#command;
		#options;
		constructor(command, options = {}) {
			this.#command = command instanceof URL ? fileURLToPath(command) : command;
			this.#options = options;
		}
		#spawnOptions() {
			const o = this.#options;
			const env = o.clearEnv ? { ...(o.env ?? {}) } : { ...process.env, ...(o.env ?? {}) };
			return {
				cwd: o.cwd ? toPath(o.cwd) : undefined,
				env,
				windowsVerbatimArguments: o.windowsRawArguments,
				uid: o.uid,
				gid: o.gid,
			};
		}
		outputSync() {
			const cp = require("child_process");
			const o = this.#options;
			const opts = this.#spawnOptions();
			opts.stdio = [o.stdin === "inherit" ? "inherit" : "ignore", o.stdout === "inherit" ? "inherit" : o.stdout === "null" ? "ignore" : "pipe", o.stderr === "inherit" ? "inherit" : o.stderr === "null" ? "ignore" : "pipe"];
			const r = cp.spawnSync(this.#command, o.args ?? [], opts);
			if (r.error) throw denoError(r.error, "spawn", this.#command);
			return {
				success: r.status === 0,
				code: r.status ?? 128,
				signal: r.signal ?? null,
				stdout: bytes(r.stdout ?? Buffer.alloc(0)),
				stderr: bytes(r.stderr ?? Buffer.alloc(0)),
			};
		}
		async output() {
			const child = this.spawn();
			return child.output();
		}
		spawn() {
			const cp = require("child_process");
			const o = this.#options;
			const opts = this.#spawnOptions();
			opts.stdio = [
				o.stdin === "piped" ? "pipe" : o.stdin === "null" ? "ignore" : "inherit",
				o.stdout === "inherit" ? "inherit" : o.stdout === "null" ? "ignore" : "pipe",
				o.stderr === "inherit" ? "inherit" : o.stderr === "null" ? "ignore" : "pipe",
			];
			const child = cp.spawn(this.#command, o.args ?? [], opts);
			return new ChildProcess(child, o);
		}
	}

	class ChildProcess {
		#child;
		#options;
		#status;
		#out = [];
		#err = [];
		#accessed = false;
		constructor(child, options) {
			this.#child = child;
			this.#options = options;
			this.pid = child.pid;
			child.stdout?.on("data", (c) => this.#out.push(c));
			child.stderr?.on("data", (c) => this.#err.push(c));
			this.#status = new Promise((resolve, reject) => {
				child.once("error", (e) => reject(denoError(e, "spawn", "")));
				child.once("close", (code, signal) => resolve({ success: code === 0, code: code ?? 128, signal: signal ?? null }));
			});
			this.#status.catch(() => {});
			if (options.signal) {
				options.signal.addEventListener("abort", () => this.kill("SIGTERM"), { once: true });
			}
		}
		get status() {
			return this.#status;
		}
		#stream(child, store) {
			if (!child) return null;
			this.#accessed = true;
			return new ReadableStream({
				start(controller) {
					for (const c of store) controller.enqueue(bytes(c));
					child.on("data", (c) => controller.enqueue(bytes(c)));
					child.on("end", () => controller.close());
				},
			});
		}
		get stdout() {
			return this.#stream(this.#child.stdout, this.#out);
		}
		get stderr() {
			return this.#stream(this.#child.stderr, this.#err);
		}
		get stdin() {
			const stdin = this.#child.stdin;
			if (!stdin) return null;
			return new WritableStream({
				write(chunk) {
					return new Promise((resolve) => stdin.write(chunk, resolve));
				},
				close() {
					stdin.end();
				},
			});
		}
		async output() {
			if (this.#accessed) throw new TypeError("Cannot call output() if stdout or stderr have been accessed");
			const status = await this.#status;
			return {
				...status,
				stdout: bytes(Buffer.concat(this.#out)),
				stderr: bytes(Buffer.concat(this.#err)),
			};
		}
		kill(signal = "SIGTERM") {
			this.#child.kill(signal);
		}
		ref() {
			this.#child.ref?.();
		}
		unref() {
			this.#child.unref?.();
		}
		async [Symbol.asyncDispose]() {
			try {
				this.kill();
			} catch {}
			await this.#status.catch(() => {});
		}
	}

	// ---- assembly --------------------------------------------------------------------------------------------------
	const permissionStatus = (desc) => {
		const status = new EventTarget();
		status.state = "granted";
		status.onchange = null;
		status.partial = false;
		status.name = desc?.name;
		return status;
	};

	function osRelease() {
		return os.release();
	}

	const Deno = {
		version: { deno: VERSION, v8: V8_VERSION, typescript: TS_VERSION },
		build: { target: TARGET, arch: ARCH, os: OS, vendor: OS === "darwin" ? "apple" : OS === "windows" ? "pc" : "unknown", env: OS === "windows" ? "msvc" : OS === "linux" ? "gnu" : undefined, standalone: true },
		args: process.argv.slice(2),
		pid: process.pid,
		ppid: process.ppid,
		noColor: Boolean(process.env.NO_COLOR),
		mainModule: pathToFileURL(process.argv[1] ?? path.join(process.cwd(), "main.js")).href,
		env: envApi,
		errors,
		SeekMode,
		FsFile,
		Command,
		ChildProcess,
		Listener,
		Conn,
		stdin: stdStream(0, true),
		stdout: stdStream(1, false),
		stderr: stdStream(2, false),
		customInspect: Symbol.for("Deno.customInspect"),
		inspect: (value, options) => util.inspect(value, options),
		cwd: () => process.cwd(),
		chdir: (p) => process.chdir(toPath(p)),
		execPath: () => process.execPath,
		exit: (code) => process.exit(code ?? 0),
		hostname: () => os.hostname(),
		osRelease,
		osUptime: () => Math.floor(os.uptime()),
		loadavg: () => os.loadavg(),
		uid: () => (process.getuid ? process.getuid() : null),
		gid: () => (process.getgid ? process.getgid() : null),
		umask: (mask) => (mask === undefined ? process.umask() : process.umask(mask)),
		memoryUsage: () => {
			const m = process.memoryUsage();
			return { rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external };
		},
		systemMemoryInfo: () => ({ total: os.totalmem(), free: os.freemem(), available: os.freemem(), buffers: 0, cached: 0, swapTotal: 0, swapFree: 0 }),
		networkInterfaces: () => {
			const out = [];
			for (const [name, list] of Object.entries(os.networkInterfaces())) {
				for (const i of list ?? []) {
					out.push({ family: i.family === "IPv4" || i.family === 4 ? "IPv4" : "IPv6", name, address: i.address, netmask: i.netmask, scopeid: i.scopeid ?? null, cidr: i.cidr, mac: i.mac });
				}
			}
			return out;
		},
		consoleSize: () => ({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }),
		isatty: (rid) => require("tty").isatty(rid),
		kill: (pid, signal = "SIGTERM") => process.kill(pid, signal),
		addSignalListener: (sig, handler) => {
			if (!(sig in signalNames)) throw new TypeError(`Unknown signal: ${sig}`);
			process.on(sig, handler);
			signalHandlers.set(handler, sig);
		},
		removeSignalListener: (sig, handler) => {
			process.removeListener(sig, handler);
			signalHandlers.delete(handler);
		},
		permissions: {
			query: async (desc) => permissionStatus(desc),
			querySync: (desc) => permissionStatus(desc),
			request: async (desc) => permissionStatus(desc),
			requestSync: (desc) => permissionStatus(desc),
			revoke: async (desc) => permissionStatus(desc),
			revokeSync: (desc) => permissionStatus(desc),
		},
		listen: (options) => {
			if (options.transport && options.transport !== "tcp") throw unsupported(`Deno.listen({ transport: "${options.transport}" })`, "only TCP is available");
			return listenSync(() => require("net").createServer(), options);
		},
		connect: (options) => {
			if (options.transport && options.transport !== "tcp") return Promise.reject(unsupported(`Deno.connect({ transport: "${options.transport}" })`, "only TCP is available"));
			return connectSocket(require("net"), options);
		},
		listenTls: (options) => listenSync(() => require("tls").createServer({ cert: options.cert ?? fs.readFileSync(options.certFile), key: options.key ?? fs.readFileSync(options.keyFile) }), options),
		connectTls: (options) =>
			connectSocket(require("tls"), { ...options, tls: { servername: options.hostname, ...(options.caCerts ? { ca: options.caCerts } : {}) } }),
		serve,
		upgradeWebSocket,
		test: () => {
			throw unsupported("Deno.test", "tests run under `deno test`");
		},
		bench: () => {
			throw unsupported("Deno.bench", "benchmarks run under `deno bench`");
		},
		openKv: async () => {
			throw unsupported("Deno.openKv", "Deno KV needs Deno's own storage engine; use a database driver instead");
		},
		cron: () => {
			throw unsupported("Deno.cron", "schedule work with setInterval or an OS scheduler");
		},
		dlopen: () => {
			throw unsupported("Deno.dlopen (FFI)", "load native code through a Node-API addon instead");
		},
		watchFs: () => {
			throw unsupported("Deno.watchFs");
		},
		...fsApi,
	};
	for (const name of ["UnsafePointer", "UnsafePointerView", "UnsafeFnPointer", "UnsafeCallback"]) {
		Object.defineProperty(Deno, name, {
			get() {
				throw unsupported(`Deno.${name} (FFI)`);
			},
			enumerable: false,
		});
	}

	// The Deno global is not enumerable, as in Deno.
	Object.defineProperty(global, "Deno", { value: Deno, writable: true, configurable: true, enumerable: false });
})(globalThis);

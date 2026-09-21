/*
 * The rest of Node's system surface: `os`, the standard streams, `vm`, `module`, `punycode`, `constants`, and honest
 * explanations for the modules the host cannot provide (`cluster`, `dgram`, `inspector`, `repl`, `wasi`, ...).
 *
 * Where a value can be read from the machine (CPU count, memory, hostname), it is; where it cannot, the function
 * still exists and returns a plausible, documented neutral value rather than throwing, because programs size worker
 * pools and buffers from these and a missing function is a crash where a rough number is only a rough number.
 */

const unavailable = (what, why) =>
	Object.assign(new Error(`${what} is not available in the ForgeGraal native host: ${why}`), {
		code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
	});

/* -------------------------------------------------------------------------- os */

function createOs({ std, processModule, readText }) {
	const isWindows = processModule.platform === "win32";
	const read = (file) => {
		try {
			return readText(file);
		} catch {
			return null;
		}
	};
	const env = processModule.env;

	const cpus = () => {
		let count = 0;
		let model = "ForgeGraal CPU";
		const info = isWindows ? null : read("/proc/cpuinfo");
		if (info) {
			for (const line of info.split("\n")) {
				if (line.startsWith("processor")) count++;
				else if (line.startsWith("model name") && model === "ForgeGraal CPU") model = line.split(":")[1].trim();
			}
		}
		if (!count) count = Number(env.NUMBER_OF_PROCESSORS) || 1;
		return Array.from({ length: count }, () => ({ model, speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
	};

	const meminfo = (key) => {
		const info = isWindows ? null : read("/proc/meminfo");
		const match = info && new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(info);
		return match ? Number(match[1]) * 1024 : null;
	};

	const constants = {
		UV_UDP_REUSEADDR: 4,
		dlopen: { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0 },
		errno: { E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EAGAIN: 11, EBADF: 9, ECONNREFUSED: 111, ECONNRESET: 104, EEXIST: 17, EINVAL: 22, EISDIR: 21, EMFILE: 24, ENOENT: 2, ENOTDIR: 20, ENOTEMPTY: 39, EPERM: 1, EPIPE: 32, ETIMEDOUT: 110 },
		signals: { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22 },
		priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },
	};

	return {
		platform: () => processModule.platform,
		arch: () => processModule.arch,
		machine: () => ({ x64: "x86_64", ia32: "i686", arm64: "aarch64", arm: "armv7l" })[processModule.arch] ?? processModule.arch,
		type: () => (isWindows ? "Windows_NT" : "Linux"),
		release: () => (isWindows ? "10.0.0" : (read("/proc/sys/kernel/osrelease")?.trim() ?? "")),
		version: () => (isWindows ? "Windows" : (read("/proc/sys/kernel/version")?.trim() ?? "")),
		homedir: () => env.HOME ?? env.USERPROFILE ?? (isWindows ? "C:\\" : "/"),
		tmpdir: () => {
			const dir = env.TMPDIR ?? env.TMP ?? env.TEMP ?? (isWindows ? `${env.SystemRoot ?? "C:\\Windows"}\\Temp` : "/tmp");
			return dir.length > 1 && /[\\/]$/.test(dir) && !/^[A-Za-z]:[\\/]$/.test(dir) ? dir.slice(0, -1) : dir;
		},
		hostname: () => env.HOSTNAME ?? env.COMPUTERNAME ?? read("/etc/hostname")?.trim() ?? "localhost",
		cpus,
		availableParallelism: () => cpus().length,
		totalmem: () => meminfo("MemTotal") ?? 1024 ** 3,
		freemem: () => meminfo("MemAvailable") ?? meminfo("MemFree") ?? 512 * 1024 ** 2,
		uptime: () => {
			const text = isWindows ? null : read("/proc/uptime");
			return text ? Number(text.split(" ")[0]) : processModule.uptime();
		},
		loadavg: () => {
			const text = isWindows ? null : read("/proc/loadavg");
			return text ? text.split(" ").slice(0, 3).map(Number) : [0, 0, 0];
		},
		networkInterfaces: () => ({ lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }] }),
		userInfo: () => ({
			uid: -1,
			gid: -1,
			username: env.USER ?? env.USERNAME ?? env.LOGNAME ?? "user",
			homedir: env.HOME ?? env.USERPROFILE ?? "",
			shell: env.SHELL ?? null,
		}),
		getPriority: () => 0,
		setPriority: () => {},
		EOL: isWindows ? "\r\n" : "\n",
		devNull: isWindows ? "\\\\.\\nul" : "/dev/null",
		endianness: () => "LE",
		constants,
	};
}

/* ------------------------------------------------------------ standard streams */

/*
 * process.stdout / stderr are Writables over the file descriptors, so pipe(), write(Buffer) and 'drain' behave; stdin is a
 * Readable that reads without blocking the event loop where the engine can watch a descriptor.
 */
function createStdio({ os, std, Buffer, stream }) {
	const isTTY = (fd) => {
		try {
			return Boolean(os.isatty(fd));
		} catch {
			return false;
		}
	};

	const makeOut = (fd, file) => {
		const out = new stream.Writable({
			decodeStrings: true,
			write(chunk, encoding, callback) {
				try {
					// The engine's own FILE* buffers stay in step with console.log, which writes through them.
					file.flush();
					let done = 0;
					while (done < chunk.length) {
						const n = os.write(fd, chunk.buffer, chunk.byteOffset + done, chunk.length - done);
						if (n < 0) {
							if (n === -11) continue; // EAGAIN on a non-blocking pipe: try again
							throw Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: n, syscall: "write" });
						}
						done += n;
					}
					callback();
				} catch (err) {
					callback(err);
				}
			},
		});
		out.fd = fd;
		// Node leaves isTTY undefined on a pipe or file, and true on a terminal.
		if (isTTY(fd)) out.isTTY = true;
		out._isStdio = true;
		out.writable = true;
		out.destroySoon = out.destroy;
		out._destroy = (err, cb) => cb(err); // stdout is never closed
		if (out.isTTY) {
			const size = os.ttyGetWinSize?.(fd);
			out.columns = size?.[0] ?? 80;
			out.rows = size?.[1] ?? 24;
			out.getWindowSize = () => [out.columns, out.rows];
			out.hasColors = () => true;
			out.getColorDepth = () => 8;
			out.cursorTo = () => true;
			out.moveCursor = () => true;
			out.clearLine = () => true;
			out.clearScreenDown = () => true;
		}
		return out;
	};

	let stdin = null;
	const getStdin = () => {
		if (stdin) return stdin;
		stdin = new stream.Readable({
			read() {
				if (this._watching) return;
				this._watching = true;
				const chunk = new Uint8Array(16384);
				const onReadable = () => {
					const n = os.read(0, chunk.buffer, 0, chunk.length);
					if (n > 0) {
						if (!this.push(Buffer.from(chunk.subarray(0, n)))) {
							this._watching = false;
							if (os.setReadHandler) os.setReadHandler(0, null);
						}
					} else if (n === 0) {
						if (os.setReadHandler) os.setReadHandler(0, null);
						this._watching = false;
						this.push(null);
					}
				};
				if (os.setReadHandler) os.setReadHandler(0, onReadable);
				else onReadable(); // Windows: the engine cannot watch a console handle, so a read blocks
			},
		});
		stdin.fd = 0;
		if (isTTY(0)) stdin.isTTY = true;
		stdin.setRawMode = (mode) => {
			if (os.ttySetRaw && mode) os.ttySetRaw(0);
			return stdin;
		};
		stdin.ref = () => stdin;
		stdin.unref = () => stdin;
		return stdin;
	};

	return { stdout: makeOut(1, std.out), stderr: makeOut(2, std.err), getStdin };
}

/* -------------------------------------------------------------------------- vm */

/*
 * vm without a second engine context: code runs in this realm. A "context" is a sandbox object; the code's free
 * variables read and write it through a `with` block over a Proxy that claims every name, so nothing it assigns
 * leaks onto the real global and what it reads falls back to the built-ins. That is enough for the users of vm in
 * practice -- template compilers, config evaluators, test harnesses -- and is not a security boundary.
 */
function createVm({ evalScript }) {
	const contexts = new WeakSet();
	const scopeFor = (sandbox) =>
		new Proxy(sandbox, {
			// `eval` and the two parameters stay out of the sandbox so the direct eval below is still direct.
			has: (_target, key) => key !== Symbol.unscopables && key !== "eval" && key !== "__fgScope" && key !== "__fgCode",
			get: (target, key) => {
				if (key === Symbol.unscopables) return undefined;
				if (key in target) return target[key];
				if (key === "globalThis" || key === "global" || key === "self") return target;
				return globalThis[key];
			},
			set: (target, key, value) => {
				target[key] = value;
				return true;
			},
		});

	const runIn = (code, sandbox, filename) => {
		const fn = evalScript(`(function (__fgScope, __fgCode) { with (__fgScope) { return eval(__fgCode); } })`, filename ?? "vm.js");
		return fn(scopeFor(sandbox), String(code));
	};

	class Script {
		constructor(code, options = {}) {
			this.code = String(code);
			this.filename = typeof options === "string" ? options : (options.filename ?? "evalmachine.<anonymous>");
			// Syntax errors surface when the script is created, as in Node.
			new Function(this.code);
		}
		runInThisContext() {
			return evalScript(this.code, this.filename);
		}
		runInContext(context) {
			return runIn(this.code, context, this.filename);
		}
		runInNewContext(sandbox = {}) {
			return runIn(this.code, createContext(sandbox), this.filename);
		}
		createCachedData() {
			return new Uint8Array(0);
		}
	}

	function createContext(sandbox = {}) {
		contexts.add(sandbox);
		return sandbox;
	}

	return {
		Script,
		createContext,
		isContext: (value) => contexts.has(value),
		runInThisContext: (code, options) => evalScript(String(code), typeof options === "string" ? options : (options?.filename ?? "evalmachine.<anonymous>")),
		runInContext: (code, context, options) => runIn(code, context, typeof options === "string" ? options : options?.filename),
		runInNewContext: (code, sandbox = {}, options) => runIn(code, createContext(sandbox), typeof options === "string" ? options : options?.filename),
		compileFunction(code, params = [], options = {}) {
			const fn = new Function(...params, String(code));
			if (options.contextExtensions?.length) {
				const scope = Object.assign({}, ...options.contextExtensions);
				return new Function("__fgScope", `with (__fgScope) { return function (${params.join(",")}) { ${code} }; }`)(scope);
			}
			return fn;
		},
		measureMemory: async () => ({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } }),
		constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("vm_dynamic_import_main_context_default"), DONT_CONTEXTIFY: Symbol("vm_context_no_contextify") },
	};
}

/* ---------------------------------------------------------------------- module */

function createModuleModule({ builtins, moduleCache, createRequire, resolveModule, pathModule, readText, evalScript }) {
	function Module(id = "", parent) {
		this.id = id;
		this.path = pathModule.dirname(id);
		this.exports = {};
		this.filename = null;
		this.loaded = false;
		this.children = [];
		this.paths = Module._nodeModulePaths(this.path);
		this.parent = parent;
	}
	Module.prototype.require = function require(id) {
		return createRequire(this.filename ?? this.id)(id);
	};
	Module.prototype._compile = function _compile(content, filename) {
		const wrapper = evalScript(Module.wrap(content), filename);
		this.filename = filename;
		return wrapper.call(this.exports, this.exports, createRequire(filename), this, filename, pathModule.dirname(filename));
	};

	const wrapper = ["(function (exports, require, module, __filename, __dirname) { ", "\n});"];
	Module.wrapper = wrapper;
	Module.wrap = (script) => wrapper[0] + script + wrapper[1];
	Module.builtinModules = Object.keys(builtins).filter((name) => !name.startsWith("_"));
	Module.isBuiltin = (name) => {
		const bare = String(name).startsWith("node:") ? String(name).slice(5) : String(name);
		return bare in builtins;
	};
	Module.createRequire = (filename) => {
		const file = typeof filename === "object" && filename?.href ? decodeURIComponent(filename.pathname) : String(filename).replace(/^file:\/\//, "");
		return createRequire(file);
	};
	Module._cache = moduleCache;
	Module._pathCache = Object.create(null);
	Module._extensions = {
		".js": (module, filename) => module._compile(readText(filename), filename),
		".json": (module, filename) => {
			module.exports = JSON.parse(readText(filename));
		},
		".node": (module, filename) => {
			process.dlopen(module, filename);
		},
	};
	Module.globalPaths = [];
	Module._nodeModulePaths = (from) => {
		const paths = [];
		let dir = pathModule.resolve(from);
		for (;;) {
			if (pathModule.basename(dir) !== "node_modules") paths.push(pathModule.join(dir, "node_modules"));
			const parent = pathModule.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return paths;
	};
	Module._resolveFilename = (request, parent) => {
		const from = parent?.filename ? pathModule.dirname(parent.filename) : process.cwd();
		const resolved = resolveModule(request, from);
		return resolved.builtin ?? resolved.file;
	};
	Module._load = (request, parent) => createRequire(parent?.filename ?? `${process.cwd()}/`)(request);
	Module.syncBuiltinESMExports = () => {};
	Module.findSourceMap = () => undefined;
	Module.register = () => {};
	Module.enableCompileCache = () => ({ status: 3 });
	Module.constants = { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } };
	Module.Module = Module;
	return Module;
}

/* -------------------------------------------------------------------- punycode */

/* Bootstring encoding of Unicode for host names (RFC 3492), as Node's deprecated `punycode` module. */
function createPunycode() {
	const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128, delimiter = "-";
	const error = (type) => new RangeError({ overflow: "Overflow: input needs wider integers to process", "not-basic": "Illegal input >= 0x80 (not a basic code point)", "invalid-input": "Invalid input" }[type]);
	const adapt = (delta, numPoints, firstTime) => {
		let k = 0;
		delta = firstTime ? Math.floor(delta / damp) : delta >> 1;
		delta += Math.floor(delta / numPoints);
		for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
		return Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));
	};
	const digitToBasic = (digit) => digit + 22 + 75 * (digit < 26);
	const ucs2decode = (string) => {
		const output = [];
		for (let i = 0; i < string.length; ) {
			const value = string.charCodeAt(i++);
			if (value >= 0xd800 && value <= 0xdbff && i < string.length) {
				const extra = string.charCodeAt(i++);
				if ((extra & 0xfc00) === 0xdc00) output.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);
				else {
					output.push(value);
					i--;
				}
			} else output.push(value);
		}
		return output;
	};
	const ucs2encode = (codePoints) => String.fromCodePoint(...codePoints);
	function decode(input) {
		const output = [];
		const inputLength = input.length;
		let i = 0, n = initialN, bias = initialBias;
		let basic = input.lastIndexOf(delimiter);
		if (basic < 0) basic = 0;
		for (let j = 0; j < basic; ++j) {
			if (input.charCodeAt(j) >= 0x80) throw error("not-basic");
			output.push(input.charCodeAt(j));
		}
		for (let index = basic > 0 ? basic + 1 : 0; index < inputLength; ) {
			const oldi = i;
			for (let w = 1, k = base; ; k += base) {
				if (index >= inputLength) throw error("invalid-input");
				const c = input.charCodeAt(index++);
				const digit = c >= 0x30 && c < 0x3a ? c - 22 : c >= 0x41 && c < 0x5b ? c - 0x41 : c >= 0x61 && c < 0x7b ? c - 0x61 : base;
				if (digit >= base) throw error("invalid-input");
				if (digit > Math.floor((0x7fffffff - i) / w)) throw error("overflow");
				i += digit * w;
				const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
				if (digit < t) break;
				w *= base - t;
			}
			const out = output.length + 1;
			bias = adapt(i - oldi, out, oldi === 0);
			if (Math.floor(i / out) > 0x7fffffff - n) throw error("overflow");
			n += Math.floor(i / out);
			i %= out;
			output.splice(i++, 0, n);
		}
		return String.fromCodePoint(...output);
	}
	function encode(input) {
		const output = [];
		input = ucs2decode(input);
		let n = initialN, delta = 0, bias = initialBias;
		for (const c of input) if (c < 0x80) output.push(String.fromCharCode(c));
		const basicLength = output.length;
		let handled = basicLength;
		if (basicLength) output.push(delimiter);
		while (handled < input.length) {
			let m = 0x7fffffff;
			for (const c of input) if (c >= n && c < m) m = c;
			if (m - n > Math.floor((0x7fffffff - delta) / (handled + 1))) throw error("overflow");
			delta += (m - n) * (handled + 1);
			n = m;
			for (const c of input) {
				if (c < n && ++delta > 0x7fffffff) throw error("overflow");
				if (c === n) {
					let q = delta;
					for (let k = base; ; k += base) {
						const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
						if (q < t) break;
						output.push(String.fromCharCode(digitToBasic(t + ((q - t) % (base - t)))));
						q = Math.floor((q - t) / (base - t));
					}
					output.push(String.fromCharCode(digitToBasic(q)));
					bias = adapt(delta, handled + 1, handled === basicLength);
					delta = 0;
					++handled;
				}
			}
			++delta;
			++n;
		}
		return output.join("");
	}
	const mapDomain = (domain, fn) => {
		const parts = domain.split("@");
		let result = "";
		if (parts.length > 1) {
			result = `${parts[0]}@`;
			domain = parts[1];
		}
		return result + domain.replace(/[\u3002\uff0e\uff61]/g, ".").split(".").map(fn).join(".");
	};
	return {
		version: "2.1.0",
		ucs2: { decode: ucs2decode, encode: ucs2encode },
		decode,
		encode,
		toUnicode: (input) => mapDomain(input, (s) => (/^xn--/.test(s) ? decode(s.slice(4).toLowerCase()) : s)),
		toASCII: (input) => mapDomain(input, (s) => (/[^\0-\x7f]/.test(s) ? `xn--${encode(s)}` : s)),
	};
}

/* ----------------------------------------------------------- modules with no host */

function createUnavailable(EventEmitter) {
	const notAvailable = (what, why) => () => {
		throw unavailable(what, why);
	};
	class Domain extends EventEmitter {
		constructor() {
			super();
			this.members = [];
		}
		run(fn, ...args) {
			return fn(...args);
		}
		add(emitter) {
			this.members.push(emitter);
		}
		remove(emitter) {
			this.members = this.members.filter((m) => m !== emitter);
		}
		bind(fn) {
			return fn;
		}
		intercept(fn) {
			return fn;
		}
		enter() {}
		exit() {}
		dispose() {}
	}
	return {
		domain: { Domain, create: () => new Domain(), createDomain: () => new Domain(), active: null },
		cluster: Object.assign(new EventEmitter(), {
			isPrimary: true,
			isMaster: true,
			isWorker: false,
			workers: {},
			settings: {},
			schedulingPolicy: 2,
			SCHED_NONE: 1,
			SCHED_RR: 2,
			fork: notAvailable("cluster.fork()", "there are no worker processes; run several copies of the program instead"),
			setupPrimary() {},
			setupMaster() {},
			disconnect(callback) {
				callback?.();
			},
		}),
		dgram: {
			createSocket: notAvailable("dgram.createSocket()", "the host has TCP sockets only, not UDP"),
			Socket: class Socket {},
		},
		inspector: {
			open() {},
			close() {},
			url: () => undefined,
			waitForDebugger: notAvailable("inspector.waitForDebugger()", "there is no debugger protocol"),
			Session: class Session extends EventEmitter {
				connect() {
					throw unavailable("inspector.Session", "there is no debugger protocol");
				}
			},
			console: globalThis.console,
		},
		trace_events: { createTracing: () => ({ enable() {}, disable() {}, enabled: false, categories: "" }), getEnabledCategories: () => undefined },
		repl: { start: notAvailable("repl.start()", "there is no interactive terminal session"), REPLServer: class REPLServer extends EventEmitter {}, builtinModules: [] },
		wasi: { WASI: class WASI { constructor() { throw unavailable("wasi", "the engine has no WebAssembly"); } } },
	};
}

/* ------------------------------------------------------------------ util.types */

/* Node's util.types: brand checks that programs (undici, assert libraries, inspectors) use to tell values apart. */
function createUtilTypes({ isProxy }) {
	const tag = (v) => Object.prototype.toString.call(v).slice(8, -1);
	const typed = (name) => (v) => ArrayBuffer.isView(v) && !(v instanceof DataView) && tag(v) === name;
	const protoTag = (v) => (typeof v === "function" ? Object.getPrototypeOf(v)?.[Symbol.toStringTag] : undefined);
	return {
		isProxy: (v) => (v !== null && (typeof v === "object" || typeof v === "function") ? Boolean(isProxy?.(v)) : false),
		isExternal: () => false,
		isDate: (v) => v instanceof Date,
		isRegExp: (v) => v instanceof RegExp,
		isNativeError: (v) => v instanceof Error,
		isPromise: (v) => v instanceof Promise,
		isMap: (v) => v instanceof Map,
		isSet: (v) => v instanceof Set,
		isWeakMap: (v) => v instanceof WeakMap,
		isWeakSet: (v) => v instanceof WeakSet,
		isMapIterator: (v) => tag(v) === "Map Iterator",
		isSetIterator: (v) => tag(v) === "Set Iterator",
		isGeneratorObject: (v) => tag(v) === "Generator",
		isGeneratorFunction: (v) => protoTag(v) === "GeneratorFunction" || protoTag(v) === "AsyncGeneratorFunction",
		isAsyncFunction: (v) => protoTag(v) === "AsyncFunction" || protoTag(v) === "AsyncGeneratorFunction",
		isArgumentsObject: (v) => tag(v) === "Arguments",
		isArrayBuffer: (v) => v instanceof ArrayBuffer,
		isSharedArrayBuffer: (v) => typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer,
		isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer),
		isArrayBufferView: (v) => ArrayBuffer.isView(v),
		isDataView: (v) => v instanceof DataView,
		isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
		isUint8Array: typed("Uint8Array"),
		isUint8ClampedArray: typed("Uint8ClampedArray"),
		isUint16Array: typed("Uint16Array"),
		isUint32Array: typed("Uint32Array"),
		isInt8Array: typed("Int8Array"),
		isInt16Array: typed("Int16Array"),
		isInt32Array: typed("Int32Array"),
		isFloat32Array: typed("Float32Array"),
		isFloat64Array: typed("Float64Array"),
		isBigInt64Array: typed("BigInt64Array"),
		isBigUint64Array: typed("BigUint64Array"),
		isBoxedPrimitive: (v) => v instanceof Number || v instanceof String || v instanceof Boolean || (typeof BigInt !== "undefined" && v instanceof BigInt) || v instanceof Symbol,
		isNumberObject: (v) => v instanceof Number,
		isStringObject: (v) => v instanceof String,
		isBooleanObject: (v) => v instanceof Boolean,
		isBigIntObject: (v) => typeof BigInt !== "undefined" && v instanceof BigInt,
		isSymbolObject: (v) => v instanceof Symbol,
		isModuleNamespaceObject: (v) => tag(v) === "Module",
		isKeyObject: () => false,
		isCryptoKey: () => false,
	};
}

export { createUtilTypes, createOs, createStdio, createVm, createModuleModule, createPunycode, createUnavailable };

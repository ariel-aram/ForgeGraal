/*
 * The rest of Node's public surface that is not big enough for a file of its own: statics of `events`, the promises
 * forms of timers, `path.matchesGlob`, `fs.glob`, additions to `process` and `util`, message channels, the extra web
 * streams (`TextEncoderStream`, `CompressionStream`, ...), `navigator`, `CustomEvent`, `PerformanceObserver`, and the
 * small members of `tls`, `net`, `buffer`, `console`, `readline`, `querystring`, `module` and `stream` that programs and
 * packages reach for. Each is checked against Node's own output in test/fixtures/web/extras-corpus.cjs.
 */

function installExtras(deps) {
	const { builtins, globalObject, EventEmitter, Buffer, util, processModule, pathModule, os, std, nativeLayer, web, streamModule } = deps;
	const fs = deps.fs;
	const define = (name, value) => {
		if (typeof globalObject[name] === "undefined") Object.defineProperty(globalObject, name, { value, writable: true, configurable: true, enumerable: false });
	};

	// ---- events --------------------------------------------------------------------------------------------------
	{
		const events = builtins.events;
		const kRejection = Symbol.for("nodejs.rejection");
		events.captureRejectionSymbol ??= kRejection;
		events.usingDomains ??= false;
		events.init ??= function init(options) {
			EventEmitter.call(this, options);
		};
		events.getMaxListeners ??= (target) => (typeof target.getMaxListeners === "function" ? target.getMaxListeners() : (target._maxListeners ?? events.defaultMaxListeners));
		events.getEventListeners ??= (target, name) => {
			if (typeof target.listeners === "function") return target.listeners(name);
			return (target._listeners?.[name] ?? []).map((entry) => entry.fn);
		};
		events.addAbortListener ??= (signal, listener) => {
			if (signal.aborted) queueMicrotask(() => listener(new Event("abort")));
			else signal.addEventListener("abort", listener, { once: true });
			return { [Symbol.dispose]: () => signal.removeEventListener("abort", listener) };
		};
		events.on ??= function on(emitter, event, options = {}) {
			const signal = options.signal;
			if (signal?.aborted) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
			const queue = [];
			const waiting = [];
			let error = null;
			let finished = false;
			const closeEvents = options.close ?? [];
			const push = (...args) => {
				const next = waiting.shift();
				if (next) next.resolve({ value: args, done: false });
				else queue.push(args);
			};
			const fail = (err) => {
				error = err;
				const next = waiting.shift();
				if (next) next.reject(err);
				cleanup();
			};
			const end = () => {
				finished = true;
				for (const w of waiting.splice(0)) w.resolve({ value: undefined, done: true });
				cleanup();
			};
			const target = typeof emitter.on === "function" ? emitter : null;
			const add = (name, fn) => (target ? target.on(name, fn) : emitter.addEventListener(name, fn));
			const remove = (name, fn) => (target ? target.removeListener(name, fn) : emitter.removeEventListener(name, fn));
			const onEvent = target ? push : (e) => push(e);
			add(event, onEvent);
			if (target && event !== "error") add("error", fail);
			for (const name of closeEvents) add(name, end);
			const onAbort = () => fail(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
			signal?.addEventListener("abort", onAbort, { once: true });
			function cleanup() {
				remove(event, onEvent);
				if (target) remove("error", fail);
				for (const name of closeEvents) remove(name, end);
				signal?.removeEventListener("abort", onAbort);
			}
			return {
				next() {
					if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
					if (error) {
						const err = error;
						error = null;
						return Promise.reject(err);
					}
					if (finished) return Promise.resolve({ value: undefined, done: true });
					return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
				},
				return() {
					cleanup();
					finished = true;
					for (const w of waiting.splice(0)) w.resolve({ value: undefined, done: true });
					return Promise.resolve({ value: undefined, done: true });
				},
				throw(err) {
					error = err;
					cleanup();
					return Promise.reject(err);
				},
				[Symbol.asyncIterator]() {
					return this;
				},
			};
		};
		events.EventEmitterAsyncResource ??= class EventEmitterAsyncResource extends EventEmitter {
			constructor(options = {}) {
				super(options);
				this.asyncResource = { runInAsyncScope: (fn, thisArg, ...args) => fn.apply(thisArg, args), emitDestroy() {}, asyncId: () => 0, triggerAsyncId: () => 0 };
			}
			emit(...args) {
				return super.emit(...args);
			}
			emitDestroy() {}
		};
		for (const name of ["on", "getMaxListeners", "getEventListeners", "addAbortListener", "captureRejectionSymbol", "usingDomains", "init", "EventEmitterAsyncResource"]) {
			if (!(name in EventEmitter)) EventEmitter[name] = events[name];
		}
	}

	// ---- timers --------------------------------------------------------------------------------------------------
	{
		const tp = builtins["timers/promises"];
		tp.setInterval ??= async function* setInterval(delay, value, options = {}) {
			const signal = options.signal;
			for (;;) {
				await new Promise((resolve, reject) => {
					const timer = globalObject.setTimeout(() => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					}, delay);
					const onAbort = () => {
						globalObject.clearTimeout(timer);
						reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
					};
					if (signal?.aborted) return onAbort();
					signal?.addEventListener("abort", onAbort, { once: true });
				});
				yield value;
			}
		};
		tp.scheduler ??= { wait: (ms, options) => tp.setTimeout(ms, undefined, options), yield: () => tp.setImmediate() };
		builtins.timers.promises ??= tp;
	}

	// ---- path ----------------------------------------------------------------------------------------------------
	{
		const globToRegExp = (pattern, { windows = false } = {}) => {
			let out = "";
			let i = 0;
			const braces = [];
			while (i < pattern.length) {
				const c = pattern[i];
				if (c === "*") {
					if (pattern[i + 1] === "*") {
						i += 2;
						if (pattern[i] === "/") {
							i++;
							out += "(?:[^/]*(?:/|$))*";
						} else out += ".*";
						continue;
					}
					out += "[^/]*";
				} else if (c === "?") out += "[^/]";
				else if (c === "[") {
					const end = pattern.indexOf("]", i + 2);
					if (end === -1) out += "\\[";
					else {
						let body = pattern.slice(i + 1, end);
						if (body[0] === "!") body = `^${body.slice(1)}`;
						out += `[${body.replace(/\\/g, "\\\\")}]`;
						i = end;
					}
				} else if (c === "{") {
					braces.push(true);
					out += "(?:";
				} else if (c === "}" && braces.length) {
					braces.pop();
					out += ")";
				} else if (c === "," && braces.length) out += "|";
				else if (c === "\\" && !windows && i + 1 < pattern.length) out += `\\${pattern[++i]}`;
				else out += /[.+^${}()|\\]/.test(c) ? `\\${c}` : c;
				i++;
			}
			return new RegExp(`^${out}$`);
		};
		// "dir/**" also matches "dir" itself: `**` stands for zero or more segments.
		const globPattern = (pattern, options) => {
			const text = String(pattern);
			if (text.endsWith("/**")) {
				const base = globToRegExp(text.slice(0, -3), options).source.slice(0, -1);
				return new RegExp(`${base}(?:/.*)?$`);
			}
			return globToRegExp(text, options);
		};
		const matchesGlob = (path, pattern) => globPattern(pattern).test(String(path).replace(/\\/g, "/"));
		for (const p of [pathModule, builtins["path/posix"], builtins["path/win32"]]) {
			if (p && !p.matchesGlob) p.matchesGlob = matchesGlob;
		}
		for (const [p, windows] of [[pathModule, os.platform === "win32"], [builtins["path/posix"], false], [builtins["path/win32"], true]]) {
			if (p && !p.toNamespacedPath) {
				p.toNamespacedPath = windows
					? (path) => {
							if (typeof path !== "string" || path.length === 0) return path;
							const resolved = p.resolve(path);
							if (resolved.startsWith("\\\\")) return resolved.startsWith("\\\\?\\") ? resolved : `\\\\?\\UNC\\${resolved.slice(2)}`;
							return /^[A-Za-z]:/.test(resolved) ? `\\\\?\\${resolved}` : path;
						}
					: (path) => path;
			}
		}
		deps.globToRegExp = globPattern;
	}

	// ---- fs: glob, writev, readv, openAsBlob ---------------------------------------------------------------------
	{
		const globToRegExp = deps.globToRegExp;
		const expand = (patterns) => [].concat(patterns);
		function* walk(dir, base, recursive, exclude) {
			let entries;
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const rel = base ? `${base}/${entry.name}` : entry.name;
				if (exclude?.(rel)) continue;
				yield { rel, isDirectory: entry.isDirectory() };
				if (entry.isDirectory() && recursive) yield* walk(`${dir}/${entry.name}`, rel, recursive, exclude);
			}
		}
		function globSync(pattern, options = {}) {
			const cwd = options.cwd ? String(options.cwd) : process.cwd();
			const regexps = expand(pattern).map((p) => globToRegExp(String(p)));
			const excludeOption = options.exclude;
			const exclude = typeof excludeOption === "function" ? (rel) => excludeOption(rel) : Array.isArray(excludeOption) ? (rel) => excludeOption.some((p) => globToRegExp(p).test(rel)) : null;
			const found = [];
			for (const { rel } of walk(cwd, "", true, exclude)) {
				if (regexps.some((re) => re.test(rel))) found.push(options.withFileTypes ? rel : rel);
			}
			return found;
		}
		fs.globSync ??= globSync;
		fs.glob ??= (pattern, options, callback) => {
			if (typeof options === "function") {
				callback = options;
				options = {};
			}
			queueMicrotask(() => {
				try {
					callback(null, globSync(pattern, options));
				} catch (error) {
					callback(error);
				}
			});
		};
		if (fs.promises) {
			fs.promises.glob ??= async function* glob(pattern, options) {
				for (const found of globSync(pattern, options)) yield found;
			};
		}
		fs.writevSync ??= (fd, buffers, position) => {
			let total = 0;
			for (const b of buffers) total += fs.writeSync(fd, b, 0, b.byteLength, position === undefined || position === null ? null : position + total);
			return total;
		};
		fs.writev ??= (fd, buffers, position, callback) => {
			if (typeof position === "function") {
				callback = position;
				position = null;
			}
			queueMicrotask(() => {
				try {
					const n = fs.writevSync(fd, buffers, position);
					callback(null, n, buffers);
				} catch (error) {
					callback(error);
				}
			});
		};
		fs.readvSync ??= (fd, buffers, position) => {
			let total = 0;
			for (const b of buffers) {
				const n = fs.readSync(fd, b, 0, b.byteLength, position === undefined || position === null ? null : position + total);
				total += n;
				if (n < b.byteLength) break;
			}
			return total;
		};
		fs.readv ??= (fd, buffers, position, callback) => {
			if (typeof position === "function") {
				callback = position;
				position = null;
			}
			queueMicrotask(() => {
				try {
					const n = fs.readvSync(fd, buffers, position);
					callback(null, n, buffers);
				} catch (error) {
					callback(error);
				}
			});
		};
		fs.openAsBlob ??= async (path, options = {}) => new Blob([fs.readFileSync(path)], { type: options.type ?? "" });
	}

	// ---- process -------------------------------------------------------------------------------------------------
	{
		const p = processModule;
		p.getBuiltinModule ??= (id) => {
			const name = String(id).startsWith("node:") ? String(id).slice(5) : String(id);
			if (!(name in builtins) || name in { sea: 1, test: 1 } && !builtins[name]) return undefined;
			// node:test is reachable only through the scheme, as it is for require().
			if ((name === "test" || name === "test/reporters") && !String(id).startsWith("node:")) return undefined;
			try {
				return builtins[name];
			} catch {
				return undefined;
			}
		};
		p.loadEnvFile ??= (path = ".env") => {
			const text = fs.readFileSync(path, "utf8");
			for (const line of text.split(/\r?\n/)) {
				const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
				if (!match || line.trimStart().startsWith("#")) continue;
				let value = match[2];
				if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
					const quote = value[0];
					value = value.slice(1, -1);
					if (quote === '"') value = value.replace(/\\n/g, "\n");
				} else value = value.replace(/\s+#.*$/, "");
				if (!(match[1] in p.env)) p.env[match[1]] = value;
			}
		};
		p.availableMemory ??= () => os.freemem?.() ?? 0;
		p.constrainedMemory ??= () => 0;
		p.threadCpuUsage ??= () => p.cpuUsage?.() ?? { user: 0, system: 0 };
		p.getActiveResourcesInfo ??= () => [];
		p.openStdin ??= () => {
			p.stdin.resume?.();
			return p.stdin;
		};
		p.ref ??= () => {};
		p.unref ??= () => {};
		p.sourceMapsEnabled ??= false;
		p.debugPort ??= 9229;
		p.moduleLoadList ??= [];
		p.domain ??= null;
		p.addUncaughtExceptionCaptureCallback ??= (fn) => {
			p._captureCallback = fn;
			p.on("uncaughtException", fn);
		};
		p.hasUncaughtExceptionCaptureCallback ??= () => Boolean(p._captureCallback);
		if (!("ppid" in p)) {
			let ppid = 0;
			try {
				const stat = fs.readFileSync("/proc/self/stat", "utf8");
				ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || 0;
			} catch {
				// Not Linux: unknown.
			}
			p.ppid = ppid;
		}
		const registry = typeof FinalizationRegistry === "function" ? new FinalizationRegistry((fn) => fn) : null;
		p.finalization ??= {
			register: (object, callback) => registry?.register(object, callback),
			registerBeforeExit: (object, callback) => registry?.register(object, callback),
			unregister: (object) => registry?.unregister(object),
		};
	}

	// ---- util ----------------------------------------------------------------------------------------------------
	{
		util.debug ??= util.debuglog;
		util.getSystemErrorMessage ??= (err) => {
			const names = { "-2": "no such file or directory", "-13": "permission denied", "-17": "file already exists", "-98": "address already in use", "-111": "connection refused" };
			return names[String(err)] ?? `Unknown system error ${err}`;
		};
		util.convertProcessSignalToExitCode ??= (signal) => 128 + (os.constants?.signals?.[signal] ?? 0);
		util.setTraceSigInt ??= () => {};
		util.transferableAbortController ??= () => new AbortController();
		util.transferableAbortSignal ??= (signal) => signal;
		util.getCallSites ??= (frames = 10) => {
			const lines = String(new Error().stack).split("\n").slice(2, 2 + frames);
			return lines.map((line) => {
				const m = /at (?:(.*?) )?\(?(.*?):(\d+)(?::(\d+))?\)?$/.exec(line.trim());
				return { functionName: m?.[1] ?? "", scriptName: m?.[2] ?? "", scriptId: "0", lineNumber: Number(m?.[3] ?? 0), columnNumber: Number(m?.[4] ?? 0), column: Number(m?.[4] ?? 0) };
			});
		};
		class MIMEParams {
			#map = new Map();
			delete(name) {
				this.#map.delete(String(name).toLowerCase());
			}
			get(name) {
				return this.#map.get(String(name).toLowerCase()) ?? null;
			}
			has(name) {
				return this.#map.has(String(name).toLowerCase());
			}
			set(name, value) {
				this.#map.set(String(name).toLowerCase(), String(value));
			}
			entries() {
				return this.#map.entries();
			}
			keys() {
				return this.#map.keys();
			}
			values() {
				return this.#map.values();
			}
			[Symbol.iterator]() {
				return this.#map.entries();
			}
			toString() {
				return [...this.#map].map(([k, v]) => `${k}=${/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(v) ? v : `"${v.replace(/(["\\])/g, "\\$1")}"`}`).join(";");
			}
			toJSON() {
				return this.toString();
			}
		}
		class MIMEType {
			#type;
			#subtype;
			#params = new MIMEParams();
			constructor(input) {
				const text = String(input).trim();
				const [essence, ...rest] = text.split(";");
				const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\/([!#$%&'*+.^_`|~0-9A-Za-z-]+)$/.exec(essence.trim());
				if (!match) throw Object.assign(new TypeError(`The MIME syntax for a type in "${text}" is invalid`), { code: "ERR_INVALID_MIME_SYNTAX" });
				this.#type = match[1].toLowerCase();
				this.#subtype = match[2].toLowerCase();
				for (const part of rest) {
					const eq = part.indexOf("=");
					if (eq === -1) continue;
					const name = part.slice(0, eq).trim().toLowerCase();
					let value = part.slice(eq + 1).trim();
					if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, "$1");
					if (name && !this.#params.has(name)) this.#params.set(name, value);
				}
			}
			get type() {
				return this.#type;
			}
			set type(value) {
				this.#type = String(value).toLowerCase();
			}
			get subtype() {
				return this.#subtype;
			}
			set subtype(value) {
				this.#subtype = String(value).toLowerCase();
			}
			get essence() {
				return `${this.#type}/${this.#subtype}`;
			}
			get params() {
				return this.#params;
			}
			toString() {
				const params = this.#params.toString();
				return params ? `${this.essence};${params}` : this.essence;
			}
			toJSON() {
				return this.toString();
			}
		}
		util.MIMEType ??= MIMEType;
		util.MIMEParams ??= MIMEParams;
	}

	// ---- buffer, console, querystring, stream, module ------------------------------------------------------------
	{
		const b = builtins.buffer;
		if (typeof globalObject.Blob !== "undefined") b.Blob ??= globalObject.Blob;
		if (typeof globalObject.File !== "undefined") b.File ??= globalObject.File;
		b.resolveObjectURL ??= () => undefined;
		b.transcode ??= (source, from, to) => {
			const norm = (e) => String(e).toLowerCase().replace("utf-8", "utf8").replace("ucs-2", "ucs2").replace("utf-16le", "utf16le");
			return Buffer.from(Buffer.from(source).toString(norm(from)), norm(to));
		};

		const c = builtins.console;
		c.Console ??= class Console {
			constructor(options) {
				const out = options?.stdout ?? options;
				const err = options?.stderr ?? out;
				const write = (stream) => (...args) => stream.write(`${util.format(...args)}\n`);
				this.log = this.info = this.debug = write(out);
				this.error = this.warn = this.trace = write(err);
				this.dir = (value, opts) => out.write(`${util.inspect(value, opts)}\n`);
				this.assert = (cond, ...args) => {
					if (!cond) err.write(`Assertion failed${args.length ? `: ${util.format(...args)}` : ""}\n`);
				};
				this.table = (...args) => globalObject.console.table?.(...args);
				this.group = this.groupEnd = this.time = this.timeEnd = this.timeLog = this.count = this.countReset = () => {};
			}
		};
		c.clear ??= () => {};
		c.groupCollapsed ??= (...args) => c.group?.(...args);
		c.profile ??= () => {};
		c.profileEnd ??= () => {};
		c.timeStamp ??= () => {};
		c.context ??= () => c;
		c.createTask ??= () => ({ run: (fn) => fn() });

		const qs = builtins.querystring;
		qs.encode ??= qs.stringify;
		qs.decode ??= qs.parse;
		qs.unescapeBuffer ??= (s) => Buffer.from(qs.unescape(String(s)), "latin1");

		const st = streamModule;
		st.duplexPair ??= (options) => {
			const a = new st.Duplex({ ...options, read() {}, write(chunk, enc, cb) { b2.push(chunk); cb(); }, final(cb) { b2.push(null); cb(); } });
			const b2 = new st.Duplex({ ...options, read() {}, write(chunk, enc, cb) { a.push(chunk); cb(); }, final(cb) { a.push(null); cb(); } });
			return [a, b2];
		};
		st._isUint8Array ??= (v) => v instanceof Uint8Array;
		st._isArrayBufferView ??= ArrayBuffer.isView;
		st._uint8ArrayToBuffer ??= (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

		const m = builtins.module;
		m.findPackageJSON ??= (specifier, base) => {
			let dir = String(base ?? `${process.cwd()}/x`).replace(/^file:\/\//, "");
			dir = pathModule.dirname(dir);
			for (;;) {
				const candidate = pathModule.join(dir, "package.json");
				if (fs.existsSync(candidate)) return candidate;
				const parent = pathModule.dirname(dir);
				if (parent === dir) return undefined;
				dir = parent;
			}
		};
		m.SourceMap ??= class SourceMap {
			constructor(payload) {
				this.payload = payload;
			}
			findEntry() {
				return {};
			}
			findOrigin() {
				return {};
			}
		};
		m.registerHooks ??= () => ({ deregister() {} });
		m.flushCompileCache ??= () => {};
		m.getCompileCacheDir ??= () => undefined;
		m.setSourceMapsSupport ??= () => {};
		m.getSourceMapsSupport ??= () => ({ enabled: false, nodeModules: false, generatedCode: false });
		m.runMain ??= () => {};
		m.stripTypeScriptTypes ??= () => {
			throw Object.assign(new Error("module.stripTypeScriptTypes is not available: Graak converts TypeScript when it builds"), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
		};
	}

	// ---- readline: raw mode and keypress events -----------------------------------------------------------------
	{
		const rl = builtins.readline;
		rl.clearScreenDown ??= (stream, callback) => {
			stream.write("\x1b[0J");
			callback?.();
			return true;
		};
		rl.emitKeypressEvents ??= (stream) => {
			if (stream._keypressDecoder) return;
			stream._keypressDecoder = true;
			const decoder = new (builtins.string_decoder.StringDecoder)("utf8");
			const KEYS = { "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\x1b[H": "home", "\x1b[F": "end", "\x1b[3~": "delete", "\x1b[5~": "pageup", "\x1b[6~": "pagedown", "\x1bOP": "f1", "\x1bOQ": "f2", "\x1bOR": "f3", "\x1bOS": "f4" };
			const feed = (chunk) => {
				const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
				let i = 0;
				while (i < text.length) {
					let seq = text[i];
					if (seq === "\x1b") {
						const match = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Z]|.)/.exec(text.slice(i));
						seq = match ? match[0] : "\x1b";
					}
					i += seq.length;
					const key = { sequence: seq, name: undefined, ctrl: false, meta: false, shift: false };
					if (KEYS[seq]) key.name = KEYS[seq];
					else if (seq === "\r" || seq === "\n") key.name = seq === "\r" ? "return" : "enter";
					else if (seq === "\t") key.name = "tab";
					else if (seq === "\x7f" || seq === "\b") key.name = "backspace";
					else if (seq === "\x1b") key.name = "escape";
					else if (seq.length === 1 && seq < " ") {
						key.name = String.fromCharCode(seq.charCodeAt(0) + 96);
						key.ctrl = true;
					} else if (seq.length === 1) {
						key.name = seq.toLowerCase();
						key.shift = seq !== seq.toLowerCase();
					}
					stream.emit("keypress", seq.length === 1 ? seq : undefined, key);
				}
			};
			stream.on("newListener", function onNew(event) {
				if (event === "keypress") {
					stream.on("data", feed);
					stream.removeListener("newListener", onNew);
				}
			});
		};
		rl.promises ??= builtins["readline/promises"];
		// setRawMode: the terminal stops line-buffering and echoing, which interactive prompts depend on.
		const stdin = processModule.stdin;
		if (stdin && typeof stdin.setRawMode !== "function" && typeof os.ttySetRaw === "function") {
			stdin.isRaw = false;
			stdin.setRawMode = (mode) => {
				if (mode) os.ttySetRaw(0);
				stdin.isRaw = Boolean(mode);
				return stdin;
			};
		}
	}

	// ---- perf_hooks ----------------------------------------------------------------------------------------------
	{
		const ph = builtins.perf_hooks;
		const perf = globalObject.performance;
		class PerformanceEntry {
			constructor(name, entryType, startTime, duration, detail) {
				this.name = name;
				this.entryType = entryType;
				this.startTime = startTime;
				this.duration = duration;
				if (detail !== undefined) this.detail = detail;
			}
			toJSON() {
				return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration, ...(this.detail !== undefined ? { detail: this.detail } : {}) };
			}
		}
		class PerformanceMark extends PerformanceEntry {
			constructor(name, options = {}) {
				super(name, "mark", options.startTime ?? perf.now(), 0, options.detail ?? null);
			}
		}
		class PerformanceMeasure extends PerformanceEntry {}
		const entries = [];
		const observers = new Set();
		const publish = (entry) => {
			entries.push(entry);
			for (const o of observers) if (o._types.has(entry.entryType)) o._queue.push(entry);
			for (const o of observers) if (o._queue.length && !o._scheduled) {
				o._scheduled = true;
				queueMicrotask(() => {
					o._scheduled = false;
					// Entries are delivered in the order they started, whatever kind they are.
					const list = o._queue.splice(0).sort((a, b) => a.startTime - b.startTime);
					if (list.length) o._callback({ getEntries: () => list, getEntriesByName: (n) => list.filter((e) => e.name === n), getEntriesByType: (t) => list.filter((e) => e.entryType === t) }, o);
				});
			}
		};
		class PerformanceObserver {
			constructor(callback) {
				this._callback = callback;
				this._types = new Set();
				this._queue = [];
				this._scheduled = false;
			}
			static get supportedEntryTypes() {
				return ["function", "gc", "http", "http2", "mark", "measure", "net", "resource"];
			}
			observe(options = {}) {
				for (const t of options.entryTypes ?? (options.type ? [options.type] : [])) this._types.add(t);
				observers.add(this);
			}
			disconnect() {
				observers.delete(this);
			}
			takeRecords() {
				return this._queue.splice(0);
			}
		}
		if (perf && typeof perf.mark !== "function") {
			perf.mark = (name, options) => {
				const mark = new PerformanceMark(name, options);
				publish(mark);
				return mark;
			};
			perf.measure = (name, startOrOptions, endMark) => {
				const find = (m) => (typeof m === "number" ? m : [...entries].reverse().find((e) => e.name === m && e.entryType === "mark")?.startTime);
				let start = 0;
				let end = perf.now();
				if (typeof startOrOptions === "object" && startOrOptions) {
					start = find(startOrOptions.start) ?? 0;
					end = find(startOrOptions.end) ?? (startOrOptions.duration !== undefined ? start + startOrOptions.duration : end);
				} else {
					if (startOrOptions !== undefined) start = find(startOrOptions) ?? 0;
					if (endMark !== undefined) end = find(endMark) ?? end;
				}
				const measure = new PerformanceMeasure(name, "measure", start, end - start, null);
				publish(measure);
				return measure;
			};
			perf.getEntries = () => [...entries];
			perf.getEntriesByName = (n, t) => entries.filter((e) => e.name === n && (!t || e.entryType === t));
			perf.getEntriesByType = (t) => entries.filter((e) => e.entryType === t);
			perf.clearMarks = (n) => {
				for (let i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === "mark" && (!n || entries[i].name === n)) entries.splice(i, 1);
			};
			perf.clearMeasures = (n) => {
				for (let i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === "measure" && (!n || entries[i].name === n)) entries.splice(i, 1);
			};
			perf.toJSON ??= () => ({ nodeTiming: {}, timeOrigin: perf.timeOrigin, eventLoopUtilization: {} });
			perf.eventLoopUtilization ??= () => ({ idle: 0, active: 0, utilization: 0 });
			perf.timerify ??= (fn) => fn;
		}
		ph.PerformanceEntry ??= PerformanceEntry;
		ph.PerformanceMark ??= PerformanceMark;
		ph.PerformanceMeasure ??= PerformanceMeasure;
		ph.PerformanceObserver ??= PerformanceObserver;
		ph.PerformanceObserverEntryList ??= class PerformanceObserverEntryList {};
		ph.PerformanceResourceTiming ??= class PerformanceResourceTiming extends PerformanceEntry {};
		ph.Performance ??= perf?.constructor ?? class Performance {};
		ph.constants ??= { NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16 };
		ph.eventLoopUtilization ??= perf.eventLoopUtilization;
		ph.timerify ??= (fn) => fn;
		const histogram = () => {
			const values = [];
			return {
				record: (v) => values.push(Number(v)),
				reset: () => (values.length = 0),
				get min() { return values.length ? Math.min(...values) : 9223372036854776000; },
				get max() { return values.length ? Math.max(...values) : 0; },
				get mean() { return values.length ? values.reduce((a, c) => a + c, 0) / values.length : NaN; },
				get count() { return values.length; },
				get stddev() {
					if (!values.length) return NaN;
					const mean = values.reduce((a, c) => a + c, 0) / values.length;
					return Math.sqrt(values.reduce((a, c) => a + (c - mean) ** 2, 0) / values.length);
				},
				percentile(p) {
					if (!values.length) return 0;
					const sorted = [...values].sort((a, c) => a - c);
					return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
				},
				percentiles: new Map(),
				exceeds: 0,
			};
		};
		ph.createHistogram ??= histogram;
		ph.monitorEventLoopDelay ??= () => Object.assign(histogram(), { enable: () => true, disable: () => true });
		Object.assign(globalObject, {});
		define("PerformanceEntry", PerformanceEntry);
		define("PerformanceMark", PerformanceMark);
		define("PerformanceMeasure", PerformanceMeasure);
		define("PerformanceObserver", PerformanceObserver);
		define("PerformanceObserverEntryList", ph.PerformanceObserverEntryList);
		define("PerformanceResourceTiming", ph.PerformanceResourceTiming);
		define("Performance", ph.Performance);
	}

	// ---- message channels -----------------------------------------------------------------------------------------
	{
		const wt = builtins.worker_threads;
		class MessagePort extends EventEmitter {
			constructor() {
				super();
				this._peer = null;
				this._queue = [];
				this._closed = false;
				this._started = false;
				this._targets = new Set();
				this.onmessage = null;
				this.onmessageerror = null;
			}
			postMessage(value, transfer) {
				if (this._closed || !this._peer) return;
				const cloned = structuredClone(value, transfer && !Array.isArray(transfer) ? transfer : { transfer: transfer ?? [] });
				const peer = this._peer;
				peer._queue.push(cloned);
				queueMicrotask(() => peer._drain());
			}
			_drain() {
				if (!this._started && !this.onmessage && !this.listenerCount("message")) return;
				while (this._queue.length && !this._closed) {
					const data = this._queue.shift();
					const event = Object.assign(new Event("message"), { data, ports: [] });
					if (typeof this.onmessage === "function") this.onmessage(event);
					this.emit("message", data);
					for (const fn of this._targets) fn(event);
				}
			}
			start() {
				this._started = true;
				queueMicrotask(() => this._drain());
			}
			close() {
				if (this._closed) return;
				this._closed = true;
				const peer = this._peer;
				queueMicrotask(() => {
					this.emit("close");
					if (peer && !peer._closed) {
						peer._closed = true;
						peer.emit("close");
					}
				});
			}
			ref() {}
			unref() {}
			addEventListener(type, fn) {
				if (type === "message") {
					this._targets.add(fn);
					this.start();
				}
			}
			removeEventListener(type, fn) {
				if (type === "message") this._targets.delete(fn);
			}
			on(event, fn) {
				super.on(event, fn);
				if (event === "message") this.start();
				return this;
			}
			once(event, fn) {
				super.once(event, fn);
				if (event === "message") this.start();
				return this;
			}
			dispatchEvent() {
				return true;
			}
		}
		class MessageChannel {
			constructor() {
				this.port1 = new MessagePort();
				this.port2 = new MessagePort();
				this.port1._peer = this.port2;
				this.port2._peer = this.port1;
			}
		}
		const channels = new Map();
		class BroadcastChannel extends EventTarget {
			constructor(name) {
				super();
				this.name = String(name);
				this.onmessage = null;
				this._closed = false;
				(channels.get(this.name) ?? channels.set(this.name, new Set()).get(this.name)).add(this);
			}
			postMessage(value) {
				if (this._closed) throw Object.assign(new Error("BroadcastChannel is closed."), { name: "InvalidStateError" });
				const data = structuredClone(value);
				for (const other of channels.get(this.name) ?? []) {
					if (other === this) continue;
					queueMicrotask(() => {
						if (other._closed) return;
						const event = Object.assign(new Event("message"), { data });
						if (typeof other.onmessage === "function") other.onmessage(event);
						other.dispatchEvent(event);
					});
				}
			}
			close() {
				this._closed = true;
				channels.get(this.name)?.delete(this);
			}
			ref() {}
			unref() {}
		}
		wt.MessageChannel ??= MessageChannel;
		wt.MessagePort ??= MessagePort;
		wt.BroadcastChannel ??= BroadcastChannel;
		wt.receiveMessageOnPort ??= (port) => {
			if (!port._queue.length) return undefined;
			return { message: port._queue.shift() };
		};
		const environmentData = new Map();
		wt.setEnvironmentData ??= (key, value) => (value === undefined ? environmentData.delete(key) : environmentData.set(key, value));
		wt.getEnvironmentData ??= (key) => environmentData.get(key);
		wt.SHARE_ENV ??= Symbol.for("nodejs.worker_threads.SHARE_ENV");
		wt.resourceLimits ??= {};
		wt.isInternalThread ??= false;
		wt.threadName ??= "";
		wt.markAsUntransferable ??= () => {};
		wt.isMarkedAsUntransferable ??= () => false;
		wt.markAsUncloneable ??= () => {};
		wt.moveMessagePortToContext ??= (port) => port;
		wt.postMessageToThread ??= async () => {
			throw Object.assign(new Error("postMessageToThread is not available: workers here have no thread ids"), { code: "ERR_WORKER_MESSAGING_FAILED" });
		};
		wt.locks ??= undefined;
		define("MessageChannel", MessageChannel);
		define("MessagePort", MessagePort);
		define("BroadcastChannel", BroadcastChannel);
	}

	// ---- event classes, navigator ---------------------------------------------------------------------------------
	{
		define("CustomEvent", class CustomEvent extends Event {
			constructor(type, init = {}) {
				super(type, init);
				this.detail = init.detail ?? null;
			}
		});
		define("ErrorEvent", class ErrorEvent extends Event {
			constructor(type, init = {}) {
				super(type, init);
				this.message = init.message ?? "";
				this.filename = init.filename ?? "";
				this.lineno = init.lineno ?? 0;
				this.colno = init.colno ?? 0;
				this.error = init.error;
			}
		});
		class Navigator {
			get hardwareConcurrency() {
				return os.cpus?.().length || 1;
			}
			get language() {
				return (std.getenv("LANG") ?? "en-US").split(".")[0].replace("_", "-") || "en-US";
			}
			get languages() {
				return [this.language];
			}
			get platform() {
				return { win32: "Win32", darwin: "MacIntel", linux: "Linux x86_64" }[os.platform] ?? os.platform;
			}
			get userAgent() {
				return `Node.js/${String(processModule.version).replace(/^v/, "").split(".")[0]}`;
			}
		}
		define("Navigator", Navigator);
		define("navigator", new Navigator());
	}

	// ---- web streams: the classes and the stream wrappers around text and compression -----------------------------
	{
		const sw = builtins["stream/web"];
		// The reader, writer and controller classes are not exported by the web streams layer; they are what its
		// own streams hand out, so the constructors are read off them.
		const found = {};
		try {
			let readableController;
			let writableController;
			let transformController;
			const rs = new web.ReadableStream({ start: (c) => { readableController = c; } });
			const ws = new web.WritableStream({ start: (c) => { writableController = c; } });
			new web.TransformStream({ start: (c) => { transformController = c; } });
			found.ReadableStreamDefaultReader = rs.getReader().constructor;
			found.WritableStreamDefaultWriter = ws.getWriter().constructor;
			found.ReadableStreamDefaultController = readableController?.constructor;
			found.WritableStreamDefaultController = writableController?.constructor;
			found.TransformStreamDefaultController = transformController?.constructor;
		} catch {
			// A layer without them just lacks the classes.
		}
		for (const name of [
			"ReadableStreamDefaultReader", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest", "ReadableByteStreamController",
			"ReadableStreamDefaultController", "TransformStreamDefaultController", "WritableStreamDefaultController", "WritableStreamDefaultWriter",
		]) {
			const cls = web[name] ?? found[name];
			if (cls && cls !== Object) {
				sw[name] ??= cls;
				define(name, cls);
			}
		}
		class TextEncoderStream {
			constructor() {
				const encoder = new TextEncoder();
				let pending = "";
				const transform = new TransformStream({
					transform(chunk, controller) {
						pending += String(chunk);
						// A lone high surrogate waits for its pair.
						const last = pending.charCodeAt(pending.length - 1);
						let emit = pending;
						pending = "";
						if (last >= 0xd800 && last <= 0xdbff) {
							pending = emit.slice(-1);
							emit = emit.slice(0, -1);
						}
						if (emit) controller.enqueue(encoder.encode(emit));
					},
					flush(controller) {
						if (pending) controller.enqueue(encoder.encode(pending));
					},
				});
				this.readable = transform.readable;
				this.writable = transform.writable;
			}
			get encoding() {
				return "utf-8";
			}
		}
		class TextDecoderStream {
			constructor(label = "utf-8", options = {}) {
				const decoder = new TextDecoder(label, options);
				this._decoder = decoder;
				const transform = new TransformStream({
					transform(chunk, controller) {
						const text = decoder.decode(chunk, { stream: true });
						if (text) controller.enqueue(text);
					},
					flush(controller) {
						const text = decoder.decode();
						if (text) controller.enqueue(text);
					},
				});
				this.readable = transform.readable;
				this.writable = transform.writable;
			}
			get encoding() {
				return this._decoder.encoding;
			}
			get fatal() {
				return this._decoder.fatal;
			}
			get ignoreBOM() {
				return this._decoder.ignoreBOM;
			}
		}
		const zlib = () => builtins.zlib;
		const compression = (name, compress) => {
			const table = { gzip: ["gzipSync", "gunzipSync"], deflate: ["deflateSync", "inflateSync"], "deflate-raw": ["deflateRawSync", "inflateRawSync"] };
			return class {
				constructor(format) {
					if (!table[format]) throw new TypeError(`Unsupported compression format: '${format}'`);
					const fn = zlib()[table[format][compress ? 0 : 1]];
					const chunks = [];
					const transform = new TransformStream({
						transform(chunk) {
							chunks.push(Buffer.from(chunk.buffer ?? chunk, chunk.byteOffset, chunk.byteLength));
						},
						flush(controller) {
							const out = fn(Buffer.concat(chunks));
							controller.enqueue(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
						},
					});
					this.readable = transform.readable;
					this.writable = transform.writable;
				}
			};
		};
		const CompressionStream = compression("CompressionStream", true);
		const DecompressionStream = compression("DecompressionStream", false);
		sw.TextEncoderStream ??= TextEncoderStream;
		sw.TextDecoderStream ??= TextDecoderStream;
		sw.CompressionStream ??= CompressionStream;
		sw.DecompressionStream ??= DecompressionStream;
		sw.ReadableStreamTee ??= undefined;
		define("TextEncoderStream", TextEncoderStream);
		define("TextDecoderStream", TextDecoderStream);
		define("CompressionStream", CompressionStream);
		define("DecompressionStream", DecompressionStream);
	}

	// ---- net.BlockList, net.SocketAddress -----------------------------------------------------------------------------
	{
		const net = builtins.net;
		if (net && !net.__graakUnavailable) {
			const ipv4ToInt = (ip) => ip.split(".").reduce((a, c) => a * 256 + Number(c), 0);
			class SocketAddress {
				constructor(options = {}) {
					this.address = options.address ?? (options.family === "ipv6" ? "::" : "127.0.0.1");
					this.port = options.port ?? 0;
					this.family = options.family ?? (this.address.includes(":") ? "ipv6" : "ipv4");
					this.flowlabel = options.flowlabel ?? 0;
				}
				static parse(input) {
					const m = /^\[(.*)\]:(\d+)$/.exec(input) ?? /^(.*):(\d+)$/.exec(input);
					return m ? new SocketAddress({ address: m[1], port: Number(m[2]) }) : undefined;
				}
			}
			class BlockList {
				constructor() {
					this._rules = [];
				}
				addAddress(address) {
					this._rules.push({ type: "address", address });
				}
				addRange(start, end) {
					this._rules.push({ type: "range", start, end });
				}
				addSubnet(network, prefix) {
					this._rules.push({ type: "subnet", network, prefix });
				}
				check(address) {
					const ip = typeof address === "string" ? address : address.address;
					const v4 = /^\d+\.\d+\.\d+\.\d+$/.test(ip);
					for (const r of this._rules) {
						if (r.type === "address" && r.address === ip) return true;
						if (!v4) continue;
						const n = ipv4ToInt(ip);
						if (r.type === "range" && n >= ipv4ToInt(r.start) && n <= ipv4ToInt(r.end)) return true;
						if (r.type === "subnet" && /^\d+\./.test(r.network)) {
							const mask = r.prefix === 0 ? 0 : (0xffffffff << (32 - r.prefix)) >>> 0;
							if (((n & mask) >>> 0) === ((ipv4ToInt(r.network) & mask) >>> 0)) return true;
						}
					}
					return false;
				}
				get rules() {
					return this._rules.map((r) => (r.type === "address" ? `Address: ${r.address}` : r.type === "range" ? `Range: ${r.start}-${r.end}` : `Subnet: ${r.network}/${r.prefix}`));
				}
			}
			net.SocketAddress ??= SocketAddress;
			net.BlockList ??= BlockList;
			net.Stream ??= net.Socket;
			net.getDefaultAutoSelectFamilyAttemptTimeout ??= () => 250;
			net.setDefaultAutoSelectFamilyAttemptTimeout ??= () => {};
		}
	}

	// ---- tls -------------------------------------------------------------------------------------------------------
	{
		const tls = builtins.tls;
		if (tls && !tls.__graakUnavailable) {
			tls.DEFAULT_CIPHERS ??= "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384";
			tls.DEFAULT_ECDH_CURVE ??= "auto";
			tls.CLIENT_RENEG_LIMIT ??= 3;
			tls.CLIENT_RENEG_WINDOW ??= 600;
			tls.getCiphers ??= () => tls.DEFAULT_CIPHERS.toLowerCase().split(":");
			tls.convertALPNProtocols ??= (protocols, out) => {
				const list = [].concat(protocols).map((p) => Buffer.from(p));
				out.ALPNProtocols = Buffer.concat(list.map((p) => Buffer.concat([Buffer.from([p.length]), p])));
			};
			tls.SecureContext ??= class SecureContext {
				constructor(context) {
					this.context = context;
				}
			};
			tls.checkServerIdentity ??= (hostname, cert) => {
				const names = [];
				for (const part of String(cert?.subjectaltname ?? "").split(",")) {
					const m = /^\s*(DNS|IP Address):(.*)$/.exec(part);
					if (m) names.push(m[2].trim());
				}
				if (!names.length && cert?.subject?.CN) names.push(cert.subject.CN);
				const host = String(hostname).toLowerCase();
				const ok = names.some((name) => {
					const n = name.toLowerCase();
					if (n === host) return true;
					if (n.startsWith("*.")) return host.split(".").slice(1).join(".") === n.slice(2) && host.split(".").length === n.split(".").length;
					return false;
				});
				if (!ok) {
					return Object.assign(new Error(`Hostname/IP does not match certificate's altnames: Host: ${hostname}. is not in the cert's altnames: ${names.map((n) => `DNS:${n}`).join(", ")}`), { code: "ERR_TLS_CERT_ALTNAME_INVALID", reason: "", host: hostname, cert });
				}
				return undefined;
			};
			tls.getCACertificates ??= () => tls.rootCertificates;
			tls.setDefaultCACertificates ??= () => {};
		}
	}

	// ---- constants: the errno names programs compare against ----------------------------------------------------
	{
		const errno = { EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, ENXIO: 6, E2BIG: 7, ENOEXEC: 8, EBADF: 9, ECHILD: 10, EAGAIN: 11, ENOMEM: 12, EACCES: 13, EFAULT: 14, EBUSY: 16, EEXIST: 17, EXDEV: 18, ENODEV: 19, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENFILE: 23, EMFILE: 24, ENOTTY: 25, ETXTBSY: 26, EFBIG: 27, ENOSPC: 28, ESPIPE: 29, EROFS: 30, EMLINK: 31, EPIPE: 32, EDOM: 33, ERANGE: 34, EDEADLK: 35, ENAMETOOLONG: 36, ENOLCK: 37, ENOSYS: 38, ENOTEMPTY: 39, ELOOP: 40, ENOMSG: 42, EIDRM: 43, ENOSTR: 60, ENODATA: 61, ETIME: 62, ENOSR: 63, ENOLINK: 67, EPROTO: 71, EMULTIHOP: 72, EBADMSG: 74, EOVERFLOW: 75, EILSEQ: 84, EUSERS: 87, ENOTSOCK: 88, EDESTADDRREQ: 89, EMSGSIZE: 90, EPROTOTYPE: 91, ENOPROTOOPT: 92, EPROTONOSUPPORT: 93, ENOTSUP: 95, EOPNOTSUPP: 95, EAFNOSUPPORT: 97, EADDRINUSE: 98, EADDRNOTAVAIL: 99, ENETDOWN: 100, ENETUNREACH: 101, ENETRESET: 102, ECONNABORTED: 103, ECONNRESET: 104, ENOBUFS: 105, EISCONN: 106, ENOTCONN: 107, ETIMEDOUT: 110, ECONNREFUSED: 111, EHOSTUNREACH: 113, EALREADY: 114, EINPROGRESS: 115, ESTALE: 116, EDQUOT: 122, ECANCELED: 125, EOWNERDEAD: 130, ENOTRECOVERABLE: 131 };
		const target = os.constants?.errno;
		if (target) for (const [k, v] of Object.entries(errno)) if (!(k in target)) target[k] = v;
		const c = builtins.constants;
		if (c) for (const [k, v] of Object.entries(errno)) if (!(k in c)) c[k] = v;
	}

	// ---- async_hooks, repl, diagnostics_channel: small members -----------------------------------------------------------
	{
		const ah = builtins.async_hooks;
		if (ah) {
			ah.executionAsyncResource ??= () => ({});
			ah.asyncWrapProviders ??= {};
		}
		const repl = builtins.repl;
		if (repl && !repl.__graakUnavailable) {
			repl.REPL_MODE_SLOPPY ??= Symbol("repl-sloppy");
			repl.REPL_MODE_STRICT ??= Symbol("repl-strict");
			repl.writer ??= (value) => util.inspect(value);
			repl.Recoverable ??= class Recoverable extends SyntaxError {};
			repl.isValidSyntax ??= (code) => {
				try {
					new Function(code);
					return true;
				} catch {
					return false;
				}
			};
		}
	}

	// ---- child_process: the class -------------------------------------------------------------------------------------
	{
		const cp = builtins.child_process;
		if (cp && !cp.ChildProcess) {
			cp.ChildProcess = class ChildProcess extends EventEmitter {};
		}
	}

	// ---- crypto: small members ----------------------------------------------------------------------------------------
	{
		const c = builtins.crypto;
		if (c && !c.__graakUnavailable) {
			c.randomUUIDv7 ??= () => {
				const bytes = c.randomBytes(16);
				const ms = BigInt(Date.now());
				for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
				bytes[6] = (bytes[6] & 0x0f) | 0x70;
				bytes[8] = (bytes[8] & 0x3f) | 0x80;
				const hex = bytes.toString("hex");
				return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
			};
			c.secureHeapUsed ??= () => ({ total: 0, min: 0, used: 0, utilization: 0 });
			const webCrypto = globalObject.crypto;
			if (webCrypto) {
				define("Crypto", webCrypto.constructor);
				if (webCrypto.subtle) define("SubtleCrypto", webCrypto.subtle.constructor);
				if (c.webClasses?.CryptoKey) define("CryptoKey", c.webClasses.CryptoKey);
			}
			c.setEngine ??= () => {};
		}
	}
}

export { installExtras };

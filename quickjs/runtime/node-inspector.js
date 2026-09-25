/*
 * Node's `node:inspector` (and `inspector/promises`): `Session` with `connect()`, `post()`, `disconnect()` and the
 * 'inspectorNotification' events, answering the parts of the Runtime domain a program can use from inside the process
 * (`Runtime.evaluate`, `getProperties`, `callFunctionOn`, `releaseObject`, `enable`, console notifications, ...) with the
 * shapes V8 gives them; `url()` (undefined: nothing listens), `console`, `waitForDebugger()` (not active), `close()`.
 *
 * QuickJS has no debugger protocol, no sampling profiler and no heap profiler. The domains that need them (Profiler,
 * HeapProfiler, Debugger, ...) and `open()` (which would start a debug server) throw an ERR_INSPECTOR_NOT_AVAILABLE error
 * that says so, instead of returning empty answers. Descriptions of errors carry this engine's stack, not V8's.
 */

import { nodeError } from "./node-test-util.js";

const UNAVAILABLE_DOMAINS = new Set([
	"Profiler", "HeapProfiler", "Debugger", "NodeTracing", "NodeWorker", "NodeRuntime", "Network", "DOMStorage", "IO",
	"Target", "Tracing", "Inspector",
]);
const UNAVAILABLE_RUNTIME = new Set([
	"awaitPromise", "compileScript", "runScript", "queryObjects", "getExceptionDetails", "addBinding", "removeBinding",
	"setAsyncCallStackDepth", "setCustomObjectFormatterEnabled", "setMaxCallStackSizeToCapture", "terminateExecution",
]);

const notAvailable = (what, why = "the engine has no debugger protocol, sampling profiler or heap profiler") =>
	nodeError(Error, "ERR_INSPECTOR_NOT_AVAILABLE", `${what} is not available on the Graak engine: ${why}`);
const commandError = (code, message) => nodeError(Error, "ERR_INSPECTOR_COMMAND", `Inspector error ${code}: ${message}`);
const invalidType = (name, expected, value) => {
	const shown = value === null ? "null" : typeof value === "object" || typeof value === "function" ? `an instance of ${value?.constructor?.name ?? "Object"}` : `type ${typeof value} (${String(value)})`;
	return nodeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be of type ${expected}. Received ${shown}`);
};

class ProtocolError {
	constructor(code, message) {
		this.code = code;
		this.message = message;
	}
}

export function createInspector({ EventEmitter, util, vm, process }) {
	const isProxy = (v) => util.types?.isProxy?.(v) ?? false;
	const lexicalNames = new Set();
	const sessions = new Set();
	let consolePatched = null;
	// V8 keeps what the console printed while a session was connected and reports it when the Runtime domain is enabled.
	let consoleBuffer = [];

	function patchConsole() {
		if (consolePatched) return;
		consolePatched = {};
		const types = { log: "log", info: "info", debug: "debug", warn: "warning", error: "error", dir: "dir" };
		for (const [method, type] of Object.entries(types)) {
			const original = globalThis.console?.[method];
			if (typeof original !== "function") continue;
			consolePatched[method] = original;
			globalThis.console[method] = function (...args) {
				const entry = { type, args, timestamp: Date.now() };
				consoleBuffer.push(entry);
				if (consoleBuffer.length > 1000) consoleBuffer.shift();
				for (const session of sessions) session._consoleCall(entry);
				return original.apply(this, args);
			};
		}
	}
	function unpatchConsole() {
		if (!consolePatched || sessions.size) return;
		for (const [method, original] of Object.entries(consolePatched)) globalThis.console[method] = original;
		consolePatched = null;
		consoleBuffer = [];
	}

	class Session extends EventEmitter {
		constructor() {
			super();
			this._connected = false;
			this._objects = new Map();
			this._groups = new Map();
			this._counter = 0;
			this._exceptions = 0;
			this._runtimeEnabled = false;
			this._id = `${Math.floor(Math.random() * 9e18) - 4.5e18}`.replace(/\..*$/, "");
		}

		connect() {
			if (this._connected) throw nodeError(Error, "ERR_INSPECTOR_ALREADY_CONNECTED", "The inspector session is already connected");
			this._connected = true;
			sessions.add(this);
			patchConsole();
		}

		connectToMainThread() {
			this.connect();
		}

		disconnect() {
			if (!this._connected) return;
			this._connected = false;
			this._runtimeEnabled = false;
			this._objects.clear();
			this._groups.clear();
			sessions.delete(this);
			unpatchConsole();
		}

		post(method, params, callback) {
			if (typeof method !== "string") throw invalidType("method", "string", method);
			if (typeof params === "function") {
				callback = params;
				params = undefined;
			}
			if (params !== undefined && (params === null || typeof params !== "object")) throw invalidType("params", "object", params);
			if (callback !== undefined && typeof callback !== "function") throw invalidType("callback", "function", callback);
			if (!this._connected) throw nodeError(Error, "ERR_INSPECTOR_NOT_CONNECTED", "Session is not connected");
			const domain = method.split(".")[0];
			if (UNAVAILABLE_DOMAINS.has(domain) || (domain === "Runtime" && UNAVAILABLE_RUNTIME.has(method.slice(8)))) {
				throw notAvailable(method);
			}
			this._dispatch(method, params ?? {}, (err, result) => {
				if (!callback) return;
				callback(err ? commandError(err.code, err.message) : null, err ? undefined : result);
			});
		}

		_notify(method, params) {
			const message = { method, params };
			this.emit(method, message);
			this.emit("inspectorNotification", message);
		}

		_consoleCall({ type, args, timestamp }) {
			if (!this._runtimeEnabled) return;
			this._notify("Runtime.consoleAPICalled", {
				type,
				args: args.map((a) => this._remote(a, { preview: true })),
				executionContextId: 1,
				timestamp,
				stackTrace: { callFrames: [] },
			});
		}

		/* ---------------------------------------------------------------------------------- objects */

		_register(value, group) {
			const id = `${this._id}.1.${++this._counter}`;
			this._objects.set(id, value);
			if (group) {
				if (!this._groups.has(group)) this._groups.set(group, new Set());
				this._groups.get(group).add(id);
			}
			return id;
		}

		_lookup(objectId) {
			if (typeof objectId !== "string" || !/^-?\d+\.\d+\.\d+$/.test(objectId)) throw new ProtocolError(-32000, "Invalid remote object id");
			if (!this._objects.has(objectId)) throw new ProtocolError(-32000, "Could not find object with given id");
			return this._objects.get(objectId);
		}

		/** V8's RemoteObject for a value. */
		_remote(value, { byValue = false, preview = false, group } = {}) {
			switch (typeof value) {
				case "undefined":
					return { type: "undefined" };
				case "boolean":
					return { type: "boolean", value };
				case "string":
					return { type: "string", value };
				case "number":
					if (Number.isNaN(value) || !Number.isFinite(value) || Object.is(value, -0)) {
						const text = Object.is(value, -0) ? "-0" : String(value);
						return { type: "number", unserializableValue: text, description: text };
					}
					return { type: "number", value, description: String(value) };
				case "bigint":
					return { type: "bigint", unserializableValue: `${value}n`, description: `${value}n` };
				case "symbol":
					return { type: "symbol", description: String(value), objectId: this._register(value, group) };
				default:
			}
			if (value === null) return { type: "object", subtype: "null", value: null };
			if (byValue) return { type: typeof value, value: this._serialize(value) };
			const out = this._describe(value);
			out.objectId = this._register(value, group);
			if (preview) out.preview = this._preview(value, out);
			return out;
		}

		_describe(value) {
			if (typeof value === "function") {
				let description;
				try {
					description = Function.prototype.toString.call(value);
				} catch {
					description = "function () { [native code] }";
				}
				let className = "Function";
				try {
					className = Object.getPrototypeOf(value)?.constructor?.name || "Function";
				} catch {
					/* an odd prototype reads as a plain Function */
				}
				return { type: "function", className, description };
			}
			const tag = Object.prototype.toString.call(value).slice(8, -1);
			let className = "Object";
			try {
				let proto = Object.getPrototypeOf(value);
				while (proto && !Object.getOwnPropertyDescriptor(proto, "constructor")?.value?.name) proto = Object.getPrototypeOf(proto);
				className = (proto && Object.getOwnPropertyDescriptor(proto, "constructor").value.name) || "Object";
			} catch {
				/* a hostile prototype chain reads as a plain Object */
			}
			const make = (subtype, extra = {}) => {
				const description = extra.description ?? extra.className ?? className;
				return { type: "object", ...(subtype ? { subtype } : {}), className: extra.className ?? className, description };
			};
			if (value === globalThis) return make(undefined, { className: "global" });
			if (isProxy(value)) return make("proxy", { className: "Object", description: "Proxy(Object)" });
			if (Array.isArray(value)) return make("array", { className: "Array", description: `Array(${value.length})` });
			if (value instanceof Error) {
				return make("error", { description: typeof value.stack === "string" && value.stack ? value.stack : `${value.name}: ${value.message}` });
			}
			if (value instanceof RegExp) return make("regexp", { description: String(value) });
			if (value instanceof Date) return make("date", { description: Date.prototype.toString.call(value) });
			if (value instanceof Map) return make("map", { description: `Map(${value.size})` });
			if (value instanceof Set) return make("set", { description: `Set(${value.size})` });
			if (value instanceof WeakMap) return make("weakmap");
			if (value instanceof WeakSet) return make("weakset");
			if (value instanceof Promise) return make("promise", { description: "Promise" });
			if (typeof WeakRef !== "undefined" && value instanceof WeakRef) return make("weakref");
			if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return make("typedarray", { description: `${className}(${value.length})` });
			if (value instanceof DataView) return make("dataview", { description: `DataView(${value.byteLength})` });
			if (value instanceof ArrayBuffer) return make("arraybuffer", { description: `ArrayBuffer(${value.byteLength})` });
			if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return make("arraybuffer", { description: `SharedArrayBuffer(${value.byteLength})` });
			if (tag === "Generator") return make("generator", { className: "Generator", description: "Generator" });
			if (/ Iterator$/.test(tag)) return make("iterator", { className: tag, description: tag });
			return make();
		}

		_preview(value, described) {
			const properties = [];
			let overflow = false;
			const keys = typeof value === "function" ? [] : Object.keys(value);
			for (const key of keys) {
				if (properties.length >= 5) {
					overflow = true;
					break;
				}
				const d = Object.getOwnPropertyDescriptor(value, key);
				if (d && "value" in d) {
					const v = d.value;
					const entry = { name: key, type: v === null ? "object" : typeof v };
					if (v === null) entry.subtype = "null";
					const s = typeof v === "string" ? (v.length > 100 ? `${v.slice(0, 50)}…${v.slice(-50)}` : v) : typeof v === "function" ? "" : v !== null && typeof v === "object" ? this._describe(v).description : String(v);
					entry.value = s;
					if (v !== null && typeof v === "object") {
						const sub = this._describe(v).subtype;
						if (sub) entry.subtype = sub;
					}
					properties.push(entry);
				} else properties.push({ name: key, type: "accessor" });
			}
			const out = { type: "object", description: described.description, overflow, properties };
			if (described.subtype) out.subtype = described.subtype;
			return { type: out.type, ...(out.subtype ? { subtype: out.subtype } : {}), description: out.description, overflow, properties };
		}

		/** A copy of a value made of plain data, as `returnByValue` gives it. */
		_serialize(value, stack = []) {
			if (typeof value === "function") return {};
			if (value === null || typeof value !== "object") return value;
			if (stack.includes(value)) throw new ProtocolError(-32000, "Object reference chain is too long");
			if (typeof value.toJSON === "function") return this._serialize(value.toJSON(), stack);
			stack.push(value);
			try {
				if (Array.isArray(value)) return value.map((v) => (v === undefined || typeof v === "symbol" ? null : this._serialize(v, stack)));
				const out = {};
				for (const key of Object.keys(value)) {
					const v = value[key];
					if (v === undefined || typeof v === "symbol") continue;
					out[key] = this._serialize(v, stack);
				}
				return out;
			} finally {
				stack.pop();
			}
		}

		_exception(thrown, options, text = "Uncaught") {
			return {
				exceptionId: ++this._exceptions,
				text,
				lineNumber: 0,
				columnNumber: 0,
				exception: this._remote(thrown, options),
			};
		}

		/* -------------------------------------------------------------------------------- commands */

		_dispatch(method, params, done) {
			let result;
			try {
				result = this._run(method, params, done);
			} catch (err) {
				if (err instanceof ProtocolError) return done(err);
				throw err;
			}
			if (result !== undefined) done(null, result);
		}

		_run(method, params, done) {
			const opts = () => ({ byValue: Boolean(params.returnByValue), preview: Boolean(params.generatePreview), group: params.objectGroup });
			const invalid = () => new ProtocolError(-32602, "Invalid parameters");
			switch (method) {
				case "Runtime.enable":
					if (!this._runtimeEnabled) {
						this._runtimeEnabled = true;
						this._notify("Runtime.executionContextCreated", {
							context: { id: 1, origin: "", name: `graak[${process.pid}]`, uniqueId: `${this._id}.1`, auxData: { isDefault: true } },
						});
						for (const entry of [...consoleBuffer]) this._consoleCall(entry);
					}
					return {};
				case "Runtime.disable":
					this._runtimeEnabled = false;
					return {};
				case "Runtime.discardConsoleEntries":
					consoleBuffer = [];
					return {};
				case "Runtime.runIfWaitingForDebugger":
				case "Console.enable":
				case "Console.disable":
				case "Console.clearMessages":
					return {};
				case "Runtime.getIsolateId":
					return { id: this._id.replace(/\D/g, "").slice(0, 16).padStart(16, "0") };
				case "Runtime.getHeapUsage": {
					const m = process.memoryUsage?.() ?? {};
					return { usedSize: m.heapUsed ?? 0, totalSize: m.heapTotal ?? 0, embedderHeapUsedSize: 0, backingStorageSize: m.arrayBuffers ?? 0 };
				}
				case "Runtime.globalLexicalScopeNames":
					return { names: [...lexicalNames] };
				case "Schema.getDomains":
					return { domains: [{ name: "Runtime", version: "1.3" }, { name: "Console", version: "1.3" }, { name: "Schema", version: "1.3" }] };
				case "Runtime.releaseObject":
					if (typeof params.objectId !== "string") throw invalid();
					this._objects.delete(params.objectId);
					return {};
				case "Runtime.releaseObjectGroup":
					if (typeof params.objectGroup !== "string") throw invalid();
					for (const id of this._groups.get(params.objectGroup) ?? []) this._objects.delete(id);
					this._groups.delete(params.objectGroup);
					return {};
				case "Runtime.evaluate": {
					if (typeof params.expression !== "string") throw invalid();
					let value;
					try {
						value = vm.runInThisContext(params.expression);
						for (const m of params.expression.matchAll(/(?:^|[;\n}])\s*(?:let|const|class)\s+([A-Za-z_$][\w$]*)/g)) lexicalNames.add(m[1]);
					} catch (thrown) {
						return { result: this._remote(thrown, opts()), exceptionDetails: this._exception(thrown, opts()) };
					}
					return this._settle(value, params, opts, done);
				}
				case "Runtime.callFunctionOn": {
					if (typeof params.functionDeclaration !== "string") throw invalid();
					if (params.objectId !== undefined && typeof params.objectId !== "string") throw invalid();
					const self = params.objectId === undefined ? undefined : this._lookup(params.objectId);
					const args = (params.arguments ?? []).map((a) => {
						if (a.objectId !== undefined) return this._lookup(a.objectId);
						if (a.unserializableValue !== undefined) return a.unserializableValue.endsWith("n") ? BigInt(a.unserializableValue.slice(0, -1)) : Number(a.unserializableValue === "-0" ? -0 : a.unserializableValue);
						return a.value;
					});
					let value;
					try {
						value = vm.runInThisContext(`(${params.functionDeclaration})`).apply(self, args);
					} catch (thrown) {
						return { result: this._remote(thrown, opts()), exceptionDetails: this._exception(thrown, opts()) };
					}
					return this._settle(value, params, opts, done);
				}
				case "Runtime.getProperties": {
					if (typeof params.objectId !== "string") throw invalid();
					const target = this._lookup(params.objectId);
					if (target === null || (typeof target !== "object" && typeof target !== "function")) throw new ProtocolError(-32000, "Object is not available");
					return this._properties(target, params);
				}
				default:
					throw new ProtocolError(-32601, `'${method}' wasn't found`);
			}
		}

		/** Turns the value an expression produced into the protocol answer, waiting for a promise when asked to. */
		_settle(value, params, opts, done) {
			if (params.awaitPromise && value && typeof value.then === "function") {
				Promise.resolve(value).then(
					(resolved) => done(null, { result: this._remote(resolved, opts()) }),
					(reason) => done(null, { result: this._remote(reason, opts()), exceptionDetails: this._exception(reason, opts(), "Uncaught (in promise)") })
				);
				return undefined;
			}
			return { result: this._remote(value, opts()) };
		}

		_properties(target, params) {
			const result = [];
			const seen = new Set();
			const own = params.ownProperties === true;
			const describe = (name, d, isOwn, symbol) => {
				const entry = { name };
				if (d && "value" in d) {
					entry.value = this._remote(d.value, { preview: Boolean(params.generatePreview) });
					entry.writable = d.writable;
				} else {
					entry.get = d?.get ? this._remote(d.get) : { type: "undefined" };
					entry.set = d?.set ? this._remote(d.set) : { type: "undefined" };
				}
				entry.configurable = d.configurable;
				entry.enumerable = d.enumerable;
				entry.isOwn = isOwn;
				if (symbol) entry.symbol = this._remote(symbol);
				return entry;
			};
			let obj = target;
			for (let depth = 0; obj !== null && obj !== undefined; depth++) {
				if (depth > 0 && own) break;
				for (const key of Reflect.ownKeys(obj)) {
					const isSymbol = typeof key === "symbol";
					const name = isSymbol ? String(key) : key;
					if (seen.has(key)) continue;
					seen.add(key);
					const d = Object.getOwnPropertyDescriptor(obj, key);
					if (!d) continue;
					if (params.accessorPropertiesOnly && "value" in d) continue;
					result.push(describe(name, d, depth === 0, isSymbol ? key : undefined));
				}
				obj = Object.getPrototypeOf(obj);
			}
			const out = { result };
			const proto = Object.getPrototypeOf(target);
			if (proto !== null && !params.accessorPropertiesOnly) out.internalProperties = [{ name: "[[Prototype]]", value: this._remote(proto) }];
			return out;
		}
	}

	class PromiseSession extends Session {
		post(method, params) {
			return new Promise((resolve, reject) => {
				super.post(method, params, (err, result) => (err ? reject(err) : resolve(result)));
			});
		}
	}

	const inspectorConsole = {};
	for (const name of [
		"debug", "error", "info", "log", "warn", "dir", "dirxml", "table", "trace", "group", "groupCollapsed", "groupEnd", "clear",
		"count", "countReset", "assert", "profile", "profileEnd", "time", "timeLog", "timeEnd", "timeStamp", "context",
	]) {
		inspectorConsole[name] = function () {};
	}
	const noops = (...names) => Object.fromEntries(names.map((name) => [name, function () {}]));

	const base = {
		open() {
			throw notAvailable("inspector.open()", "there is no debug server to start, so a debugger cannot attach");
		},
		close() {},
		url: () => undefined,
		waitForDebugger() {
			throw nodeError(Error, "ERR_INSPECTOR_NOT_ACTIVE", "Inspector is not active");
		},
		console: inspectorConsole,
		Session,
		Network: noops(
			"requestWillBeSent", "responseReceived", "loadingFinished", "loadingFailed", "dataSent", "dataReceived", "webSocketCreated",
			"webSocketClosed", "webSocketHandshakeResponseReceived"
		),
		NetworkResources: noops("put"),
		DOMStorage: noops("domStorageItemAdded", "domStorageItemRemoved", "domStorageItemUpdated", "domStorageItemsCleared", "registerStorage"),
	};
	const promises = { ...base, Session: PromiseSession };
	return Object.defineProperty(base, "promises", { value: promises, enumerable: false });
}

/*
 * The `WebAssembly` global, over wasm3 (quickjs/native/fg_wasm.c).
 *
 * Module, Instance, Memory, Global, Table, instantiate/compile/validate and the three error classes follow the
 * JavaScript API. The module's structure (types, imports, exports, custom sections) is read here from the binary
 * itself, so `WebAssembly.Module.imports()` and LinkError checks do not depend on the interpreter's internals;
 * wasm3 is asked only to run code.
 *
 * What wasm3 cannot do is reported, not faked: SIMD, threads and exception handling fail to compile (so feature
 * probes such as `validate()` answer honestly), and a module that imports a memory, table or global (rather than
 * defining it) fails to instantiate with a LinkError that says so.
 */

const KIND = ["function", "table", "memory", "global"];
const VALTYPE = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128", 0x70: "funcref", 0x6f: "externref" };
const LETTER = { i32: "i", i64: "I", f32: "f", f64: "F" };

class CompileError extends Error {
	constructor(message) {
		super(message);
		this.name = "CompileError";
	}
}
class LinkError extends Error {
	constructor(message) {
		super(message);
		this.name = "LinkError";
	}
}
class RuntimeError extends Error {
	constructor(message) {
		super(message);
		this.name = "RuntimeError";
	}
}

/* ------------------------------------------------------------------ binary reader */

class Reader {
	constructor(bytes) {
		this.bytes = bytes;
		this.pos = 0;
	}
	byte() {
		if (this.pos >= this.bytes.length) throw new CompileError("unexpected end of the module");
		return this.bytes[this.pos++];
	}
	u32() {
		let result = 0;
		let shift = 0;
		for (;;) {
			const b = this.byte();
			result += (b & 0x7f) * 2 ** shift;
			if (!(b & 0x80)) return result;
			shift += 7;
			if (shift > 35) throw new CompileError("invalid LEB128 in the module");
		}
	}
	skipLeb() {
		while (this.byte() & 0x80);
	}
	name() {
		const length = this.u32();
		const text = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + length));
		this.pos += length;
		return text;
	}
	limits() {
		const flag = this.byte();
		const min = this.u32();
		const max = flag & 1 ? this.u32() : undefined;
		return { min, max };
	}
	/* A constant initialiser expression: skipped up to its `end`. */
	skipExpr() {
		for (;;) {
			const op = this.byte();
			if (op === 0x0b) return;
			if (op === 0x41 || op === 0x42 || op === 0x23 || op === 0xd2) this.skipLeb();
			else if (op === 0x43) this.pos += 4;
			else if (op === 0x44) this.pos += 8;
			else if (op === 0xd0) this.byte();
			else if (op === 0x6a || op === 0x6b || op === 0x6c || op === 0x7c || op === 0x7d || op === 0x7e) continue;
			else throw new CompileError(`unsupported constant expression opcode 0x${op.toString(16)}`);
		}
	}
}

function parseModule(bytes) {
	if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
		throw new CompileError("expected magic word 00 61 73 6d");
	}
	if (bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) throw new CompileError("expected version 01 00 00 00");
	const info = { types: [], imports: [], funcs: [], exports: [], customSections: [], globalDefs: [], start: undefined };
	const r = new Reader(bytes);
	r.pos = 8;
	while (r.pos < bytes.length) {
		const id = r.byte();
		const size = r.u32();
		const end = r.pos + size;
		if (end > bytes.length) throw new CompileError("section extends past the end of the module");
		if (id === 0) {
			const name = r.name();
			info.customSections.push({ name, data: bytes.slice(r.pos, end) });
		} else if (id === 1) {
			for (let n = r.u32(); n > 0; n--) {
				if (r.byte() !== 0x60) throw new CompileError("expected a function type");
				const params = [];
				for (let p = r.u32(); p > 0; p--) params.push(VALTYPE[r.byte()] ?? "unknown");
				const results = [];
				for (let p = r.u32(); p > 0; p--) results.push(VALTYPE[r.byte()] ?? "unknown");
				info.types.push({ params, results });
			}
		} else if (id === 2) {
			for (let n = r.u32(); n > 0; n--) {
				const module = r.name();
				const name = r.name();
				const kind = r.byte();
				const entry = { module, name, kind: KIND[kind] };
				if (kind === 0) {
					entry.type = r.u32();
					info.funcs.push(entry.type);
				} else if (kind === 1) {
					r.byte();
					entry.limits = r.limits();
				} else if (kind === 2) entry.limits = r.limits();
				else if (kind === 3) {
					entry.valueType = VALTYPE[r.byte()];
					entry.mutable = r.byte() === 1;
				} else throw new CompileError("unknown import kind");
				info.imports.push(entry);
			}
		} else if (id === 3) {
			for (let n = r.u32(); n > 0; n--) info.funcs.push(r.u32());
		} else if (id === 6) {
			for (let n = r.u32(); n > 0; n--) {
				const type = VALTYPE[r.byte()];
				const mutable = r.byte() === 1;
				r.skipExpr();
				info.globalDefs.push({ type, mutable });
			}
		} else if (id === 7) {
			for (let n = r.u32(); n > 0; n--) {
				const name = r.name();
				const kind = r.byte();
				const index = r.u32();
				info.exports.push({ name, kind: KIND[kind], index });
			}
		} else if (id === 8) info.start = r.u32();
		r.pos = end;
	}
	return info;
}

/* ------------------------------------------------------------------- error mapping */

const TRAPS = [
	[/out of bounds memory access/, "memory access out of bounds"],
	[/integer divide by zero/, "divide by zero"],
	[/integer overflow/, "divide result unrepresentable"],
	[/invalid conversion to integer/, "float unrepresentable in integer range"],
	[/unreachable/, "unreachable"],
	[/undefined element|table index/, "table index is out of bounds"],
	[/null table element/, "null function or function signature mismatch"],
	[/indirect call type mismatch/, "null function or function signature mismatch"],
];

function mapError(error) {
	if (!error || typeof error !== "object" || !error.wasmKind) return error;
	const raw = String(error.message);
	if (/stack overflow/.test(raw)) return new RangeError("Maximum call stack size exceeded");
	const text = raw.replace(/^\[trap\]\s*/, "");
	if (error.wasmKind === "RuntimeError") {
		const mapped = TRAPS.find(([pattern]) => pattern.test(raw));
		return new RuntimeError(mapped ? mapped[1] : text);
	}
	if (error.wasmKind === "LinkError") return new LinkError(`WebAssembly.Instance(): ${text}`);
	return new CompileError(`WebAssembly.Module(): ${text}`);
}

/* Function imports as stand-ins, so a module can be compiled (and rejected) before anyone supplies the real ones. */
function stubImports(info) {
	const letters = (list) => list.map((t) => LETTER[t] ?? "?").join("");
	const stubs = [];
	for (const entry of info.imports) {
		if (entry.kind !== "function") return null; // memory, table and global imports cannot be stubbed
		const type = info.types[entry.type];
		if (!type || type.results.length > 1 || letters(type.params).includes("?") || letters(type.results).includes("?")) return null;
		stubs.push({ module: entry.module, name: entry.name, sig: `${type.results.length ? letters(type.results) : "v"}(${letters(type.params)})`, fn: () => 0 });
	}
	return stubs;
}

const toBytes = (source, what) => {
	if (source instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && source instanceof SharedArrayBuffer)) return new Uint8Array(source);
	if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
	throw new TypeError(`${what}: Argument 0 must be a buffer source`);
};

/* ------------------------------------------------------------------------ objects */

const internals = new WeakMap();

function createWebAssembly(native) {
	class Module {
		constructor(source) {
			const bytes = toBytes(source, "WebAssembly.Module()").slice();
			const info = parseModule(bytes);
			const stubs = stubImports(info);
			try {
				if (stubs) native.wasmInstantiate(bytes, stubs, true);
			} catch (error) {
				throw mapError(error);
			}
			internals.set(this, { bytes, info });
		}
		static imports(module) {
			return internals.get(module).info.imports.map(({ module: m, name, kind }) => ({ module: m, name, kind }));
		}
		static exports(module) {
			return internals.get(module).info.exports.map(({ name, kind }) => ({ name, kind }));
		}
		static customSections(module, name) {
			return internals.get(module).info.customSections.filter((s) => s.name === name).map((s) => s.data.buffer.slice(s.data.byteOffset, s.data.byteOffset + s.data.byteLength));
		}
		get [Symbol.toStringTag]() {
			return "WebAssembly.Module";
		}
	}

	/* A Memory that belongs to an instance reads the interpreter's memory; a standalone one owns its buffer. */
	class Memory {
		constructor(descriptor, bound) {
			if (bound !== undefined) {
				internals.set(this, { instance: bound });
				return;
			}
			if (!descriptor || typeof descriptor !== "object") throw new TypeError("WebAssembly.Memory(): Argument 0 must be a memory descriptor");
			const initial = Number(descriptor.initial);
			if (!Number.isInteger(initial) || initial < 0 || initial > 65536) throw new RangeError("WebAssembly.Memory(): Property 'initial': value is out of range");
			internals.set(this, { pages: initial, maximum: descriptor.maximum, buffer: new ArrayBuffer(initial * 65536) });
		}
		get buffer() {
			const own = internals.get(this);
			if (own.instance !== undefined) return native.wasmMemory(own.instance) ?? new ArrayBuffer(0);
			return own.buffer;
		}
		grow(delta) {
			const own = internals.get(this);
			if (own.instance !== undefined) {
				const before = native.wasmGrow(own.instance, delta);
				if (before < 0) throw new RangeError("WebAssembly.Memory.grow(): Maximum memory size exceeded");
				return before;
			}
			const before = own.pages;
			const after = before + delta;
			if (delta < 0 || after > (own.maximum ?? 65536)) throw new RangeError("WebAssembly.Memory.grow(): Maximum memory size exceeded");
			const grown = new ArrayBuffer(after * 65536);
			new Uint8Array(grown).set(new Uint8Array(own.buffer));
			own.pages = after;
			own.buffer = grown;
			return before;
		}
		get [Symbol.toStringTag]() {
			return "WebAssembly.Memory";
		}
	}

	class Global {
		constructor(descriptor, value, bound) {
			if (bound) {
				internals.set(this, { ...bound });
				return;
			}
			const type = descriptor?.value;
			if (!LETTER[type]) throw new TypeError("WebAssembly.Global(): Descriptor property 'value' must be a WebAssembly type");
			internals.set(this, { type, mutable: Boolean(descriptor.mutable), value: value ?? (type === "i64" ? 0n : 0) });
		}
		get value() {
			const own = internals.get(this);
			return own.instance !== undefined ? native.wasmGlobal(own.instance, own.name) : own.value;
		}
		set value(v) {
			const own = internals.get(this);
			if (!own.mutable) throw new TypeError("WebAssembly.Global.value: Can't set the value of an immutable global.");
			if (own.instance !== undefined) native.wasmGlobal(own.instance, own.name, v);
			else own.value = v;
		}
		valueOf() {
			return this.value;
		}
		get [Symbol.toStringTag]() {
			return "WebAssembly.Global";
		}
	}

	class Table {
		constructor(descriptor) {
			const initial = Number(descriptor?.initial ?? 0);
			internals.set(this, { elements: new Array(initial).fill(null), maximum: descriptor?.maximum });
		}
		get length() {
			return internals.get(this).elements.length;
		}
		get(index) {
			return internals.get(this).elements[index] ?? null;
		}
		set(index, value) {
			internals.get(this).elements[index] = value;
		}
		grow(delta) {
			const own = internals.get(this);
			const before = own.elements.length;
			own.elements.length += delta;
			own.elements.fill(null, before);
			return before;
		}
		get [Symbol.toStringTag]() {
			return "WebAssembly.Table";
		}
	}

	class Instance {
		constructor(module, importObject) {
			if (!internals.has(module)) throw new TypeError("WebAssembly.Instance(): Argument 0 must be a WebAssembly.Module");
			const { bytes, info } = internals.get(module);
			const imports = [];
			let index = 0;
			for (const entry of info.imports) {
				const where = `Import #${index++} "${entry.module}" "${entry.name}"`;
				if (importObject === undefined || importObject === null) {
					throw new TypeError("WebAssembly.Instance(): Imports argument must be present and must be an object");
				}
				const source = importObject[entry.module];
				if (source === undefined || source === null || (typeof source !== "object" && typeof source !== "function")) {
					throw new TypeError(`WebAssembly.Instance(): Import #${index - 1} "${entry.module}": module is not an object or function`);
				}
				const value = source[entry.name];
				if (entry.kind !== "function") {
					throw new LinkError(
						`WebAssembly.Instance(): ${where}: ${entry.kind} imports are not supported by the Graak native host ` +
							"(a module can define its own memory, table and globals, but not import them)"
					);
				}
				if (typeof value !== "function") throw new LinkError(`WebAssembly.Instance(): ${where}: function import requires a callable`);
				const type = info.types[entry.type];
				if (type.results.length > 1) throw new LinkError(`WebAssembly.Instance(): ${where}: multi-value function returns are not supported`);
				const letters = (list) => list.map((t) => LETTER[t] ?? "?").join("");
				if (letters(type.params).includes("?") || letters(type.results).includes("?")) {
					throw new LinkError(`WebAssembly.Instance(): ${where}: parameter or result types outside i32, i64, f32 and f64 are not supported`);
				}
				imports.push({ module: entry.module, name: entry.name, sig: `${type.results.length ? letters(type.results) : "v"}(${letters(type.params)})`, fn: value });
			}

			let id;
			try {
				id = native.wasmInstantiate(bytes, imports, false);
			} catch (error) {
				throw mapError(error);
			}
			const exports = Object.create(null);
			for (const entry of info.exports) {
				if (entry.kind === "function") {
					const found = native.wasmFind(id, entry.name);
					if (!found) throw new LinkError(`WebAssembly.Instance(): export "${entry.name}" could not be found in the interpreter`);
					const call = (...args) => {
						try {
							return native.wasmCall(id, found.index, args);
						} catch (error) {
							throw mapError(error);
						}
					};
					const fn = function (...args) {
						while (args.length < found.args.length) args.push(undefined);
						return call(...args.slice(0, found.args.length));
					};
					Object.defineProperty(fn, "length", { value: found.args.length });
					Object.defineProperty(fn, "name", { value: String(entry.index) });
					exports[entry.name] = fn;
				} else if (entry.kind === "memory") exports[entry.name] = new Memory(undefined, id);
				else if (entry.kind === "global") {
					// Imported globals come first in the index space, and none can be imported here.
					const definition = info.globalDefs[entry.index - info.imports.filter((i) => i.kind === "global").length];
					exports[entry.name] = new Global(undefined, undefined, { instance: id, name: entry.name, mutable: Boolean(definition?.mutable), type: definition?.type });
				} else exports[entry.name] = new Table({ initial: 0 });
			}
			Object.freeze(exports);
			Object.defineProperty(this, "exports", { value: exports, enumerable: true });
		}
		get [Symbol.toStringTag]() {
			return "WebAssembly.Instance";
		}
	}

	const validate = (source) => {
		let bytes;
		try {
			bytes = toBytes(source, "WebAssembly.validate()");
		} catch (error) {
			throw error;
		}
		try {
			const info = parseModule(bytes);
			const stubs = stubImports(info);
			if (stubs) native.wasmInstantiate(bytes.slice(), stubs, true);
			return true;
		} catch {
			return false;
		}
	};

	const WebAssembly = {
		Module,
		Instance,
		Memory,
		Global,
		Table,
		CompileError,
		LinkError,
		RuntimeError,
		validate,
		compile: async (source) => new Module(source),
		instantiate: async (source, importObject) => {
			if (source instanceof Module) return new Instance(source, importObject);
			const module = new Module(source);
			return { module, instance: new Instance(module, importObject) };
		},
		compileStreaming: async (response) => new Module(await (await response).arrayBuffer()),
		instantiateStreaming: async (response, importObject) => {
			const module = new Module(await (await response).arrayBuffer());
			return { module, instance: new Instance(module, importObject) };
		},
	};
	Object.defineProperty(WebAssembly, Symbol.toStringTag, { value: "WebAssembly" });
	return WebAssembly;
}

export { createWebAssembly };

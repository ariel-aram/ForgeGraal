/*
 * Deno's FFI -- Deno.dlopen, UnsafePointer, UnsafePointerView, UnsafeFnPointer, UnsafeCallback -- for programs
 * bundled by Graak, on the host's libffi (quickjs/native/fg_ffi.c). It exists only on the Graak engine: Node.js has
 * no foreign function interface to adapt, and a program built for Node.js gets Deno.errors.NotSupported, saying so.
 *
 * What is the same as Deno: 64-bit integers are bigints, pointers are opaque objects (or null), a `buffer` argument
 * passes the address of a typed array, `function` takes a callback's pointer, structs are typed arrays, and a symbol
 * that is not in the library is an Error naming it. What differs: a `nonblocking` symbol runs on the JavaScript thread
 * (it returns a promise, but the call itself blocks the event loop while it runs), and a callback invoked from another
 * thread is not delivered (the host says so on stderr and returns zero).
 */
(function installFfi(global) {
	"use strict";
	const Deno = global.Deno;
	if (!Deno || Deno.__graakFfi) return;
	Object.defineProperty(Deno, "__graakFfi", { value: true, enumerable: false });

	const native = global.__graak_native;
	const supported = Boolean(native && typeof native.ffiOpen === "function");
	const { fileURLToPath } = require("url");

	function notSupported() {
		return new Deno.errors.NotSupported(
			"Deno FFI is not supported on the Node.js engine: it needs the Graak engine (build with --engine native)."
		);
	}
	if (!supported) {
		Deno.dlopen = () => {
			throw notSupported();
		};
		for (const name of ["UnsafePointer", "UnsafePointerView", "UnsafeFnPointer", "UnsafeCallback"]) {
			Object.defineProperty(Deno, name, {
				get() {
					throw notSupported();
				},
				enumerable: false,
				configurable: true,
			});
		}
		return;
	}

	// ---- pointers ----------------------------------------------------------------------------------------------
	const ADDRESS = Symbol("graak.pointer");

	class PointerObject {
		constructor(address) {
			Object.defineProperty(this, ADDRESS, { value: address, enumerable: false });
			Object.freeze(this);
		}
	}
	const addressOf = (pointer) => {
		if (pointer === null || pointer === undefined) return null;
		if (typeof pointer === "bigint") return pointer;
		if (typeof pointer === "number") return BigInt(pointer);
		if (pointer instanceof PointerObject) return pointer[ADDRESS];
		if (pointer && pointer.pointer instanceof PointerObject) return pointer.pointer[ADDRESS];
		throw new TypeError("The argument is not a pointer");
	};
	const wrap = (address) => (address === null || address === undefined || address === 0n ? null : new PointerObject(address));

	const UnsafePointer = {
		create: (value) => wrap(BigInt(value)),
		equals: (a, b) => addressOf(a) === addressOf(b),
		of(source) {
			if (source instanceof UnsafeCallback) return source.pointer;
			return wrap(native.ffiAddressOf(source));
		},
		offset(pointer, offset) {
			const base = addressOf(pointer);
			return base === null ? null : wrap(base + BigInt(offset));
		},
		value: (pointer) => (pointer === null ? 0n : addressOf(pointer)),
	};

	class UnsafePointerView {
		constructor(pointer) {
			this.pointer = pointer;
		}
		#at(offset = 0) {
			const base = addressOf(this.pointer);
			if (base === null) throw new TypeError("Invalid pointer: null");
			return base + BigInt(offset);
		}
		#read(offset, size) {
			return new DataView(native.ffiPeek(this.#at(offset), size));
		}
		getBool(offset) {
			return this.getUint8(offset) !== 0;
		}
		getUint8(offset) {
			return this.#read(offset, 1).getUint8(0);
		}
		getInt8(offset) {
			return this.#read(offset, 1).getInt8(0);
		}
		getUint16(offset) {
			return this.#read(offset, 2).getUint16(0, true);
		}
		getInt16(offset) {
			return this.#read(offset, 2).getInt16(0, true);
		}
		getUint32(offset) {
			return this.#read(offset, 4).getUint32(0, true);
		}
		getInt32(offset) {
			return this.#read(offset, 4).getInt32(0, true);
		}
		getBigUint64(offset) {
			return this.#read(offset, 8).getBigUint64(0, true);
		}
		getBigInt64(offset) {
			return this.#read(offset, 8).getBigInt64(0, true);
		}
		getFloat32(offset) {
			return this.#read(offset, 4).getFloat32(0, true);
		}
		getFloat64(offset) {
			return this.#read(offset, 8).getFloat64(0, true);
		}
		getPointer(offset) {
			return wrap(this.#read(offset, 8).getBigUint64(0, true));
		}
		getCString(offset) {
			return native.ffiCString(this.#at(offset));
		}
		getArrayBuffer(byteLength, offset) {
			return native.ffiPeek(this.#at(offset), byteLength);
		}
		copyInto(destination, offset) {
			const bytes = new Uint8Array(native.ffiPeek(this.#at(offset), destination.byteLength));
			new Uint8Array(destination.buffer ?? destination, destination.byteOffset ?? 0, destination.byteLength).set(bytes);
		}
		static getCString(pointer, offset) {
			return new UnsafePointerView(pointer).getCString(offset);
		}
		static getArrayBuffer(pointer, byteLength, offset) {
			return new UnsafePointerView(pointer).getArrayBuffer(byteLength, offset);
		}
		static copyInto(pointer, destination, offset) {
			new UnsafePointerView(pointer).copyInto(destination, offset);
		}
	}

	// ---- types -------------------------------------------------------------------------------------------------
	/** A Deno type as the host wants it: a name, or an array of field names for a struct passed by value. */
	function hostType(type) {
		if (typeof type === "string") return type;
		if (type && Array.isArray(type.struct)) return type.struct.map(hostType);
		throw new TypeError(`Invalid FFI type: ${JSON.stringify(type)}`);
	}
	const isStruct = (type) => typeof type === "object" && type !== null && Array.isArray(type.struct);

	const INTEGER_TYPES = new Set(["i8", "u8", "i16", "u16", "i32", "u32"]);
	const WIDE_TYPES = new Set(["i64", "u64", "isize", "usize"]);

	/** An argument as the host takes it: a pointer as its address, everything else as it is, checked against its type. */
	function toHost(type, value) {
		if (type === "pointer" || type === "function") {
			if (value !== null && !(value instanceof PointerObject) && !(value && value.pointer instanceof PointerObject)) {
				throw new TypeError(`Invalid FFI ${type} type, expected null or a pointer`);
			}
			return addressOf(value);
		}
		if (type === "buffer") {
			if (value === null) return null;
			if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
			throw new TypeError("Invalid FFI buffer type, expected null, TypedArray or ArrayBuffer");
		}
		if (type === "bool") {
			if (typeof value !== "boolean") throw new TypeError("Invalid FFI bool type, expected boolean");
			return value;
		}
		if (INTEGER_TYPES.has(type)) {
			if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(`Invalid FFI ${type} type, expected integer`);
			return value;
		}
		if (WIDE_TYPES.has(type)) {
			if (typeof value !== "bigint" && !(typeof value === "number" && Number.isInteger(value))) throw new TypeError(`Invalid FFI ${type} type, expected integer or bigint`);
			return value;
		}
		if (type === "f32" || type === "f64") {
			if (typeof value !== "number") throw new TypeError(`Invalid FFI ${type} type, expected number`);
			return value;
		}
		return value;
	}
	function fromHost(type, value) {
		if (type === "pointer" || type === "function") return wrap(value);
		return value;
	}

	function makeCaller(address, definition) {
		const params = (definition.parameters ?? []).map(hostType);
		const declared = definition.parameters ?? [];
		const result = definition.result === undefined ? "void" : definition.result;
		const hostResult = hostType(result);
		const invoke = (...args) => {
			// Arguments beyond the declared ones are ignored, as in Deno; a missing one fails its type check.
			const converted = params.map((_, i) => toHost(declared[i], args[i]));
			return fromHost(result, native.ffiCall(address, params, hostResult, converted));
		};
		return definition.nonblocking ? (...args) => new Promise((resolve, reject) => setTimeout(() => {
			try {
				resolve(invoke(...args));
			} catch (error) {
				reject(error);
			}
		}, 0)) : invoke;
	}

	// ---- callbacks ---------------------------------------------------------------------------------------------
	class UnsafeCallback {
		#address;
		#closed = false;
		constructor(definition, callback) {
			if (typeof callback !== "function") throw new TypeError("UnsafeCallback needs a function");
			this.definition = definition;
			this.callback = callback;
			const declared = definition.parameters ?? [];
			const result = definition.result === undefined ? "void" : definition.result;
			const wrapped = (...raw) => {
				const args = raw.map((value, i) => fromHost(declared[i], value));
				return toHost(result, callback(...args));
			};
			this.#address = native.ffiCallback(hostType(result), declared.map(hostType), wrapped);
			this.pointer = wrap(this.#address);
		}
		static threadSafe(definition, callback) {
			return new UnsafeCallback(definition, callback);
		}
		ref() {}
		unref() {}
		close() {
			if (this.#closed) return;
			this.#closed = true;
			native.ffiCallbackFree(this.#address);
		}
		[Symbol.dispose]() {
			this.close();
		}
	}

	class UnsafeFnPointer {
		constructor(pointer, definition) {
			this.pointer = pointer;
			this.definition = definition;
			const call = makeCaller(addressOf(pointer), definition);
			this.call = call;
		}
	}

	// ---- libraries ---------------------------------------------------------------------------------------------
	function dlopen(path, symbols) {
		const file = path instanceof URL ? fileURLToPath(path) : String(path);
		let id;
		try {
			id = native.ffiOpen(file);
		} catch (error) {
			throw new Error(`Failed to open the library ${file}: ${error.message}`);
		}
		const table = {};
		for (const [name, definition] of Object.entries(symbols)) {
			const symbolName = definition.name ?? name;
			let address;
			try {
				address = native.ffiSymbol(id, symbolName);
			} catch (error) {
				if (definition.optional) {
					table[name] = null;
					continue;
				}
				native.ffiClose(id);
				throw new Error(`Failed to register symbol ${name}: Could not obtain symbol from the library: ${file}: undefined symbol: ${symbolName}`);
			}
			if (definition.type !== undefined) {
				// A static variable: read at each access.
				const type = definition.type;
				const size = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8, usize: 8, isize: 8, pointer: 8 }[type] ?? 8;
				Object.defineProperty(table, name, {
					enumerable: true,
					get() {
						const view = new DataView(native.ffiPeek(address, size));
						switch (type) {
							case "u8": return view.getUint8(0);
							case "i8": return view.getInt8(0);
							case "bool": return view.getUint8(0) !== 0;
							case "u16": return view.getUint16(0, true);
							case "i16": return view.getInt16(0, true);
							case "u32": return view.getUint32(0, true);
							case "i32": return view.getInt32(0, true);
							case "f32": return view.getFloat32(0, true);
							case "f64": return view.getFloat64(0, true);
							case "u64": case "usize": return view.getBigUint64(0, true);
							case "i64": case "isize": return view.getBigInt64(0, true);
							default: return wrap(view.getBigUint64(0, true));
						}
					},
				});
				continue;
			}
			table[name] = makeCaller(address, definition);
		}
		return {
			symbols: table,
			close() {
				native.ffiClose(id);
			},
			[Symbol.dispose]() {
				this.close();
			},
		};
	}

	Deno.dlopen = dlopen;
	Deno.UnsafePointer = UnsafePointer;
	Deno.UnsafePointerView = UnsafePointerView;
	Deno.UnsafeFnPointer = UnsafeFnPointer;
	Deno.UnsafeCallback = UnsafeCallback;
	void isStruct;
})(globalThis);

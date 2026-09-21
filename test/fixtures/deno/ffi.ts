// Deno FFI against the C library: scalar and 64-bit calls, buffers, pointers, callbacks, structs and static data.
const out: string[] = [];
const say = (...a: unknown[]) =>
	out.push(
		a
			.map((x) => (typeof x === "string" ? x : JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))))
			?.join(" ")
	);
const enc = new TextEncoder();
const libc = Deno.dlopen("libc.so.6", {
	strlen: { parameters: ["buffer"], result: "usize" },
	abs: { parameters: ["i32"], result: "i32" },
	labs: { parameters: ["i64"], result: "i64" },
	getenv: { parameters: ["buffer"], result: "pointer" },
	qsort: { parameters: ["buffer", "usize", "usize", "function"], result: "void" },
	toupper: { parameters: ["i32"], result: "i32", nonblocking: true },
	memcpy: { parameters: ["buffer", "buffer", "usize"], result: "pointer" },
	atoi: { parameters: ["buffer"], result: "i32" },
	snprintf: { parameters: ["buffer", "usize", "buffer", "i32", "f64"], result: "i32" },
	div: { parameters: ["i32", "i32"], result: { struct: ["i32", "i32"] } },
	strtoull: { parameters: ["buffer", "pointer", "i32"], result: "u64" },
	bogus: { parameters: [], result: "void", optional: true },
});
const libm = Deno.dlopen("libm.so.6", {
	pow: { parameters: ["f64", "f64"], result: "f64" },
	sqrtf: { parameters: ["f32"], result: "f32" },
	floor: { parameters: ["f64"], result: "f64" },
});
say("strlen", libc.symbols.strlen(enc.encode("hello\0")));
say("abs", libc.symbols.abs(-5), libc.symbols.abs(7));
say("labs", libc.symbols.labs(-5), libc.symbols.labs(-9007199254740993n));
say("math", libm.symbols.pow(2, 10), libm.symbols.sqrtf(2.25), libm.symbols.floor(-1.5));
say(
	"atoi",
	libc.symbols.atoi(enc.encode("  -42xyz\0")),
	libc.symbols.strtoull(enc.encode("18446744073709551615\0"), null, 10)
);
const home = libc.symbols.getenv(enc.encode("PATH\0"));
say("pointer", home !== null, typeof home, Object.keys(home ?? {}), Deno.UnsafePointer.value(home) > 0n);
say("cstring", new Deno.UnsafePointerView(home!).getCString() === Deno.env.get("PATH"));
const cb = new Deno.UnsafeCallback({ parameters: ["pointer", "pointer"], result: "i32" } as const, (a, b) => {
	return new Deno.UnsafePointerView(a!).getInt32() - new Deno.UnsafePointerView(b!).getInt32();
});
const arr = new Int32Array([5, 3, 9, 1, 7, -2]);
libc.symbols.qsort(arr, BigInt(arr.length), 4n, cb.pointer);
say("qsort", Array.from(arr));
cb.close();
const np = libc.symbols.toupper(97);
say("nonblocking", np instanceof Promise, await np);
const dst = new Uint8Array(4);
libc.symbols.memcpy(dst, new Uint8Array([1, 2, 3, 4]), 4n);
say("memcpy", Array.from(dst));
const p = Deno.UnsafePointer.of(dst)!;
say(
	"of",
	Deno.UnsafePointer.equals(p, Deno.UnsafePointer.of(dst)),
	Deno.UnsafePointer.value(Deno.UnsafePointer.offset(p, 2)) - Deno.UnsafePointer.value(p)
);
const words = new Uint32Array([7, 8, 9]); // kept alive: a pointer does not keep its buffer alive
const view = new Deno.UnsafePointerView(Deno.UnsafePointer.of(words)!);
say(
	"view",
	view.getUint32(0),
	view.getUint32(4),
	view.getUint32(8),
	Array.from(new Uint8Array(view.getArrayBuffer(4, 4)))
);
const copy = new Uint8Array(3);
const source = new Uint8Array([10, 20, 30]);
new Deno.UnsafePointerView(Deno.UnsafePointer.of(source)!).copyInto(copy);
say("copyInto", Array.from(copy));
const outBuf = new Uint8Array(32);
libc.symbols.snprintf(outBuf, 32n, enc.encode("n=%d f=%.3f\0"), 42, 1.23456);
say("snprintf", new TextDecoder().decode(outBuf.subarray(0, outBuf.indexOf(0))));
const quot = libc.symbols.div(17, 5) as Uint8Array;
say("struct", Array.from(new Int32Array(quot.buffer, quot.byteOffset, 2)));
say("null", Deno.UnsafePointer.create(0n), Deno.UnsafePointer.value(null), Deno.UnsafePointer.equals(null, null));
say("missing", (libc.symbols as any).nothing, (libc.symbols as any).bogus);
const fp = new Deno.UnsafeFnPointer(
	Deno.UnsafePointer.create(BigInt(Deno.UnsafePointer.value(libc.symbols.getenv(enc.encode("PATH\0"))))),
	{ parameters: [], result: "void" }
);
say("fnpointer", typeof fp.call);
try {
	Deno.dlopen("libc.so.6", { nope_not_there: { parameters: [], result: "void" } });
} catch (e) {
	say("bad symbol", (e as Error).message.startsWith("Failed to register symbol nope_not_there"));
}
try {
	Deno.dlopen("/no/such/library.so", {});
} catch (e) {
	say("bad library", (e as Error).name);
}
say("extra args", libc.symbols.abs(-1, 2 as never));
try {
	(libc.symbols.abs as any)();
} catch (e) {
	say("missing arg", (e as Error).name, (e as Error).message);
}
try {
	(libc.symbols.abs as any)("x");
} catch (e) {
	say("wrong type", (e as Error).message);
}
libm.close();
libc.close();
for (const l of out) console.log(l);

// Hand-assembled modules exercising the WebAssembly API. Output must equal Node's.
const out = [];
const show = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v + "n" : v));
const log = (...a) => out.push(a.map((x) => (typeof x === "bigint" ? x + "n" : typeof x === "string" ? x : show(x))).join(" "));
const leb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
const str = (s) => [s.length, ...Buffer.from(s)];
const vec = (items) => [...leb(items.length), ...items.flat()];
const section = (id, body) => [id, ...leb(body.length), ...body];
const wasm = (...sections) => new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sections.flat()]);
const I32 = 0x7f, I64 = 0x7e, F32 = 0x7d, F64 = 0x7c;
const fn = (params, results) => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];

(async () => {
  // add(i32,i32)->i32, mul(f64,f64)->f64, fact(i64)->i64 (iterative), div(i32,i32)->i32 (traps), unreachable()
  const types = section(1, vec([fn([I32, I32], [I32]), fn([F64, F64], [F64]), fn([I64], [I64]), fn([], []), fn([I32], [])]));
  const funcs = section(3, vec([[0], [1], [2], [0], [3]]));
  const memory = section(5, vec([[1, 1, 2]]));
  const globals = section(6, vec([[I32, 1, 0x41, 7, 0x0b], [I32, 0, 0x41, 42, 0x0b]]));
  const exports = section(7, vec([[...str("add"), 0, 0], [...str("mul"), 0, 1], [...str("fact"), 0, 2], [...str("div"), 0, 3], [...str("boom"), 0, 4], [...str("mem"), 2, 0], [...str("counter"), 3, 0], [...str("answer"), 3, 1]]));
  const body = (code) => [...leb(code.length), ...code];
  const code = section(10, vec([
    body([0, 0x20, 0, 0x20, 1, 0x6a, 0x0b]),
    body([0, 0x20, 0, 0x20, 1, 0xa2, 0x0b]),
    // fact(n): acc = 1; block { loop { if (n <= 1) break; acc *= n; n -= 1; continue } } acc
    body([1, 1, I64, 0x42, 1, 0x21, 1, 0x02, 0x40, 0x03, 0x40, 0x20, 0, 0x42, 1, 0x57, 0x0d, 1, 0x20, 1, 0x20, 0, 0x7e, 0x21, 1, 0x20, 0, 0x42, 1, 0x7d, 0x21, 0, 0x0c, 0, 0x0b, 0x0b, 0x20, 1, 0x0b]),
    body([0, 0x20, 0, 0x20, 1, 0x6d, 0x0b]),
    body([0, 0x00, 0x0b]),
  ]));
  const data = section(11, vec([[0, 0x41, 16, 0x0b, ...vec([...Buffer.from("hello wasm")].map((b) => [b]))]]));
  const bytes = wasm(types, funcs, memory, globals, exports, code, data);

  log("validate", WebAssembly.validate(bytes), WebAssembly.validate(new Uint8Array([1, 2, 3])));
  const mod = await WebAssembly.compile(bytes);
  log("module imports/exports", WebAssembly.Module.imports(mod), WebAssembly.Module.exports(mod).map((e) => e.name + ":" + e.kind));
  const { exports: ex } = await WebAssembly.instantiate(mod, {});
  log("add", ex.add(2, 3), ex.add(2 ** 31 - 1, 1), ex.add("7", 1.9), ex.add.length, typeof ex.add);
  log("mul", ex.mul(1.5, 4), ex.mul(0.1, 3));
  log("fact", ex.fact(5n), ex.fact(20n));
  try { ex.fact(5); } catch (e) { log("fact number", e.name); }
  log("div", ex.div(7, 2), ex.div(-7, 2));
  try { ex.div(1, 0); } catch (e) { log("div0", e.name, e.message, e instanceof WebAssembly.RuntimeError); }
  try { ex.boom(); } catch (e) { log("unreachable", e.name, e.message); }
  const u8 = new Uint8Array(ex.mem.buffer);
  log("memory", ex.mem.buffer.byteLength, Buffer.from(u8.subarray(16, 26)).toString());
  u8[100] = 77;
  log("memory write", new Uint8Array(ex.mem.buffer)[100]);
  const before = ex.mem.buffer;
  log("grow", ex.mem.grow(1), ex.mem.buffer.byteLength, before.byteLength, before === ex.mem.buffer);
  try { ex.mem.grow(5); } catch (e) { log("grow too far", e.name); }
  log("globals", ex.counter.value, ex.answer.value);
  ex.counter.value = 9; log("global set", ex.counter.value);
  try { ex.answer.value = 1; } catch (e) { log("immutable", e.name); }
  log("exports", Object.keys(ex), Object.isFrozen(ex), ex instanceof Object);
  const inst = new WebAssembly.Instance(mod);
  log("instance", inst instanceof WebAssembly.Instance, mod instanceof WebAssembly.Module, inst.exports.add(1, 2));

  // imports: calls back into JavaScript, with i32, i64 and f64
  const impTypes = section(1, vec([fn([I32], [I32]), fn([I64, F64], [F64]), fn([I32], [])]));
  const imports = section(2, vec([[...str("env"), ...str("double"), 0, 0], [...str("env"), ...str("mix"), 0, 1], [...str("env"), ...str("fail"), 0, 2]]));
  const impFuncs = section(3, vec([[0], [1], [2]]));
  const impExports = section(7, vec([[...str("callDouble"), 0, 3], [...str("callMix"), 0, 4], [...str("callFail"), 0, 5]]));
  const impCode = section(10, vec([
    body([0, 0x20, 0, 0x10, 0, 0x0b]),
    body([0, 0x20, 0, 0x20, 1, 0x10, 1, 0x0b]),
    body([0, 0x20, 0, 0x10, 2, 0x0b]),
  ]));
  const imod = wasm(impTypes, imports, impFuncs, impExports, impCode);
  const calls = [];
  const iex = (await WebAssembly.instantiate(imod, { env: { double: (x) => { calls.push(["double", x]); return x * 2; }, mix: (a, b) => { calls.push(["mix", a, b]); return Number(a) + b; }, fail: (x) => { throw new Error("from js " + x); } } })).instance.exports;
  log("import i32", iex.callDouble(21), calls[0]);
  log("import i64/f64", iex.callMix(10n, 0.5), calls[1]);
  try { iex.callFail(5); } catch (e) { log("import throws", e.name, e.message); }
  try { new WebAssembly.Instance(new WebAssembly.Module(imod), {}); } catch (e) { log("missing imports", e.name); }
  try { new WebAssembly.Instance(new WebAssembly.Module(imod), { env: { double: 1, mix() {}, fail() {} } }); } catch (e) { log("not callable", e.name); }
  try { new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0])); } catch (e) { log("bad version", e.name, e instanceof WebAssembly.CompileError); }
  try { await WebAssembly.compile(new Uint8Array([9, 9, 9, 9])); } catch (e) { log("compile rejects", e.name); }
  log("standalone memory", new WebAssembly.Memory({ initial: 2 }).buffer.byteLength, typeof WebAssembly.Global, new WebAssembly.Global({ value: "i32", mutable: true }, 5).value);
  console.log(out.join("\n"));
})().catch((e) => console.log("FAILED", e && e.stack));

// assert: what each assertion throws (name, code, operator, generatedMessage, first message line). Must match Node.js.
const assert = require("assert");
const out = [];
const t = (name, fn) => { try { const r = fn(); out.push([name, "ok"]); } catch (e) { out.push([name, e.name, e.code, e.operator, e.generatedMessage, String(e.message).split("\n")[0]]); } };
t("ok", () => assert.ok(0));
t("ok msg", () => assert(false, "custom"));
t("equal", () => assert.equal(1, "1"));
t("notEqual", () => assert.notEqual(1, 1));
t("strictEqual", () => assert.strictEqual(1, 2));
t("strictEqual obj", () => assert.strictEqual({}, {}));
t("deepStrictEqual", () => assert.deepStrictEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }));
t("deepStrictEqual fail", () => assert.deepStrictEqual({ a: 1 }, { a: 2 }));
t("deepEqual loose", () => assert.deepEqual({ a: 1 }, { a: "1" }));
t("deepStrictEqual proto", () => assert.deepStrictEqual(Object.create(null), {}));
t("map", () => assert.deepStrictEqual(new Map([[1, { a: 1 }]]), new Map([[1, { a: 1 }]])));
t("set", () => assert.deepStrictEqual(new Set([1, { a: 2 }]), new Set([{ a: 2 }, 1])));
t("date", () => assert.deepStrictEqual(new Date(5), new Date(6)));
t("nan", () => assert.deepStrictEqual(NaN, NaN));
t("neg zero", () => assert.deepStrictEqual(0, -0));
t("regexp", () => assert.deepStrictEqual(/a/g, /a/i));
t("typed", () => assert.deepStrictEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])));
t("circular", () => { const a = {}; a.a = a; const b = {}; b.a = b; assert.deepStrictEqual(a, b); });
t("notDeepStrictEqual", () => assert.notDeepStrictEqual({ a: 1 }, { a: 1 }));
t("throws none", () => assert.throws(() => {}));
t("throws class", () => assert.throws(() => { throw new TypeError("x"); }, TypeError));
t("throws wrong class", () => assert.throws(() => { throw new TypeError("x"); }, RangeError));
t("throws regex", () => assert.throws(() => { throw new Error("boom"); }, /boom/));
t("throws regex fail", () => assert.throws(() => { throw new Error("boom"); }, /nope/));
t("throws object", () => assert.throws(() => { throw Object.assign(new Error("m"), { code: "E1" }); }, { message: "m", code: "E1" }));
t("throws object fail", () => assert.throws(() => { throw Object.assign(new Error("m"), { code: "E1" }); }, { code: "E2" }));
t("throws fn", () => assert.throws(() => { throw new Error("m"); }, (e) => e.message === "m"));
t("throws fn false", () => assert.throws(() => { throw new Error("m"); }, () => false));
t("doesNotThrow", () => assert.doesNotThrow(() => { throw new Error("bad"); }));
t("match", () => assert.match("abc", /b/));
t("match fail", () => assert.match("abc", /z/));
t("doesNotMatch", () => assert.doesNotMatch("abc", /b/));
t("ifError", () => assert.ifError(new Error("oops")));
t("ifError ok", () => assert.ifError(null));
t("fail", () => assert.fail());
t("fail msg", () => assert.fail("nope"));
t("partial", () => assert.partialDeepStrictEqual({ a: 1, b: 2 }, { a: 1 }));
t("partial fail", () => assert.partialDeepStrictEqual({ a: 1 }, { a: 2 }));
t("strict", () => assert.strict.equal(1, "1"));
t("AssertionError", () => { throw new assert.AssertionError({ actual: 1, expected: 2, operator: "strictEqual" }); });
(async () => {
  for (const [name, fn] of [
    ["rejects ok", () => assert.rejects(Promise.reject(new Error("r")), /r/)],
    ["rejects none", () => assert.rejects(Promise.resolve(1))],
    ["rejects class", () => assert.rejects(async () => { throw new TypeError("x"); }, RangeError)],
    ["doesNotReject", () => assert.doesNotReject(Promise.reject(new Error("bad")))],
    ["doesNotReject ok", () => assert.doesNotReject(Promise.resolve(1))],
  ]) {
    try { await fn(); out.push([name, "ok"]); } catch (e) { out.push([name, e.name, e.code, e.operator, e.generatedMessage, String(e.message).split("\n")[0]]); }
  }
  const e = new assert.AssertionError({ actual: 1, expected: 2, operator: "strictEqual" });
  out.push(["toString", e.toString().split("\n")[0], e instanceof Error]);
  for (const l of out) console.log(JSON.stringify(l));
})();

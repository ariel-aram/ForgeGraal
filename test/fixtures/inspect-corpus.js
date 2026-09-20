class Animal { constructor() { this.name = "rex"; this.tags = ["a", "b"]; } }
const circ = { name: "c" }; circ.self = circ;
console.log({ a: 1, b: "two", c: [1, 2, 3], d: { e: { f: { g: 1 } } }, fn() {}, arrow: () => 1, sym: Symbol("s"), n: null, u: undefined, big: 10n });
console.log(new Animal(), new Map([["k", { v: 1 }]]), new Set([1, 2]), [undefined, null], Buffer.from("hi"), new Uint8Array(3));
console.log(circ, new Error("boom").message, [1.5, -0, NaN], "str", ["a'b"], new Date(0), /re/g, Promise.resolve(5));
console.log(Array.from({ length: 30 }, (_, i) => i * 3), "x".repeat(100).split("").slice(0, 3));
console.log({ longer: "a".repeat(30), other: "b".repeat(30), third: "c".repeat(30) });
console.log("%s is %d years and %j", "bob", 42, { a: 1 }, "extra", { z: 1 });
console.error("to stderr", { e: 1 });
console.table([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
console.log(class Foo {}, function bar() {}, async () => {}, [class A extends Animal {}]);
console.log([ , 1, , , 2], Object.create(null), { get x() { return 1; }, set y(v) {} }, [[1, [2, [3, [4]]]]]);
const o2 = { users: [{ id: 1, name: "a", roles: ["x", "y"], meta: { created: new Date(0), tags: new Set(["p"]) } }, { id: 2, name: "b" }], nested: { a: { b: { c: { d: 1 } } } }, list: Array.from({ length: 120 }, (_, i) => i) };
console.log(o2);
console.log([["a", 1], ["b", 2]], { "quoted-key": 1, 2: "num" }, [1, 2, 3].map(String), Object.assign(() => {}, { x: 1 }));
console.log(new Error("plain").message, [new Error("in array").message]);
console.log({ und: undefined, nul: null, nan: NaN, inf: -Infinity, str: "it's \"q\"", nl: "a\nb" });

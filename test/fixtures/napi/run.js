const a = require("./addon.node");
const out = {};
out.add = a.add(2, 3.5);
out.greet = a.greet("Graak");
out.obj = a.makeObject();
out.bufferSum = a.bufferSum(Buffer.from([1, 2, 3, 250]));
const mb = a.makeBuffer(); out.makeBuffer = [Buffer.isBuffer(mb), mb.toString("hex")];
out.callBack = a.callBack((n) => n + 1);
try { a.throws(); } catch (e) { out.throws = [e.name, e.code, e.message, e instanceof TypeError]; }
const c = new a.Counter(10); c.inc(); c.inc();
out.counter = [c.value, c instanceof a.Counter, Object.getPrototypeOf(c) === a.Counter.prototype];
out.ref = a.refRoundtrip({ x: 1 });
out.big = String(a.bigDouble(21n));
out.types = [undefined, null, true, 1, "s", Symbol("q"), {}, () => 1, 1n].map(a.typeName).join(",");
let ticks = [];
a.ticks((n) => ticks.push(n), 5);
a.asyncDouble(21).then((v) => {
	out.async = v;
	setTimeout(() => { out.ticks = ticks; console.log(JSON.stringify(out)); }, 100);
});

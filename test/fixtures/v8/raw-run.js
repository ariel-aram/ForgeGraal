const a = require("./raw.node");
const out = {};
out.add = a.add(2, 3.5);
try { a.add("x"); } catch (e) { out.addErr = [e.name, e.message]; }
out.hello = a.hello("Graak");
out.obj = a.makeObject();
out.cb = a.callBack((n) => n + 1);
out.catches = [a.catches(() => { throw new Error("boom"); }), a.catches(() => 7)];
out.bufSum = a.bufSum(Buffer.from([1, 2, 3, 250]));
const b = a.makeBuf(); out.makeBuf = [Buffer.isBuffer(b), b.toString("hex")];
const c = new a.Counter(10); c.inc(); c.inc();
out.counter = [c.value, c instanceof a.Counter];
try { a.Counter(); } catch (e) { out.ctorErr = e.message; }
out.persist = (a.persist({ k: 1 }), a.persist());
out.types = [undefined, null, true, 1, "s", Symbol("q"), {}, () => 1, [], 1n].map(a.typeName).join(",");
console.log(JSON.stringify(out));

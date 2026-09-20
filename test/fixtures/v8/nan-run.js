const a = require("./nan.node");
const out = {};
out.add = a.add(2, 3.5);
try { a.add("x"); } catch (e) { out.addErr = [e.name, e.message]; }
out.hello = a.hello("ForgeGraal");
out.obj = a.makeObject();
out.cb = a.callBack((n) => n + 1);
out.bufSum = a.bufSum(Buffer.from([1, 2, 3, 250]));
const b = a.makeBuf(); out.makeBuf = [Buffer.isBuffer(b), b.toString("hex")];
try { a.throws(); } catch (e) { out.throws = [e.name, e.message]; }
const c = new a.Counter(10); c.inc(); c.inc();
out.counter = [c.value, c instanceof a.Counter];
a.asyncDouble(21, (err, value) => {
	out.async = [err, value];
	setTimeout(() => console.log(JSON.stringify(out)), 50);
});

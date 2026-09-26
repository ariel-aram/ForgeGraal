// Timers: ref/unref, hasRef, refresh, clear and the rule that a process ends when only unref'd timers remain.
// Must print exactly what Node.js prints.
const out = [];
const say = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
const at = (name) => say(name);

const unrefTimeout = setTimeout(() => at("unref'd timeout: never fires"), 1500);
unrefTimeout.unref();
const unrefInterval = setInterval(() => at("unref'd interval: fires while others are alive"), 250);
unrefInterval.unref();
const plain = setTimeout(() => at("plain at 300"), 300);
const reref = setTimeout(() => at("unref then ref at 520"), 520);
reref.unref();
reref.ref();
const shortUnref = setTimeout(() => at("unref'd at 100, fires because 700 outlives it"), 100);
shortUnref.unref();
const last = setTimeout(() => at("last at 700"), 700);
const refreshed = setTimeout(() => at("refreshed: 200 after the refresh at 150"), 200);
setTimeout(() => refreshed.refresh(), 150);
const cleared = setTimeout(() => at("cleared: never"), 400);
clearTimeout(cleared);
const closed = setTimeout(() => at("closed: never"), 400);
closed.close();
say("hasRef", unrefTimeout.hasRef(), plain.hasRef(), reref.hasRef(), last.hasRef());
say("chain", unrefTimeout.unref() === unrefTimeout, unrefTimeout.ref() === unrefTimeout, unrefTimeout.refresh() === unrefTimeout);
unrefTimeout.unref();
say("primitive", typeof plain[Symbol.toPrimitive]());
setImmediate(() => at("immediate"));
process.nextTick(() => at("tick"));
process.on("exit", () => {
	say("exit");
	console.log(out.join("\n"));
});

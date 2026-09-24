// node:test: what a program can observe of the runner (the default reporter's text, the order things run in, mocks,
// timers, hooks, plans, timeouts, the exit code). Must print exactly what Node.js prints, durations and stack frames aside.
const { test, describe, it, suite, before, after, beforeEach, afterEach, mock, getTestContext } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const log = [];
const say = (...a) => log.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));

// The reporter writes to process.stdout as tests finish; keep what it writes and print it, masked, at the end.
let reporterText = "";
const realWrite = process.stdout.write;
process.stdout.write = function (chunk) {
	reporterText += String(chunk);
	return true;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- plain tests -------------------------------------------------------------------------------------------------
test("passes", () => {});
test("passes async", async () => {
	await sleep(1);
});
test("fails with an error", () => {
	throw new Error("boom");
});
test("fails an assertion", () => {
	assert.strictEqual(1, 2);
});
test("fails an assertion with a message", () => {
	assert.equal("a", "b", "custom message");
});
test("fails a deep assertion", () => {
	assert.deepStrictEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] });
});
test("fails with a string", () => {
	throw "just a string";
});
test("fails with an object", () => {
	throw { code: 7 };
});
test("rejects", async () => {
	await Promise.reject(new TypeError("bad type"));
});
test("error with properties", () => {
	throw Object.assign(new RangeError("out"), { code: "E_OUT", extra: [1, 2] });
});
test(function namedFunction() {});
test(() => {});
test("name given in options", { skip: false }, () => {});

// ---- skip, todo ----------------------------------------------------------------------------------------------------
test("skip option", { skip: true }, () => say("never"));
test("skip with reason", { skip: "not today" }, () => say("never"));
test("todo option", { todo: true }, () => {});
test("todo with reason that fails", { todo: "someday" }, () => {
	throw new Error("expected while todo");
});
test.skip("test.skip", () => say("never"));
test.todo("test.todo", () => {});
test("skip from inside", (t) => {
	t.skip("skipped inside");
	say("t.skip keeps running the body", t.name);
});
test("todo from inside", (t) => {
	t.todo("todo inside");
});
test("weird \\ names # with\ttabs", () => {});

// ---- subtests --------------------------------------------------------------------------------------------------------
test("subtests", async (t) => {
	await t.test("first", () => {});
	await t.test("second", async (t2) => {
		await t2.test("deep", () => {});
		t2.diagnostic("diagnostic in second");
	});
	const results = [];
	for (const n of [1, 2, 3]) {
		results.push(await t.test(`item ${n}`, { skip: n === 2 && "no two" }, () => {}));
	}
	say("subtest results", results);
	t.diagnostic("diagnostic in subtests");
	say("names", t.name, t.fullName);
});
test("failing subtest fails the parent", async (t) => {
	await t.test("bad child", () => {
		throw new Error("child failed");
	});
	await t.test("good child", () => {});
});
test("subtests not awaited are waited for", (t) => {
	t.test("late a", async () => {
		await sleep(10);
		say("late a done");
	});
	t.test("late b", async () => {
		await sleep(2);
		say("late b done");
	});
});
test("t.plan passes", (t) => {
	t.plan(2);
	t.assert.ok(true);
	t.assert.strictEqual(1, 1);
});
test("t.plan too few", (t) => {
	t.plan(3);
	t.assert.ok(true);
});
test("t.plan counts subtests", async (t) => {
	t.plan(2);
	await t.test("one", () => {});
	await t.test("two", () => {});
});
test("t.plan wait", async (t) => {
	t.plan(1, { wait: 200 });
	setTimeout(() => t.assert.ok(true), 5);
});
test("t.plan option", { plan: 1 }, (t) => {
	t.assert.equal(1, 1);
});
test("t.plan twice", (t) => {
	t.plan(1);
	t.plan(1);
});
test("t.assert methods", (t) => {
	t.assert.deepStrictEqual({ a: [1, 2] }, { a: [1, 2] });
	t.assert.notStrictEqual(1, 2);
	t.assert.throws(() => {
		throw new Error("x");
	}, /x/);
	t.assert.match("abc", /b/);
	say("assert keys", Object.keys(t.assert).sort());
});
test("t.assert failing message is the assertion's", (t) => {
	try {
		t.assert.strictEqual(1, 2);
	} catch (err) {
		say("assert failure", err.name, err.code, err.message.split("\n")[0]);
	}
});
test("t.signal aborts after the test", async (t) => {
	say("signal at start", t.signal.aborted);
	t.after(() => say("signal in after hook", t.signal.aborted));
});
test("waitFor", async (t) => {
	let n = 0;
	const value = await t.waitFor(
		() => {
			if (++n < 3) throw new Error("not yet");
			return n;
		},
		{ interval: 1, timeout: 500 }
	);
	say("waitFor", value);
	await t.waitFor(() => Promise.reject(new Error("never")), { interval: 1, timeout: 20 }).catch((err) => {
		say("waitFor timeout", err.message, err.cause.message);
	});
});
test("callback style", (t, done) => {
	setTimeout(done, 1);
});
test("callback style failing", (t, done) => {
	setTimeout(() => done(new Error("callback error")), 1);
});
test("callback and promise", (t, done) => {
	done();
	return Promise.resolve();
});
test("expectFailure", { expectFailure: true }, () => {
	throw new Error("expected");
});
test("expectFailure passes unexpectedly", { expectFailure: "known bug" }, () => {});
test("getTestContext", (t) => {
	say("getTestContext", getTestContext() === t, typeof getTestContext);
});

// ---- timeouts ------------------------------------------------------------------------------------------------------
test("times out", { timeout: 15 }, async (t) => {
	t.signal.addEventListener("abort", () => say("signal aborted by the timeout", t.signal.aborted));
	await sleep(300);
});
test("times out with a callback", { timeout: 15 }, (t, done) => {});
test("timeout is not hit", { timeout: 500 }, async () => {
	await sleep(1);
});

// ---- suites and hooks -------------------------------------------------------------------------------------------------
const order = [];
describe("outer suite", () => {
	before(() => order.push("outer before"));
	after(() => order.push("outer after"));
	beforeEach(() => order.push("outer beforeEach"));
	afterEach(() => order.push("outer afterEach"));
	it("first", () => order.push("first"));
	describe("inner suite", () => {
		before(() => order.push("inner before"));
		after(() => order.push("inner after"));
		beforeEach(() => order.push("inner beforeEach"));
		afterEach(() => order.push("inner afterEach"));
		it("second", () => order.push("second"));
		it("third", async (t) => {
			order.push("third");
			t.beforeEach(() => order.push("t.beforeEach (only for subtests)"));
			t.afterEach(() => order.push("t.afterEach one"));
			t.afterEach(() => order.push("t.afterEach two"));
			await t.test("subtest of third", () => order.push("subtest of third"));
		});
	});
	it.skip("skipped in suite", () => order.push("never"));
	it("fourth", () => order.push("fourth"));
});
describe("suite with a failing test and hooks", () => {
	afterEach((t) => {
		order.push(`afterEach saw passed=${t.passed} error=${t.error ? "yes" : "no"}`);
	});
	it("fails", () => {
		throw new Error("in suite");
	});
	it("passes", () => {});
});
describe("suite whose before hook fails", () => {
	before(() => {
		throw new Error("before hook failed");
	});
	it("is cancelled", () => order.push("never"));
});
describe("suite whose afterEach hook fails", () => {
	afterEach(() => {
		throw new Error("afterEach hook failed");
	});
	it("has a failing hook", () => {});
});
describe("suite with an async describe body", async () => {
	await sleep(1);
	it("declared before the await ends", () => {});
});
describe.skip("skipped suite", () => {
	it("never runs", () => order.push("never"));
});
describe.todo("todo suite", () => {
	it("runs but does not count", () => {});
});
describe("suite with a throwing body", () => {
	throw new Error("describe body threw");
});
suite("suite alias", () => {
	it("alias works", () => {});
});
describe("suite context", function (s) {
	order.push(`suite context name=${s.name} fullName=${s.fullName} signal=${typeof s.signal}`);
	it("checks names", (t) => order.push(`t.fullName=${t.fullName}`));
});

// ---- more contexts ----------------------------------------------------------------------------------------------------
test("uncaught exception in the running test", async () => {
	setTimeout(() => {
		throw new Error("thrown in a timer");
	}, 1);
	await sleep(15);
});
test("signal option cancels the test", async (t) => {
	const ac = new AbortController();
	await t.test("aborted from outside", { signal: ac.signal }, async () => {
		setTimeout(() => ac.abort(new Error("cancelled from outside")), 3);
		await sleep(200);
	});
});
test("hooks of a test", async (t) => {
	t.after(() => {
		order.push("t.after runs");
	});
	t.after(() => {
		throw new Error("t.after failed");
	});
	t.before(() => order.push("t.before runs late"));
	order.push("body");
});
test("test returning a value", () => 42);
test("t.runOnly", async (t) => {
	t.runOnly(true);
	await t.test("not selected", () => order.push("never"));
	await t.test("selected", { only: true }, () => {});
});
describe("suite options", { skip: "whole suite skipped" }, () => {
	it("skipped through the suite", () => order.push("never"));
});
describe("todo through an option", { todo: true }, () => {
	it("child", () => {
		throw new Error("todo child failed");
	});
});
describe("nested async suites", async () => {
	await sleep(1);
	describe("inner after await", () => {
		it("inner test", () => {});
	});
	it("outer after await", () => {});
});
describe("suite with a timeout", { timeout: 20 }, () => {
	it("hangs", async () => {
		await sleep(300);
	});
});
describe("suite diagnostics", (s) => {
	s.diagnostic("diagnostic in a suite");
	it("child", () => {});
});
before(() => order.push("root before"));
after(() => order.push("root after"));

// ---- concurrency ---------------------------------------------------------------------------------------------------------
const started = [];
test("sequential by default", async (t) => {
	await Promise.all([
		t.test("s1", async () => {
			started.push("s1 start");
			await sleep(10);
			started.push("s1 end");
		}),
		t.test("s2", async () => {
			started.push("s2 start");
			await sleep(1);
			started.push("s2 end");
		}),
	]);
	say("sequential", started.splice(0));
});
test("concurrent subtests", { concurrency: true }, async (t) => {
	await Promise.all([
		t.test("c1", async () => {
			started.push("c1 start");
			await sleep(20);
			started.push("c1 end");
		}),
		t.test("c2", async () => {
			started.push("c2 start");
			await sleep(2);
			started.push("c2 end");
		}),
	]);
	say("concurrent", started.splice(0));
});
test("concurrency of 2", { concurrency: 2 }, async (t) => {
	const running = { now: 0, max: 0 };
	const work = async () => {
		running.max = Math.max(running.max, ++running.now);
		await sleep(3);
		running.now--;
	};
	await Promise.all([1, 2, 3, 4].map((n) => t.test(`w${n}`, work)));
	say("max running", running.max);
});

// ---- mocks --------------------------------------------------------------------------------------------------------------
test("mock.fn", (t) => {
	const fn = t.mock.fn((a, b) => a + b);
	say("fn", fn(1, 2), fn(3, 4), fn.mock.callCount());
	say("calls", fn.mock.calls.map((c) => ({ arguments: c.arguments, result: c.result, error: c.error, this: c.this === undefined })));
	fn.mock.mockImplementationOnce(() => "once");
	say("once", fn(1, 1), fn(1, 1));
	fn.mock.mockImplementation(() => "swapped");
	say("swapped", fn());
	fn.mock.resetCalls();
	say("after reset", fn.mock.callCount());
	const throwing = t.mock.fn(() => {
		throw new Error("mock threw");
	});
	try {
		throwing();
	} catch {}
	say("error recorded", throwing.mock.calls[0].error.message, throwing.mock.calls[0].result);
	const times = t.mock.fn(() => "mocked", () => "original", { times: 1 });
	say("times", times(), times());
	const bare = t.mock.fn();
	say("bare", bare(), bare.mock.callCount());
	class Thing {
		constructor(x) {
			this.x = x;
		}
	}
	const Mocked = t.mock.fn(Thing);
	const made = new Mocked(5);
	say("construct", made.x, Mocked.mock.calls[0].target === Thing, made instanceof Thing);
	say("mock keys", Object.keys(fn.mock), typeof fn.mock.calls);
});
test("mock.method", (t) => {
	const obj = {
		value: 1,
		add(n) {
			return this.value + n;
		},
	};
	const method = t.mock.method(obj, "add");
	say("spy", obj.add(2), method.mock.callCount(), method.mock.calls[0].this === obj);
	t.mock.method(obj, "add", (n) => n * 10);
	say("replaced", obj.add(2));
	obj.add.mock.restore();
	say("restored", obj.add(2), obj.add.mock === undefined);
	t.mock.method(obj, "add", () => 0, { times: 2 });
	say("times", obj.add(), obj.add(), obj.add(1));
	try {
		t.mock.method(obj, "missing");
	} catch (err) {
		say("missing method", err.code, err.message);
	}
	t.mock.method(Math, "random", () => 0.5);
	say("Math.random", Math.random());
});
test("mock.getter and mock.setter", (t) => {
	const obj = {
		_v: 1,
		get v() {
			return this._v;
		},
		set v(x) {
			this._v = x;
		},
	};
	const getter = t.mock.getter(obj, "v", () => 42);
	say("getter", obj.v, getter.mock.callCount());
	const setter = t.mock.setter(obj, "v", (x) => {
		obj._v = x * 2;
	});
	obj.v = 5;
	say("setter", obj._v, setter.mock.callCount(), setter.mock.calls[0].arguments);
	getter.mock.restore();
	say("getter restored", obj.v);
});
test("mock.property", (t) => {
	const obj = { a: 1 };
	const prop = t.mock.property(obj, "a", 5);
	say("property", obj.a, prop.a);
	obj.a = 9;
	say("set", obj.a, prop.mock.accessCount(), prop.mock.accesses.map((x) => [x.type, x.value]));
	prop.mock.mockImplementationOnce(100);
	say("once", obj.a, obj.a);
	prop.mock.restore();
	say("restored", obj.a);
});
test("t.mock is restored after the test", async (t) => {
	const target = { f: () => "original" };
	await t.test("mocks inside a subtest", (t2) => {
		t2.mock.method(target, "f", () => "mocked");
		say("inside", target.f());
	});
	say("after subtest", target.f());
});
test("mock.reset and restoreAll", () => {
	const o = { f: () => 1 };
	mock.method(o, "f", () => 2);
	say("before", o.f());
	mock.restoreAll();
	say("restoreAll", o.f());
	mock.method(o, "f", () => 3);
	mock.reset();
	say("reset", o.f());
});
test("mock.timers", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
	const calls = [];
	setTimeout((...args) => calls.push(["timeout", ...args]), 100, "a", "b");
	const interval = setInterval(() => calls.push(["interval", Date.now()]), 30);
	const cleared = setTimeout(() => calls.push(["cleared"]), 10);
	clearTimeout(cleared);
	say("before tick", calls.length, Date.now());
	t.mock.timers.tick(29);
	say("tick 29", calls.length);
	t.mock.timers.tick(1);
	say("tick 30", JSON.stringify(calls));
	t.mock.timers.tick(100);
	clearInterval(interval);
	say("tick 130", JSON.stringify(calls), Date.now(), new Date().getTime());
	setTimeout(() => calls.push("late"), 500);
	t.mock.timers.runAll();
	say("runAll", calls.at(-1), Date.now());
	t.mock.timers.setTime(50);
	say("setTime", Date.now());
	const timersPromises = require("node:timers/promises");
	const promised = timersPromises.setTimeout(10, "resolved value");
	t.mock.timers.tick(10);
	say("timers/promises", await promised);
	t.mock.timers.reset();
	say("after reset", Date.now() > 1e12, typeof setTimeout(() => {}, 0).unref);
	try {
		t.mock.timers.tick(1);
	} catch (err) {
		say("tick when disabled", err.code, err.message);
	}
});
test("mock.timers setImmediate", (t) => {
	t.mock.timers.enable({ apis: ["setImmediate"] });
	const calls = [];
	setImmediate(() => calls.push("immediate"));
	t.mock.timers.tick(0);
	say("setImmediate", calls);
	try {
		t.mock.timers.enable({ apis: ["nope"] });
	} catch (err) {
		say("bad api", err.code);
	}
});

// ---- argument validation ---------------------------------------------------------------------------------------------
test("argument validation", async (t) => {
	const attempt = async (label, fn) => {
		try {
			await fn();
			say(label, "no error");
		} catch (err) {
			say(label, err.name, err.code, err.message);
		}
	};
	await attempt("timeout -1", () => t.test("x", { timeout: -1 }, () => {}));
	await attempt("timeout string", () => t.test("x", { timeout: "soon" }, () => {}));
	await attempt("concurrency string", () => t.test("x", { concurrency: "many" }, () => {}));
	await attempt("signal", () => t.test("x", { signal: {} }, () => {}));
	await attempt("mock.fn(1)", () => t.mock.fn(1, 2));
	await attempt("mock.method(1)", () => t.mock.method(1, "x"));
	await attempt("plan string", () => t.plan("x"));
	await attempt("waitFor", () => t.waitFor(1));
});

// ---- the end ------------------------------------------------------------------------------------------------------------
process.on("exit", (code) => {
	process.stdout.write = realWrite;
	const clean = reporterText
		.replace(/\(\d+(?:\.\d+)?ms\)/g, "(<ms>)")
		.replace(/duration_ms \d+(?:\.\d+)?/g, "duration_ms <ms>")
		.replace(/^ *at .*\n/gm, "")
		.replace(/^test at .*$/gm, "test at <location>")
		.split(path.dirname(__filename))
		.join("<dir>");
	console.log(clean);
	console.log("--- program side");
	say("order", order);
	say("exit code", code, process.exitCode);
	for (const line of log) console.log(line);
	process.exitCode = 0;
});

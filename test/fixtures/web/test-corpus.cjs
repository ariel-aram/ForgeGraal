// node:test and node:test/reporters differential corpus. Must print exactly what Node.js prints.
const test = require("node:test");
const { describe, it, before, after, beforeEach, afterEach } = test;
const assert = require("node:assert");

test("sync test", () => {
	assert.equal(1 + 1, 2);
});

test("async test", async () => {
	await new Promise((r) => setTimeout(r, 5));
	assert.ok(true);
});

test("callback test", (t, done) => {
	setTimeout(() => {
		assert.ok(true);
		done();
	}, 5);
});

test("parent test", async (t) => {
	t.diagnostic("sample diagnostic");
	assert.equal(t.name, "parent test");
	await t.test("child subtest", (st) => {
		assert.equal(st.name, "child subtest");
	});
});

test.skip("skipped test", () => {});
test.todo("todo test", () => {});
test("skip option", { skip: "skipped reason" }, () => {});
test("todo option", { todo: "todo reason" }, () => {});

test("context mock.fn", (t) => {
	const fn = t.mock.fn((x) => x * 3);
	assert.equal(fn(4), 12);
	assert.equal(fn.mock.callCount(), 1);
	assert.deepEqual(fn.mock.calls[0].arguments, [4]);
	fn.mock.mockImplementationOnce((x) => x + 10);
	assert.equal(fn(4), 14);
	assert.equal(fn(4), 12);
});

test("context mock.method", (t) => {
	const target = {
		count: 0,
		inc(n) {
			this.count += n;
			return this.count;
		},
	};
	const spy = t.mock.method(target, "inc");
	assert.equal(target.inc(5), 5);
	assert.equal(spy.mock.callCount(), 1);
});

test("mock.timers", (t) => {
	t.mock.timers.enable();
	let ticks = 0;
	setInterval(() => {
		ticks++;
	}, 50);
	t.mock.timers.tick(150);
	assert.equal(ticks, 3);
	t.mock.timers.reset();
});

describe("suite with hooks", () => {
	const order = [];
	before(() => {
		order.push("before");
	});
	beforeEach(() => {
		order.push("beforeEach");
	});
	afterEach(() => {
		order.push("afterEach");
	});
	after(() => {
		order.push("after");
	});

	it("suite test 1", () => {
		assert.deepEqual(order, ["before", "beforeEach"]);
	});

	it("suite test 2", () => {
		assert.deepEqual(order, ["before", "beforeEach", "afterEach", "beforeEach"]);
	});

	describe("nested suite", () => {
		it("nested test", () => {
			assert.ok(true);
		});
	});
});

test("runner exports and reporters", () => {
	const testModule = require("node:test");
	const reporters = require("node:test/reporters");
	assert.equal(typeof testModule, "function");
	assert.equal(typeof testModule.test, "function");
	assert.equal(typeof testModule.it, "function");
	assert.equal(typeof testModule.describe, "function");
	assert.equal(typeof testModule.suite, "function");
	assert.equal(typeof testModule.before, "function");
	assert.equal(typeof testModule.after, "function");
	assert.equal(typeof testModule.beforeEach, "function");
	assert.equal(typeof testModule.afterEach, "function");
	assert.equal(typeof testModule.mock, "object");
	assert.equal(typeof testModule.run, "function");
	assert.equal(typeof reporters.spec, "function");
	assert.equal(typeof reporters.tap, "function");
	assert.equal(typeof reporters.dot, "function");
	assert.equal(typeof reporters.junit, "function");
	assert.equal(typeof reporters.lcov, "function");
});

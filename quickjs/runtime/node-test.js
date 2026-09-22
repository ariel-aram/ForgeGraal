/*
 * `node:test` and `node:test/reporters` for the Graak native host.
 *
 * Implements the Node.js test runner API (test, it, describe, suite, before, after,
 * beforeEach, afterEach, mock, and reporters) matching Node.js 26.9.0's output format.
 */

function createTestModule({ process, EventEmitter, CallableStream, Buffer }) {
	const Readable = CallableStream.Readable;
	const Transform = CallableStream.Transform;

	const now = () => Number(process.hrtime.bigint()) / 1e6;

	// ---- Mock subsystem --------------------------------------------------------

	const activeMockMethods = [];
	let timersMockActive = false;
	let originalTimers = null;
	let mockTime = 0;
	let mockTimerId = 1;
	let mockTimersQueue = [];

	function createMockFn(original, implementation) {
		let impl = implementation ?? original ?? (() => {});
		const calls = [];
		const fn = function (...args) {
			const callRecord = {
				arguments: args,
				this: this,
				target: fn,
				result: undefined,
				error: undefined,
			};
			calls.push(callRecord);
			try {
				const res = impl.apply(this, args);
				callRecord.result = res;
				return res;
			} catch (err) {
				callRecord.error = err;
				throw err;
			}
		};
		fn.mock = {
			calls,
			callCount: () => calls.length,
			resetCalls: () => {
				calls.length = 0;
			},
			mockImplementation: (newImpl) => {
				impl = newImpl;
			},
			mockImplementationOnce: (newImpl, onCall) => {
				const prev = impl;
				let count = 0;
				impl = function (...args) {
					if (onCall === undefined || count === onCall) {
						impl = prev;
						return newImpl.apply(this, args);
					}
					count++;
					return prev.apply(this, args);
				};
			},
			restore: () => {
				impl = original ?? (() => {});
			},
		};
		return fn;
	}

	function mockMethod(object, methodName, implementation) {
		if (!object || (typeof object !== "object" && typeof object !== "function")) {
			throw new TypeError("The 'object' argument must be an object");
		}
		const original = object[methodName];
		const mocked = createMockFn(original, implementation);
		mocked.mock.restore = () => {
			object[methodName] = original;
			const idx = activeMockMethods.indexOf(mocked);
			if (idx !== -1) activeMockMethods.splice(idx, 1);
		};
		object[methodName] = mocked;
		activeMockMethods.push(mocked);
		return mocked;
	}

	const mockTimers = {
		enable(options) {
			if (timersMockActive) return;
			timersMockActive = true;
			mockTime = Date.now();
			mockTimersQueue = [];
			originalTimers = {
				setTimeout: globalThis.setTimeout,
				clearTimeout: globalThis.clearTimeout,
				setInterval: globalThis.setInterval,
				clearInterval: globalThis.clearInterval,
				Date: globalThis.Date,
			};

			globalThis.setTimeout = (fn, delay = 0, ...args) => {
				const id = mockTimerId++;
				mockTimersQueue.push({
					id,
					fn,
					args,
					due: mockTime + Math.max(0, delay),
					interval: 0,
				});
				mockTimersQueue.sort((a, b) => a.due - b.due);
				return id;
			};
			globalThis.clearTimeout = (id) => {
				mockTimersQueue = mockTimersQueue.filter((t) => t.id !== id);
			};
			globalThis.setInterval = (fn, delay = 0, ...args) => {
				const id = mockTimerId++;
				const step = Math.max(1, delay);
				mockTimersQueue.push({
					id,
					fn,
					args,
					due: mockTime + step,
					interval: step,
				});
				mockTimersQueue.sort((a, b) => a.due - b.due);
				return id;
			};
			globalThis.clearInterval = globalThis.clearTimeout;
		},
		reset() {
			if (!timersMockActive) return;
			timersMockActive = false;
			mockTimersQueue = [];
			if (originalTimers) {
				globalThis.setTimeout = originalTimers.setTimeout;
				globalThis.clearTimeout = originalTimers.clearTimeout;
				globalThis.setInterval = originalTimers.setInterval;
				globalThis.clearInterval = originalTimers.clearInterval;
				globalThis.Date = originalTimers.Date;
				originalTimers = null;
			}
		},
		tick(ms = 1) {
			const target = mockTime + ms;
			while (mockTimersQueue.length > 0 && mockTimersQueue[0].due <= target) {
				const timer = mockTimersQueue.shift();
				mockTime = timer.due;
				try {
					timer.fn(...timer.args);
				} catch (err) {
					// Timers errors in mock
				}
				if (timer.interval > 0) {
					timer.due = mockTime + timer.interval;
					mockTimersQueue.push(timer);
					mockTimersQueue.sort((a, b) => a.due - b.due);
				}
			}
			mockTime = target;
		},
		setTime(ms) {
			mockTime = ms;
		},
		runAll() {
			while (mockTimersQueue.length > 0) {
				const timer = mockTimersQueue.shift();
				mockTime = timer.due;
				try {
					timer.fn(...timer.args);
				} catch {
					// Ignore
				}
			}
		},
	};

	const mock = {
		fn: createMockFn,
		method: mockMethod,
		timers: mockTimers,
		reset() {
			this.restoreAll();
		},
		restoreAll() {
			while (activeMockMethods.length > 0) {
				activeMockMethods.pop().mock.restore();
			}
			mockTimers.reset();
		},
	};

	// ---- Test Node and Tree ----------------------------------------------------

	class TestNode {
		constructor({ name, fn, options = {}, isSuite = false, parent = null, location = "" }) {
			this.name = name;
			this.fn = fn;
			this.options = options;
			this.isSuite = isSuite;
			this.parent = parent;
			this.location = location;
			this.children = [];
			this.beforeHooks = [];
			this.afterHooks = [];
			this.beforeEachHooks = [];
			this.afterEachHooks = [];
			this.diagnostics = [];
			this.status = null; // 'pass' | 'fail' | 'skipped' | 'todo' | 'cancelled'
			this.error = null;
			this.duration = 0;
			this.skipReason = options.skip ? (typeof options.skip === "string" ? options.skip : "SKIP") : null;
			this.todoReason = options.todo ? (typeof options.todo === "string" ? options.todo : "TODO") : null;
			this.only = Boolean(options.only);
		}
	}

	const rootSuite = new TestNode({ name: "<root>", isSuite: true });
	let currentSuite = rootSuite;
	let hasScheduledRun = false;
	let autoRunDisabled = false;

	function normalizeArgs(kind, args) {
		let name = "";
		let options = {};
		let fn = null;

		if (args.length === 1) {
			if (typeof args[0] === "string") name = args[0];
			else if (typeof args[0] === "function") fn = args[0];
			else if (args[0] && typeof args[0] === "object") options = args[0];
		} else if (args.length === 2) {
			if (typeof args[0] === "string") {
				name = args[0];
				if (typeof args[1] === "function") fn = args[1];
				else if (args[1] && typeof args[1] === "object") options = args[1];
			} else if (typeof args[0] === "object") {
				options = args[0] ?? {};
				if (typeof args[1] === "function") fn = args[1];
			}
		} else if (args.length >= 3) {
			name = String(args[0] ?? "");
			options = args[1] ?? {};
			fn = args[2];
		}

		if (!name && typeof fn === "function" && fn.name) {
			name = fn.name;
		}
		if (!name) name = "<anonymous>";
		return { name, options, fn: fn ?? (() => {}) };
	}

	function getLocation() {
		try {
			const err = new Error();
			const lines = (err.stack || "").split("\n");
			for (let i = 2; i < lines.length; i++) {
				const line = lines[i];
				if (!line.includes("node-test.js") && !line.includes("node:test")) {
					const m = /at\s+(?:.*?\s+)?\(?([^():]+:\d+:\d+)\)?/.exec(line);
					if (m) return m[1];
				}
			}
		} catch {
			// Ignore stack parse errors
		}
		return "";
	}

	function registerTest(args, extraOptions = {}) {
		const { name, options, fn } = normalizeArgs("test", args);
		const node = new TestNode({
			name,
			fn,
			options: { ...options, ...extraOptions },
			isSuite: false,
			parent: currentSuite,
			location: getLocation(),
		});
		currentSuite.children.push(node);
		scheduleAutoRun();
		return node;
	}

	function registerSuite(args, extraOptions = {}) {
		const { name, options, fn } = normalizeArgs("describe", args);
		const node = new TestNode({
			name,
			fn,
			options: { ...options, ...extraOptions },
			isSuite: true,
			parent: currentSuite,
			location: getLocation(),
		});
		currentSuite.children.push(node);

		const prev = currentSuite;
		currentSuite = node;
		try {
			if (typeof fn === "function") fn();
		} finally {
			currentSuite = prev;
		}
		scheduleAutoRun();
		return node;
	}

	function test(...args) {
		return registerTest(args);
	}
	test.test = test;
	test.it = test;
	test.describe = describe;
	test.suite = describe;
	test.before = before;
	test.after = after;
	test.beforeEach = beforeEach;
	test.afterEach = afterEach;
	test.mock = mock;
	test.run = run;
	test.skip = (...args) => registerTest(args, { skip: true });
	test.todo = (...args) => registerTest(args, { todo: true });
	test.only = (...args) => registerTest(args, { only: true });
	test.getTestContext = () => null;
	test.snapshot = () => {};
	test.expectFailure = () => {};
	test.assert = { register: () => {} };

	function describe(...args) {
		return registerSuite(args);
	}
	describe.describe = describe;
	describe.suite = describe;
	describe.skip = (...args) => registerSuite(args, { skip: true });
	describe.todo = (...args) => registerSuite(args, { todo: true });
	describe.only = (...args) => registerSuite(args, { only: true });
	describe.expectFailure = () => {};

	function before(fn) {
		currentSuite.beforeHooks.push(fn);
	}
	function after(fn) {
		currentSuite.afterHooks.push(fn);
	}
	function beforeEach(fn) {
		currentSuite.beforeEachHooks.push(fn);
	}
	function afterEach(fn) {
		currentSuite.afterEachHooks.push(fn);
	}

	async function executeHook(hook, context) {
		if (hook.length >= 2) {
			await new Promise((resolve, reject) => {
				let settled = false;
				const done = (err) => {
					if (settled) return;
					settled = true;
					if (err) reject(err);
					else resolve();
				};
				try {
					const res = hook(context, done);
					if (res && typeof res.then === "function") {
						res.then(() => done(), done);
					}
				} catch (err) {
					done(err);
				}
			});
		} else {
			const res = hook(context);
			if (res && typeof res.then === "function") {
				await res;
			}
		}
	}

	// ---- Execution & Reporter --------------------------------------------------

	function collectBeforeEach(node) {
		const hooks = [];
		let curr = node.parent;
		while (curr) {
			if (curr.beforeEachHooks.length > 0) hooks.unshift(...curr.beforeEachHooks);
			curr = curr.parent;
		}
		return hooks;
	}

	function collectAfterEach(node) {
		const hooks = [];
		let curr = node.parent;
		while (curr) {
			if (curr.afterEachHooks.length > 0) hooks.push(...curr.afterEachHooks);
			curr = curr.parent;
		}
		return hooks;
	}

	function hasOnly(node) {
		if (node.only) return true;
		for (const child of node.children) {
			if (hasOnly(child)) return true;
		}
		return false;
	}

	function formatDuration(ms) {
		return `${ms.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}ms`;
	}

	class TestContext {
		constructor(node, emitter, onSubtest) {
			this.name = node.name;
			this.signal = undefined;
			this._node = node;
			this._emitter = emitter;
			this._onSubtest = onSubtest;
			this._scopedMocks = [];
			this.mock = {
				fn: (...args) => {
					const f = createMockFn(...args);
					this._scopedMocks.push(f);
					return f;
				},
				method: (...args) => {
					const m = mockMethod(...args);
					this._scopedMocks.push(m);
					return m;
				},
				timers: mockTimers,
				reset() {
					this.restoreAll();
				},
				restoreAll: () => {
					while (this._scopedMocks.length > 0) {
						this._scopedMocks.pop().mock.restore();
					}
				},
			};
		}
		diagnostic(message) {
			this._node.diagnostics.push(message);
			if (this._emitter) this._emitter.emit("test:diagnostic", { message, nesting: getDepth(this._node) });
		}
		skip(reason) {
			this._node.skipReason = typeof reason === "string" ? reason : "SKIP";
			this._node.status = "skipped";
		}
		todo(reason) {
			this._node.todoReason = typeof reason === "string" ? reason : "TODO";
			this._node.status = "todo";
		}
		async test(...args) {
			const { name, options, fn } = normalizeArgs("test", args);
			const subNode = new TestNode({
				name,
				options,
				fn,
				isSuite: false,
				parent: this._node,
				location: getLocation(),
			});
			this._node.children.push(subNode);
			if (this._onSubtest) {
				return await this._onSubtest(subNode);
			}
		}
		before(fn) {
			this._node.beforeHooks.push(fn);
		}
		after(fn) {
			this._node.afterHooks.push(fn);
		}
		beforeEach(fn) {
			this._node.beforeEachHooks.push(fn);
		}
		afterEach(fn) {
			this._node.afterEachHooks.push(fn);
		}
	}

	function getDepth(node) {
		let d = 0;
		let curr = node.parent;
		while (curr && curr !== rootSuite) {
			d++;
			curr = curr.parent;
		}
		return d;
	}

	async function runNode(node, state, emitter) {
		const depth = getDepth(node);
		const indent = "  ".repeat(depth);

		if (state.onlyMode && !node.only && !hasOnly(node) && node !== rootSuite) {
			node.status = "skipped";
			node.skipReason = "SKIP";
			state.counts.skipped++;
			state.counts.tests++;
			return;
		}

		if (node.isSuite) {
			state.counts.suites++;
			// Suite header
			if (node !== rootSuite) {
				state.out(`${indent}▶ ${node.name}\n`);
			}

			const start = now();
			let suiteError = null;

			// Run before hooks
			for (const hook of node.beforeHooks) {
				try {
					await executeHook(hook, null);
				} catch (err) {
					suiteError = err;
					break;
				}
			}

			if (!suiteError) {
				for (const child of node.children) {
					await runNode(child, state, emitter);
				}
			} else {
				node.status = "fail";
				node.error = suiteError;
				state.failures.push(node);
			}

			// Run after hooks
			for (const hook of node.afterHooks) {
				try {
					await executeHook(hook, null);
				} catch (err) {
					if (!suiteError) {
						node.status = "fail";
						node.error = err;
						state.failures.push(node);
					}
				}
			}

			node.duration = now() - start;

			// Check if any child failed
			const childFailed = node.children.some((c) => c.status === "fail");
			if (childFailed && !node.status) {
				node.status = "fail";
			} else if (!node.status) {
				node.status = "pass";
			}

			if (node !== rootSuite) {
				const sym = node.status === "pass" ? "✔" : "✖";
				state.out(`${indent}${sym} ${node.name} (${formatDuration(node.duration)})\n`);
			}
			return;
		}

		// Leaf test or test with subtests
		state.counts.tests++;

		if (node.skipReason) {
			state.counts.skipped++;
			node.status = "skipped";
			state.out(`${indent}﹣ ${node.name} (${formatDuration(0)}) # ${node.skipReason}\n`);
			return;
		}

		const start = now();
		let hasSubtests = false;

		const onSubtest = async (subNode) => {
			if (!hasSubtests) {
				hasSubtests = true;
				state.out(`${indent}▶ ${node.name}\n`);
			}
			await runNode(subNode, state, emitter);
		};

		const context = new TestContext(node, emitter, onSubtest);

		// Run beforeEach hooks
		const beforeEach = collectBeforeEach(node);
		let hookError = null;
		for (const hook of beforeEach) {
			try {
				await executeHook(hook, context);
			} catch (err) {
				hookError = err;
				break;
			}
		}

		let testError = hookError;
		if (!testError) {
			let timer = null;
			let timeoutOccurred = false;
			try {
				if (node.options.timeout) {
					const controller = new AbortController();
					context.signal = controller.signal;
					timer = setTimeout(() => {
						timeoutOccurred = true;
						controller.abort();
					}, node.options.timeout);
				}

				if (node.fn.length >= 2) {
					await new Promise((resolve, reject) => {
						let settled = false;
						const done = (err) => {
							if (settled) return;
							settled = true;
							if (err) reject(err);
							else resolve();
						};
						try {
							const res = node.fn(context, done);
							if (res && typeof res.then === "function") {
								res.then(() => done(), done);
							}
						} catch (err) {
							done(err);
						}
					});
				} else {
					const res = node.fn(context);
					if (res && typeof res.then === "function") {
						await res;
					}
				}
			} catch (err) {
				testError = err;
			} finally {
				if (timer) clearTimeout(timer);
				context.mock.restoreAll();
			}

			if (timeoutOccurred) {
				node.status = "cancelled";
				node.error = `test timed out after ${node.options.timeout}ms`;
				state.counts.cancelled++;
				state.failures.push(node);
			}
		}

		// Run afterEach hooks
		const afterEach = collectAfterEach(node);
		for (const hook of afterEach) {
			try {
				await executeHook(hook, context);
			} catch (err) {
				if (!testError) testError = err;
			}
		}

		node.duration = now() - start;

		if (node.status === "cancelled") {
			// Already handled timeout
			state.out(`${indent}✖ ${node.name} (${formatDuration(node.duration)})\n`);
			return;
		}

		if (node.status === "skipped") {
			state.counts.skipped++;
			state.out(`${indent}﹣ ${node.name} (${formatDuration(node.duration)}) # ${node.skipReason}\n`);
			return;
		}

		const childFailed = node.children.some((c) => c.status === "fail");

		if (node.todoReason) {
			state.counts.todo++;
			if (testError || childFailed) {
				node.status = "todo";
				node.error = testError;
				state.failures.push(node);
				state.out(`${indent}⚠ ${node.name} (${formatDuration(node.duration)}) # ${node.todoReason}\n`);
			} else {
				node.status = "pass";
				state.out(`${indent}✔ ${node.name} (${formatDuration(node.duration)}) # ${node.todoReason}\n`);
			}
		} else if (testError || childFailed) {
			node.status = "fail";
			node.error = testError;
			state.counts.fail++;
			state.failures.push(node);
			state.out(`${indent}✖ ${node.name} (${formatDuration(node.duration)})\n`);
		} else {
			node.status = "pass";
			state.counts.pass++;
			state.out(`${indent}✔ ${node.name} (${formatDuration(node.duration)})\n`);
		}

		// Emit diagnostics
		for (const diag of node.diagnostics) {
			state.out(`ℹ ${diag}\n`);
		}
	}

	async function runSuite(root, options = {}, emitter = null) {
		const out = options.write ?? ((t) => process.stdout.write(t));
		const state = {
			out,
			counts: {
				tests: 0,
				suites: 0,
				pass: 0,
				fail: 0,
				cancelled: 0,
				skipped: 0,
				todo: 0,
			},
			failures: [],
			onlyMode: hasOnly(root),
		};

		const suiteStart = now();

		// Run root before hooks
		for (const hook of root.beforeHooks) {
			try {
				await hook();
			} catch (err) {
				out(`✖ Root before hook failed: ${err.message}\n`);
			}
		}

		for (const child of root.children) {
			await runNode(child, state, emitter);
		}

		// Run root after hooks
		for (const hook of root.afterHooks) {
			try {
				await hook();
			} catch (err) {
				out(`✖ Root after hook failed: ${err.message}\n`);
			}
		}

		const totalDuration = now() - suiteStart;

		// Summary
		out(`ℹ tests ${state.counts.tests}\n`);
		out(`ℹ suites ${state.counts.suites}\n`);
		out(`ℹ pass ${state.counts.pass}\n`);
		out(`ℹ fail ${state.counts.fail}\n`);
		out(`ℹ cancelled ${state.counts.cancelled}\n`);
		out(`ℹ skipped ${state.counts.skipped}\n`);
		out(`ℹ todo ${state.counts.todo}\n`);
		out(`ℹ duration_ms ${totalDuration.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}\n`);

		// Failures section
		if (state.failures.length > 0) {
			out("\n✖ failing tests:\n\n");
			for (const f of state.failures) {
				if (f.location) {
					out(`test at ${f.location}\n`);
				}
				const sym = f.status === "todo" ? "⚠" : "✖";
				const extra = f.status === "todo" ? ` # ${f.todoReason}` : "";
				out(`${sym} ${f.name} (${formatDuration(f.duration)})${extra}\n`);

				if (f.error) {
					if (typeof f.error === "string") {
						out(`  '${f.error}'\n\n`);
					} else if (f.error.name === "AssertionError") {
						out(`  AssertionError [${f.error.code || "ERR_ASSERTION"}]: ${f.error.message}\n`);
						if (f.error.stack) {
							const stackLines = f.error.stack.split("\n").slice(1);
							out(`  ${stackLines.join("\n  ")}\n`);
						}
						out("\n");
					} else {
						const errStr = `${f.error.name || "Error"}${f.error.message ? `: ${f.error.message}` : ""}`;
						out(`  ${errStr}\n`);
						if (f.error.stack) {
							const stackLines = f.error.stack.split("\n").slice(1);
							out(`  ${stackLines.join("\n  ")}\n`);
						}
						out("\n");
					}
				}
			}
		}

		if (state.counts.fail > 0 || state.counts.cancelled > 0) {
			process.exitCode = 1;
		}
		return state;
	}

	function scheduleAutoRun() {
		if (hasScheduledRun || autoRunDisabled) return;
		hasScheduledRun = true;
		process.nextTick(() => {
			if (autoRunDisabled) return;
			// Run on nextTick / beforeExit
			runSuite(rootSuite);
		});
	}

	function run(options = {}) {
		autoRunDisabled = true;
		const stream = new Readable({
			objectMode: true,
			read() {},
		});

		process.nextTick(async () => {
			let buffer = "";
			const customWrite = (chunk) => {
				buffer += chunk;
			};
			const state = await runSuite(rootSuite, { write: customWrite });
			stream.push({ type: "test:summary", data: state.counts });
			stream.push(null);
		});

		return stream;
	}

	// ---- Reporters -------------------------------------------------------------

	function createSpecReporter() {
		return new Transform({
			writableObjectMode: true,
			transform(chunk, encoding, callback) {
				callback(null, String(chunk));
			},
		});
	}

	async function* tapReporter(source) {
		yield "TAP version 13\n";
		let count = 0;
		for await (const event of source) {
			if (event.type === "test:pass") {
				count++;
				yield `ok ${count} - ${event.data?.name || "test"}\n`;
			} else if (event.type === "test:fail") {
				count++;
				yield `not ok ${count} - ${event.data?.name || "test"}\n`;
			}
		}
		if (count > 0) yield `1..${count}\n`;
	}

	async function* dotReporter(source) {
		for await (const event of source) {
			if (event.type === "test:pass") yield ".";
			else if (event.type === "test:fail") yield "X";
			else if (event.type === "test:skip") yield "-";
		}
		yield "\n";
	}

	async function* junitReporter(source) {
		yield '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n';
		for await (const event of source) {
			if (event.type === "test:pass") {
				yield `  <testcase name="${event.data?.name || "test"}" />\n`;
			} else if (event.type === "test:fail") {
				yield `  <testcase name="${event.data?.name || "test"}"><failure /></testcase>\n`;
			}
		}
		yield "</testsuites>\n";
	}

	const reportersModule = {
		spec: createSpecReporter,
		tap: tapReporter,
		dot: dotReporter,
		junit: junitReporter,
		lcov: createSpecReporter,
	};

	const testModule = Object.assign(test, {
		test,
		it: test,
		describe,
		suite: describe,
		before,
		after,
		beforeEach,
		afterEach,
		mock,
		run,
		skip: test.skip,
		todo: test.todo,
		only: test.only,
		getTestContext: () => null,
		snapshot: () => {},
		expectFailure: () => {},
		assert: { register: () => {} },
	});

	return { testModule, reportersModule };
}

export { createTestModule };

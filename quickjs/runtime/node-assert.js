/*
 * Node's `assert`, complete: the loose and strict families, deep equality with Node's rules (Map, Set, Date, RegExp,
 * typed arrays, errors, boxed primitives, symbols, circular references, prototypes in strict mode, NaN), `throws` and
 * `rejects` with every form of the expected argument (a class, a regular expression, a validation function, an object of
 * properties, an Error to match), `match`, `ifError`, `partialDeepStrictEqual` and `assert.strict`.
 *
 * An AssertionError carries what Node's does: `code: 'ERR_ASSERTION'`, `actual`, `expected`, `operator`,
 * `generatedMessage`, and the message Node builds for the common cases ("Expected values to be strictly equal:" with the
 * two values, a `+ actual - expected` diff for objects).
 */

function createAssert({ inspect }) {
	const kReadableOperator = {
		deepStrictEqual: "Expected values to be strictly deep-equal:",
		strictEqual: "Expected values to be strictly equal:",
		strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
		deepEqual: "Expected values to be loosely deep-equal:",
		notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
		notStrictEqual: 'Expected "actual" to be strictly unequal to:',
		notStrictEqualObject: 'Expected "actual" not to be reference-equal to "expected":',
		notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
		notIdentical: "Values identical but not reference-equal:",
		notDeepEqualUnequal: "Expected values not to be loosely deep-equal:",
	};

	const inspectOptions = { compact: false, customInspect: false, depth: 1000, maxArrayLength: Infinity, showHidden: false, showProxy: false, sorted: true, getters: true };
	const show = (value) => inspect(value, inspectOptions);

	function simpleDiff(actualText, expectedText) {
		const a = actualText.split("\n");
		const b = expectedText.split("\n");
		let start = 0;
		while (start < a.length && start < b.length && a[start] === b[start]) start++;
		let endA = a.length - 1;
		let endB = b.length - 1;
		while (endA >= start && endB >= start && a[endA] === b[endB]) {
			endA--;
			endB--;
		}
		const lines = [];
		for (let i = 0; i < start; i++) lines.push(`  ${a[i]}`);
		for (let i = start; i <= endA; i++) lines.push(`+ ${a[i]}`);
		for (let i = start; i <= endB; i++) lines.push(`- ${b[i]}`);
		for (let i = endA + 1; i < a.length; i++) lines.push(`  ${a[i]}`);
		return lines.join("\n");
	}

	function generatedMessage(operator, actual, expected) {
		const single = (v) => typeof v !== "object" && typeof v !== "function" || v === null;
		if (operator === "strictEqual" || operator === "deepStrictEqual" || operator === "deepEqual") {
			const header = operator === "strictEqual" && !single(actual) && !single(expected) ? kReadableOperator.strictEqualObject : kReadableOperator[operator];
			const a = show(actual);
			const b = show(expected);
			if (single(actual) && single(expected) && !a.includes("\n") && !b.includes("\n")) return `${header}\n\n${a} !== ${b}\n`;
			if (a === b) return `${operator === "strictEqual" ? "Values have same structure but are not reference-equal:" : kReadableOperator.notIdentical}\n\n${a}\n`;
			return `${header}\n+ actual - expected\n\n${simpleDiff(a, b)}\n`;
		}
		if (operator === "notStrictEqual" || operator === "notDeepStrictEqual" || operator === "notDeepEqual") {
			const header = operator === "notStrictEqual" && !single(actual) ? kReadableOperator.notStrictEqualObject : kReadableOperator[operator];
			return `${header}\n\n${show(actual)}\n`;
		}
		if (operator === "partialDeepStrictEqual") return `Expected values to be partially and strictly deep-equal:\n+ actual - expected\n\n${simpleDiff(show(actual), show(expected))}\n`;
		if (operator === "==") return `${show(actual)} == ${show(expected)}`;
		if (operator === "!=") return `${show(actual)} != ${show(expected)}`;
		return `${show(actual)} ${operator} ${show(expected)}`;
	}

	class AssertionError extends Error {
		constructor(options) {
			if (options === null || typeof options !== "object") {
				throw Object.assign(new TypeError('The "options" argument must be of type object.'), { code: "ERR_INVALID_ARG_TYPE" });
			}
			const { message, operator, actual, expected } = options;
			const generated = message === undefined;
			super(generated ? generatedMessage(operator, actual, expected) : String(message));
			this.generatedMessage = generated;
			this.code = "ERR_ASSERTION";
			this.actual = actual;
			this.expected = expected;
			this.operator = operator;
			this.diff = options.diff ?? "simple";
			Object.defineProperty(this, "name", { value: "AssertionError", enumerable: false, writable: true, configurable: true });
			if (Error.captureStackTrace) Error.captureStackTrace(this, options.stackStartFn || options.stackStartFunction || this.constructor);
			// The engine's stack is only the frames; Node's opens `AssertionError [ERR_ASSERTION]: message`.
			const frames = typeof this.stack === "string" ? this.stack.split("\n").filter((line) => /^\s+at /.test(line)).join("\n") : "";
			Object.defineProperty(this, "stack", {
				value: `AssertionError [ERR_ASSERTION]: ${this.message}${frames ? `\n${frames}` : ""}`,
				enumerable: false,
				writable: true,
				configurable: true,
			});
		}
		toString() {
			return `${this.name} [${this.code}]: ${this.message}`;
		}
		[Symbol.for("nodejs.util.inspect.custom")](recurseTimes, ctx) {
			// Long strings are cut short, and `actual` and `expected` are inspected no deeper than the error itself: they would
			// be too verbose next to the message, which already shows both values side by side.
			const addEllipsis = (string) => {
				const lines = string.split("\n", 11);
				if (lines.length > 10) {
					lines.length = 10;
					return `${lines.join("\n")}\n...`;
				}
				if (string.length > 512) return `${string.slice(512)}...`;
				return string;
			};
			const tmpActual = this.actual;
			const tmpExpected = this.expected;
			if (typeof this.actual === "string") this.actual = addEllipsis(this.actual);
			if (typeof this.expected === "string") this.expected = addEllipsis(this.expected);
			try {
				return inspect(this, { ...ctx, customInspect: false, depth: 0 });
			} finally {
				this.actual = tmpActual;
				this.expected = tmpExpected;
			}
		}
	}

	const fail = (options) => {
		if (options.message instanceof Error) throw options.message;
		throw new AssertionError(options);
	};

	// ---- deep equality -----------------------------------------------------------------------------------------
	const isBoxed = (v) => v instanceof Number || v instanceof String || v instanceof Boolean || v instanceof BigInt || v instanceof Symbol;
	const tag = (v) => Object.prototype.toString.call(v);

	function deepEqual(a, b, strict, seen = []) {
		if (a === b) return a !== 0 || !strict || Object.is(a, b);
		if (strict) {
			if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
			if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
		} else {
			if (a === null || typeof a !== "object") {
				if (b === null || typeof b !== "object") {
					// biome-ignore lint/suspicious/noDoubleEquals: loose deepEqual compares primitives with ==
					return a == b || (Number.isNaN(a) && Number.isNaN(b));
				}
				return false;
			}
			if (b === null || typeof b !== "object") return false;
		}
		const ta = tag(a);
		if (ta !== tag(b)) return false;
		if (Array.isArray(a) !== Array.isArray(b)) return false;

		if (a instanceof Date) {
			if (a.getTime() !== b.getTime() && !(Number.isNaN(a.getTime()) && Number.isNaN(b.getTime()))) return false;
		} else if (a instanceof RegExp) {
			if (a.source !== b.source || a.flags !== b.flags || a.lastIndex !== b.lastIndex) return false;
		} else if (a instanceof Error) {
			if (a.message !== b.message || a.name !== b.name) return false;
			if ("cause" in a !== "cause" in b) return false;
		} else if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
			if (a.length !== b.length) return false;
			if (strict === false && (a instanceof Float32Array || a instanceof Float64Array)) {
				for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
			} else {
				for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i]) && !(a[i] === b[i])) return false;
			}
		} else if (a instanceof DataView || a instanceof ArrayBuffer) {
			const x = new Uint8Array(a instanceof DataView ? a.buffer : a, a.byteOffset ?? 0, a.byteLength);
			const y = new Uint8Array(b instanceof DataView ? b.buffer : b, b.byteOffset ?? 0, b.byteLength);
			if (x.length !== y.length) return false;
			for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
		} else if (isBoxed(a)) {
			if (!Object.is(a.valueOf(), b.valueOf())) return false;
		}

		for (let i = 0; i < seen.length; i++) if (seen[i][0] === a) return seen[i][1] === b;
		seen.push([a, b]);
		try {
			if (a instanceof Map) {
				if (a.size !== b.size) return false;
				outer: for (const [ka, va] of a) {
					if (b.has(ka)) {
						if (deepEqual(va, b.get(ka), strict, seen)) continue;
					}
					if (typeof ka !== "object" || ka === null) {
						if (strict || typeof ka === "object") return false;
					}
					for (const [kb, vb] of b) {
						if (deepEqual(ka, kb, strict, seen) && deepEqual(va, vb, strict, seen)) continue outer;
					}
					return false;
				}
			} else if (a instanceof Set) {
				if (a.size !== b.size) return false;
				outer: for (const va of a) {
					if (b.has(va)) continue;
					if (typeof va !== "object" || va === null) {
						if (strict) return false;
					}
					for (const vb of b) if (deepEqual(va, vb, strict, seen)) continue outer;
					return false;
				}
			}
			const ka = Object.keys(a);
			const kb = Object.keys(b);
			if (ka.length !== kb.length) return false;
			for (const key of ka) {
				if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
				if (!deepEqual(a[key], b[key], strict, seen)) return false;
			}
			if (strict) {
				const sa = Object.getOwnPropertySymbols(a).filter((s) => Object.prototype.propertyIsEnumerable.call(a, s));
				const sb = Object.getOwnPropertySymbols(b).filter((s) => Object.prototype.propertyIsEnumerable.call(b, s));
				if (sa.length !== sb.length) return false;
				for (const s of sa) if (!Object.prototype.propertyIsEnumerable.call(b, s) || !deepEqual(a[s], b[s], strict, seen)) return false;
			}
			if (a instanceof Error && "cause" in a && !deepEqual(a.cause, b.cause, strict, seen)) return false;
			return true;
		} finally {
			seen.pop();
		}
	}

	/** partialDeepStrictEqual: every property of `expected` is in `actual`, compared deeply and strictly. */
	function partialEqual(actual, expected, seen = []) {
		if (Object.is(actual, expected)) return true;
		if (typeof expected !== "object" || expected === null || typeof actual !== "object" || actual === null) return false;
		if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
		for (const [x, y] of seen) if (x === actual) return y === expected;
		seen.push([actual, expected]);
		try {
			if (expected instanceof Set) {
				for (const item of expected) {
					if (actual.has(item)) continue;
					let found = false;
					for (const candidate of actual) if (partialEqual(candidate, item, seen)) found = true;
					if (!found) return false;
				}
				return true;
			}
			if (expected instanceof Map) {
				for (const [k, v] of expected) {
					if (actual.has(k) && partialEqual(actual.get(k), v, seen)) continue;
					let found = false;
					for (const [ck, cv] of actual) if (partialEqual(ck, k, seen) && partialEqual(cv, v, seen)) found = true;
					if (!found) return false;
				}
				return true;
			}
			if (Array.isArray(expected)) {
				let at = 0;
				for (const item of expected) {
					let found = false;
					while (at < actual.length) if (partialEqual(actual[at++], item, seen)) {
						found = true;
						break;
					}
					if (!found) return false;
				}
				return true;
			}
			for (const key of Reflect.ownKeys(expected)) {
				if (!(key in actual) || !partialEqual(actual[key], expected[key], seen)) return false;
			}
			return true;
		} finally {
			seen.pop();
		}
	}

	// ---- the expected argument of throws / rejects ------------------------------------------------------------
	function invalidArg(name, expected, actual) {
		return Object.assign(new TypeError(`The "${name}" argument must be ${expected}. Received ${show(actual)}`), { code: "ERR_INVALID_ARG_TYPE" });
	}

	function compareExceptionKey(actual, expected, key, message, keys, fn) {
		if (!(key in actual) || !deepEqual(actual[key], expected[key], true)) {
			if (!message) {
				const a = {};
				const b = {};
				for (const k of keys) {
					if (k in actual) a[k] = actual[k];
					b[k] = expected[k];
				}
				const err = new AssertionError({ actual: a, expected: b, operator: "deepStrictEqual", stackStartFn: fn, message: undefined });
				err.actual = actual;
				err.expected = expected;
				err.operator = fn.name;
				throw err;
			}
			throw new AssertionError({ actual, expected, message, operator: fn.name, stackStartFn: fn });
		}
	}

	function expectedException(actual, expected, message, fn) {
		let generated = false;
		if (typeof expected !== "function") {
			if (expected instanceof RegExp) {
				const text = String(actual);
				if (expected.exec(text) !== null) return;
				if (!message) {
					generated = true;
					message = `The input did not match the regular expression ${show(expected)}. Input:\n\n${show(text)}\n`;
				}
				throw Object.assign(new AssertionError({ actual, expected, message, operator: fn.name, stackStartFn: fn }), { generatedMessage: generated });
			}
			if (typeof actual !== "object" || actual === null) {
				const err = new AssertionError({ actual, expected, message, operator: "deepStrictEqual", stackStartFn: fn });
				err.operator = fn.name;
				throw err;
			}
			const keys = Object.keys(expected);
			if (expected instanceof Error) keys.push("name", "message");
			else if (keys.length === 0) throw Object.assign(new TypeError(`The argument 'error' may not be an empty object. Received {}`), { code: "ERR_INVALID_ARG_VALUE" });
			for (const key of keys) {
				if (typeof actual[key] === "string" && expected[key] instanceof RegExp && expected[key].exec(actual[key]) !== null) continue;
				compareExceptionKey(actual, expected, key, message, keys, fn);
			}
			return;
		}
		if (expected.prototype !== undefined && actual instanceof expected) return;
		if (Error.isPrototypeOf(expected)) {
			if (!message) {
				generated = true;
				message = `The error is expected to be an instance of "${expected.name}". Received `;
				message += actual instanceof Error ? `"${actual.name}"` : show(actual);
				if (actual?.message) message += `\n\nError message:\n\n${actual.message}`;
			}
			throw Object.assign(new AssertionError({ actual, expected, message, operator: fn.name, stackStartFn: fn }), { generatedMessage: generated });
		}
		const res = Reflect.apply(expected, {}, [actual]);
		if (res !== true) {
			if (!message) {
				generated = true;
				const name = expected.name ? `"${expected.name}" ` : "";
				message = `The ${name}validation function is expected to return "true". Received ${show(res)}\n\nCaught error:\n\n${actual}`;
			}
			throw Object.assign(new AssertionError({ actual, expected, message, operator: fn.name, stackStartFn: fn }), { generatedMessage: generated });
		}
	}

	const NO_EXCEPTION = Symbol("no exception");

	function getActual(fn) {
		if (typeof fn !== "function") throw invalidArg("fn", "of type function", fn);
		try {
			fn();
		} catch (error) {
			return error;
		}
		return NO_EXCEPTION;
	}

	async function waitForActual(promiseFn) {
		let resultPromise;
		if (typeof promiseFn === "function") {
			resultPromise = promiseFn();
			if (!resultPromise || typeof resultPromise.then !== "function") {
				throw Object.assign(new TypeError(`Expected instance of Promise to be returned from the "promiseFn" function but got ${show(resultPromise)}.`), { code: "ERR_INVALID_RETURN_VALUE" });
			}
		} else if (promiseFn && typeof promiseFn.then === "function") {
			resultPromise = promiseFn;
		} else {
			throw invalidArg("promiseFn", "of type function or an instance of Promise", promiseFn);
		}
		try {
			await resultPromise;
		} catch (error) {
			return error;
		}
		return NO_EXCEPTION;
	}

	function expectsError(stackStartFn, actual, error, message) {
		if (typeof error === "string") {
			if (arguments.length === 4) throw invalidArg("error", "of type function or an instance of Error, RegExp, or Object", error);
			if (typeof actual === "object" && actual !== null) {
				if (actual.message === error) {
					throw Object.assign(new TypeError(`The "error/message" argument is ambiguous. The error message "${actual.message}" is identical to the message.`), { code: "ERR_AMBIGUOUS_ARGUMENT" });
				}
			} else if (actual === error) {
				throw Object.assign(new TypeError(`The "error/message" argument is ambiguous. The error "${actual}" is identical to the message.`), { code: "ERR_AMBIGUOUS_ARGUMENT" });
			}
			message = error;
			error = undefined;
		} else if (error != null && typeof error !== "object" && typeof error !== "function") {
			throw invalidArg("error", "of type function or an instance of Error, RegExp, or Object", error);
		}
		if (actual === NO_EXCEPTION) {
			let details = "";
			if (error?.name) details += ` (${error.name})`;
			details += message ? `: ${message}` : ".";
			const fnType = stackStartFn === assert.rejects ? "rejection" : "exception";
			fail({ actual: undefined, expected: error, operator: stackStartFn.name, message: `Missing expected ${fnType}${details}`, stackStartFn });
		}
		if (!error) return;
		expectedException(actual, error, message, stackStartFn);
	}

	function expectsNoError(stackStartFn, actual, error, message) {
		if (actual === NO_EXCEPTION) return;
		if (typeof error === "string") {
			message = error;
			error = undefined;
		}
		if (!error || (error instanceof RegExp && error.exec(String(actual)) !== null) || (typeof error === "function" && actual instanceof error)) {
			const details = message ? `: ${message}` : ".";
			const fnType = stackStartFn === assert.doesNotReject ? "rejection" : "exception";
			fail({ actual, expected: error, operator: stackStartFn.name, message: `Got unwanted ${fnType}${details}\nActual message: "${actual?.message}"`, stackStartFn });
		}
		throw actual;
	}

	// ---- the module -------------------------------------------------------------------------------------------
	function innerOk(fn, argLen, value, message) {
		if (!value) {
			let generated = false;
			if (argLen === 0) {
				generated = true;
				message = "No value argument passed to `assert.ok()`";
			} else if (message === undefined) {
				generated = true;
				message = "The expression evaluated to a falsy value:\n\n  assert.ok(" + show(value) + ")\n";
			} else if (message instanceof Error) throw message;
			const err = new AssertionError({ actual: value, expected: true, message, operator: "==", stackStartFn: fn });
			err.generatedMessage = generated;
			throw err;
		}
	}

	function assert(...args) {
		innerOk(assert, args.length, ...args);
	}

	const strictPair = (name, compare, operator, negate) =>
		function (actual, expected, message) {
			if (arguments.length < 2) throw Object.assign(new TypeError('The "actual" and "expected" arguments must be specified'), { code: "ERR_MISSING_ARGS" });
			if (negate ? !compare(actual, expected) : compare(actual, expected)) return;
			if (message instanceof Error) throw message;
			throw new AssertionError({ actual, expected, message, operator, stackStartFn: this?.fn ?? assert[name] });
		};

	const looseEqual = (a, b) => a == b || (Number.isNaN(a) && Number.isNaN(b));
	Object.assign(assert, {
		AssertionError,
		fail(message = "Failed") {
			if (message instanceof Error) throw message;
			const err = new AssertionError({ message, operator: "fail", stackStartFn: assert.fail });
			err.generatedMessage = message === "Failed";
			throw err;
		},
		ok(...args) {
			innerOk(assert.ok, args.length, ...args);
		},
		equal: strictPair("equal", looseEqual, "==", false),
		notEqual: strictPair("notEqual", looseEqual, "!=", true),
		strictEqual: strictPair("strictEqual", Object.is, "strictEqual", false),
		notStrictEqual: strictPair("notStrictEqual", Object.is, "notStrictEqual", true),
		deepEqual: strictPair("deepEqual", (a, b) => deepEqual(a, b, false), "deepEqual", false),
		notDeepEqual: strictPair("notDeepEqual", (a, b) => deepEqual(a, b, false), "notDeepEqual", true),
		deepStrictEqual: strictPair("deepStrictEqual", (a, b) => deepEqual(a, b, true), "deepStrictEqual", false),
		notDeepStrictEqual: strictPair("notDeepStrictEqual", (a, b) => deepEqual(a, b, true), "notDeepStrictEqual", true),
		partialDeepStrictEqual(actual, expected, message) {
			if (arguments.length < 2) throw Object.assign(new TypeError('The "actual" and "expected" arguments must be specified'), { code: "ERR_MISSING_ARGS" });
			if (partialEqual(actual, expected)) return;
			if (message instanceof Error) throw message;
			throw new AssertionError({ actual, expected, message, operator: "partialDeepStrictEqual", stackStartFn: assert.partialDeepStrictEqual });
		},
		throws(fn, ...args) {
			expectsError(assert.throws, getActual(fn), ...args);
		},
		async rejects(promiseFn, ...args) {
			expectsError(assert.rejects, await waitForActual(promiseFn), ...args);
		},
		doesNotThrow(fn, ...args) {
			expectsNoError(assert.doesNotThrow, getActual(fn), ...args);
		},
		async doesNotReject(fn, ...args) {
			expectsNoError(assert.doesNotReject, await waitForActual(fn), ...args);
		},
		ifError(err) {
			if (err !== null && err !== undefined) {
				let message = "ifError got unwanted exception: ";
				if (typeof err === "object" && typeof err.message === "string") {
					message += err.message.length === 0 && err.constructor ? err.constructor.name : err.message;
				} else message += show(err);
				const newErr = new AssertionError({ actual: err, expected: null, operator: "ifError", message, stackStartFn: assert.ifError });
				newErr.generatedMessage = false;
				throw newErr;
			}
		},
		match(string, regexp, message) {
			matchImpl(string, regexp, message, assert.match, true);
		},
		doesNotMatch(string, regexp, message) {
			matchImpl(string, regexp, message, assert.doesNotMatch, false);
		},
	});

	function matchImpl(string, regexp, message, fn, shouldMatch) {
		if (arguments.length < 3 && message === undefined && regexp === undefined) throw Object.assign(new TypeError('The "string" and "regexp" arguments must be specified'), { code: "ERR_MISSING_ARGS" });
		if (!(regexp instanceof RegExp)) throw invalidArg("regexp", "an instance of RegExp", regexp);
		const match = typeof string === "string" && regexp.exec(string) !== null;
		if (match === shouldMatch) return;
		if (message instanceof Error) throw message;
		const generated = !message;
		message ||= typeof string !== "string"
			? `The "string" argument must be of type string. Received type ${typeof string} (${show(string)})`
			: `${shouldMatch ? "The input did not match the regular expression " : "The input was expected to not match the regular expression "}${show(regexp)}. Input:\n\n${show(string)}\n`;
		const err = new AssertionError({ actual: string, expected: regexp, message, operator: fn.name, stackStartFn: fn });
		err.generatedMessage = generated;
		throw err;
	}

	const strict = Object.assign((...args) => innerOk(strict, args.length, ...args), assert, {
		equal: assert.strictEqual,
		deepEqual: assert.deepStrictEqual,
		notEqual: assert.notStrictEqual,
		notDeepEqual: assert.notDeepStrictEqual,
	});
	assert.strict = strict;
	strict.strict = strict;
	assert.Assert = class Assert {
		constructor(options = {}) {
			const source = options.strict === false ? assert : strict;
			for (const name of Object.keys(source)) if (typeof source[name] === "function" && name !== "AssertionError") this[name] = source[name];
		}
	};
	return assert;
}

export { createAssert };

/*
 * What `node:test` needs from Node's internals and this runtime does not have as a module: the coded errors Node throws
 * for a bad argument, the validators that throw them, and the small helpers the runner and the mocks share.
 */

const TIMEOUT_MAX = 2 ** 31 - 1;
const kEmptyObject = Object.freeze({ __proto__: null });

/** Set by node-test.js to the host's `util.inspect`, so that messages quote values as Node does. */
const hooks = { inspect: (value) => String(value) };

function nodeError(Base, code, message, { hideFrames = false } = {}) {
	const err = new Base(message);
	// Node's coded errors read `TypeError [CODE]: message` in their stack and `code` shows in `util.inspect`.
	try {
		Object.defineProperty(err, "stack", {
			value: (hideFrames ? String(err.stack).split("\n")[0] : String(err.stack)).replace(
				/^([A-Za-z]*Error)(?=:|\n|$)/,
				`$1 [${code}]`
			),
			writable: true,
			configurable: true,
			enumerable: false,
		});
	} catch {
		// A stack that cannot be rewritten still carries the code below.
	}
	Object.defineProperty(err, "code", { value: code, writable: true, configurable: true, enumerable: true });
	Object.defineProperty(err, "toString", {
		value() {
			return `${this.name} [${code}]: ${this.message}`;
		},
		writable: true,
		configurable: true,
		enumerable: false,
	});
	return err;
}

function describeReceived(actual) {
	if (actual == null) return `. Received ${actual}`;
	if (typeof actual === "function") return `. Received function ${actual.name}`;
	if (typeof actual === "object") {
		const name = actual.constructor?.name;
		return name ? `. Received an instance of ${name}` : `. Received ${hooks.inspect(actual, { depth: -1 })}`;
	}
	let inspected = hooks.inspect(actual, { colors: false });
	if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
	return `. Received type ${typeof actual} (${inspected})`;
}

function invalidArgType(name, expected, actual) {
	const all = [].concat(expected);
	const types = all.filter((type) => /^[a-z]/.test(type));
	const instances = all.filter((type) => /^[A-Z]/.test(type));
	const label = name.endsWith(" argument") ? name : `"${name}" ${name.includes(".") ? "property" : "argument"}`;
	let msg = `The ${label} must be `;
	if (types.length > 2) msg += `one of type ${types.slice(0, -1).join(", ")}, or ${types.at(-1)}`;
	else if (types.length === 2) msg += `one of type ${types[0]} or ${types[1]}`;
	else if (types.length === 1) msg += `of type ${types[0]}`;
	if (types.length > 0 && instances.length > 0) msg += " or ";
	if (instances.length > 2) msg += `an instance of ${instances.slice(0, -1).join(", ")}, or ${instances.at(-1)}`;
	else if (instances.length === 2) msg += `an instance of ${instances[0]} or ${instances[1]}`;
	else if (instances.length === 1) msg += `an instance of ${instances[0]}`;
	return nodeError(TypeError, "ERR_INVALID_ARG_TYPE", `${msg}${describeReceived(actual)}`);
}

function invalidArgValue(name, value, reason = "is invalid") {
	const kind = name.includes(".") ? "property" : "argument";
	return nodeError(
		TypeError,
		"ERR_INVALID_ARG_VALUE",
		`The ${kind} '${name}' ${reason}. Received ${hooks.inspect(value)}`
	);
}

function outOfRange(name, range, received) {
	let shown;
	if (Number.isInteger(received) && Math.abs(received) > 2 ** 32) {
		shown = String(received).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
	} else if (typeof received === "bigint") {
		shown = `${String(received).replace(/\B(?=(\d{3})+(?!\d))/g, "_")}n`;
	} else {
		shown = hooks.inspect(received);
	}
	return nodeError(
		RangeError,
		"ERR_OUT_OF_RANGE",
		`The value of "${name}" is out of range. It must be ${range}. Received ${shown}`
	);
}

function invalidState(message) {
	return nodeError(Error, "ERR_INVALID_STATE", `Invalid state: ${message}`);
}

function validateFunction(value, name) {
	if (typeof value !== "function") throw invalidArgType(name, "function", value);
}

function validateObject(value, name) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidArgType(name, "object", value);
}

function validateString(value, name) {
	if (typeof value !== "string") throw invalidArgType(name, "string", value);
}

function validateBoolean(value, name) {
	if (typeof value !== "boolean") throw invalidArgType(name, "boolean", value);
}

function validateNumber(value, name, min = undefined, max = undefined) {
	if (typeof value !== "number") throw invalidArgType(name, "number", value);
	if (
		(min != null && value < min) ||
		(max != null && value > max) ||
		((min != null || max != null) && Number.isNaN(value))
	) {
		throw outOfRange(
			name,
			`${min != null ? `>= ${min}` : ""}${min != null && max != null ? " && " : ""}${max != null ? `<= ${max}` : ""}`,
			value
		);
	}
}

function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
	if (typeof value !== "number") throw invalidArgType(name, "number", value);
	if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
	if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
}

function validateUint32(value, name, positive = false) {
	if (typeof value !== "number") throw invalidArgType(name, "number", value);
	if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
	const min = positive ? 1 : 0;
	if (value < min || value > 4294967295) throw outOfRange(name, `>= ${min} && <= 4294967295`, value);
}

function validateOneOf(value, name, oneOf) {
	if (!oneOf.includes(value)) {
		const allowed = oneOf.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ");
		throw invalidArgValue(name, value, `must be one of: ${allowed}`);
	}
}

function validateStringArray(value, name) {
	if (!Array.isArray(value)) throw invalidArgType(name, "Array", value);
	for (let i = 0; i < value.length; i++) validateString(value[i], `${name}[${i}]`);
}

function validateAbortSignal(signal, name) {
	if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
		throw invalidArgType(name, "AbortSignal", signal);
	}
}

/** The listener runs once when the signal aborts, or on a microtask if it already has; `dispose` detaches it. */
function addAbortListener(signal, listener) {
	if (signal.aborted) {
		queueMicrotask(() => listener(new Event("abort")));
		return { dispose() {} };
	}
	signal.addEventListener("abort", listener, { once: true });
	return { dispose: () => signal.removeEventListener("abort", listener) };
}

function createAbortError(message = "The operation was aborted", options) {
	const err = new Error(message, options);
	err.name = "AbortError";
	err.code = "ABORT_ERR";
	return err;
}

export {
	addAbortListener,
	createAbortError,
	hooks,
	invalidArgType,
	invalidArgValue,
	invalidState,
	kEmptyObject,
	nodeError,
	outOfRange,
	TIMEOUT_MAX,
	validateAbortSignal,
	validateBoolean,
	validateFunction,
	validateInteger,
	validateNumber,
	validateObject,
	validateOneOf,
	validateString,
	validateStringArray,
	validateUint32,
};

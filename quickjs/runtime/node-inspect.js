/*
 * util.inspect, util.format and console, following Node.js's own formatting rules.
 *
 * The engine's console.log converts every argument with ToString, so an object prints as
 * "[object Object]" and an Error loses its stack. That is what a bot's diagnostics look like in
 * practice, so the layout here is Node's, not an approximation of it: nested depth, quoting, class
 * names, Map/Set/typed-array/Buffer forms, circular references, and the same rules for when an object
 * stays on one line and when it breaks (including column layout of long arrays).
 */

const custom = Symbol.for("nodejs.util.inspect.custom");
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z_0-9]*$/;

const defaults = {
	depth: 2,
	breakLength: 80,
	compact: 3,
	maxArrayLength: 100,
	maxStringLength: 10000,
	showHidden: false,
	sorted: false,
	getters: false,
};

function quote(str) {
	const single = !str.includes("'");
	const q = single ? "'" : !str.includes('"') ? '"' : !str.includes("`") && !str.includes("${") ? "`" : "'";
	const escaped = str.replace(/[\\\n\r\t\b\f\v\x00-\x1f\x7f]|['"`]/g, (c) => {
		if (c === q) return `\\${c}`;
		if (c === "'" || c === '"' || c === "`") return c;
		switch (c) {
			case "\\":
				return "\\\\";
			case "\n":
				return "\\n";
			case "\r":
				return "\\r";
			case "\t":
				return "\\t";
			case "\b":
				return "\\b";
			case "\f":
				return "\\f";
			case "\v":
				return "\\v";
			default:
				return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`;
		}
	});
	return q + escaped + q;
}

function keyName(key) {
	if (typeof key === "symbol") return `[${key.toString()}]`;
	return IDENTIFIER.test(key) ? key : quote(key);
}

function getPrefix(constructor, tag, fallback, size = "") {
	if (constructor === null) {
		if (tag !== "" && fallback !== tag) return `[${fallback}${size}: null prototype] [${tag}] `;
		return `[${fallback}${size}: null prototype] `;
	}
	if (tag !== "" && constructor !== tag) return `${constructor}${size} [${tag}] `;
	return `${constructor}${size} `;
}

function constructorName(obj) {
	for (let o = obj; o !== null && o !== undefined; o = Object.getPrototypeOf(o)) {
		const descriptor = Object.getOwnPropertyDescriptor(o, "constructor");
		if (descriptor !== undefined && typeof descriptor.value === "function" && descriptor.value.name !== "") {
			return descriptor.value.name;
		}
	}
	return null;
}

function isBelowBreakLength(ctx, output, start, base) {
	let total = output.length + start;
	if (total + output.length > ctx.breakLength) return false;
	for (let i = 0; i < output.length; i++) {
		total += output[i].length;
		if (total > ctx.breakLength) return false;
	}
	return base === "" || !base.includes("\n");
}

function reduceToSingleString(ctx, output, base, braces, extrasType, recurseTimes, value) {
	if (ctx.compact !== true) {
		if (typeof ctx.compact === "number" && ctx.compact >= 1) {
			const entries = output.length;
			if (extrasType === "array" && entries > 6) output = groupArrayElements(ctx, output, value);
			if (ctx.currentDepth - recurseTimes < ctx.compact && entries === output.length) {
				const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
				if (isBelowBreakLength(ctx, output, start, base)) {
					const joined = output.join(", ");
					if (!joined.includes("\n")) {
						return `${base ? `${base} ` : ""}${braces[0]} ${joined} ${braces[1]}`;
					}
				}
			}
		}
		const indentation = `\n${" ".repeat(ctx.indentationLvl)}`;
		return `${base ? `${base} ` : ""}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
	}
	if (isBelowBreakLength(ctx, output, 0, base)) {
		return `${braces[0]}${base ? ` ${base}` : ""} ${output.join(", ")} ${braces[1]}`;
	}
	const indentation = `\n${" ".repeat(ctx.indentationLvl)}`;
	const ln = base === "" && braces[0].length === 1 ? " " : `${base ? ` ${base}` : ""}\n${indentation}  `;
	return `${braces[0]}${ln}${output.join(`,${indentation}  `)} ${braces[1]}`;
}

function groupArrayElements(ctx, output, value) {
	let totalLength = 0;
	let maxLength = 0;
	let i = 0;
	let outputLength = output.length;
	if (ctx.maxArrayLength < output.length) outputLength--;
	const separatorSpace = 2;
	const dataLen = new Array(outputLength);
	for (; i < outputLength; i++) {
		const len = output[i].length;
		dataLen[i] = len;
		totalLength += len + separatorSpace;
		if (maxLength < len) maxLength = len;
	}
	const actualMax = maxLength + separatorSpace;
	if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength && (totalLength / actualMax > 5 || maxLength <= 6)) {
		const approxCharHeights = 2.5;
		const averageBias = Math.sqrt(actualMax - totalLength / output.length);
		const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
		const columns = Math.min(
			Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),
			Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
			ctx.compact * 4,
			15
		);
		if (columns <= 1) return output;
		const tmp = [];
		const maxLineLength = [];
		for (let c = 0; c < columns; c++) {
			let lineLength = 0;
			for (let j = c; j < output.length; j += columns) if (dataLen[j] > lineLength) lineLength = dataLen[j];
			maxLineLength.push(lineLength + separatorSpace);
		}
		let padStart = true;
		if (value !== undefined) {
			for (let k = 0; k < output.length; k++) {
				if (typeof value[k] !== "number" && typeof value[k] !== "bigint") {
					padStart = false;
					break;
				}
			}
		}
		for (let r = 0; r < outputLength; r += columns) {
			const max = Math.min(r + columns, outputLength);
			let str = "";
			let j = r;
			for (; j < max - 1; j++) {
				const padding = maxLineLength[j - r];
				str += padStart ? `${output[j]}, `.padStart(padding, " ") : `${output[j]}, `.padEnd(padding, " ");
			}
			if (padStart) str += output[j].padStart(maxLineLength[j - r] - separatorSpace, " ");
			else str += output[j];
			tmp.push(str);
		}
		if (ctx.maxArrayLength < output.length) tmp.push(output[outputLength]);
		output = tmp;
	}
	return output;
}

const STYLE_CODES = {
	bold: [1, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27], white: [37, 39], grey: [90, 39], black: [30, 39],
	blue: [34, 39], cyan: [36, 39], green: [32, 39], magenta: [35, 39], red: [31, 39], yellow: [33, 39],
};
const STYLES = { special: "cyan", number: "yellow", bigint: "yellow", boolean: "yellow", undefined: "grey", null: "bold", string: "green", symbol: "green", date: "magenta", regexp: "red", module: "underline" };

/* Wraps `text` in the ANSI colour for a kind of value, when the caller asked for colours. */
function stylize(ctx, text, kind) {
	if (!ctx.colors) return text;
	const code = STYLE_CODES[STYLES[kind]];
	return code ? `\u001b[${code[0]}m${text}\u001b[${code[1]}m` : text;
}

function formatPrimitive(value, ctx) {
	if (typeof value === "string") {
		let trailer = "";
		if (value.length > ctx.maxStringLength) {
			const remaining = value.length - ctx.maxStringLength;
			value = value.slice(0, ctx.maxStringLength);
			trailer = `... ${remaining} more character${remaining > 1 ? "s" : ""}`;
		}
		// A long string with newlines is split so each line reads as its own literal.
		if (ctx.compact !== true && value.length > 16 && value.length > ctx.breakLength - ctx.indentationLvl - 4) {
			return `${value
				.split(/(?<=\n)/)
				.map((line) => stylize(ctx, quote(line), "string"))
				.join(` +\n${" ".repeat(ctx.indentationLvl + 2)}`)}${trailer}`;
		}
		return stylize(ctx, quote(value), "string") + trailer;
	}
	if (typeof value === "bigint") return stylize(ctx, `${value}n`, "bigint");
	if (typeof value === "number") return stylize(ctx, Object.is(value, -0) ? "-0" : `${value}`, "number");
	if (typeof value === "boolean") return stylize(ctx, String(value), "boolean");
	if (value === undefined) return stylize(ctx, "undefined", "undefined");
	return String(value);
}

function formatValue(ctx, value, recurseTimes, typedArray) {
	if (typeof value !== "object" && typeof value !== "function" && typeof value !== "symbol") {
		return formatPrimitive(value, ctx);
	}
	if (typeof value === "symbol") return stylize(ctx, value.toString(), "symbol");
	if (value === null) return stylize(ctx, "null", "null");

	const proxy = null;
	const maybeCustom = value[custom];
	if (typeof maybeCustom === "function" && maybeCustom !== inspect) {
		const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
		const ret = maybeCustom.call(value, depth, { ...ctx, depth }, inspect);
		if (ret !== value) {
			if (typeof ret !== "string") return formatValue(ctx, ret, recurseTimes);
			return ret.replaceAll("\n", `\n${" ".repeat(ctx.indentationLvl)}`);
		}
	}
	void proxy;

	if (ctx.seen.includes(value)) {
		let index = 1;
		if (ctx.circular === undefined) {
			ctx.circular = new Map();
			ctx.circular.set(value, index);
		} else {
			index = ctx.circular.get(value);
			if (index === undefined) {
				index = ctx.circular.size + 1;
				ctx.circular.set(value, index);
			}
		}
		return stylize(ctx, `[Circular *${index}]`, "special");
	}
	return formatRaw(ctx, value, recurseTimes, typedArray);
}

function getKeys(value, showHidden) {
	const keys = Object.keys(value);
	const symbols = Object.getOwnPropertySymbols(value);
	if (showHidden) return [...Object.getOwnPropertyNames(value), ...symbols];
	if (symbols.length) return [...keys, ...symbols.filter((s) => Object.prototype.propertyIsEnumerable.call(value, s))];
	return keys;
}

function formatProperty(ctx, value, recurseTimes, key, type) {
	let name;
	let str;
	let extra = " ";
	const desc = Object.getOwnPropertyDescriptor(value, key) ?? { value: value[key], enumerable: true };
	if (desc.value !== undefined) {
		const diff = ctx.compact !== true || type !== "object" ? 2 : 3;
		ctx.indentationLvl += diff;
		str = formatValue(ctx, desc.value, recurseTimes);
		if (diff === 3 && ctx.breakLength < str.length) extra = `\n${" ".repeat(ctx.indentationLvl)}`;
		ctx.indentationLvl -= diff;
	} else if (desc.get !== undefined) {
		const label = desc.set !== undefined ? "Getter/Setter" : "Getter";
		str = `[${label}]`;
	} else if (desc.set !== undefined) {
		str = "[Setter]";
	} else {
		str = "undefined";
	}
	if (type === "array-index") return str;
	if (typeof key === "symbol") name = `[${key.toString()}]`;
	else if (key === "__proto__") name = "['__proto__']";
	else if (desc.enumerable === false) name = `[${key}]`;
	else name = keyName(key);
	return `${name}:${extra}${str}`;
}

function formatError(err, constructor, tag, ctx) {
	let stack = typeof err.stack === "string" && err.stack ? err.stack : Error.prototype.toString.call(err);
	// The engine's stack is only the "at ..." frames; Node's opens with "Name: message", which is what
	// a person reading a log expects to see first.
	const header = Error.prototype.toString.call(err);
	if (!stack.startsWith(header.split("\n")[0]) && /^\s*at /.test(stack)) stack = `${header}\n${stack}`;
	// Node prints a class-named error as `Name: message` even when the stack starts differently.
	const name = err.name ?? "Error";
	if (constructor !== null && constructor !== name && !stack.includes(constructor) && stack.startsWith(name)) {
		stack = `${constructor} [${name}]${stack.slice(name.length)}`;
	}
	const cause = err.cause;
	let extra = "";
	if (cause !== undefined && !stack.includes("[cause]")) {
		extra = ` {\n${" ".repeat(ctx.indentationLvl + 2)}[cause]: ${formatValue(ctx, cause, 0)}\n${" ".repeat(ctx.indentationLvl)}}`;
	}
	return stack + extra;
}

function formatRaw(ctx, value, recurseTimes, typedArray) {
	let keys;
	let protoProps;
	const constructor = constructorName(value);
	let tag = value[Symbol.toStringTag];
	if (typeof tag !== "string" || (tag !== "" && (ctx.showHidden ? Object.hasOwn(value, Symbol.toStringTag) : false))) {
		tag = "";
	}
	let base = "";
	let formatter = getEmptyFormatArray;
	let braces;
	let noIterator = true;
	let extrasType = "object";
	let i = 0;

	if (Symbol.iterator in value || constructor === null) {
		noIterator = false;
		if (Array.isArray(value)) {
			const prefix = constructor !== "Array" || tag !== "" ? getPrefix(constructor, tag, "Array", `(${value.length})`) : "";
			keys = getOwnNonIndexProperties(value, ctx.showHidden);
			braces = [`${prefix}[`, "]"];
			if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
			extrasType = "array";
			formatter = formatArray;
		} else if (value instanceof Set) {
			const size = value.size;
			const prefix = getPrefix(constructor, tag, "Set", `(${size})`);
			keys = getKeys(value, ctx.showHidden);
			formatter = (c, _v, r) => formatSet(value, c, r);
			if (size === 0 && keys.length === 0) return `${prefix}{}`;
			braces = [`${prefix}{`, "}"];
		} else if (value instanceof Map) {
			const size = value.size;
			const prefix = getPrefix(constructor, tag, "Map", `(${size})`);
			keys = getKeys(value, ctx.showHidden);
			formatter = (c, _v, r) => formatMap(value, c, r);
			if (size === 0 && keys.length === 0) return `${prefix}{}`;
			braces = [`${prefix}{`, "}"];
		} else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
			keys = getOwnNonIndexProperties(value, ctx.showHidden);
			const isBuffer = constructor === "Buffer";
			if (isBuffer) {
				const max = 50;
				let str = "";
				const n = Math.min(max, value.length);
				for (let k = 0; k < n; k++) str += `${k ? " " : ""}${value[k].toString(16).padStart(2, "0")}`;
				const remaining = value.length - max;
				if (remaining > 0) str += ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}`;
				return `<Buffer${str ? ` ${str}` : ""}>`;
			}
			const size = value.length;
			const fallback = value[Symbol.toStringTag] ?? "TypedArray";
			const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
			braces = [`${prefix}[`, "]"];
			if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
			formatter = formatTypedArray.bind(null, value, size);
			extrasType = "array";
		} else if (value instanceof Map.prototype.constructor && false) {
			noIterator = true;
		} else {
			noIterator = true;
		}
	}
	if (noIterator) {
		keys = getKeys(value, ctx.showHidden);
		braces = ["{", "}"];
		if (typeof value === "function") {
			base = getFunctionBase(value, constructor, tag);
			if (keys.length === 0) return base;
		} else if (constructor === "Object") {
			if (value instanceof Error || Object.prototype.toString.call(value) === "[object Error]") {
				base = formatError(value, constructor, tag, ctx);
				keys = keys.filter((k) => k !== "stack" && k !== "message" && k !== "cause");
				if (keys.length === 0) return base;
			} else if (tag !== "") {
				braces[0] = `${getPrefix(constructor, tag, "Object")}{`;
			}
			if (keys.length === 0 && base === "") return `${braces[0]}}`;
		} else if (value instanceof RegExp) {
			base = RegExp.prototype.toString.call(value);
			const prefix = getPrefix(constructor, tag, "RegExp");
			if (prefix !== "RegExp ") base = `${prefix}${base}`;
			if (keys.length === 0) return base;
		} else if (value instanceof Date) {
			base = Number.isNaN(value.getTime()) ? Date.prototype.toString.call(value) : Date.prototype.toISOString.call(value);
			const prefix = getPrefix(constructor, tag, "Date");
			if (prefix !== "Date ") base = `${prefix}${base}`;
			if (keys.length === 0) return base;
		} else if (value instanceof Error) {
			base = formatError(value, constructor, tag, ctx);
			keys = keys.filter((k) => k !== "stack" && k !== "message" && k !== "cause");
			if (keys.length === 0) return base;
		} else if (value instanceof ArrayBuffer) {
			const prefix = getPrefix(constructor, tag, "ArrayBuffer");
			const bytes = new Uint8Array(value);
			const shown = Array.from(bytes.subarray(0, 50), (b) => b.toString(16).padStart(2, "0")).join(" ");
			const more = bytes.length > 50 ? ` ... ${bytes.length - 50} more byte${bytes.length - 50 > 1 ? "s" : ""}` : "";
			braces[0] = `${prefix}{`;
			formatter = () => [`[Uint8Contents]: <${shown}${more}>`, `byteLength: ${value.byteLength}`];
		} else if (value instanceof Promise) {
			braces[0] = `${getPrefix(constructor, tag, "Promise")}{`;
			formatter = (c, v, r) => {
				const state = promiseState(v);
				if (state === "pending") return ["<pending>"];
				c.indentationLvl += 2;
				const s = formatValue(c, state.value, r);
				c.indentationLvl -= 2;
				return [state.rejected ? `<rejected> ${s}` : s];
			};
		} else if (value instanceof WeakSet || value instanceof WeakMap) {
			braces[0] = `${getPrefix(constructor, tag, value instanceof WeakSet ? "WeakSet" : "WeakMap")}{`;
			formatter = () => ["<items unknown>"];
		} else if (isBoxed(value)) {
			const [type, primitive] = boxed(value);
			base = `[${type}${constructor !== type ? (constructor === null ? " (null prototype)" : ` (${constructor})`) : ""}: ${formatPrimitive(primitive, { ...ctx, compact: true })}]`;
			if (keys.length === 0) return base;
		} else if (value instanceof DataView) {
			braces[0] = `${getPrefix(constructor, tag, "DataView")}{`;
			formatter = (c, v, r) => [
				`byteLength: ${v.byteLength}`,
				`byteOffset: ${v.byteOffset}`,
				`buffer: ${formatValue(c, v.buffer, r)}`,
			];
		} else {
			if (keys.length === 0) return `${getPrefix(constructor, tag, "Object")}{}`;
			braces[0] = `${getPrefix(constructor, tag, "Object")}{`;
		}
	}

	if (ctx.depth !== null && recurseTimes > ctx.depth) {
		let name = constructor === null ? "Object: null prototype" : (constructor ?? tag ?? "Object");
		if (Array.isArray(value)) name = "Array";
		return `[${name}]`;
	}
	recurseTimes += 1;
	ctx.seen.push(value);
	ctx.currentDepth = recurseTimes;
	let output;
	let entries;
	try {
		output = formatter(ctx, value, recurseTimes);
		for (i = 0; i < keys.length; i++) {
			output.push(formatProperty(ctx, value, recurseTimes, keys[i], extrasType));
		}
		void protoProps;
	} finally {
		ctx.seen.pop();
	}
	if (ctx.circular !== undefined) {
		const index = ctx.circular.get(value);
		if (index !== undefined) {
			const reference = `<ref *${index}>`;
			if (ctx.compact !== true) base = base === "" ? reference : `${reference} ${base}`;
			else braces[0] = `${reference} ${braces[0]}`;
		}
	}
	if (ctx.sorted) output.sort();
	entries = output.length;
	void entries;
	const res = reduceToSingleString(ctx, output, base, braces, extrasType, recurseTimes, value);
	return res;
}

function getEmptyFormatArray() {
	return [];
}

function getFunctionBase(value, constructor, tag) {
	const stringified = Function.prototype.toString.call(value);
	if (stringified.startsWith("class") && stringified.endsWith("}")) {
		const slice = stringified.slice(5, -1);
		const bracketIndex = slice.indexOf("{");
		if (bracketIndex !== -1 && (!slice.slice(0, bracketIndex).includes("(") || /^(?:\s+[\w$]+)?\s*extends\s/.test(slice.slice(0, bracketIndex)))) {
			let base = `[class ${value.name || "(anonymous)"}`;
			const superName = Object.getPrototypeOf(value)?.name;
			if (superName) base += ` extends ${superName}`;
			return `${base}]`;
		}
	}
	let type = "Function";
	if (/^async\s*function\*/.test(stringified)) type = "AsyncGeneratorFunction";
	else if (/^function\*/.test(stringified)) type = "GeneratorFunction";
	else if (/^async\b/.test(stringified)) type = "AsyncFunction";
	let base = `[${type}`;
	if (constructor === null) base += " (null prototype)";
	base += value.name === "" ? " (anonymous)" : `: ${value.name}`;
	base += "]";
	if (constructor !== type && constructor !== null) base += ` ${constructor}`;
	if (tag !== "" && constructor !== tag) base += ` [${tag}]`;
	return base;
}

function getOwnNonIndexProperties(value, showHidden) {
	const all = showHidden ? Object.getOwnPropertyNames(value) : Object.keys(value);
	const out = all.filter((k) => !/^(0|[1-9]\d*)$/.test(k) || Number(k) >= 4294967295);
	const symbols = Object.getOwnPropertySymbols(value).filter((s) => showHidden || Object.prototype.propertyIsEnumerable.call(value, s));
	return [...out.filter((k) => !(showHidden && k === "length")), ...symbols];
}

function formatArray(ctx, value, recurseTimes) {
	const valLen = value.length;
	const len = Math.min(Math.max(0, ctx.maxArrayLength), valLen);
	const remaining = valLen - len;
	const output = [];
	for (let i = 0; i < len; i++) {
		if (!Object.hasOwn(value, i)) return formatArrayBuffer(ctx, value, recurseTimes, len, output);
		output.push(formatProperty(ctx, value, recurseTimes, String(i), "array-index"));
	}
	if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? "s" : ""}`);
	return output;
}

// A sparse array: runs of holes collapse to "<n empty items>".
function formatArrayBuffer(ctx, value, recurseTimes, len, output) {
	output.length = 0;
	let holes = 0;
	let shown = 0;
	for (let i = 0; i < value.length && shown < ctx.maxArrayLength; i++) {
		if (!Object.hasOwn(value, i)) {
			holes++;
			continue;
		}
		if (holes) {
			output.push(`<${holes} empty item${holes > 1 ? "s" : ""}>`);
			holes = 0;
			shown++;
		}
		output.push(formatProperty(ctx, value, recurseTimes, String(i), "array-index"));
		shown++;
	}
	if (holes) output.push(`<${holes} empty item${holes > 1 ? "s" : ""}>`);
	return output;
}

function formatTypedArray(value, length, ctx) {
	const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length);
	const remaining = value.length - maxLength;
	const output = new Array(maxLength);
	for (let i = 0; i < maxLength; ++i) output[i] = formatPrimitive(value[i], ctx);
	if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? "s" : ""}`);
	return output;
}

function formatSet(value, ctx, recurseTimes) {
	const output = [];
	ctx.indentationLvl += 2;
	for (const v of value) output.push(formatValue(ctx, v, recurseTimes));
	ctx.indentationLvl -= 2;
	return output;
}

function formatMap(value, ctx, recurseTimes) {
	const output = [];
	ctx.indentationLvl += 2;
	for (const [k, v] of value) output.push(`${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`);
	ctx.indentationLvl -= 2;
	return output;
}

function isBoxed(value) {
	return (
		value instanceof Number || value instanceof String || value instanceof Boolean || value instanceof BigInt || value instanceof Symbol
	);
}
function boxed(value) {
	if (value instanceof Number) return ["Number", Number.prototype.valueOf.call(value)];
	if (value instanceof String) return ["String", String.prototype.valueOf.call(value)];
	if (value instanceof Boolean) return ["Boolean", Boolean.prototype.valueOf.call(value)];
	if (value instanceof BigInt) return ["BigInt", BigInt.prototype.valueOf.call(value)];
	return ["Symbol", Symbol.prototype.valueOf.call(value)];
}

/** Promise state can only be read by racing it; the engine exposes it to the host, not to script. */
let promiseStateReader = null;
export function setPromiseStateReader(fn) {
	promiseStateReader = fn;
}
function promiseState(promise) {
	const [state, value] = promiseStateReader ? promiseStateReader(promise) : ["pending"];
	return state === "pending" ? "pending" : { rejected: state === "rejected", value };
}

export function inspect(value, opts, ...rest) {
	const ctx = {
		...defaults,
		seen: [],
		indentationLvl: 0,
		currentDepth: 0,
		circular: undefined,
	};
	if (typeof opts === "boolean") {
		ctx.showHidden = opts;
		if (rest.length > 0 && rest[0] !== undefined) ctx.depth = rest[0];
	} else if (opts) {
		for (const key of Object.keys(opts)) if (key in defaults || key === "colors" || key === "customInspect") ctx[key] = opts[key];
	}
	if (ctx.compact === false) ctx.compact = 0;
	if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
	if (ctx.depth === Infinity) ctx.depth = null;
	return formatValue(ctx, value, 0);
}
inspect.custom = custom;
inspect.defaultOptions = defaults;
inspect.colors = Object.fromEntries(Object.entries(STYLE_CODES));
inspect.styles = STYLES;

export function format(...args) {
	const first = args[0];
	let a = 0;
	let str = "";
	let join = "";
	if (typeof first === "string") {
		if (args.length === 1) return first;
		let lastPos = 0;
		for (let i = 0; i < first.length - 1; i++) {
			if (first.charCodeAt(i) !== 37) continue;
			const next = first[i + 1];
			if (next === "%") {
				str += first.slice(lastPos, i) + "%";
				lastPos = i + 2;
				i++;
				continue;
			}
			if (a + 1 === args.length || !"sdifjoOc".includes(next)) continue;
			const arg = args[++a];
			let piece;
			switch (next) {
				case "s":
					piece =
						typeof arg === "number"
							? formatPrimitive(arg, defaults)
							: typeof arg === "bigint"
								? `${arg}n`
								: typeof arg !== "object" || arg === null || !hasBuiltInToString(arg)
									? String(arg)
									: inspect(arg, { depth: 0, colors: false, compact: 3 });
					break;
				case "d":
					piece = typeof arg === "bigint" ? `${arg}n` : typeof arg === "symbol" ? "NaN" : formatPrimitive(Number(arg), defaults);
					break;
				case "i":
					piece = typeof arg === "bigint" ? `${arg}n` : typeof arg === "symbol" ? "NaN" : formatPrimitive(Number.parseInt(arg), defaults);
					break;
				case "f":
					piece = typeof arg === "symbol" ? "NaN" : formatPrimitive(Number.parseFloat(arg), defaults);
					break;
				case "j":
					try {
						piece = JSON.stringify(arg);
					} catch {
						piece = "[Circular]";
					}
					break;
				case "o":
					piece = inspect(arg, { showHidden: true, showProxy: true, depth: 4 });
					break;
				case "O":
					piece = inspect(arg);
					break;
				default:
					piece = "";
			}
			if (lastPos !== i - 1 || true) str += first.slice(lastPos, i);
			str += piece;
			lastPos = i + 2;
			i++;
		}
		if (lastPos !== 0) {
			a++;
			join = " ";
			if (lastPos < first.length) str += first.slice(lastPos);
		}
	}
	while (a < args.length) {
		const value = args[a];
		str += join;
		str += typeof value !== "string" ? inspect(value) : value;
		join = " ";
		a++;
	}
	return str;
}

function hasBuiltInToString(value) {
	if (typeof value.toString !== "function") return true;
	if (Object.hasOwn(value, "toString")) return false;
	let pointer = value;
	do {
		pointer = Object.getPrototypeOf(pointer);
	} while (!Object.hasOwn(pointer, "toString"));
	const descriptor = Object.getOwnPropertyDescriptor(pointer, "constructor");
	return descriptor !== undefined && typeof descriptor.value === "function" && ["Object", "Array", "Error", "Map", "Set", "Date", "RegExp"].includes(descriptor.value.name);
}

/**
 * A Console over two write functions. `now` is injected so timers work without a clock of its own.
 */
export function createConsole(writeOut, writeErr, now) {
	let indent = "";
	const counts = new Map();
	const timers = new Map();
	const emit = (write, args) => {
		const text = format(...args);
		write(indent ? `${indent}${text.replaceAll("\n", `\n${indent}`)}\n` : `${text}\n`);
	};
	const con = {
		log: (...args) => emit(writeOut, args),
		info: (...args) => emit(writeOut, args),
		debug: (...args) => emit(writeOut, args),
		warn: (...args) => emit(writeErr, args),
		error: (...args) => emit(writeErr, args),
		trace: (...args) => {
			const err = new Error(format(...args));
			err.name = "Trace";
			emit(writeErr, [err.stack]);
		},
		dir: (value, options) => emit(writeOut, [inspect(value, { customInspect: false, ...options })]),
		dirxml: (...args) => emit(writeOut, args),
		assert: (condition, ...args) => {
			if (!condition) emit(writeErr, [`Assertion failed${args.length ? `: ${format(...args)}` : ""}`]);
		},
		count: (label = "default") => {
			const n = (counts.get(label) ?? 0) + 1;
			counts.set(label, n);
			emit(writeOut, [`${label}: ${n}`]);
		},
		countReset: (label = "default") => counts.delete(label),
		group: (...args) => {
			if (args.length) emit(writeOut, args);
			indent += "  ";
		},
		groupEnd: () => {
			indent = indent.slice(0, -2);
		},
		time: (label = "default") => timers.set(label, now()),
		timeEnd: (label = "default") => {
			const start = timers.get(label);
			if (start === undefined) return;
			timers.delete(label);
			emit(writeOut, [`${label}: ${(now() - start).toFixed(3)}ms`]);
		},
		timeLog: (label = "default", ...data) => {
			const start = timers.get(label);
			if (start !== undefined) emit(writeOut, [`${label}: ${(now() - start).toFixed(3)}ms`, ...data]);
		},
		table: (data) => {
			if (data === null || typeof data !== "object") return emit(writeOut, [data]);
			const rows = Array.isArray(data) ? data.map((v, i) => [String(i), v]) : Object.entries(data);
			const columns = [];
			const cells = rows.map(([key, row]) => {
				const cell = { "(index)": key };
				if (row !== null && typeof row === "object") {
					for (const [k, v] of Object.entries(row)) {
						if (!columns.includes(k)) columns.push(k);
						cell[k] = inspect(v, { depth: 0, compact: true });
					}
				} else {
					if (!columns.includes("Values")) columns.push("Values");
					cell.Values = inspect(row, { depth: 0, compact: true });
				}
				return cell;
			});
			const heads = ["(index)", ...columns];
			const widths = heads.map((h) => Math.max(h.length, ...cells.map((c) => (c[h] ?? "").length)) + 2);
			const center = (s, w) => ` ${s}`.padEnd(w, " ");
			const line = (l, m, r) => `${l}${widths.map((w) => "─".repeat(w)).join(m)}${r}`;
			const lines = [
				line("┌", "┬", "┐"),
				`│${heads.map((h, i) => center(h, widths[i])).join("│")}│`,
				line("├", "┼", "┤"),
				...cells.map((c) => `│${heads.map((h, i) => center(c[h] ?? "", widths[i])).join("│")}│`),
				line("└", "┴", "┘"),
			];
			emit(writeOut, [lines.join("\n")]);
		},
	};
	return con;
}

/*
 * Node's `node:repl`: `repl.start()` and `REPLServer` -- a read-eval-print loop over any pair of streams, with the
 * `_` and `_error` variables, `.help .break .clear .exit .save .load .editor` and custom `defineCommand()`s, top-level
 * `await`, multi-line input, tab completion, history, `context`, `useGlobal`, `writer`, `eval`, `replMode`, and the
 * 'exit' and 'reset' events. The behaviour follows Node's lib/repl.js, lib/internal/repl/{completion,await,history}.js.
 *
 * There is one engine realm, so a REPL "context" is a sandbox object and the code runs through a `with` block over a
 * Proxy (the way `vm` does here). Top-level `let`/`const`/`class` declarations are kept in a per-context table (the
 * TDZ, redeclaration and const-assignment errors of a real script scope are reproduced), top-level `var` and
 * `function` declarations become properties of the context, exactly as in a V8 context. Node parses with acorn; this
 * file reads the code with a small tokenizer instead, so it understands what the REPL needs (statement starts,
 * declarations, unterminated input) and nothing more.
 *
 * What differs from Node (also in the README): syntax-error messages are the engine's own, and there is no source
 * echo with a caret under them; frames of user functions are not shown in `Uncaught` errors; terminal mode is a plain
 * line editor (arrows, history, Tab, Ctrl+A/E/K/U/W/L/C/D) without the inline preview, reverse search or multi-line
 * editing; `.editor` works, `breakEvalOnSigint` cannot interrupt a running script.
 */

import { createConsole } from "./node-inspect.js";
import { nodeError } from "./node-test-util.js";

/** What a fresh V8 context has on its global; a REPL context is given everything else the process has. */
const V8_GLOBALS = [
	"Object", "Function", "Array", "Number", "parseFloat", "parseInt", "Infinity", "NaN", "undefined", "Boolean", "String",
	"Symbol", "Date", "Promise", "RegExp", "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError",
	"SyntaxError", "TypeError", "URIError", "globalThis", "JSON", "Math", "Intl", "ArrayBuffer", "Atomics", "Uint8Array",
	"Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "BigUint64Array", "BigInt64Array",
	"Uint8ClampedArray", "Float32Array", "Float64Array", "DataView", "Map", "BigInt", "Set", "Iterator", "WeakMap",
	"WeakSet", "Proxy", "Reflect", "FinalizationRegistry", "WeakRef", "decodeURI", "decodeURIComponent", "encodeURI",
	"encodeURIComponent", "escape", "unescape", "eval", "isFinite", "isNaN", "console", "SuppressedError",
	"DisposableStack", "AsyncDisposableStack", "Float16Array", "SharedArrayBuffer", "WebAssembly",
];
const V8_GLOBAL_SET = new Set(V8_GLOBALS);
/** The globals Node leaves enumerable on a REPL context, in the order it lists them. */
const ENUMERABLE_GLOBALS = [
	"global", "clearImmediate", "setImmediate", "clearInterval", "clearTimeout", "setInterval", "setTimeout",
	"queueMicrotask", "structuredClone", "atob", "btoa", "performance", "fetch", "crypto", "navigator",
];
const HOST_ONLY_GLOBALS = /^(__graak|scriptArgs$|print$|InternalError$|require$|console$)/;

const REPL_MODE_SLOPPY = Symbol("repl-sloppy");
const REPL_MODE_STRICT = Symbol("repl-strict");
const MULTILINE_PROMPT = "| ";
const HISTORY_SIZE = 30;

/* ------------------------------------------------------------------------------------------------- tokenizer */

const OPERATOR_KEYWORDS = new Set([
	"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);
const NOT_A_NAME = new Set([
	...OPERATOR_KEYWORDS, "this", "function", "class", "async", "null", "true", "false", "super", "import", "let", "var", "const",
]);
const PUNCTUATORS = [
	">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||",
	"??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
];
const NUMBER = /^(?:0[xXbBoO][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/;
const isIdStart = (c) => /[A-Za-z_$#\u0080-\uffff\\]/.test(c);
const isIdPart = (c) => /[\w$\u0080-\uffff\\]/.test(c);
const isNewline = (c) => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";

/**
 * Splits JavaScript into tokens ({ t: id|num|str|tpl|re|p, v, s, e, nl, d }): `nl` is a newline before the token, `d` the
 * bracket depth (openers at the depth they sit in, closers at the depth after closing). It also reports what an
 * interactive reader wants to know about the end of the text.
 */
function scan(src) {
	const tokens = [];
	const stack = [];
	const info = { tokens, stray: false, unterminated: false, badString: false, continuation: false, unclosed: false };
	const n = src.length;
	let i = 0;
	let nl = false;
	const add = (t, s, e, d, extra) => {
		tokens.push({ t, v: src.slice(s, e), s, e, nl, d: d ?? stack.length, ...extra });
		nl = false;
	};
	const regexAllowed = () => {
		const prev = tokens[tokens.length - 1];
		if (!prev) return true;
		if (prev.t === "p") return ![")", "]", "}"].includes(prev.v);
		if (prev.t === "id") return OPERATOR_KEYWORDS.has(prev.v);
		if (prev.t === "tpl") return !prev.closed;
		return false;
	};
	// Reads template text from `from` (just after the backtick or the `}` of a substitution).
	const template = (start, from) => {
		let j = from;
		while (j < n) {
			const c = src[j];
			if (c === "\\") j += 2;
			else if (c === "`") {
				add("tpl", start, j + 1, undefined, { closed: true });
				return j + 1;
			} else if (c === "$" && src[j + 1] === "{") {
				stack.push("t");
				add("tpl", start, j + 2, stack.length - 1, { closed: false });
				return j + 2;
			} else j++;
		}
		info.unterminated = true;
		return n;
	};
	while (i < n) {
		const c = src[i];
		if (isNewline(c)) {
			nl = true;
			i++;
		} else if (c === " " || c === "\t" || c === "\v" || c === "\f" || c === " " || c === "﻿") i++;
		else if (c === "/" && src[i + 1] === "/") {
			while (i < n && !isNewline(src[i])) i++;
		} else if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end < 0) {
				info.unterminated = true;
				break;
			}
			if (/[\n\r\u2028\u2029]/.test(src.slice(i, end))) nl = true;
			i = end + 2;
		} else if (c === "'" || c === '"') {
			let j = i + 1;
			let closed = false;
			while (j < n) {
				const d = src[j];
				if (d === "\\") j += src[j + 1] === "\r" && src[j + 2] === "\n" ? 3 : 2;
				else if (d === c) {
					closed = true;
					j++;
					break;
				} else if (isNewline(d)) break;
				else j++;
			}
			if (!closed) {
				if (j >= n && /\\(?:\r\n?|\n|\u2028|\u2029)$/.test(src)) info.continuation = true;
				else info.badString = true;
				break;
			}
			add("str", i, j);
			i = j;
		} else if (c === "`") i = template(i, i + 1);
		else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
			const m = NUMBER.exec(src.slice(i, i + 80));
			add("num", i, i + m[0].length);
			i += m[0].length;
		} else if (isIdStart(c)) {
			let j = i + 1;
			while (j < n && isIdPart(src[j])) j++;
			add("id", i, j);
			i = j;
		} else if (c === "/" && regexAllowed()) {
			let j = i + 1;
			let inClass = false;
			let closed = false;
			while (j < n && !isNewline(src[j])) {
				const d = src[j];
				if (d === "\\") j++;
				else if (d === "[") inClass = true;
				else if (d === "]") inClass = false;
				else if (d === "/" && !inClass) {
					closed = true;
					break;
				}
				j++;
			}
			if (closed) {
				j++;
				while (j < n && /[a-z]/.test(src[j])) j++;
				add("re", i, j);
				i = j;
			} else {
				add("p", i, i + 1);
				i++;
			}
		} else if (c === "(" || c === "[" || c === "{") {
			add("p", i, i + 1);
			stack.push(c);
			i++;
		} else if (c === ")" || c === "]" || c === "}") {
			const top = stack[stack.length - 1];
			if (c === "}" && top === "t") {
				stack.pop();
				i = template(i, i + 1);
			} else {
				if (stack.length && top === { ")": "(", "]": "[", "}": "{" }[c]) stack.pop();
				else info.stray = true;
				add("p", i, i + 1);
				i++;
			}
		} else {
			let len = 1;
			for (const p of PUNCTUATORS) {
				if (src.startsWith(p, i) && !(p === "?." && /[0-9]/.test(src[i + 2] ?? ""))) {
					len = p.length;
					break;
				}
			}
			add("p", i, i + len);
			i += len;
		}
	}
	info.unclosed = stack.length > 0;
	return info;
}

const endsExpression = (tok) => {
	if (!tok) return false;
	if (tok.t === "num" || tok.t === "str" || tok.t === "re") return true;
	if (tok.t === "tpl") return tok.closed;
	if (tok.t === "id") return !OPERATOR_KEYWORDS.has(tok.v);
	return [")", "]", "}", "++", "--"].includes(tok.v);
};

/** Whether the token at `i` starts a statement (at depth 0): after `;` or `}`, at the start, or after a newline ASI would split. */
function startsStatement(tokens, i) {
	const tok = tokens[i];
	if (tok.d !== 0) return false;
	if (i === 0) return true;
	const prev = tokens[i - 1];
	// `else`, `catch` and `finally` continue the statement a `}` closed.
	if (prev.t === "p" && (prev.v === ";" || (prev.v === "}" && prev.d === 0))) return !["else", "catch", "finally"].includes(tok.v);
	return tok.nl && endsExpression(prev);
}

const splitTop = (toks, sep) => {
	const parts = [[]];
	if (!toks.length) return parts;
	const base = Math.min(...toks.map((t) => t.d));
	for (const t of toks) {
		if (t.d === base && t.t === "p" && t.v === sep) parts.push([]);
		else parts[parts.length - 1].push(t);
	}
	return parts;
};
const indexTop = (toks, sep) => {
	if (!toks.length) return -1;
	const base = Math.min(...toks.map((t) => t.d));
	return toks.findIndex((t) => t.d === base && t.t === "p" && t.v === sep);
};

/** The names a binding pattern (`a`, `{ a, b: [c] }`, ...) declares. */
function bindingNames(toks, out = []) {
	if (!toks.length) return out;
	const first = toks[0];
	if (first.t === "id") out.push(first.v);
	else if (first.v === "{" || first.v === "[") {
		for (const part of splitTop(toks.slice(1, -1), ",")) {
			let p = part;
			if (p[0]?.v === "...") p = p.slice(1);
			if (first.v === "{") {
				const colon = indexTop(p, ":");
				if (colon >= 0) p = p.slice(colon + 1);
			}
			const eq = indexTop(p, "=");
			if (eq >= 0) p = p.slice(0, eq);
			bindingNames(p, out);
		}
	}
	return out;
}

/** `typeof name` must not throw for a name that does not exist. */
function rewriteTypeof(src) {
	const { tokens } = scan(src);
	let out = "";
	let last = 0;
	for (let i = 0; i + 1 < tokens.length; i++) {
		const t = tokens[i];
		const id = tokens[i + 1];
		if (t.t !== "id" || t.v !== "typeof" || id.t !== "id" || NOT_A_NAME.has(id.v) || id.v.startsWith("#")) continue;
		const after = tokens[i + 2];
		if (after && (after.t === "tpl" || (after.t === "p" && [".", "[", "(", "?."].includes(after.v)))) continue;
		out += `${src.slice(last, id.s)}(()=>{try{return ${id.v}}catch{}})()`;
		last = id.e;
	}
	return out + src.slice(last);
}

/**
 * Turns the top-level declarations of one REPL input into assignments the scope proxy understands, and lists what was
 * declared: `const a = 1` becomes `void (a = 1);`, `function f(){}` becomes `void (f = function f(){});`.
 */
function transformDeclarations(src) {
	const { tokens } = scan(src);
	const decls = [];
	const edits = [];
	const nextIs = (i, v) => tokens[i + 1]?.v === v;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.t !== "id" || !startsStatement(tokens, i)) continue;
		const isFunction = tok.v === "function" || (tok.v === "async" && nextIs(i, "function") && !tokens[i + 1].nl);
		const nameAt = tok.v === "async" ? i + 2 : i + 1;
		if (isFunction || (tok.v === "class" && tokens[i + 1]?.t === "id")) {
			let nameIdx = nameAt;
			if (isFunction && tokens[nameIdx]?.v === "*") nameIdx++;
			const name = tokens[nameIdx];
			if (!name || name.t !== "id") continue;
			let j = nameIdx + 1;
			while (j < tokens.length && !(tokens[j].d === 0 && tokens[j].v === "{" && tokens[j].t === "p")) j++;
			let k = j + 1;
			while (k < tokens.length && !(tokens[k].d === 0 && tokens[k].v === "}" && tokens[k].t === "p")) k++;
			if (k >= tokens.length) continue;
			decls.push({ kind: isFunction ? "function" : "class", name: name.v });
			edits.push({ s: tok.s, e: tokens[k].e, text: `void (${name.v} = ${src.slice(tok.s, tokens[k].e)});` });
			i = k;
			continue;
		}
		const after = tokens[i + 1];
		const isLet =
			tok.v === "let" && after && ((after.t === "id" && !["in", "of", "instanceof"].includes(after.v)) || (after.t === "p" && ["{", "["].includes(after.v)));
		if (tok.v !== "var" && tok.v !== "const" && !isLet) continue;
		// The end of the statement: `;` at depth 0, or the newline ASI would split at.
		let end = i + 1;
		while (end < tokens.length) {
			const t = tokens[end];
			if (t.d === 0 && t.t === "p" && t.v === ";") break;
			if (t.d === 0 && t.nl && endsExpression(tokens[end - 1]) && ["id", "num", "str", "re"].includes(t.t) && !["in", "of", "instanceof"].includes(t.v)) break;
			end++;
		}
		const body = tokens.slice(i + 1, end);
		if (!body.length) continue;
		const parts = [];
		let malformed = false;
		const declaredHere = [];
		for (const declarator of splitTop(body, ",")) {
			if (!declarator.length) continue;
			const eq = indexTop(declarator, "=");
			const pattern = eq < 0 ? declarator : declarator.slice(0, eq);
			if (!pattern.length || !(pattern[0].t === "id" || ["{", "["].includes(pattern[0].v)) || (pattern[0].t === "id" && NOT_A_NAME.has(pattern[0].v))) {
				malformed = true;
				break;
			}
			for (const name of bindingNames(pattern)) declaredHere.push({ kind: tok.v, name });
			const patternText = src.slice(pattern[0].s, pattern[pattern.length - 1].e);
			if (eq >= 0) {
				const init = declarator.slice(eq + 1);
				if (init.length) parts.push(`(${patternText} = ${src.slice(init[0].s, init[init.length - 1].e)})`);
			} else if (tok.v === "let") parts.push(`(${patternText} = void 0)`);
		}
		// A declaration the reader cannot make sense of is left for the compiler to reject.
		if (malformed) continue;
		decls.push(...declaredHere);
		edits.push({ s: tok.s, e: tokens[end - 1].e, text: `${parts.length ? `void (${parts.join(", ")})` : "void 0"};` });
		i = end - 1;
	}
	let out = "";
	let last = 0;
	for (const edit of edits) {
		out += src.slice(last, edit.s) + edit.text;
		last = edit.e;
	}
	return { code: out + src.slice(last), decls };
}

/** Wraps input that has a top-level `await` so the value of its last expression comes back as `{ value }`. */
function wrapAsync(src) {
	const { tokens } = scan(src);
	let lastStart = -1;
	for (let i = 0; i < tokens.length; i++) if (startsStatement(tokens, i) && !(tokens[i].t === "p" && tokens[i].v === ";")) lastStart = i;
	let body = src;
	if (lastStart >= 0) {
		const tok = tokens[lastStart];
		const control = tok.t === "id" && ["if", "for", "while", "do", "try", "switch", "throw", "return", "break", "continue", "with", "debugger"].includes(tok.v);
		if (!control && !(tok.t === "p" && tok.v === "{")) {
			const tail = src.slice(tok.s).replace(/[\s;]+$/, "");
			body = `${src.slice(0, tok.s)}return { value: (${tail}\n) }`;
		}
	}
	return `(async () => { ${body}\n})()`;
}

/** A top-level `await` followed by `(` or `[`: the one form that also parses as an ordinary script. */
function hasAwaitCall(code) {
	if (!code.includes("await")) return false;
	const { tokens } = scan(code);
	return tokens.some((t, i) => t.t === "id" && t.v === "await" && t.d === 0 && tokens[i - 1]?.v !== "." && ["(", "["].includes(tokens[i + 1]?.v));
}

const compileError = (code) => {
	try {
		new Function(`${code}\n`);
		return null;
	} catch (err) {
		return err;
	}
};
const isValidSyntax = (input) => compileError(String(input)) === null || compileError(`_=${input}`) === null;

/** Whether a compile failure only means "the input is not finished" (Node's isRecoverableError, on this engine's messages). */
function isRecoverable(err, code) {
	if (/^\s*\{/.test(code) && isRecoverable(err, `(${code}`)) return true;
	const info = scan(code);
	if (info.stray || info.badString) return false;
	if (info.unclosed || info.unterminated || info.continuation) return true;
	// Input that stops on an operator (`x.`, `a ?`, `1 +`) is waiting for its other half.
	const last = info.tokens[info.tokens.length - 1];
	if (last?.t === "p" && ![")", "]", "}", ";", "++", "--"].includes(last.v)) return true;
	const message = String(err?.message ?? "");
	return /'\}'$|''$|end of (string|comment|input)|expecting catch or finally/.test(message);
}

/* ------------------------------------------------------------------------------------------------ the module */

export function createRepl({ EventEmitter, readline, util, vm, fs, path, process, moduleModule, createRequire, signal }) {
	const Interface = readline.Interface;
	const inspect = util.inspect;
	const isProxy = (v) => util.types?.isProxy?.(v) ?? false;

	let builtinLibs = moduleModule.builtinModules.filter((e) => e[0] !== "_" && !e.includes(":"));

	const writer = (obj) => inspect(obj, writer.options);
	writer.options = { ...inspect.defaultOptions, showProxy: true };

	class Recoverable extends SyntaxError {
		constructor(err) {
			super();
			this.err = err;
		}
	}

	const runner = vm.runInThisContext("(function (__grScope, __grCode) { with (__grScope) { return eval(__grCode); } })");
	const HIDDEN = new Set(["eval", "__grScope", "__grCode"]);

	/** The scope one evaluation sees: the lexical table first, then the context, then what the process has. */
	function makeScope(repl, target, gen) {
		const lex = repl._lexical;
		return new Proxy(target, {
			has: (_t, key) => typeof key === "string" && !HIDDEN.has(key),
			get(t, key) {
				if (key === Symbol.unscopables) return undefined;
				const entry = lex.get(key);
				if (entry) {
					// A binding a failed declaration left behind reads as missing in later input, as in V8's REPL mode.
					if (!entry.init) throw new ReferenceError(entry.gen === gen ? `Cannot access '${key}' before initialization` : `${key} is not defined`);
					return entry.value;
				}
				if (key === "globalThis") return t;
				if (key in t) return Reflect.get(t, key, t);
				if (key in globalThis) return globalThis[key];
				throw new ReferenceError(`${key} is not defined`);
			},
			set(t, key, value) {
				const entry = lex.get(key);
				if (entry) {
					if (entry.init && entry.kind === "const") throw new TypeError("Assignment to constant variable.");
					entry.value = value;
					entry.init = true;
					return true;
				}
				if (repl.replMode === REPL_MODE_STRICT && !(key in t) && !(key in globalThis)) throw new ReferenceError(`${key} is not defined`);
				return Reflect.set(t, key, value, t);
			},
		});
	}

	function declare(repl, decls, gen) {
		const lex = repl._lexical;
		for (const { kind, name } of decls) {
			if (lex.has(name) || ((kind === "let" || kind === "const" || kind === "class") && repl._vars.has(name))) {
				throw new SyntaxError(`Identifier '${name}' has already been declared`);
			}
		}
		for (const { kind, name } of decls) {
			if (kind === "let" || kind === "const" || kind === "class") lex.set(name, { kind: kind === "const" ? "const" : "let", init: false, value: undefined, gen });
			else {
				repl._vars.add(name);
				if (!Object.prototype.hasOwnProperty.call(repl.context, name)) {
					Object.defineProperty(repl.context, name, { value: undefined, writable: true, enumerable: true, configurable: true });
				}
			}
		}
	}

	const commonPrefix = (strings) => {
		if (!strings.length) return "";
		if (strings.length === 1) return strings[0];
		const sorted = [...strings].sort();
		const min = sorted[0];
		const max = sorted[sorted.length - 1];
		for (let i = 0; i < min.length; i++) if (min[i] !== max[i]) return min.slice(0, i);
		return min;
	};

	const isIdentifier = (s) => /^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*$/.test(s);
	const isIndexKey = (s) => /^(?:0|[1-9]\d*)$/.test(s) && Number(s) < 2 ** 32 - 1;
	const LEGACY = new Set(["__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);
	function filteredOwnPropertyNames(obj) {
		if (!obj) return [];
		let isObjectPrototype = false;
		if (Object.getPrototypeOf(obj) === null) {
			const ctor = Object.getOwnPropertyDescriptor(obj, "constructor");
			if (ctor?.value) {
				const ctorProto = Object.getPrototypeOf(ctor.value);
				isObjectPrototype = Boolean(ctorProto) && Object.getPrototypeOf(ctorProto) === obj;
			}
		}
		return Object.getOwnPropertyNames(obj).filter((k) => !isIndexKey(k) && isIdentifier(k) && !(isObjectPrototype && LEGACY.has(k)));
	}

	const COMMON_WORDS = [
		"async", "await", "break", "case", "catch", "const", "continue", "debugger", "default", "delete", "do", "else", "export",
		"false", "finally", "for", "function", "if", "import", "in", "instanceof", "let", "new", "null", "return", "switch", "this",
		"throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
	];
	const requireRE = /\brequire\s*\(\s*['"`](([\w@./:-]+\/)?(?:[\w@./:-]*))(?![^'"`])$/;
	const importRE = /\bimport\s*\(\s*['"`](([\w@./:-]+\/)?(?:[\w@./:-]*))(?![^'"`])$/;
	const fsAutoCompleteRE = /fs(?:\.promises)?\.\s*[a-z][a-zA-Z]+\(\s*["'](.*)/;

	/** The last piece of the input worth completing: `a.b.` , `obj.pro`, `tru` -- not calls, not text after an operator. */
	function findCompleteTarget(line) {
		const { tokens } = scan(line);
		const last = tokens[tokens.length - 1];
		if (!last || last.e !== line.length || !(last.t === "id" || (last.t === "p" && (last.v === "." || last.v === "?.")))) return null;
		let start = last.s;
		let j = tokens.length - 1;
		while (j >= 0) {
			const t = tokens[j];
			if (["id", "num", "str", "re", "tpl"].includes(t.t) || (t.t === "p" && (t.v === "." || t.v === "?."))) start = t.s;
			else if (t.t === "p" && t.v === "]") {
				let depth = 1;
				let k = j - 1;
				while (k >= 0 && depth) {
					if (tokens[k].t === "p" && tokens[k].v === "]") depth++;
					else if (tokens[k].t === "p" && tokens[k].v === "[") depth--;
					k--;
				}
				if (depth) return null;
				j = k + 1;
				start = tokens[j].s;
			} else if (t.t === "p" && t.v === ")") return null;
			else break;
			const prev = tokens[j - 1];
			if (!prev || prev.e !== start) break;
			j--;
		}
		return line.slice(start) || null;
	}

	/* ---------------------------------------------------------------------------------------- REPLServer */

	class REPLServer extends Interface {
		constructor(prompt, stream, eval_, useGlobal, ignoreUndefined, replMode) {
			let options;
			if (prompt !== null && typeof prompt === "object") {
				options = { ...prompt };
				stream = options.stream || options.socket;
				eval_ = options.eval;
				useGlobal = options.useGlobal;
				ignoreUndefined = options.ignoreUndefined;
				prompt = options.prompt;
				replMode = options.replMode;
			} else options = {};
			if (!options.input && !options.output) {
				stream ||= process;
				options.input = stream.stdin || stream;
				options.output = stream.stdout || stream;
			}
			if (options.terminal === undefined) options.terminal = options.output.isTTY;
			options.terminal = Boolean(options.terminal);
			if (options.terminal && options.useColors === undefined) {
				options.useColors = typeof options.output.hasColors === "function" ? options.output.hasColors() : false;
			}
			if (options.breakEvalOnSigint && eval_) {
				throw nodeError(TypeError, "ERR_INVALID_REPL_EVAL_CONFIG", 'Cannot specify both "breakEvalOnSigint" and "eval" for REPL');
			}
			if (typeof prompt !== "string") prompt = "> ";

			// A terminal is read by this class itself; a plain stream goes through the readline line splitter.
			super({ input: options.terminal ? undefined : options.input, output: options.output, terminal: false });
			this.input = options.input;
			this.output = options.output;
			this.terminal = options.terminal;
			this.completer = options.completer || ((text, cb) => this._complete(text, this.editorMode ? this.completeOnEditorMode(cb) : cb));
			this._initialPrompt = prompt;
			this._prompt = prompt;
			this.historySize = options.historySize ?? HISTORY_SIZE;
			this.history = [];
			this.line = "";
			this.cursor = 0;

			this.allowBlockingCompletions = Boolean(options.allowBlockingCompletions);
			this.useColors = Boolean(options.useColors);
			this.useGlobal = Boolean(useGlobal);
			this.ignoreUndefined = Boolean(ignoreUndefined);
			this.replMode = replMode || REPL_MODE_SLOPPY;
			this.underscoreAssigned = false;
			this.last = undefined;
			this.underscoreErrAssigned = false;
			this.lastError = undefined;
			this.breakEvalOnSigint = Boolean(options.breakEvalOnSigint);
			this.editorMode = false;
			this._buffered = "";
			this._paused = false;
			this._queue = [];
			this._loading = false;
			this._sawSIGINT = false;
			this._sawCtrlD = false;
			this._historyIndex = -1;
			this._domain = new EventEmitter();
			this.eval = eval_ || this._defaultEval.bind(this);
			Object.defineProperty(this, "inputStream", { get: () => this.input, set: (v) => (this.input = v), enumerable: false, configurable: true });
			Object.defineProperty(this, "outputStream", { get: () => this.output, set: (v) => (this.output = v), enumerable: false, configurable: true });

			this.resetContext();
			this.commands = { __proto__: null };
			this._defineDefaultCommands();
			this.writer = options.writer || writer;
			if (this.writer === writer) writer.options.colors = this.useColors;

			this.on("close", () => {
				if (this._paused) this._queue.push(["close"]);
				else this.emit("exit");
			});
			this.on("SIGINT", () => this._onSigint());
			this.on("line", (cmd) => this._onLine(cmd));
			if (this.terminal) this._attachTerminal();
			else {
				// A last line without a newline still runs before the REPL closes.
				this.input.on?.("end", () => {
					const rest = this._buffer;
					this._buffer = "";
					if (rest) this.emit("line", rest);
				});
			}
			this.displayPrompt();
		}

		get closed() {
			return this._closed;
		}

		/* -------------------------------------------------------------------------------- context */

		createContext() {
			let context;
			if (this.useGlobal) context = globalThis;
			else {
				context = vm.createContext();
				const names = Object.getOwnPropertyNames(globalThis);
				const put = (name) => {
					if (name === "global" || V8_GLOBAL_SET.has(name) || HOST_ONLY_GLOBALS.test(name) || !names.includes(name)) return;
					const d = Object.getOwnPropertyDescriptor(globalThis, name);
					Object.defineProperty(context, name, { ...d, enumerable: ENUMERABLE_GLOBALS.includes(name) });
				};
				Object.defineProperty(context, "global", { value: context, writable: true, configurable: true, enumerable: true });
				for (const name of ENUMERABLE_GLOBALS) if (name !== "global") put(name);
				for (const name of names) put(name);
				const output = this.output;
				const write = (text) => output.write(text);
				Object.defineProperty(context, "console", {
					configurable: true,
					writable: true,
					value: createConsole(write, write, () => globalThis.performance?.now?.() ?? Date.now()),
				});
			}
			const cwd = process.cwd();
			const replModule = new moduleModule("<repl>");
			replModule.filename = path.resolve(cwd, "repl");
			replModule.paths = moduleModule._nodeModulePaths(cwd);
			const req = createRequire(`${cwd.replace(/[\\/]$/, "")}/repl`);
			Object.defineProperty(context, "module", { configurable: true, writable: true, value: replModule });
			Object.defineProperty(context, "require", { configurable: true, writable: true, value: req });
			for (const name of builtinLibs) {
				if (name.includes("/") || Object.prototype.hasOwnProperty.call(context, name)) continue;
				let cached;
				let hasCached = false;
				Object.defineProperty(context, name, {
					configurable: true,
					enumerable: false,
					get: () => {
						if (!hasCached) {
							cached = req(name);
							hasCached = true;
						}
						return cached;
					},
					set: (value) => {
						delete context[name];
						context[name] = value;
					},
				});
			}
			return context;
		}

		resetContext() {
			this.context = this.createContext();
			this._lexical = new Map();
			this._vars = new Set();
			this.underscoreAssigned = false;
			this.underscoreErrAssigned = false;
			this.lines = [];
			this.lines.level = [];
			Object.defineProperty(this.context, "_", {
				configurable: true,
				get: () => this.last,
				set: (value) => {
					this.last = value;
					if (!this.underscoreAssigned) {
						this.underscoreAssigned = true;
						this.output.write("Expression assignment to _ now disabled.\n");
					}
				},
			});
			Object.defineProperty(this.context, "_error", {
				configurable: true,
				get: () => this.lastError,
				set: (value) => {
					this.lastError = value;
					if (!this.underscoreErrAssigned) {
						this.underscoreErrAssigned = true;
						this.output.write("Expression assignment to _error now disabled.\n");
					}
				},
			});
			this.emit("reset", this.context);
		}

		/* ---------------------------------------------------------------------------------- eval */

		_prepare(input) {
			let code = input;
			let wrappedCmd = false;
			if (/^\s*\{/.test(code) && !/;\s*$/.test(code) && isValidSyntax(code)) {
				code = `(${code.trim()})\n`;
				wrappedCmd = true;
			}
			for (;;) {
				const prepared = this._prepareCode(code);
				if (prepared.error && wrappedCmd) {
					wrappedCmd = false;
					code = input;
					continue;
				}
				return prepared;
			}
		}

		_prepareCode(code) {
			let transformed;
			try {
				transformed = transformDeclarations(rewriteTypeof(code));
			} catch (err) {
				return { error: err };
			}
			const plain = compileError(transformed.code);
			if (!plain && hasAwaitCall(code)) {
				// `await (x)` and `await [x]` also read as a call of a function named await; Node reads them as `await`.
				const wrapped = wrapAsync(transformed.code);
				if (!compileError(wrapped)) return { source: wrapped, decls: transformed.decls, isAsync: true };
			}
			if (!plain) return { source: transformed.code, decls: transformed.decls };
			if (/await/.test(code)) {
				const wrapped = wrapAsync(transformed.code);
				if (!compileError(wrapped) && /\bawait\b|\bfor\s+await\b/.test(code)) {
					return { source: wrapped, decls: transformed.decls, isAsync: true };
				}
				const fallback = code.replace(/\bawait\b/g, "");
				const fallbackError = compileError(fallback);
				if (fallbackError && isRecoverable(fallbackError, fallback)) return { error: new Recoverable(plain) };
			}
			return { error: isRecoverable(plain, code) ? new Recoverable(plain) : plain };
		}

		_defaultEval(input, context, file, cb) {
			if (input === "\n") return cb(null);
			const prepared = this._prepare(input);
			if (prepared.error) return cb(prepared.error);
			let result;
			try {
				this._gen = (this._gen ?? 0) + 1;
				declare(this, prepared.decls, this._gen);
				let source = prepared.source;
				if (this.replMode === REPL_MODE_STRICT && !/^\s*$/.test(source)) source = `'use strict'; void 0;\n${source}`;
				result = runner.call(this.useGlobal ? globalThis : context, makeScope(this, context, this._gen), source);
			} catch (err) {
				// Node runs the REPL in a domain, so what the code throws (even a falsy value) goes straight to the error printer.
				this._onError(err);
				return;
			}
			if (!prepared.isAsync) return cb(null, result);
			this._pause();
			Promise.resolve(result).then(
				(res) => {
					cb(null, res?.value);
					this._unpause();
				},
				(err) => {
					if (err) this._onError(err);
					else cb(err);
					this._unpause();
				}
			);
		}

		_pause() {
			this._paused = true;
		}

		_unpause() {
			if (!this._paused) return;
			this._paused = false;
			let entry;
			while ((entry = this._queue.shift()) !== undefined) {
				if (entry[0] === "close") this.emit("exit");
				else this._key(entry[1]);
				if (this._paused) break;
			}
		}

		/* ---------------------------------------------------------------------------------- lines */

		_memory(cmd) {
			this.lines ||= [];
			this.lines.level ||= [];
			if (cmd) this.lines.push(cmd);
			else {
				this.lines.push("");
				this.lines.level = [];
			}
		}

		_onLine(cmd) {
			const self = this;
			cmd ||= "";
			this._sawSIGINT = false;
			if (this.editorMode) {
				this._buffered += `${cmd}\n`;
				this._memory(cmd);
				return;
			}
			const trimmed = cmd.trim();
			if (trimmed && trimmed[0] === "." && trimmed[1] !== "." && Number.isNaN(Number.parseFloat(trimmed))) {
				const matches = /^\.([^\s]+)\s*(.*)$/.exec(trimmed);
				const command = matches && this.commands[matches[1]];
				if (command) {
					command.action.call(this, matches[2]);
					return;
				}
				if (!this._buffered) {
					this.output.write("Invalid REPL keyword\n");
					finish(null);
					return;
				}
			}
			const evalCmd = `${this._buffered}${cmd}\n`;
			try {
				this.eval(evalCmd, this.context, "REPL", finish);
			} catch (err) {
				finish(err);
			}

			function finish(e, ret) {
				self._memory(cmd);
				if (e && !self._buffered && trimmed.startsWith("npm ") && !(e instanceof Recoverable)) {
					self.output.write("npm should be run outside of the Node.js REPL, in your normal shell.\n(Press Ctrl+D to exit.)\n");
					self.displayPrompt();
					return;
				}
				if (e instanceof Recoverable && !self._sawCtrlD) {
					self._buffered += `${cmd}\n`;
					self.displayPrompt();
					return;
				}
				if (e) self._onError(e.err || e);
				self._buffered = "";
				self._sawCtrlD = false;
				if (!e && arguments.length === 2 && (!self.ignoreUndefined || ret !== undefined)) {
					if (!self.underscoreAssigned) self.last = ret;
					self.output.write(`${self.writer(ret)}\n`);
				}
				if (!self.closed && !e) self.displayPrompt();
			}
		}

		/** Prints an error the way Node does: `Uncaught ` in front, no frames of the REPL itself. */
		_onError(e) {
			let errStack = "";
			if (typeof e === "object" && e !== null) {
				if (typeof e.stack === "string") {
					const at = e.stack.search(/\n\s+at /);
					if (at >= 0) {
						try {
							Object.defineProperty(e, "stack", { value: e.stack.slice(0, at), writable: true, configurable: true, enumerable: false });
						} catch {
							/* a frozen error keeps its frames */
						}
					}
				}
				if (e instanceof Error) {
					errStack = this.writer(e);
					if (errStack[0] === "[" && errStack[errStack.length - 1] === "]") errStack = errStack.slice(1, -1);
				}
			}
			if (!this.underscoreErrAssigned) this.lastError = e;
			if (errStack === "") errStack = this.writer(e);
			const lines = errStack.split(/(?<=\n)/);
			let matched = false;
			errStack = "";
			for (const line of lines) {
				if (!matched && /^\[?([A-Z][a-z0-9_]*)*Error/.test(line)) {
					errStack += writer.options.breakLength >= line.length ? `Uncaught ${line}` : `Uncaught:\n${line}`;
					matched = true;
				} else errStack += line;
			}
			if (!matched) errStack = `Uncaught${lines.length === 1 ? " " : ":\n"}${errStack}`;
			errStack += errStack.endsWith("\n") ? "" : "\n";
			this.output.write(errStack);
			this._buffered = "";
			this.lines.level = [];
			if (!this.closed) this.displayPrompt();
		}

		clearBufferedCommand() {
			this._buffered = "";
		}

		/* ---------------------------------------------------------------------------------- prompt */

		prompt(preserveCursor) {
			if (this.terminal) {
				this._refreshLine();
				return;
			}
			this.output?.write?.(this._prompt);
		}

		displayPrompt(preserveCursor) {
			let prompt = this._initialPrompt;
			if (this._buffered.length) prompt = MULTILINE_PROMPT;
			if (this.editorMode) prompt = "";
			this._prompt = prompt;
			this.prompt(preserveCursor);
		}

		setPrompt(prompt) {
			this._initialPrompt = prompt;
			this._prompt = prompt;
		}

		getPrompt() {
			return this._prompt;
		}

		/** Splits input into lines before running any, so a line that writes more input (`.load`) cannot reorder them. */
		_consume(text) {
			if (this._closed) return;
			const parts = (this._buffer + text).split(/\r\n|\n|\r/);
			this._buffer = parts.pop();
			for (const line of parts) this.emit("line", line);
		}

		/** Text fed to the REPL as if it had been typed (what `.load` relies on). */
		write(data) {
			if (this.terminal) this._ttyWrite(String(data));
			else this._consume(String(data));
		}

		pause() {
			this.input?.pause?.();
			this.emit("pause");
			return this;
		}

		resume() {
			this.input?.resume?.();
			this.emit("resume");
			return this;
		}

		close() {
			process.nextTick(() => {
				if (this._closed) return;
				if (this.terminal) this._detachTerminal();
				super.close();
			});
		}

		defineCommand(keyword, cmd) {
			if (typeof cmd === "function") cmd = { action: cmd };
			else if (typeof cmd?.action !== "function") {
				throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "cmd.action" property must be of type function. Received ${cmd?.action === null ? "null" : typeof cmd?.action}`);
			}
			this.commands[keyword] = cmd;
		}

		_defineDefaultCommands() {
			const turnOn = (repl) => {
				repl.editorMode = true;
				repl._prompt = "";
			};
			const turnOff = (repl) => {
				repl.editorMode = false;
				repl.setPrompt(repl._initialPrompt);
			};
			this.defineCommand("break", {
				help: "Sometimes you get stuck, this gets you out",
				action() {
					this.clearBufferedCommand();
					this.displayPrompt();
				},
			});
			this.defineCommand("clear", {
				help: this.useGlobal ? "Alias for .break" : "Break, and also clear the local context",
				action() {
					this.clearBufferedCommand();
					if (!this.useGlobal) {
						this.output.write("Clearing context...\n");
						this.resetContext();
					}
					this.displayPrompt();
				},
			});
			this.defineCommand("exit", {
				help: "Exit the REPL",
				action() {
					this.close();
				},
			});
			this.defineCommand("help", {
				help: "Print this help message",
				action() {
					const names = Object.keys(this.commands).sort();
					const longest = Math.max(...names.map((name) => name.length));
					for (const name of names) {
						const cmd = this.commands[name];
						this.output.write(`.${name}${cmd.help ? " ".repeat(longest - name.length + 3) + cmd.help : ""}\n`);
					}
					this.output.write("\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n");
					this.displayPrompt();
				},
			});
			const missing = () => nodeError(TypeError, "ERR_MISSING_ARGS", 'The "file" argument must be specified');
			this.defineCommand("save", {
				help: "Save all evaluated commands in this REPL session to a file",
				action(file) {
					try {
						if (file === "") throw missing();
						fs.writeFileSync(file, this.lines.join("\n"));
						this.output.write(`Session saved to: ${file}\n`);
					} catch (error) {
						this.output.write(error?.code === "ERR_MISSING_ARGS" ? `${error.message}\n` : `Failed to save: ${file}\n`);
					}
					this.displayPrompt();
				},
			});
			this.defineCommand("load", {
				help: "Load JS from a file into the REPL session",
				action(file) {
					try {
						if (file === "") throw missing();
						const stats = fs.statSync(file);
						if (stats?.isFile()) {
							turnOn(this);
							this._loading = true;
							const data = fs.readFileSync(file, "utf8");
							this.write(data);
							this._loading = false;
							turnOff(this);
							this.write("\n");
						} else this.output.write(`Failed to load: ${file} is not a valid file\n`);
					} catch (error) {
						this.output.write(error?.code === "ERR_MISSING_ARGS" ? `${error.message}\n` : `Failed to load: ${file}\n`);
					}
					this.displayPrompt();
				},
			});
			if (this.terminal) {
				this.defineCommand("editor", {
					help: "Enter editor mode",
					action() {
						turnOn(this);
						this.output.write("// Entering editor mode (Ctrl+D to finish, Ctrl+C to cancel)\n");
					},
				});
			}
		}

		clearLine() {
			if (this.terminal) this.output.write("\r\n");
			this.line = "";
			this.cursor = 0;
		}

		_onSigint() {
			const empty = this.line.length === 0;
			this.clearLine();
			if (this.editorMode) {
				this.editorMode = false;
				this.setPrompt(this._initialPrompt);
			}
			if (!(this._buffered && this._buffered.length > 0) && empty) {
				if (this._sawSIGINT) {
					this.close();
					this._sawSIGINT = false;
					return;
				}
				this.output.write("(To exit, press Ctrl+C again or Ctrl+D or type .exit)\n");
				this._sawSIGINT = true;
			} else this._sawSIGINT = false;
			this._buffered = "";
			this.lines.level = [];
			this.displayPrompt();
		}

		/* ------------------------------------------------------------------------------- history */

		setupHistory(historyConfig = {}, cb) {
			const options = typeof historyConfig === "string" ? { filePath: historyConfig } : { ...historyConfig };
			if (typeof cb === "function") options.onHistoryFileLoaded = cb;
			if (options.size !== undefined) this.historySize = options.size;
			const done = (err) => {
				if (typeof options.onHistoryFileLoaded === "function") options.onHistoryFileLoaded(err ?? null, this);
			};
			if (Array.isArray(options.history)) this.history = [...options.history];
			let file = options.filePath;
			if (typeof file === "string") file = file.trim();
			if (file === "" || file === undefined) {
				const home = process.env.HOME ?? process.env.USERPROFILE;
				file = home ? path.join(home, ".node_repl_history") : "";
			}
			if (!file) {
				this.output.write("\nError: Could not get the home directory.\nREPL session history will not be persisted.\n");
				return done(null);
			}
			try {
				if (!fs.existsSync(file)) fs.writeFileSync(file, "", { mode: 0o600 });
				const data = fs.readFileSync(file, "utf8");
				const loaded = data ? data.split(/\r?\n+/).slice(0, this.historySize) : [];
				this.history = this.history.length ? [...this.history, ...loaded].slice(0, this.historySize) : loaded;
			} catch {
				this.output.write("\nError: Could not open history file.\nREPL session history will not be persisted.\n");
				return done(null);
			}
			const flush = () => {
				try {
					fs.writeFileSync(file, this.history.join("\n"));
				} catch {
					/* an unwritable history file is not fatal */
				}
				this.emit("flushHistory");
			};
			this.on("line", () => queueMicrotask(flush));
			flush();
			done(null);
		}

		_addHistory() {
			const line = this.line;
			if (!line.length || !line.trim().length || this.historySize === 0) return;
			if (this._buffered && this._historyIndex === -1) this.history.shift();
			if (this.history.length === 0 || this.history[0] !== line) {
				this.history.unshift(line);
				if (this.history.length > this.historySize) this.history.pop();
			}
			this._historyIndex = -1;
			this.emit("history", this.history);
		}

		/* ---------------------------------------------------------------------------- completion */

		complete(...args) {
			return this.completer(...args);
		}

		completeOnEditorMode(callback) {
			return (err, results) => {
				if (err) return callback(err);
				const [completions, completeOn = ""] = results;
				let result = completions.filter(Boolean);
				if (completeOn && result.length !== 0) result = [commonPrefix(result)];
				callback(null, [result, completeOn]);
			};
		}

		_complete(line, callback) {
			let groups = [];
			let completeOn;
			let filter = "";
			line = line.trimStart();
			const done = () => {
				if (groups.length && filter) {
					const lower = filter.toLocaleLowerCase();
					groups = groups.map((g) => g.filter((s) => s.toLocaleLowerCase().startsWith(lower))).filter((g) => g.length);
				}
				const completions = [];
				const seen = new Set([""]);
				for (const group of groups) {
					group.sort((a, b) => (b > a ? 1 : -1));
					const size = seen.size;
					for (const entry of group) {
						if (!seen.has(entry)) {
							completions.unshift(entry);
							seen.add(entry);
						}
					}
					if (seen.size !== size) completions.unshift("");
				}
				if (completions[0] === "") completions.shift();
				callback(null, [completions, completeOn]);
			};
			let match;
			if ((match = /^\s*\.(\w*)$/.exec(line)) !== null) {
				groups.push(Object.keys(this.commands));
				completeOn = match[1];
				if (completeOn.length) filter = completeOn;
			} else if ((match = requireRE.exec(line)) !== null || (match = importRE.exec(line)) !== null) {
				completeOn = match[1];
				filter = completeOn;
				const group = [];
				if (this.allowBlockingCompletions) {
					const subdir = match[2] || "";
					let dirs = [];
					if (completeOn === ".") group.push("./", "../");
					else if (completeOn === "..") group.push("../");
					else if (/^\.\.?\//.test(completeOn)) dirs = [process.cwd()];
					else dirs = moduleModule._nodeModulePaths(process.cwd());
					for (const dir of dirs) {
						let entries = [];
						try {
							entries = fs.readdirSync(path.resolve(dir, subdir), { withFileTypes: true });
						} catch {
							/* no such directory */
						}
						for (const entry of entries) {
							if (/-\d+\.\d+/.test(entry.name) || entry.name === ".npm") continue;
							if (entry.isDirectory()) group.push(`${subdir}${entry.name}/`);
							else {
								const ext = path.extname(entry.name);
								if ([".js", ".json", ".node", ".mjs", ".cjs"].includes(ext)) group.push(`${subdir}${ext ? entry.name.slice(0, -ext.length) : entry.name}`);
							}
						}
					}
				}
				if (group.length) groups.push(group);
				groups.push(builtinLibs, builtinLibs.map((lib) => `node:${lib}`));
			} else if ((match = fsAutoCompleteRE.exec(line)) !== null && this.allowBlockingCompletions) {
				let baseName = "";
				let filePath = match[1];
				let list;
				const read = (p) => {
					try {
						return fs.readdirSync(p, { withFileTypes: true });
					} catch {
						return undefined;
					}
				};
				list = read(filePath);
				if (!list) {
					baseName = path.basename(filePath);
					filePath = path.dirname(filePath);
					list = read(filePath) || [];
				}
				groups = [list.filter((d) => d.name.startsWith(baseName)).map((d) => d.name)];
				completeOn = baseName;
			} else if (line.length === 0 || /\w|\.|\$/.test(line[line.length - 1])) {
				const target = line.length === 0 ? line : findCompleteTarget(line);
				if (line.length !== 0 && !target) return done();
				let expr = "";
				completeOn = target;
				if (line.endsWith(".")) expr = target.slice(0, -1);
				else if (line.length !== 0) {
					const bits = target.split(".");
					filter = bits.pop();
					expr = bits.join(".");
				}
				if (!expr) {
					groups.push([...this._lexical.keys()]);
					let proto = this.context;
					while ((proto = Object.getPrototypeOf(proto)) !== null) groups.push(filteredOwnPropertyNames(proto));
					const own = filteredOwnPropertyNames(this.context);
					if (!this.useGlobal) own.push(...V8_GLOBALS);
					groups.push(own);
					if (filter !== "") groups.push(COMMON_WORDS);
					return done();
				}
				return this._completeMembers(expr, filter, (memberGroups, newFilter) => {
					groups.push(...memberGroups);
					filter = newFilter;
					done();
				});
			}
			return done();
		}

		_completeMembers(expr, filter, cb) {
			let chaining = ".";
			if (expr.endsWith("?")) {
				expr = expr.slice(0, -1);
				chaining = "?.";
			}
			// Nothing on the way may be a getter or a Proxy: completing must not run user code.
			const evalSafe = (code, then) => this.eval(`try { ${code} } catch {}`, this.context, "REPL", then);
			const chain = expr.split(/\??\./);
			const pure = chain.every((p) => /^[A-Za-z_$][\w$]*$/.test(p));
			const proceed = () => {
				evalSafe(expr, (_e, obj) => {
					const memberGroups = [];
					try {
						let p;
						if ((typeof obj === "object" && obj !== null) || typeof obj === "function") {
							memberGroups.push(filteredOwnPropertyNames(obj));
							p = Object.getPrototypeOf(obj);
						} else p = obj.constructor ? obj.constructor.prototype : null;
						let sentinel = 5;
						while (p !== null && sentinel-- !== 0) {
							memberGroups.push(filteredOwnPropertyNames(p));
							p = Object.getPrototypeOf(p);
						}
					} catch {
						/* a value without properties has nothing to offer */
					}
					const out = [];
					if (memberGroups.length) {
						const prefix = expr + chaining;
						for (const group of memberGroups) out.push(group.map((m) => `${prefix}${m}`));
						if (filter) filter = `${prefix}${filter}`;
					}
					cb(out, filter);
				});
			};
			if (!pure) return proceed();
			let current;
			let index = 0;
			const step = () => {
				if (index >= chain.length) return proceed();
				const name = chain[index];
				if (index === 0) {
					evalSafe(name, (_e, obj) => {
						if (isProxy(obj)) return cb([], filter);
						current = obj;
						index++;
						step();
					});
					return;
				}
				if (current === null || current === undefined) return proceed();
				let unsafe = false;
				try {
					const d = Object.getOwnPropertyDescriptor(Object(current), name);
					unsafe = typeof d?.get === "function" || (d && "value" in d && isProxy(d.value));
					if (!unsafe && !d) {
						// an inherited getter is as unsafe as an own one
						let p = Object.getPrototypeOf(Object(current));
						while (p && !unsafe) {
							const pd = Object.getOwnPropertyDescriptor(p, name);
							if (pd) unsafe = typeof pd.get === "function";
							if (pd) break;
							p = Object.getPrototypeOf(p);
						}
					}
				} catch {
					unsafe = false;
				}
				if (unsafe) return cb([], filter);
				current = current[name];
				index++;
				step();
			};
			step();
		}

		/* --------------------------------------------------------------------------------- terminal */

		_attachTerminal() {
			this._onData = (chunk) => this._ttyWrite(typeof chunk === "string" ? chunk : Buffer_toString(chunk));
			this._onEnd = () => this.close();
			this.input.on("data", this._onData);
			this.input.on("end", this._onEnd);
			try {
				this.input.setRawMode?.(true);
			} catch {
				/* not a TTY after all */
			}
			// The terminal in raw mode still turns Ctrl+C into SIGINT on this engine; the key is what the REPL wants.
			if (typeof signal === "function" && this.input === process.stdin) {
				try {
					signal(2, () => this._key("\x03"));
					this._signalHandled = true;
				} catch {
					/* no signal support on this platform */
				}
			}
			this.input.resume?.();
		}

		_detachTerminal() {
			if (this._signalHandled) {
				try {
					signal(2, null);
				} catch {
					/* nothing to restore */
				}
				this._signalHandled = false;
			}
			this.input.removeListener?.("data", this._onData);
			this.input.removeListener?.("end", this._onEnd);
			try {
				this.input.setRawMode?.(false);
			} catch {
				/* not a TTY after all */
			}
			this.input.pause?.();
		}

		_refreshLine() {
			const prompt = this._prompt;
			this.output.write(`\r\x1b[0J${prompt}${this.line}`);
			if (this.cursor < this.line.length) this.output.write(`\r\x1b[${prompt.length + this.cursor + 1}G`);
		}

		_ttyWrite(data) {
			const keys = data.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b.|[\s\S]/gu) ?? [];
			for (const key of keys) this._key(key);
		}

		_key(key) {
			if (this._paused) {
				this._queue.push(["key", key]);
				return;
			}
			const lastWasTab = this._lastKey === "\t";
			this._lastKey = key;
			switch (key) {
				case "\r":
				case "\n": {
					const line = this.line;
					this.output.write("\r\n");
					if (!this.editorMode) this._addHistory();
					this.line = "";
					this.cursor = 0;
					this._historyIndex = -1;
					this.emit("line", line);
					return;
				}
				case "\x7f":
				case "\b":
					if (this.cursor > 0) {
						this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
						this.cursor--;
						this._refreshLine();
					}
					return;
				case "\x03":
					if (this.listenerCount("SIGINT") > 0) this.emit("SIGINT");
					return;
				case "\x04":
					if (this.editorMode && this.terminal) {
						this.editorMode = false;
						this.setPrompt(this._initialPrompt);
						this._sawCtrlD = true;
						this.output.write("\r\n");
						this.emit("line", this.line);
						this.line = "";
						this.cursor = 0;
					} else if (this.line.length === 0) {
						this.clearLine();
						this.close();
					} else if (this.cursor < this.line.length) {
						this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
						this._refreshLine();
					}
					return;
				case "\t":
					this._tabComplete(lastWasTab);
					return;
				case "\x01":
				case "\x1b[H":
				case "\x1bOH":
					this._moveCursor(-this.cursor);
					return;
				case "\x05":
				case "\x1b[F":
				case "\x1bOF":
					this._moveCursor(this.line.length - this.cursor);
					return;
				case "\x0b":
					this.line = this.line.slice(0, this.cursor);
					this._refreshLine();
					return;
				case "\x15":
					this.line = this.line.slice(this.cursor);
					this.cursor = 0;
					this._refreshLine();
					return;
				case "\x17": {
					const before = this.line.slice(0, this.cursor).replace(/\S+\s*$/, "");
					this.line = before + this.line.slice(this.cursor);
					this.cursor = before.length;
					this._refreshLine();
					return;
				}
				case "\x0c":
					this.output.write("\x1b[1;1H\x1b[0J");
					this._refreshLine();
					return;
				case "\x1b[D":
					this._moveCursor(-1);
					return;
				case "\x1b[C":
					this._moveCursor(1);
					return;
				case "\x1b[3~":
					if (this.cursor < this.line.length) {
						this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
						this._refreshLine();
					}
					return;
				case "\x1b[A":
				case "\x1b[B": {
					if (this.editorMode) return;
					const up = key === "\x1b[A";
					const next = this._historyIndex + (up ? 1 : -1);
					if (next < -1 || next >= this.history.length) return;
					this._historyIndex = next;
					this.line = next === -1 ? "" : this.history[next];
					this.cursor = this.line.length;
					this._refreshLine();
					return;
				}
				default:
					if (key.length > 0 && key[0] >= " " && !key.startsWith("\x1b")) this._insert(key);
			}
		}

		_tabComplete(lastKeypressWasTab) {
			const beforeCursor = this.line.slice(0, this.cursor);
			this.completer(beforeCursor, (err, value) => {
				if (err) {
					this.output.write(`Tab completion error: ${inspect(err)}`);
					return;
				}
				const [completions, completeOn = ""] = value ?? [[], ""];
				if (!completions || completions.length === 0) return;
				const prefix = commonPrefix(completions.filter((e) => e !== ""));
				if (prefix.startsWith(completeOn) && prefix.length > completeOn.length) {
					this._insert(prefix.slice(completeOn.length));
					return;
				}
				if (!completeOn.startsWith(prefix)) {
					this.line = this.line.slice(0, this.cursor - completeOn.length) + prefix + this.line.slice(this.cursor);
					this.cursor = this.cursor - completeOn.length + prefix.length;
					this._refreshLine();
					return;
				}
				if (!lastKeypressWasTab) return;
				const width = Math.max(...completions.map((e) => e.length)) + 2;
				let maxColumns = Math.floor((this.output.columns || Number.POSITIVE_INFINITY) / width) || 1;
				if (maxColumns === Number.POSITIVE_INFINITY) maxColumns = 1;
				let text = "\r\n";
				let lineIndex = 0;
				let whitespace = 0;
				for (const completion of completions) {
					if (completion === "" || lineIndex === maxColumns) {
						text += "\r\n";
						lineIndex = 0;
						whitespace = 0;
					} else text += " ".repeat(whitespace);
					if (completion !== "") {
						text += completion;
						whitespace = width - completion.length;
						lineIndex++;
					} else text += "\r\n";
				}
				if (lineIndex !== 0) text += "\r\n\r\n";
				this.output.write(text);
				this._refreshLine();
			});
		}

		_moveCursor(delta) {
			const target = Math.max(0, Math.min(this.line.length, this.cursor + delta));
			const moved = target - this.cursor;
			this.cursor = target;
			if (moved) this.output.write(`\x1b[${Math.abs(moved)}${moved < 0 ? "D" : "C"}`);
		}

		/** Inserts text at the cursor: at the end of the line only the new text is echoed. */
		_insert(text) {
			const atEnd = this.cursor === this.line.length;
			this.line = this.line.slice(0, this.cursor) + text + this.line.slice(this.cursor);
			this.cursor += text.length;
			if (atEnd) this.output.write(text);
			else this._refreshLine();
		}
	}

	const Buffer_toString = (chunk) => (typeof chunk?.toString === "function" ? chunk.toString("utf8") : String(chunk));

	const repl = {
		start: (prompt, source, eval_, useGlobal, ignoreUndefined, replMode) =>
			new REPLServer(prompt, source, eval_, useGlobal, ignoreUndefined, replMode),
		writer,
		REPLServer,
		REPL_MODE_SLOPPY,
		REPL_MODE_STRICT,
		Recoverable,
		isValidSyntax,
	};
	for (const name of ["builtinModules", "_builtinLibs"]) {
		Object.defineProperty(repl, name, {
			get: () => builtinLibs,
			set: (value) => {
				builtinLibs = value;
			},
			enumerable: false,
			configurable: true,
		});
	}
	return repl;
}

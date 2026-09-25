// node:repl: a REPLServer driven over PassThrough streams; the transcript it writes must match Node's.
const repl = require("node:repl");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repl-corpus-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const show = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
// Error messages of a syntax error are the engine's own words: what is compared is that the REPL called it one.
const gist = (out) => out.split(tmp).join("<tmp>").replace(/Uncaught SyntaxError[^\n]*\n(?:[^>|\n][^\n]*\n)*/g, "Uncaught SyntaxError\n");

function start(options = {}) {
	const input = new PassThrough();
	const output = new PassThrough();
	const box = { out: "", exited: false, closed: false };
	output.on("data", (d) => {
		box.out += d;
	});
	const server = repl.start({ input, output, terminal: false, ...options });
	server.on("exit", () => {
		box.exited = true;
	});
	server.on("close", () => {
		box.closed = true;
	});
	return { input, output, server, box };
}

// Feeds lines one at a time and lets the evaluation (a promise, a timer) settle before the next.
async function feed(session, lines, gap = 25) {
	for (const line of lines) {
		session.input.write(`${line}\n`);
		await sleep(gap);
	}
}

async function transcript(label, lines, options, after) {
	const session = start(options);
	await after?.pre?.(session);
	await feed(session, lines);
	await after?.post?.(session);
	session.input.end();
	await sleep(30);
	show(label, gist(session.box.out));
	show(`${label} exited`, [session.box.exited, session.box.closed, session.server.closed]);
	return session;
}

async function main() {
	// Values and how the writer shows them.
	await transcript("values", [
		"1 + 1",
		"'text'",
		"null",
		"undefined",
		"true",
		"[1, 2, 3].map((x) => x * 2)",
		"({ a: 1, b: { c: [1, 2] } })",
		"new Map([[1, 'a']])",
		"new Set([1, 2])",
		"Symbol('s')",
		"123n",
		"-0",
		"0.1 + 0.2",
		"[1, , 3]",
		"(function () {})",
		"(() => 1)",
		"class Foo {}",
		"new Foo()",
		"/re/gi",
		"new Date(0).toISOString()",
		"`template ${1 + 1}`",
		"Math.max(1, 5, 3)",
		"JSON.stringify({ a: [1, 2] })",
		"[...'abc']",
		"Object.keys({ x: 1, y: 2 })",
		"typeof undefinedThing",
		"typeof 5",
	]);

	// Declarations survive from line to line, with a real script scope's rules.
	await transcript("declarations", [
		"var a = 1",
		"a + 1",
		"let b = 2",
		"const c = a + b",
		"c",
		"function add(x, y) { return x + y }",
		"add(a, b)",
		"class Point { constructor(x) { this.x = x } }",
		"new Point(3).x",
		"var { p, q = 5 } = { p: 1 }",
		"p + q",
		"let [m, n] = [10, 20]",
		"m + n",
		"const arrow = (x) => x * 3",
		"arrow(4)",
		"var v1 = 1, v2 = 2",
		"v1 + v2",
		"const k = 1; const l = 2; k + l",
		"let dup = 1",
		"let dup = 2",
		"dup",
		"c = 5",
		"c",
		"var d1",
		"d1",
		"x9 = 4",
		"x9",
		"globalThis.viaGlobal = 8",
		"viaGlobal",
		"this === globalThis",
		"typeof module",
		"typeof exports",
	]);

	// Errors are printed with `Uncaught`, and `_error` keeps the last one.
	await transcript("errors", [
		"foo.bar",
		"throw new Error('boom')",
		"throw new TypeError('bad')",
		"throw 5",
		"throw 'text'",
		"throw { a: 1 }",
		"throw null",
		"throw undefined",
		"_error === undefined",
		"1 +",
		"2",
		"var ok = 1",
		"ok",
	]);

	// A syntax error is reported as one and the session goes on (the engine's own words are not compared).
	const syntax = start();
	await feed(syntax, ["var 5", "1 +* 2", "let ok1 = 1", "ok1", ")", "'unterminated", "2"]);
	show("syntax errors", [(syntax.box.out.match(/Uncaught SyntaxError/g) || []).length, syntax.box.out.endsWith("> 2\n> ")]);
	syntax.input.end();
	await sleep(20);

	// `_` holds the last value until it is assigned to.
	await transcript("underscore", ["1 + 1", "_", "_ * 2", "_ = 9", "1 + 3", "_", "_error", "throw new Error('x')", "_error = 3", "_error"]);

	// Multi-line input continues until the code is complete.
	await transcript("multiline", [
		"function f() {",
		"  return 1",
		"}",
		"f()",
		"({",
		"  a: 1,",
		"  b: [",
		"    2",
		"  ]",
		"})",
		"const t = `line1",
		"line2`",
		"t",
		"if (true) {",
		"  'yes'",
		"} else {",
		"  'no'",
		"}",
		"[1, 2,",
		"3]",
		"(1 +",
		"2)",
		"const obj = {",
		"  m() {",
		"    return 'method'",
		"  }",
		"}",
		"obj.m()",
		"/* comment",
		"still */ 5",
		"{",
		"}",
		"{ a: 1 }",
		"{}",
		"",
		"   ",
		".break",
	]);

	// Object literals are values, blocks are blocks.
	await transcript("literals", ["{ a: 1, b: 2 }", "{ a: 1 };", "{ let z = 1; z + 1 }", "{}", "({}).constructor === Object"]);

	// The dot commands.
	const dots = await transcript(
		"commands",
		[".help", ".foo", "var x = 1", ".break", "function g() {", ".break", "1", ".clear", "typeof x", ".exit", "unreached"],
		{},
		{
			pre: (s) => {
				s.server.on("reset", (ctx) => show("reset event", [typeof ctx, "x" in ctx]));
			},
		}
	);
	show("commands names", Object.keys(dots.server.commands).sort());

	// .save and .load go through files.
	const saved = path.join(tmp, "session.js");
	fs.writeFileSync(path.join(tmp, "load.js"), "var loaded = 41;\nfunction inc(n) {\n  return n + 1;\n}\ninc(loaded)\n");
	await transcript("save-load", [
		"var s1 = 3",
		"s1 * 2",
		`.save ${saved}`,
		`.load ${path.join(tmp, "load.js")}`,
		"loaded",
		"inc(1)",
		`.load ${path.join(tmp, "missing.js")}`,
		`.load ${tmp}`,
		".save",
		".load",
	]);
	show("saved file", fs.readFileSync(saved, "utf8"));

	// defineCommand.
	await transcript("defineCommand", [".hello world", ".shout", ".help"], {}, {
		pre: (s) => {
			s.server.defineCommand("hello", {
				help: "Say hello",
				action(name) {
					this.output.write(`hello ${name}\n`);
					this.displayPrompt();
				},
			});
			s.server.defineCommand("shout", function () {
				this.output.write("SHOUT\n");
				this.displayPrompt();
			});
		},
	});
	try {
		start().server.defineCommand("bad", { help: "x" });
	} catch (err) {
		show("defineCommand invalid", [err.name, err.code]);
	}

	// Top-level await.
	await transcript("await", [
		"await Promise.resolve(4)",
		"await 1 + 2",
		"const awaited = await Promise.resolve('v')",
		"awaited",
		"await new Promise((r) => setTimeout(() => r('late'), 5))",
		"var w1 = await 7; w1 + 1",
		"function af() { return 1 }",
		"await af()",
		"for await (const item of [Promise.resolve(1)]) { item }",
		"await Promise.reject(5)",
		"await Promise.reject('rej')",
		"await (async () => { return await 9 })()",
		"let [aw1, aw2] = await Promise.all([1, 2]); aw1 + aw2",
		"_",
	]);

	// The context: what the code sees and what the program can put there.
	const ctxSession = start();
	const preset = new Set(Object.keys(ctxSession.server.context));
	ctxSession.server.context.answer = 42;
	ctxSession.server.context.double = (n) => n * 2;
	await feed(ctxSession, [
		"answer",
		"double(answer)",
		"var made = 'in repl'",
		"answer = 43",
		"require('node:os') === require('os')",
		"typeof fs",
		"typeof path.join",
		"fs === require('fs')",
		"require('node:path').basename('/a/b.txt')",
		"module.id",
		"typeof require.resolve",
		"typeof console.log",
		"console.log('to the repl output')",
		"typeof process.version",
		"typeof Buffer.from",
		"typeof setTimeout",
		"global === globalThis",
		"typeof notThere",
	]);
	show("context transcript", ctxSession.box.out);
	show("context values", [ctxSession.server.context.answer, ctxSession.server.context.made]);
	const userKeys = Object.keys(ctxSession.server.context).filter((k) => !preset.has(k));
	show("context user keys", userKeys);
	show("lines", ctxSession.server.lines.length > 0);
	ctxSession.input.end();
	await sleep(20);

	// Options.
	await transcript("prompt", ["1", "{", "2", "}"], { prompt: "$ " });
	await transcript("ignoreUndefined", ["undefined", "var iu = 1", "iu", "null"], { ignoreUndefined: true });
	await transcript("writer", ["1", "'a'", "[1]", "throw new Error('w')"], { writer: (v) => `<<${typeof v}:${String(v)}>>` });
	await transcript("eval", ["abc", "", "  sp", "a b"], {
		eval: (cmd, context, filename, callback) => {
			callback(null, `E:${JSON.stringify(cmd)}:${typeof context}`);
		},
	});
	await transcript("eval-error", ["x"], {
		eval: (cmd, context, filename, callback) => {
			callback("from eval");
		},
	});
	await transcript("strict", ["undeclared = 1", "var strictVar = 2", "strictVar", "let sl = 3", "sl", "this === undefined"], { replMode: repl.REPL_MODE_STRICT });
	const sloppy = await transcript("sloppy", ["sloppyGlobal = 1", "sloppyGlobal"], { replMode: repl.REPL_MODE_SLOPPY });
	show("modes", [sloppy.server.replMode === repl.REPL_MODE_SLOPPY, repl.REPL_MODE_SLOPPY.toString(), repl.REPL_MODE_STRICT.toString()]);

	// useGlobal: the code runs in the program's own global.
	const globalSession = start({ useGlobal: true });
	await feed(globalSession, ["var viaRepl = 12", "this === globalThis", "globalThis.viaRepl", ".help", "replGlobalSet = 3"]);
	show("useGlobal transcript", globalSession.box.out);
	show("useGlobal", [globalSession.server.context === globalThis, globalThis.viaRepl, globalThis.replGlobalSet, globalSession.server.useGlobal]);
	globalSession.input.end();
	await sleep(20);
	delete globalThis.viaRepl;
	delete globalThis.replGlobalSet;

	// Properties of the server object.
	const props = start({ prompt: "> ", historySize: 7 });
	show("props", [
		props.server.terminal,
		props.server.useGlobal,
		props.server.ignoreUndefined,
		props.server.underscoreAssigned,
		props.server.editorMode,
		props.server.historySize,
		Array.isArray(props.server.lines),
		props.server.history,
		props.server.input === props.input,
		props.server.output === props.output,
		typeof props.server.getPrompt(),
		props.server instanceof require("node:readline").Interface,
		props.server instanceof require("node:events"),
		typeof props.server.displayPrompt,
		typeof props.server.setupHistory,
		typeof props.server.defineCommand,
		typeof props.server.complete,
		typeof props.server.clearBufferedCommand,
		typeof props.server.resetContext,
		typeof props.server.createContext,
	]);
	props.server.setPrompt("new> ");
	props.server.displayPrompt();
	show("setPrompt", [props.server.getPrompt(), props.box.out]);
	props.server.close();
	await sleep(20);
	show("close", [props.box.exited, props.box.closed, props.server.closed]);

	// End of input ends the REPL; a last line without a newline still runs.
	const ending = start();
	ending.input.write("1 + 1\n2 + 2");
	ending.input.end();
	await sleep(30);
	show("end without newline", [ending.box.out, ending.box.exited]);

	// Tab completion.
	const completer = start();
	completer.server.context.myObj = { alpha: 1, beta: { gamma: 2 }, alpine: 3 };
	completer.server.context.myNum = 5;
	completer.server.context.myList = [1, 2, 3];
	completer.server.context.withGetter = Object.defineProperty({}, "risky", { get() { throw new Error("must not run"); }, enumerable: true });
	await feed(completer, ["var localVar = { one: 1, two: 2 }", "let lexicalOne = 1", "const lexicalTwo = 2"]);
	for (const line of [
		"myO",
		"myObj.al",
		"myObj.alp",
		"myObj.beta.ga",
		"myObj.",
		"myNum.toF",
		"myList.ma",
		"myList.fil",
		"localVar.t",
		"localVar.",
		"lexical",
		"Ma",
		"Ar",
		"json",
		"fs.readF",
		"path.jo",
		"os.hostn",
		"process.ver",
		"[1, 2].ma",
		"'str'.sl",
		"withGetter.ri",
		"nothing.at.all.",
		"1 + myN",
		"x = myO",
		".",
		".he",
		".b",
		"require('pat",
		"require('node:pat",
		"const z = myObj.be",
		"foo(",
		"1 +",
	]) {
		await new Promise((resolve) => {
			completer.server.complete(line, (err, result) => {
				const [list, on] = result ?? [];
				show(`complete ${JSON.stringify(line)}`, [err, list, on]);
				resolve();
			});
		});
	}
	completer.input.end();
	await sleep(20);

	// A completer of the program's own.
	const own = start({ completer: (line, cb) => cb(null, [["one", "two"].filter((c) => c.startsWith(line)), line]) });
	await new Promise((resolve) => own.server.complete("t", (err, result) => (show("own completer", [err, result]), resolve())));
	own.input.end();
	await sleep(20);

	// Builtin libraries on the context and in the module.
	show("builtinModules", [
		Array.isArray(repl.builtinModules),
		["fs", "path", "os", "util", "events", "http", "crypto", "readline", "repl", "vm", "zlib", "stream"].every((m) => repl.builtinModules.includes(m)),
		repl.builtinModules.every((m) => typeof m === "string" && !m.startsWith("_") && !m.startsWith("node:")),
		repl.builtinModules.includes("node:test"),
		Object.keys(repl),
	]);
	const desc = Object.getOwnPropertyDescriptor(repl, "builtinModules");
	show("builtinModules descriptor", [desc.enumerable, desc.configurable, typeof desc.get]);

	// Recoverable and the syntax check.
	const recoverable = new repl.Recoverable(new SyntaxError("inner"));
	show("Recoverable", [recoverable instanceof SyntaxError, recoverable instanceof repl.Recoverable, recoverable.err.message]);
	show("isValidSyntax", [repl.isValidSyntax("1 + 1"), repl.isValidSyntax("1 +"), repl.isValidSyntax("{ a: 1 }"), repl.isValidSyntax("var a = 1;")]);
	show("writer", [repl.writer({ a: [1, 2, { b: 3 }] }), repl.writer("s"), repl.writer(5n), typeof repl.writer.options]);
	show("shape", [typeof repl.start, typeof repl.REPLServer, typeof repl.REPL_MODE_SLOPPY, typeof repl.REPL_MODE_STRICT]);

	// History file.
	const historyFile = path.join(tmp, "history");
	fs.writeFileSync(historyFile, "third\nsecond\nfirst\n");
	const hist = start({ historySize: 10 });
	await new Promise((resolve) => hist.server.setupHistory(historyFile, (err, server) => (show("history loaded", [err, server === hist.server, hist.server.history]), resolve())));
	hist.input.end();
	await sleep(20);
	const noHistory = start();
	show("history none", noHistory.server.history);
	noHistory.input.end();
	await sleep(20);

	// A terminal: keystrokes in, escape codes stripped out.
	const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
	const term = start({ terminal: true, preview: false, useColors: false });
	show("terminal flags", [term.server.terminal, term.server.useColors]);
	for (const chunk of ["1+", "1", "\r", "var tv = 5\r", "tv * 2\r", "\x1b[A", "\r", "  ", "\x7f\x7f", "tv", "\r", "\x1b[A\x1b[A\x1b[A", "\r"]) {
		term.input.write(chunk);
		await sleep(15);
	}
	show("terminal transcript", strip(term.box.out));
	show("terminal history", term.server.history);
	term.input.write("\x04");
	await sleep(30);
	show("terminal ctrl-d", [term.box.exited, term.box.closed]);
	const term2 = start({ terminal: true, preview: false });
	for (const chunk of ["ab", "\x03", "\x03", "\x03"]) {
		term2.input.write(chunk);
		await sleep(15);
	}
	await sleep(30);
	show("terminal ctrl-c", [strip(term2.box.out), term2.box.exited]);

	// More declaration and statement shapes.
	await transcript("statements", [
		"let x = 1, y = x + 1",
		"y",
		"const { a } = { a: 5 }, b = 2",
		"a + b",
		"var f = function () { return 1 }",
		"f()",
		"const fn = async () => { await 1; return 2 }",
		"let z; z = 3; z",
		"class A { static s = 1; get g() { return 2 } }",
		"A.s + new A().g",
		"for (let i = 0; i < 3; i++) {}",
		"typeof i",
		"for (var j = 0; j < 3; j++) {}",
		"j",
		"if (true) { var inBlock = 1 }",
		"inBlock",
		"if (true) { let scoped = 1 }",
		"typeof scoped",
		";",
		"1;;",
		"// just a comment",
		"/* c */",
		"a; b",
		"let l1 = 1; l1++; l1",
		"const c9 = 1; c9++",
		"var v9 = 1; var v9 = 2; v9",
		"function dup() { return 1 }; function dup() { return 2 }; dup()",
		"label: for (;;) { break label }",
		"1, 2, 3",
		"void 0",
		"typeof typeof 1",
		"'x'.repeat(3)",
		"[...'ab'].map((c) => c.toUpperCase())",
		"(function () { return typeof this })()",
		"(function () { 'use strict'; return typeof this })()",
		"Object.assign({}, { q: 1 })",
		"a = 10",
		"a",
		"delete globalThis.a",
		"typeof a",
		"this.x = 1",
		"this.x",
		"var self = this; self === globalThis",
		"'x' in globalThis",
		"globalThis.hasOwnProperty('x')",
	]);
	await transcript("redeclare", ["let a1 = 1", "let a1 = 2", "var a1 = 3", "const k1 = 1", "var k1 = 2", "function k2() {}", "let k2 = 1", "class K3 {}", "class K3 {}", "var K3", "let t1 = t1", "t1", "let t2 = (() => { throw 1 })()", "t2", "let t2 = 5", "const t3 = (() => { throw 2 })()", "t3", "let t5 = 1, t6 = (() => { throw 3 })()", "t5", "t6"]);
	await transcript("await more", [
		"const o = {",
		"a: 1,",
		"get b() { return 2 },",
		"c: [1,",
		"2]",
		"}",
		"o",
		"o.b",
		"async function af() { return 5 }",
		"await af()",
		"await af().then((v) => v + 1)",
		"const p = new Promise((r) => r(4)); await p",
		"var q = await p; q",
		"for await (const v of (async function* () { yield 1; yield 2 })()) { console.log(v) }",
		"await Promise.all([1, Promise.resolve(2)])",
		"await (async () => 3)()",
		"[await 1, await 2]",
		"({ v: await 3 })",
		"await 1; await 2",
		"if (await true) { 'yes' }",
		"try { await Promise.reject(1) } catch (e) { 'caught ' + e }",
	]);
	await transcript("dots", ["1 + 1", ".help", "", " .break", ".5", ".5 + 1", ".9", ". 5", ".exit foo", "after"]);
	await transcript("empty prompt", ["a.b.c", "x", "var x = 1", "x."], { prompt: "" });
	await transcript("unicode prompt", ["1", "2"], { prompt: "λ> " });
	await transcript("console", [
		"console.log('a', 'b', { c: 1 })",
		"console.error('err')",
		"console.dir({ a: { b: { c: { d: 1 } } } }, { depth: 0 })",
		"console.group('g'); console.log('in'); console.groupEnd()",
		"typeof process.exit",
	]);

	// A terminal with Tab completion and the editor.
	const term3 = start({ terminal: true, preview: false });
	term3.server.context.myObj = { alpha: 1, alpine: 2 };
	term3.server.context.myVar = 1;
	for (const chunk of ["myV", "\t", "\r", "myObj.al", "\t", "\t", "\t", "\x15", "Ma", "\t", "\t", "\x15", "12", "\x1b[D", "3", "\r"]) {
		term3.input.write(chunk);
		await sleep(15);
	}
	show("terminal tab", strip(term3.box.out));
	show("terminal tab line", [term3.server.line, term3.server.cursor]);
	term3.input.end();
	await sleep(20);
	const editor = start({ terminal: true, preview: false });
	for (const chunk of [".editor\r", "function twice(n) {\r", "  return n * 2;\r", "}\r", "twice(21)\r", "\x04", "twice(4)\r"]) {
		editor.input.write(chunk);
		await sleep(15);
	}
	show("terminal editor", strip(editor.box.out));
	show("terminal editor mode", editor.server.editorMode);
	editor.input.end();
	await sleep(20);
	const editorCancel = start({ terminal: true, preview: false });
	for (const chunk of [".editor\r", "1 + 1\r", "\x03", "2 + 2\r"]) {
		editorCancel.input.write(chunk);
		await sleep(15);
	}
	show("terminal editor cancel", strip(editorCancel.box.out));
	editorCancel.input.end();
	await sleep(20);

	// Colors, the legacy signature, and options that cannot be combined.
	const colored = start({ useColors: true });
	await feed(colored, ["1", "'a'", "[true, null]", "throw new Error('c')"]);
	show("colors", colored.box.out);
	show("colors writer", [colored.server.useColors, repl.writer.options.colors]);
	colored.input.end();
	await sleep(20);
	const legacyIn = new PassThrough();
	const legacyOut = new PassThrough();
	let legacy = "";
	legacyOut.on("data", (d) => {
		legacy += d;
	});
	const legacyServer = repl.start("legacy> ", { stdin: legacyIn, stdout: legacyOut }, undefined, false, true);
	legacyIn.write("1\nundefined\n");
	await sleep(30);
	show("legacy signature", [legacy, legacyServer.ignoreUndefined, legacyServer.terminal]);
	legacyIn.end();
	await sleep(20);
	try {
		start({ breakEvalOnSigint: true, eval: () => {} });
	} catch (err) {
		show("breakEvalOnSigint with eval", [err.name, err.code, err.message]);
	}
	// The server object's own eval, called directly.
	const direct = start();
	await new Promise((resolve) => direct.server.eval("6 * 7\n", direct.server.context, "direct", (err, value) => (show("direct eval", [err, value]), resolve())));
	direct.input.end();
	await sleep(20);

	fs.rmSync(tmp, { recursive: true, force: true });
}

main().then(
	() => process.exit(0),
	(err) => {
		console.log("FAILED", err);
		process.exit(1);
	}
);

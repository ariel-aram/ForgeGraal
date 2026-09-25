// node:inspector: an in-process Session evaluating expressions and reading objects, with V8's protocol shapes.
const inspector = require("node:inspector");
const inspectorPromises = require("node:inspector/promises");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const show = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);

// Object ids, script ids and V8's own frames in error text differ per process; the rest of the shape is compared.
function norm(value, key) {
	if (Array.isArray(value)) return value.map((v) => norm(v));
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = norm(v, k);
		if (out.subtype === "error" && typeof out.description === "string") out.description = out.description.split("\n")[0];
		if (out.subtype === "date") out.description = "<date>";
		if (out.type === "function" && typeof out.description === "string" && out.description.includes("[native code]")) out.description = "<native>";
		return out;
	}
	if (key === "objectId" || key === "scriptId") return `<${key}>`;
	return value;
}
const clean = (err, result) => [err && [err.name, err.code, err.message], norm(result)];

function open() {
	const session = new inspector.Session();
	session.connect();
	return session;
}
const post = (session, method, params) => {
	let answer;
	session.post(method, params, (err, result) => {
		answer = clean(err, result);
	});
	return answer;
};
const postAsync = (session, method, params) =>
	new Promise((resolve) => session.post(method, params, (err, result) => resolve(clean(err, result))));

async function main() {
	show("exports", [Object.keys(inspector), inspector.url(), typeof inspector.Session]);
	show("console", [Object.keys(inspector.console), typeof inspector.console.log, inspector.console.log("nothing is printed")]);
	show("namespaces", [Object.keys(inspector.Network), Object.keys(inspector.NetworkResources), Object.keys(inspector.DOMStorage)]);
	show("promises exports", [Object.keys(inspectorPromises), inspectorPromises.Session !== inspector.Session]);
	try {
		inspector.waitForDebugger();
	} catch (err) {
		show("waitForDebugger", [err.name, err.code, err.message]);
	}
	show("close", inspector.close());

	// Connecting.
	const session = new inspector.Session();
	show("session", [session instanceof require("node:events"), typeof session.connect, typeof session.post, typeof session.disconnect]);
	try {
		session.post("Runtime.evaluate", { expression: "1" });
	} catch (err) {
		show("post before connect", [err.name, err.code, err.message]);
	}
	session.connect();
	try {
		session.connect();
	} catch (err) {
		show("connect twice", [err.name, err.code, err.message]);
	}
	for (const bad of [[5], ["Runtime.evaluate", 5], ["Runtime.evaluate", {}, 5], [null]]) {
		try {
			session.post(...bad);
		} catch (err) {
			show("post invalid", [err.name, err.code, err.message]);
		}
	}

	// Runtime.evaluate: primitives and objects.
	for (const expression of [
		"1 + 1", "'text'", "'a\\nb'", "undefined", "null", "true", "NaN", "Infinity", "-0", "1e21", "5n ** 20n", "Symbol('q')", "Symbol.iterator",
		"[1, 2, 3]", "[]", "({ a: 1 })", "({})", "Object.create(null)", "new Map([[1, 2]])", "new Set([1])", "new WeakMap()", "/re/g", "new Date(0)",
		"(function foo(a) { return a })", "(() => 1)", "(async () => {})", "class A {}", "new (class B {})()", "new Error('x')", "new TypeError('t')",
		"Promise.resolve(1)", "new Proxy({}, {})", "new Uint8Array(2)", "new ArrayBuffer(4)", "new DataView(new ArrayBuffer(2))", "(function* () {})()",
		"new Number(1)", "new String('a')", "new Boolean(false)", "[1, [2]]", "let lexA = 1", "const lexB = 2; lexB", "var varA = 3", "typeof varA",
		"lexA + lexB + varA", "this === globalThis", "1;\n2", "if (true) { 'block' }", "({ a: 1 }).a",
	]) {
		show(`evaluate ${JSON.stringify(expression)}`, post(session, "Runtime.evaluate", { expression }));
	}

	// Errors thrown by the expression.
	for (const expression of ["throw new Error('boom')", "throw 5", "throw 'text'", "throw { a: 1 }", "throw null", "nothingHere", "null.x", "1 +", "function () {}"]) {
		const [err, result] = post(session, "Runtime.evaluate", { expression });
		const details = result?.exceptionDetails;
		show(`throws ${JSON.stringify(expression)}`, [
			err,
			result?.result?.type,
			result?.result?.subtype,
			result?.result?.className,
			details && [details.text, typeof details.exceptionId, details.exception?.type, details.exception?.subtype, details.exception?.className],
		]);
	}
	show("exception ids", [post(session, "Runtime.evaluate", { expression: "throw 1" })[1].exceptionDetails.exceptionId > 0]);

	// Options.
	show("returnByValue", [
		post(session, "Runtime.evaluate", { expression: "[1, { a: 2, b: [3, 'x'] }, null]", returnByValue: true }),
		post(session, "Runtime.evaluate", { expression: "({ a: 1, f() {}, u: undefined, d: { e: 1 } })", returnByValue: true }),
		post(session, "Runtime.evaluate", { expression: "(function () {})", returnByValue: true }),
		post(session, "Runtime.evaluate", { expression: "var cyc = {}; cyc.self = cyc; cyc", returnByValue: true }),
		post(session, "Runtime.evaluate", { expression: "7", returnByValue: true }),
	]);
	show("generatePreview", [
		post(session, "Runtime.evaluate", { expression: "({ a: 1, b: [1, 2], c: 'text', d: { e: 1 }, f() {} })", generatePreview: true }),
		post(session, "Runtime.evaluate", { expression: "[1, 2, 3]", generatePreview: true }),
	]);
	show("awaitPromise", [
		await postAsync(session, "Runtime.evaluate", { expression: "Promise.resolve(5)", awaitPromise: true }),
		await postAsync(session, "Runtime.evaluate", { expression: "new Promise((r) => setTimeout(() => r('later'), 5))", awaitPromise: true }),
		await postAsync(session, "Runtime.evaluate", { expression: "Promise.reject(7)", awaitPromise: true }),
		await postAsync(session, "Runtime.evaluate", { expression: "3", awaitPromise: true }),
	]);
	show("evaluate invalid", [
		post(session, "Runtime.evaluate"),
		post(session, "Runtime.evaluate", {}),
		post(session, "Runtime.evaluate", { expression: 5 }),
	]);

	// Reading an object back.
	const obj = post(session, "Runtime.evaluate", { expression: "({ a: 1, b: 'x', c: { d: 2 }, get g() { return 1 }, set s(v) {}, [Symbol('k')]: 2 })" })[1];
	const own = post(session, "Runtime.getProperties", { objectId: undefined });
	show("getProperties invalid", [own, post(session, "Runtime.getProperties", { objectId: "bogus" })]);
	const objectId = await new Promise((resolve) => session.post("Runtime.evaluate", { expression: "globalThis.__probe = { a: 1, b: 'x', c: { d: 2 }, get g() { return 1 }, set s(v) {}, [Symbol('k')]: 2 }" }, (e, r) => resolve(r.result.objectId)));
	const props = (params) => {
		let answer;
		session.post("Runtime.getProperties", { objectId, ...params }, (err, result) => {
			answer = result && { names: result.result.map((p) => p.name), result: norm(result.result.filter((p) => p.isOwn)), internal: result.internalProperties && result.internalProperties.map((p) => p.name) };
			if (err) answer = clean(err);
		});
		return answer;
	};
	show("getProperties own", props({ ownProperties: true }));
	show("getProperties accessors", props({ ownProperties: true, accessorPropertiesOnly: true }));
	const inherited = props({});
	show("getProperties inherited", [inherited.names.slice(0, 6), inherited.names.includes("hasOwnProperty"), inherited.names.includes("__proto__"), inherited.internal]);
	const arrayId = post(session, "Runtime.evaluate", { expression: "[10, 20, , 40]" });
	let arrayObject;
	session.post("Runtime.evaluate", { expression: "[10, 20, 30]" }, (e, r) => {
		arrayObject = r.result.objectId;
	});
	show(
		"getProperties array",
		await new Promise((resolve) => session.post("Runtime.getProperties", { objectId: arrayObject, ownProperties: true }, (e, r) => resolve(norm(r.result.map((p) => [p.name, p.value.value, p.enumerable, p.writable]))))),
	);
	void obj;
	void arrayId;

	// Object ids are the session's: they can be released, and calls can be made on them.
	let target;
	session.post("Runtime.evaluate", { expression: "({ base: 40, twice(n) { return n * 2 } })" }, (e, r) => {
		target = r.result.objectId;
	});
	show("callFunctionOn", [
		post(session, "Runtime.callFunctionOn", { objectId: target, functionDeclaration: "function () { return this.base + 2 }" }),
		post(session, "Runtime.callFunctionOn", { objectId: target, functionDeclaration: "function (n) { return this.twice(n) }", arguments: [{ value: 21 }], returnByValue: true }),
		post(session, "Runtime.callFunctionOn", { objectId: target, functionDeclaration: "function () { throw new Error('inside') }" })[1].exceptionDetails.exception.className,
		post(session, "Runtime.callFunctionOn", { objectId: target, functionDeclaration: "function () { return this }" })[1].result.type,
	]);
	show("releaseObject", [
		post(session, "Runtime.releaseObject", { objectId: target }),
		post(session, "Runtime.getProperties", { objectId: target }),
		post(session, "Runtime.releaseObject", {}),
		post(session, "Runtime.releaseObjectGroup", { objectGroup: "none" }),
	]);
	let grouped;
	session.post("Runtime.evaluate", { expression: "({})", objectGroup: "g1" }, (e, r) => {
		grouped = r.result.objectId;
	});
	post(session, "Runtime.releaseObjectGroup", { objectGroup: "g1" });
	show("released group", post(session, "Runtime.getProperties", { objectId: grouped }));

	// Small commands.
	show("misc", [
		post(session, "Runtime.discardConsoleEntries"),
		post(session, "Runtime.runIfWaitingForDebugger"),
		post(session, "Runtime.globalLexicalScopeNames", {})[1].names.filter((n) => n.startsWith("lex")),
		typeof post(session, "Runtime.getIsolateId")[1].id,
		Object.keys(post(session, "Runtime.getHeapUsage")[1]),
		post(session, "Foo.bar"),
		post(session, "Runtime.bogus", {}),
	]);

	// Notifications.
	const seen = [];
	session.on("inspectorNotification", (message) => {
		if (message.method === "Runtime.executionContextCreated" || message.method === "Runtime.consoleAPICalled") seen.push([message.method, "inspectorNotification"]);
	});
	session.on("Runtime.executionContextCreated", (message) => {
		seen.push(["context", Object.keys(message), Object.keys(message.params.context), message.params.context.auxData]);
	});
	session.on("Runtime.consoleAPICalled", (message) => {
		seen.push(["console", message.params.type, norm(message.params.args), typeof message.params.timestamp, message.params.executionContextId]);
	});
	show("enable", post(session, "Runtime.enable"));
	const realLog = process.stdout.write;
	process.stdout.write = () => true;
	console.log("first", 2, { a: 1 });
	console.warn("careful");
	console.error("bad");
	process.stdout.write = realLog;
	show("disable", post(session, "Runtime.disable"));
	console.log("after disable");
	show("notifications", seen);

	// Disconnecting.
	session.disconnect();
	session.disconnect();
	try {
		session.post("Runtime.evaluate", { expression: "1" });
	} catch (err) {
		show("post after disconnect", [err.name, err.code, err.message]);
	}
	session.connect();
	show("reconnect", post(session, "Runtime.evaluate", { expression: "'again'" }));
	session.disconnect();

	// The promise flavour.
	const ps = new inspectorPromises.Session();
	ps.connect();
	show("promises", [
		clean(null, await ps.post("Runtime.evaluate", { expression: "2 + 2" })),
		await ps.post("Runtime.evaluate", { expression: "Promise.resolve('p')", awaitPromise: true }).then(norm),
		await ps.post("Runtime.nothing").then(() => "resolved", (err) => [err.name, err.code, err.message]),
	]);
	ps.disconnect();

	await sleep(10);
}

main().then(
	() => process.exit(0),
	(err) => {
		console.log("FAILED", err);
		process.exit(1);
	}
);

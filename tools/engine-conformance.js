/*
 * What a JavaScript engine has to support before a current ForgeScript bot can run on it.
 *
 * Run it against any engine binary:
 *
 *     node tools/engine-conformance.js
 *     qjs  tools/engine-conformance.js
 *
 * Every entry here is something that actually appears in ForgeScript, discord.js or undici, not a
 * general conformance wishlist. The language checks are the exact constructs that fail to parse on
 * the Windows 7 Node.js pin (12.22.12); the host checks are the APIs that were missing when a bot
 * was run against it for real.
 *
 * Deliberately written in ES5 and with no imports, so an engine that supports none of this still
 * reaches the report instead of dying on the file itself.
 */

var results = [];

function check(group, name, fn) {
	var status;
	try {
		status = fn() ? "ok" : "wrong";
	} catch (e) {
		status = "missing";
	}
	results.push({ group: group, name: name, status: status });
}

/* Syntax is probed through eval so that an engine lacking it reports a miss rather than
 * refusing to parse this file. */
function syntax(name, source) {
	check("language", name, function () {
		return (0, eval)(source) === true;
	});
}

syntax("optional chaining", "({a:{b:1}})?.a?.b === 1");
syntax("nullish coalescing", "(null ?? 7) === 7");
syntax("logical assignment", "(function(){ var x = null; x ??= 5; return x === 5; })()");
syntax("private class fields", "(function(){ class C { #v = 1; get(){ return this.#v; } } return new C().get() === 1; })()");
syntax("private method calling super", "(function(){ class A { v(){ return 1; } } class B extends A { #p(){ return super.v() + 1; } r(){ return this.#p(); } } return new B().r() === 2; })()");
syntax("class static block", "(function(){ class C { static x; static { C.x = 3; } } return C.x === 3; })()");
syntax("async generators", "(function(){ async function* g(){ yield 1; } return typeof g().next === 'function'; })()");
syntax("object spread", "({...{a:1}}).a === 1");
syntax("BigInt", "(2n ** 64n) > 0n");
syntax("regexp named groups", "'2024'.match(/(?<y>\\d{4})/).groups.y === '2024'");

check("builtins", "Array.prototype.at", function () {
	return [1, 2, 3].at(-1) === 3;
});
check("builtins", "Array.prototype.findLast", function () {
	return [1, 2, 3].findLast(function (n) {
		return n < 3;
	}) === 2;
});
check("builtins", "Object.hasOwn", function () {
	return Object.hasOwn({ a: 1 }, "a");
});
check("builtins", "String.prototype.replaceAll", function () {
	return "aa".replaceAll("a", "b") === "bb";
});
check("builtins", "String.prototype.toWellFormed", function () {
	return typeof "x".toWellFormed === "function";
});
check("builtins", "Promise.any", function () {
	return typeof Promise.any === "function";
});
check("builtins", "AggregateError", function () {
	return typeof AggregateError === "function";
});
check("builtins", "WeakRef", function () {
	return typeof WeakRef === "function";
});
check("builtins", "FinalizationRegistry", function () {
	return typeof FinalizationRegistry === "function";
});
check("builtins", "Proxy/Reflect", function () {
	return Reflect.has(new Proxy({ a: 1 }, {}), "a");
});

/* Host APIs. An engine on its own provides none of these; they are what a runtime layer has to
 * supply before discord.js will work. */
check("host", "TextEncoder", function () {
	return typeof TextEncoder === "function";
});
check("host", "structuredClone", function () {
	return typeof structuredClone === "function";
});
check("host", "fetch", function () {
	return typeof fetch === "function";
});
check("host", "ReadableStream", function () {
	return typeof ReadableStream === "function";
});
check("host", "AbortController", function () {
	return typeof AbortController === "function";
});
check("host", "EventTarget", function () {
	return typeof EventTarget === "function";
});
check("host", "Blob", function () {
	return typeof Blob === "function";
});
check("host", "Intl.Segmenter", function () {
	return typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";
});

/* Node's module surface, which ForgeScript and discord.js require directly. Counted by scanning
 * the real dependency tree; the busiest ones come first. */
var NODE_MODULES = [
	"assert", "util", "stream", "buffer", "fs", "process", "events", "crypto",
	"worker_threads", "timers", "path", "http", "zlib", "async_hooks", "net",
	"url", "os", "tls", "diagnostics_channel", "querystring", "http2", "dns",
	"console", "perf_hooks", "child_process", "string_decoder", "readline", "v8",
	"tty", "https",
];
for (var i = 0; i < NODE_MODULES.length; i++) {
	(function (name) {
		check("node-modules", name, function () {
			if (typeof require !== "function") return false;
			var mod = require(name);
			// A module that loads but throws the moment it is used is not present. Graak's
			// quickjs-ng layer marks those explicitly so this count cannot flatter itself.
			if (mod && mod.__graakUnavailable) return false;
			return true;
		});
	})(NODE_MODULES[i]);
}

var groups = {};
for (var j = 0; j < results.length; j++) {
	var r = results[j];
	if (!groups[r.group]) groups[r.group] = [];
	groups[r.group].push(r);
}

var totalOk = 0;
var order = ["language", "builtins", "host", "node-modules"];
for (var k = 0; k < order.length; k++) {
	var group = order[k];
	var rows = groups[group] || [];
	var passed = 0;
	var misses = [];
	for (var m = 0; m < rows.length; m++) {
		if (rows[m].status === "ok") passed++;
		else misses.push(rows[m].name);
	}
	totalOk += passed;
	print(group + ": " + passed + "/" + rows.length + (misses.length ? "  missing: " + misses.join(", ") : ""));
}
print("");
print("total: " + totalOk + "/" + results.length);

function print(line) {
	if (typeof console !== "undefined" && console.log) console.log(line);
	else if (typeof std !== "undefined" && std.out) std.out.puts(line + "\n");
}

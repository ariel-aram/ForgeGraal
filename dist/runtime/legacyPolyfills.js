"use strict";
/**
 * Runtime polyfills injected into builds for targets pinned to an old Node.js.
 *
 * `LegacyTranspiler` rewrites bundled *syntax* down to what the target can parse. That is only
 * half the gap: current discord.js and its dependencies also call APIs that did not exist yet.
 * On the Windows 7 pin (Node.js 12.22.12) the missing surface was measured directly against the
 * real runtime rather than guessed, and is what this file fills in.
 *
 * Three rules shaped what is here, all of them learned by watching the real thing break:
 *
 * 1. **A wrong polyfill is worse than a missing one.** `structuredClone` was first written as a
 *    JSON round-trip. web-streams-polyfill probes for `structuredClone` to implement the spec's
 *    TransferArrayBuffer step, took that branch, and every byte-stream chunk came back detached:
 *    HTTP 200 responses with a zero-length body. Without the fake it would have used its own safe
 *    fallback. It is implemented over `v8.serialize` here, which really does clone binary data.
 * 2. **What cannot be done correctly must fail loudly.** `Intl.Segmenter` needs ICU segmentation
 *    tables; approximating it would mis-split emoji and combining marks while looking like it
 *    worked. Its constructor exists (ForgeScript builds one at module scope, so the library will
 *    not even load otherwise) but using it throws an explanation.
 * 3. **It must parse on the target.** This source is ES5: no `let`, arrow functions, template
 *    literals or classes, so the runtime reaches the polyfills instead of a SyntaxError.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.POLYFILL_PACKAGES = void 0;
exports.createLegacyPolyfillSource = createLegacyPolyfillSource;
/** Bundled polyfill implementations, and the globals each one provides. */
exports.POLYFILL_PACKAGES = [
    "web-streams-polyfill",
    "abort-controller",
    "event-target-shim",
    "formdata-node",
];
function createLegacyPolyfillSource(config) {
    return `(function installGraakLegacyPolyfills() {
	var g = typeof globalThis !== "undefined" ? globalThis : global;
	var TARGET = ${JSON.stringify(config.target)};
	var ASSET_DIR = path.join(appDir, ${JSON.stringify(config.assetDir)});

	function def(name, value) {
		if (typeof g[name] === "undefined" && value) g[name] = value;
	}

	// ---- module resolution -------------------------------------------------------------
	// The "node:" prefix (Node 14.18/16) and builtin subpath specifiers are newer than this
	// runtime, but the modules behind them exist. Map them back onto what it does have.
	var Module = require("module");
	var virtual = {};
	var subpaths = {
		"util/types": function () { return require("util").types; },
		"fs/promises": function () { return require("fs").promises; },
		"dns/promises": function () { return require("dns").promises; },
		"timers/promises": function () {
			var timers = require("timers");
			return {
				setTimeout: function (ms, value) {
					return new Promise(function (r) { timers.setTimeout(function () { r(value); }, ms); });
				},
				setImmediate: function (value) {
					return new Promise(function (r) { timers.setImmediate(function () { r(value); }); });
				}
			};
		}
	};

	// node:diagnostics_channel (Node 15.1): a named pub/sub registry, no I/O and no native code,
	// so a faithful implementation is short.
	virtual.diagnostics_channel = (function () {
		var channels = {};
		function Channel(name) { this.name = name; this._subs = []; }
		Object.defineProperty(Channel.prototype, "hasSubscribers", {
			get: function () { return this._subs.length > 0; }
		});
		Channel.prototype.publish = function (message) {
			for (var i = 0; i < this._subs.length; i++) this._subs[i](message, this.name);
		};
		Channel.prototype.subscribe = function (fn) { this._subs.push(fn); };
		Channel.prototype.unsubscribe = function (fn) {
			var i = this._subs.indexOf(fn);
			if (i === -1) return false;
			this._subs.splice(i, 1);
			return true;
		};
		function channel(name) {
			if (!channels[name]) channels[name] = new Channel(name);
			return channels[name];
		}
		return {
			channel: channel,
			hasSubscribers: function (name) { return !!channels[name] && channels[name].hasSubscribers; },
			subscribe: function (name, fn) { channel(name).subscribe(fn); },
			unsubscribe: function (name, fn) { return channel(name).unsubscribe(fn); },
			Channel: Channel
		};
	})();

	var origLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (typeof request === "string") {
			var bare = request.indexOf("node:") === 0 ? request.slice(5) : request;
			if (Module.builtinModules.indexOf(bare) !== -1) return origLoad.call(this, bare, parent, isMain);
			if (virtual[bare]) return virtual[bare];
			if (subpaths[bare]) {
				virtual[bare] = subpaths[bare]();
				return virtual[bare];
			}
		}
		return origLoad.apply(this, arguments);
	};

	// ---- bundled polyfill implementations -----------------------------------------------
	var poly = require(path.join(ASSET_DIR, "polyfills.js"));

	def("EventTarget", poly.EventTarget);
	def("Event", poly.Event);
	def("AbortController", poly.AbortController);
	def("AbortSignal", poly.AbortSignal);
	def("ReadableStream", poly.ReadableStream);
	def("WritableStream", poly.WritableStream);
	def("TransformStream", poly.TransformStream);
	def("ByteLengthQueuingStrategy", poly.ByteLengthQueuingStrategy);
	def("CountQueuingStrategy", poly.CountQueuingStrategy);
	def("FormData", poly.FormData);
	def("Blob", poly.Blob);
	def("File", poly.File);

	// ---- globals available in this runtime, just not globally ---------------------------
	var wt = require("worker_threads");
	def("MessageChannel", wt.MessageChannel);
	def("MessagePort", wt.MessagePort);
	def("BroadcastChannel", wt.BroadcastChannel);
	def("performance", require("perf_hooks").performance);

	// ---- DOMException (Node 17) ----------------------------------------------------------
	if (typeof g.DOMException === "undefined") {
		var DOMExceptionShim = function DOMException(message, name) {
			var e = Error.call(this, message);
			this.message = message === undefined ? "" : String(message);
			this.name = name === undefined ? "Error" : String(name);
			this.stack = e.stack;
		};
		DOMExceptionShim.prototype = Object.create(Error.prototype);
		DOMExceptionShim.prototype.constructor = DOMExceptionShim;
		g.DOMException = DOMExceptionShim;
	}

	// ---- AggregateError (Node 15) --------------------------------------------------------
	if (typeof g.AggregateError === "undefined") {
		var AggregateErrorShim = function AggregateError(errors, message) {
			var e = Error.call(this, message);
			this.message = message === undefined ? "" : String(message);
			this.name = "AggregateError";
			this.errors = Array.prototype.slice.call(errors);
			this.stack = e.stack;
		};
		AggregateErrorShim.prototype = Object.create(Error.prototype);
		AggregateErrorShim.prototype.constructor = AggregateErrorShim;
		g.AggregateError = AggregateErrorShim;
	}

	// ---- WeakRef / FinalizationRegistry (V8 8.4 / Node 14.6) -----------------------------
	// Neither can be implemented faithfully: both need garbage-collector integration the engine
	// does not expose. These hold a strong reference and never finalize, which never *lies*
	// (deref always returns a live object) but does mean registered objects are not collected.
	// undici uses them only to evict idle per-origin dispatchers, so what leaks is bounded by
	// the number of distinct hosts the bot talks to.
	if (typeof g.WeakRef === "undefined") {
		var WeakRefShim = function WeakRef(value) {
			if (!(this instanceof WeakRefShim)) throw new TypeError("Constructor WeakRef requires 'new'");
			this._value = value;
		};
		WeakRefShim.prototype.deref = function () { return this._value; };
		g.WeakRef = WeakRefShim;
	}
	if (typeof g.FinalizationRegistry === "undefined") {
		var FinalizationRegistryShim = function FinalizationRegistry(fn) {
			if (!(this instanceof FinalizationRegistryShim)) {
				throw new TypeError("Constructor FinalizationRegistry requires 'new'");
			}
			this._callback = fn;
		};
		FinalizationRegistryShim.prototype.register = function () {};
		FinalizationRegistryShim.prototype.unregister = function () { return false; };
		g.FinalizationRegistry = FinalizationRegistryShim;
	}

	// ---- structuredClone (Node 17) -------------------------------------------------------
	// v8.serialize implements the structured clone algorithm for real, including ArrayBuffers,
	// TypedArrays, Map, Set, Date and RegExp. The \`transfer\` option cannot be honoured without
	// engine support, so buffers are copied and the source is deliberately left intact rather
	// than faking a detach -- a fake detach is what silently emptied every stream chunk when
	// this was a JSON round-trip.
	if (typeof g.structuredClone === "undefined") {
		var v8 = require("v8");
		g.structuredClone = function structuredClone(value) {
			return v8.deserialize(v8.serialize(value));
		};
	}

	// ---- crypto (randomUUID Node 14.17, global crypto Node 19) ---------------------------
	var nodeCrypto = require("crypto");
	if (!nodeCrypto.randomUUID) {
		nodeCrypto.randomUUID = function randomUUID() {
			var b = nodeCrypto.randomBytes(16);
			b[6] = (b[6] & 0x0f) | 0x40;
			b[8] = (b[8] & 0x3f) | 0x80;
			var h = b.toString("hex");
			return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
		};
	}
	def("crypto", {
		randomUUID: nodeCrypto.randomUUID,
		getRandomValues: function (view) {
			nodeCrypto.randomFillSync(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
			return view;
		}
	});

	// ---- stream helpers (Node 16.8 / 17) -------------------------------------------------
	var streamMod = require("stream");
	if (!streamMod.isDisturbed) {
		streamMod.isDisturbed = function (stream) {
			if (!stream) return false;
			var s = stream._readableState;
			return !!(stream.readableDidRead || (s && (s.dataEmitted || s.endEmitted || s.reading)));
		};
	}
	if (!streamMod.isErrored) {
		streamMod.isErrored = function (stream) {
			if (!stream) return false;
			var s = stream._readableState || stream._writableState;
			return !!(stream.destroyed && stream.errored) || !!(s && s.errored);
		};
	}
	if (!streamMod.isReadable) {
		streamMod.isReadable = function (stream) {
			var s = stream && stream._readableState;
			return !!(s && stream.readable !== false && !s.endEmitted);
		};
	}

	// ---- statics -------------------------------------------------------------------------
	function define(target, name, value) {
		if (!target[name]) Object.defineProperty(target, name, { value: value, writable: true, configurable: true });
	}
	function relativeIndex(length, index) {
		index = Math.trunc(index) || 0;
		if (index < 0) index += length;
		return index < 0 || index >= length ? -1 : index;
	}

	if (!Object.hasOwn) {
		Object.hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
	}
	define(Array.prototype, "at", function (index) {
		var i = relativeIndex(this.length, index);
		return i === -1 ? undefined : this[i];
	});
	define(String.prototype, "at", function (index) {
		var i = relativeIndex(this.length, index);
		return i === -1 ? undefined : this[i];
	});
	define(Array.prototype, "findLastIndex", function (fn, thisArg) {
		for (var i = this.length - 1; i >= 0; i--) {
			if (fn.call(thisArg, this[i], i, this)) return i;
		}
		return -1;
	});
	define(Array.prototype, "findLast", function (fn, thisArg) {
		var i = this.findLastIndex(fn, thisArg);
		return i === -1 ? undefined : this[i];
	});
	define(String.prototype, "replaceAll", function (find, replacement) {
		if (find instanceof RegExp) {
			if (!find.global) throw new TypeError("replaceAll must be called with a global RegExp");
			return this.replace(find, replacement);
		}
		return this.split(find).join(replacement);
	});
	if (!Promise.any) {
		Promise.any = function (iterable) {
			return new Promise(function (resolve, reject) {
				var items = Array.prototype.slice.call(iterable);
				var errors = new Array(items.length);
				var remaining = items.length;
				if (!remaining) return reject(new g.AggregateError([], "All promises were rejected"));
				items.forEach(function (item, i) {
					Promise.resolve(item).then(resolve, function (err) {
						errors[i] = err;
						remaining--;
						if (remaining === 0) reject(new g.AggregateError(errors, "All promises were rejected"));
					});
				});
			});
		};
	}

	// Lone surrogates: code units in [0xD800,0xDFFF] that are not part of a valid pair.
	function scanWellFormed(str, replace) {
		var out = "";
		var wellFormed = true;
		for (var i = 0; i < str.length; i++) {
			var code = str.charCodeAt(i);
			var lone = false;
			if (code >= 0xd800 && code <= 0xdbff) {
				var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
				if (next >= 0xdc00 && next <= 0xdfff) {
					if (replace) out += str[i] + str[i + 1];
					i++;
					continue;
				}
				lone = true;
			} else if (code >= 0xdc00 && code <= 0xdfff) {
				lone = true;
			}
			if (lone) {
				wellFormed = false;
				if (!replace) return false;
				out += "\\uFFFD";
			} else if (replace) {
				out += str[i];
			}
		}
		return replace ? out : wellFormed;
	}
	define(String.prototype, "isWellFormed", function () { return scanWellFormed(String(this), false); });
	define(String.prototype, "toWellFormed", function () { return scanWellFormed(String(this), true); });

	// ---- Intl.Segmenter (V8 8.7 / Node 16, needs full ICU) -------------------------------
	// Deliberately not emulated. Correct grapheme, word and sentence breaking needs ICU's
	// segmentation tables; splitting by code point instead would quietly mishandle emoji,
	// combining marks and ZWJ sequences -- wrong output that looks right. ForgeScript constructs
	// one at module scope, so the constructor has to exist for the library to load at all.
	if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "undefined") {
		var SegmenterShim = function Segmenter() {
			if (!(this instanceof SegmenterShim)) throw new TypeError("Constructor Intl.Segmenter requires 'new'");
		};
		SegmenterShim.prototype.segment = function () {
			throw new Error(
				"Intl.Segmenter is not available on " + TARGET + " (added in Node.js 16, and it needs full ICU). " +
				"Graak does not emulate it, because approximating Unicode segmentation would split emoji and " +
				"combining characters incorrectly while appearing to work. Avoid text-segmentation functions such as " +
				"$segmentTextSplit on this target, or build for a modern target instead."
			);
		};
		SegmenterShim.prototype.resolvedOptions = function () {
			return { locale: "en", granularity: "grapheme" };
		};
		SegmenterShim.supportedLocalesOf = function () { return []; };
		Intl.Segmenter = SegmenterShim;
	}

	// ---- fetch (global since Node 18) ----------------------------------------------------
	// Node does not implement fetch itself: from v18 it exposes undici's. This runtime is older
	// than that, but undici is in the bundle whenever discord.js is, so the same implementation
	// is wired to the same global. It has to happen after the polyfills above, because undici's
	// fetch is built on ReadableStream, AbortController and Blob.
	//
	// Found the hard way: a bot calling global fetch() died with "fetch is not defined" on a real
	// Windows machine, because every earlier version of this file polyfilled what undici needed
	// and then forgot the thing the bot actually calls.
	if (typeof g.fetch === "undefined") {
		try {
			var appRequire = Module.createRequire(path.join(appDir, "package.json"));
			var undici = appRequire("undici");
			def("fetch", undici.fetch);
			def("Headers", undici.Headers);
			def("Request", undici.Request);
			def("Response", undici.Response);
			def("FormData", undici.FormData);
			def("WebSocket", undici.WebSocket);
		} catch (e) {
			// No undici in the bundle. Rather than leave a confusing ReferenceError at the call
			// site, fetch exists and explains itself.
			g.fetch = function () {
				return Promise.reject(
					new Error(
						"fetch() is not available on " + TARGET + ": this runtime predates Node 18, which is " +
						"where Node began providing it, and 'undici' (the implementation Node uses) is not in " +
						"this bundle. Add undici as a dependency, or use node:https directly."
					)
				);
			};
		}
	}
${config.runtimeCodegen ? runtimeCodegenSource(config) : "\n\tg.__graakLegacyReady = null;\n"}
})();
`;
}
/**
 * Patches the `Function` constructor so code generated at runtime is lowered before the engine
 * compiles it. Uses esbuild's WebAssembly build, which runs on the target itself, rather than a
 * regular expression over source: rewriting code by pattern is how a transpiler silently
 * corrupts a program, and `transformSync` is available so the synchronous contract of
 * `new Function(...)` is preserved.
 *
 * Initialization is asynchronous, so this exposes a promise the launcher waits on before it
 * loads the bot -- by the time any bot code runs, the patch is live.
 */
function runtimeCodegenSource(config) {
    return `
	// ---- runtime code generation ---------------------------------------------------------
	var esbuildWasm = require(path.join(ASSET_DIR, "esbuild-wasm", "lib", "main.js"));
	var JS_TARGET = process.env.GRAAK_JS_TARGET || ${JSON.stringify(config.jsTarget)};
	var transpilerReady = false;
	var NativeFunction = Function;

	// esbuild's WebAssembly build runs the compiler in a child process, so a transform costs
	// roughly 14ms on the Windows 7 pin. Generated sources repeat heavily -- ForgeScript emits
	// the same handful of templates for every compiled field -- so memoising collapses that to
	// one transform per distinct source instead of one per call.
	var lowered = {};
	var loweredCount = 0;

	function lowerSource(source) {
		if (!transpilerReady) return source;
		if (Object.prototype.hasOwnProperty.call(lowered, source)) return lowered[source];
		var result;
		try {
			result = esbuildWasm.transformSync(source, { target: JS_TARGET, loader: "js" }).code;
		} catch (e) {
			// Not parseable on its own; let the engine raise its own error against the original.
			result = source;
		}
		// Bounded so a bot that generates unbounded distinct sources cannot grow this forever.
		if (loweredCount < 4096) {
			lowered[source] = result;
			loweredCount++;
		}
		return result;
	}

	function PatchedFunction() {
		var args = Array.prototype.slice.call(arguments);
		if (args.length && transpilerReady) {
			var body = String(args[args.length - 1]);
			var params = args.slice(0, -1).map(String).join(",");
			var wrapped = "(function anonymous(" + params + "\\n) {\\n" + body + "\\n})";
			var lowered = lowerSource(wrapped);
			if (lowered !== wrapped) return (0, eval)(lowered);
		}
		return NativeFunction.apply(this, args);
	}
	PatchedFunction.prototype = NativeFunction.prototype;
	PatchedFunction.prototype.constructor = PatchedFunction;
	g.Function = PatchedFunction;

	g.__graakLegacyReady = esbuildWasm
		.initialize({ worker: false })
		.then(function () { transpilerReady = true; })
		.catch(function (err) {
			process.stderr.write(
				"[Graak] Could not start the runtime transpiler: " + (err && err.message ? err.message : err) + "\\n" +
				"[Graak] Code generated at runtime (ForgeScript compiles its functions this way) will fail to " +
				"parse on this runtime.\\n"
			);
		});
`;
}
//# sourceMappingURL=legacyPolyfills.js.map
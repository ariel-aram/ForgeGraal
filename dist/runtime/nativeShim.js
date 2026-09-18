"use strict";
/**
 * Native addon shim injected into ForgeGraal executables.
 *
 * Legacy and 32-bit targets (Windows XP / Vista / 7, iSH, linux-x86, FreeBSD) frequently
 * cannot load prebuilt `.node` addons, so `require()` fails with ERR_DLOPEN_FAILED. This
 * shim intercepts that failure and substitutes a replacement **only when a correct one
 * exists**:
 *
 * - `bufferutil`, `utf-8-validate` — pure JS implementations with identical semantics
 *   (the same algorithms `ws` uses when these optional accelerators are absent).
 * - `sqlite3`, `better-sqlite3` — backed by Node's built-in `node:sqlite`, so data is
 *   really written to the same database file. Unimplemented methods throw instead of
 *   silently doing nothing.
 *
 * Everything else (LMDB, canvas, gifsx, sodium/davey voice crypto, zlib-sync, bcrypt,
 * pg-native, mysql2, msgpackr-extract, mediaplex) is deliberately **not** stubbed. A stub
 * that returns empty images, discards database writes, hashes passwords with unsalted
 * SHA-256, or produces ciphertext with the wrong algorithm is worse than a crash: the bot
 * appears to work while losing data or leaking security guarantees. For those the original
 * error is rethrown with an explanation of what to do about it. Most of them are optional
 * accelerators whose own libraries already fall back to pure JS when the addon is missing.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WASM_FALLBACKS_SOURCE = exports.UNSUBSTITUTABLE_NATIVE = exports.OPTIONAL_ACCELERATORS = void 0;
exports.createNativeShimSource = createNativeShimSource;
/**
 * Packages whose absence the calling library already handles, so the load error must be
 * allowed to propagate untouched rather than being answered with a fake module.
 */
exports.OPTIONAL_ACCELERATORS = [
    "zlib-sync",
    "msgpackr-extract",
    "pg-native",
    "mediaplex",
    "@discordjs/opus",
    "node-opus",
];
/**
 * Packages that genuinely need a native addon. Substituting them silently would corrupt
 * data or weaken security, so the build fails or the bot stops with an explanation.
 */
exports.UNSUBSTITUTABLE_NATIVE = [
    "lmdb",
    "canvas",
    "@napi-rs/canvas",
    "@gifsx/gifsx",
    "sodium-native",
    "@snazzah/davey",
    "bcrypt",
    "argon2",
];
/**
 * Builds the ES5 shim source embedded in the launcher.
 */
function createNativeShimSource(config) {
    return `(function installForgeGraalNativeShim() {
	var Module = require("module");
	var origLoad = Module._load;
	var TARGET = ${JSON.stringify(config.target)};
	var seen = {};

	function note(message) {
		if (seen[message]) return;
		seen[message] = true;
		process.stderr.write("[ForgeGraal] " + message + "\\n");
	}

	function isDlopenFailure(err) {
		if (!err) return false;
		if (err.code === "ERR_DLOPEN_FAILED") return true;
		var message = err.message || "";
		return (
			message.indexOf("procedure could not be found") !== -1 ||
			message.indexOf("specified module could not be found") !== -1 ||
			message.indexOf("not a valid Win32 application") !== -1 ||
			message.indexOf("was compiled against a different Node.js version") !== -1
		);
	}

	/** Package name of a request, ignoring deep paths: "a/b/c.node" -> "a" ("@s/p" kept whole). */
	function packageOf(request) {
		var parts = String(request || "").split(/[\\\\/]/);
		if (parts[0].charAt(0) === "@" && parts.length > 1) return (parts[0] + "/" + parts[1]).toLowerCase();
		return parts[0].toLowerCase();
	}

	/** Innermost node_modules package a file belongs to, used when the addon path is absolute. */
	function owningPackage(filename) {
		var parts = String(filename || "").split(/[\\\\/]/);
		for (var i = parts.length - 1; i >= 0; i--) {
			if (parts[i] !== "node_modules" || i + 1 >= parts.length) continue;
			var name = parts[i + 1];
			if (name.charAt(0) === "@" && i + 2 < parts.length) name = name + "/" + parts[i + 2];
			return name.toLowerCase();
		}
		return "";
	}

	function inList(name, list) {
		for (var i = 0; i < list.length; i++) if (list[i] === name) return true;
		return false;
	}

	// --- Replacements that are behaviourally identical to the native addon ------------

	// ws's own JS fallback for bufferutil.
	function bufferUtilFallback() {
		return {
			mask: function (source, mask, output, offset, length) {
				for (var i = 0; i < length; i++) output[offset + i] = source[i] ^ mask[i & 3];
			},
			unmask: function (buffer, mask) {
				for (var i = 0; i < buffer.length; i++) buffer[i] ^= mask[i & 3];
			}
		};
	}

	// utf-8-validate exports the validator function itself.
	function utf8ValidateFallback() {
		var decoder = new TextDecoder("utf-8", { fatal: true });
		function isValidUTF8(buffer) {
			try {
				decoder.decode(buffer);
				return true;
			} catch (e) {
				return false;
			}
		}
		return isValidUTF8;
	}

	/**
	 * SQLite backed by node:sqlite, so rows are written to the real database file.
	 * Returns null when the runtime is too old, and then the caller reports that.
	 */
	function loadNodeSqlite() {
		try {
			return require("node:sqlite");
		} catch (e) {
			return null;
		}
	}

	function unsupported(api) {
		return function () {
			throw new Error(
				"[ForgeGraal] '" + api + "' is not implemented by the node:sqlite compatibility layer used on " +
					TARGET + ". Use a pure JavaScript ForgeDB driver (mongodb, mysql, postgres), or run this bot " +
					"on a platform where the native driver installs."
			);
		};
	}

	function betterSqlite3Fallback(sqlite) {
		function Database(filename, options) {
			if (!(this instanceof Database)) return new Database(filename, options);
			var target = filename === undefined || filename === null ? ":memory:" : filename;
			this._db = new sqlite.DatabaseSync(String(target));
			this.name = String(target);
			this.open = true;
			this.memory = String(target) === ":memory:";
			this.readonly = !!(options && options.readonly);
		}
		Database.prototype.prepare = function (sql) {
			var statement = this._db.prepare(sql);
			return {
				run: function () {
					var result = statement.run.apply(statement, arguments);
					return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
				},
				get: function () {
					return statement.get.apply(statement, arguments);
				},
				all: function () {
					return statement.all.apply(statement, arguments);
				},
				iterate: function () {
					return statement.all.apply(statement, arguments)[Symbol.iterator]();
				},
				pluck: unsupported("Statement#pluck"),
				expand: unsupported("Statement#expand"),
				raw: unsupported("Statement#raw")
			};
		};
		Database.prototype.exec = function (sql) {
			this._db.exec(sql);
			return this;
		};
		Database.prototype.pragma = function (statement, options) {
			var rows = this._db.prepare("PRAGMA " + statement).all();
			if (options && options.simple) {
				if (!rows.length) return undefined;
				for (var key in rows[0]) if (Object.prototype.hasOwnProperty.call(rows[0], key)) return rows[0][key];
				return undefined;
			}
			return rows;
		};
		Database.prototype.close = function () {
			if (this.open) {
				this._db.close();
				this.open = false;
			}
			return this;
		};
		Database.prototype.transaction = function (fn) {
			var db = this;
			return function () {
				db.exec("BEGIN");
				try {
					var out = fn.apply(this, arguments);
					db.exec("COMMIT");
					return out;
				} catch (err) {
					try {
						db.exec("ROLLBACK");
					} catch (e) {}
					throw err;
				}
			};
		};
		Database.prototype.function = unsupported("Database#function");
		Database.prototype.aggregate = unsupported("Database#aggregate");
		Database.prototype.backup = unsupported("Database#backup");
		Database.prototype.loadExtension = unsupported("Database#loadExtension");
		return Database;
	}

	/** node-sqlite3's callback API (what TypeORM's "sqlite" driver, and so ForgeDB, uses). */
	function sqlite3Fallback(sqlite) {
		function defer(callback, self, err, result) {
			if (typeof callback !== "function") {
				if (err) throw err;
				return;
			}
			process.nextTick(function () {
				callback.call(self, err, result);
			});
		}

		function normalize(params, callback) {
			// (sql, cb) | (sql, params, cb) | (sql, p1, p2, ..., cb)
			var cb = typeof params[params.length - 1] === "function" ? params[params.length - 1] : undefined;
			var rest = Array.prototype.slice.call(params, 1, cb ? params.length - 1 : params.length);
			var bind = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
			if (bind.length === 1 && bind[0] && typeof bind[0] === "object" && !Array.isArray(bind[0]) && !Buffer.isBuffer(bind[0])) {
				bind = [bind[0]];
			}
			return { sql: params[0], bind: bind, callback: cb };
		}

		function Database(filename, mode, callback) {
			if (!(this instanceof Database)) return new Database(filename, mode, callback);
			var done = typeof mode === "function" ? mode : callback;
			var target = filename === undefined || filename === null ? ":memory:" : String(filename);
			try {
				this._db = new sqlite.DatabaseSync(target);
			} catch (err) {
				defer(done, this, err);
				throw err;
			}
			this.filename = target;
			this.open = true;
			defer(done, this, null);
		}

		Database.prototype.run = function () {
			var call = normalize(arguments);
			var self = this;
			try {
				var statement = self._db.prepare(call.sql);
				var result = statement.run.apply(statement, call.bind);
				var ctx = { lastID: Number(result.lastInsertRowid), changes: Number(result.changes) };
				defer(call.callback, ctx, null);
			} catch (err) {
				defer(call.callback, self, err);
			}
			return self;
		};
		Database.prototype.all = function () {
			var call = normalize(arguments);
			var self = this;
			try {
				var allStatement = self._db.prepare(call.sql);
				defer(call.callback, self, null, allStatement.all.apply(allStatement, call.bind));
			} catch (err) {
				defer(call.callback, self, err);
			}
			return self;
		};
		Database.prototype.get = function () {
			var call = normalize(arguments);
			var self = this;
			try {
				var getStatement = self._db.prepare(call.sql);
				defer(call.callback, self, null, getStatement.get.apply(getStatement, call.bind));
			} catch (err) {
				defer(call.callback, self, err);
			}
			return self;
		};
		Database.prototype.each = function () {
			var call = normalize(arguments);
			var self = this;
			try {
				var eachStatement = self._db.prepare(call.sql);
				var rows = eachStatement.all.apply(eachStatement, call.bind);
				for (var i = 0; i < rows.length; i++) defer(call.callback, self, null, rows[i]);
			} catch (err) {
				defer(call.callback, self, err);
			}
			return self;
		};
		Database.prototype.exec = function (sql, callback) {
			var self = this;
			try {
				self._db.exec(sql);
				defer(callback, self, null);
			} catch (err) {
				defer(callback, self, err);
			}
			return self;
		};
		Database.prototype.prepare = function () {
			var call = normalize(arguments);
			var self = this;
			var statement = {
				run: function () {
					return Database.prototype.run.apply(self, [call.sql].concat(Array.prototype.slice.call(arguments)));
				},
				all: function () {
					return Database.prototype.all.apply(self, [call.sql].concat(Array.prototype.slice.call(arguments)));
				},
				get: function () {
					return Database.prototype.get.apply(self, [call.sql].concat(Array.prototype.slice.call(arguments)));
				},
				finalize: function (cb) {
					defer(cb, self, null);
					return statement;
				}
			};
			defer(call.callback, statement, null);
			return statement;
		};
		// node:sqlite is synchronous, so serialize/parallelize are already satisfied.
		Database.prototype.serialize = function (fn) {
			if (fn) fn.call(this);
			return this;
		};
		Database.prototype.parallelize = Database.prototype.serialize;
		Database.prototype.close = function (callback) {
			try {
				if (this.open) {
					this._db.close();
					this.open = false;
				}
				defer(callback, this, null);
			} catch (err) {
				defer(callback, this, err);
			}
			return this;
		};
		Database.prototype.configure = function () {
			return this;
		};
		Database.prototype.on = function () {
			return this;
		};
		Database.prototype.once = function () {
			return this;
		};
		Database.prototype.removeListener = function () {
			return this;
		};
		Database.prototype.loadExtension = unsupported("Database#loadExtension");

		return {
			Database: Database,
			Statement: function () {
				throw new Error("[ForgeGraal] sqlite3.Statement cannot be constructed directly in the compatibility layer.");
			},
			OPEN_READONLY: 1,
			OPEN_READWRITE: 2,
			OPEN_CREATE: 4,
			OPEN_FULLMUTEX: 65536,
			OPEN_SHAREDCACHE: 131072,
			OPEN_PRIVATECACHE: 262144,
			OPEN_URI: 64,
			cached: { Database: Database },
			verbose: function () {
				return this;
			}
		};
	}

	var OPTIONAL_ACCELERATORS = ${JSON.stringify(exports.OPTIONAL_ACCELERATORS)};
	var UNSUBSTITUTABLE = ${JSON.stringify(exports.UNSUBSTITUTABLE_NATIVE)};

	Module._load = function (request, parent, isMain) {
		try {
			return origLoad.apply(this, arguments);
		} catch (err) {
			if (!isDlopenFailure(err)) throw err;

			// Resolve which package failed: the request itself, or the module that required it
			// (prebuild loaders such as node-gyp-build require an absolute .node path).
			var name = packageOf(request);
			if (name.charAt(0) === "." || name.charAt(0) === "/" || name.indexOf(":") === 1) {
				name = owningPackage(request) || owningPackage(parent && parent.filename);
			}
			if (!name) name = owningPackage(parent && parent.filename);

			if (name === "bufferutil") {
				note("'bufferutil' could not be loaded on " + TARGET + "; using the pure JavaScript mask/unmask instead.");
				return bufferUtilFallback();
			}
			if (name === "utf-8-validate") {
				note("'utf-8-validate' could not be loaded on " + TARGET + "; using the pure JavaScript validator instead.");
				return utf8ValidateFallback();
			}

			if (name === "better-sqlite3" || name === "sqlite3") {
				var sqlite = loadNodeSqlite();
				if (!sqlite) {
					err.message =
						"[ForgeGraal] '" + name + "' has no usable native addon on " + TARGET + ", and this runtime has no " +
						"built-in node:sqlite (Node.js >= 22.5) to fall back to. Use a pure JavaScript ForgeDB driver " +
						"(mongodb, mysql, postgres), supply a newer runtime with --node-binary, or rebuild '" + name +
						"' for this platform.\\nOriginal error: " + err.message;
					throw err;
				}
				note(
					"'" + name + "' could not be loaded on " + TARGET + "; using the built-in node:sqlite instead. " +
						"Data is still written to the same database file."
				);
				return name === "sqlite3" ? sqlite3Fallback(sqlite) : betterSqlite3Fallback(sqlite);
			}

			if (inList(name, OPTIONAL_ACCELERATORS)) {
				note(
					"'" + name + "' has no usable native addon on " + TARGET + ". It is an optional accelerator, so the " +
						"library that requested it should continue without it."
				);
				throw err;
			}

			if (inList(name, UNSUBSTITUTABLE)) {
				err.message =
					"[ForgeGraal] '" + name + "' needs a native addon built for " + TARGET + ", and no correct pure " +
					"JavaScript replacement exists. ForgeGraal does not substitute a stub here on purpose: doing so " +
					"would silently produce empty images, discard database writes, or weaken cryptography. Install or " +
					"rebuild '" + name + "' for this platform, or drop the feature that needs it.\\nOriginal error: " +
					err.message;
				throw err;
			}

			err.message =
				"[ForgeGraal] A native addon ('" + (name || request) + "') could not be loaded on " + TARGET + ". " +
				"Rebuild it for this platform, or replace it with a pure JavaScript package.\\nOriginal error: " +
				err.message;
			throw err;
		}
	};
})();
`;
}
/**
 * @deprecated Use {@link createNativeShimSource}. Kept so existing imports keep working.
 */
exports.WASM_FALLBACKS_SOURCE = createNativeShimSource({
    target: "unknown",
});
//# sourceMappingURL=nativeShim.js.map
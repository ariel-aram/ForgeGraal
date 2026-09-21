/**
 * Bun runtime compatibility layer.
 *
 * Graak executables always run on Node.js (SEA / portable bundle), even when the bot
 * project itself is authored for and developed with Bun. Code written against Bun's own
 * APIs — `import { Database } from "bun:sqlite"`, `Bun.serve`, `Bun.file`, `Bun.env` — does
 * not exist under Node and would otherwise fail at startup with "Cannot find module
 * 'bun:sqlite'" or "Bun is not defined".
 *
 * This layer intercepts those two failure modes and answers with a real implementation
 * only where one is achievable with the *same behavior*:
 *
 * - `bun:sqlite`'s `Database` — backed by Node's built-in `node:sqlite`, matching Bun's
 *   synchronous, better-sqlite3-shaped API. Rows go to the real database file.
 * - `Bun.file` / `Bun.write` — backed by `node:fs`, same read/write semantics.
 * - `Bun.serve` — a Fetch-API HTTP server bridged onto `node:http`, so `fetch(request)`
 *   handlers written for Bun run unmodified.
 * - `Bun.env`, `Bun.sleep`, `Bun.which`, `Bun.nanoseconds`, `Bun.gc` — thin, exact wrappers.
 *
 * `Bun.password` (argon2id/bcrypt hashing) and `Bun.hash` (a specific non-cryptographic hash
 * function, xxHash/wyhash/CityHash/Murmur variants) are deliberately **not** polyfilled:
 * Node's standard library has no algorithm that produces the same output, and a different
 * algorithm behind the same name is a silent correctness bug (password hashes that don't
 * verify against ones from Bun, cache keys that never hit). Accessing them throws instead.
 * Anything else on `Bun` (`Bun.spawn`, `Bun.build`, `Bun.$`, FFI, ...) throws the same way:
 * an explained error at the point of use, not a crash three files deep in a library.
 */

export interface BunCompatConfig {
	/** Target id, only used in diagnostics. */
	target: string;
}

/** `Bun.*` members intercepted with a genuine, correct implementation. */
export const BUN_GLOBAL_SHIMMED = [
	"env",
	"file",
	"write",
	"serve",
	"sleep",
	"sleepSync",
	"which",
	"nanoseconds",
	"gc",
	"version",
	"revision",
] as const;

/** `Bun.*` members that exist for compatibility but always throw: no correct equivalent. */
export const BUN_GLOBAL_UNSAFE = ["password", "hash", "CryptoHasher"] as const;

export function createBunCompatSource(config: BunCompatConfig): string {
	return `(function installGraakBunCompat() {
	var TARGET = ${JSON.stringify(config.target)};
	var seen = {};

	function note(message) {
		if (seen[message]) return;
		seen[message] = true;
		process.stderr.write("[Graak] " + message + "\\n");
	}

	function unsafe(name, why) {
		return function () {
			throw new Error(
				"[Graak] 'Bun." + name + "' is not available in the Node.js compatibility layer used on " +
					TARGET + ": " + why
			);
		};
	}

	function unimplemented(name) {
		return function () {
			throw new Error(
				"[Graak] 'Bun." + name + "' has no Node.js equivalent in this compatibility layer (executables " +
					"run on Node.js, not Bun, on " + TARGET + "). Rewrite this part with Node.js APIs."
			);
		};
	}

	// --- bun:sqlite ---------------------------------------------------------------------

	function loadNodeSqlite() {
		try {
			return require("node:sqlite");
		} catch (e) {
			return null;
		}
	}

	function unsupportedSqlite(api) {
		return function () {
			throw new Error(
				"[Graak] '" + api + "' is not implemented by the bun:sqlite compatibility layer (backed by " +
					"node:sqlite) on " + TARGET + "."
			);
		};
	}

	function installBunSqlite() {
		var sqlite = loadNodeSqlite();
		if (!sqlite) {
			return function () {
				throw new Error(
					"[Graak] 'bun:sqlite' needs Node's built-in node:sqlite (Node.js >= 22.5) on " + TARGET +
						", which this runtime does not have. Supply a newer runtime, or switch to a pure JavaScript " +
						"ForgeDB driver (mongodb, mysql, postgres)."
				);
			};
		}

		function toRunResult(result) {
			return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
		}

		function Statement(raw) {
			this._raw = raw;
		}
		Statement.prototype.all = function () {
			return this._raw.all.apply(this._raw, arguments);
		};
		Statement.prototype.get = function () {
			return this._raw.get.apply(this._raw, arguments);
		};
		Statement.prototype.run = function () {
			return toRunResult(this._raw.run.apply(this._raw, arguments));
		};
		Statement.prototype.values = function () {
			var rows = this._raw.all.apply(this._raw, arguments);
			return rows.map(function (row) {
				var out = [];
				for (var key in row) if (Object.prototype.hasOwnProperty.call(row, key)) out.push(row[key]);
				return out;
			});
		};
		Statement.prototype.iterate = function () {
			return this.all.apply(this, arguments)[Symbol.iterator]();
		};
		Statement.prototype.finalize = function () {};
		Statement.prototype.as = unsupportedSqlite("Statement#as");
		Statement.prototype.columnNames = unsupportedSqlite("Statement#columnNames");

		function Database(filename, options) {
			if (!(this instanceof Database)) return new Database(filename, options);
			var target = filename === undefined || filename === null ? ":memory:" : filename;
			this._db = new sqlite.DatabaseSync(String(target), {
				readOnly: !!(options && (options.readonly || options.readOnly))
			});
			this.filename = String(target);
		}
		Database.prototype.query = function (sql) {
			return new Statement(this._db.prepare(sql));
		};
		Database.prototype.prepare = Database.prototype.query;
		Database.prototype.run = function (sql) {
			var statement = this._db.prepare(sql);
			return toRunResult(statement.run.apply(statement, Array.prototype.slice.call(arguments, 1)));
		};
		Database.prototype.exec = function (sql) {
			this._db.exec(sql);
			return this;
		};
		Database.prototype.close = function () {
			this._db.close();
		};
		Database.prototype.transaction = function (fn) {
			var db = this;
			function wrapped() {
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
			}
			wrapped.deferred = wrapped;
			wrapped.immediate = wrapped;
			wrapped.exclusive = wrapped;
			return wrapped;
		};
		Database.prototype.loadExtension = unsupportedSqlite("Database#loadExtension");
		Database.prototype.serialize = unsupportedSqlite("Database#serialize");
		Database.prototype.fileControl = unsupportedSqlite("Database#fileControl");

		note("'bun:sqlite' is not available on " + TARGET + "; using node:sqlite instead. Data is still written to the real database file.");
		return { Database: Database, Statement: Statement, constants: {} };
	}

	// --- Bun.* globals -------------------------------------------------------------------

	function BunFile(filePath) {
		var fs = require("fs");
		var fsp = require("fs/promises");
		return {
			name: filePath,
			get size() {
				try {
					return fs.statSync(filePath).size;
				} catch (e) {
					return 0;
				}
			},
			type: "application/octet-stream",
			exists: function () {
				return fsp.access(filePath, fs.constants.F_OK).then(
					function () { return true; },
					function () { return false; }
				);
			},
			text: function () {
				return fsp.readFile(filePath, "utf8");
			},
			json: function () {
				return fsp.readFile(filePath, "utf8").then(function (t) { return JSON.parse(t); });
			},
			arrayBuffer: function () {
				return fsp.readFile(filePath).then(function (buf) {
					return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
				});
			},
			stream: function () {
				var Readable = require("stream").Readable;
				return Readable.toWeb(fs.createReadStream(filePath));
			},
			writer: function () {
				var handle = fs.createWriteStream(filePath);
				return {
					write: function (chunk) {
						handle.write(typeof chunk === "string" ? chunk : Buffer.from(chunk));
						return Promise.resolve();
					},
					end: function () {
						return new Promise(function (resolve) {
							handle.end(resolve);
						});
					}
				};
			}
		};
	}

	function bunWrite(destination, data) {
		var fsp = require("fs/promises");
		var path = typeof destination === "string" ? destination : destination && destination.name;
		if (!path) return unimplemented("write")();
		if (data && typeof data.stream === "function" && typeof data.arrayBuffer === "function" && data.name) {
			// Another BunFile / Blob-like source.
			return data.arrayBuffer().then(function (buf) {
				return fsp.writeFile(path, Buffer.from(buf)).then(function () { return buf.byteLength; });
			});
		}
		var buffer = typeof data === "string" || Buffer.isBuffer(data) ? data : Buffer.from(data);
		return fsp.writeFile(path, buffer).then(function () {
			return Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(buffer);
		});
	}

	/** Bridges a Bun.serve()-style { fetch(request) } handler onto node:http. */
	function bunServe(options) {
		var http = require("http");
		var handler = options && options.fetch;
		if (typeof handler !== "function") {
			throw new Error("[Graak] Bun.serve() requires a 'fetch' handler function.");
		}

		var server = http.createServer(function (req, res) {
			Promise.resolve()
				.then(function () {
					var Readable = require("stream").Readable;
					var url = "http://" + (req.headers.host || "localhost") + req.url;
					var hasBody = req.method !== "GET" && req.method !== "HEAD";
					var init = {
						method: req.method,
						headers: req.headers,
						body: hasBody ? Readable.toWeb(req) : undefined
					};
					if (hasBody) init.duplex = "half";
					var request = new Request(url, init);
					return handler(request, server);
				})
				.then(function (response) {
					if (!response) {
						res.statusCode = 204;
						res.end();
						return;
					}
					res.statusCode = response.status;
					response.headers.forEach(function (value, key) {
						res.setHeader(key, value);
					});
					if (!response.body) {
						res.end();
						return;
					}
					var Readable = require("stream").Readable;
					Readable.fromWeb(response.body).pipe(res);
				})
				.catch(function (err) {
					note("Bun.serve() handler threw on " + TARGET + ": " + (err && err.message ? err.message : err));
					res.statusCode = 500;
					res.end("Internal Server Error");
				});
		});

		// 0 is a valid, common port request ("give me any free port"); the OR operator would
		// treat 0 as falsy and silently rebind to 3000 instead, so this checks the type.
		var requestedPort = options && typeof options.port === "number" ? options.port : 3000;
		var hostname = (options && options.hostname) || "0.0.0.0";
		server.listen(requestedPort, hostname);

		// Real Bun.serve() is synchronous and server.port is correct the instant it returns.
		// Node's socket bind is asynchronous, so when an ephemeral port (0, or a busy port
		// Bun would have retried) is requested, the true bound port is only known once the
		// 'listening' event fires. .port stays a live getter so it becomes correct moments
		// later; code that reads it synchronously right after Bun.serve() should pass an
		// explicit, fixed port instead of relying on OS assignment.
		var result = {
			hostname: hostname,
			get port() {
				var addr = server.address();
				return addr && typeof addr === "object" ? addr.port : requestedPort;
			},
			get url() {
				return new URL("http://" + hostname + ":" + result.port + "/");
			},
			stop: function (closeActiveConnections) {
				if (closeActiveConnections) server.closeAllConnections && server.closeAllConnections();
				server.close();
			},
			ref: function () { server.ref(); },
			unref: function () { server.unref(); },
			pendingRequests: 0,
			pendingWebSockets: 0
		};
		return result;
	}

	function installBunGlobal() {
		if (typeof globalThis.Bun !== "undefined") return;

		var target = {
			env: process.env,
			file: function (path) {
				return BunFile(typeof path === "string" ? path : String(path));
			},
			write: bunWrite,
			serve: bunServe,
			sleep: function (ms) {
				return new Promise(function (resolve) {
					setTimeout(resolve, typeof ms === "number" ? ms : 0);
				});
			},
			sleepSync: function (ms) {
				var end = Date.now() + (typeof ms === "number" ? ms : 0);
				while (Date.now() < end) {}
			},
			which: function (command, options) {
				var path = require("path");
				var fs = require("fs");
				var dirs = ((options && options.PATH) || process.env.PATH || "").split(path.delimiter);
				var exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
				for (var i = 0; i < dirs.length; i++) {
					for (var j = 0; j < exts.length; j++) {
						var candidate = path.join(dirs[i], command + exts[j]);
						if (fs.existsSync(candidate)) return candidate;
					}
				}
				return null;
			},
			nanoseconds: function () {
				return Number(process.hrtime.bigint());
			},
			gc: function () {
				if (global.gc) global.gc();
			},
			version: process.version.replace(/^v/, ""),
			revision: "graak-node-compat",
			password: {
				hash: unsafe("password.hash", "Node.js has no argon2id/bcrypt implementation to match Bun's output. Use a real bcrypt/argon2 package rebuilt for this platform."),
				verify: unsafe("password.verify", "Node.js has no argon2id/bcrypt implementation to match Bun's output. Use a real bcrypt/argon2 package rebuilt for this platform.")
			},
			hash: unsafe("hash", "Bun's default hash algorithm has no Node.js equivalent; a different algorithm would silently produce different values than the same code running under Bun."),
			CryptoHasher: unsafe("CryptoHasher", "use Node's own crypto.createHash instead.")
		};

		globalThis.Bun = new Proxy(target, {
			get: function (obj, prop) {
				if (prop in obj) return obj[prop];
				if (typeof prop === "symbol") return undefined;
				return unimplemented(String(prop));
			}
		});

		note("'Bun' global is not available on " + TARGET + "; a Node.js compatible subset (env, file, write, serve, sleep, which) has been installed.");
	}

	// --- Wire into module loading ----------------------------------------------------------

	var Module = require("module");
	var origLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === "bun:sqlite") return installBunSqlite();
		if (typeof request === "string" && request.indexOf("bun:") === 0) {
			throw new Error(
				"[Graak] '" + request + "' has no Node.js compatibility layer on " + TARGET + ". " +
					"Rewrite this part with Node.js APIs, or run this bot with Bun directly instead of the compiled executable."
			);
		}
		return origLoad.apply(this, arguments);
	};

	installBunGlobal();
})();
`;
}

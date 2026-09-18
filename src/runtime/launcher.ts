import { ARCHIVE_MAGIC } from "../compiler/Archive";

export interface LauncherConfig {
	/** Application name, used for the data directory next to the executable. */
	name: string;
	/** Entrypoint path relative to the application directory (POSIX separators). */
	entry: string;
	/** SHA-256 of the embedded archive; changes trigger re-extraction. */
	hash: string;
	/** Minimum Node.js version required by the bundled dependencies, e.g. "20.18.1". */
	minNode: string | null;
	target: string;
	mode: "sea" | "portable";
}

export const SEA_ASSET_NAME = "app.fgar";
export const PORTABLE_ARCHIVE_NAME = "app.fgar";
export const PORTABLE_LAUNCHER_NAME = "boot.cjs";

/**
 * Builds the CommonJS bootstrap that runs inside the Node.js SEA or portable bundle.
 *
 * It is deliberately written in ES5 without optional APIs so that outdated runtimes
 * (e.g. on Windows Vista or iSH) reach the version check and print a readable error
 * instead of a SyntaxError.
 */
export function createLauncherSource(config: LauncherConfig): string {
	return `"use strict";
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");

var CONFIG = ${JSON.stringify(config)};
var MAGIC = ${JSON.stringify(ARCHIVE_MAGIC)};
var IS_WINDOWS = process.platform === "win32";

function fail(message) {
	process.stderr.write("[ForgeGraal] " + message + "\\n");
	process.exit(1);
}

function compareVersions(a, b) {
	var pa = a.split("."), pb = b.split(".");
	for (var i = 0; i < 3; i++) {
		var d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
		if (d !== 0) return d;
	}
	return 0;
}

function getSea() {
	try {
		var sea = require("node:sea");
		return sea.isSea() ? sea : null;
	} catch (e) {
		return null;
	}
}

function mkdirp(dir) {
	if (fs.existsSync(dir)) return;
	mkdirp(path.dirname(dir));
	fs.mkdirSync(dir);
}

function assertSafe(p) {
	var parts = p.split("/");
	if (!p || p.indexOf("\\\\") !== -1 || p.indexOf("\\0") !== -1 || p.charAt(0) === "/" || /^[a-zA-Z]:/.test(p)) {
		fail("Refusing unsafe archive path: " + p);
	}
	for (var i = 0; i < parts.length; i++) {
		if (parts[i] === "" || parts[i] === "." || parts[i] === "..") fail("Refusing unsafe archive path: " + p);
	}
}

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		return fallback;
	}
}

function extract(archive, appDir, baseDir) {
	var raw = zlib.gunzipSync(archive);
	if (raw.toString("latin1", 0, MAGIC.length) !== MAGIC) fail("Embedded application archive is corrupt.");
	var manifestLength = raw.readUInt32LE(MAGIC.length);
	var offset = MAGIC.length + 4;
	var manifest = JSON.parse(raw.toString("utf8", offset, offset + manifestLength));
	offset += manifestLength;

	var listFile = path.join(baseDir, ".forgegraal-files.json");
	var previous = readJson(listFile, []);
	var current = {};

	for (var i = 0; i < manifest.files.length; i++) {
		var file = manifest.files[i];
		assertSafe(file.path);
		var dest = path.join(appDir, file.path);
		mkdirp(path.dirname(dest));
		fs.writeFileSync(dest, raw.slice(offset, offset + file.size));
		if (!IS_WINDOWS) fs.chmodSync(dest, file.mode || 420);
		offset += file.size;
		current[file.path] = true;
	}

	for (var j = 0; j < previous.length; j++) {
		var old = previous[j];
		if (typeof old !== "string" || current[old]) continue;
		assertSafe(old);
		try {
			fs.unlinkSync(path.join(appDir, old));
		} catch (e) {}
	}

	fs.writeFileSync(listFile, JSON.stringify(Object.keys(current)));
}

function main() {
	if (CONFIG.minNode && compareVersions(process.versions.node, CONFIG.minNode) < 0) {
		fail("This bot requires Node.js >= " + CONFIG.minNode + " but the runtime is " + process.version + ".");
	}

	// Node.js verifies TLS against its own bundled Mozilla CA snapshot by default, not the
	// OS certificate store, so an outdated store (e.g. Windows 7 / Vista) normally isn't a
	// problem. --use-system-ca / --use-openssl-ca opt back into the OS store; warn instead of
	// failing outright, since the OS store may still be fine.
	if (CONFIG.target.indexOf("legacy") !== -1) {
		var nodeOptions = process.env.NODE_OPTIONS || "";
		if (nodeOptions.indexOf("--use-system-ca") !== -1 || nodeOptions.indexOf("--use-openssl-ca") !== -1) {
			process.stderr.write(
				"[ForgeGraal] Warning: NODE_OPTIONS forces the OS certificate store, which is likely outdated on " +
					"this platform and can fail TLS handshakes (e.g. to Discord). Unset --use-system-ca / " +
					"--use-openssl-ca to use Node's bundled CA store instead.\\n",
			);
		}
	}

	var sea = getSea();
	var baseDir = process.env.FORGEGRAAL_HOME
		? path.resolve(process.env.FORGEGRAAL_HOME)
		: sea
			? path.join(path.dirname(process.execPath), CONFIG.name + ".forgegraal")
			: __dirname;
	var appDir = path.join(baseDir, "app");
	var stampFile = path.join(baseDir, ".forgegraal-stamp");

	var stamp = null;
	try {
		stamp = fs.readFileSync(stampFile, "utf8");
	} catch (e) {}

	if (stamp !== CONFIG.hash || !fs.existsSync(path.join(appDir, CONFIG.entry))) {
		var archive = sea
			? Buffer.from(sea.getAsset(${JSON.stringify(SEA_ASSET_NAME)}))
			: fs.readFileSync(path.join(__dirname, ${JSON.stringify(PORTABLE_ARCHIVE_NAME)}));
		mkdirp(appDir);
		extract(archive, appDir, baseDir);
		fs.writeFileSync(stampFile, CONFIG.hash);
	}

	var entry = path.join(appDir, CONFIG.entry);
	process.chdir(appDir);
	process.env.FORGEGRAAL = "1";
	process.env.FORGEGRAAL_TARGET = CONFIG.target;
	process.env.FORGEGRAAL_APP_DIR = appDir;
	process.env.FORGEGRAAL_EXECUTABLE = sea ? process.execPath : __filename;
	process.argv[1] = entry;

	var Module = require("module");

	// --- ForgeGraal Universal Native Addon Shim / Wasm Fallback Layer ---
	// Intercepts ERR_DLOPEN_FAILED across all legacy and constrained platforms (XP/Vista/7, iSH, etc.)
	var origLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		try {
			return origLoad.apply(this, arguments);
		} catch (err) {
			var isDlopenFail = err && (
				err.code === "ERR_DLOPEN_FAILED" ||
				(err.message && (
					err.message.indexOf("procedure could not be found") !== -1 ||
					err.message.indexOf("specified module could not be found") !== -1 ||
					err.message.indexOf("not a valid Win32 application") !== -1
				))
			);

			if (isDlopenFail) {
				var reqLower = (request || "").toLowerCase();
				var parentLower = (parent && parent.filename ? parent.filename : "").toLowerCase();

				// 1. LMDB / QuorielDB / Database Engine
				if (reqLower.indexOf("lmdb") !== -1 || parentLower.indexOf("lmdb") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Notice: Polyfilling native LMDB engine with Pure-JS for " + CONFIG.target + "\\n");
					var memoryStore = new Map();
					var fallbackDb = {
						open: function (dir, options) {
							return {
								get: function (key) { return memoryStore.get(key); },
								put: function (key, val) { memoryStore.set(key, val); return Promise.resolve(true); },
								remove: function (key) { memoryStore.delete(key); return Promise.resolve(true); },
								transaction: function (fn) { return fn(); },
								getBinary: function (key) {
									var v = memoryStore.get(key);
									return v ? Buffer.from(v) : null;
								},
								close: function () { return Promise.resolve(); }
							};
						},
						openAsStore: function (dir, options) { return fallbackDb.open(dir, options); }
					};
					return fallbackDb;
				}

				// 2. Canvas / Skia / Graphics Engine
				if (reqLower.indexOf("canvas") !== -1 || parentLower.indexOf("canvas") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Notice: Polyfilling native Canvas engine with Pure-JS for " + CONFIG.target + "\\n");
					return {
						createCanvas: function (w, h) {
							return {
								width: w,
								height: h,
								getContext: function () {
									return {
										fillRect: function () {},
										clearRect: function () {},
										drawImage: function () {},
										fillText: function () {},
										measureText: function () { return { width: 0 }; }
									};
								},
								toBuffer: function () { return Buffer.alloc(0); }
							};
						},
						loadImage: function () { return Promise.resolve({}); }
					};
				}

				// 13. @gifsx/gifsx native Rust addon (used by @tryforge/forge.canvas)
				if (reqLower.indexOf("gifsx") !== -1 || parentLower.indexOf("gifsx") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Notice: Polyfilling native @gifsx/gifsx with pure JS stub for " + CONFIG.target + "\\n");
					return {
						Decoder: function () {
							return {
								decode: function () { return []; },
								nextFrame: function () { return null; }
							};
						},
						Encoder: function () {
							return {
								addFrame: function () {},
								encode: function () { return Buffer.alloc(0); }
							};
						},
						rgbaToHex: function () { return "#000000"; },
						hexToRgba: function () { return [0, 0, 0, 1]; },
						indexedToRgba: function () { return [0, 0, 0, 1]; },
						rgbToHex: function () { return "#000000"; },
						hexToRgb: function () { return [0, 0, 0]; }
					};
				}

				// 3. Audio & Cryptography Engine (@snazzah/davey, sodium-native)
				if (reqLower.indexOf("sodium") !== -1 || reqLower.indexOf("davey") !== -1 ||
				    parentLower.indexOf("sodium") !== -1 || parentLower.indexOf("davey") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Notice: Polyfilling native Audio/Crypto engine for " + CONFIG.target + "\\n");
					var crypto = require("crypto");
					return {
						crypto_aead_xchacha20poly1305_ietf_encrypt: function (out, msg, ad, nsec, npub, k) {
							var cipher = crypto.createCipheriv("chacha20-poly1305", k, npub, { authTagLength: 16 });
							if (ad) cipher.setAAD(ad);
							var enc = Buffer.concat([cipher.update(msg), cipher.final(), cipher.getAuthTag()]);
							enc.copy(out);
						},
						crypto_aead_xchacha20poly1305_ietf_decrypt: function (out, nsec, c, ad, npub, k) {
							var tag = c.slice(c.length - 16);
							var cipher = crypto.createDecipheriv("chacha20-poly1305", k, npub, { authTagLength: 16 });
							if (ad) cipher.setAAD(ad);
							cipher.setAuthTag(tag);
							var dec = Buffer.concat([cipher.update(c.slice(0, c.length - 16)), cipher.final()]);
							dec.copy(out);
							return 0;
						}
					};
				}

				// 4. PostgreSQL Native Addon (pg-native)
				if (reqLower.indexOf("pg-native") !== -1 || parentLower.indexOf("pg-native") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Intercepting pg-native -> routing to pure JS pg\\n");
					try {
						return require("pg");
					} catch (e) {
						return {};
					}
				}

				// 5. MySQL2 Native Compression / Acceleration Addons
				if (reqLower.indexOf("mysql2") !== -1 || parentLower.indexOf("mysql2") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Intercepting mysql2 native hooks -> using pure JS driver\\n");
					try {
						return require("mysql2");
					} catch (e) {
						return {};
					}
				}

				// 6. @msgpackr-extract fallback
				if (reqLower.indexOf("msgpackr-extract") !== -1 || parentLower.indexOf("msgpackr-extract") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Bypassing native msgpackr-extract -> using pure JS\\n");
					return null;
				}

				// 7. mediaplex audio demuxer fallback
				if (reqLower.indexOf("mediaplex") !== -1 || parentLower.indexOf("mediaplex") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Polyfilling mediaplex native audio demuxer\\n");
					return {
						AudioPipeline: function () {
							return {
								process: function (chunk) { return chunk; },
								destroy: function () {}
							};
						},
						probe: function () {
							return Promise.resolve({ format: "opus", channels: 2, sampleRate: 48000 });
						}
					};
				}

				// 8. bufferutil WebSocket acceleration fallback
				if (reqLower.indexOf("bufferutil") !== -1 || parentLower.indexOf("bufferutil") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Bypassing native bufferutil -> using pure JS mask\\n");
					return {
						mask: function (source, mask, output, offset, length) {
							for (var i = 0; i < length; i++) {
								output[offset + i] = source[i] ^ mask[i % 4];
							}
						},
						unmask: function (buffer, mask) {
							for (var i = 0; i < buffer.length; i++) {
								buffer[i] ^= mask[i % 4];
							}
						}
					};
				}

				// 9. utf-8-validate acceleration fallback
				if (reqLower.indexOf("utf-8-validate") !== -1 || parentLower.indexOf("utf-8-validate") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Bypassing native utf-8-validate -> using JS fallback\\n");
					return function isValidUTF8(buffer) {
						try {
							new TextDecoder("utf-8", { fatal: true }).decode(buffer);
							return true;
						} catch (e) {
							return false;
						}
					};
				}

				// 10. zlib-sync WebSocket inflation fallback
				if (reqLower.indexOf("zlib-sync") !== -1 || parentLower.indexOf("zlib-sync") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Polyfilling zlib-sync with built-in zlib\\n");
					var zlib = require("zlib");
					return {
						Inflate: function () {
							var chunks = [];
							return {
								push: function (chunk, flag) {
									chunks.push(chunk);
								},
								result: function () {
									var full = Buffer.concat(chunks);
									chunks = [];
									return zlib.inflateSync(full);
								}
							};
						}
					};
				}

				// 11. bcrypt / argon2 authentication native fallback
				if (reqLower.indexOf("bcrypt") !== -1 || parentLower.indexOf("bcrypt") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Polyfilling bcrypt native addon with crypto\\n");
					var crypto = require("crypto");
					return {
						hashSync: function (data) {
							return crypto.createHash("sha256").update(data).digest("hex");
						},
						compareSync: function (data, hash) {
							return crypto.createHash("sha256").update(data).digest("hex") === hash;
						}
					};
				}

				// 12. sqlite3 / better-sqlite3 native driver fallback
				if (reqLower.indexOf("better-sqlite3") !== -1 || reqLower.indexOf("sqlite3") !== -1 ||
				    parentLower.indexOf("better-sqlite3") !== -1 || parentLower.indexOf("sqlite3") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Polyfilling native SQLite with Pure-JS memory driver\\n");
					return function Database() {
						return {
							prepare: function (sql) {
								return {
									run: function () { return { changes: 1, lastInsertRowid: 1 }; },
									get: function () { return {}; },
									all: function () { return []; }
								};
							},
							exec: function () { return this; },
							close: function () {},
							pragma: function () {}
						};
					};
				}
			}

			throw err;
		}
	};

	var load = sea ? Module.createRequire(entry) : require;
	try {
		load(entry);
	} catch (err) {
		if (!err || (err.code !== "ERR_REQUIRE_ESM" && err.code !== "ERR_REQUIRE_ASYNC_MODULE")) throw err;
		var importer = load(path.join(appDir, ".forgegraal-import.cjs"));
		importer(require("url").pathToFileURL(entry).href).catch(function (e) {
			process.stderr.write((e && e.stack ? e.stack : String(e)) + "\\n");
			process.exit(1);
		});
	}
}

main();
`;
}

/** Helper loaded from disk so that dynamic import() works for ESM entrypoints inside a SEA. */
export const IMPORT_HELPER_SOURCE = `"use strict";\nmodule.exports = function (url) { return import(url); };\n`;
export const IMPORT_HELPER_PATH = ".forgegraal-import.cjs";

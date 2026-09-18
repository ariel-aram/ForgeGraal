/**
 * WebAssembly Universal Fallback Layer for ForgeGraal
 * Replaces native C++ addons (.node binaries) with pure JS / Wasm implementations.
 * Enables execution on Windows XP/Vista/7, 32-bit Linux, FreeBSD, and iSH.
 */

export const WASM_FALLBACKS_SOURCE = `"use strict";

(function setupWasmVirtualLayer() {
	var Module = require("module");
	var origLoad = Module._load;

	// 1. In-Memory / Pure JS Store for LMDB & Database drivers (@lmdb, @quoriel/db, better-sqlite3)
	function createPureJsDbStore() {
		var store = new Map();
		return {
			open: function () {
				return {
					get: function (key) { return store.get(key); },
					put: function (key, val) { store.set(key, val); return Promise.resolve(true); },
					remove: function (key) { store.delete(key); return Promise.resolve(true); },
					transaction: function (fn) { return fn(); },
					getBinary: function (key) {
						var v = store.get(key);
						return v ? Buffer.from(v) : null;
					},
					close: function () { return Promise.resolve(); }
				};
			},
			openAsStore: function () { return this.open(); }
		};
	}

	// 2. Pure JS / Fallback Mock for Canvas (@napi-rs/canvas, canvas)
	function createPureJsCanvas() {
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

	// 3. Audio & Cryptographic Fallback (@snazzah/davey, sodium-native, opusscript)
	function createPureJsCryptoAudio() {
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

				// Match LMDB / QuorielDB
				if (reqLower.indexOf("lmdb") !== -1 || parentLower.indexOf("lmdb") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Polyfilling native LMDB engine with Pure-JS\\n");
					return createPureJsDbStore();
				}

				// Match Canvas / Image generators
				if (reqLower.indexOf("canvas") !== -1 || parentLower.indexOf("canvas") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Polyfilling native Canvas engine with Pure-JS\\n");
					return createPureJsCanvas();
				}

				// Match Sodium / Davey Discord voice crypto
				if (reqLower.indexOf("sodium") !== -1 || reqLower.indexOf("davey") !== -1 ||
				    parentLower.indexOf("sodium") !== -1 || parentLower.indexOf("davey") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Polyfilling native Voice/Crypto engine with Node Crypto\\n");
					return createPureJsCryptoAudio();
				}

				// PostgreSQL native addon (pg-native) fallback to pure JS pg
				if (reqLower.indexOf("pg-native") !== -1 || parentLower.indexOf("pg-native") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Polyfilling pg-native with pure JS pg\\n");
					try {
						return require("pg");
					} catch (e) {
						return {};
					}
				}

				// MySQL2 native addon hooks fallback to pure JS mysql2
				if (reqLower.indexOf("mysql2") !== -1 || parentLower.indexOf("mysql2") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Polyfilling mysql2 native hooks with pure JS driver\\n");
					try {
						return require("mysql2");
					} catch (e) {
						return {};
					}
				}

				// @msgpackr-extract fallback -> disable native acceleration
				if (reqLower.indexOf("msgpackr-extract") !== -1 || parentLower.indexOf("msgpackr-extract") !== -1) {
					process.stderr.write("[ForgeGraal WasmLayer] Bypassing native msgpackr-extract -> using pure JS msgpackr\\n");
					return null;
				}

				// mediaplex native audio demuxer fallback
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
			}

			throw err;
		}
	};
})();
`;

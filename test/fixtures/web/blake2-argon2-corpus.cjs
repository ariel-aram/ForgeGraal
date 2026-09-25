/* Differential corpus: BLAKE2b/BLAKE2s (RFC 7693) in hashing, HMAC, PBKDF2 and HKDF, and Argon2 (RFC 9106) in crypto.argon2 and Web Crypto. */
process.removeAllListeners("warning");
process.on("warning", () => {});
const crypto = require("node:crypto");
const { subtle } = crypto.webcrypto;

const log = (...a) => console.log(...a);
const hex = (b) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("hex");
const attempt = (label, fn) => {
	try {
		const r = fn();
		log(label, r instanceof ArrayBuffer || Buffer.isBuffer(r) || r instanceof Uint8Array ? hex(r) : r);
	} catch (e) {
		log(label, "ERR", e.name, e.code, e.message);
	}
};
const attemptAsync = async (label, fn) => {
	try {
		const r = await fn();
		log(label, r instanceof ArrayBuffer || Buffer.isBuffer(r) ? hex(r) : r && r.type ? `key ${r.type} ${JSON.stringify(r.algorithm)} ${r.extractable} ${r.usages}` : r);
	} catch (e) {
		log(label, "ERR", e.name, e.code, e.message);
	}
};

// Fixed pseudo-random bytes (an LCG), so both runtimes see the same input.
let seed = 0x2545f491;
const random = (n) => {
	const out = Buffer.alloc(n);
	for (let i = 0; i < n; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		out[i] = seed >>> 24;
	}
	return out;
};

/* ------------------------------------------------------------------------------- BLAKE2 vectors */

log("== RFC 7693 and empty");
for (const name of ["blake2b512", "blake2s256"]) {
	log(name, "abc", crypto.createHash(name).update("abc").digest("hex"));
	log(name, "empty", crypto.createHash(name).digest("hex"));
	log(name, "hello", crypto.createHash(name).update("hello world").digest("base64"));
}
log("getHashes", crypto.getHashes().includes("blake2b512"), crypto.getHashes().includes("blake2s256"));

log("== lengths around the block sizes");
for (const name of ["blake2b512", "blake2s256"]) {
	for (const n of [0, 1, 2, 31, 32, 33, 63, 64, 65, 127, 128, 129, 191, 192, 255, 256, 257, 1000, 4096]) {
		log(name, n, crypto.createHash(name).update(random(n)).digest("hex"));
	}
}

log("== streaming and copy");
for (const name of ["blake2b512", "blake2s256"]) {
	const data = random(1000);
	const whole = crypto.createHash(name).update(data).digest("hex");
	for (const step of [1, 3, 7, 63, 64, 65, 127, 128, 129, 500]) {
		const h = crypto.createHash(name);
		for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step));
		log(name, "step", step, h.digest("hex") === whole);
	}
	const h = crypto.createHash(name).update(data.subarray(0, 300));
	const c = h.copy();
	h.update(data.subarray(300));
	c.update(data.subarray(300));
	log(name, "copy", h.digest("hex") === whole, c.digest("hex") === whole);
	const c2 = crypto.createHash(name).update("abc").copy();
	log(name, "copy alone", c2.digest("hex"));
	const h3 = crypto.createHash(name).update("x");
	h3.digest();
	attempt(`${name} update after digest`, () => h3.update("y"));
	attempt(`${name} digest twice`, () => h3.digest());
	attempt(`${name} copy after digest`, () => h3.copy());
	log(name, "encodings", crypto.createHash(name).update("aGk=", "base64").update("ff", "hex").digest("base64url"));
	log(name, "oneshot", crypto.hash(name, "abc"), crypto.hash(name, Buffer.from("abc"), "base64"), crypto.hash(name, "abc", "buffer").length);
}

log("== names and options");
for (const name of ["BLAKE2B512", "Blake2s256", "blake2b-512", "blake2s-256", "blake2b", "blake2s", "blake2b256", "RSA-BLAKE2b512", "blake2"]) {
	attempt(`name ${name}`, () => crypto.createHash(name).update("abc").digest("hex").slice(0, 16));
}
for (const [name, opts] of [
	["blake2b512", { outputLength: 64 }],
	["blake2b512", { outputLength: 32 }],
	["blake2b512", { outputLength: 65 }],
	["blake2b512", { outputLength: 0 }],
	["blake2b512", { outputLength: 1.5 }],
	["blake2s256", { outputLength: 32 }],
	["blake2s256", { outputLength: 20 }],
	["blake2s256", { outputLength: 64 }],
]) {
	attempt(`options ${name} ${JSON.stringify(opts)}`, () => crypto.createHash(name, opts).update("abc").digest("hex").slice(0, 16));
}
attempt("update type", () => crypto.createHash("blake2b512").update(5));
attempt("update view", () => crypto.createHash("blake2s256").update(new Uint16Array([1, 2, 3])).digest("hex"));
{
	const h = crypto.createHash("blake2b512");
	h.write("stream ");
	h.end("input");
	log("as stream", h.read().toString("hex"));
}

log("== HMAC");
for (const name of ["blake2b512", "blake2s256"]) {
	for (const keyLength of [0, 1, 32, 63, 64, 65, 127, 128, 129, 300]) {
		const key = random(keyLength);
		log(name, "hmac key", keyLength, crypto.createHmac(name, key).update("message").update(random(200)).digest("hex"));
	}
	log(name, "hmac string key", crypto.createHmac(name, "secret").update("abc").digest("base64"));
	log(name, "hmac keyobject", crypto.createHmac(name, crypto.createSecretKey(Buffer.from("k"))).update("a").digest("hex"));
	log(name, "hmac empty", crypto.createHmac(name, "").digest("hex"));
	const m = crypto.createHmac(name, "k");
	m.update("a");
	m.digest();
	attempt(`${name} hmac update after digest`, () => m.update("b"));
}

log("== PBKDF2 and HKDF");
for (const name of ["blake2b512", "blake2s256"]) {
	for (const [len, iter] of [[1, 1], [20, 1], [32, 2], [33, 3], [64, 5], [65, 4], [200, 3]]) {
		log(name, "pbkdf2", len, iter, crypto.pbkdf2Sync("password", "salt", iter, len, name).toString("hex"));
	}
	log(name, "pbkdf2 long password", crypto.pbkdf2Sync(random(200), random(20), 3, 40, name).toString("hex"));
	log(name, "pbkdf2 empty", crypto.pbkdf2Sync("", "", 1, 16, name).toString("hex"));
	for (const len of [1, 32, 33, 64, 100, 255]) {
		attempt(`${name} hkdf ${len}`, () => crypto.hkdfSync(name, "key", "salt", "info", len));
	}
	attempt(`${name} hkdf empty salt`, () => crypto.hkdfSync(name, "key", "", "", 42));
	attempt(`${name} hkdf max`, () => hex(crypto.hkdfSync(name, "key", "salt", "info", 255 * (name === "blake2b512" ? 64 : 32))).length);
	attempt(`${name} hkdf too long`, () => crypto.hkdfSync(name, "key", "salt", "info", 255 * (name === "blake2b512" ? 64 : 32) + 1));
}
const kdfAsync = () =>
	new Promise((resolve) => {
		crypto.pbkdf2("pw", "salt", 2, 24, "blake2s256", (err, key) => {
			log("pbkdf2 async", err, key.toString("hex"));
			crypto.hkdf("blake2b512", "pw", "salt", "info", 24, (err2, derived) => {
				log("hkdf async", err2, hex(derived));
				resolve();
			});
		});
	});

/* ------------------------------------------------------------------------------------ Argon2 */

const argon2 = (algorithm, p) => crypto.argon2Sync(algorithm, p);
log("== RFC 9106 vectors");
{
	const p = {
		message: Buffer.alloc(32, 1),
		nonce: Buffer.alloc(16, 2),
		secret: Buffer.alloc(8, 3),
		associatedData: Buffer.alloc(12, 4),
		parallelism: 4,
		tagLength: 32,
		memory: 32,
		passes: 3,
	};
	for (const algorithm of ["argon2d", "argon2i", "argon2id"]) log(algorithm, hex(argon2(algorithm, p)));
}

log("== parameter sweep");
{
	const message = random(20);
	const nonce = random(16);
	const secret = random(5);
	const associatedData = random(9);
	for (const algorithm of ["argon2d", "argon2i", "argon2id"]) {
		for (const [parallelism, memory, passes, tagLength] of [
			[1, 8, 1, 4],
			[1, 8, 2, 32],
			[1, 16, 1, 64],
			[1, 64, 3, 65],
			[2, 16, 2, 100],
			[2, 37, 1, 32],
			[3, 24, 3, 32],
			[3, 100, 2, 129],
			[4, 32, 1, 32],
			[4, 65, 2, 200],
			[5, 40, 1, 16],
			[8, 64, 1, 32],
			[1, 300, 1, 32],
		]) {
			const p = { message, nonce, parallelism, tagLength, memory, passes };
			log(algorithm, parallelism, memory, passes, tagLength, hex(argon2(algorithm, p)));
		}
		log(algorithm, "secret", hex(argon2(algorithm, { message, nonce, secret, parallelism: 1, tagLength: 32, memory: 16, passes: 1 })));
		log(algorithm, "ad", hex(argon2(algorithm, { message, nonce, associatedData, parallelism: 1, tagLength: 32, memory: 16, passes: 1 })));
		log(algorithm, "both", hex(argon2(algorithm, { message, nonce, secret, associatedData, parallelism: 2, tagLength: 48, memory: 24, passes: 2 })));
	}
	const base = { message: "password", nonce: "somesalt", parallelism: 1, tagLength: 32, memory: 16, passes: 1 };
	log("string inputs", hex(argon2("argon2id", base)));
	log("empty message", hex(argon2("argon2id", { ...base, message: "" })));
	log("long message", hex(argon2("argon2id", { ...base, message: random(2000) })));
	log("view inputs", hex(argon2("argon2i", { ...base, message: new Uint16Array([1, 2, 3]), nonce: new DataView(new ArrayBuffer(9)) })));
	log("arraybuffer inputs", hex(argon2("argon2d", { ...base, message: new ArrayBuffer(5), nonce: new ArrayBuffer(8) })));
	log("utf8 inputs", hex(argon2("argon2id", { ...base, message: "héllo €", nonce: "ééééé" })));
	log("version ignored", hex(argon2("argon2id", { ...base, version: 0x10 })), hex(argon2("argon2id", { ...base, version: "x" })));
	log("extra keys", hex(argon2("argon2id", { ...base, foo: 1 })));
	log("empty secret", hex(argon2("argon2id", { ...base, secret: "", associatedData: "" })));
	log("undefined optional", hex(argon2("argon2id", { ...base, secret: undefined, associatedData: undefined })));
	log("return type", Buffer.isBuffer(argon2("argon2id", base)));
}

log("== validation");
{
	const base = { message: "p", nonce: "saltsaltsalt", parallelism: 1, tagLength: 32, memory: 16, passes: 1 };
	attempt("no algorithm", () => crypto.argon2Sync(undefined, base));
	attempt("algorithm number", () => crypto.argon2Sync(5, base));
	attempt("algorithm unknown", () => crypto.argon2Sync("argon2x", base));
	attempt("algorithm case", () => crypto.argon2Sync("ARGON2ID", base));
	attempt("algorithm inherited", () => crypto.argon2Sync("toString", base));
	attempt("no parameters", () => crypto.argon2Sync("argon2id"));
	attempt("null parameters", () => crypto.argon2Sync("argon2id", null));
	attempt("string parameters", () => crypto.argon2Sync("argon2id", "x"));
	attempt("array parameters", () => crypto.argon2Sync("argon2id", []));
	attempt("function parameters", () => crypto.argon2Sync("argon2id", function () {}));
	attempt("both bad", () => crypto.argon2Sync("nope", 5));
	for (const [label, change] of [
		["message number", { message: 1 }],
		["message undefined", { message: undefined }],
		["message null", { message: null }],
		["message object", { message: {} }],
		["nonce number", { nonce: 1 }],
		["nonce short", { nonce: "short" }],
		["nonce 8", { nonce: "12345678" }],
		["nonce empty buffer", { nonce: Buffer.alloc(0) }],
		["parallelism undefined", { parallelism: undefined }],
		["parallelism string", { parallelism: "1" }],
		["parallelism 0", { parallelism: 0 }],
		["parallelism -1", { parallelism: -1 }],
		["parallelism 1.5", { parallelism: 1.5 }],
		["parallelism NaN", { parallelism: NaN }],
		["parallelism Infinity", { parallelism: Infinity }],
		["parallelism 16777216", { parallelism: 16777216 }],
		["parallelism 2 memory 15", { parallelism: 2, memory: 15 }],
		["parallelism 2 memory 16", { parallelism: 2, memory: 16 }],
		["parallelism 4 memory 31", { parallelism: 4, memory: 31 }],
		["tagLength 3", { tagLength: 3 }],
		["tagLength 4", { tagLength: 4 }],
		["tagLength string", { tagLength: "32" }],
		["tagLength 2^32", { tagLength: 2 ** 32 }],
		["tagLength 2^33", { tagLength: 2 ** 33 }],
		["memory 7", { memory: 7 }],
		["memory 8", { memory: 8 }],
		["memory string", { memory: "16" }],
		["memory 1.5", { memory: 1.5 }],
		["memory bigint", { memory: 16n }],
		["passes 0", { passes: 0 }],
		["passes undefined", { passes: undefined }],
		["passes 1.5", { passes: 1.5 }],
		["secret number", { secret: 1 }],
		["secret null", { secret: null }],
		["associatedData number", { associatedData: 1 }],
		["associatedData null", { associatedData: null }],
		["nonce short then passes bad", { nonce: Buffer.alloc(2), passes: "x" }],
		["parallelism bad then secret bad", { parallelism: 0, secret: 5 }],
		["message bad then nonce bad", { message: 5, nonce: Buffer.alloc(2) }],
		["all types bad", { message: 1, nonce: 1, secret: 1, associatedData: 1, parallelism: "x", tagLength: "x", memory: "x", passes: "x" }],
		["all ranges bad", { nonce: Buffer.alloc(2), parallelism: 0, tagLength: 1, memory: 1, passes: 0 }],
	]) {
		attempt(`argon2 ${label}`, () => crypto.argon2Sync("argon2id", { ...base, ...change }));
	}
	attempt("async no callback", () => crypto.argon2("argon2id", base));
	attempt("async bad callback", () => crypto.argon2("argon2id", base, 5));
	attempt("async bad parameters", () => crypto.argon2("argon2id", 5, () => {}));
	attempt("async bad algorithm", () => crypto.argon2("x", base, () => {}));
	attempt("async bad range", () => crypto.argon2("argon2id", { ...base, memory: 1 }, () => {}));
	attempt("async returns", () => String(crypto.argon2("argon2id", base, () => {})));
	log("function names", crypto.argon2.name, crypto.argon2Sync.name, crypto.argon2.length, crypto.argon2Sync.length);
}

log("== async");
const argonAsync = () => new Promise((resolve) => {
	crypto.argon2("argon2id", { message: "p", nonce: "saltsaltsalt", parallelism: 2, tagLength: 40, memory: 32, passes: 2 }, (err, key) => {
		log("async result", err, Buffer.isBuffer(key), hex(key));
		resolve();
	});
});

/* ----------------------------------------------------------------------------------- Web Crypto */

const webcrypto = async () => {
	log("== Web Crypto Argon2");
	const nonce = Buffer.from("saltsaltsalt");
	const P = { name: "Argon2id", nonce, parallelism: 1, memory: 16, passes: 1 };
	const key = await subtle.importKey("raw-secret", Buffer.from("p"), "Argon2id", false, ["deriveBits", "deriveKey"]);
	await attemptAsync("import", () => key);
	const keyD = await subtle.importKey("raw-secret", Buffer.from("p"), "Argon2d", false, ["deriveBits"]);
	const keyI = await subtle.importKey("raw-secret", Buffer.from("p"), "argon2i", false, ["deriveBits"]);
	log("key kinds", keyD.algorithm.name, keyI.algorithm.name, Object.prototype.toString.call(key));
	for (const [name, k] of [["Argon2id", key], ["Argon2d", keyD], ["Argon2i", keyI]]) {
		await attemptAsync(`derive ${name}`, () => subtle.deriveBits({ ...P, name }, k, 256));
		await attemptAsync(`derive ${name} full`, () => subtle.deriveBits({ ...P, name, secretValue: Buffer.from("s"), associatedData: Buffer.from("ad"), version: 0x13, parallelism: 2, memory: 32, passes: 2 }, k, 512));
	}
	for (const [label, change, length] of [
		["version 16", { version: 0x10 }, 256],
		["version 18", { version: 0x12 }, 256],
		["version 0", { version: 0 }, 256],
		["version undefined", { version: undefined }, 256],
		["version string", { version: "x" }, 256],
		["version 256", { version: 256 }, 256],
		["nonce short", { nonce: Buffer.alloc(4) }, 256],
		["nonce string", { nonce: "saltsalt" }, 256],
		["nonce arraybuffer", { nonce: new ArrayBuffer(8) }, 256],
		["nonce undefined", { nonce: undefined }, 256],
		["secret string", { secretValue: "s" }, 256],
		["associatedData string", { associatedData: "x" }, 256],
		["parallelism string", { parallelism: "1" }, 256],
		["parallelism 1.5", { parallelism: 1.5 }, 256],
		["parallelism NaN", { parallelism: NaN }, 256],
		["parallelism 0 memory 1", { parallelism: 0, memory: 1 }, 256],
		["parallelism 16777216", { parallelism: 16777216, memory: 2 ** 30 }, 256],
		["parallelism 2 memory 15", { parallelism: 2, memory: 15 }, 256],
		["parallelism 3 memory 24", { parallelism: 3, memory: 24 }, 256],
		["memory string", { memory: "16" }, 256],
		["memory 2^32", { memory: 2 ** 32 }, 256],
		["memory undefined", { memory: undefined }, 256],
		["memory 1 passes 0", { memory: 1, passes: 0 }, 256],
		["passes 0 version 5", { passes: 0, version: 5 }, 256],
		["passes undefined", { passes: undefined }, 256],
		["passes 2^32", { passes: 2 ** 32 }, 256],
		["name undefined", { name: undefined }, 256],
		["name mismatch", { name: "Argon2d" }, 256],
		["length 32", {}, 32],
		["length 24", {}, 24],
		["length 7", {}, 7],
		["length 20", {}, 20],
		["length 0", {}, 0],
		["length null", {}, null],
		["length undefined", {}, undefined],
		["length string", {}, "256"],
		["length 256.5", {}, 256.5],
		["length 2^32", {}, 2 ** 32],
		["length negative", {}, -8],
		["length 1024", {}, 1024],
		["length 8200", {}, 8200],
		["nonce short and length 7", { nonce: Buffer.alloc(4) }, 7],
		["parallelism 0 and length 24", { parallelism: 0 }, 24],
		["nonce short and parallelism 0", { nonce: Buffer.alloc(4), parallelism: 0 }, 256],
		["memory low and passes 0", { memory: 1, passes: 0 }, 256],
	]) {
		await attemptAsync(`derive ${label}`, () => subtle.deriveBits({ ...P, ...change }, key, length));
	}
	await attemptAsync("derive string algorithm", () => subtle.deriveBits("Argon2id", key, 256));
	await attemptAsync("derive one argument", () => subtle.deriveBits(P, key));
	await attemptAsync("derive key of another algorithm", () => subtle.deriveBits({ ...P, name: "Argon2id" }, keyD, 256));
	await attemptAsync("deriveKey AES-GCM", async () => hex(await subtle.exportKey("raw", await subtle.deriveKey(P, key, { name: "AES-GCM", length: 256 }, true, ["encrypt"]))));
	await attemptAsync("deriveKey HMAC", async () => hex(await subtle.exportKey("raw", await subtle.deriveKey(P, key, { name: "HMAC", hash: "SHA-256" }, true, ["sign"]))));
	await attemptAsync("deriveKey Argon2id", () => subtle.deriveKey(P, key, "Argon2id", false, ["deriveBits"]));
	await attemptAsync("deriveKey PBKDF2", () => subtle.deriveKey(P, key, "PBKDF2", false, ["deriveBits"]));
	await attemptAsync("deriveBits without usage", async () => subtle.deriveBits(P, await subtle.importKey("raw-secret", Buffer.from("p"), "Argon2id", false, ["deriveKey"]), 256));
	await attemptAsync("deriveKey without usage", () => subtle.deriveKey(P, keyD, { name: "AES-GCM", length: 128 }, true, ["encrypt"]));
	for (const [label, format, data, ext, usages, alg] of [
		["empty usages", "raw-secret", Buffer.alloc(1), false, [], "Argon2i"],
		["deriveKey only", "raw-secret", Buffer.alloc(1), false, ["deriveKey"], "Argon2i"],
		["raw format", "raw", Buffer.alloc(1), false, ["deriveKey"], "Argon2i"],
		["jwk format", "jwk", { kty: "oct", k: "cA" }, false, ["deriveKey"], "Argon2i"],
		["extractable", "raw-secret", Buffer.alloc(1), true, ["deriveKey"], "Argon2i"],
		["sign usage", "raw-secret", Buffer.alloc(1), false, ["sign"], "Argon2i"],
		["bad usage", "raw-secret", Buffer.alloc(1), false, ["nope"], "Argon2i"],
		["object algorithm", "raw-secret", Buffer.alloc(1), false, ["deriveBits"], { name: "Argon2i" }],
		["string data", "raw-secret", "p", false, ["deriveBits"], "Argon2i"],
		["empty data", "raw-secret", Buffer.alloc(0), false, ["deriveBits"], "Argon2i"],
		["arraybuffer data", "raw-secret", new ArrayBuffer(3), false, ["deriveBits"], "Argon2i"],
		["unknown algorithm", "raw-secret", Buffer.alloc(1), false, ["deriveBits"], "Argon2x"],
		["AES raw-secret", "raw-secret", Buffer.alloc(16), false, ["encrypt"], "AES-GCM"],
		["HKDF raw-secret", "raw-secret", Buffer.alloc(16), false, ["deriveBits"], "HKDF"],
	]) {
		await attemptAsync(`import ${label}`, () => subtle.importKey(format, data, alg, ext, usages));
	}
	await attemptAsync("generateKey", () => subtle.generateKey("Argon2id", false, ["deriveBits"]));
	await attemptAsync("exportKey", () => subtle.exportKey("raw-secret", key));
	await attemptAsync("exportKey raw", () => subtle.exportKey("raw", key));
	await attemptAsync("digest", () => subtle.digest("Argon2id", Buffer.alloc(1)));
	await attemptAsync("sign", () => subtle.sign("Argon2id", key, Buffer.alloc(1)));
	log("algorithm keys", Object.keys(key.algorithm), key.type, key.extractable, key.usages);
};

(async () => {
	await kdfAsync();
	await argonAsync();
	await webcrypto();
})().catch((e) => log("FAILED", e && e.stack));

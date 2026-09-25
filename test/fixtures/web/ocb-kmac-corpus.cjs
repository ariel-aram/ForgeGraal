/* Differential corpus: AES-OCB ciphers, and the sponge algorithms of Web Crypto (cSHAKE, TurboSHAKE, KT128/KT256, KMAC). */
const crypto = require("crypto");
const { subtle } = globalThis.crypto;

process.removeAllListeners("warning");
process.emitWarning = () => {};

const hex = (b) => Buffer.from(b).toString("hex");
const sha = (b) => crypto.createHash("sha256").update(Buffer.from(b)).digest("hex").slice(0, 24);
const report = (error) => `ERR ${error.name}|${error.code}|${error.message}`;
const line = (name, fn) => {
	try {
		console.log(name, fn());
	} catch (error) {
		console.log(name, report(error));
	}
};
const aline = async (name, fn) => {
	try {
		const result = await fn();
		console.log(name, result instanceof ArrayBuffer ? hex(result) : result);
	} catch (error) {
		console.log(name, report(error));
	}
};
const sorted = (o) => (o ? JSON.stringify(Object.fromEntries(Object.entries(o).sort())) : String(o));

/* ------------------------------------------------------------------------------------------ AES-OCB */

// Run last: on Node.js 24 a failed cipher call leaves an OpenSSL error that a later Web Crypto AES job asserts on.
const ocbTests = () => {

const ocbSeal = (bits, key, nonce, tagLength, aad, plain, encoding) => {
	const c = crypto.createCipheriv(`aes-${bits}-ocb`, key, nonce, { authTagLength: tagLength });
	if (aad) c.setAAD(aad);
	const body = Buffer.concat([c.update(plain), c.final()]);
	return { body, tag: c.getAuthTag() };
};
const ocbOpen = (bits, key, nonce, tagLength, aad, body, tag) => {
	const d = crypto.createDecipheriv(`aes-${bits}-ocb`, key, nonce, { authTagLength: tagLength });
	if (aad) d.setAAD(aad);
	d.setAuthTag(tag);
	return Buffer.concat([d.update(body), d.final()]);
};

// RFC 7253 appendix A: K = 000102...0F, 128-bit tags.
const rfcKey = Buffer.from("000102030405060708090A0B0C0D0E0F", "hex");
const rfcNonce = (n) => Buffer.from(`BBAA998877665544332211${n}`, "hex");
const rfcVector = (n, a, p, expected) => {
	const aad = Buffer.from(a, "hex");
	const plain = Buffer.from(p, "hex");
	const sealed = ocbSeal(128, rfcKey, rfcNonce(n), 16, aad, plain);
	const all = hex(Buffer.concat([sealed.body, sealed.tag])).toUpperCase();
	const back = ocbOpen(128, rfcKey, rfcNonce(n), 16, aad, sealed.body, sealed.tag);
	console.log("rfc7253", n, all, all === expected, hex(back) === p.toLowerCase());
};
rfcVector("00", "", "", "785407BFFFC8AD9EDCC5520AC9111EE6");
rfcVector("01", "0001020304050607", "0001020304050607", "6820B3657B6F615A5725BDA0D3B4EB3A257C9AF1F8F03009");
rfcVector("02", "0001020304050607", "", "81017F8203F081277152FADE694A0A00");
rfcVector("03", "", "0001020304050607", "45DD69F8F5AAE72414054CD1F35D82760B2CD00D2F99BFA9");
rfcVector(
	"04",
	"000102030405060708090A0B0C0D0E0F",
	"000102030405060708090A0B0C0D0E0F",
	"571D535B60B277188BE5147170A9A22C3AD7A4FF3835B8C5701C1CCEC8FC3358"
);
rfcVector("05", "000102030405060708090A0B0C0D0E0F", "", "8CF761B6902EF764462AD86498CA6B97");
rfcVector(
	"06",
	"",
	"000102030405060708090A0B0C0D0E0F",
	"5CE88EC2E0692706A915C00AEB8B2396F40E1C743F52436BDF06D8FA1ECA343D"
);
// The 96-bit tag vector of the RFC (key 0F0E...00, nonce BBAA9988776655443322110D, 40 bytes of associated data and text).
{
	const key = Buffer.from("0F0E0D0C0B0A09080706050403020100", "hex");
	const nonce = Buffer.from("BBAA9988776655443322110D", "hex");
	const data = Buffer.from(Array.from({ length: 40 }, (_, i) => i));
	const sealed = ocbSeal(128, key, nonce, 12, data, data);
	console.log("rfc7253 96", hex(Buffer.concat([sealed.body, sealed.tag])).toUpperCase());
	console.log("rfc7253 96 open", hex(ocbOpen(128, key, nonce, 12, data, sealed.body, sealed.tag)) === hex(data));
}

// Every key size, tag length and nonce length, over a spread of message and header lengths.
{
	const digest = crypto.createHash("sha256");
	let cases = 0;
	for (const bits of [128, 192, 256]) {
		const key = Buffer.alloc(bits / 8, bits);
		for (let tagLength = 1; tagLength <= 16; tagLength++) {
			for (let nonceLength = 1; nonceLength <= 15; nonceLength += tagLength % 3 === 0 ? 1 : 7) {
				const nonce = Buffer.alloc(nonceLength, nonceLength + 3);
				for (const plainLength of [0, 1, 15, 16, 17, 31, 32, 33, 47, 64, 65, 100]) {
					for (const aadLength of [0, 1, 16, 21, 33]) {
						const plain = Buffer.alloc(plainLength, plainLength + 1);
						const aad = Buffer.alloc(aadLength, aadLength + 2);
						const sealed = ocbSeal(bits, key, nonce, tagLength, aad, plain);
						const back = ocbOpen(bits, key, nonce, tagLength, aad, sealed.body, sealed.tag);
						if (!back.equals(plain)) console.log("ROUNDTRIP MISMATCH", bits, tagLength, nonceLength, plainLength, aadLength);
						digest.update(sealed.body).update(sealed.tag);
						cases++;
					}
				}
			}
		}
	}
	console.log("matrix", cases, digest.digest("hex"));
}

// Streaming: output is whole blocks, the rest comes with final().
{
	const key = Buffer.alloc(16, 7);
	const nonce = Buffer.alloc(12, 3);
	const split = (total, cuts, aad, decrypt) => {
		const plain = Buffer.alloc(total, 9);
		const sealed = ocbSeal(16 * 8, key, nonce, 16, aad, plain);
		const source = decrypt ? sealed.body : plain;
		const c = decrypt ? crypto.createDecipheriv("aes-128-ocb", key, nonce, { authTagLength: 16 }) : crypto.createCipheriv("aes-128-ocb", key, nonce, { authTagLength: 16 });
		if (aad) c.setAAD(aad);
		if (decrypt) c.setAuthTag(sealed.tag);
		const parts = [];
		let at = 0;
		for (const cut of cuts) {
			parts.push(hex(c.update(source.subarray(at, at + cut))));
			at += cut;
		}
		parts.push(`F:${hex(c.final())}`);
		if (!decrypt) parts.push(`T:${hex(c.getAuthTag())}`);
		return parts.join(" ");
	};
	for (const [total, cuts] of [[20, [5, 5, 10]], [48, [10, 38]], [48, [16, 16, 16]], [0, []], [33, [33]], [33, [1, 1, 1, 30]], [65, [64, 1]]]) {
		line(`stream enc ${total} ${cuts}`, () => split(total, cuts, Buffer.from("hdr")));
		line(`stream dec ${total} ${cuts}`, () => split(total, cuts, Buffer.from("hdr"), true));
	}
	line("aad split and late", () => {
		const c = crypto.createCipheriv("aes-128-ocb", key, nonce, { authTagLength: 16 });
		c.setAAD(Buffer.from("x"));
		c.setAAD("yz");
		const first = c.update(Buffer.alloc(20));
		c.setAAD(Buffer.from("late"));
		return `${hex(first)} ${hex(c.final())} ${hex(c.getAuthTag())}`;
	});
	line("string encodings", () => {
		const c = crypto.createCipheriv("aes-256-ocb", Buffer.alloc(32, 2), Buffer.alloc(15, 4), { authTagLength: 12 });
		const out = c.update("hello world, this is ocb!", "utf8", "hex") + c.final("hex");
		const c2 = crypto.createCipheriv("aes-256-ocb", Buffer.alloc(32, 2), Buffer.alloc(15, 4), { authTagLength: 12 });
		const b64 = c2.update("00".repeat(20), "hex", "base64") + c2.final("base64");
		const d = crypto.createDecipheriv("aes-256-ocb", Buffer.alloc(32, 2), Buffer.alloc(15, 4), { authTagLength: 12 });
		d.setAuthTag(c.getAuthTag());
		const text = d.update(out, "hex", "utf8") + d.final("utf8");
		return `${out} ${hex(c.getAuthTag())} ${b64} ${text}`;
	});
	line("large", () => {
		const c = crypto.createCipheriv("aes-128-ocb", key, nonce, { authTagLength: 16 });
		const body = Buffer.concat([c.update(Buffer.alloc(300000, 5)), c.final()]);
		return `${sha(body)} ${hex(c.getAuthTag())}`;
	});
	line("keyobject and string key", () => {
		const a = crypto.createCipheriv("aes-128-ocb", crypto.createSecretKey(key), nonce, { authTagLength: 16 });
		const b = crypto.createCipheriv("aes-128-ocb", "abcdefghijklmnop", nonce, { authTagLength: 16 });
		return `${hex(Buffer.concat([a.update("x"), a.final()]))} ${hex(Buffer.concat([b.update("x"), b.final()]))}`;
	});
}

// Decryption failures and states.
{
	const key = Buffer.alloc(16, 7);
	const nonce = Buffer.alloc(12, 3);
	const sealed = ocbSeal(128, key, nonce, 16, Buffer.from("a"), Buffer.from("hello"));
	const dec = (tweak) => {
		const d = crypto.createDecipheriv("aes-128-ocb", key, nonce, { authTagLength: 16 });
		return tweak(d);
	};
	line("bad tag", () =>
		dec((d) => {
			const tag = Buffer.from(sealed.tag);
			tag[0] ^= 1;
			d.setAAD(Buffer.from("a"));
			d.setAuthTag(tag);
			d.update(sealed.body);
			return d.final();
		})
	);
	line("bad aad", () =>
		dec((d) => {
			d.setAAD(Buffer.from("b"));
			d.setAuthTag(sealed.tag);
			d.update(sealed.body);
			return d.final();
		})
	);
	line("bad body", () =>
		dec((d) => {
			const body = Buffer.from(sealed.body);
			body[1] ^= 4;
			d.setAAD(Buffer.from("a"));
			d.setAuthTag(sealed.tag);
			d.update(body);
			return d.final();
		})
	);
	line("no tag", () => dec((d) => (d.update(sealed.body), d.final())));
	line("final again after failure", () =>
		dec((d) => {
			d.setAuthTag(sealed.tag);
			try {
				d.final();
			} catch {}
			return d.final();
		})
	);
	line("update after failure", () =>
		dec((d) => {
			d.setAuthTag(sealed.tag);
			try {
				d.final();
			} catch {}
			return d.update(Buffer.alloc(3));
		})
	);
	line("setAuthTag twice", () => dec((d) => (d.setAuthTag(sealed.tag), d.setAuthTag(sealed.tag))));
	line("setAuthTag short", () => dec((d) => d.setAuthTag(sealed.tag.subarray(0, 8))));
	line("setAuthTag long", () => dec((d) => d.setAuthTag(Buffer.concat([sealed.tag, sealed.tag]))));
	line("setAuthTag number", () => dec((d) => d.setAuthTag(5)));
	line("setAuthTag after final", () =>
		dec((d) => {
			d.setAuthTag(sealed.tag);
			try {
				d.final();
			} catch {}
			d.setAuthTag(sealed.tag);
		})
	);
	line("unset tag with output", () => dec((d) => hex(d.update(sealed.body))));
	line("tag through Uint8Array", () =>
		dec((d) => {
			d.setAAD(Buffer.from("a"));
			d.setAuthTag(new Uint8Array(sealed.tag));
			return d.update(sealed.body, null, "utf8") + d.final("utf8");
		})
	);
	const enc = () => crypto.createCipheriv("aes-128-ocb", key, nonce, { authTagLength: 16 });
	line("getAuthTag early", () => {
		const c = enc();
		c.update("a");
		return c.getAuthTag();
	});
	line("getAuthTag after final", () => {
		const c = enc();
		c.final();
		return hex(c.getAuthTag()) + hex(c.getAuthTag());
	});
	line("final twice", () => {
		const c = enc();
		c.final();
		c.final();
	});
	line("update after final", () => {
		const c = enc();
		c.final();
		c.update("a");
	});
	line("setAAD after final", () => {
		const c = enc();
		c.final();
		c.setAAD(Buffer.from("a"));
	});
	line("setAAD undefined", () => enc().setAAD());
	line("setAAD number", () => enc().setAAD(5));
	line("update number", () => enc().update(5));
	line("update null", () => enc().update(null));
	line("update object", () => enc().update({}));
	line("methods per side", () => {
		const c = enc();
		const d = crypto.createDecipheriv("aes-128-ocb", key, nonce, { authTagLength: 16 });
		return [typeof c.getAuthTag, typeof c.setAuthTag, typeof d.getAuthTag, typeof d.setAuthTag, c.constructor.name, d.constructor.name].join();
	});
	line("setAutoPadding", () => enc().setAutoPadding(false) instanceof crypto.Cipheriv);
}

// Options and parameter errors.
{
	const key = Buffer.alloc(16, 7);
	const iv = Buffer.alloc(12, 3);
	const make = (options, ivBytes = iv, keyBytes = key, name = "aes-128-ocb") => () => crypto.createCipheriv(name, keyBytes, ivBytes, options).constructor.name;
	line("no authTagLength", make(undefined));
	line("authTagLength undefined", make({ authTagLength: undefined }));
	line("authTagLength null", make({ authTagLength: null }));
	line("authTagLength 17", make({ authTagLength: 17 }));
	line("authTagLength -1", make({ authTagLength: -1 }));
	line("authTagLength 8.5", make({ authTagLength: 8.5 }));
	line("authTagLength string", make({ authTagLength: "16" }));
	line("authTagLength true", make({ authTagLength: true }));
	line("authTagLength huge", make({ authTagLength: 2 ** 40 }));
	line("authTagLength 16.0", make({ authTagLength: 16.0 }));
	line("authTagLength 1", make({ authTagLength: 1 }));
	line("authTagLength 0 update", () => {
		const c = crypto.createCipheriv("aes-128-ocb", key, iv, { authTagLength: 0 });
		c.update("hello");
	});
	line("iv empty", make({ authTagLength: 16 }, Buffer.alloc(0)));
	line("iv null", make({ authTagLength: 16 }, null));
	line("iv 15", make({ authTagLength: 16 }, Buffer.alloc(15)));
	line("iv 16", make({ authTagLength: 16 }, Buffer.alloc(16)));
	line("iv 1", make({ authTagLength: 16 }, Buffer.alloc(1)));
	line("key short", make({ authTagLength: 16 }, iv, Buffer.alloc(15)));
	line("key for 256", make({ authTagLength: 16 }, iv, key, "aes-256-ocb"));
	line("upper case name", make({ authTagLength: 16 }, iv, key, "AES-128-OCB"));
	line("decipher no authTagLength", () => crypto.createDecipheriv("aes-128-ocb", key, iv).constructor.name);
	line("ciphers", () => crypto.getCiphers().filter((n) => n.includes("ocb")).join());
	for (const name of ["aes-128-ocb", "aes-192-ocb", "aes-256-ocb", "AES-128-OCB"]) line(`info ${name}`, () => sorted(crypto.getCipherInfo(name)));
	line("info nid", () => sorted(crypto.getCipherInfo(958)));
	for (const ivLength of [0, 1, 12, 15, 16]) line(`info ivLength ${ivLength}`, () => sorted(crypto.getCipherInfo("aes-128-ocb", { ivLength })));
	line("info keyLength", () => sorted(crypto.getCipherInfo("aes-128-ocb", { keyLength: 32 })));
}

};

/* ----------------------------------------------------------------------------------- sponge digests */

const abc = Buffer.from("abc");
const digestCase = (name, params, data = abc) => aline(name, () => subtle.digest(params, data));

const spongeDigests = async () => {
	// NIST and RFC vectors.
	await digestCase("cSHAKE128 nist", { name: "cSHAKE128", outputLength: 256, customization: Buffer.from("Email Signature") }, Buffer.from("00010203", "hex"));
	await digestCase("cSHAKE128 plain is SHAKE128", { name: "cSHAKE128", outputLength: 256 });
	line("shake128 for comparison", () => crypto.createHash("shake128", { outputLength: 32 }).update(abc).digest("hex"));
	await digestCase("TurboSHAKE128 empty", { name: "TurboSHAKE128", outputLength: 256 }, Buffer.alloc(0));
	await digestCase("KT128 empty", { name: "KT128", outputLength: 256 }, Buffer.alloc(0));
	for (const name of ["cSHAKE128", "cSHAKE256", "TurboSHAKE128", "TurboSHAKE256", "KT128", "KT256"]) {
		for (const outputLength of [8, 64, 256, 512, 2000]) {
			await aline(`${name} ${outputLength}`, async () => sha(await subtle.digest({ name, outputLength }, abc)));
		}
		for (const size of [0, 1, 167, 168, 135, 136, 8191, 8192, 8193, 20000]) {
			await aline(`${name} input ${size}`, async () => sha(await subtle.digest({ name, outputLength: 384 }, Buffer.alloc(size, size % 251))));
		}
		if (name.startsWith("cSHAKE") || name.startsWith("KT")) {
			for (const size of [0, 1, 2, 300]) {
				await aline(`${name} customization ${size}`, async () => sha(await subtle.digest({ name, outputLength: 256, customization: Buffer.alloc(size, 7) }, Buffer.alloc(9000, 1))));
			}
			await aline(`${name} customization buffer`, () => subtle.digest({ name, outputLength: 256, customization: new Uint8Array([1, 2, 3]).buffer }, abc));
			await aline(`${name} customization empty`, () => subtle.digest({ name, outputLength: 256, customization: new Uint8Array(0) }, abc));
		}
		await aline(`${name} lowercase`, () => subtle.digest({ name: name.toLowerCase(), outputLength: 64 }, abc));
		await aline(`${name} missing length`, () => subtle.digest({ name }, abc));
		await aline(`${name} string algorithm`, () => subtle.digest(name, abc));
		await aline(`${name} negative length`, () => subtle.digest({ name, outputLength: -8 }, abc));
		await aline(`${name} big length`, () => subtle.digest({ name, outputLength: 2 ** 32 }, abc));
		await aline(`${name} NaN length`, () => subtle.digest({ name, outputLength: NaN }, abc));
		await aline(`${name} string length`, () => subtle.digest({ name, outputLength: "64" }, abc));
		await aline(`${name} fractional length`, () => subtle.digest({ name, outputLength: 64.9 }, abc));
		await aline(`${name} data string`, () => subtle.digest({ name, outputLength: 64 }, "abc"));
		await aline(`${name} customization string`, () => subtle.digest({ name, outputLength: 64, customization: "x" }, abc));
		await aline(`${name} customization null`, () => subtle.digest({ name, outputLength: 64, customization: null }, abc));
		await aline(`${name} length 0`, () => subtle.digest({ name, outputLength: 0 }, abc));
		await aline(`${name} length 7`, () => subtle.digest({ name, outputLength: 7 }, abc));
		await aline(`${name} length 9`, () => subtle.digest({ name, outputLength: 9 }, abc));
	}
	for (const domainSeparation of [1, 0x1f, 0x7f, 0x80, 0, 255, 256, -1, "a", "5", 1.5, null, undefined, NaN, true]) {
		await aline(`TurboSHAKE256 ds ${String(domainSeparation)}`, () => subtle.digest({ name: "TurboSHAKE256", outputLength: 256, domainSeparation }, abc));
	}
	await aline("cSHAKE functionName empty", () => subtle.digest({ name: "cSHAKE128", outputLength: 256, functionName: Buffer.alloc(0) }, abc));
	await aline("cSHAKE functionName set", () => subtle.digest({ name: "cSHAKE128", outputLength: 256, functionName: Buffer.from("x") }, abc));
	await aline("cSHAKE functionName string", () => subtle.digest({ name: "cSHAKE128", outputLength: 256, functionName: "x" }, abc));
	await aline("cSHAKE functionName null", () => subtle.digest({ name: "cSHAKE128", outputLength: 256, functionName: null }, abc));
	await aline("digest unknown", () => subtle.digest({ name: "ParallelHash128", outputLength: 256 }, abc));
	await aline("digest KMAC", () => subtle.digest({ name: "KMAC128", outputLength: 256 }, abc));
	await aline("digest SHAKE128", () => subtle.digest({ name: "SHAKE128", outputLength: 256 }, abc));
	await aline("digest no data", () => subtle.digest({ name: "KT128", outputLength: 256 }));
	await aline("import TurboSHAKE", () => subtle.importKey("raw", abc, { name: "TurboSHAKE128" }, false, ["sign"]));
	await aline("import cSHAKE", () => subtle.importKey("raw", abc, { name: "cSHAKE128" }, false, ["sign"]));
	await aline("import KT", () => subtle.importKey("raw", abc, { name: "KT128" }, false, ["sign"]));
};

/* ------------------------------------------------------------------------------------------- KMAC */

const jwk = (name, bytes) => ({ kty: "oct", k: Buffer.from(bytes).toString("base64url"), alg: name === "KMAC128" ? "K128" : "K256" });
const kmacKey = (name, bytes = Buffer.alloc(32, 1), usages = ["sign", "verify"], extractable = true, jwkExtra = {}) =>
	subtle.importKey("jwk", { ...jwk(name, bytes), ...jwkExtra }, { name }, extractable, usages);

const kmacTests = async () => {
	// NIST SP 800-185 KMAC samples.
	const nistKey = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x40 + i));
	const nistData = Buffer.from("00010203", "hex");
	const k128 = await kmacKey("KMAC128", nistKey);
	await aline("KMAC128 nist 1", () => subtle.sign({ name: "KMAC128", outputLength: 256 }, k128, nistData));
	await aline("KMAC128 nist 2", () => subtle.sign({ name: "KMAC128", outputLength: 256, customization: Buffer.from("My Tagged Application") }, k128, nistData));
	const k256 = await kmacKey("KMAC256", nistKey);
	await aline("KMAC256 nist 4", () => subtle.sign({ name: "KMAC256", outputLength: 512, customization: Buffer.from("My Tagged Application") }, k256, nistData));
	await aline("KMAC128 nist 3", async () => {
		const data = Buffer.from(Array.from({ length: 200 }, (_, i) => i));
		return subtle.sign({ name: "KMAC128", outputLength: 256, customization: Buffer.from("My Tagged Application") }, k128, data);
	});
	for (const name of ["KMAC128", "KMAC256"]) {
		const key = await kmacKey(name);
		await aline(`${name} key`, () => `${key.type} ${key.extractable} ${JSON.stringify(key.algorithm)} ${key.usages} ${Object.prototype.toString.call(key)}`);
		const sign = (params, k = key, data = abc) => () => subtle.sign({ name, ...params }, k, data);
		for (const outputLength of [0, 1, 7, 8, 9, 128, 256, 512, 1024, 3000]) await aline(`${name} sign ${outputLength}`, async () => sha(await subtle.sign({ name, outputLength }, key, abc)));
		for (const size of [0, 1, 3, 500]) {
			await aline(`${name} sign key ${size}`, async () => {
				const k = await kmacKey(name, Buffer.alloc(size, 5));
				return sha(await subtle.sign({ name, outputLength: 256, customization: Buffer.alloc(size, 1) }, k, Buffer.alloc(size * 3, 2)));
			});
		}
		await aline(`${name} sign short lengths`, async () => {
			const parts = [];
			for (let length = 1; length <= 17; length++) parts.push(hex(await subtle.sign({ name, outputLength: length }, key, abc)));
			return parts.join(" ");
		});
		await aline(`${name} sign missing length`, sign({}));
		await aline(`${name} sign string algorithm`, () => subtle.sign(name, key, abc));
		await aline(`${name} sign negative length`, sign({ outputLength: -8 }));
		await aline(`${name} sign NaN length`, sign({ outputLength: NaN }));
		await aline(`${name} sign big length`, sign({ outputLength: 2 ** 32 }));
		await aline(`${name} sign customization string`, sign({ outputLength: 8, customization: "x" }));
		await aline(`${name} sign data string`, sign({ outputLength: 8 }, key, "abc"));
		await aline(`${name} sign data number`, sign({ outputLength: 8 }, key, 5));
		await aline(`${name} sign empty data`, sign({ outputLength: 256 }, key, Buffer.alloc(0)));
		await aline(`${name} sign lowercase name`, () => subtle.sign({ name: name.toLowerCase(), outputLength: 256 }, key, abc));
		await aline(`${name} sign other name`, () => subtle.sign({ name: "HMAC" }, key, abc));
		await aline(`${name} sign other kmac`, () => subtle.sign({ name: name === "KMAC128" ? "KMAC256" : "KMAC128", outputLength: 256 }, key, abc));
		const hmacKey = await subtle.importKey("raw", Buffer.alloc(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		await aline(`${name} sign hmac key`, sign({ outputLength: 256 }, hmacKey));
		const signOnly = await kmacKey(name, Buffer.alloc(32, 1), ["sign"]);
		const verifyOnly = await kmacKey(name, Buffer.alloc(32, 1), ["verify"]);
		const signature = await subtle.sign({ name, outputLength: 256 }, key, abc);
		await aline(`${name} sign verify-only`, sign({ outputLength: 256 }, verifyOnly));
		await aline(`${name} verify`, () => subtle.verify({ name, outputLength: 256 }, key, signature, abc));
		await aline(`${name} verify verify-only`, () => subtle.verify({ name, outputLength: 256 }, verifyOnly, signature, abc));
		await aline(`${name} verify sign-only`, () => subtle.verify({ name, outputLength: 256 }, signOnly, signature, abc));
		await aline(`${name} verify wrong data`, () => subtle.verify({ name, outputLength: 256 }, key, signature, Buffer.from("abd")));
		await aline(`${name} verify short signature`, () => subtle.verify({ name, outputLength: 256 }, key, signature.slice(1), abc));
		await aline(`${name} verify other length`, () => subtle.verify({ name, outputLength: 512 }, key, signature, abc));
		await aline(`${name} verify customization`, () => subtle.verify({ name, outputLength: 256, customization: Buffer.from("c") }, key, signature, abc));
		await aline(`${name} verify missing length`, () => subtle.verify({ name }, key, signature, abc));
		await aline(`${name} verify signature string`, () => subtle.verify({ name, outputLength: 256 }, key, "x", abc));

		// Keys: JWK in and out, nothing else.
		await aline(`${name} export jwk`, async () => JSON.stringify(await subtle.exportKey("jwk", key)));
		await aline(`${name} export raw`, () => subtle.exportKey("raw", key));
		await aline(`${name} export spki`, () => subtle.exportKey("spki", key));
		await aline(`${name} export pkcs8`, () => subtle.exportKey("pkcs8", key));
		await aline(`${name} export bad format`, () => subtle.exportKey("foo", key));
		const locked = await kmacKey(name, Buffer.alloc(32, 1), ["sign"], false);
		await aline(`${name} export non-extractable`, () => subtle.exportKey("jwk", locked));
		await aline(`${name} export non-extractable raw`, () => subtle.exportKey("raw", locked));
		await aline(`${name} non-extractable`, () => `${locked.extractable} ${locked.usages}`);
		await aline(`${name} import raw`, () => subtle.importKey("raw", Buffer.alloc(32, 1), { name }, true, ["sign"]));
		await aline(`${name} import raw no usages`, () => subtle.importKey("raw", Buffer.alloc(32, 1), { name }, true, []));
		await aline(`${name} import spki`, () => subtle.importKey("spki", Buffer.alloc(3), { name }, true, ["sign"]));
		await aline(`${name} import pkcs8`, () => subtle.importKey("pkcs8", Buffer.alloc(3), { name }, true, ["sign"]));
		await aline(`${name} import bad format`, () => subtle.importKey("foo", Buffer.alloc(3), { name }, true, ["sign"]));
		await aline(`${name} import bad usage`, () => subtle.importKey("jwk", jwk(name, Buffer.alloc(3)), { name }, true, ["foo"]));
		await aline(`${name} import wrong usage`, () => subtle.importKey("jwk", jwk(name, Buffer.alloc(3)), { name }, true, ["encrypt"]));
		await aline(`${name} import no usages`, () => kmacKey(name, Buffer.alloc(3), []));
		await aline(`${name} import no usages bad kty`, () => subtle.importKey("jwk", { kty: "RSA" }, { name }, true, []));
		await aline(`${name} import bad kty`, () => kmacKey(name, Buffer.alloc(3), ["sign"], true, { kty: "RSA" }));
		await aline(`${name} import no k`, () => subtle.importKey("jwk", { kty: "oct" }, { name }, true, ["sign"]));
		await aline(`${name} import buffer as jwk`, () => subtle.importKey("jwk", Buffer.alloc(3), { name }, true, ["sign"]));
		await aline(`${name} import wrong alg`, () => kmacKey(name, Buffer.alloc(3), ["sign"], true, { alg: name === "KMAC128" ? "K256" : "K128" }));
		await aline(`${name} import lowercase alg`, () => kmacKey(name, Buffer.alloc(3), ["sign"], true, { alg: name === "KMAC128" ? "k128" : "k256" }));
		await aline(`${name} import no alg`, async () => {
			const { alg, ...rest } = jwk(name, Buffer.alloc(3));
			return JSON.stringify((await subtle.importKey("jwk", rest, { name }, true, ["sign"])).algorithm);
		});
		await aline(`${name} import ext mismatch`, () => kmacKey(name, Buffer.alloc(3), ["sign"], true, { ext: false }));
		await aline(`${name} import ext false`, async () => (await kmacKey(name, Buffer.alloc(3), ["sign"], false, { ext: false })).extractable);
		await aline(`${name} import key_ops mismatch`, () => kmacKey(name, Buffer.alloc(3), ["sign"], true, { key_ops: ["verify"] }));
		await aline(`${name} import key_ops both`, async () => (await kmacKey(name, Buffer.alloc(3), ["sign"], true, { key_ops: ["sign", "verify"] })).usages);
		await aline(`${name} import use`, async () => (await kmacKey(name, Buffer.alloc(3), ["sign"], true, { use: "sig" })).usages);
		await aline(`${name} import usages dedupe`, async () => (await kmacKey(name, Buffer.alloc(3), ["verify", "sign", "sign"])).usages);
		for (const size of [0, 1, 16, 100]) await aline(`${name} import length ${size}`, async () => JSON.stringify((await kmacKey(name, Buffer.alloc(size, 4))).algorithm));

		await aline(`${name} generate`, async () => {
			const k = await subtle.generateKey({ name }, true, ["sign", "verify"]);
			const exported = await subtle.exportKey("jwk", k);
			return `${JSON.stringify(k.algorithm)} ${k.usages} ${Buffer.from(exported.k, "base64url").length} ${exported.alg}`;
		});
		for (const length of [0, 8, 12, 64, 128, "64", 2000]) {
			await aline(`${name} generate length ${length}`, async () => {
				const k = await subtle.generateKey({ name, length }, true, ["sign"]);
				return `${JSON.stringify(k.algorithm)} ${Buffer.from((await subtle.exportKey("jwk", k)).k, "base64url").length}`;
			});
		}
		await aline(`${name} generate negative`, () => subtle.generateKey({ name, length: -1 }, true, ["sign"]));
		await aline(`${name} generate huge`, () => subtle.generateKey({ name, length: 2 ** 40 }, true, ["sign"]));
		await aline(`${name} generate bad usage`, () => subtle.generateKey({ name }, true, ["encrypt"]));
		await aline(`${name} generate no usage`, () => subtle.generateKey({ name }, true, []));
		await aline(`${name} generate non-extractable`, async () => {
			const k = await subtle.generateKey({ name }, false, ["sign"]);
			return `${k.extractable} ${k.usages}`;
		});
		await aline(`${name} generated keys sign and verify`, async () => {
			const k = await subtle.generateKey({ name, length: 200 }, true, ["sign", "verify"]);
			const s = await subtle.sign({ name, outputLength: 128 }, k, abc);
			return subtle.verify({ name, outputLength: 128 }, k, s, abc);
		});

		// Derivation, wrapping, unwrapping.
		const base = await subtle.importKey("raw", Buffer.alloc(32, 3), "HKDF", false, ["deriveKey"]);
		const hkdf = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new Uint8Array() };
		await aline(`${name} derive default`, async () => {
			const k = await subtle.deriveKey(hkdf, base, { name }, true, ["sign"]);
			return `${JSON.stringify(k.algorithm)} ${Buffer.from((await subtle.exportKey("jwk", k)).k, "base64url").toString("hex")}`;
		});
		await aline(`${name} derive length 64`, async () => {
			const k = await subtle.deriveKey(hkdf, base, { name, length: 64 }, true, ["sign"]);
			return `${JSON.stringify(k.algorithm)} ${Buffer.from((await subtle.exportKey("jwk", k)).k, "base64url").toString("hex")}`;
		});
		await aline(`${name} derive length 12`, () => subtle.deriveKey(hkdf, base, { name, length: 12 }, true, ["sign"]));
		await aline(`${name} derive no usages`, () => subtle.deriveKey(hkdf, base, { name }, true, []));
		const wrapper = await subtle.importKey("raw", Buffer.alloc(16, 8), "AES-GCM", false, ["wrapKey", "unwrapKey"]);
		const gcm = { name: "AES-GCM", iv: Buffer.alloc(12, 2) };
		await aline(`${name} wrap jwk`, async () => {
			const small = await kmacKey(name, Buffer.alloc(16, 1), ["sign"]);
			const wrapped = await subtle.wrapKey("jwk", small, wrapper, gcm);
			const back = await subtle.unwrapKey("jwk", wrapped, wrapper, gcm, { name }, true, ["sign"]);
			return `${hex(wrapped)} ${JSON.stringify(back.algorithm)} ${hex(await subtle.sign({ name, outputLength: 64 }, back, abc))}`;
		});
		await aline(`${name} wrap raw`, () => subtle.wrapKey("raw", key, wrapper, gcm));
		await aline(`${name} unwrap raw`, async () => {
			const wrapped = await subtle.wrapKey("raw", await subtle.generateKey({ name: "AES-CBC", length: 128 }, true, ["encrypt"]), wrapper, gcm);
			return subtle.unwrapKey("raw", wrapped, wrapper, gcm, { name }, true, ["sign"]);
		});
		await aline(`${name} as wrapping key`, () => subtle.wrapKey("jwk", key, key, { name, outputLength: 8 }));
		await aline(`${name} encrypt`, () => subtle.encrypt({ name }, key, abc));
		await aline(`${name} deriveBits`, () => subtle.deriveBits({ name }, key, 8));
	}
};

(async () => {
	await new Promise((resolve) => {
		const c = crypto.createCipheriv("aes-128-ocb", Buffer.alloc(16, 7), Buffer.alloc(12, 3), { authTagLength: 16 });
		const parts = [];
		c.on("data", (d) => parts.push(hex(d)));
		c.on("end", () => {
			console.log("stream pipe", parts.join("|"), hex(c.getAuthTag()));
			resolve();
		});
		c.write(Buffer.alloc(20, 1));
		c.end(Buffer.alloc(20, 2));
	});
	await spongeDigests();
	await kmacTests();
	ocbTests();
})().catch((error) => {
	console.log("FAILED", error && error.stack);
	process.exitCode = 1;
});

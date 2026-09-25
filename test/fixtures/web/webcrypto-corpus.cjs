/* Differential corpus: Web Crypto (crypto.subtle) with keys made by Node.js. */
const nodeCrypto = require("crypto");
const { subtle } = globalThis.crypto;
const F = {
 "rsa": {
  "priv": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDutL0wNyMtZTZ6\nV9uX+gprdGk9ipSFhBveKsiIas7SSuAllFbZxkeJ5syhDj6FkQt7sWCRuHN6+DeB\nBzAwJPau1jzCuGdRAJLWQkib3sc+8EpmJ5fWuKN3L0PewNNBkM+bH/Fq667FcvIc\nZW8hEuKfoX/NSkEpZufTEtgZ/Uk2rA+PB1oe8TblA4MyFiwNYBb6lzFsuUQdfp43\n4r4FRhKPt6/2gNiMgmaKHLh06mAjh47WrWqOGCnEu9Ns1Av+g1ZW7SGig8JcHBk1\nOROzo9UtxqExzxhqm9fUvXFyE178wefBOA1dlklvkaDcqUQrrBvWR2QecTR3BL2m\npQTPfq6PAgMBAAECggEAA274xFdxW2x38CKQt2A9WMuqh9wVGXvg+r0azVDb+2Jg\nVFS3OxgDB2oZH2fuYPVzzipVp+2Ym6LeXti/n1xTarMM2gV/rEaZ1hh1+uf6wwj/\nHku2KhHV0sJh84j1K52YSYmYFgr1z0Pr/5nl6KU2Op2UElvdvBQNhEJidrKR+bCm\nHBmt30PSjHgrchxYPDZmazGAEGTUCjifJR0R7nVL53cYgmKLUjmiSFPwLnzRoHG7\n1o1F0iH+rtbNv5UHcQS/s5aUcn00et/k9tDid0x4/qn2qBhhpTqjfWlrR8f6JQx8\ngJ5MjL9qxGkJ7c+ot+MsjGPd8IAvmMRzXUNZk102QQKBgQD3uooSp5BVeUJznJb/\nGEJ5kUO1R9hBRHiKBG00T1C//RQsxCaUfK9UxZxkBaJyehwZT9Lx4N75ZzKL2Vwt\n3lY3+aPlPfVmFrScw647ldpkEuSixPlCUrlKQ4MTn4A8OFnqa6G5OsUb0CmAPR8l\n1DZ21hlZbCC419Xyec55JrnGGQKBgQD2rRQZOVzEX8p/k2GSMTtQ8GiwIhoapFct\nzO2mcbt4YsB8o5Uvk135suE7hAK8zFq54oYAn4OPAeKOn2MhpKaWIDJqFp6SkEGC\nllX+FhvrXW3D7l0mCmkOdXZJOCmbENFMseJpwiWtfQ+A4+fwHep7enRhIxKJ2L4l\nmF3r9pYe5wKBgQDxXujPGkLwdRDBMq6Q6KNEbbxp8hGMLlnAKGX61NkZ501z/L6W\naRIwZ8ZkUnUgU0fzhapEEFVQ7jL6vhMpgfvB2FPPtdnX2YGrSKIH3o+GeD4bNg6j\nh5SP/k3FneBFTKaXWL2fi9qnqd/12hfyNN3IVf0m+sq7L1l/Qx1hP9E8aQKBgHuV\npxYkGQgBffCApEecBr28VJa53x4t68d0fjP/kw7zWsCXLC0TxedN6W3p630vXNz4\nUm6JfF3vcdRGomG+nf9kzh08i+GeCFQmgZq09PPscQvSpjRiztOBoet5Cc84k8O6\n81ZNAJd0qonGpPM16b5HUXtBGQ6a2lj3h0aq2fdNAoGBAMfcNDXxhn/RM+uPq1ap\nm7lvLrencnWVyjacsRNXfVpfiXEH3U7sdz0A8Ifr85MW866diaHai/uvYo1ZJx26\nh5ghI6GTMHrtm5gSvp1sPA1vb+h9p4GiByl4MniCLYSbmx4++sJn3T54kFGO+WZZ\nEwp35VZbh1Z4Gmt5aeVOTxFR\n-----END PRIVATE KEY-----\n",
  "pub": "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7rS9MDcjLWU2elfbl/oK\na3RpPYqUhYQb3irIiGrO0krgJZRW2cZHiebMoQ4+hZELe7Fgkbhzevg3gQcwMCT2\nrtY8wrhnUQCS1kJIm97HPvBKZieX1rijdy9D3sDTQZDPmx/xauuuxXLyHGVvIRLi\nn6F/zUpBKWbn0xLYGf1JNqwPjwdaHvE25QODMhYsDWAW+pcxbLlEHX6eN+K+BUYS\nj7ev9oDYjIJmihy4dOpgI4eO1q1qjhgpxLvTbNQL/oNWVu0hooPCXBwZNTkTs6PV\nLcahMc8YapvX1L1xchNe/MHnwTgNXZZJb5Gg3KlEK6wb1kdkHnE0dwS9pqUEz36u\njwIDAQAB\n-----END PUBLIC KEY-----\n",
  "pkcs1": "d4f2b143860a3d62f2f429ef9ee997a85a0864c038ab1029fa495bcf9ff992fe39d0bf98eab0b50baff73decd81f7ee301b6f56ea8bfec8d30ab0f9825fa7844335e39c63064f6866fce591d82c7bb362e823497d9a5341ed549ade6d4ace847eb72cf9bd8a0836de059e9324e38dae7f21a7e6783a73f344571c49f3d7e1c5a94da040ef6b261740d45b020c78ffa37c11a740b1796fac080e211ed1efa3adea063913c0193a883961926478ac5eb5c00235d22bfcbad0fd026ae8b3723cfc38a65c264b684e3064b1544d7c0077e75228f8ac3d28a296714783f7dc05fd3b221fbe7f26e649f72532832d914bc5472d3491c0a46a85da9ec8f15cdc9c57056",
  "pss": "hWbJsS975yaTi63sKLiR/JwXbbiDpqLYHhN7IP0npL+WxZMzBiKS2raAJHzjLFcognHILvn5ppE5NJqqtxy8iDAolOgTi5io+HTzOwV+lfXF1Hzn4zow93Vs0unek4qKO3OjxqY6TJCnkCDFfctGoddA4Omhuz+kXL592PY5u+JNSC7mzZYWkCBtsfSbSJH6DUXyKcicfCAGtheDydjsNwH6KfKzUlMK/SaonTFRQrreHc8l0/yz/6PsLWCFMzuVlKxt0WRW91ZOFERC+Ja27j3vn6gUNQSr02T+bC5/cNaJnxcLkCm7AuLWETIpeeH5mQkz45BaTDwwzaEFiOYXRQ==",
  "oaep": "suwUxOmsykCB1/2L8AJTNVBPGB68SbIocYpTtJ5+9RCVfkrni32ZpnMPO4wp57GKzH42vTmMr+CMMAZWrMf3O7GEzLPTWl+yHR1kjzkPkQBGObi9tG91UXSKMVMCfYYajIS+jWzqnANpRQw1GfwRfefbVnqt2mX4hwrrHYRCmGSJdsRCIyBFu55JLeGwVY8XVrH6vd8hu4r2uVDE1yUUScmP8LfLUqvpjvQ4aGSm1/wf5IwXMUAx1H+KjiNnxsn8yHK+nABMv++aksYiegIkbOleAfOEKeavmLx/QLyxSh/p1ui/7++CMwBfuzvk4oNnehumTAXxjZh9gl/wOT1Psw=="
 },
 "ec": {
  "priv": "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgHjPM0f6IPt6MhTfT\nsWojuD2UShnkhp3K5IkQJh4cnlKhRANCAAQucRL9emdqZA1DlNOKMpdr3jWXJyZ/\nsqLdoyoJzhPEyvxmu/YL9Hj5BMwLftTfBQNXij02y/F8R+sb66BvCo0a\n-----END PRIVATE KEY-----\n",
  "pub": "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAELnES/XpnamQNQ5TTijKXa941lycm\nf7Ki3aMqCc4TxMr8Zrv2C/R4+QTMC37U3wUDV4o9NsvxfEfrG+ugbwqNGg==\n-----END PUBLIC KEY-----\n",
  "sig": "5lHQBJgx9PW5d2iecsd7Bboco43DtNgg1PLBfZbWcnG/HQZj6SdttY6suiEor7Cbi1MSGsNzijzLqngDugLB2g=="
 },
 "ecdh": {
  "a": "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgmaHSCln/f6FLwgue\n+phCDMIdywoJb2nHK+GZH2T7zFGhRANCAATV2MAEYgNkEH50uC3bN5385WZMGTX2\nOWMsGJ4e8e0q+t8FUiQD5Ev0iXLDEeB7McE0MpeZq1GCbg4eFTkkKcJF\n-----END PRIVATE KEY-----\n",
  "b": "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETdJjGTl9jZX+IPY3mQ+5iQX3KFJ8\nWkeEGb666Sf5Kc9hbdC+EiPRPygMTrhSt5y0rXQ1LbH4qZicVehLOMqgjw==\n-----END PUBLIC KEY-----\n",
  "secret": "e46d28add34a56172aab6e7c139ae218ee923aa4914c1fd224b98d34252f041b"
 },
 "Ed25519": {
  "priv": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEILU2b28Dcp97wo+E7QncA8GBzXW4vGvS0LN5RpSEhtik\n-----END PRIVATE KEY-----\n",
  "pub": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi7CvGjNSDqta4gwCRa3ofJn28pHmkGNbvt1bZcnOXuA=\n-----END PUBLIC KEY-----\n",
  "sig": "54aa3fd5744d01874838a5a084c09c3a4a3c4db316652e2b46334ed7a85f77cb2069406b257dd7ea436dda71fb60b28a0c85118edf0d3d425a3ff7147f48a402"
 },
 "Ed448": {
  "priv": "-----BEGIN PRIVATE KEY-----\nMEcCAQAwBQYDK2VxBDsEOZRbaxr2exzI6zELgFWN66hjkLTy4/5ulj4L7GWujJnQ\nzKLOWxm7mCjU7pHSg2YDQ4hzgj9jahMGBQ==\n-----END PRIVATE KEY-----\n",
  "pub": "-----BEGIN PUBLIC KEY-----\nMEMwBQYDK2VxAzoAbO6+IRYN6wX1Cc7DWfbysl/lOBOaKOQSpq1PaijJ0VaYIODo\njUNRJS6cm0MKmCWJ5mIe0UseK3iA\n-----END PUBLIC KEY-----\n",
  "sig": "a6fdce6cf619e78666d2085aacff760b5e93d816d378ae4bcf9505f7ca183f78ab58ff4bac715523641716240ea4ca7f7505dfe1ff25d2bd0080e094fc1f7ebaaa3bca770c79bdd661e221d0391973a41ebf3a9f37ecce5c69fd5ad92c96e2da332c672f8ffc13bab737cb6fb5c2abfb1000"
 },
 "X25519": {
  "a": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEIAjHZnUvVyZIaUEYvfYNu69KsKLJbqHyQESZlHcURata\n-----END PRIVATE KEY-----\n",
  "b": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEA3cRfM3BvXeWn72JnwgLQXHvpE0wo1F63QwnKrcq+IHU=\n-----END PUBLIC KEY-----\n",
  "secret": "5e213c517f370aba105e4b36d8e75f5fd54f663a7649fb06a31be50723205232"
 },
 "X448": {
  "a": "-----BEGIN PRIVATE KEY-----\nMEYCAQAwBQYDK2VvBDoEOPxcM43AAzjFtUpwnDFSpReqdeP8L6xtkQV6xY1KVEXB\nQnjKvjwpiqkmr1dcEnzg6++YSrKDv6KG\n-----END PRIVATE KEY-----\n",
  "b": "-----BEGIN PUBLIC KEY-----\nMEIwBQYDK2VvAzkA3suzqvJO1AeLcp/Lvvx52EsjGM4xaXiMhK5IQgBbLKjwu9JA\nLRk2JTUST4SfEnqA+qpODRFCEq8=\n-----END PUBLIC KEY-----\n",
  "secret": "b982dd763b137379eadb9ba270fde90a3d0b36c4789b2a3b40d84ab96f8a914c155c2c979832dfcacc2f8536dc3331777a72d12299de3751"
 }
};

const hex = (b) => Buffer.from(b).toString("hex");
const line = (label, value) => console.log(label + ": " + (typeof value === "string" ? value : JSON.stringify(value, (k, v) => (v instanceof ArrayBuffer ? "ab:" + hex(v) : ArrayBuffer.isView(v) ? "view:" + hex(v) : v))));
const attempt = async (label, fn) => {
	try {
		const value = await fn();
		line(label, value === undefined ? "ok" : value);
	} catch (err) {
		line(label, ["throws", err.constructor.name, err.name, err.code, err.message]);
	}
};
const enc = (s) => new TextEncoder().encode(s);
const der = (pem) => new Uint8Array(Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64"));
const info = (key) => ({ type: key.type, extractable: key.extractable, algorithm: key.algorithm, usages: key.usages });
const MSG = enc("graak web crypto corpus");

(async () => {
	line("globals", [typeof CryptoKey, typeof SubtleCrypto, typeof Crypto, globalThis.crypto instanceof Crypto, subtle instanceof SubtleCrypto, Object.prototype.toString.call(globalThis.crypto)]);
	/* ---- digest */
	for (const name of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) line("digest " + name, hex(await subtle.digest(name, MSG)));
	line("digest object form", hex(await subtle.digest({ name: "sha-256" }, MSG)));
	await attempt("digest unknown", () => subtle.digest("MD5", MSG));
	await attempt("digest bad data", () => subtle.digest("SHA-256", "text"));

	/* ---- HMAC */
	const hmacKey = await subtle.importKey("raw", enc("secret key material"), { name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]);
	line("hmac key", info(hmacKey));
	const mac = await subtle.sign("HMAC", hmacKey, MSG);
	line("hmac sign", hex(mac));
	line("hmac verify", [await subtle.verify("HMAC", hmacKey, mac, MSG), await subtle.verify("HMAC", hmacKey, mac, enc("other"))]);
	line("hmac export raw", hex(await subtle.exportKey("raw", hmacKey)));
	line("hmac export jwk", await subtle.exportKey("jwk", hmacKey));
	const hmacFromJwk = await subtle.importKey("jwk", await subtle.exportKey("jwk", hmacKey), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
	line("hmac jwk import", [info(hmacFromJwk), hex(await subtle.sign("HMAC", hmacFromJwk, MSG)) === hex(mac)]);
	for (const hash of ["SHA-1", "SHA-384", "SHA-512"]) {
		const key = await subtle.importKey("raw", enc("k"), { name: "HMAC", hash }, false, ["sign"]);
		line("hmac " + hash, [key.algorithm, hex(await subtle.sign("HMAC", key, MSG))]);
	}
	const generatedHmac = await subtle.generateKey({ name: "HMAC", hash: "SHA-512", length: 200 }, true, ["sign", "verify"]);
	line("hmac generated", [generatedHmac.algorithm, generatedHmac.usages, (await subtle.exportKey("raw", generatedHmac)).byteLength]);
	await attempt("hmac not extractable", async () => subtle.exportKey("raw", await subtle.importKey("raw", enc("k"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])));
	await attempt("hmac bad usage", () => subtle.importKey("raw", enc("k"), { name: "HMAC", hash: "SHA-256" }, true, ["encrypt"]));
	await attempt("hmac no usage", () => subtle.importKey("raw", enc("k"), { name: "HMAC", hash: "SHA-256" }, true, []));
	await attempt("hmac sign wrong usage", async () => subtle.sign("HMAC", await subtle.importKey("raw", enc("k"), { name: "HMAC", hash: "SHA-256" }, true, ["verify"]), MSG));
	await attempt("hmac empty key", () => subtle.importKey("raw", new Uint8Array(0), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
	await attempt("hmac missing hash", () => subtle.importKey("raw", enc("k"), { name: "HMAC" }, true, ["sign"]));

	/* ---- AES */
	const aesRaw = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
	const iv16 = Buffer.from("0f0e0d0c0b0a09080706050403020100", "hex");
	const iv12 = iv16.subarray(0, 12);
	for (const [name, params] of [["AES-CBC", { iv: iv16 }], ["AES-CTR", { counter: iv16, length: 64 }], ["AES-GCM", { iv: iv12 }], ["AES-GCM", { iv: iv12, additionalData: enc("aad"), tagLength: 96 }]]) {
		const key = await subtle.importKey("raw", aesRaw, name, true, ["encrypt", "decrypt"]);
		const sealed = await subtle.encrypt({ name, ...params }, key, MSG);
		line(name + " " + JSON.stringify(Object.keys(params)), [key.algorithm, hex(sealed), hex(await subtle.decrypt({ name, ...params }, key, sealed)) === hex(MSG)]);
	}
	const gcmKey = await subtle.importKey("raw", aesRaw, "AES-GCM", true, ["encrypt", "decrypt"]);
	const gcmSealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: iv12 }, gcmKey, MSG));
	gcmSealed[gcmSealed.length - 1] ^= 1;
	await attempt("gcm bad tag", () => subtle.decrypt({ name: "AES-GCM", iv: iv12 }, gcmKey, gcmSealed));
	await attempt("gcm bad tag length", () => subtle.encrypt({ name: "AES-GCM", iv: iv12, tagLength: 100 }, gcmKey, MSG));
	await attempt("cbc bad iv", async () => subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(3) }, await subtle.importKey("raw", aesRaw, "AES-CBC", true, ["encrypt"]), MSG));
	await attempt("aes bad key length", () => subtle.importKey("raw", new Uint8Array(15), "AES-GCM", true, ["encrypt"]));
	await attempt("aes bad generate length", () => subtle.generateKey({ name: "AES-GCM", length: 100 }, true, ["encrypt"]));
	await attempt("aes bad usage", () => subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["sign"]));
	await attempt("aes algorithm mismatch", () => subtle.encrypt({ name: "AES-CBC", iv: iv16 }, gcmKey, MSG));
	const generatedAes = await subtle.generateKey({ name: "AES-CBC", length: 256 }, false, ["encrypt", "decrypt", "wrapKey"]);
	line("aes generated", info(generatedAes));
	line("aes jwk", await subtle.exportKey("jwk", gcmKey));
	for (const bits of [192, 256]) {
		const key = await subtle.importKey("raw", Buffer.alloc(bits / 8, 7), "AES-CTR", true, ["encrypt"]);
		line("aes ctr " + bits, hex(await subtle.encrypt({ name: "AES-CTR", counter: iv16, length: 128 }, key, MSG)));
	}
	// AES-KW
	const kek = await subtle.importKey("raw", Buffer.alloc(16, 1), "AES-KW", true, ["wrapKey", "unwrapKey"]);
	const target = await subtle.importKey("raw", Buffer.alloc(16, 9), { name: "AES-GCM" }, true, ["encrypt"]);
	const wrapped = await subtle.wrapKey("raw", target, kek, "AES-KW");
	line("aes-kw wrap", hex(wrapped));
	const unwrapped = await subtle.unwrapKey("raw", wrapped, kek, "AES-KW", "AES-GCM", true, ["decrypt"]);
	line("aes-kw unwrap", [info(unwrapped), hex(await subtle.exportKey("raw", unwrapped))]);
	const gcmWrapKey = await subtle.importKey("raw", aesRaw, "AES-GCM", true, ["wrapKey", "unwrapKey"]);
	const wrappedJwk = await subtle.wrapKey("jwk", target, gcmWrapKey, { name: "AES-GCM", iv: iv12 });
	const back = await subtle.unwrapKey("jwk", wrappedJwk, gcmWrapKey, { name: "AES-GCM", iv: iv12 }, "AES-GCM", true, ["encrypt"]);
	line("jwk wrap roundtrip", [wrappedJwk.byteLength > 30, hex(await subtle.exportKey("raw", back))]);
	await attempt("aes-kw bad length", async () => subtle.wrapKey("raw", await subtle.importKey("raw", Buffer.alloc(10), { name: "HMAC", hash: "SHA-1" }, true, ["sign"]), kek, "AES-KW"));

	/* ---- derivation */
	const pbkdf2Key = await subtle.importKey("raw", enc("password"), "PBKDF2", false, ["deriveBits", "deriveKey"]);
	line("pbkdf2 key", info(pbkdf2Key));
	line("pbkdf2 bits", hex(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc("salt"), iterations: 1000 }, pbkdf2Key, 256)));
	const derivedAes = await subtle.deriveKey({ name: "PBKDF2", hash: "SHA-1", salt: enc("salt"), iterations: 10 }, pbkdf2Key, { name: "AES-GCM", length: 128 }, true, ["encrypt"]);
	line("pbkdf2 deriveKey", [info(derivedAes), hex(await subtle.exportKey("raw", derivedAes))]);
	const derivedHmac = await subtle.deriveKey({ name: "PBKDF2", hash: "SHA-512", salt: enc("salt"), iterations: 5 }, pbkdf2Key, { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
	line("pbkdf2 hmac", [derivedHmac.algorithm, (await subtle.exportKey("raw", derivedHmac)).byteLength]);
	const hkdfKey = await subtle.importKey("raw", enc("input keying material"), "HKDF", false, ["deriveBits"]);
	line("hkdf bits", hex(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc("salt"), info: enc("info") }, hkdfKey, 336)));
	await attempt("pbkdf2 extractable", () => subtle.importKey("raw", enc("p"), "PBKDF2", true, ["deriveBits"]));
	await attempt("pbkdf2 no length", () => subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc("s"), iterations: 1 }, pbkdf2Key, null));
	await attempt("pbkdf2 wrong usage", async () => subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc("s"), iterations: 1 }, await subtle.importKey("raw", enc("p"), "PBKDF2", false, ["deriveKey"]), 128));

	/* ---- RSA */
	const rsaPriv = der(F.rsa.priv);
	const rsaPub = der(F.rsa.pub);
	for (const [name, hash, usagePub, usagePriv] of [["RSASSA-PKCS1-v1_5", "SHA-256", ["verify"], ["sign"]], ["RSA-PSS", "SHA-384", ["verify"], ["sign"]], ["RSA-OAEP", "SHA-256", ["encrypt"], ["decrypt"]]]) {
		const pub = await subtle.importKey("spki", rsaPub, { name, hash }, true, usagePub);
		const priv = await subtle.importKey("pkcs8", rsaPriv, { name, hash }, true, usagePriv);
		line(name + " imported", [info(pub), info(priv)]);
		line(name + " export", [hex(await subtle.exportKey("spki", pub)) === hex(rsaPub), hex(await subtle.exportKey("pkcs8", priv)) === hex(rsaPriv)]);
		const jwkPub = await subtle.exportKey("jwk", pub);
		const jwkPriv = await subtle.exportKey("jwk", priv);
		line(name + " jwk", [Object.keys(jwkPub), jwkPub.alg, jwkPub.key_ops, Object.keys(jwkPriv), jwkPriv.key_ops]);
		const again = await subtle.importKey("jwk", jwkPriv, { name, hash }, true, usagePriv);
		line(name + " jwk import", hex(await subtle.exportKey("pkcs8", again)) === hex(rsaPriv));
		if (name === "RSA-OAEP") {
			line(name + " decrypt node", Buffer.from(await subtle.decrypt({ name }, priv, Buffer.from(F.rsa.oaep, "base64"))).toString());
			const sealed = await subtle.encrypt({ name, label: enc("lbl") }, pub, MSG);
			line(name + " roundtrip", [sealed.byteLength, hex(await subtle.decrypt({ name, label: enc("lbl") }, priv, sealed)) === hex(MSG)]);
			await attempt(name + " wrong label", async () => subtle.decrypt({ name, label: enc("other") }, priv, sealed));
		} else if (name === "RSASSA-PKCS1-v1_5") {
			const signature = await subtle.sign(name, priv, MSG);
			line(name + " sign deterministic", [hex(signature) === F.rsa.pkcs1, await subtle.verify(name, pub, signature, MSG), await subtle.verify(name, pub, signature, enc("x"))]);
		} else {
			const signature = await subtle.sign({ name, saltLength: 20 }, priv, MSG);
			line(name + " sign", [signature.byteLength, await subtle.verify({ name, saltLength: 20 }, pub, signature, MSG), await subtle.verify({ name, saltLength: 30 }, pub, signature, MSG)]);
			line(name + " verify node", await subtle.verify({ name, saltLength: 32 }, pub, Buffer.from(F.rsa.pss, "base64"), MSG));
			await attempt(name + " no saltLength", () => subtle.sign(name, priv, MSG));
		}
	}
	const generatedRsa = await subtle.generateKey({ name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
	line("rsa generated", [generatedRsa.publicKey.algorithm, generatedRsa.publicKey.usages, generatedRsa.privateKey.usages, generatedRsa.publicKey.extractable, generatedRsa.privateKey.extractable, generatedRsa.publicKey.type, generatedRsa.privateKey.type]);
	await attempt("rsa bad usage", () => subtle.generateKey({ name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt"]));
	await attempt("rsa wrong key for algorithm", () => subtle.importKey("spki", der(F.ec.pub), { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"]));
	await attempt("rsa export raw", async () => subtle.exportKey("raw", generatedRsa.privateKey));
	await attempt("rsa jwk alg mismatch", async () => subtle.importKey("jwk", { ...(await subtle.exportKey("jwk", generatedRsa.publicKey)), alg: "PS512" }, { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"]));

	/* ---- EC */
	for (const curve of ["P-256", "P-384", "P-521"]) {
		const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign", "verify"]);
		const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, MSG);
		line("ecdsa " + curve, [pair.publicKey.algorithm, signature.byteLength, await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, signature, MSG), await subtle.verify({ name: "ECDSA", hash: "SHA-384" }, pair.publicKey, signature, MSG)]);
		const raw = await subtle.exportKey("raw", pair.publicKey);
		line("ecdsa raw " + curve, [raw.byteLength, new Uint8Array(raw)[0]]);
		const reimported = await subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: curve }, true, ["verify"]);
		line("ecdsa raw import " + curve, await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, reimported, signature, MSG));
		const jwk = await subtle.exportKey("jwk", pair.privateKey);
		line("ecdsa jwk " + curve, [Object.keys(jwk), jwk.crv, jwk.key_ops]);
	}
	const ecPub = await subtle.importKey("spki", der(F.ec.pub), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
	const ecPriv = await subtle.importKey("pkcs8", der(F.ec.priv), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
	line("ecdsa fixtures", [hex(await subtle.exportKey("spki", ecPub)) === hex(der(F.ec.pub)), hex(await subtle.exportKey("pkcs8", ecPriv)) === hex(der(F.ec.priv))]);
	line("ecdsa verify node", await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecPub, Buffer.from(F.ec.sig, "base64"), MSG));
	await attempt("ecdsa wrong curve", () => subtle.importKey("spki", der(F.ec.pub), { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]));
	await attempt("ecdsa bad curve name", () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-999" }, true, ["sign"]));
	await attempt("ecdsa missing hash", () => subtle.sign({ name: "ECDSA" }, ecPriv, MSG));
	const ecdhA = await subtle.importKey("pkcs8", der(F.ecdh.a), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
	const ecdhB = await subtle.importKey("spki", der(F.ecdh.b), { name: "ECDH", namedCurve: "P-256" }, true, []);
	line("ecdh bits", [hex(await subtle.deriveBits({ name: "ECDH", public: ecdhB }, ecdhA, 256)) === F.ecdh.secret, hex(await subtle.deriveBits({ name: "ECDH", public: ecdhB }, ecdhA, 128)) === F.ecdh.secret.slice(0, 32), (await subtle.deriveBits({ name: "ECDH", public: ecdhB }, ecdhA, null)).byteLength]);
	const ecdhKey = await subtle.deriveKey({ name: "ECDH", public: ecdhB }, ecdhA, { name: "AES-GCM", length: 256 }, true, ["encrypt"]);
	line("ecdh deriveKey", [ecdhKey.algorithm, hex(await subtle.exportKey("raw", ecdhKey)) === F.ecdh.secret]);
	await attempt("ecdh too long", () => subtle.deriveBits({ name: "ECDH", public: ecdhB }, ecdhA, 512));
	await attempt("ecdh wrong curve", async () => subtle.deriveBits({ name: "ECDH", public: await subtle.importKey("raw", Buffer.from(await subtle.exportKey("raw", (await subtle.generateKey({ name: "ECDH", namedCurve: "P-384" }, true, ["deriveBits"])).publicKey)), { name: "ECDH", namedCurve: "P-384" }, true, []) }, ecdhA, 128));
	line("ecdh public usages", [ecdhB.usages, ecdhA.usages]);

	/* ---- Ed25519, Ed448, X25519, X448 */
	for (const name of ["Ed25519", "Ed448"]) {
		const pub = await subtle.importKey("spki", der(F[name].pub), name, true, ["verify"]);
		const priv = await subtle.importKey("pkcs8", der(F[name].priv), name, true, ["sign"]);
		line(name + " imported", [info(pub), info(priv)]);
		const signature = await subtle.sign(name, priv, MSG);
		line(name + " sign", [hex(signature) === F[name].sig, await subtle.verify(name, pub, signature, MSG), await subtle.verify(name, pub, signature, enc("x"))]);
		const raw = await subtle.exportKey("raw", pub);
		line(name + " raw", [raw.byteLength, hex(raw)]);
		const fromRaw = await subtle.importKey("raw", raw, name, true, ["verify"]);
		line(name + " raw import", await subtle.verify(name, fromRaw, signature, MSG));
		line(name + " jwk", [await subtle.exportKey("jwk", pub), Object.keys(await subtle.exportKey("jwk", priv))]);
		const pair = await subtle.generateKey(name, true, ["sign", "verify"]);
		line(name + " generated", [pair.publicKey.algorithm, pair.privateKey.usages, await subtle.verify(name, pair.publicKey, await subtle.sign(name, pair.privateKey, MSG), MSG)]);
	}
	for (const name of ["X25519", "X448"]) {
		const a = await subtle.importKey("pkcs8", der(F[name].a), name, true, ["deriveBits"]);
		const b = await subtle.importKey("spki", der(F[name].b), name, true, []);
		line(name + " derive", [hex(await subtle.deriveBits({ name, public: b }, a, null)) === F[name].secret, (await subtle.deriveBits({ name, public: b }, a, 64)).byteLength]);
		const pair = await subtle.generateKey(name, true, ["deriveBits"]);
		line(name + " generated", [pair.publicKey.algorithm, pair.publicKey.usages, pair.privateKey.usages]);
		const raw = await subtle.exportKey("raw", pair.publicKey);
		line(name + " raw", raw.byteLength);
	}
	await attempt("ed25519 wrong usage", () => subtle.generateKey("Ed25519", true, ["deriveBits"]));

	/* ---- API details */
	await attempt("unknown algorithm", () => subtle.generateKey("nope", true, ["sign"]));
	await attempt("bad format", () => subtle.importKey("pem", new Uint8Array(1), "AES-GCM", true, ["encrypt"]));
	await attempt("bad key data", () => subtle.importKey("raw", "string", "AES-GCM", true, ["encrypt"]));
	await attempt("bad usages type", () => subtle.importKey("raw", new Uint8Array(16), "AES-GCM", true, "encrypt"));
	await attempt("crypto key constructor", () => new CryptoKey());
	await attempt("subtle constructor", () => new SubtleCrypto());
	await attempt("detached call", () => subtle.digest.call({}, "SHA-256", MSG));
	line("key prototype", [Object.prototype.toString.call(hmacKey), hmacKey instanceof CryptoKey, Object.keys(hmacKey), typeof hmacKey.usages]);
	line("usages copy", (() => { const u = hmacKey.usages; u.push("x"); return hmacKey.usages; })());
	line("getRandomValues", [globalThis.crypto.getRandomValues(new Uint8Array(4)).length, typeof globalThis.crypto.randomUUID(), nodeCrypto.webcrypto === globalThis.crypto, nodeCrypto.subtle === subtle]);
	await attempt("getRandomValues float", () => globalThis.crypto.getRandomValues(new Float32Array(2)));
	await attempt("getRandomValues detached", () => { const { getRandomValues } = globalThis.crypto; return getRandomValues(new Uint8Array(2)); });
})().catch((err) => {
	console.log("FAILED", err && err.stack);
	process.exit(1);
});

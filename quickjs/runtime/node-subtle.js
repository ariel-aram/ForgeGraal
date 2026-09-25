/*
 * Web Crypto on the native host: `crypto.subtle`, `CryptoKey`, `SubtleCrypto` and `Crypto`.
 *
 * Keys are the Node `KeyObject`s of node-crypto2.js wrapped in CryptoKey objects; the operations are the ones of
 * `crypto` (sign, verify, publicEncrypt, diffieHellman, ciphers, PBKDF2, HKDF). What is covered: digest (SHA-1, SHA-2,
 * SHA-3, cSHAKE, TurboSHAKE, KangarooTwelve), HMAC, KMAC, AES-CBC, AES-CTR, AES-GCM, AES-KW, RSASSA-PKCS1-v1_5, RSA-PSS, RSA-OAEP, ECDSA and ECDH (P-256, P-384,
 * P-521), Ed25519, Ed448, X25519, X448, PBKDF2 and HKDF, with generateKey, importKey and exportKey (raw, spki, pkcs8, jwk),
 * deriveBits, deriveKey, wrapKey and unwrapKey (Argon2 keys import as raw-secret), and ML-KEM-512/768/1024 (encapsulateBits, encapsulateKey,
 * decapsulateBits, decapsulateKey) and ML-DSA-44/65/87 (sign and verify with a context), keys in raw-public, raw-seed, spki, pkcs8 and jwk.
 * KMAC keys import from and export to JWK only, as in Node.js. Not covered: AES-OCB and ChaCha20-Poly1305. SLH-DSA is a `crypto` key type only,
 * as in Node, which has no Web Crypto SLH-DSA. Argon2 (Argon2d, Argon2i, Argon2id) is derive-only, version 0x13, as in Node.js.
 */

import { argon2Derive } from "./node-argon2.js";
import { cshake, kangarootwelve, kmac, truncateBits, turboshake } from "./node-keccak.js";

const USAGE_ORDER = ["encrypt", "decrypt", "sign", "verify", "deriveKey", "deriveBits", "wrapKey", "unwrapKey", "encapsulateKey", "encapsulateBits", "decapsulateKey", "decapsulateBits"];
const ML_KEM = ["ML-KEM-512", "ML-KEM-768", "ML-KEM-1024"];
const ML_DSA = ["ML-DSA-44", "ML-DSA-65", "ML-DSA-87"];
/* The arcs of each parameter set's OID (2.16.840.1.101.3.4.<a>.<b>), for the seed-only PKCS#8 Web Crypto exports. */
const PQC_ARCS = { "ML-KEM-512": [4, 1], "ML-KEM-768": [4, 2], "ML-KEM-1024": [4, 3], "ML-DSA-44": [3, 17], "ML-DSA-65": [3, 18], "ML-DSA-87": [3, 19] };
const HASHES = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512", "SHA3-256": "sha3-256", "SHA3-384": "sha3-384", "SHA3-512": "sha3-512" };
const CURVES = { "P-256": "prime256v1", "P-384": "secp384r1", "P-521": "secp521r1" };
const KEY_ALGORITHMS = [
	"RSASSA-PKCS1-v1_5", "RSA-PSS", "RSA-OAEP", "ECDSA", "ECDH", "Ed25519", "Ed448", "X25519", "X448", "HMAC", "AES-CTR", "AES-CBC", "AES-GCM", "AES-KW", "PBKDF2", "HKDF", "KMAC128", "KMAC256", "Argon2d", "Argon2i", "Argon2id",
	...ML_KEM, ...ML_DSA,
];
const ARGON2 = ["Argon2d", "Argon2i", "Argon2id"];
const XOF_DIGESTS = ["cSHAKE128", "cSHAKE256", "TurboSHAKE128", "TurboSHAKE256", "KT128", "KT256"];
const isKmac = (name) => name === "KMAC128" || name === "KMAC256";
const OPERATIONS = {
	digest: [...Object.keys(HASHES), ...XOF_DIGESTS],
	sign: ["RSASSA-PKCS1-v1_5", "RSA-PSS", "ECDSA", "Ed25519", "Ed448", "HMAC", "KMAC128", "KMAC256", ...ML_DSA],
	verify: ["RSASSA-PKCS1-v1_5", "RSA-PSS", "ECDSA", "Ed25519", "Ed448", "HMAC", "KMAC128", "KMAC256", ...ML_DSA],
	encrypt: ["RSA-OAEP", "AES-CTR", "AES-CBC", "AES-GCM"],
	decrypt: ["RSA-OAEP", "AES-CTR", "AES-CBC", "AES-GCM"],
	deriveBits: ["ECDH", "X25519", "X448", "HKDF", "PBKDF2", ...ARGON2],
	generateKey: KEY_ALGORITHMS.filter((n) => n !== "PBKDF2" && n !== "HKDF" && !ARGON2.includes(n)),
	importKey: KEY_ALGORITHMS,
	exportKey: KEY_ALGORITHMS,
	wrapKey: ["AES-KW", "RSA-OAEP", "AES-CTR", "AES-CBC", "AES-GCM"],
	unwrapKey: ["AES-KW", "RSA-OAEP", "AES-CTR", "AES-CBC", "AES-GCM"],
	encapsulateBits: ML_KEM,
	encapsulateKey: ML_KEM,
	decapsulateBits: ML_KEM,
	decapsulateKey: ML_KEM,
	getPublicKey: [...ML_KEM, ...ML_DSA, "RSASSA-PKCS1-v1_5", "RSA-PSS", "RSA-OAEP", "ECDSA", "ECDH", "Ed25519", "Ed448", "X25519", "X448"],
};
OPERATIONS.deriveKey = OPERATIONS.deriveBits;

export function createSubtle({ native, Buffer, toBytes, crypto, hashName }) {
	const DOMExceptionClass = globalThis.DOMException;
	const fail = (name, message) => {
		if (DOMExceptionClass) return new DOMExceptionClass(message, name);
		return Object.assign(new Error(message), { name });
	};
	const typeError = (message, code = "ERR_INVALID_ARG_TYPE") => Object.assign(new TypeError(message), { code });
	/* Node's message for a member a parameter dictionary requires and did not get. */
	const required = (a, dictionary, members) => {
		for (const member of members) {
			if (a[member] === undefined) {
				throw typeError(`Failed to normalize algorithm: passed algorithm cannot be converted to '${dictionary}' because '${member}' is required in '${dictionary}'.`, "ERR_MISSING_OPTION");
			}
		}
	};
	const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10]}`;
	const abOf = (bytes) => {
		const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
	};
	const bytesOf = (data, name = "data") => {
		if (data instanceof ArrayBuffer) return new Uint8Array(data);
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		// The public method wraps this into Node's "Failed to execute ..." text.
		throw Object.assign(typeError(`The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`), { bufferArgument: name });
	};
	const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

	/* ------------------------------------------------------------------------------- CryptoKey */

	const slot = new WeakMap();
	class CryptoKey {
		constructor() {
			throw typeError("Illegal constructor", "ERR_ILLEGAL_CONSTRUCTOR");
		}
		get type() {
			return slot.get(this).type;
		}
		get extractable() {
			return slot.get(this).extractable;
		}
		get algorithm() {
			return slot.get(this).algorithm;
		}
		get usages() {
			return slot.get(this).usages;
		}
		get [Symbol.toStringTag]() {
			return "CryptoKey";
		}
	}
	const makeKey = (keyObject, algorithm, extractable, usages, type) => {
		const key = Object.create(CryptoKey.prototype);
		slot.set(key, { keyObject, algorithm, extractable, usages: USAGE_ORDER.filter((u) => usages.includes(u)), type: type ?? keyObject.type });
		return key;
	};
	const internal = (key, what = "key") => {
		const found = key && typeof key === "object" ? slot.get(key) : undefined;
		if (!found) throw typeError(`The "${what}" argument must be an instance of CryptoKey.`);
		return found;
	};

	/* ------------------------------------------------------------------- algorithm normalisation */

	/* Argon2Params as Node reads the dictionary: members in lexicographic order, each converted as WebIDL does. */
	const argonParams = (a) => {
		const bytesMember = (name, mandatory) => {
			const value = a[name];
			if (value === undefined) {
				if (mandatory) required(a, "Argon2Params", [name]);
				return undefined;
			}
			if (value instanceof ArrayBuffer) return new Uint8Array(value);
			if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			throw typeError(`Failed to normalize algorithm: ${name} in passed algorithm is not instance of ArrayBuffer, Buffer, TypedArray, or DataView.`);
		};
		const numberMember = (name, mandatory, max) => {
			const value = a[name];
			if (value === undefined) {
				if (mandatory) required(a, "Argon2Params", [name]);
				return undefined;
			}
			const n = Number(value);
			if (!Number.isFinite(n)) throw typeError(`Failed to normalize algorithm: ${name} in passed algorithm is not a finite number.`);
			const whole = Math.trunc(n);
			if (whole < 0 || whole > max) throw Object.assign(new TypeError(`Failed to normalize algorithm: ${name} in passed algorithm is outside the expected range of 0 to ${max}.`), { code: "ERR_OUT_OF_RANGE" });
			return whole + 0;
		};
		const associatedData = bytesMember("associatedData", false);
		const memory = numberMember("memory", true, 4294967295);
		const nonce = bytesMember("nonce", true);
		const parallelism = numberMember("parallelism", true, 4294967295);
		const passes = numberMember("passes", true, 4294967295);
		const secretValue = bytesMember("secretValue", false);
		const version = numberMember("version", false, 255);
		return { ...a, associatedData, memory, nonce, parallelism, passes, secretValue, version };
	};
	const canonical = (name, operation) => {
		const upper = String(name).toUpperCase();
		const found = OPERATIONS[operation].find((n) => n.toUpperCase() === upper);
		if (!found) throw fail("NotSupportedError", "Unrecognized algorithm name");
		return found;
	};
	/* The parameter dictionaries of the sponge algorithms, converted member by member in lexicographic order as WebIDL does. */
	const DICTIONARIES = {
		cSHAKE128: ["CShakeParams", [["customization", "buffer"], ["functionName", "buffer"], ["outputLength", "ulong", true]]],
		cSHAKE256: ["CShakeParams", [["customization", "buffer"], ["functionName", "buffer"], ["outputLength", "ulong", true]]],
		TurboSHAKE128: ["TurboShakeParams", [["domainSeparation", "octet"], ["outputLength", "ulong", true]]],
		TurboSHAKE256: ["TurboShakeParams", [["domainSeparation", "octet"], ["outputLength", "ulong", true]]],
		KT128: ["KangarooTwelveParams", [["customization", "buffer"], ["outputLength", "ulong", true]]],
		KT256: ["KangarooTwelveParams", [["customization", "buffer"], ["outputLength", "ulong", true]]],
		KMAC128: ["KmacParams", [["customization", "buffer"], ["outputLength", "ulong", true]]],
		KMAC256: ["KmacParams", [["customization", "buffer"], ["outputLength", "ulong", true]]],
	};
	const convertMember = (a, member, kind) => {
		const value = a[member];
		if (kind === "buffer") {
			if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw typeError(`Failed to normalize algorithm: ${member} in passed algorithm is not instance of ArrayBuffer, Buffer, TypedArray, or DataView.`);
			return value;
		}
		const number = Number(value);
		if (!Number.isFinite(number)) throw typeError(`Failed to normalize algorithm: ${member} in passed algorithm is not a finite number.`);
		const max = kind === "octet" ? 255 : 4294967295;
		const whole = Math.trunc(number);
		if (whole < 0 || whole > max) throw typeError(`Failed to normalize algorithm: ${member} in passed algorithm is outside the expected range of 0 to ${max}.`, "ERR_OUT_OF_RANGE");
		return whole + 0;
	};
	const convertDictionary = (a, dictionary, members) => {
		const converted = { ...a };
		for (const [member, kind, mandatory] of members) {
			if (a[member] === undefined) {
				if (mandatory) required(a, dictionary, [member]);
				continue;
			}
			converted[member] = convertMember(a, member, kind);
		}
		return converted;
	};
	const withParameters = (a, operation) => {
		const dictionary = DICTIONARIES[a.name];
		if (dictionary && (operation === "digest" || operation === "sign" || operation === "verify")) return convertDictionary(a, dictionary[0], dictionary[1]);
		if (isKmac(a.name) && operation === "generateKey" && a.length !== undefined) return { ...a, length: convertMember(a, "length", "ulong") };
		return a;
	};
	const normalize = (algorithm, operation) => {
		const finish = (named) =>
			ARGON2.includes(named.name) && (operation === "deriveBits" || operation === "deriveKey") ? argonParams(named) : withParameters(named, operation);
		if (typeof algorithm === "string" || typeof algorithm === "number" || typeof algorithm === "boolean") return finish({ name: canonical(algorithm, operation) });
		if (algorithm === null || typeof algorithm !== "object") throw typeError('The "algorithm" argument must be of type string or an instance of Object.');
		if (algorithm.name === undefined) throw typeError("Failed to normalize algorithm: passed algorithm cannot be converted to 'Algorithm' because 'name' is required in 'Algorithm'.", "ERR_MISSING_OPTION");
		return finish({ ...algorithm, name: canonical(algorithm.name, operation) });
	};
	const hashOf = (hash) => {
		const given = typeof hash === "string" ? { name: hash } : hash;
		if (!given || given.name === undefined) throw typeError("Failed to normalize algorithm: passed algorithm cannot be converted to 'HashAlgorithmIdentifier'.", "ERR_MISSING_OPTION");
		const upper = String(given.name).toUpperCase();
		const found = Object.keys(HASHES).find((n) => n === upper);
		if (!found) throw fail("NotSupportedError", "Unrecognized algorithm name");
		return found;
	};
	const hashBits = (hash) => ({ "SHA-1": 160, "SHA-256": 256, "SHA-384": 384, "SHA-512": 512, "SHA3-256": 256, "SHA3-384": 384, "SHA3-512": 512 })[hash];
	const blockBits = (hash) => ({ "SHA-1": 512, "SHA-256": 512, "SHA-384": 1024, "SHA-512": 1024, "SHA3-256": 1088, "SHA3-384": 832, "SHA3-512": 576 })[hash];

	const checkUsages = (name, usages, allowed, extraForPrivate) => {
		if (!Array.isArray(usages)) throw typeError('The "keyUsages" argument must be an instance of Array.');
		for (const usage of usages) {
			if (!USAGE_ORDER.includes(usage)) throw typeError(`Invalid key usage: ${usage}`, "ERR_INVALID_ARG_VALUE");
			if (!allowed.includes(usage)) throw fail("SyntaxError", `Unsupported key usage for ${name} key`);
		}
		void extraForPrivate;
	};
	const secretUsages = {
		"AES-CTR": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
		"AES-CBC": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
		"AES-GCM": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
		"AES-KW": ["wrapKey", "unwrapKey"],
		HMAC: ["sign", "verify"],
		KMAC128: ["sign", "verify"],
		KMAC256: ["sign", "verify"],
		PBKDF2: ["deriveKey", "deriveBits"],
		HKDF: ["deriveKey", "deriveBits"],
		Argon2d: ["deriveKey", "deriveBits"],
		Argon2i: ["deriveKey", "deriveBits"],
		Argon2id: ["deriveKey", "deriveBits"],
	};
	const publicUsages = { "RSASSA-PKCS1-v1_5": ["verify"], "RSA-PSS": ["verify"], "RSA-OAEP": ["encrypt", "wrapKey"], ECDSA: ["verify"], ECDH: [], Ed25519: ["verify"], Ed448: ["verify"], X25519: [], X448: [] };
	const privateUsages = { "RSASSA-PKCS1-v1_5": ["sign"], "RSA-PSS": ["sign"], "RSA-OAEP": ["decrypt", "unwrapKey"], ECDSA: ["sign"], ECDH: ["deriveKey", "deriveBits"], Ed25519: ["sign"], Ed448: ["sign"], X25519: ["deriveKey", "deriveBits"], X448: ["deriveKey", "deriveBits"] };
	for (const name of ML_KEM) {
		publicUsages[name] = ["encapsulateKey", "encapsulateBits"];
		privateUsages[name] = ["decapsulateKey", "decapsulateBits"];
	}
	for (const name of ML_DSA) {
		publicUsages[name] = ["verify"];
		privateUsages[name] = ["sign"];
	}

	/* --------------------------------------------------------------------------- key material */

	const exponentOf = (bytes) => {
		let value = 0;
		for (const byte of bytesOf(bytes, "publicExponent")) value = value * 256 + byte;
		return value;
	};
	const rsaAlgorithm = (name, keyObject, hash) => {
		const details = keyObject.asymmetricKeyDetails;
		const exponent = new Uint8Array(Buffer.from(details.publicExponent.toString(16).padStart(details.publicExponent.toString(16).length + (details.publicExponent.toString(16).length % 2), "0"), "hex"));
		return { name, modulusLength: details.modulusLength, publicExponent: exponent, hash: { name: hash } };
	};
	const secretKey = (bytes, algorithm, extractable, usages) => makeKey(crypto.createSecretKey(bytes), algorithm, extractable, usages, "secret");

	const generateKey = (algorithm, extractable, usages) => {
		const a = normalize(algorithm, "generateKey");
		const name = a.name;
		if (name.startsWith("AES-")) {
			required(a, "AesKeyGenParams", ["length"]);
			if (![128, 192, 256].includes(a.length)) throw fail("OperationError", "AES key length must be 128, 192, or 256 bits");
			checkUsages(name, usages, secretUsages[name]);
			if (!usages.length) throw fail("SyntaxError", "Usages cannot be empty when creating a key.");
			return secretKey(native.randomBytes(a.length / 8), { name, length: a.length }, extractable, usages);
		}
		if (isKmac(name)) {
			checkUsages(name, usages, secretUsages[name]);
			if (!usages.length) throw fail("SyntaxError", "Usages cannot be empty when creating a key.");
			const length = a.length ?? (name === "KMAC128" ? 128 : 256);
			return secretKey(native.randomBytes((length + 7) >> 3), { name, length }, extractable, usages);
		}
		if (name === "HMAC") {
			required(a, "HmacKeyGenParams", ["hash"]);
			const hash = hashOf(a.hash);
			checkUsages(name, usages, secretUsages.HMAC);
			if (!usages.length) throw fail("SyntaxError", "Usages cannot be empty when creating a key.");
			const length = a.length ?? blockBits(hash);
			if (!Number.isInteger(length) || length <= 0) throw fail("OperationError", "Zero-length key is not supported");
			return secretKey(native.randomBytes((length + 7) >> 3), { name, length, hash: { name: hash } }, extractable, usages);
		}
		let pair;
		let algo;
		if (name.startsWith("RSA")) {
			required(a, "RsaHashedKeyGenParams", ["modulusLength", "publicExponent", "hash"]);
			const hash = hashOf(a.hash);
			pair = crypto.generateKeyPairSync("rsa", { modulusLength: a.modulusLength, publicExponent: exponentOf(a.publicExponent) });
			algo = rsaAlgorithm(name, pair.publicKey, hash);
		} else if (name === "ECDSA" || name === "ECDH") {
			required(a, "EcKeyGenParams", ["namedCurve"]);
			if (!CURVES[a.namedCurve]) throw fail("NotSupportedError", "Unrecognized namedCurve");
			pair = crypto.generateKeyPairSync("ec", { namedCurve: CURVES[a.namedCurve] });
			algo = { name, namedCurve: a.namedCurve };
		} else {
			pair = crypto.generateKeyPairSync(name.toLowerCase());
			algo = { name };
		}
		const allowedPrivate = privateUsages[name];
		const allowedPublic = publicUsages[name];
		for (const usage of usages) {
			if (!USAGE_ORDER.includes(usage)) throw typeError(`Invalid key usage: ${usage}`, "ERR_INVALID_ARG_VALUE");
			if (![...allowedPrivate, ...allowedPublic].includes(usage)) throw fail("SyntaxError", `Unsupported key usage for ${name} key`);
		}
		if (!usages.some((u) => allowedPrivate.includes(u))) throw fail("SyntaxError", "Usages cannot be empty when creating a key.");
		return {
			publicKey: makeKey(pair.publicKey, algo, true, usages.filter((u) => allowedPublic.includes(u)), "public"),
			privateKey: makeKey(pair.privateKey, algo, extractable, usages.filter((u) => allowedPrivate.includes(u)), "private"),
		};
	};

	const jwkAlgFor = (algorithm) => {
		const name = algorithm.name;
		const bits = algorithm.hash ? hashBits(algorithm.hash.name) : undefined;
		if (name === "HMAC") return `HS${bits}`;
		if (isKmac(name)) return name === "KMAC128" ? "K128" : "K256";
		if (name === "RSASSA-PKCS1-v1_5") return `RS${bits === 1 || bits === 160 ? "1" : bits}`;
		if (name === "RSA-PSS") return `PS${bits}`;
		if (name === "RSA-OAEP") return bits === 160 ? "RSA-OAEP" : `RSA-OAEP-${bits}`;
		if (name.startsWith("AES-")) return { "AES-CTR": "CTR", "AES-CBC": "CBC", "AES-GCM": "GCM", "AES-KW": "KW" }[name] ? `A${algorithm.length}${{ "AES-CTR": "CTR", "AES-CBC": "CBC", "AES-GCM": "GCM", "AES-KW": "KW" }[name]}` : undefined;
		if (name === "Ed25519" || name === "Ed448") return name === "Ed25519" ? "Ed25519" : "Ed448";
		return undefined;
	};
	const jwkCurve = (algorithm) => algorithm.namedCurve;

	const exportKey = (format, key) => {
		if (!["raw", "raw-secret", "raw-public", "raw-seed", "spki", "pkcs8", "jwk"].includes(format)) throw typeError(`Failed to execute 'exportKey' on 'SubtleCrypto': 1st argument '${format}' is not a valid enum value of type KeyFormat.`, "ERR_INVALID_ARG_VALUE");
		const k = internal(key, "key");
		if (ARGON2.includes(k.algorithm.name)) throw fail("NotSupportedError", `${k.algorithm.name} key export is not supported`);
		if (!k.extractable) throw fail("InvalidAccessError", "key is not extractable");
		const ko = k.keyObject;
		const name = k.algorithm.name;
		if (isKmac(name) && ["raw", "spki", "pkcs8"].includes(format)) throw fail("NotSupportedError", `Unable to export ${name} secret key using ${format} format`);
		if (PQC_ARCS[name]) {
			const unable = () => fail("NotSupportedError", `Unable to export ${name} ${ko.type} key using ${format} format`);
			if (format === "raw-public") return ko.type === "public" ? abOf(ko.export({ format: "raw-public" })) : (() => { throw unable(); })();
			if (format === "raw-seed") return ko.type === "private" ? abOf(ko.export({ format: "raw-seed" })) : (() => { throw unable(); })();
			if (format === "spki") return ko.type === "public" ? abOf(ko.export({ type: "spki", format: "der" })) : (() => { throw unable(); })();
			if (format === "pkcs8") {
				if (ko.type !== "private") throw unable();
				// Web Crypto exports the seed alone: PrivateKeyInfo with a [0] seed inside the private key octets.
				const seed = new Uint8Array(ko.export({ format: "raw-seed" }));
				const inner = Uint8Array.of(0x80, seed.length, ...seed);
				const algorithm = Uint8Array.of(0x30, 0x0b, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, ...PQC_ARCS[name]);
				const body = Uint8Array.of(2, 1, 0, ...algorithm, 4, inner.length, ...inner);
				return abOf(Uint8Array.of(0x30, body.length, ...body));
			}
			if (format !== "jwk") throw unable();
		}
		if (format === "raw" || (format === "raw-secret" && ko.type === "secret")) {
			if (ko.type === "secret") return abOf(ko.export());
			if (ko.type === "public" && (name === "ECDSA" || name === "ECDH")) {
				const jwk = ko.export({ format: "jwk" });
				const x = Buffer.from(jwk.x, "base64url");
				const y = Buffer.from(jwk.y, "base64url");
				return abOf(Buffer.concat([Buffer.from([4]), x, y]));
			}
			if (ko.type === "public" && ko.asymmetricKeyType && /^(ed|x)/.test(ko.asymmetricKeyType)) return abOf(Buffer.from(ko.export({ format: "jwk" }).x, "base64url"));
			throw fail("NotSupportedError", `Unable to export ${name} ${ko.type} key using raw format`);
		}
		if (format === "spki") {
			if (ko.type !== "public") throw fail("InvalidAccessError", `Unable to export ${name} ${ko.type} key using spki format`);
			return abOf(ko.export({ type: "spki", format: "der" }));
		}
		if (format === "pkcs8") {
			if (ko.type !== "private") throw fail("InvalidAccessError", `Unable to export ${name} ${ko.type} key using pkcs8 format`);
			return abOf(ko.export({ type: "pkcs8", format: "der" }));
		}
		if (format === "jwk") {
			const jwk = { key_ops: k.usages, ext: k.extractable };
			const alg = jwkAlgFor(k.algorithm);
			if (alg && ko.type !== "public" ? true : Boolean(alg) && ko.type === "public") jwk.alg = alg;
			const base = ko.type === "secret" ? { kty: "oct", k: b64u(ko.export()) } : ko.export({ format: "jwk" });
			if (name === "ECDSA" || name === "ECDH") base.crv = jwkCurve(k.algorithm);
			return { ...jwk, ...base };
		}
		throw typeError(`The argument 'format' is invalid. Received '${format}'`, "ERR_INVALID_ARG_VALUE");
	};

	const importKey = (format, keyData, algorithm, extractable, usages) => {
		const a = normalize(algorithm, "importKey");
		const name = a.name;
		if (!["raw", "raw-secret", "raw-public", "raw-seed", "spki", "pkcs8", "jwk"].includes(format)) throw typeError(`Failed to execute 'importKey' on 'SubtleCrypto': 1st argument '${format}' is not a valid enum value of type KeyFormat.`, "ERR_INVALID_ARG_VALUE");
		if (!Array.isArray(usages)) throw typeError("Failed to execute 'importKey' on 'SubtleCrypto': 5th argument cannot be converted to sequence.");
		usages.forEach((usage, i) => {
			if (!USAGE_ORDER.includes(usage)) throw typeError(`Failed to execute 'importKey' on 'SubtleCrypto': 5th argument[${i}] '${usage}' is not a valid enum value of type KeyUsage.`, "ERR_INVALID_ARG_VALUE");
		});
		if (format === "jwk") {
			if (keyData === null || typeof keyData !== "object" || Array.isArray(keyData)) throw typeError("Failed to execute 'importKey' on 'SubtleCrypto': 2nd argument is not of type JsonWebKey.");
		} else if (!(keyData instanceof ArrayBuffer) && !ArrayBuffer.isView(keyData)) {
			throw typeError("Failed to execute 'importKey' on 'SubtleCrypto': 2nd argument is not instance of ArrayBuffer, Buffer, TypedArray, or DataView.");
		}
		if (name === "HMAC") required(a, "HmacImportParams", ["hash"]);
		if (name.startsWith("RSA")) required(a, "RsaHashedImportParams", ["hash"]);
		if (name === "ECDSA" || name === "ECDH") required(a, "EcKeyImportParams", ["namedCurve"]);
		if (isKmac(name)) {
			usages.forEach((usage, i) => {
				if (!USAGE_ORDER.includes(usage)) throw typeError(`Failed to execute 'importKey' on 'SubtleCrypto': 5th argument[${i}] '${usage}' is not a valid enum value of type KeyUsage.`, "ERR_INVALID_ARG_VALUE");
			});
			checkUsages(name, usages, secretUsages[name]);
			// Node.js imports KMAC keys from JWK only.
			if (format !== "jwk") throw fail("NotSupportedError", `Unable to import ${name} using ${format} format`);
			if (keyData instanceof ArrayBuffer || ArrayBuffer.isView(keyData)) throw fail("DataError", "Invalid keyData");
			if (keyData.kty !== "oct") throw fail("DataError", 'Invalid JWK "kty" Parameter');
			if (keyData.k === undefined) throw fail("DataError", "Invalid keyData");
			checkJwkCommon(keyData, extractable, usages);
			if (keyData.alg !== undefined && keyData.alg !== jwkAlgFor({ name })) throw fail("DataError", 'JWK "alg" does not match the requested algorithm');
			if (!usages.length) throw fail("SyntaxError", "Usages cannot be empty when importing a secret key.");
			const bytes = Buffer.from(String(keyData.k), "base64url");
			return secretKey(bytes, { name, length: bytes.length * 8 }, extractable, usages);
		}
		if (secretUsages[name]) {
			if (ARGON2.includes(name)) {
				if (format !== "raw-secret") throw fail("NotSupportedError", `Unable to import ${name} using ${format} format`);
				for (const usage of usages) {
					if (!USAGE_ORDER.includes(usage)) throw typeError(`Invalid key usage: ${usage}`, "ERR_INVALID_ARG_VALUE");
					if (!secretUsages[name].includes(usage)) throw fail("SyntaxError", `Unsupported key usage for a ${name} key`);
				}
				if (extractable) throw fail("SyntaxError", `${name} keys are not extractable`);
				if (!usages.length) throw fail("SyntaxError", "Usages cannot be empty when importing a secret key.");
				return secretKey(Buffer.from(bytesOf(keyData, "keyData")), { name }, false, usages);
			}
			checkUsages(name, usages, secretUsages[name]);
			let bytes;
			if (format === "raw" || format === "raw-secret") bytes = Buffer.from(bytesOf(keyData, "keyData"));
			else if (format === "jwk") {
				if (keyData.kty !== "oct") throw fail("DataError", "Invalid JWK key type");
				if (typeof keyData.k !== "string") throw fail("DataError", "Invalid keyData");
				bytes = Buffer.from(keyData.k, "base64url");
				checkJwkCommon(keyData, extractable, usages);
				const expected = jwkAlgFor({ name, hash: a.hash ? { name: hashOf(a.hash) } : undefined, length: bytes.length * 8 });
				if (keyData.alg !== undefined && expected && keyData.alg !== expected && name !== "PBKDF2" && name !== "HKDF") throw fail("DataError", "JWK \"alg\" does not match the requested algorithm");
			} else throw fail("NotSupportedError", `Unable to import ${name} key with format ${format}`);
			if (name === "PBKDF2" || name === "HKDF") {
				if (extractable) throw fail("SyntaxError", `${name} keys are not extractable`);
				return secretKey(bytes, { name }, false, usages);
			}
			if (name.startsWith("AES-")) {
				if (![16, 24, 32].includes(bytes.length)) throw fail("DataError", "Invalid key length");
				if (!usages.length) throw fail("SyntaxError", "Usages cannot be empty when importing a secret key.");
				return secretKey(bytes, { name, length: bytes.length * 8 }, extractable, usages);
			}
			// HMAC
			const hash = hashOf(a.hash);
			if (!bytes.length) throw fail("DataError", "Zero-length key is not supported");
			if (!usages.length) throw fail("SyntaxError", "Usages cannot be empty when importing a secret key.");
			let length = bytes.length * 8;
			if (a.length !== undefined) {
				if (a.length > length || a.length <= length - 8) throw fail("DataError", "Invalid key length");
				length = a.length;
			}
			return secretKey(bytes, { name, length, hash: { name: hash } }, extractable, usages);
		}
		// asymmetric
		const isPqc = Boolean(PQC_ARCS[name]);
		if (isPqc && format === "raw") throw fail("NotSupportedError", `Unable to import ${name} using raw format`);
		if (!isPqc && (format === "raw-public" || format === "raw-seed")) throw fail("NotSupportedError", `Unable to import ${name} key with format ${format}`);
		const isEd = name === "Ed25519" || name === "Ed448";
		const isX = name === "X25519" || name === "X448";
		let keyObject;
		let type;
		try {
			if (format === "spki") {
				keyObject = crypto.createPublicKey({ key: Buffer.from(bytesOf(keyData, "keyData")), format: "der", type: "spki" });
				type = "public";
			} else if (format === "pkcs8") {
				keyObject = crypto.createPrivateKey({ key: Buffer.from(bytesOf(keyData, "keyData")), format: "der", type: "pkcs8" });
				type = "private";
			} else if (format === "raw-public" || format === "raw-seed") {
				const raw = Buffer.from(bytesOf(keyData, "keyData"));
				const options = { key: raw, format, asymmetricKeyType: name.toLowerCase() };
				keyObject = format === "raw-seed" ? crypto.createPrivateKey(options) : crypto.createPublicKey(options);
				type = format === "raw-seed" ? "private" : "public";
			} else if (format === "raw") {
				const raw = Buffer.from(bytesOf(keyData, "keyData"));
				if (name === "ECDSA" || name === "ECDH") {
					if (raw[0] !== 4 || !CURVES[a.namedCurve]) throw new Error("bad point");
					const size = (raw.length - 1) >> 1;
					const jwk = { kty: "EC", crv: a.namedCurve, x: raw.subarray(1, 1 + size).toString("base64url"), y: raw.subarray(1 + size).toString("base64url") };
					keyObject = crypto.createPublicKey({ key: jwk, format: "jwk" });
				} else if (isEd || isX) {
					keyObject = crypto.createPublicKey({ key: { kty: "OKP", crv: name, x: raw.toString("base64url") }, format: "jwk" });
				} else throw fail("NotSupportedError", `Unable to import ${name} key with format raw`);
				type = "public";
			} else if (format === "jwk" && isPqc) {
				if (keyData.kty !== "AKP") throw fail("DataError", 'Invalid JWK "kty" Parameter');
				if (keyData.alg === undefined || typeof keyData.pub !== "string") throw fail("DataError", "Invalid keyData");
				if (keyData.alg !== name) throw fail("DataError", 'JWK "alg" Parameter and algorithm name mismatch');
				if (keyData.use !== undefined && keyData.use !== (name.startsWith("ML-KEM") ? "enc" : "sig")) throw fail("DataError", 'Invalid JWK "use" Parameter');
				checkJwkCommon(keyData, extractable, usages);
				const isPrivate = keyData.priv !== undefined;
				keyObject = isPrivate ? crypto.createPrivateKey({ key: keyData, format: "jwk" }) : crypto.createPublicKey({ key: keyData, format: "jwk" });
				type = isPrivate ? "private" : "public";
			} else if (format === "jwk") {
				checkJwkCommon(keyData, extractable, usages);
				const jwk = { ...keyData };
				const isPrivate = jwk.d !== undefined;
				if (name.startsWith("RSA") && jwk.kty !== "RSA") throw fail("DataError", "Invalid JWK \"kty\" Parameter");
				if ((name === "ECDSA" || name === "ECDH") && jwk.kty !== "EC") throw fail("DataError", "Invalid JWK \"kty\" Parameter");
				if ((isEd || isX) && jwk.kty !== "OKP") throw fail("DataError", "Invalid JWK \"kty\" Parameter");
				if (name.startsWith("RSA") && jwk.alg !== undefined && jwk.alg !== jwkAlgFor({ name, hash: { name: hashOf(a.hash) } })) throw fail("DataError", "JWK \"alg\" does not match the requested algorithm");
				keyObject = isPrivate ? crypto.createPrivateKey({ key: jwk, format: "jwk" }) : crypto.createPublicKey({ key: jwk, format: "jwk" });
				type = isPrivate ? "private" : "public";
			} else {
				throw fail("NotSupportedError", `Unable to import ${name} key with format ${format}`);
			}
		} catch (err) {
			if (err && err.name === "NotSupportedError") throw err;
			if (err && (err.name === "DataError" || err.name === "SyntaxError" || err.name === "InvalidAccessError")) throw err;
			throw fail("DataError", "Invalid keyData");
		}
		// The key must be of the kind the algorithm names.
		const kind = keyObject.asymmetricKeyType;
		if (name.startsWith("RSA") ? kind !== "rsa" : name === "ECDSA" || name === "ECDH" ? kind !== "ec" : kind !== name.toLowerCase()) throw fail("DataError", "Invalid key type");
		const allowed = type === "public" ? publicUsages[name] : privateUsages[name];
		checkUsages(name, usages, allowed);
		if (type === "private" && !usages.length) throw fail("SyntaxError", "Usages cannot be empty when importing a private key.");
		let algo;
		if (name.startsWith("RSA")) algo = rsaAlgorithm(name, keyObject, hashOf(a.hash));
		else if (name === "ECDSA" || name === "ECDH") {
			const actual = Object.entries(CURVES).find(([, v]) => v === keyObject.asymmetricKeyDetails.namedCurve)?.[0];
			if (actual !== a.namedCurve) throw fail("DataError", "Named curve mismatch");
			algo = { name, namedCurve: a.namedCurve };
		} else algo = { name };
		return makeKey(keyObject, algo, extractable, usages, type);
	};
	const checkJwkCommon = (jwk, extractable, usages) => {
		if (jwk.use !== undefined && !["sig", "enc"].includes(jwk.use) && false) throw fail("DataError", "Invalid JWK \"use\" Parameter");
		if (jwk.key_ops !== undefined) {
			for (const op of usages) if (!jwk.key_ops.includes(op)) throw fail("DataError", "Key operations and usage mismatch");
		}
		if (jwk.ext !== undefined && jwk.ext === false && extractable) throw fail("DataError", "JWK \"ext\" Parameter and extractable mismatch");
	};

	/* ---------------------------------------------------------------------------- operations */

	function operationError() {
		return fail("OperationError", "The operation failed for an operation-specific reason");
	}
	const requireUsage = (key, usage, action) => {
		if (!key.usages.includes(usage)) throw fail("InvalidAccessError", `Unable to use this key to ${action}`);
	};
	const sameAlgorithm = (a, key) => {
		if (a.name !== key.algorithm.name) throw fail("InvalidAccessError", "Key algorithm mismatch");
	};
	const signBytes = (a, key, data) => {
		const name = a.name;
		if (name === "HMAC") return new Uint8Array(native.hmac(HASHES[key.algorithm.hash.name], key.keyObject.export(), data));
		if (isKmac(name)) return kmac(name === "KMAC128" ? 128 : 256, key.keyObject.export(), data, a.outputLength, a.customization ? bytesOf(a.customization) : undefined);
		if (name === "RSASSA-PKCS1-v1_5") return new Uint8Array(crypto.sign(HASHES[key.algorithm.hash.name], data, key.keyObject));
		if (name === "RSA-PSS") return new Uint8Array(crypto.sign(HASHES[key.algorithm.hash.name], data, { key: key.keyObject, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: a.saltLength }));
		if (name === "ECDSA") return new Uint8Array(crypto.sign(HASHES[hashOf(a.hash)], data, { key: key.keyObject, dsaEncoding: "ieee-p1363" }));
		if (ML_DSA.includes(name)) return new Uint8Array(crypto.sign(null, data, { key: key.keyObject, context: contextOf(a) }));
		return new Uint8Array(crypto.sign(null, data, key.keyObject));
	};
	/* The `context` of ML-DSA parameters: a BufferSource of at most 255 bytes. */
	const contextOf = (a) => {
		if (a.context === undefined) return new Uint8Array(0);
		if (!(a.context instanceof ArrayBuffer) && !ArrayBuffer.isView(a.context)) {
			throw typeError("Failed to normalize algorithm: context in passed algorithm is not instance of ArrayBuffer, Buffer, TypedArray, or DataView.");
		}
		const bytes = bytesOf(a.context, "context");
		if (bytes.length > 255) throw operationError();
		return bytes;
	};
	const sign = (algorithm, key, data) => {
		const a = normalize(algorithm, "sign");
		const k = internal(key, "key");
		sameAlgorithm(a, k);
		requireUsage(k, "sign", "sign");
		if (a.name === "RSA-PSS") required(a, "RsaPssParams", ["saltLength"]);
		if (a.name === "ECDSA") required(a, "EcdsaParams", ["hash"]);
		return abOf(signBytes(a, k, bytesOf(data)));
	};
	const verify = (algorithm, key, signature, data) => {
		const a = normalize(algorithm, "verify");
		const k = internal(key, "key");
		sameAlgorithm(a, k);
		requireUsage(k, "verify", "verify");
		if (a.name === "RSA-PSS") required(a, "RsaPssParams", ["saltLength"]);
		if (a.name === "ECDSA") required(a, "EcdsaParams", ["hash"]);
		const message = bytesOf(data);
		const sig = bytesOf(signature, "signature");
		const name = a.name;
		if (name === "HMAC" || isKmac(name)) {
			const expected = signBytes(a, { ...k, keyObject: k.keyObject }, message);
			return expected.length === sig.length && expected.every((b, i) => b === sig[i]);
		}
		if (name === "RSASSA-PKCS1-v1_5") return crypto.verify(HASHES[k.algorithm.hash.name], message, k.keyObject, sig);
		if (name === "RSA-PSS") return crypto.verify(HASHES[k.algorithm.hash.name], message, { key: k.keyObject, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: a.saltLength }, sig);
		if (name === "ECDSA") return crypto.verify(HASHES[hashOf(a.hash)], message, { key: k.keyObject, dsaEncoding: "ieee-p1363" }, sig);
		if (ML_DSA.includes(name)) return crypto.verify(null, message, { key: k.keyObject, context: contextOf(a) }, sig);
		return crypto.verify(null, message, k.keyObject, sig);
	};
	const cipherRun = (encrypt, a, k, data) => {
		const name = a.name;
		const bits = k.algorithm.length;
		const message = bytesOf(data);
		if (name === "AES-CBC") required(a, "AesCbcParams", ["iv"]);
		if (name === "AES-CTR") required(a, "AesCtrParams", ["counter", "length"]);
		if (name === "AES-GCM") required(a, "AesGcmParams", ["iv"]);
		try {
			if (name === "AES-CBC") {
				const iv = bytesOf(a.iv, "iv");
				if (iv.length !== 16) throw fail("OperationError", "algorithm.iv must contain exactly 16 bytes");
				const c = encrypt ? crypto.createCipheriv(`aes-${bits}-cbc`, k.keyObject.export(), iv) : crypto.createDecipheriv(`aes-${bits}-cbc`, k.keyObject.export(), iv);
				return new Uint8Array(Buffer.concat([c.update(message), c.final()]));
			}
			if (name === "AES-CTR") {
				const counter = bytesOf(a.counter, "counter");
				if (counter.length !== 16) throw fail("OperationError", "algorithm.counter must contain exactly 16 bytes");
				if (!Number.isInteger(a.length) || a.length < 1 || a.length > 128) throw fail("OperationError", "algorithm.length must be between 1 and 128");
				const c = encrypt ? crypto.createCipheriv(`aes-${bits}-ctr`, k.keyObject.export(), counter) : crypto.createDecipheriv(`aes-${bits}-ctr`, k.keyObject.export(), counter);
				return new Uint8Array(Buffer.concat([c.update(message), c.final()]));
			}
			if (name === "AES-GCM") {
				const iv = bytesOf(a.iv, "iv");
				const tagBits = a.tagLength ?? 128;
				if (![32, 64, 96, 104, 112, 120, 128].includes(tagBits)) throw fail("OperationError", `${tagBits} is not a valid AES-GCM tag length`);
				const tagBytes = tagBits / 8;
				const aad = a.additionalData === undefined ? undefined : bytesOf(a.additionalData, "additionalData");
				if (encrypt) {
					const c = crypto.createCipheriv(`aes-${bits}-gcm`, k.keyObject.export(), iv, { authTagLength: tagBytes });
					if (aad) c.setAAD(aad);
					const body = Buffer.concat([c.update(message), c.final()]);
					return new Uint8Array(Buffer.concat([body, c.getAuthTag()]));
				}
				if (message.length < tagBytes) throw operationError();
				const c = crypto.createDecipheriv(`aes-${bits}-gcm`, k.keyObject.export(), iv, { authTagLength: tagBytes });
				if (aad) c.setAAD(aad);
				c.setAuthTag(message.subarray(message.length - tagBytes));
				return new Uint8Array(Buffer.concat([c.update(message.subarray(0, message.length - tagBytes)), c.final()]));
			}
			// RSA-OAEP
			const options = { key: k.keyObject, oaepHash: HASHES[k.algorithm.hash.name] };
			if (a.label !== undefined) options.oaepLabel = Buffer.from(bytesOf(a.label, "label"));
			return new Uint8Array(encrypt ? crypto.publicEncrypt(options, message) : crypto.privateDecrypt(options, message));
		} catch (err) {
			if (err && err.name && /Error$/.test(err.name) && err.constructor === DOMExceptionClass) throw err;
			throw operationError();
		}
	};
	const cryptoOp = (op, algorithm, key, data) => {
		const encrypt = op === "encrypt";
		const a = normalize(algorithm, op);
		const k = internal(key, "key");
		sameAlgorithm(a, k);
		requireUsage(k, op, op);
		return abOf(cipherRun(encrypt, a, k, data));
	};

	const deriveBitsBytes = (a, base, length) => {
		const name = a.name;
		if (ARGON2.includes(name)) {
			if (a.nonce.length < 8) throw fail("OperationError", "nonce must be at least 8 bytes");
			if (a.parallelism < 1 || a.parallelism > 16777215) throw fail("OperationError", "parallelism must be > 0 and <= 16777215");
			if (a.memory < 8 * a.parallelism) throw fail("OperationError", "memory must be at least 8 times the degree of parallelism");
			if (a.passes < 1) throw fail("OperationError", "passes must be > 0");
			const version = a.version ?? 0x13;
			if (version !== 0x13) throw fail("OperationError", `${version} is not a valid Argon2 version`);
			if (length === null || length === undefined) throw fail("OperationError", "length cannot be null");
			if (length % 8 !== 0) throw fail("OperationError", "length must be a multiple of 8");
			if (length < 32) throw fail("OperationError", "length must be >= 32");
			return argon2Derive(name.toLowerCase(), {
				message: base.keyObject.export(),
				nonce: a.nonce,
				secret: a.secretValue ?? new Uint8Array(0),
				associatedData: a.associatedData ?? new Uint8Array(0),
				parallelism: a.parallelism,
				tagLength: length / 8,
				memory: a.memory,
				passes: a.passes,
				version,
			});
		}
		if (name === "PBKDF2" || name === "HKDF") {
			if (name === "PBKDF2") required(a, "Pbkdf2Params", ["salt", "iterations", "hash"]);
			else required(a, "HkdfParams", ["hash", "salt", "info"]);
			const hash = hashOf(a.hash);
			if (length === null || length === undefined) throw fail("OperationError", "length cannot be null");
			if (length % 8 !== 0) throw fail("OperationError", "length must be a multiple of 8");
			const secret = base.keyObject.export();
			if (name === "PBKDF2") {
				if (!Number.isInteger(a.iterations) || a.iterations < 1) throw fail("OperationError", "iterations cannot be zero");
				return new Uint8Array(native.pbkdf2(HASHES[hash], secret, bytesOf(a.salt, "salt"), a.iterations, length / 8));
			}
			return new Uint8Array(native.hkdf(HASHES[hash], secret, bytesOf(a.salt, "salt"), bytesOf(a.info, "info"), length / 8));
		}
		// ECDH, X25519, X448
		required(a, name === "ECDH" ? "EcdhKeyDeriveParams" : "KeyDeriveParams", ["public"]);
		const other = internal(a.public, "algorithm.public");
		if (other.type !== "public") throw fail("InvalidAccessError", "algorithm.public must be a public key");
		if (other.algorithm.name !== base.algorithm.name) throw fail("InvalidAccessError", "algorithm.public must be a public key of the same algorithm");
		if (name === "ECDH" && other.algorithm.namedCurve !== base.algorithm.namedCurve) throw fail("InvalidAccessError", "Named curve mismatch");
		let secret;
		try {
			secret = new Uint8Array(crypto.diffieHellman({ privateKey: base.keyObject, publicKey: other.keyObject }));
		} catch {
			throw operationError();
		}
		if (length === null || length === undefined) return secret;
		if (length > secret.length * 8) throw fail("OperationError", "derived bit length is too small");
		const bytes = secret.subarray(0, (length + 7) >> 3);
		if (length % 8) {
			const copy = new Uint8Array(bytes);
			copy[copy.length - 1] &= 0xff << (8 - (length % 8));
			return copy;
		}
		return bytes.slice();
	};
	const deriveBits = (algorithm, baseKey, length) => {
		const a = normalize(algorithm, "deriveBits");
		const k = internal(baseKey, "baseKey");
		if (!k.usages.includes("deriveBits")) throw fail("InvalidAccessError", "baseKey does not have deriveBits usage");
		sameAlgorithm(a, k);
		if (length !== undefined && length !== null) {
			const n = Math.trunc(Number(length));
			if (!(n >= 0 && n <= 4294967295)) throw typeError("Failed to execute 'deriveBits' on 'SubtleCrypto': 3rd argument is outside the expected range of 0 to 4294967295.", "ERR_OUT_OF_RANGE");
			length = n;
		}
		return abOf(deriveBitsBytes(a, k, length ?? null));
	};
	const keyLengthOf = (derived) => {
		const d = normalize(derived, "importKey");
		if (d.name.startsWith("AES-")) {
			if (![128, 192, 256].includes(d.length)) throw fail("OperationError", "AES key length must be 128, 192, or 256 bits");
			return d.length;
		}
		if (d.name === "HMAC") return d.length ?? blockBits(hashOf(d.hash));
		if (d.name === "HKDF" || d.name === "PBKDF2" || ARGON2.includes(d.name)) return null;
		if (isKmac(d.name)) return d.length === undefined ? (d.name === "KMAC128" ? 128 : 256) : convertMember(d, "length", "ulong");
		throw fail("NotSupportedError", "Unrecognized algorithm name");
	};
	const deriveKey = (algorithm, baseKey, derivedKeyType, extractable, usages) => {
		const a = normalize(algorithm, "deriveKey");
		const k = internal(baseKey, "baseKey");
		if (!k.usages.includes("deriveKey")) throw fail("InvalidAccessError", "baseKey does not have deriveKey usage");
		sameAlgorithm(a, k);
		const length = keyLengthOf(derivedKeyType);
		const bits = deriveBitsBytes(a, k, length);
		const derived = normalize(derivedKeyType, "importKey");
		if (isKmac(derived.name)) {
			checkUsages(derived.name, usages, secretUsages[derived.name]);
			if (!usages.length) throw fail("SyntaxError", "Usages cannot be empty when importing a secret key.");
			return secretKey(bits, { name: derived.name, length: bits.length * 8 }, extractable, usages);
		}
		return importKey("raw", bits, derivedKeyType, extractable, usages);
	};

	const wrapAlgorithm = (algorithm, op) => normalize(algorithm, op);
	const wrapKey = (format, key, wrappingKey, wrapAlgo) => {
		const a = wrapAlgorithm(wrapAlgo, "wrapKey");
		const wrapping = internal(wrappingKey, "wrappingKey");
		sameAlgorithm(a, wrapping);
		requireUsage(wrapping, "wrapKey", "wrapKey");
		const exported = exportKey(format, key);
		let bytes = format === "jwk" ? new Uint8Array(Buffer.from(JSON.stringify(exported), "utf8")) : new Uint8Array(exported);
		if (format === "jwk" && a.name === "AES-KW" && bytes.length % 8) {
			// AES-KW wraps whole 8-byte halves: Node pads the JSON with spaces.
			const padded = new Uint8Array(bytes.length + (8 - (bytes.length % 8))).fill(0x20);
			padded.set(bytes);
			bytes = padded;
		}
		if (a.name === "AES-KW") {
			if (bytes.length % 8) throw operationError();
			return abOf(new Uint8Array(native.kwWrap(wrapping.keyObject.export(), bytes, false)));
		}
		return abOf(cipherRun(true, a, wrapping, bytes));
	};
	const unwrapKey = (format, wrapped, unwrappingKey, unwrapAlgo, unwrappedAlgo, extractable, usages) => {
		const a = wrapAlgorithm(unwrapAlgo, "unwrapKey");
		const unwrapping = internal(unwrappingKey, "unwrappingKey");
		sameAlgorithm(a, unwrapping);
		requireUsage(unwrapping, "unwrapKey", "unwrapKey");
		let bytes;
		if (a.name === "AES-KW") {
			try {
				bytes = new Uint8Array(native.kwUnwrap(unwrapping.keyObject.export(), bytesOf(wrapped, "wrappedKey"), false));
			} catch {
				throw operationError();
			}
		} else bytes = cipherRun(false, a, unwrapping, wrapped);
		let keyData = bytes;
		if (format === "jwk") {
			try {
				keyData = JSON.parse(Buffer.from(bytes).toString("utf8"));
			} catch {
				throw fail("DataError", "Invalid keyData");
			}
		}
		return importKey(format, keyData, unwrappedAlgo, extractable, usages);
	};

	/* cSHAKE, TurboSHAKE and KangarooTwelve digests; the output length is in bits. */
	const digestSponge = (a, data) => {
		const strength = a.name.endsWith("128") ? 128 : 256;
		const bits = a.outputLength;
		const custom = a.customization && !a.name.startsWith("TurboSHAKE") ? bytesOf(a.customization) : undefined;
		if (a.name.startsWith("cSHAKE")) {
			if (a.functionName && bytesOf(a.functionName).length) throw fail("NotSupportedError", "Unsupported CShakeParams functionName");
			return truncateBits(cshake(strength, data, Math.ceil(bits / 8), undefined, custom), bits);
		}
		if (a.name.startsWith("TurboSHAKE")) {
			const domain = a.domainSeparation ?? 0x1f;
			if (domain < 1 || domain > 0x7f) throw fail("OperationError", "TurboShakeParams.domainSeparation must be in range 0x01-0x7f");
			if (bits === 0 || bits % 8) throw fail("OperationError", "Invalid TurboShakeParams outputLength");
			return turboshake(strength, data, bits / 8, domain);
		}
		if (bits === 0 || bits % 8) throw fail("OperationError", "Invalid KangarooTwelveParams outputLength");
		return kangarootwelve(strength, data, bits / 8, custom);
	};
	/* ML-KEM: the key must be a CryptoKey of the named parameter set with the right usage. */
	const kemKey = (method, position, key, a, usage, label) => {
		const k = key && typeof key === "object" ? slot.get(key) : undefined;
		if (!k) throw typeError(`Failed to execute '${method}' on 'SubtleCrypto': ${ordinal(position)} argument is not of type CryptoKey.`);
		if (k.algorithm.name !== a.name) throw fail("InvalidAccessError", "key algorithm mismatch");
		if (!k.usages.includes(usage)) throw fail("InvalidAccessError", `${label} does not have ${usage} usage`);
		return k;
	};
	const kemCall = (fn) => {
		try {
			return fn();
		} catch (err) {
			if (err && err.code === "ERR_CRYPTO_OPERATION_FAILED") throw operationError();
			throw err;
		}
	};
	const encapsulateBits = (algorithm, encapsulationKey) => {
		const a = normalize(algorithm, "encapsulateBits");
		const k = kemKey("encapsulateBits", 2, encapsulationKey, a, "encapsulateBits", "encapsulationKey");
		const { sharedKey, ciphertext } = kemCall(() => crypto.encapsulate(k.keyObject));
		return { sharedKey: abOf(sharedKey), ciphertext: abOf(ciphertext) };
	};
	const encapsulateKey = (algorithm, encapsulationKey, sharedKeyAlgorithm, extractable, usages) => {
		const a = normalize(algorithm, "encapsulateKey");
		const k = kemKey("encapsulateKey", 2, encapsulationKey, a, "encapsulateKey", "encapsulationKey");
		const { sharedKey, ciphertext } = kemCall(() => crypto.encapsulate(k.keyObject));
		return { ciphertext: abOf(ciphertext), sharedKey: importKey("raw", sharedKey, sharedKeyAlgorithm, extractable, usages) };
	};
	const decapsulateBits = (algorithm, decapsulationKey, ciphertext) => {
		const a = normalize(algorithm, "decapsulateBits");
		const k = kemKey("decapsulateBits", 2, decapsulationKey, a, "decapsulateBits", "decapsulationKey");
		return abOf(kemCall(() => crypto.decapsulate(k.keyObject, bytesOf(ciphertext, "ciphertext"))));
	};
	const decapsulateKey = (algorithm, decapsulationKey, ciphertext, sharedKeyAlgorithm, extractable, usages) => {
		const a = normalize(algorithm, "decapsulateKey");
		const k = kemKey("decapsulateKey", 2, decapsulationKey, a, "decapsulateKey", "decapsulationKey");
		const sharedKey = kemCall(() => crypto.decapsulate(k.keyObject, bytesOf(ciphertext, "ciphertext")));
		return importKey("raw", sharedKey, sharedKeyAlgorithm, extractable, usages);
	};

	const digest = (algorithm, data) => {
		const a = normalize(algorithm, "digest");
		if (XOF_DIGESTS.includes(a.name)) return abOf(digestSponge(a, bytesOf(data)));
		return abOf(new Uint8Array(native.hash(HASHES[a.name], bytesOf(data))));
	};
	const getPublicKey = (key, usages) => {
		const k = internal(key, "key");
		if (k.type !== "private") throw fail("InvalidAccessError", "key must be a private key");
		checkUsages(k.algorithm.name, usages, publicUsages[k.algorithm.name] ?? []);
		return makeKey(crypto.createPublicKey(k.keyObject), k.algorithm, true, usages, "public");
	};

	/* ------------------------------------------------------------------------ the classes */

	const ARITY = { encrypt: 3, decrypt: 3, sign: 3, verify: 4, digest: 2, generateKey: 3, deriveKey: 5, deriveBits: 2, importKey: 5, exportKey: 2, wrapKey: 4, unwrapKey: 7, getPublicKey: 2, encapsulateBits: 2, encapsulateKey: 5, decapsulateBits: 3, decapsulateKey: 6 };
	/* Where in the call each byte argument sits, for Node's "Failed to execute" wording. */
	const BUFFER_ARGUMENT = { digest: { data: 2 }, sign: { data: 3 }, verify: { signature: 3, data: 4 }, encrypt: { data: 3 }, decrypt: { data: 3 }, importKey: { keyData: 2 }, unwrapKey: { wrappedKey: 2 }, decapsulateBits: { ciphertext: 3 }, decapsulateKey: { ciphertext: 3 } };
	const wrapAsync = (method, fn) =>
		function (...args) {
			if (!(this instanceof SubtleCrypto)) return Promise.reject(Object.assign(new TypeError('Value of "this" must be of type SubtleCrypto'), { code: "ERR_INVALID_THIS" }));
			try {
				if (args.length < ARITY[method]) {
					throw typeError(`Failed to execute '${method}' on 'SubtleCrypto': ${ARITY[method]} arguments required, but only ${args.length} present.`, "ERR_MISSING_ARGS");
				}
				return Promise.resolve(fn(...args));
			} catch (err) {
				if (err && err.bufferArgument !== undefined) {
					const position = BUFFER_ARGUMENT[method]?.[err.bufferArgument];
					if (position) {
						return Promise.reject(typeError(`Failed to execute '${method}' on 'SubtleCrypto': ${ordinal(position)} argument is not instance of ArrayBuffer, Buffer, TypedArray, or DataView.`));
					}
				}
				return Promise.reject(err);
			}
		};
	class SubtleCrypto {
		constructor() {
			throw typeError("Illegal constructor", "ERR_ILLEGAL_CONSTRUCTOR");
		}
		get [Symbol.toStringTag]() {
			return "SubtleCrypto";
		}
	}
	const methods = {
		encrypt: (algorithm, key, data) => cryptoOp("encrypt", algorithm, key, data),
		decrypt: (algorithm, key, data) => cryptoOp("decrypt", algorithm, key, data),
		sign,
		verify,
		digest,
		generateKey,
		deriveKey,
		deriveBits,
		importKey,
		exportKey,
		wrapKey,
		unwrapKey,
		getPublicKey,
		encapsulateBits,
		encapsulateKey,
		decapsulateBits,
		decapsulateKey,
	};
	for (const [name, fn] of Object.entries(methods)) {
		Object.defineProperty(SubtleCrypto.prototype, name, { value: wrapAsync(name, fn), writable: true, configurable: true, enumerable: true });
	}
	/* SubtleCrypto.supports(operation, algorithm[, lengthOrAdditionalAlgorithm]): whether the host offers that. */
	Object.defineProperty(SubtleCrypto, "supports", {
		value: function supports(operation, algorithm, lengthOrAdditionalAlgorithm) {
			try {
				if (!OPERATIONS[operation]) return false;
				const a = normalize(algorithm, operation);
				if (operation === "encapsulateKey" || operation === "decapsulateKey") {
					return lengthOrAdditionalAlgorithm !== undefined && supports("importKey", lengthOrAdditionalAlgorithm);
				}
				if (operation === "generateKey") {
					if (a.name.startsWith("AES-")) return Number.isInteger(a.length);
					if (a.name === "HMAC") return a.hash !== undefined;
					if (a.name.startsWith("RSA")) return a.modulusLength !== undefined && a.publicExponent !== undefined && a.hash !== undefined;
					if (a.name === "ECDSA" || a.name === "ECDH") return CURVES[a.namedCurve] !== undefined;
				}
				if (operation === "importKey") {
					if (a.name === "HMAC" || a.name.startsWith("RSA")) return a.hash !== undefined;
					if (a.name === "ECDSA" || a.name === "ECDH") return CURVES[a.namedCurve] !== undefined;
				}
				return true;
			} catch {
				return false;
			}
		},
		writable: true,
		configurable: true,
	});
	const subtle = Object.create(SubtleCrypto.prototype);

	return { CryptoKey, SubtleCrypto, subtle, keyObjectOf: (key) => (key && typeof key === "object" ? slot.get(key)?.keyObject : undefined) };
}

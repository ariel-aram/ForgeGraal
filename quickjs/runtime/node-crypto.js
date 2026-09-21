/*
 * Node's `crypto`, over the native host's mbedTLS: hashing and HMAC (md5, sha1, sha224/256/384/512, ripemd160),
 * secure randomness, PBKDF2, HKDF, scrypt, AES (ECB, CBC, CTR, GCM) and ChaCha20-Poly1305, RSA and ECDSA signing and
 * verification from PEM keys, and the parts of Web Crypto (`crypto.subtle`, `globalThis.crypto`) programs use most.
 *
 * Streaming ciphers buffer what they are given and transform it when final() is called: the concatenation of
 * update() and final() outputs is exactly what Node produces, but an update() call alone returns nothing yet.
 * What is not provided says so: key generation, Diffie-Hellman and RSA-PSS/OAEP throw an explanation.
 */

const HASHES = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "ripemd160"];
const CIPHERS = [
	"aes-128-cbc", "aes-192-cbc", "aes-256-cbc", "aes-128-ecb", "aes-192-ecb", "aes-256-ecb", "aes-128-ctr", "aes-192-ctr", "aes-256-ctr",
	"aes-128-gcm", "aes-192-gcm", "aes-256-gcm", "chacha20-poly1305",
];

const ALIASES = { "rsa-sha256": "sha256", "rsa-sha1": "sha1", "rsa-sha384": "sha384", "rsa-sha512": "sha512", "rsa-md5": "md5", sha256withrsaencryption: "sha256", sha1withrsaencryption: "sha1", sha512withrsaencryption: "sha512", "sha-1": "sha1", "sha-256": "sha256", "sha-384": "sha384", "sha-512": "sha512", sha2: "sha256" };

function notSupported(name, why) {
	return () => {
		throw Object.assign(new Error(`crypto.${name} is not available in the Graak native host: ${why}`), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
	};
}

function createCrypto({ native, Buffer, stream, toBytes }) {
	const buf = (bytes) => Buffer.from(bytes);
	const bytesOf = (value, encoding) => {
		if (value && typeof value === "object" && value._keyData) return value._keyData;
		return toBytes(value, encoding);
	};
	const out = (bytes, encoding) => {
		const b = buf(bytes);
		return encoding && encoding !== "buffer" ? b.toString(encoding) : b;
	};
	const concat = (chunks) => {
		let total = 0;
		for (const chunk of chunks) total += chunk.length;
		const joined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			joined.set(chunk, offset);
			offset += chunk.length;
		}
		return joined;
	};
	const hashName = (algorithm) => {
		const key = String(algorithm).toLowerCase();
		const name = ALIASES[key] ?? key;
		if (!HASHES.includes(name)) {
			throw new Error("Digest method not supported");
		}
		return name;
	};
	const invalidArg = (name, expected, value) =>
		Object.assign(new TypeError(`The "${name}" argument must be ${expected}. Received ${value === null ? "null" : typeof value}`), { code: "ERR_INVALID_ARG_TYPE" });

	/* ---------------------------------------------------------------- hash and hmac */

	class Hash extends stream.Transform {
		constructor(algorithm, options) {
			super(options);
			this.algorithm = hashName(algorithm);
			this._chunks = [];
			this._done = false;
		}
		update(data, encoding) {
			if (this._done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
			if (typeof data !== "string" && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
				throw invalidArg("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
			}
			this._chunks.push(toBytes(data, encoding));
			return this;
		}
		digest(encoding) {
			if (this._done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
			this._done = true;
			return out(native.hash(this.algorithm, concat(this._chunks)), encoding);
		}
		copy() {
			const clone = new Hash(this.algorithm);
			clone._chunks = [...this._chunks];
			return clone;
		}
		_transform(chunk, encoding, callback) {
			this.update(chunk, encoding === "buffer" ? undefined : encoding);
			callback();
		}
		_flush(callback) {
			this.push(this.digest());
			callback();
		}
	}

	class Hmac extends stream.Transform {
		constructor(algorithm, key, options) {
			super(options);
			this.algorithm = hashName(algorithm);
			this._key = bytesOf(key);
			this._chunks = [];
			this._done = false;
		}
		update(data, encoding) {
			if (this._done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
			this._chunks.push(toBytes(data, encoding));
			return this;
		}
		digest(encoding) {
			this._done = true;
			return out(native.hmac(this.algorithm, this._key, concat(this._chunks)), encoding);
		}
		_transform(chunk, encoding, callback) {
			this.update(chunk, encoding === "buffer" ? undefined : encoding);
			callback();
		}
		_flush(callback) {
			this.push(this.digest());
			callback();
		}
	}

	/* --------------------------------------------------------------------- random */

	const randomFillSync = (target, offset = 0, size) => {
		const view = target instanceof ArrayBuffer ? new Uint8Array(target) : new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
		const length = size ?? view.length - offset;
		if (offset < 0 || offset + length > view.length) {
			throw Object.assign(new RangeError('The value of "size + offset" is out of range.'), { code: "ERR_OUT_OF_RANGE" });
		}
		// The host draws at most a bounded amount per call.
		for (let done = 0; done < length; ) {
			const n = Math.min(length - done, 65536);
			view.set(native.randomBytes(n), offset + done);
			done += n;
		}
		return target;
	};

	function randomInt(min, max, callback) {
		if (typeof max === "function" || max === undefined) {
			callback = max;
			max = min;
			min = 0;
		}
		if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) throw invalidArg("min", "a safe integer", min);
		const range = max - min;
		if (range <= 0 || range > 2 ** 48 - 1) {
			throw Object.assign(new RangeError('The value of "max" is out of range. It must be greater than the value of "min"'), { code: "ERR_OUT_OF_RANGE" });
		}
		// Rejection sampling: a plain modulus of random bytes would favour the low values.
		const limit = 2 ** 48 - (2 ** 48 % range);
		let value;
		do {
			value = 0;
			for (const byte of native.randomBytes(6)) value = value * 256 + byte;
		} while (value >= limit);
		const result = min + (value % range);
		if (callback) {
			queueMicrotask(() => callback(null, result));
			return undefined;
		}
		return result;
	}

	const randomUUID = () => {
		const bytes = native.randomBytes(16);
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = buf(bytes).toString("hex");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	};

	const getRandomValues = (view) => {
		if (!ArrayBuffer.isView(view) || view instanceof Float32Array || view instanceof Float64Array || view instanceof DataView) {
			throw Object.assign(new TypeError("The data argument must be an integer-type TypedArray"), { name: "TypeMismatchError", code: 17 });
		}
		if (view.byteLength > 65536) {
			throw Object.assign(new Error("The ArrayBufferView's byte length exceeds the number of bytes of entropy available via this API (65536)"), { name: "QuotaExceededError", code: 22 });
		}
		return randomFillSync(view);
	};

	/* ------------------------------------------------------------- key derivation */

	const digestOf = (digest) => {
		if (typeof digest !== "string") throw invalidArg("digest", "of type string", digest);
		return hashName(digest);
	};

	const pbkdf2Sync = (password, salt, iterations, keylen, digest) => {
		if (!Number.isInteger(iterations) || iterations < 1) throw Object.assign(new RangeError('The value of "iterations" is out of range.'), { code: "ERR_OUT_OF_RANGE" });
		return buf(native.pbkdf2(digestOf(digest), bytesOf(password), bytesOf(salt), iterations, keylen));
	};
	const pbkdf2 = (password, salt, iterations, keylen, digest, callback) => {
		let result;
		let error = null;
		try {
			result = pbkdf2Sync(password, salt, iterations, keylen, digest);
		} catch (err) {
			error = err;
		}
		queueMicrotask(() => (error ? callback(error) : callback(null, result)));
	};

	const hkdfSync = (digest, ikm, salt, info, keylen) => {
		const derived = native.hkdf(digestOf(digest), bytesOf(ikm), bytesOf(salt), bytesOf(info), keylen);
		return derived.buffer.slice(derived.byteOffset, derived.byteOffset + derived.byteLength);
	};
	const hkdf = (digest, ikm, salt, info, keylen, callback) => {
		let result;
		let error = null;
		try {
			result = hkdfSync(digest, ikm, salt, info, keylen);
		} catch (err) {
			error = err;
		}
		queueMicrotask(() => (error ? callback(error) : callback(null, result)));
	};

	/* scrypt (RFC 7914) over the host's PBKDF2. */
	function scryptSync(password, salt, keylen, options = {}) {
		const N = options.N ?? options.cost ?? 16384;
		const r = options.r ?? options.blockSize ?? 8;
		const p = options.p ?? options.parallelization ?? 1;
		if (N < 2 || (N & (N - 1)) !== 0) throw Object.assign(new RangeError("Invalid scrypt param"), { code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" });
		const maxmem = options.maxmem ?? 32 * 1024 * 1024;
		if (128 * N * r > maxmem) throw Object.assign(new RangeError("Invalid scrypt params: memory limit exceeded"), { code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" });
		const B = new Uint8Array(native.pbkdf2("sha256", bytesOf(password), bytesOf(salt), 1, p * 128 * r));
		const rot = (a, b) => (a << b) | (a >>> (32 - b));
		const salsa = (block) => {
			const x = new Uint32Array(16);
			x.set(block);
			for (let i = 0; i < 4; i++) {
				x[4] ^= rot(x[0] + x[12], 7); x[8] ^= rot(x[4] + x[0], 9); x[12] ^= rot(x[8] + x[4], 13); x[0] ^= rot(x[12] + x[8], 18);
				x[9] ^= rot(x[5] + x[1], 7); x[13] ^= rot(x[9] + x[5], 9); x[1] ^= rot(x[13] + x[9], 13); x[5] ^= rot(x[1] + x[13], 18);
				x[14] ^= rot(x[10] + x[6], 7); x[2] ^= rot(x[14] + x[10], 9); x[6] ^= rot(x[2] + x[14], 13); x[10] ^= rot(x[6] + x[2], 18);
				x[3] ^= rot(x[15] + x[11], 7); x[7] ^= rot(x[3] + x[15], 9); x[11] ^= rot(x[7] + x[3], 13); x[15] ^= rot(x[11] + x[7], 18);
				x[1] ^= rot(x[0] + x[3], 7); x[2] ^= rot(x[1] + x[0], 9); x[3] ^= rot(x[2] + x[1], 13); x[0] ^= rot(x[3] + x[2], 18);
				x[6] ^= rot(x[5] + x[4], 7); x[7] ^= rot(x[6] + x[5], 9); x[4] ^= rot(x[7] + x[6], 13); x[5] ^= rot(x[4] + x[7], 18);
				x[11] ^= rot(x[10] + x[9], 7); x[8] ^= rot(x[11] + x[10], 9); x[9] ^= rot(x[8] + x[11], 13); x[10] ^= rot(x[9] + x[8], 18);
				x[12] ^= rot(x[15] + x[14], 7); x[13] ^= rot(x[12] + x[15], 9); x[14] ^= rot(x[13] + x[12], 13); x[15] ^= rot(x[14] + x[13], 18);
			}
			for (let i = 0; i < 16; i++) block[i] = (block[i] + x[i]) | 0;
		};
		const blockMix = (input, output) => {
			const words = 16 * r * 2;
			let X = input.slice(words - 16, words);
			for (let i = 0; i < 2 * r; i++) {
				for (let j = 0; j < 16; j++) X[j] ^= input[i * 16 + j];
				salsa(X);
				output.set(X, ((i & 1) === 0 ? i / 2 : r + (i - 1) / 2) * 16);
			}
		};
		const view = new Uint32Array(B.buffer);
		const words = 32 * r;
		const V = new Uint32Array(words * N);
		const X = new Uint32Array(words);
		const Y = new Uint32Array(words);
		for (let i = 0; i < p; i++) {
			X.set(view.subarray(i * words, (i + 1) * words));
			for (let j = 0; j < N; j++) {
				V.set(X, j * words);
				blockMix(X, Y);
				X.set(Y);
			}
			for (let j = 0; j < N; j++) {
				const k = X[(2 * r - 1) * 16] & (N - 1);
				for (let w = 0; w < words; w++) X[w] ^= V[k * words + w];
				blockMix(X, Y);
				X.set(Y);
			}
			view.set(X, i * words);
		}
		return buf(native.pbkdf2("sha256", bytesOf(password), B, 1, keylen));
	}
	const scrypt = (password, salt, keylen, options, callback) => {
		if (typeof options === "function") {
			callback = options;
			options = {};
		}
		let result;
		let error = null;
		try {
			result = scryptSync(password, salt, keylen, options);
		} catch (err) {
			error = err;
		}
		queueMicrotask(() => (error ? callback(error) : callback(null, result)));
	};

	/* ------------------------------------------------------------------- ciphers */

	const cipherSpec = (algorithm, key, iv) => {
		const name = String(algorithm).toLowerCase();
		if (!CIPHERS.includes(name)) {
			throw Object.assign(new Error("Unknown cipher"), { code: "ERR_CRYPTO_UNKNOWN_CIPHER" });
		}
		const keyBytes = bytesOf(key);
		const ivBytes = iv === null || iv === undefined ? new Uint8Array(0) : bytesOf(iv);
		const wantKey = name === "chacha20-poly1305" ? 32 : Number(name.split("-")[1]) / 8;
		if (keyBytes.length !== wantKey) throw Object.assign(new RangeError("Invalid key length"), { code: "ERR_CRYPTO_INVALID_KEYLEN" });
		const ecb = name.endsWith("-ecb");
		if (ecb ? ivBytes.length !== 0 : name.endsWith("-gcm") || name === "chacha20-poly1305" ? ivBytes.length < 1 : ivBytes.length !== 16) {
			throw Object.assign(new TypeError("Invalid initialization vector"), { code: "ERR_CRYPTO_INVALID_IV" });
		}
		return { name, keyBytes, ivBytes, aead: name.endsWith("-gcm") || name === "chacha20-poly1305" };
	};

	class Cipheriv extends stream.Transform {
		constructor(algorithm, key, iv, options, decrypt) {
			super(options);
			this._spec = cipherSpec(algorithm, key, iv);
			this._decrypt = decrypt;
			this._chunks = [];
			this._aad = null;
			this._tag = null;
			this._padding = true;
			this._finalized = false;
		}
		setAAD(aad) {
			this._aad = bytesOf(aad);
			return this;
		}
		setAutoPadding(value = true) {
			this._padding = Boolean(value);
			return this;
		}
		getAuthTag() {
			if (!this._tag) throw Object.assign(new Error("Attempting to get auth tag in unsupported state"), { code: "ERR_CRYPTO_INVALID_STATE" });
			return buf(this._tag);
		}
		setAuthTag(tag) {
			this._tag = bytesOf(tag);
			return this;
		}
		update(data, inputEncoding, outputEncoding) {
			if (this._finalized) throw Object.assign(new Error("Unsupported state"), { code: "ERR_CRYPTO_INVALID_STATE" });
			this._chunks.push(toBytes(data, inputEncoding));
			return out(new Uint8Array(0), outputEncoding);
		}
		final(outputEncoding) {
			if (this._finalized) throw Object.assign(new Error("Unsupported state"), { code: "ERR_CRYPTO_INVALID_STATE" });
			this._finalized = true;
			const { name, keyBytes, ivBytes, aead } = this._spec;
			const message = concat(this._chunks);
			if (!aead) return out(native.cipher(!this._decrypt, name, keyBytes, ivBytes, message, null, 0, this._padding), outputEncoding);
			if (!this._decrypt) {
				const sealed = native.cipher(true, name, keyBytes, ivBytes, message, this._aad, 16, true);
				this._tag = sealed.slice(sealed.length - 16);
				return out(sealed.slice(0, sealed.length - 16), outputEncoding);
			}
			if (!this._tag) throw Object.assign(new Error("Unsupported state or unable to authenticate data"), { code: "ERR_CRYPTO_INVALID_STATE" });
			return out(native.cipher(false, name, keyBytes, ivBytes, concat([message, this._tag]), this._aad, 16, true), outputEncoding);
		}
		_transform(chunk, encoding, callback) {
			this._chunks.push(toBytes(chunk, encoding === "buffer" ? undefined : encoding));
			callback();
		}
		_flush(callback) {
			try {
				this.push(this.final());
				callback();
			} catch (err) {
				callback(err);
			}
		}
	}
	const createCipheriv = (algorithm, key, iv, options) => new Cipheriv(algorithm, key, iv, options, false);
	const createDecipheriv = (algorithm, key, iv, options) => new Cipheriv(algorithm, key, iv, options, true);

	/* ---------------------------------------------------------- sign and verify */

	const pemOf = (key) => {
		if (key && typeof key === "object" && !ArrayBuffer.isView(key) && key.key !== undefined) return { pem: String(Buffer.from(bytesOf(key.key)).toString("utf8")), passphrase: key.passphrase };
		return { pem: Buffer.from(bytesOf(key)).toString("utf8"), passphrase: undefined };
	};

	class Sign extends stream.Writable {
		constructor(algorithm) {
			super();
			this._hash = hashName(algorithm);
			this._chunks = [];
		}
		update(data, encoding) {
			this._chunks.push(toBytes(data, encoding));
			return this;
		}
		_write(chunk, encoding, callback) {
			this._chunks.push(toBytes(chunk, encoding === "buffer" ? undefined : encoding));
			callback();
		}
		sign(privateKey, outputEncoding) {
			const { pem, passphrase } = pemOf(privateKey);
			return out(native.pkSign(this._hash, pem, passphrase, concat(this._chunks)), outputEncoding);
		}
	}
	class Verify extends stream.Writable {
		constructor(algorithm) {
			super();
			this._hash = hashName(algorithm);
			this._chunks = [];
		}
		update(data, encoding) {
			this._chunks.push(toBytes(data, encoding));
			return this;
		}
		_write(chunk, encoding, callback) {
			this._chunks.push(toBytes(chunk, encoding === "buffer" ? undefined : encoding));
			callback();
		}
		verify(publicKey, signature, signatureEncoding) {
			const { pem } = pemOf(publicKey);
			return native.pkVerify(this._hash, pem, concat(this._chunks), toBytes(signature, signatureEncoding));
		}
	}

	/* ------------------------------------------------------------------ key objects */

	class KeyObject {
		constructor(type, data) {
			this.type = type;
			this._keyData = data;
		}
		get symmetricKeySize() {
			return this._keyData.length;
		}
		export() {
			return buf(this._keyData);
		}
		equals(other) {
			return other instanceof KeyObject && buf(this._keyData).equals(buf(other._keyData));
		}
	}

	/* ---------------------------------------------------------------- Web Crypto */

	const subtleHash = (algorithm) => hashName(typeof algorithm === "string" ? algorithm : algorithm.name);
	const subtle = {
		async digest(algorithm, data) {
			const digest = native.hash(subtleHash(algorithm), toBytes(data));
			return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
		},
		async importKey(format, keyData, algorithm, extractable, usages) {
			if (format !== "raw") throw Object.assign(new Error("Only raw key import is supported"), { name: "NotSupportedError" });
			const name = typeof algorithm === "string" ? algorithm : algorithm.name;
			return { type: "secret", extractable, algorithm: typeof algorithm === "string" ? { name } : algorithm, usages, _keyData: toBytes(keyData) };
		},
		async exportKey(format, key) {
			if (format !== "raw" || !key.extractable) throw Object.assign(new Error("The key is not extractable"), { name: "InvalidAccessError" });
			return key._keyData.buffer.slice(key._keyData.byteOffset, key._keyData.byteOffset + key._keyData.byteLength);
		},
		async sign(algorithm, key, data) {
			if ((typeof algorithm === "string" ? algorithm : algorithm.name).toUpperCase() !== "HMAC") throw Object.assign(new Error("Only HMAC signing is supported"), { name: "NotSupportedError" });
			const mac = native.hmac(subtleHash(key.algorithm.hash), key._keyData, toBytes(data));
			return mac.buffer.slice(mac.byteOffset, mac.byteOffset + mac.byteLength);
		},
		async verify(algorithm, key, signature, data) {
			const expected = new Uint8Array(await subtle.sign(algorithm, key, data));
			const actual = toBytes(signature);
			if (expected.length !== actual.length) return false;
			let diff = 0;
			for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
			return diff === 0;
		},
		async encrypt(algorithm, key, data) {
			if (algorithm.name.toUpperCase() !== "AES-GCM") throw Object.assign(new Error("Only AES-GCM is supported"), { name: "NotSupportedError" });
			const sealed = native.cipher(true, `aes-${key._keyData.length * 8}-gcm`, key._keyData, toBytes(algorithm.iv), toBytes(data), algorithm.additionalData ? toBytes(algorithm.additionalData) : null, 16, true);
			return sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength);
		},
		async decrypt(algorithm, key, data) {
			if (algorithm.name.toUpperCase() !== "AES-GCM") throw Object.assign(new Error("Only AES-GCM is supported"), { name: "NotSupportedError" });
			let plain;
			try {
				plain = native.cipher(false, `aes-${key._keyData.length * 8}-gcm`, key._keyData, toBytes(algorithm.iv), toBytes(data), algorithm.additionalData ? toBytes(algorithm.additionalData) : null, 16, true);
			} catch {
				throw Object.assign(new Error("The operation failed for an operation-specific reason"), { name: "OperationError" });
			}
			return plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);
		},
		async deriveBits(algorithm, baseKey, length) {
			const name = algorithm.name.toUpperCase();
			let derived;
			if (name === "PBKDF2") derived = native.pbkdf2(subtleHash(algorithm.hash), baseKey._keyData, toBytes(algorithm.salt), algorithm.iterations, length / 8);
			else if (name === "HKDF") derived = native.hkdf(subtleHash(algorithm.hash), baseKey._keyData, toBytes(algorithm.salt), toBytes(algorithm.info), length / 8);
			else throw Object.assign(new Error("Unsupported derivation algorithm"), { name: "NotSupportedError" });
			return derived.buffer.slice(derived.byteOffset, derived.byteOffset + derived.byteLength);
		},
	};

	const webcrypto = { getRandomValues, randomUUID, subtle };

	/* ------------------------------------------------------------------- the module */

	const crypto = {
		createHash: (algorithm, options) => new Hash(algorithm, options),
		createHmac: (algorithm, key, options) => new Hmac(algorithm, key, options),
		hash: (algorithm, data, outputEncoding = "hex") => out(native.hash(hashName(algorithm), toBytes(data)), outputEncoding),
		randomBytes(size, callback) {
			if (!Number.isInteger(size) || size < 0) throw Object.assign(new RangeError(`The value of "size" is out of range. It must be >= 0 && <= 2147483647. Received ${size}`), { code: "ERR_OUT_OF_RANGE" });
			const bytes = buf(randomFillSync(new Uint8Array(size)));
			if (callback) {
				queueMicrotask(() => callback(null, bytes));
				return undefined;
			}
			return bytes;
		},
		randomFillSync,
		randomFill(target, offset, size, callback) {
			if (typeof offset === "function") {
				callback = offset;
				offset = 0;
				size = undefined;
			} else if (typeof size === "function") {
				callback = size;
				size = undefined;
			}
			randomFillSync(target, offset, size);
			queueMicrotask(() => callback(null, target));
		},
		randomUUID,
		randomInt,
		getRandomValues,
		pseudoRandomBytes: (size, callback) => crypto.randomBytes(size, callback),
		timingSafeEqual(a, b) {
			const left = toBytes(a);
			const right = toBytes(b);
			if (left.length !== right.length) throw Object.assign(new RangeError("Input buffers must have the same byte length"), { code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" });
			let diff = 0;
			for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
			return diff === 0;
		},
		pbkdf2,
		pbkdf2Sync,
		hkdf,
		hkdfSync,
		scrypt,
		scryptSync,
		createCipheriv,
		createDecipheriv,
		createSign: (algorithm) => new Sign(algorithm),
		createVerify: (algorithm) => new Verify(algorithm),
		sign: (algorithm, data, key) => new Sign(algorithm ?? "sha256").update(data).sign(key),
		verify: (algorithm, data, key, signature) => new Verify(algorithm ?? "sha256").update(data).verify(key, signature),
		createSecretKey: (key, encoding) => new KeyObject("secret", bytesOf(key, encoding)),
		KeyObject,
		getHashes: () => [...HASHES],
		getCiphers: () => [...CIPHERS],
		getCurves: () => ["prime256v1", "secp256r1", "secp384r1", "secp521r1", "secp256k1"],
		getFips: () => 0,
		setFips: () => {},
		createDiffieHellman: notSupported("createDiffieHellman", "key agreement is not implemented"),
		createECDH: notSupported("createECDH", "key agreement is not implemented"),
		generateKeyPairSync: notSupported("generateKeyPairSync", "key generation is not implemented"),
		generateKeyPair: notSupported("generateKeyPair", "key generation is not implemented"),
		generateKeySync: notSupported("generateKeySync", "key generation is not implemented"),
		createPrivateKey: notSupported("createPrivateKey", "key objects hold secret keys only; pass the PEM to sign() directly"),
		createPublicKey: notSupported("createPublicKey", "key objects hold secret keys only; pass the PEM to verify() directly"),
		publicEncrypt: notSupported("publicEncrypt", "RSA encryption is not implemented"),
		privateDecrypt: notSupported("privateDecrypt", "RSA encryption is not implemented"),
		constants: { RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3, RSA_PKCS1_OAEP_PADDING: 4, RSA_PKCS1_PSS_PADDING: 6, POINT_CONVERSION_COMPRESSED: 2, POINT_CONVERSION_UNCOMPRESSED: 4 },
		Hash,
		Hmac,
		Cipheriv,
		Decipheriv: Cipheriv,
		Sign,
		Verify,
		webcrypto,
		subtle,
	};
	return crypto;
}

export { createCrypto };

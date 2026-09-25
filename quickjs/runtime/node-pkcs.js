/*
 * Password-protected keys and certificates: PBES2 (PBKDF2 with AES or 3DES) and the PKCS#12 key derivation and legacy
 * ciphers (3DES, RC2, RC4), PKCS#8 encrypted private keys, the older "Proc-Type: 4,ENCRYPTED" PEM form, and PKCS#12
 * (`.pfx` / `.p12`) files. mbedTLS reads PBES2 keys itself; this is what it lacks: writing them, reading them for key
 * types it does not know, and everything about PKCS#12.
 */

import { derBits, derContext, derInt, derNull, derOctets, derOid, derSeq, join, oidText, readChildren, readTlv, tlv, toPem, unsignedBytes } from "./node-asn1.js";

const OID = {
	PBES2: "1.2.840.113549.1.5.13",
	PBKDF2: "1.2.840.113549.1.5.12",
	DES_EDE3_CBC: "1.2.840.113549.3.7",
	AES128_CBC: "2.16.840.1.101.3.4.1.2",
	AES192_CBC: "2.16.840.1.101.3.4.1.22",
	AES256_CBC: "2.16.840.1.101.3.4.1.42",
	HMAC_SHA1: "1.2.840.113549.2.7",
	HMAC_SHA224: "1.2.840.113549.2.8",
	HMAC_SHA256: "1.2.840.113549.2.9",
	HMAC_SHA384: "1.2.840.113549.2.10",
	HMAC_SHA512: "1.2.840.113549.2.11",
	P12_RC4_128: "1.2.840.113549.1.12.1.1",
	P12_RC4_40: "1.2.840.113549.1.12.1.2",
	P12_3DES: "1.2.840.113549.1.12.1.3",
	P12_2DES: "1.2.840.113549.1.12.1.4",
	P12_RC2_128: "1.2.840.113549.1.12.1.5",
	P12_RC2_40: "1.2.840.113549.1.12.1.6",
	DATA: "1.2.840.113549.1.7.1",
	ENCRYPTED_DATA: "1.2.840.113549.1.7.6",
	KEY_BAG: "1.2.840.113549.1.12.10.1.1",
	SHROUDED_KEY_BAG: "1.2.840.113549.1.12.10.1.2",
	CERT_BAG: "1.2.840.113549.1.12.10.1.3",
	X509_CERT: "1.2.840.113549.1.9.22.1",
	LOCAL_KEY_ID: "1.2.840.113549.1.9.21",
	SHA1: "1.3.14.3.2.26",
	SHA224: "2.16.840.1.101.3.4.2.4",
	SHA256: "2.16.840.1.101.3.4.2.1",
	SHA384: "2.16.840.1.101.3.4.2.2",
	SHA512: "2.16.840.1.101.3.4.2.3",
};
const HMAC_HASH = { [OID.HMAC_SHA1]: "sha1", [OID.HMAC_SHA224]: "sha224", [OID.HMAC_SHA256]: "sha256", [OID.HMAC_SHA384]: "sha384", [OID.HMAC_SHA512]: "sha512" };
const DIGEST_HASH = { [OID.SHA1]: "sha1", [OID.SHA224]: "sha224", [OID.SHA256]: "sha256", [OID.SHA384]: "sha384", [OID.SHA512]: "sha512" };
const HASH_HMAC_OID = { sha1: OID.HMAC_SHA1, sha224: OID.HMAC_SHA224, sha256: OID.HMAC_SHA256, sha384: OID.HMAC_SHA384, sha512: OID.HMAC_SHA512 };
const AES_BY_OID = { [OID.AES128_CBC]: ["aes-128-cbc", 16, 16], [OID.AES192_CBC]: ["aes-192-cbc", 24, 16], [OID.AES256_CBC]: ["aes-256-cbc", 32, 16], [OID.DES_EDE3_CBC]: ["des-ede3-cbc", 24, 8] };
const CIPHER_OID = { "aes-128-cbc": OID.AES128_CBC, "aes-192-cbc": OID.AES192_CBC, "aes-256-cbc": OID.AES256_CBC, "des-ede3-cbc": OID.DES_EDE3_CBC };
const HASH_BLOCK = { sha1: 64, sha224: 64, sha256: 64, sha384: 128, sha512: 128 };
const HASH_SIZE = { sha1: 20, sha224: 28, sha256: 32, sha384: 48, sha512: 64 };

/* RFC 2268's permutation of 0..255. */
const RC2_PI = Uint8Array.from([
	217, 120, 249, 196, 25, 221, 181, 237, 40, 233, 253, 121, 74, 160, 216, 157, 198, 126, 55, 131, 43, 118, 83, 142, 98, 76, 100, 136, 68, 139, 251, 162, 23, 154, 89, 245, 135, 179, 79, 19, 97, 69, 109, 141, 9, 129, 125, 50, 189, 143, 64, 235, 134, 183, 123, 11, 240, 149, 33, 34, 92, 107, 78, 130, 84, 214, 101, 147, 206, 96, 178, 28, 115, 86, 192, 20, 167, 140, 241, 220, 18, 117, 202, 31, 59, 190, 228, 209, 66, 61, 212, 48, 163, 60, 182, 38, 111, 191, 14, 218, 70, 105, 7, 87, 39, 242, 29, 155, 188, 148, 67, 3, 248, 17, 199, 246, 144, 239, 62, 231, 6, 195, 213, 47, 200, 102, 30, 215, 8, 232, 234, 222, 128, 82, 238, 247, 132, 170, 114, 172, 53, 77, 106, 42, 150, 26, 210, 113, 90, 21, 73, 116, 75, 159, 208, 94, 4, 24, 164, 236, 194, 224, 65, 110, 15, 81, 203, 204, 36, 145, 175, 80, 161, 244, 112, 57, 153, 124, 58, 133, 35, 184, 180, 122, 252, 2, 54, 91, 37, 85, 151, 49, 45, 93, 250, 152, 227, 138, 146, 174, 5, 223, 41, 16, 103, 108, 186, 201, 211, 0, 230, 207, 225, 158, 168, 44, 99, 22, 1, 63, 88, 226, 137, 169, 13, 56, 52, 27, 171, 51, 255, 176, 187, 72, 12, 95, 185, 177, 205, 46, 197, 243, 219, 71, 229, 165, 156, 119, 10, 166, 32, 104, 254, 127, 193, 173,
]);

const bad = (message, code = "ERR_OSSL_BAD_DECRYPT") => Object.assign(new Error(message), { code });
const badDecrypt = () => bad("error:1C800064:Provider routines::bad decrypt");

/* RC2 in CBC mode, decrypt only: the 1990s encryption of the certificates in an old .pfx. */
function rc2CbcDecrypt(key, effectiveBits, iv, data) {
	const T = key.length;
	const L = new Uint8Array(128);
	L.set(key);
	for (let i = T; i < 128; i++) L[i] = RC2_PI[(L[i - 1] + L[i - T]) & 255];
	const T8 = (effectiveBits + 7) >> 3;
	const TM = 255 % 2 ** (8 + effectiveBits - 8 * T8);
	L[128 - T8] = RC2_PI[L[128 - T8] & TM];
	for (let i = 127 - T8; i >= 0; i--) L[i] = RC2_PI[L[i + 1] ^ L[i + T8]];
	const K = new Uint16Array(64);
	for (let i = 0; i < 64; i++) K[i] = L[2 * i] | (L[2 * i + 1] << 8);
	const out = new Uint8Array(data.length);
	let previous = iv;
	const rol = (x, n) => ((x << n) | (x >>> (16 - n))) & 0xffff;
	const ror = (x, n) => ((x >>> n) | (x << (16 - n))) & 0xffff;
	for (let at = 0; at + 8 <= data.length; at += 8) {
		let r0 = data[at] | (data[at + 1] << 8);
		let r1 = data[at + 2] | (data[at + 3] << 8);
		let r2 = data[at + 4] | (data[at + 5] << 8);
		let r3 = data[at + 6] | (data[at + 7] << 8);
		let j = 63;
		for (let i = 15; i >= 0; i--) {
			r3 = (ror(r3, 5) - K[j] - (r2 & r1) - (~r2 & r0 & 0xffff)) & 0xffff;
			j--;
			r2 = (ror(r2, 3) - K[j] - (r1 & r0) - (~r1 & r3 & 0xffff)) & 0xffff;
			j--;
			r1 = (ror(r1, 2) - K[j] - (r0 & r3) - (~r0 & r2 & 0xffff)) & 0xffff;
			j--;
			r0 = (ror(r0, 1) - K[j] - (r3 & r2) - (~r3 & r1 & 0xffff)) & 0xffff;
			j--;
			if (i === 11 || i === 5) {
				r3 = (r3 - K[r2 & 63]) & 0xffff;
				r2 = (r2 - K[r1 & 63]) & 0xffff;
				r1 = (r1 - K[r0 & 63]) & 0xffff;
				r0 = (r0 - K[r3 & 63]) & 0xffff;
			}
		}
		const block = [r0 & 255, r0 >> 8, r1 & 255, r1 >> 8, r2 & 255, r2 >> 8, r3 & 255, r3 >> 8];
		for (let k = 0; k < 8; k++) out[at + k] = block[k] ^ previous[k];
		previous = data.subarray(at, at + 8);
	}
	return out;
}

function rc4(key, data) {
	const S = new Uint8Array(256);
	for (let i = 0; i < 256; i++) S[i] = i;
	let j = 0;
	for (let i = 0; i < 256; i++) {
		j = (j + S[i] + key[i % key.length]) & 255;
		[S[i], S[j]] = [S[j], S[i]];
	}
	const out = new Uint8Array(data.length);
	let a = 0;
	let b = 0;
	for (let k = 0; k < data.length; k++) {
		a = (a + 1) & 255;
		b = (b + S[a]) & 255;
		[S[a], S[b]] = [S[b], S[a]];
		out[k] = data[k] ^ S[(S[a] + S[b]) & 255];
	}
	return out;
}

const unpad = (bytes, blockSize) => {
	if (!bytes.length) throw badDecrypt();
	const pad = bytes[bytes.length - 1];
	if (pad === 0 || pad > blockSize || pad > bytes.length) throw badDecrypt();
	for (let i = 1; i <= pad; i++) if (bytes[bytes.length - i] !== pad) throw badDecrypt();
	return bytes.subarray(0, bytes.length - pad);
};

export function createPkcs({ native, Buffer }) {
	const utf8 = (text) => new Uint8Array(Buffer.from(text, "utf8"));
	const passwordBytes = (password) => (typeof password === "string" ? utf8(password) : new Uint8Array(password ?? []));
	/* PKCS#12 wants the password as a BMPString: UTF-16BE with a terminating zero character. */
	const bmpPassword = (password) => {
		const text = typeof password === "string" ? password : Buffer.from(password ?? []).toString("utf8");
		const out = new Uint8Array((text.length + 1) * 2);
		for (let i = 0; i < text.length; i++) {
			const unit = text.charCodeAt(i);
			out[2 * i] = unit >> 8;
			out[2 * i + 1] = unit & 255;
		}
		return out;
	};
	const bigOf = (bytes) => {
		let hex = "";
		for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
		return BigInt(`0x${hex || "0"}`);
	};
	const bytesOfBig = (value, size) => {
		let hex = value.toString(16);
		if (hex.length > size * 2) hex = hex.slice(hex.length - size * 2);
		return new Uint8Array(Buffer.from(hex.padStart(size * 2, "0"), "hex"));
	};

	/* RFC 7292 appendix B.2: the key, IV (id 1, 2) or MAC key (id 3) derived from a BMPString password. */
	const pkcs12Kdf = (hash, password, salt, iterations, id, length) => {
		const v = HASH_BLOCK[hash];
		const u = HASH_SIZE[hash];
		const D = new Uint8Array(v).fill(id);
		const stretch = (bytes) => {
			if (!bytes.length) return new Uint8Array(0);
			const out = new Uint8Array(v * Math.ceil(bytes.length / v));
			for (let i = 0; i < out.length; i++) out[i] = bytes[i % bytes.length];
			return out;
		};
		const I = join([stretch(salt), stretch(password)]);
		const c = Math.ceil(length / u);
		const result = new Uint8Array(c * u);
		const modulus = 1n << BigInt(8 * v);
		for (let i = 0; i < c; i++) {
			let A = new Uint8Array(native.hash(hash, join([D, I])));
			for (let round = 1; round < iterations; round++) A = new Uint8Array(native.hash(hash, A));
			result.set(A, i * u);
			if (i + 1 < c) {
				const B = new Uint8Array(v);
				for (let k = 0; k < v; k++) B[k] = A[k % u];
				const b1 = bigOf(B) + 1n;
				for (let at = 0; at < I.length; at += v) {
					I.set(bytesOfBig((bigOf(I.subarray(at, at + v)) + b1) % modulus, v), at);
				}
			}
		}
		return result.subarray(0, length);
	};

	/* ---- PBES2 (RFC 8018) */
	const parsePbes2 = (bytes, params) => {
		const [kdf, enc] = readChildren(bytes, params);
		const [kdfOid, kdfParams] = readChildren(bytes, kdf);
		if (oidText(bytes, kdfOid) !== OID.PBKDF2) throw bad("unsupported key derivation function", "ERR_OSSL_UNSUPPORTED");
		const kids = readChildren(bytes, kdfParams);
		const salt = bytes.subarray(kids[0].start, kids[0].end);
		const iterations = Number(bigOf(unsignedBytes(bytes, kids[1])));
		let prf = "sha1";
		let keyLength;
		for (const extra of kids.slice(2)) {
			if (extra.tag === 2) keyLength = Number(bigOf(unsignedBytes(bytes, extra)));
			else if (extra.tag === 0x30) prf = HMAC_HASH[oidText(bytes, readChildren(bytes, extra)[0])] ?? bad("unsupported PRF", "ERR_OSSL_UNSUPPORTED");
		}
		const [encOid, encParams] = readChildren(bytes, enc);
		const cipher = AES_BY_OID[oidText(bytes, encOid)];
		if (!cipher) throw bad("unsupported cipher", "ERR_OSSL_UNSUPPORTED");
		const iv = bytes.subarray(encParams.start, encParams.end);
		return { salt, iterations, prf, keyLength: keyLength ?? cipher[1], cipher: cipher[0], iv };
	};
	const decryptPbes2 = (bytes, params, password, data) => {
		const p = parsePbes2(bytes, params);
		const key = native.pbkdf2(p.prf, passwordBytes(password), p.salt, p.iterations, p.keyLength);
		try {
			return new Uint8Array(native.cipher(false, p.cipher, key, p.iv, data, null, 0, true));
		} catch {
			throw badDecrypt();
		}
	};

	/* ---- PKCS#12 password-based encryption of one blob */
	const decryptPkcs12Pbe = (oid, salt, iterations, password, data) => {
		const pw = bmpPassword(password);
		const attempt = (pass) => {
			switch (oid) {
				case OID.P12_3DES: {
					const key = pkcs12Kdf("sha1", pass, salt, iterations, 1, 24);
					const iv = pkcs12Kdf("sha1", pass, salt, iterations, 2, 8);
					return new Uint8Array(native.cipher(false, "des-ede3-cbc", key, iv, data, null, 0, true));
				}
				case OID.P12_2DES: {
					const key2 = pkcs12Kdf("sha1", pass, salt, iterations, 1, 16);
					const key = join([key2, key2.subarray(0, 8)]);
					const iv = pkcs12Kdf("sha1", pass, salt, iterations, 2, 8);
					return new Uint8Array(native.cipher(false, "des-ede3-cbc", key, iv, data, null, 0, true));
				}
				case OID.P12_RC2_128:
				case OID.P12_RC2_40: {
					const size = oid === OID.P12_RC2_40 ? 5 : 16;
					const key = pkcs12Kdf("sha1", pass, salt, iterations, 1, size);
					const iv = pkcs12Kdf("sha1", pass, salt, iterations, 2, 8);
					return unpad(rc2CbcDecrypt(key, size * 8, iv, data), 8);
				}
				case OID.P12_RC4_128:
				case OID.P12_RC4_40:
					return rc4(pkcs12Kdf("sha1", pass, salt, iterations, 1, oid === OID.P12_RC4_40 ? 5 : 16), data);
				default:
					throw bad(`unsupported encryption algorithm ${oid}`, "ERR_OSSL_UNSUPPORTED");
			}
		};
		try {
			return attempt(pw);
		} catch (err) {
			if (err.code === "ERR_OSSL_UNSUPPORTED") throw err;
			// An empty password is either no bytes or a lone terminator, depending on who wrote the file.
			if ((typeof password === "string" ? password : "") === "") return attempt(new Uint8Array(0));
			throw badDecrypt();
		}
	};

	/* Decrypts an AlgorithmIdentifier + ciphertext pair as found in EncryptedPrivateKeyInfo and EncryptedData. */
	const decryptWith = (bytes, algorithm, data, password) => {
		const [oidElement, params] = readChildren(bytes, algorithm);
		const oid = oidText(bytes, oidElement);
		if (oid === OID.PBES2) return decryptPbes2(bytes, params, password, data);
		const kids = readChildren(bytes, params);
		const salt = bytes.subarray(kids[0].start, kids[0].end);
		const iterations = Number(bigOf(unsignedBytes(bytes, kids[1])));
		return decryptPkcs12Pbe(oid, salt, iterations, password, data);
	};

	/* An EncryptedPrivateKeyInfo (PKCS#8) -> the PrivateKeyInfo inside. */
	const decryptPkcs8 = (der, password) => {
		if (password === undefined || password === null) throw Object.assign(new Error("Passphrase required for encrypted key"), { code: "ERR_MISSING_PASSPHRASE" });
		const top = readTlv(der, 0);
		const [algorithm, data] = readChildren(der, top);
		return decryptWith(der, algorithm, der.subarray(data.start, data.end), password);
	};

	/* PKCS#8 encryption: PBES2 with PBKDF2-HMAC-SHA256 (the default of OpenSSL 3). */
	const encryptPkcs8 = (pkcs8, password, cipherName = "aes-256-cbc", iterations = 2048, prf = "sha256") => {
		const cipher = CIPHER_OID[cipherName];
		if (!cipher) throw bad("Unknown cipher", "ERR_CRYPTO_UNKNOWN_CIPHER");
		const [, keyLength, ivLength] = AES_BY_OID[cipher];
		const salt = new Uint8Array(native.randomBytes(8));
		const iv = new Uint8Array(native.randomBytes(ivLength));
		const key = native.pbkdf2(prf, passwordBytes(password), salt, iterations, keyLength);
		const sealed = new Uint8Array(native.cipher(true, cipherName, key, iv, pkcs8, null, 0, true));
		const kdf = derSeq(derOid(OID.PBKDF2), derSeq(derOctets(salt), derInt(bytesOfBig(BigInt(iterations), 4)), derSeq(derOid(HASH_HMAC_OID[prf]), derNull())));
		const enc = derSeq(derOid(cipher), derOctets(iv));
		return derSeq(derSeq(derOid(OID.PBES2), derSeq(kdf, enc)), derOctets(sealed));
	};

	/* The traditional encrypted PEM: key = EVP_BytesToKey(MD5, passphrase, iv[0..8]). */
	const bytesToKey = (password, salt, length) => {
		let previous = new Uint8Array(0);
		let out = new Uint8Array(0);
		while (out.length < length) {
			previous = new Uint8Array(native.hash("md5", join([previous, passwordBytes(password), salt])));
			out = join([out, previous]);
		}
		return out.subarray(0, length);
	};
	const legacyPemNames = { "aes-128-cbc": "AES-128-CBC", "aes-192-cbc": "AES-192-CBC", "aes-256-cbc": "AES-256-CBC", "des-ede3-cbc": "DES-EDE3-CBC" };
	const encryptLegacyPem = (label, der, password, cipherName) => {
		const info = AES_BY_OID[CIPHER_OID[cipherName]];
		if (!info) throw bad("Unknown cipher", "ERR_CRYPTO_UNKNOWN_CIPHER");
		const iv = new Uint8Array(native.randomBytes(info[2]));
		const key = bytesToKey(password, iv.subarray(0, 8), info[1]);
		const sealed = new Uint8Array(native.cipher(true, cipherName, key, iv, der, null, 0, true));
		const b64 = Buffer.from(sealed).toString("base64");
		const lines = [];
		for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
		const ivHex = Buffer.from(iv).toString("hex").toUpperCase();
		return `-----BEGIN ${label}-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: ${legacyPemNames[cipherName]},${ivHex}\n\n${lines.join("\n")}\n-----END ${label}-----\n`;
	};

	/* ---- PKCS#12 */
	const parseBags = (bytes, safeContents, password, out) => {
		for (const bag of readChildren(bytes, safeContents)) {
			const [typeElement, valueElement, attributes] = readChildren(bytes, bag);
			const type = oidText(bytes, typeElement);
			let localKeyId = null;
			if (attributes) {
				for (const attribute of readChildren(bytes, attributes)) {
					const [attrOid, attrValues] = readChildren(bytes, attribute);
					if (oidText(bytes, attrOid) === OID.LOCAL_KEY_ID) {
						const first = readChildren(bytes, attrValues)[0];
						localKeyId = Buffer.from(bytes.subarray(first.start, first.end)).toString("hex");
					}
				}
			}
			const inner = readChildren(bytes, valueElement)[0] ?? valueElement;
			if (type === OID.SHROUDED_KEY_BAG) {
				const [algorithm, data] = readChildren(bytes, valueElement.tag === 0xa0 ? readChildren(bytes, valueElement)[0] : valueElement);
				const decrypted = decryptWith(bytes, algorithm, bytes.subarray(data.start, data.end), password);
				out.keys.push({ der: decrypted, localKeyId });
			} else if (type === OID.KEY_BAG) {
				out.keys.push({ der: bytes.slice(inner.pos, inner.next), localKeyId });
			} else if (type === OID.CERT_BAG) {
				const certBag = readChildren(bytes, readChildren(bytes, valueElement)[0]);
				if (oidText(bytes, certBag[0]) === OID.X509_CERT) {
					const octets = readChildren(bytes, certBag[1])[0];
					out.certs.push({ der: bytes.slice(octets.start, octets.end), localKeyId });
				}
			}
		}
	};
	/* Reads a .pfx / .p12 file: the private key as PKCS#8 DER and the certificates as DER, the key's own certificate first. */
	const parsePkcs12 = (bytes, password) => {
		const top = readTlv(bytes, 0);
		const kids = readChildren(bytes, top);
		if (kids.length < 2 || kids[0].tag !== 2) throw bad("error:1180006B:PKCS12 routines::not a PKCS#12 file", "ERR_OSSL_PKCS12_ERROR");
		const authSafe = kids[1];
		const [contentType, content] = readChildren(bytes, authSafe);
		if (oidText(bytes, contentType) !== OID.DATA) throw bad("unsupported PKCS#12 content type", "ERR_OSSL_UNSUPPORTED");
		const octets = readChildren(bytes, content)[0];
		const safe = octets.indefinite ? join(readChildren(bytes, octets).map((c) => bytes.subarray(c.start, c.end))) : bytes.subarray(octets.start, octets.end);
		// The MAC proves the password before anything is decrypted with it.
		if (kids[2]) {
			const [digestInfo, macSalt, macIterations] = readChildren(bytes, kids[2]);
			const [digestAlgorithm, digest] = readChildren(bytes, digestInfo);
			const hash = DIGEST_HASH[oidText(bytes, readChildren(bytes, digestAlgorithm)[0])] ?? "sha1";
			const salt = bytes.subarray(macSalt.start, macSalt.end);
			const iterations = macIterations ? Number(bigOf(unsignedBytes(bytes, macIterations))) : 1;
			const expected = bytes.subarray(digest.start, digest.end);
			const check = (pass) => {
				const key = pkcs12Kdf(hash, pass, salt, iterations, 3, HASH_SIZE[hash]);
				const mac = new Uint8Array(native.hmac(hash, key, safe));
				return mac.length === expected.length && mac.every((b, i) => b === expected[i]);
			};
			let valid = check(bmpPassword(password));
			if (!valid && (typeof password === "string" ? password : "") === "") valid = check(new Uint8Array(0));
			if (!valid) throw Object.assign(new Error("error:11800071:PKCS12 routines::mac verify failure"), { code: "ERR_OSSL_PKCS12_MAC_VERIFY_FAILURE" });
		}
		const out = { keys: [], certs: [] };
		const list = readTlv(safe, 0);
		for (const info of readChildren(safe, list)) {
			const [typeElement, wrapped] = readChildren(safe, info);
			const type = oidText(safe, typeElement);
			const body = readChildren(safe, wrapped)[0];
			if (type === OID.DATA) {
				const inner = body.indefinite ? join(readChildren(safe, body).map((c) => safe.subarray(c.start, c.end))) : safe.subarray(body.start, body.end);
				parseBags(inner, readTlv(inner, 0), password, out);
			} else if (type === OID.ENCRYPTED_DATA) {
				const [, encryptedInfo] = readChildren(safe, body);
				const [, algorithm, encrypted] = readChildren(safe, encryptedInfo);
				let data;
				if (encrypted.indefinite) data = join(readChildren(safe, encrypted).map((c) => safe.subarray(c.start, c.end)));
				else data = safe.subarray(encrypted.start, encrypted.end);
				const plain = decryptWith(safe, algorithm, data, password);
				parseBags(plain, readTlv(plain, 0), password, out);
			}
		}
		const key = out.keys[0] ?? null;
		let certs = out.certs;
		if (key && key.localKeyId) {
			const own = certs.findIndex((c) => c.localKeyId === key.localKeyId);
			if (own > 0) certs = [certs[own], ...certs.slice(0, own), ...certs.slice(own + 1)];
		}
		return { key: key ? key.der : null, certs: certs.map((c) => c.der) };
	};

	return { decryptPkcs8, encryptPkcs8, encryptLegacyPem, bytesToKey, parsePkcs12, decryptWith, pkcs12Kdf, rc2CbcDecrypt, bmpPassword };
}

void derBits;
void derContext;
void tlv;
void toPem;

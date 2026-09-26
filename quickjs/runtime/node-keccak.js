/*
 * The SHA-3 family beyond what the host's native SHAKE call covers, in JavaScript: a Keccak-f[1600] permutation (24 rounds,
 * or the 12 of TurboSHAKE and KangarooTwelve) with free choice of rate and domain-separation byte, and on it cSHAKE
 * (NIST SP 800-185), KMAC, TurboSHAKE and KangarooTwelve (RFC 9861). Lanes are kept as pairs of 32-bit words.
 * Every function takes and returns Uint8Array.
 */

const RC = [
	0x00000000, 0x00000001, 0x00000000, 0x00008082, 0x80000000, 0x0000808a, 0x80000000, 0x80008000, 0x00000000, 0x0000808b, 0x00000000, 0x80000001,
	0x80000000, 0x80008081, 0x80000000, 0x00008009, 0x00000000, 0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a,
	0x00000000, 0x8000808b, 0x80000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000, 0x00008002, 0x80000000, 0x00000080,
	0x00000000, 0x0000800a, 0x80000000, 0x8000000a, 0x80000000, 0x80008081, 0x80000000, 0x00008080, 0x00000000, 0x80000001, 0x80000000, 0x80008008,
];
/* Rotation amounts of the rho step, indexed x + 5y. */
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
/* Where the lane at x + 5y lands after rho and pi. */
const DEST = new Array(25);
for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) DEST[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);

const hi = new Int32Array(25);
const lo = new Int32Array(25);
const bh = new Int32Array(25);
const bl = new Int32Array(25);
const ch = new Int32Array(5);
const cl = new Int32Array(5);

/* The last `rounds` rounds of Keccak-f[1600] on the state held in `hi` and `lo`. */
function permuteJs(rounds) {
	for (let round = 24 - rounds; round < 24; round++) {
		for (let x = 0; x < 5; x++) {
			ch[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20];
			cl[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20];
		}
		for (let x = 0; x < 5; x++) {
			const nh = ch[(x + 1) % 5];
			const nl = cl[(x + 1) % 5];
			const dh = ch[(x + 4) % 5] ^ ((nh << 1) | (nl >>> 31));
			const dl = cl[(x + 4) % 5] ^ ((nl << 1) | (nh >>> 31));
			for (let y = 0; y < 25; y += 5) {
				hi[x + y] ^= dh;
				lo[x + y] ^= dl;
			}
		}
		for (let i = 0; i < 25; i++) {
			let h = hi[i];
			let l = lo[i];
			let n = ROT[i];
			if (n >= 32) {
				const t = h;
				h = l;
				l = t;
				n -= 32;
			}
			if (n === 0) {
				bh[DEST[i]] = h;
				bl[DEST[i]] = l;
			} else {
				bh[DEST[i]] = (h << n) | (l >>> (32 - n));
				bl[DEST[i]] = (l << n) | (h >>> (32 - n));
			}
		}
		for (let y = 0; y < 25; y += 5) {
			for (let x = 0; x < 5; x++) {
				const a = y + x;
				const b = y + ((x + 1) % 5);
				const c = y + ((x + 2) % 5);
				hi[a] = bh[a] ^ (~bh[b] & bh[c]);
				lo[a] = bl[a] ^ (~bl[b] & bl[c]);
			}
		}
		hi[0] ^= RC[round * 2];
		lo[0] ^= RC[round * 2 + 1];
	}
}

/* The native host has Keccak-f in C, on the same split state. */
const nativeKeccak = globalThis.__graak_native?.keccakPermute;
const permute = nativeKeccak ? (rounds) => nativeKeccak(hi, lo, rounds) : permuteJs;

/* Absorbs `data` with the domain-separation byte `suffix` and 10*1 padding, then squeezes `outBytes` bytes. */
function sponge(rate, rounds, suffix, data, outBytes) {
	hi.fill(0);
	lo.fill(0);
	const padded = new Uint8Array(Math.floor(data.length / rate + 1) * rate);
	padded.set(data);
	padded[data.length] ^= suffix;
	padded[padded.length - 1] ^= 0x80;
	for (let offset = 0; offset < padded.length; offset += rate) {
		for (let i = 0; i < rate; i += 8) {
			const lane = i >> 3;
			const p = offset + i;
			lo[lane] ^= padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24);
			hi[lane] ^= padded[p + 4] | (padded[p + 5] << 8) | (padded[p + 6] << 16) | (padded[p + 7] << 24);
		}
		permute(rounds);
	}
	const out = new Uint8Array(outBytes);
	for (let produced = 0; produced < outBytes; ) {
		const take = Math.min(rate, outBytes - produced);
		for (let i = 0; i < take; i++) {
			const lane = i >> 3;
			const word = (i & 4 ? hi[lane] : lo[lane]) >>> ((i & 3) * 8);
			out[produced + i] = word & 0xff;
		}
		produced += take;
		if (produced < outBytes) permute(rounds);
	}
	return out;
}

const concat = (...parts) => {
	let total = 0;
	for (const part of parts) total += part.length;
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
};

/* NIST SP 800-185 encodings. */
const bigEndian = (value) => {
	const bytes = [];
	let v = value;
	do {
		bytes.unshift(v % 256);
		v = Math.floor(v / 256);
	} while (v > 0);
	return bytes;
};
const leftEncode = (value) => {
	const bytes = bigEndian(value);
	return Uint8Array.from([bytes.length, ...bytes]);
};
const rightEncode = (value) => {
	const bytes = bigEndian(value);
	return Uint8Array.from([...bytes, bytes.length]);
};
const encodeString = (bytes) => concat(leftEncode(bytes.length * 8), bytes);
const bytepad = (bytes, width) => {
	const head = concat(leftEncode(width), bytes);
	const padded = new Uint8Array(Math.ceil(head.length / width) * width);
	padded.set(head);
	return padded;
};

const EMPTY = new Uint8Array(0);
const RATE = { 128: 168, 256: 136 };

/* Keeps the first `bits` bits of `bytes` (a whole byte count, the last byte masked to its high bits). */
export function truncateBits(bytes, bits) {
	const out = bytes.slice(0, Math.ceil(bits / 8));
	if (bits % 8) out[out.length - 1] &= (0xff << (8 - (bits % 8))) & 0xff;
	return out;
}

/** SHAKE128/256 with a chosen domain byte is the sponge itself; cSHAKE adds the function-name and customization prefix. */
export function cshake(strength, data, outBytes, functionName = EMPTY, customization = EMPTY) {
	const rate = RATE[strength];
	if (!functionName.length && !customization.length) return sponge(rate, 24, 0x1f, data, outBytes);
	const prefix = bytepad(concat(encodeString(functionName), encodeString(customization)), rate);
	return sponge(rate, 24, 0x04, concat(prefix, data), outBytes);
}

/** KMAC128/256 with the output length given in bits (it is part of what is absorbed). */
export function kmac(strength, key, data, outBits, customization = EMPTY) {
	const rate = RATE[strength];
	const input = concat(bytepad(encodeString(key), rate), data, rightEncode(outBits));
	return truncateBits(cshake(strength, input, Math.ceil(outBits / 8), Uint8Array.of(0x4b, 0x4d, 0x41, 0x43), customization), outBits);
}

/** TurboSHAKE128/256: the 12-round sponge with a domain byte D in 0x01..0x7f. */
export function turboshake(strength, data, outBytes, domain = 0x1f) {
	return sponge(RATE[strength], 12, domain, data, outBytes);
}

const lengthEncode = (value) => {
	if (value === 0) return Uint8Array.of(0);
	const bytes = bigEndian(value);
	return Uint8Array.from([...bytes, bytes.length]);
};

/** KT128/KT256 (KangarooTwelve): TurboSHAKE over the message and customization, tree-hashed in 8192-byte chunks. */
export function kangarootwelve(strength, message, outBytes, customization = EMPTY) {
	const input = concat(message, customization, lengthEncode(customization.length));
	const chunk = 8192;
	if (input.length <= chunk) return turboshake(strength, input, outBytes, 0x07);
	const chainLength = strength === 128 ? 32 : 64;
	const parts = [input.subarray(0, chunk), Uint8Array.of(3, 0, 0, 0, 0, 0, 0, 0)];
	let leaves = 0;
	for (let offset = chunk; offset < input.length; offset += chunk) {
		parts.push(turboshake(strength, input.subarray(offset, Math.min(offset + chunk, input.length)), chainLength, 0x0b));
		leaves++;
	}
	parts.push(lengthEncode(leaves), Uint8Array.of(0xff, 0xff));
	return turboshake(strength, concat(...parts), outBytes, 0x06);
}

/** What OpenSSL's KECCAK-KMAC-128/256 digests compute: the plain sponge with the cSHAKE padding byte 0x04, no key. */
export function keccakKmacDigest(strength, data, outBytes) {
	return sponge(RATE[strength], 24, 0x04, data, outBytes);
}

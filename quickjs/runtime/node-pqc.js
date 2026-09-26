/*
 * Post-quantum algorithms in pure JavaScript: ML-KEM (FIPS 203), ML-DSA (FIPS 204) and SLH-DSA (FIPS 205).
 *
 * The hashing is the host's own Keccak (SHAKE128/256, SHA3-256/512) and SHA-2 (`native.keccak`, `native.hash`,
 * `native.hmac`); the arithmetic runs on typed arrays with no BigInt in the loops (a BigInt only carries the 64-bit tree
 * index of SLH-DSA, once per layer). node-crypto2.js wraps these in KeyObject, sign/verify and encapsulate/decapsulate.
 *
 * Sizes and parameter sets are the ones Node 24 and 26 offer: ML-KEM-512/768/1024, ML-DSA-44/65/87 and the twelve
 * SLH-DSA sets (SHA2 and SHAKE, 128/192/256, s and f).
 */

const join = (...parts) => {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};
const same = (a, b) => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
};
const powmod = (base, exp, mod) => {
	let result = 1;
	base %= mod;
	while (exp > 0) {
		if (exp & 1) result = (result * base) % mod;
		base = (base * base) % mod;
		exp >>= 1;
	}
	return result;
};
const bitReverse = (x, bits) => {
	let r = 0;
	for (let i = 0; i < bits; i++) r |= ((x >> i) & 1) << (bits - 1 - i);
	return r;
};
/* Little-endian bit packing: `count` values of `bits` bits each (bits <= 24). */
const packBits = (values, bits, out, offset) => {
	let acc = 0;
	let have = 0;
	let o = offset;
	for (let i = 0; i < values.length; i++) {
		acc |= values[i] << have;
		have += bits;
		while (have >= 8) {
			out[o++] = acc & 255;
			acc >>>= 8;
			have -= 8;
		}
	}
	return o;
};
const unpackBits = (bytes, offset, count, bits, out) => {
	let acc = 0;
	let have = 0;
	let o = offset;
	const mask = (1 << bits) - 1;
	for (let i = 0; i < count; i++) {
		while (have < bits) {
			acc |= bytes[o++] << have;
			have += 8;
		}
		out[i] = acc & mask;
		acc >>>= bits;
		have -= bits;
	}
	return o;
};

/* ------------------------------------------------------------------------------------------ parameter tables */

const KEM_SETS = {
	512: { k: 2, eta1: 3, eta2: 2, du: 10, dv: 4 },
	768: { k: 3, eta1: 2, eta2: 2, du: 10, dv: 4 },
	1024: { k: 4, eta1: 2, eta2: 2, du: 11, dv: 5 },
};
const DSA_SETS = {
	44: { k: 4, l: 4, eta: 2, tau: 39, gamma1: 1 << 17, gamma2: (8380417 - 1) / 88, omega: 80, lambda: 128 },
	65: { k: 6, l: 5, eta: 4, tau: 49, gamma1: 1 << 19, gamma2: (8380417 - 1) / 32, omega: 55, lambda: 192 },
	87: { k: 8, l: 7, eta: 2, tau: 60, gamma1: 1 << 19, gamma2: (8380417 - 1) / 32, omega: 75, lambda: 256 },
};
/* [n, h, d, a, k] */
const SLH_SHAPE = {
	"128s": [16, 63, 7, 12, 14],
	"128f": [16, 66, 22, 6, 33],
	"192s": [24, 63, 7, 14, 17],
	"192f": [24, 66, 22, 8, 33],
	"256s": [32, 64, 8, 14, 22],
	"256f": [32, 68, 17, 9, 35],
};

/* name -> description of every key type: what node-crypto2.js needs to parse, size and label keys. */
const TYPES = {};
const BY_OID = {};
const BY_JWK = {};
const register = (info) => {
	TYPES[info.name] = info;
	BY_OID[info.oid] = info;
	BY_JWK[info.jwk] = info;
};
for (const bits of [512, 768, 1024]) {
	const p = KEM_SETS[bits];
	register({
		name: `ml-kem-${bits}`, jwk: `ML-KEM-${bits}`, oid: `2.16.840.1.101.3.4.4.${{ 512: 1, 768: 2, 1024: 3 }[bits]}`, kind: "kem", params: p,
		pubLen: 384 * p.k + 32, expandedLen: 768 * p.k + 96, seedLen: 64, cipherLen: 32 * (p.du * p.k + p.dv),
	});
}
for (const level of [44, 65, 87]) {
	const p = DSA_SETS[level];
	const bitlen = p.eta === 2 ? 3 : 4;
	register({
		name: `ml-dsa-${level}`, jwk: `ML-DSA-${level}`, oid: `2.16.840.1.101.3.4.3.${{ 44: 17, 65: 18, 87: 19 }[level]}`, kind: "dsa", params: p,
		pubLen: 32 + 320 * p.k, expandedLen: 128 + 32 * ((p.k + p.l) * bitlen + 13 * p.k), seedLen: 32,
		sigLen: p.lambda / 4 + 32 * p.l * (p.gamma1 === 1 << 17 ? 18 : 20) + p.omega + p.k,
	});
}
{
	let oid = 20;
	for (const family of ["sha2", "shake"]) {
		for (const size of ["128s", "128f", "192s", "192f", "256s", "256f"]) {
			const [n, h, d, a, k] = SLH_SHAPE[size];
			const hp = h / d;
			const m = Math.ceil((k * a) / 8) + Math.ceil((h - hp) / 8) + Math.ceil(hp / 8);
			const params = { n, h, d, hp, a, k, m, len: 2 * n + 3, sha2: family === "sha2", big: n > 16 };
			register({
				name: `slh-dsa-${family}-${size}`, jwk: `SLH-DSA-${family.toUpperCase()}-${size}`, oid: `2.16.840.1.101.3.4.3.${oid++}`, kind: "slh", params,
				pubLen: 2 * n, expandedLen: 4 * n, seedLen: 0, sigLen: (1 + k * (a + 1) + h + d * (2 * n + 3)) * n,
			});
		}
	}
}

/* ------------------------------------------------------------------------------------------------- factory */

export function createPqc({ native }) {
	const hash = (name, data) => native.hash(name, data);
	const shake = (bits, data, length) => native.keccak(bits, data, length);
	const random = (n) => new Uint8Array(native.randomBytes(n));

	/* ======================================================================================== ML-KEM */

	const KQ = 3329;
	let KZ;
	let KZ2;
	const kemInit = () => {
		if (KZ) return;
		KZ = new Int32Array(128);
		KZ2 = new Int32Array(128);
		for (let i = 0; i < 128; i++) {
			KZ[i] = powmod(17, bitReverse(i, 7), KQ);
			KZ2[i] = powmod(17, 2 * bitReverse(i, 7) + 1, KQ);
		}
	};
	const kNtt = (f) => {
		let i = 1;
		for (let len = 128; len >= 2; len >>= 1) {
			for (let start = 0; start < 256; start += 2 * len) {
				const z = KZ[i++];
				for (let j = start; j < start + len; j++) {
					const t = (z * f[j + len]) % KQ;
					let x = f[j] - t;
					f[j + len] = x < 0 ? x + KQ : x;
					x = f[j] + t;
					f[j] = x >= KQ ? x - KQ : x;
				}
			}
		}
	};
	const kInvNtt = (f) => {
		let i = 127;
		for (let len = 2; len <= 128; len <<= 1) {
			for (let start = 0; start < 256; start += 2 * len) {
				const z = KZ[i--];
				for (let j = start; j < start + len; j++) {
					const t = f[j];
					const x = t + f[j + len];
					f[j] = x >= KQ ? x - KQ : x;
					f[j + len] = (z * (f[j + len] - t + KQ)) % KQ;
				}
			}
		}
		for (let j = 0; j < 256; j++) f[j] = (f[j] * 3303) % KQ;
	};
	/* h += f * g in the NTT domain */
	const kMulAdd = (h, f, g) => {
		for (let i = 0; i < 128; i++) {
			const a0 = f[2 * i];
			const a1 = f[2 * i + 1];
			const b0 = g[2 * i];
			const b1 = g[2 * i + 1];
			const c0 = (a0 * b0 + ((a1 * b1) % KQ) * KZ2[i]) % KQ;
			const c1 = (a0 * b1 + a1 * b0) % KQ;
			let x = h[2 * i] + c0;
			h[2 * i] = x >= KQ ? x - KQ : x;
			x = h[2 * i + 1] + c1;
			h[2 * i + 1] = x >= KQ ? x - KQ : x;
		}
	};
	const kAdd = (f, g) => {
		for (let i = 0; i < 256; i++) {
			const x = f[i] + g[i];
			f[i] = x >= KQ ? x - KQ : x;
		}
	};
	const kSampleNtt = (seed) => {
		let length = 672;
		for (;;) {
			const b = shake(128, seed, length);
			const a = new Int32Array(256);
			let j = 0;
			for (let i = 0; i + 2 < length && j < 256; i += 3) {
				const d1 = b[i] + 256 * (b[i + 1] & 15);
				const d2 = (b[i + 1] >> 4) + 16 * b[i + 2];
				if (d1 < KQ) a[j++] = d1;
				if (d2 < KQ && j < 256) a[j++] = d2;
			}
			if (j === 256) return a;
			length *= 2;
		}
	};
	const kCbd = (bytes, eta) => {
		const f = new Int32Array(256);
		let bit = 0;
		for (let i = 0; i < 256; i++) {
			let x = 0;
			let y = 0;
			for (let j = 0; j < eta; j++, bit++) x += (bytes[bit >> 3] >> (bit & 7)) & 1;
			for (let j = 0; j < eta; j++, bit++) y += (bytes[bit >> 3] >> (bit & 7)) & 1;
			f[i] = x >= y ? x - y : x - y + KQ;
		}
		return f;
	};
	const kPrf = (seed, counter, eta) => shake(256, join(seed, Uint8Array.of(counter)), 64 * eta);
	const kMatrix = (rho, k) => {
		const A = new Array(k * k);
		const seed = new Uint8Array(34);
		seed.set(rho, 0);
		for (let i = 0; i < k; i++) {
			for (let j = 0; j < k; j++) {
				seed[32] = j;
				seed[33] = i;
				A[i * k + j] = kSampleNtt(seed);
			}
		}
		return A;
	};
	const kEncodeVec = (vec, out, offset) => {
		let o = offset;
		for (const f of vec) o = packBits(f, 12, out, o);
		return o;
	};
	const kDecodeVec = (bytes, offset, k) => {
		const vec = [];
		for (let i = 0; i < k; i++) {
			const f = new Int32Array(256);
			unpackBits(bytes, offset + 384 * i, 256, 12, f);
			vec.push(f);
		}
		return vec;
	};
	const kCompress = (x, d) => ((((x << d) + 1664) / KQ) | 0) & ((1 << d) - 1);
	const kDecompress = (y, d) => (y * KQ + (1 << (d - 1))) >> d;

	const kemKeyGen = (P, d, z) => {
		kemInit();
		const { k, eta1 } = P;
		const g = hash("sha3-512", join(d, Uint8Array.of(k)));
		const rho = g.subarray(0, 32);
		const sigma = g.subarray(32, 64);
		let counter = 0;
		const s = [];
		const e = [];
		for (let i = 0; i < k; i++) s.push(kCbd(kPrf(sigma, counter++, eta1), eta1));
		for (let i = 0; i < k; i++) e.push(kCbd(kPrf(sigma, counter++, eta1), eta1));
		for (const f of s) kNtt(f);
		for (const f of e) kNtt(f);
		const A = kMatrix(rho, k);
		const t = [];
		for (let i = 0; i < k; i++) {
			const acc = new Int32Array(256);
			for (let j = 0; j < k; j++) kMulAdd(acc, A[i * k + j], s[j]);
			kAdd(acc, e[i]);
			t.push(acc);
		}
		const ek = new Uint8Array(384 * k + 32);
		kEncodeVec(t, ek, 0);
		ek.set(rho, 384 * k);
		const dk = new Uint8Array(768 * k + 96);
		kEncodeVec(s, dk, 0);
		dk.set(ek, 384 * k);
		dk.set(hash("sha3-256", ek), 768 * k + 32);
		dk.set(z, 768 * k + 64);
		return { ek, dk };
	};
	const kemPkeEncrypt = (P, ek, m, r) => {
		const { k, eta1, eta2, du, dv } = P;
		const t = kDecodeVec(ek, 0, k);
		const A = kMatrix(ek.subarray(384 * k, 384 * k + 32), k);
		let counter = 0;
		const y = [];
		const e1 = [];
		for (let i = 0; i < k; i++) y.push(kCbd(kPrf(r, counter++, eta1), eta1));
		for (let i = 0; i < k; i++) e1.push(kCbd(kPrf(r, counter++, eta2), eta2));
		const e2 = kCbd(kPrf(r, counter, eta2), eta2);
		for (const f of y) kNtt(f);
		const out = new Uint8Array(32 * (du * k + dv));
		let o = 0;
		const packed = new Int32Array(256);
		for (let i = 0; i < k; i++) {
			const u = new Int32Array(256);
			for (let j = 0; j < k; j++) kMulAdd(u, A[j * k + i], y[j]);
			kInvNtt(u);
			kAdd(u, e1[i]);
			for (let n = 0; n < 256; n++) packed[n] = kCompress(u[n], du);
			o = packBits(packed, du, out, o);
		}
		const v = new Int32Array(256);
		for (let j = 0; j < k; j++) kMulAdd(v, t[j], y[j]);
		kInvNtt(v);
		kAdd(v, e2);
		for (let n = 0; n < 256; n++) {
			if ((m[n >> 3] >> (n & 7)) & 1) {
				const x = v[n] + 1665;
				v[n] = x >= KQ ? x - KQ : x;
			}
			packed[n] = kCompress(v[n], dv);
		}
		packBits(packed, dv, out, o);
		return out;
	};
	const kemPkeDecrypt = (P, dkPke, c) => {
		const { k, du, dv } = P;
		const s = kDecodeVec(dkPke, 0, k);
		const w = new Int32Array(256);
		for (let i = 0; i < k; i++) {
			const u = new Int32Array(256);
			unpackBits(c, 32 * du * i, 256, du, u);
			for (let n = 0; n < 256; n++) u[n] = kDecompress(u[n], du);
			kNtt(u);
			kMulAdd(w, s[i], u);
		}
		kInvNtt(w);
		const v = new Int32Array(256);
		unpackBits(c, 32 * du * k, 256, dv, v);
		const m = new Uint8Array(32);
		for (let n = 0; n < 256; n++) {
			let x = kDecompress(v[n], dv) - w[n];
			if (x < 0) x += KQ;
			m[n >> 3] |= kCompress(x, 1) << (n & 7);
		}
		return m;
	};
	const kemEncapsulate = (P, ek, m) => {
		kemInit();
		const g = hash("sha3-512", join(m, hash("sha3-256", ek)));
		return { sharedKey: g.slice(0, 32), ciphertext: kemPkeEncrypt(P, ek, m, g.subarray(32, 64)) };
	};
	const kemDecapsulate = (P, dk, c) => {
		kemInit();
		const { k } = P;
		const ek = dk.subarray(384 * k, 768 * k + 32);
		const h = dk.subarray(768 * k + 32, 768 * k + 64);
		const z = dk.subarray(768 * k + 64, 768 * k + 96);
		const m = kemPkeDecrypt(P, dk.subarray(0, 384 * k), c);
		const g = hash("sha3-512", join(m, h));
		const rejected = shake(256, join(z, c), 32);
		const again = kemPkeEncrypt(P, ek, m, g.subarray(32, 64));
		const ok = same(c, again);
		const key = new Uint8Array(32);
		const mask = ok ? 255 : 0;
		for (let i = 0; i < 32; i++) key[i] = (g[i] & mask) | (rejected[i] & ~mask);
		return key;
	};
	const kemCanonical = (bytes, offset, k) => {
		const f = new Int32Array(256);
		for (let i = 0; i < k; i++) {
			unpackBits(bytes, offset + 384 * i, 256, 12, f);
			for (let n = 0; n < 256; n++) if (f[n] >= KQ) return false;
		}
		return true;
	};

	/* ======================================================================================== ML-DSA */

	const DQ = 8380417;
	let DZ;
	const dsaInit = () => {
		if (DZ) return;
		DZ = new Int32Array(256);
		for (let i = 0; i < 256; i++) DZ[i] = powmod(1753, bitReverse(i, 8), DQ);
	};
	const dNtt = (w) => {
		let m = 0;
		for (let len = 128; len >= 1; len >>= 1) {
			for (let start = 0; start < 256; start += 2 * len) {
				const z = DZ[++m];
				for (let j = start; j < start + len; j++) {
					const t = (z * w[j + len]) % DQ;
					let x = w[j] - t;
					w[j + len] = x < 0 ? x + DQ : x;
					x = w[j] + t;
					w[j] = x >= DQ ? x - DQ : x;
				}
			}
		}
	};
	const dInvNtt = (w) => {
		let m = 256;
		for (let len = 1; len < 256; len <<= 1) {
			for (let start = 0; start < 256; start += 2 * len) {
				const z = DQ - DZ[--m];
				for (let j = start; j < start + len; j++) {
					const t = w[j];
					let x = t + w[j + len];
					w[j] = x >= DQ ? x - DQ : x;
					x = t - w[j + len];
					if (x < 0) x += DQ;
					w[j + len] = (z * x) % DQ;
				}
			}
		}
		for (let j = 0; j < 256; j++) w[j] = (w[j] * 8347681) % DQ;
	};
	const dCopyNtt = (f) => {
		const g = Int32Array.from(f);
		dNtt(g);
		return g;
	};
	/* One coefficient of a matrix-vector product: sum of up to 7 products stays below 2^53 before the one reduction. */
	const dMatVec = (A, vec, rows, cols) => {
		const out = [];
		for (let r = 0; r < rows; r++) {
			const acc = new Int32Array(256);
			for (let n = 0; n < 256; n++) {
				let sum = 0;
				for (let c = 0; c < cols; c++) sum += A[r * cols + c][n] * vec[c][n];
				acc[n] = sum % DQ;
			}
			out.push(acc);
		}
		return out;
	};
	const dExpandA = (rho, k, l) => {
		const A = new Array(k * l);
		const seed = new Uint8Array(34);
		seed.set(rho, 0);
		for (let r = 0; r < k; r++) {
			for (let s = 0; s < l; s++) {
				seed[32] = s;
				seed[33] = r;
				let length = 840;
				for (;;) {
					const b = shake(128, seed, length);
					const a = new Int32Array(256);
					let j = 0;
					for (let i = 0; i + 2 < length && j < 256; i += 3) {
						const z = b[i] + (b[i + 1] << 8) + ((b[i + 2] & 127) << 16);
						if (z < DQ) a[j++] = z;
					}
					if (j === 256) {
						A[r * l + s] = a;
						break;
					}
					length *= 2;
				}
			}
		}
		return A;
	};
	const dBounded = (seed, eta) => {
		let length = 300;
		for (;;) {
			const b = shake(256, seed, length);
			const a = new Int32Array(256);
			let j = 0;
			for (let i = 0; i < length && j < 256; i++) {
				for (let half = 0; half < 2 && j < 256; half++) {
					const z = half ? b[i] >> 4 : b[i] & 15;
					if (eta === 2) {
						if (z < 15) {
							const v = 2 - (z % 5);
							a[j++] = v < 0 ? v + DQ : v;
						}
					} else if (z < 9) {
						const v = 4 - z;
						a[j++] = v < 0 ? v + DQ : v;
					}
				}
			}
			if (j === 256) return a;
			length *= 2;
		}
	};
	const dExpandS = (rhoPrime, k, l, eta) => {
		const s1 = [];
		const s2 = [];
		const seed = new Uint8Array(66);
		seed.set(rhoPrime, 0);
		for (let r = 0; r < l; r++) {
			seed[64] = r & 255;
			seed[65] = r >> 8;
			s1.push(dBounded(seed, eta));
		}
		for (let r = 0; r < k; r++) {
			seed[64] = (r + l) & 255;
			seed[65] = (r + l) >> 8;
			s2.push(dBounded(seed, eta));
		}
		return { s1, s2 };
	};
	const HALF = (DQ - 1) / 2;
	const centered = (x) => (x > HALF ? x - DQ : x);
	/* (r1, r0) of Decompose; r0 goes to `low`. */
	let low = 0;
	const dDecompose = (rp, g2) => {
		const g22 = 2 * g2;
		let r0 = rp % g22;
		if (r0 > g2) r0 -= g22;
		if (rp - r0 === DQ - 1) {
			low = r0 - 1;
			return 0;
		}
		low = r0;
		return (rp - r0) / g22;
	};
	const dSampleInBall = (seed, tau) => {
		let length = 272;
		for (;;) {
			const s = shake(256, seed, length);
			const c = new Int32Array(256);
			let pos = 8;
			let ok = true;
			for (let i = 256 - tau; i < 256; i++) {
				let j;
				do {
					if (pos >= length) {
						ok = false;
						break;
					}
					j = s[pos++];
				} while (j > i);
				if (!ok) break;
				c[i] = c[j];
				const t = i - (256 - tau);
				c[j] = (s[t >> 3] >> (t & 7)) & 1 ? DQ - 1 : 1;
			}
			if (ok) return c;
			length *= 2;
		}
	};

	const dsaKeyGen = (P, xi) => {
		dsaInit();
		const { k, l, eta } = P;
		const h = shake(256, join(xi, Uint8Array.of(k, l)), 128);
		const rho = h.subarray(0, 32);
		const rhoPrime = h.subarray(32, 96);
		const K = h.subarray(96, 128);
		const A = dExpandA(rho, k, l);
		const { s1, s2 } = dExpandS(rhoPrime, k, l, eta);
		const s1h = s1.map(dCopyNtt);
		const t = dMatVec(A, s1h, k, l);
		const t1 = [];
		const t0 = [];
		for (let r = 0; r < k; r++) {
			dInvNtt(t[r]);
			const hi = new Int32Array(256);
			const lo = new Int32Array(256);
			for (let n = 0; n < 256; n++) {
				let v = t[r][n] + s2[r][n];
				if (v >= DQ) v -= DQ;
				let r0 = v & 8191;
				if (r0 > 4096) r0 -= 8192;
				lo[n] = r0;
				hi[n] = (v - r0) >> 13;
			}
			t1.push(hi);
			t0.push(lo);
		}
		const pk = new Uint8Array(32 + 320 * k);
		pk.set(rho, 0);
		let o = 32;
		for (const f of t1) o = packBits(f, 10, pk, o);
		const tr = shake(256, pk, 64);
		const bits = eta === 2 ? 3 : 4;
		const sk = new Uint8Array(128 + 32 * ((k + l) * bits + 13 * k));
		sk.set(rho, 0);
		sk.set(K, 32);
		sk.set(tr, 64);
		o = 128;
		const tmp = new Int32Array(256);
		for (const group of [s1, s2]) {
			for (const f of group) {
				for (let n = 0; n < 256; n++) tmp[n] = eta - centered(f[n]);
				o = packBits(tmp, bits, sk, o);
			}
		}
		for (const f of t0) {
			for (let n = 0; n < 256; n++) tmp[n] = 4096 - f[n];
			o = packBits(tmp, 13, sk, o);
		}
		return { pk, sk };
	};
	/* The parts of an expanded ML-DSA key; null when a coefficient is out of range. */
	const dsaSkDecode = (P, sk) => {
		const { k, l, eta } = P;
		const bits = eta === 2 ? 3 : 4;
		const rho = sk.subarray(0, 32);
		const K = sk.subarray(32, 64);
		const tr = sk.subarray(64, 128);
		let o = 128;
		const tmp = new Int32Array(256);
		const groups = [[], []];
		for (let g = 0; g < 2; g++) {
			for (let i = 0; i < (g ? k : l); i++) {
				o = unpackBits(sk, o, 256, bits, tmp);
				const f = new Int32Array(256);
				for (let n = 0; n < 256; n++) {
					if (tmp[n] > 2 * eta) return null;
					const v = eta - tmp[n];
					f[n] = v < 0 ? v + DQ : v;
				}
				groups[g].push(f);
			}
		}
		const t0 = [];
		for (let i = 0; i < k; i++) {
			o = unpackBits(sk, o, 256, 13, tmp);
			const f = new Int32Array(256);
			for (let n = 0; n < 256; n++) f[n] = 4096 - tmp[n];
			t0.push(f);
		}
		return { rho, K, tr, s1: groups[0], s2: groups[1], t0 };
	};
	/* t1 for a decoded secret key: the public key an expanded-only key stands for. */
	const dsaPublicOf = (P, parts) => {
		dsaInit();
		const { k, l } = P;
		const A = dExpandA(parts.rho, k, l);
		const t = dMatVec(A, parts.s1.map(dCopyNtt), k, l);
		const pk = new Uint8Array(32 + 320 * k);
		pk.set(parts.rho, 0);
		let o = 32;
		const hi = new Int32Array(256);
		for (let r = 0; r < k; r++) {
			dInvNtt(t[r]);
			for (let n = 0; n < 256; n++) {
				let v = t[r][n] + parts.s2[r][n];
				if (v >= DQ) v -= DQ;
				let r0 = v & 8191;
				if (r0 > 4096) r0 -= 8192;
				hi[n] = (v - r0) >> 13;
			}
			o = packBits(hi, 10, pk, o);
		}
		return pk;
	};
	const w1Encode = (P, w1) => {
		const bits = P.gamma2 === (DQ - 1) / 88 ? 6 : 4;
		const out = new Uint8Array(32 * P.k * bits);
		let o = 0;
		for (const f of w1) o = packBits(f, bits, out, o);
		return out;
	};
	const dsaSign = (P, sk, message, ctx, rnd) => {
		dsaInit();
		const { k, l, tau, gamma1, gamma2, omega, lambda, eta } = P;
		const beta = tau * eta;
		const parts = dsaSkDecode(P, sk);
		const mPrime = join(Uint8Array.of(0, ctx.length), ctx, message);
		const A = dExpandA(parts.rho, k, l);
		const s1h = parts.s1.map(dCopyNtt);
		const s2h = parts.s2.map(dCopyNtt);
		const t0h = parts.t0.map((f) => {
			const g = new Int32Array(256);
			for (let n = 0; n < 256; n++) g[n] = f[n] < 0 ? f[n] + DQ : f[n];
			dNtt(g);
			return g;
		});
		const mu = shake(256, join(parts.tr, mPrime), 64);
		const rhoPP = shake(256, join(parts.K, rnd, mu), 64);
		const maskBits = gamma1 === 1 << 17 ? 18 : 20;
		const cBytes = lambda / 4;
		const mask = new Int32Array(256);
		const seed = new Uint8Array(66);
		seed.set(rhoPP, 0);
		for (let kappa = 0; kappa < 60000; kappa += l) {
			const y = [];
			for (let r = 0; r < l; r++) {
				seed[64] = (kappa + r) & 255;
				seed[65] = (kappa + r) >> 8;
				const v = shake(256, seed, 32 * maskBits);
				unpackBits(v, 0, 256, maskBits, mask);
				const f = new Int32Array(256);
				for (let n = 0; n < 256; n++) {
					const x = gamma1 - mask[n];
					f[n] = x < 0 ? x + DQ : x;
				}
				y.push(f);
			}
			const w = dMatVec(A, y.map(dCopyNtt), k, l);
			for (const f of w) dInvNtt(f);
			const w1 = [];
			for (let r = 0; r < k; r++) {
				const f = new Int32Array(256);
				for (let n = 0; n < 256; n++) f[n] = dDecompose(w[r][n], gamma2);
				w1.push(f);
			}
			const cTilde = shake(256, join(mu, w1Encode(P, w1)), cBytes);
			const ch = dSampleInBall(cTilde, tau);
			dNtt(ch);
			// z = y + c*s1
			const z = [];
			let bad = false;
			for (let r = 0; r < l && !bad; r++) {
				const cs = new Int32Array(256);
				for (let n = 0; n < 256; n++) cs[n] = (ch[n] * s1h[r][n]) % DQ;
				dInvNtt(cs);
				for (let n = 0; n < 256; n++) {
					let x = y[r][n] + cs[n];
					if (x >= DQ) x -= DQ;
					const c = centered(x);
					if ((c < 0 ? -c : c) >= gamma1 - beta) {
						bad = true;
						break;
					}
					cs[n] = c;
				}
				z.push(cs);
			}
			if (bad) continue;
			// r0 = LowBits(w - c*s2), and the hint
			const wcs2 = [];
			for (let r = 0; r < k && !bad; r++) {
				const cs = new Int32Array(256);
				for (let n = 0; n < 256; n++) cs[n] = (ch[n] * s2h[r][n]) % DQ;
				dInvNtt(cs);
				for (let n = 0; n < 256; n++) {
					let x = w[r][n] - cs[n];
					if (x < 0) x += DQ;
					cs[n] = x;
					dDecompose(x, gamma2);
					if ((low < 0 ? -low : low) >= gamma2 - beta) {
						bad = true;
						break;
					}
				}
				wcs2.push(cs);
			}
			if (bad) continue;
			const hint = new Uint8Array(omega + k);
			let count = 0;
			for (let r = 0; r < k && !bad; r++) {
				const ct = new Int32Array(256);
				for (let n = 0; n < 256; n++) ct[n] = (ch[n] * t0h[r][n]) % DQ;
				dInvNtt(ct);
				for (let n = 0; n < 256; n++) {
					const c = centered(ct[n]);
					if ((c < 0 ? -c : c) >= gamma2) {
						bad = true;
						break;
					}
					let x = wcs2[r][n] + ct[n];
					if (x >= DQ) x -= DQ;
					const r1a = dDecompose(x, gamma2);
					const r1b = dDecompose(wcs2[r][n], gamma2);
					if (r1a !== r1b) {
						if (count >= omega) {
							bad = true;
							break;
						}
						hint[count++] = n;
					}
				}
				hint[omega + r] = count;
			}
			if (bad) continue;
			const sig = new Uint8Array(cBytes + 32 * l * maskBits + omega + k);
			sig.set(cTilde, 0);
			let o = cBytes;
			const tmp = new Int32Array(256);
			for (let r = 0; r < l; r++) {
				for (let n = 0; n < 256; n++) tmp[n] = gamma1 - z[r][n];
				o = packBits(tmp, maskBits, sig, o);
			}
			sig.set(hint, o);
			return sig;
		}
		throw new Error("ML-DSA signing did not converge");
	};
	const dsaVerify = (P, pk, message, sig, ctx) => {
		dsaInit();
		const { k, l, tau, gamma1, gamma2, omega, lambda, eta } = P;
		const beta = tau * eta;
		const maskBits = gamma1 === 1 << 17 ? 18 : 20;
		const cBytes = lambda / 4;
		const rho = pk.subarray(0, 32);
		const tmp = new Int32Array(256);
		const z = [];
		let o = cBytes;
		for (let r = 0; r < l; r++) {
			o = unpackBits(sig, o, 256, maskBits, tmp);
			const f = new Int32Array(256);
			for (let n = 0; n < 256; n++) {
				const c = gamma1 - tmp[n];
				if ((c < 0 ? -c : c) >= gamma1 - beta) return false;
				f[n] = c < 0 ? c + DQ : c;
			}
			z.push(f);
		}
		// the hint
		const hint = [];
		let index = 0;
		for (let r = 0; r < k; r++) {
			const h = new Uint8Array(256);
			const end = sig[o + omega + r];
			if (end < index || end > omega) return false;
			const first = index;
			while (index < end) {
				if (index > first && sig[o + index - 1] >= sig[o + index]) return false;
				h[sig[o + index]] = 1;
				index++;
			}
			hint.push(h);
		}
		for (let i = index; i < omega; i++) if (sig[o + i] !== 0) return false;
		const A = dExpandA(rho, k, l);
		const tr = shake(256, pk, 64);
		const mu = shake(256, join(tr, Uint8Array.of(0, ctx.length), ctx, message), 64);
		const ch = dSampleInBall(sig.subarray(0, cBytes), tau);
		dNtt(ch);
		const zh = z.map(dCopyNtt);
		const az = dMatVec(A, zh, k, l);
		const w1 = [];
		const t1 = new Int32Array(256);
		let po = 32;
		for (let r = 0; r < k; r++) {
			po = unpackBits(pk, po, 256, 10, t1);
			for (let n = 0; n < 256; n++) t1[n] <<= 13;
			dNtt(t1);
			const f = az[r];
			for (let n = 0; n < 256; n++) {
				let x = f[n] - ((ch[n] * t1[n]) % DQ);
				if (x < 0) x += DQ;
				f[n] = x;
			}
			dInvNtt(f);
			const g = new Int32Array(256);
			const m = (DQ - 1) / (2 * gamma2);
			for (let n = 0; n < 256; n++) {
				const r1 = dDecompose(f[n], gamma2);
				if (hint[r][n]) g[n] = low > 0 ? (r1 + 1) % m : (r1 - 1 + m) % m;
				else g[n] = r1;
			}
			w1.push(g);
		}
		const expected = shake(256, join(mu, w1Encode(P, w1)), cBytes);
		return same(expected, sig.subarray(0, cBytes));
	};

	/* ======================================================================================= SLH-DSA */

	const WOTS_HASH = 0;
	const WOTS_PK = 1;
	const TREE = 2;
	const FORS_TREE = 3;
	const FORS_ROOTS = 4;
	const WOTS_PRF = 5;
	const FORS_PRF = 6;

	/* The tweakable hash functions of one key: F, H, T_l and PRF over an ADRS, for the SHA2 or the SHAKE family. */
	const slhHasher = (ps, pkSeed) => {
		const { n, sha2, big } = ps;
		const tBufs = new Map();
		if (sha2) {
			const pad2 = big ? 128 : 64;
			const compress = (buf, at, A) => {
				buf[at] = A[3];
				for (let i = 0; i < 8; i++) buf[at + 1 + i] = A[8 + i];
				buf[at + 9] = A[19];
				for (let i = 0; i < 12; i++) buf[at + 10 + i] = A[20 + i];
			};
			const bufF = new Uint8Array(64 + 22 + n);
			bufF.set(pkSeed, 0);
			const bufP = new Uint8Array(64 + 22 + n);
			bufP.set(pkSeed, 0);
			const bufH = new Uint8Array(pad2 + 22 + 2 * n);
			bufH.set(pkSeed, 0);
			const hName = big ? "sha512" : "sha256";
			return {
				F(A, m) {
					compress(bufF, 64, A);
					bufF.set(m, 86);
					return hash("sha256", bufF).subarray(0, n);
				},
				PRF(A, skSeed) {
					compress(bufP, 64, A);
					bufP.set(skSeed, 86);
					return hash("sha256", bufP).subarray(0, n);
				},
				H(A, left, right) {
					compress(bufH, pad2, A);
					bufH.set(left, pad2 + 22);
					bufH.set(right, pad2 + 22 + n);
					return hash(hName, bufH).subarray(0, n);
				},
				T(A, list) {
					let buf = tBufs.get(list.length);
					if (!buf) {
						buf = new Uint8Array(pad2 + 22 + list.length * n);
						buf.set(pkSeed, 0);
						tBufs.set(list.length, buf);
					}
					compress(buf, pad2, A);
					for (let i = 0; i < list.length; i++) buf.set(list[i], pad2 + 22 + i * n);
					return hash(hName, buf).subarray(0, n);
				},
			};
		}
		const bufF = new Uint8Array(n + 32 + n);
		bufF.set(pkSeed, 0);
		const bufH = new Uint8Array(n + 32 + 2 * n);
		bufH.set(pkSeed, 0);
		return {
			F(A, m) {
				bufF.set(A, n);
				bufF.set(m, n + 32);
				return shake(256, bufF, n);
			},
			PRF(A, skSeed) {
				bufF.set(A, n);
				bufF.set(skSeed, n + 32);
				return shake(256, bufF, n);
			},
			H(A, left, right) {
				bufH.set(A, n);
				bufH.set(left, n + 32);
				bufH.set(right, n + 32 + n);
				return shake(256, bufH, n);
			},
			T(A, list) {
				let buf = tBufs.get(list.length);
				if (!buf) {
					buf = new Uint8Array(n + 32 + list.length * n);
					buf.set(pkSeed, 0);
					tBufs.set(list.length, buf);
				}
				buf.set(A, n);
				for (let i = 0; i < list.length; i++) buf.set(list[i], n + 32 + i * n);
				return shake(256, buf, n);
			},
		};
	};
	const mgf1 = (name, seed, length) => {
		const parts = [];
		let have = 0;
		for (let counter = 0; have < length; counter++) {
			const block = hash(name, join(seed, Uint8Array.of(counter >>> 24, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255)));
			parts.push(block);
			have += block.length;
		}
		return join(...parts).subarray(0, length);
	};

	const baseB = (bytes, bits, count) => {
		const out = new Int32Array(count);
		let at = 0;
		let acc = 0;
		let have = 0;
		for (let i = 0; i < count; i++) {
			while (have < bits) {
				acc = ((acc << 8) | bytes[at++]) >>> 0;
				have += 8;
			}
			have -= bits;
			out[i] = (acc >>> have) & ((1 << bits) - 1);
			acc &= (1 << have) - 1;
		}
		return out;
	};

	/* The full scheme for one parameter set. */
	const slhScheme = (ps) => {
		const { n, h, d, hp, a, k, m, len } = ps;
		const A = new Uint8Array(32);
		const setWord = (at, v) => {
			A[at] = v >>> 24;
			A[at + 1] = (v >>> 16) & 255;
			A[at + 2] = (v >>> 8) & 255;
			A[at + 3] = v & 255;
		};
		const setLayer = (l) => {
			A[3] = l;
		};
		const setTree = (t) => {
			const hi = Number(t >> 32n);
			const lo = Number(t & 0xffffffffn);
			setWord(4, 0);
			setWord(8, hi);
			setWord(12, lo);
		};
		const setType = (t) => {
			A[19] = t;
			A.fill(0, 20, 32);
		};
		const setKeyPair = (v) => setWord(20, v);
		const setChain = (v) => setWord(24, v);
		const setHash = (v) => setWord(28, v);

		const chain = (H, x, start, steps) => {
			let tmp = x;
			for (let j = start; j < start + steps; j++) {
				setHash(j);
				tmp = H.F(A, tmp);
			}
			return tmp;
		};
		const wotsSk = (H, skSeed, kp, i) => {
			setType(WOTS_PRF);
			setKeyPair(kp);
			setChain(i);
			return H.PRF(A, skSeed);
		};
		const wotsPkGen = (H, skSeed, kp) => {
			const tmp = new Array(len);
			for (let i = 0; i < len; i++) {
				const sk = wotsSk(H, skSeed, kp, i);
				setType(WOTS_HASH);
				setKeyPair(kp);
				setChain(i);
				tmp[i] = chain(H, sk, 0, 15);
			}
			setType(WOTS_PK);
			setKeyPair(kp);
			return H.T(A, tmp);
		};
		const wotsDigits = (msg) => {
			const digits = baseB(msg, 4, 2 * n);
			let csum = 0;
			for (let i = 0; i < 2 * n; i++) csum += 15 - digits[i];
			csum <<= 4;
			const all = new Int32Array(len);
			all.set(digits, 0);
			all[2 * n] = (csum >> 12) & 15;
			all[2 * n + 1] = (csum >> 8) & 15;
			all[2 * n + 2] = (csum >> 4) & 15;
			return all;
		};
		const wotsSign = (H, msg, skSeed, kp) => {
			const digits = wotsDigits(msg);
			const out = new Array(len);
			for (let i = 0; i < len; i++) {
				const sk = wotsSk(H, skSeed, kp, i);
				setType(WOTS_HASH);
				setKeyPair(kp);
				setChain(i);
				out[i] = chain(H, sk, 0, digits[i]);
			}
			return out;
		};
		const wotsPkFromSig = (H, sig, msg, kp) => {
			const digits = wotsDigits(msg);
			const tmp = new Array(len);
			setType(WOTS_HASH);
			setKeyPair(kp);
			for (let i = 0; i < len; i++) {
				setChain(i);
				tmp[i] = chain(H, sig[i], digits[i], 15 - digits[i]);
			}
			setType(WOTS_PK);
			setKeyPair(kp);
			return H.T(A, tmp);
		};
		/* All levels of the XMSS tree at the current layer and tree address. */
		const xmssLevels = (H, skSeed) => {
			const levels = [];
			let row = new Array(1 << hp);
			for (let i = 0; i < 1 << hp; i++) row[i] = wotsPkGen(H, skSeed, i);
			levels.push(row);
			for (let z = 1; z <= hp; z++) {
				const next = new Array(row.length >> 1);
				for (let i = 0; i < next.length; i++) {
					setType(TREE);
					setWord(24, z);
					setWord(28, i);
					next[i] = H.H(A, row[2 * i], row[2 * i + 1]);
				}
				levels.push(next);
				row = next;
			}
			return levels;
		};
		const xmssPkFromSig = (H, idx, wots, auth, msg) => {
			let node = wotsPkFromSig(H, wots, msg, idx);
			setType(TREE);
			let index = idx;
			for (let j = 0; j < hp; j++) {
				setWord(24, j + 1);
				setWord(28, index >> 1);
				node = (index & 1) === 0 ? H.H(A, node, auth[j]) : H.H(A, auth[j], node);
				index >>= 1;
			}
			return node;
		};
		const htSign = (H, msg, skSeed, idxTree, idxLeaf) => {
			const parts = [];
			let node = msg;
			let leaf = idxLeaf;
			let tree = idxTree;
			for (let j = 0; j < d; j++) {
				setLayer(j);
				setTree(tree);
				const levels = xmssLevels(H, skSeed);
				setLayer(j);
				setTree(tree);
				const wots = wotsSign(H, node, skSeed, leaf);
				const auth = [];
				for (let z = 0; z < hp; z++) auth.push(levels[z][(leaf >> z) ^ 1]);
				parts.push(...wots, ...auth);
				node = levels[hp][0];
				leaf = Number(tree & BigInt((1 << hp) - 1));
				tree >>= BigInt(hp);
			}
			return parts;
		};
		const htVerify = (H, msg, sig, at, idxTree, idxLeaf, root) => {
			let node = msg;
			let leaf = idxLeaf;
			let tree = idxTree;
			for (let j = 0; j < d; j++) {
				setLayer(j);
				setTree(tree);
				const wots = [];
				for (let i = 0; i < len; i++) wots.push(sig.subarray(at + i * n, at + (i + 1) * n));
				const auth = [];
				for (let z = 0; z < hp; z++) auth.push(sig.subarray(at + (len + z) * n, at + (len + z + 1) * n));
				at += (len + hp) * n;
				node = xmssPkFromSig(H, leaf, wots, auth, node);
				leaf = Number(tree & BigInt((1 << hp) - 1));
				tree >>= BigInt(hp);
			}
			return same(node, root);
		};
		/* FORS */
		const forsSk = (H, skSeed, kp, idx) => {
			setType(FORS_PRF);
			setKeyPair(kp);
			setWord(28, idx);
			return H.PRF(A, skSeed);
		};
		const forsLeaf = (H, skSeed, kp, idx) => {
			const sk = forsSk(H, skSeed, kp, idx);
			setType(FORS_TREE);
			setKeyPair(kp);
			setWord(24, 0);
			setWord(28, idx);
			return H.F(A, sk);
		};
		/* The tree i of the FORS key: every level, so the root and any auth path come from one pass. */
		const forsTree = (H, skSeed, kp, i) => {
			const size = 1 << a;
			let row = new Array(size);
			for (let j = 0; j < size; j++) row[j] = forsLeaf(H, skSeed, kp, i * size + j);
			const levels = [row];
			for (let z = 1; z <= a; z++) {
				const next = new Array(row.length >> 1);
				const base = i * (size >> z);
				for (let j = 0; j < next.length; j++) {
					setType(FORS_TREE);
					setKeyPair(kp);
					setWord(24, z);
					setWord(28, base + j);
					next[j] = H.H(A, row[2 * j], row[2 * j + 1]);
				}
				levels.push(next);
				row = next;
			}
			return levels;
		};
		const forsPkFromSig = (H, sig, md, kp) => {
			const indices = baseB(md, a, k);
			const roots = new Array(k);
			let at = 0;
			for (let i = 0; i < k; i++) {
				const sk = sig.subarray(at, at + n);
				at += n;
				setType(FORS_TREE);
				setKeyPair(kp);
				setWord(24, 0);
				let index = i * (1 << a) + indices[i];
				setWord(28, index);
				let node = H.F(A, sk);
				for (let j = 0; j < a; j++) {
					const auth = sig.subarray(at + j * n, at + (j + 1) * n);
					setWord(24, j + 1);
					setWord(28, index >> 1);
					node = (index & 1) === 0 ? H.H(A, node, auth) : H.H(A, auth, node);
					index >>= 1;
				}
				at += a * n;
				roots[i] = node;
			}
			setType(FORS_ROOTS);
			setKeyPair(kp);
			return H.T(A, roots);
		};
		const splitDigest = (digest) => {
			const mdLen = Math.ceil((k * a) / 8);
			const treeLen = Math.ceil((h - hp) / 8);
			const leafLen = Math.ceil(hp / 8);
			const md = digest.subarray(0, mdLen);
			let tree = 0n;
			for (let i = 0; i < treeLen; i++) tree = (tree << 8n) | BigInt(digest[mdLen + i]);
			tree &= (1n << BigInt(h - hp)) - 1n;
			let leaf = 0;
			for (let i = 0; i < leafLen; i++) leaf = leaf * 256 + digest[mdLen + treeLen + i];
			leaf %= 1 << hp;
			return { md, tree, leaf };
		};
		const hMsg = (r, pkSeed, pkRoot, message) => {
			if (!ps.sha2) return shake(256, join(r, pkSeed, pkRoot, message), m);
			const name = ps.big ? "sha512" : "sha256";
			const inner = hash(name, join(r, pkSeed, pkRoot, message));
			return mgf1(name, join(r, pkSeed, inner), m);
		};
		const prfMsg = (skPrf, optRand, message) => {
			if (!ps.sha2) return shake(256, join(skPrf, optRand, message), n);
			return new Uint8Array(native.hmac(ps.big ? "sha512" : "sha256", skPrf, join(optRand, message))).subarray(0, n);
		};

		return {
			keyGen(skSeed, skPrf, pkSeed) {
				const H = slhHasher(ps, pkSeed);
				A.fill(0);
				setLayer(d - 1);
				setTree(0n);
				const levels = xmssLevels(H, skSeed);
				return join(skSeed, skPrf, pkSeed, levels[hp][0]);
			},
			sign(sk, message, ctx, optRand) {
				const skSeed = sk.subarray(0, n);
				const skPrf = sk.subarray(n, 2 * n);
				const pkSeed = sk.subarray(2 * n, 3 * n);
				const pkRoot = sk.subarray(3 * n, 4 * n);
				const H = slhHasher(ps, pkSeed);
				const mPrime = join(Uint8Array.of(0, ctx.length), ctx, message);
				const r = prfMsg(skPrf, optRand ?? pkSeed, mPrime);
				const { md, tree, leaf } = splitDigest(hMsg(r, pkSeed, pkRoot, mPrime));
				const indices = baseB(md, a, k);
				A.fill(0);
				setLayer(0);
				setTree(tree);
				const parts = [r];
				const roots = new Array(k);
				for (let i = 0; i < k; i++) {
					const levels = forsTree(H, skSeed, leaf, i);
					parts.push(forsSk(H, skSeed, leaf, i * (1 << a) + indices[i]));
					for (let z = 0; z < a; z++) parts.push(levels[z][(indices[i] >> z) ^ 1]);
					roots[i] = levels[a][0];
				}
				A.fill(0);
				setLayer(0);
				setTree(tree);
				setType(FORS_ROOTS);
				setKeyPair(leaf);
				const forsPk = H.T(A, roots);
				parts.push(...htSign(H, forsPk, skSeed, tree, leaf));
				return join(...parts);
			},
			verify(pub, message, sig, ctx) {
				const pkSeed = pub.subarray(0, n);
				const pkRoot = pub.subarray(n, 2 * n);
				const H = slhHasher(ps, pkSeed);
				const mPrime = join(Uint8Array.of(0, ctx.length), ctx, message);
				const r = sig.subarray(0, n);
				const { md, tree, leaf } = splitDigest(hMsg(r, pkSeed, pkRoot, mPrime));
				A.fill(0);
				setLayer(0);
				setTree(tree);
				const forsLen = k * (a + 1) * n;
				const forsPk = forsPkFromSig(H, sig.subarray(n, n + forsLen), md, leaf);
				return htVerify(H, forsPk, sig, n + forsLen, tree, leaf, pkRoot);
			},
		};
	};
	const slhSchemes = new Map();
	const slhFor = (type) => {
		let scheme = slhSchemes.get(type.name);
		if (!scheme) {
			scheme = slhScheme(type.params);
			slhSchemes.set(type.name, scheme);
		}
		return scheme;
	};

	/* ============================================================================================ API */

	/* With the C implementations built into the host (fg_pqc.c) the operations on secret keys run in them, in constant time;
	 * the JavaScript above is the fallback for a host built without them. */
	const fast = typeof native.pqcKemKeypair === "function";
	const level = (type) => Number(type.name.slice(type.name.lastIndexOf("-") + 1));

	/* A private key from its parts: { type, seed?, expanded, pub }. */
	const fromSeed = (type, seed) => {
		if (fast && type.kind === "kem") {
			const r = native.pqcKemKeypair(level(type), Uint8Array.from(seed.subarray(0, 64)));
			return { type, seed: Uint8Array.from(seed), expanded: r.slice(type.pubLen), pub: r.slice(0, type.pubLen) };
		}
		if (fast && type.kind === "dsa") {
			const r = native.pqcDsaKeypair(level(type), Uint8Array.from(seed.subarray(0, 32)));
			return { type, seed: Uint8Array.from(seed), expanded: r.slice(type.pubLen), pub: r.slice(0, type.pubLen) };
		}
		if (type.kind === "kem") {
			const { ek, dk } = kemKeyGen(type.params, seed.subarray(0, 32), seed.subarray(32, 64));
			return { type, seed: Uint8Array.from(seed), expanded: dk, pub: ek };
		}
		const { pk, sk } = dsaKeyGen(type.params, seed);
		return { type, seed: Uint8Array.from(seed), expanded: sk, pub: pk };
	};
	/* An expanded key with no seed; null when it is malformed. */
	const fromExpanded = (type, expanded) => {
		if (expanded.length !== type.expandedLen) return null;
		if (type.kind === "kem") {
			kemInit();
			const k = type.params.k;
			if (!kemCanonical(expanded, 0, k) || !kemCanonical(expanded, 384 * k, k)) return null;
			const ek = expanded.slice(384 * k, 768 * k + 32);
			if (!same(hash("sha3-256", ek), expanded.subarray(768 * k + 32, 768 * k + 64))) return null;
			return { type, seed: undefined, expanded: Uint8Array.from(expanded), pub: ek };
		}
		if (type.kind === "dsa") {
			const parts = dsaSkDecode(type.params, expanded);
			if (!parts) return null;
			return { type, seed: undefined, expanded: Uint8Array.from(expanded), pub: dsaPublicOf(type.params, parts) };
		}
		return { type, seed: undefined, expanded: Uint8Array.from(expanded), pub: expanded.slice(2 * type.params.n) };
	};
	const generate = (type) => {
		if (type.kind === "slh") {
			const n = type.params.n;
			const sk = fast ? native.pqcSlhKeypair(type.name, random(n), random(n), random(n)) : slhFor(type).keyGen(random(n), random(n), random(n));
			return { type, seed: undefined, expanded: sk, pub: sk.slice(2 * n) };
		}
		return fromSeed(type, random(type.seedLen));
	};
	const publicOk = (type, pub) => {
		if (pub.length !== type.pubLen) return false;
		if (type.kind === "kem") {
			kemInit();
			return kemCanonical(pub, 0, type.params.k);
		}
		return true;
	};

	return {
		types: TYPES,
		byOid: BY_OID,
		byJwk: BY_JWK,
		generate,
		fromSeed,
		fromExpanded,
		publicOk,
		/* ML-KEM */
		encapsulate: (type, pub) => {
			if (!fast) return kemEncapsulate(type.params, pub, random(32));
			const r = native.pqcKemEnc(level(type), pub, random(32));
			return { sharedKey: r.slice(type.cipherLen), ciphertext: r.slice(0, type.cipherLen) };
		},
		decapsulate: (type, expanded, ciphertext) => {
			if (ciphertext.length !== type.cipherLen) return null;
			return fast ? native.pqcKemDec(level(type), ciphertext, expanded) : kemDecapsulate(type.params, expanded, ciphertext);
		},
		/* ML-DSA and SLH-DSA; the context is at most 255 bytes, checked by the caller. */
		sign: (type, expanded, message, ctx) => {
			if (fast) {
				const rnd = random(type.kind === "dsa" ? 32 : type.params.n);
				const signature = type.kind === "dsa" ? native.pqcDsaSign(level(type), expanded, message, ctx, rnd) : native.pqcSlhSign(type.name, expanded, message, ctx, rnd);
				if (!signature) throw new Error("signing failed");
				return signature;
			}
			if (type.kind === "dsa") return dsaSign(type.params, expanded, message, ctx, random(32));
			return slhFor(type).sign(expanded, message, ctx, random(type.params.n));
		},
		verify: (type, pub, message, signature, ctx) => {
			if (signature.length !== type.sigLen) return false;
			if (fast) return type.kind === "dsa" ? native.pqcDsaVerify(level(type), pub, message, ctx, signature) : native.pqcSlhVerify(type.name, pub, message, ctx, signature);
			if (type.kind === "dsa") return dsaVerify(type.params, pub, message, signature, ctx);
			return slhFor(type).verify(pub, message, signature, ctx);
		},
	};
}

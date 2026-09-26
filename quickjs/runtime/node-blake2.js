/*
 * BLAKE2b and BLAKE2s (RFC 7693) in JavaScript for the `crypto` module: incremental hashing with copy(), HMAC, PBKDF2 and
 * HKDF over them, and the variable-length BLAKE2b that Argon2 (node-argon2.js) builds on. BLAKE2s runs on 32-bit words;
 * BLAKE2b keeps each 64-bit lane as a low and a high 32-bit word in a Uint32Array, so no BigInt is used in the hot loops.
 */

/* The eight IV words of BLAKE2b as [low, high] pairs; BLAKE2s uses the high words. */
const IV_B = new Uint32Array([
	0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
	0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);
const IV_S = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const SIGMA = new Uint8Array([
	0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
	14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
	11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
	7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
	9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
	2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
	12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
	13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
	6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
	10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
]);

/* The native host compresses a block in C; the JavaScript below is what runs where the host has no such call. */
const nativeLayer = globalThis.__graak_native;
let compressBlockB;
let compressBlockS;

/* ------------------------------------------------------------------------------------------- BLAKE2b */

const mb = new Uint32Array(32);

/* The compression function. The sixteen lanes live in local variables (low and high word each) and the eight mixing steps
 * of a round are written out in place, which is what keeps this fast on an interpreter; each step is BLAKE2b's G with the
 * 64-bit additions and rotations done on the two halves. */
function compressB(h, block, offset, tLo, tHi, last) {
	for (let i = 0, j = offset; i < 32; i++, j += 4) mb[i] = block[j] | (block[j + 1] << 8) | (block[j + 2] << 16) | (block[j + 3] << 24);
	let v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h, v8l, v8h, v9l, v9h, v10l, v10h, v11l, v11h, v12l, v12h, v13l, v13h, v14l, v14h, v15l, v15h;
	let t;
	let u;
	let xi;
	let yi;
	v0l = h[0];
	v0h = h[1];
	v8l = IV_B[0];
	v8h = IV_B[1];
	v1l = h[2];
	v1h = h[3];
	v9l = IV_B[2];
	v9h = IV_B[3];
	v2l = h[4];
	v2h = h[5];
	v10l = IV_B[4];
	v10h = IV_B[5];
	v3l = h[6];
	v3h = h[7];
	v11l = IV_B[6];
	v11h = IV_B[7];
	v4l = h[8];
	v4h = h[9];
	v12l = IV_B[8];
	v12h = IV_B[9];
	v5l = h[10];
	v5h = h[11];
	v13l = IV_B[10];
	v13h = IV_B[11];
	v6l = h[12];
	v6h = h[13];
	v14l = IV_B[12];
	v14h = IV_B[13];
	v7l = h[14];
	v7h = h[15];
	v15l = IV_B[14];
	v15h = IV_B[15];
	v12l = (v12l ^ tLo) >>> 0;
	v12h = (v12h ^ tHi) >>> 0;
	if (last) {
		v14l = ~v14l >>> 0;
		v14h = ~v14h >>> 0;
	}
	for (let r = 0; r < 12; r++) {
		const s = (r % 10) * 16;
		xi = SIGMA[s + 0] << 1;
		yi = SIGMA[s + 1] << 1;
		t = v0l + v4l + mb[xi];
		v0h = (v0h + v4h + mb[xi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v0l = t >>> 0;
		t = (v12h ^ v0h) >>> 0;
		v12h = (v12l ^ v0l) >>> 0;
		v12l = t;
		t = v8l + v12l;
		v8h = (v8h + v12h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v8l = t >>> 0;
		t = v4l ^ v8l;
		u = v4h ^ v8h;
		v4l = ((t >>> 24) | (u << 8)) >>> 0;
		v4h = ((u >>> 24) | (t << 8)) >>> 0;
		t = v0l + v4l + mb[yi];
		v0h = (v0h + v4h + mb[yi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v0l = t >>> 0;
		t = v12l ^ v0l;
		u = v12h ^ v0h;
		v12l = ((t >>> 16) | (u << 16)) >>> 0;
		v12h = ((u >>> 16) | (t << 16)) >>> 0;
		t = v8l + v12l;
		v8h = (v8h + v12h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v8l = t >>> 0;
		t = v4l ^ v8l;
		u = v4h ^ v8h;
		v4l = ((t << 1) | (u >>> 31)) >>> 0;
		v4h = ((u << 1) | (t >>> 31)) >>> 0;
		xi = SIGMA[s + 2] << 1;
		yi = SIGMA[s + 3] << 1;
		t = v1l + v5l + mb[xi];
		v1h = (v1h + v5h + mb[xi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v1l = t >>> 0;
		t = (v13h ^ v1h) >>> 0;
		v13h = (v13l ^ v1l) >>> 0;
		v13l = t;
		t = v9l + v13l;
		v9h = (v9h + v13h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v9l = t >>> 0;
		t = v5l ^ v9l;
		u = v5h ^ v9h;
		v5l = ((t >>> 24) | (u << 8)) >>> 0;
		v5h = ((u >>> 24) | (t << 8)) >>> 0;
		t = v1l + v5l + mb[yi];
		v1h = (v1h + v5h + mb[yi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v1l = t >>> 0;
		t = v13l ^ v1l;
		u = v13h ^ v1h;
		v13l = ((t >>> 16) | (u << 16)) >>> 0;
		v13h = ((u >>> 16) | (t << 16)) >>> 0;
		t = v9l + v13l;
		v9h = (v9h + v13h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v9l = t >>> 0;
		t = v5l ^ v9l;
		u = v5h ^ v9h;
		v5l = ((t << 1) | (u >>> 31)) >>> 0;
		v5h = ((u << 1) | (t >>> 31)) >>> 0;
		xi = SIGMA[s + 4] << 1;
		yi = SIGMA[s + 5] << 1;
		t = v2l + v6l + mb[xi];
		v2h = (v2h + v6h + mb[xi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v2l = t >>> 0;
		t = (v14h ^ v2h) >>> 0;
		v14h = (v14l ^ v2l) >>> 0;
		v14l = t;
		t = v10l + v14l;
		v10h = (v10h + v14h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v10l = t >>> 0;
		t = v6l ^ v10l;
		u = v6h ^ v10h;
		v6l = ((t >>> 24) | (u << 8)) >>> 0;
		v6h = ((u >>> 24) | (t << 8)) >>> 0;
		t = v2l + v6l + mb[yi];
		v2h = (v2h + v6h + mb[yi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v2l = t >>> 0;
		t = v14l ^ v2l;
		u = v14h ^ v2h;
		v14l = ((t >>> 16) | (u << 16)) >>> 0;
		v14h = ((u >>> 16) | (t << 16)) >>> 0;
		t = v10l + v14l;
		v10h = (v10h + v14h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v10l = t >>> 0;
		t = v6l ^ v10l;
		u = v6h ^ v10h;
		v6l = ((t << 1) | (u >>> 31)) >>> 0;
		v6h = ((u << 1) | (t >>> 31)) >>> 0;
		xi = SIGMA[s + 6] << 1;
		yi = SIGMA[s + 7] << 1;
		t = v3l + v7l + mb[xi];
		v3h = (v3h + v7h + mb[xi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v3l = t >>> 0;
		t = (v15h ^ v3h) >>> 0;
		v15h = (v15l ^ v3l) >>> 0;
		v15l = t;
		t = v11l + v15l;
		v11h = (v11h + v15h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v11l = t >>> 0;
		t = v7l ^ v11l;
		u = v7h ^ v11h;
		v7l = ((t >>> 24) | (u << 8)) >>> 0;
		v7h = ((u >>> 24) | (t << 8)) >>> 0;
		t = v3l + v7l + mb[yi];
		v3h = (v3h + v7h + mb[yi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v3l = t >>> 0;
		t = v15l ^ v3l;
		u = v15h ^ v3h;
		v15l = ((t >>> 16) | (u << 16)) >>> 0;
		v15h = ((u >>> 16) | (t << 16)) >>> 0;
		t = v11l + v15l;
		v11h = (v11h + v15h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v11l = t >>> 0;
		t = v7l ^ v11l;
		u = v7h ^ v11h;
		v7l = ((t << 1) | (u >>> 31)) >>> 0;
		v7h = ((u << 1) | (t >>> 31)) >>> 0;
		xi = SIGMA[s + 8] << 1;
		yi = SIGMA[s + 9] << 1;
		t = v0l + v5l + mb[xi];
		v0h = (v0h + v5h + mb[xi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v0l = t >>> 0;
		t = (v15h ^ v0h) >>> 0;
		v15h = (v15l ^ v0l) >>> 0;
		v15l = t;
		t = v10l + v15l;
		v10h = (v10h + v15h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v10l = t >>> 0;
		t = v5l ^ v10l;
		u = v5h ^ v10h;
		v5l = ((t >>> 24) | (u << 8)) >>> 0;
		v5h = ((u >>> 24) | (t << 8)) >>> 0;
		t = v0l + v5l + mb[yi];
		v0h = (v0h + v5h + mb[yi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v0l = t >>> 0;
		t = v15l ^ v0l;
		u = v15h ^ v0h;
		v15l = ((t >>> 16) | (u << 16)) >>> 0;
		v15h = ((u >>> 16) | (t << 16)) >>> 0;
		t = v10l + v15l;
		v10h = (v10h + v15h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v10l = t >>> 0;
		t = v5l ^ v10l;
		u = v5h ^ v10h;
		v5l = ((t << 1) | (u >>> 31)) >>> 0;
		v5h = ((u << 1) | (t >>> 31)) >>> 0;
		xi = SIGMA[s + 10] << 1;
		yi = SIGMA[s + 11] << 1;
		t = v1l + v6l + mb[xi];
		v1h = (v1h + v6h + mb[xi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v1l = t >>> 0;
		t = (v12h ^ v1h) >>> 0;
		v12h = (v12l ^ v1l) >>> 0;
		v12l = t;
		t = v11l + v12l;
		v11h = (v11h + v12h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v11l = t >>> 0;
		t = v6l ^ v11l;
		u = v6h ^ v11h;
		v6l = ((t >>> 24) | (u << 8)) >>> 0;
		v6h = ((u >>> 24) | (t << 8)) >>> 0;
		t = v1l + v6l + mb[yi];
		v1h = (v1h + v6h + mb[yi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v1l = t >>> 0;
		t = v12l ^ v1l;
		u = v12h ^ v1h;
		v12l = ((t >>> 16) | (u << 16)) >>> 0;
		v12h = ((u >>> 16) | (t << 16)) >>> 0;
		t = v11l + v12l;
		v11h = (v11h + v12h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v11l = t >>> 0;
		t = v6l ^ v11l;
		u = v6h ^ v11h;
		v6l = ((t << 1) | (u >>> 31)) >>> 0;
		v6h = ((u << 1) | (t >>> 31)) >>> 0;
		xi = SIGMA[s + 12] << 1;
		yi = SIGMA[s + 13] << 1;
		t = v2l + v7l + mb[xi];
		v2h = (v2h + v7h + mb[xi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v2l = t >>> 0;
		t = (v13h ^ v2h) >>> 0;
		v13h = (v13l ^ v2l) >>> 0;
		v13l = t;
		t = v8l + v13l;
		v8h = (v8h + v13h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v8l = t >>> 0;
		t = v7l ^ v8l;
		u = v7h ^ v8h;
		v7l = ((t >>> 24) | (u << 8)) >>> 0;
		v7h = ((u >>> 24) | (t << 8)) >>> 0;
		t = v2l + v7l + mb[yi];
		v2h = (v2h + v7h + mb[yi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v2l = t >>> 0;
		t = v13l ^ v2l;
		u = v13h ^ v2h;
		v13l = ((t >>> 16) | (u << 16)) >>> 0;
		v13h = ((u >>> 16) | (t << 16)) >>> 0;
		t = v8l + v13l;
		v8h = (v8h + v13h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v8l = t >>> 0;
		t = v7l ^ v8l;
		u = v7h ^ v8h;
		v7l = ((t << 1) | (u >>> 31)) >>> 0;
		v7h = ((u << 1) | (t >>> 31)) >>> 0;
		xi = SIGMA[s + 14] << 1;
		yi = SIGMA[s + 15] << 1;
		t = v3l + v4l + mb[xi];
		v3h = (v3h + v4h + mb[xi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v3l = t >>> 0;
		t = (v14h ^ v3h) >>> 0;
		v14h = (v14l ^ v3l) >>> 0;
		v14l = t;
		t = v9l + v14l;
		v9h = (v9h + v14h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v9l = t >>> 0;
		t = v4l ^ v9l;
		u = v4h ^ v9h;
		v4l = ((t >>> 24) | (u << 8)) >>> 0;
		v4h = ((u >>> 24) | (t << 8)) >>> 0;
		t = v3l + v4l + mb[yi];
		v3h = (v3h + v4h + mb[yi + 1] + ((t / 4294967296) | 0)) >>> 0;
		v3l = t >>> 0;
		t = v14l ^ v3l;
		u = v14h ^ v3h;
		v14l = ((t >>> 16) | (u << 16)) >>> 0;
		v14h = ((u >>> 16) | (t << 16)) >>> 0;
		t = v9l + v14l;
		v9h = (v9h + v14h + (t > 4294967295 ? 1 : 0)) >>> 0;
		v9l = t >>> 0;
		t = v4l ^ v9l;
		u = v4h ^ v9h;
		v4l = ((t << 1) | (u >>> 31)) >>> 0;
		v4h = ((u << 1) | (t >>> 31)) >>> 0;
	}
	h[0] ^= v0l ^ v8l;
	h[1] ^= v0h ^ v8h;
	h[2] ^= v1l ^ v9l;
	h[3] ^= v1h ^ v9h;
	h[4] ^= v2l ^ v10l;
	h[5] ^= v2h ^ v10h;
	h[6] ^= v3l ^ v11l;
	h[7] ^= v3h ^ v11h;
	h[8] ^= v4l ^ v12l;
	h[9] ^= v4h ^ v12h;
	h[10] ^= v5l ^ v13l;
	h[11] ^= v5h ^ v13h;
	h[12] ^= v6l ^ v14l;
	h[13] ^= v6h ^ v14h;
	h[14] ^= v7l ^ v15l;
	h[15] ^= v7h ^ v15h;
}

/* ------------------------------------------------------------------------------------------- BLAKE2s */

const ms = new Uint32Array(16);

/* BLAKE2s compression, with the same layout: sixteen 32-bit lanes in locals and the eight mixing steps of a round in place. */
function compressS(h, block, offset, tLo, tHi, last) {
	for (let i = 0, j = offset; i < 16; i++, j += 4) ms[i] = block[j] | (block[j + 1] << 8) | (block[j + 2] << 16) | (block[j + 3] << 24);
	let w0, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11, w12, w13, w14, w15;
	let xi;
	let yi;
	w0 = h[0];
	w8 = IV_S[0];
	w1 = h[1];
	w9 = IV_S[1];
	w2 = h[2];
	w10 = IV_S[2];
	w3 = h[3];
	w11 = IV_S[3];
	w4 = h[4];
	w12 = IV_S[4];
	w5 = h[5];
	w13 = IV_S[5];
	w6 = h[6];
	w14 = IV_S[6];
	w7 = h[7];
	w15 = IV_S[7];
	w12 = (w12 ^ tLo) >>> 0;
	w13 = (w13 ^ tHi) >>> 0;
	if (last) w14 = ~w14 >>> 0;
	for (let r = 0; r < 10; r++) {
		const s = r * 16;
		xi = SIGMA[s + 0];
		yi = SIGMA[s + 1];
		w0 = (w0 + w4 + ms[xi]) >>> 0;
		w12 ^= w0;
		w12 = ((w12 >>> 16) | (w12 << 16)) >>> 0;
		w8 = (w8 + w12) >>> 0;
		w4 ^= w8;
		w4 = ((w4 >>> 12) | (w4 << 20)) >>> 0;
		w0 = (w0 + w4 + ms[yi]) >>> 0;
		w12 ^= w0;
		w12 = ((w12 >>> 8) | (w12 << 24)) >>> 0;
		w8 = (w8 + w12) >>> 0;
		w4 ^= w8;
		w4 = ((w4 >>> 7) | (w4 << 25)) >>> 0;
		xi = SIGMA[s + 2];
		yi = SIGMA[s + 3];
		w1 = (w1 + w5 + ms[xi]) >>> 0;
		w13 ^= w1;
		w13 = ((w13 >>> 16) | (w13 << 16)) >>> 0;
		w9 = (w9 + w13) >>> 0;
		w5 ^= w9;
		w5 = ((w5 >>> 12) | (w5 << 20)) >>> 0;
		w1 = (w1 + w5 + ms[yi]) >>> 0;
		w13 ^= w1;
		w13 = ((w13 >>> 8) | (w13 << 24)) >>> 0;
		w9 = (w9 + w13) >>> 0;
		w5 ^= w9;
		w5 = ((w5 >>> 7) | (w5 << 25)) >>> 0;
		xi = SIGMA[s + 4];
		yi = SIGMA[s + 5];
		w2 = (w2 + w6 + ms[xi]) >>> 0;
		w14 ^= w2;
		w14 = ((w14 >>> 16) | (w14 << 16)) >>> 0;
		w10 = (w10 + w14) >>> 0;
		w6 ^= w10;
		w6 = ((w6 >>> 12) | (w6 << 20)) >>> 0;
		w2 = (w2 + w6 + ms[yi]) >>> 0;
		w14 ^= w2;
		w14 = ((w14 >>> 8) | (w14 << 24)) >>> 0;
		w10 = (w10 + w14) >>> 0;
		w6 ^= w10;
		w6 = ((w6 >>> 7) | (w6 << 25)) >>> 0;
		xi = SIGMA[s + 6];
		yi = SIGMA[s + 7];
		w3 = (w3 + w7 + ms[xi]) >>> 0;
		w15 ^= w3;
		w15 = ((w15 >>> 16) | (w15 << 16)) >>> 0;
		w11 = (w11 + w15) >>> 0;
		w7 ^= w11;
		w7 = ((w7 >>> 12) | (w7 << 20)) >>> 0;
		w3 = (w3 + w7 + ms[yi]) >>> 0;
		w15 ^= w3;
		w15 = ((w15 >>> 8) | (w15 << 24)) >>> 0;
		w11 = (w11 + w15) >>> 0;
		w7 ^= w11;
		w7 = ((w7 >>> 7) | (w7 << 25)) >>> 0;
		xi = SIGMA[s + 8];
		yi = SIGMA[s + 9];
		w0 = (w0 + w5 + ms[xi]) >>> 0;
		w15 ^= w0;
		w15 = ((w15 >>> 16) | (w15 << 16)) >>> 0;
		w10 = (w10 + w15) >>> 0;
		w5 ^= w10;
		w5 = ((w5 >>> 12) | (w5 << 20)) >>> 0;
		w0 = (w0 + w5 + ms[yi]) >>> 0;
		w15 ^= w0;
		w15 = ((w15 >>> 8) | (w15 << 24)) >>> 0;
		w10 = (w10 + w15) >>> 0;
		w5 ^= w10;
		w5 = ((w5 >>> 7) | (w5 << 25)) >>> 0;
		xi = SIGMA[s + 10];
		yi = SIGMA[s + 11];
		w1 = (w1 + w6 + ms[xi]) >>> 0;
		w12 ^= w1;
		w12 = ((w12 >>> 16) | (w12 << 16)) >>> 0;
		w11 = (w11 + w12) >>> 0;
		w6 ^= w11;
		w6 = ((w6 >>> 12) | (w6 << 20)) >>> 0;
		w1 = (w1 + w6 + ms[yi]) >>> 0;
		w12 ^= w1;
		w12 = ((w12 >>> 8) | (w12 << 24)) >>> 0;
		w11 = (w11 + w12) >>> 0;
		w6 ^= w11;
		w6 = ((w6 >>> 7) | (w6 << 25)) >>> 0;
		xi = SIGMA[s + 12];
		yi = SIGMA[s + 13];
		w2 = (w2 + w7 + ms[xi]) >>> 0;
		w13 ^= w2;
		w13 = ((w13 >>> 16) | (w13 << 16)) >>> 0;
		w8 = (w8 + w13) >>> 0;
		w7 ^= w8;
		w7 = ((w7 >>> 12) | (w7 << 20)) >>> 0;
		w2 = (w2 + w7 + ms[yi]) >>> 0;
		w13 ^= w2;
		w13 = ((w13 >>> 8) | (w13 << 24)) >>> 0;
		w8 = (w8 + w13) >>> 0;
		w7 ^= w8;
		w7 = ((w7 >>> 7) | (w7 << 25)) >>> 0;
		xi = SIGMA[s + 14];
		yi = SIGMA[s + 15];
		w3 = (w3 + w4 + ms[xi]) >>> 0;
		w14 ^= w3;
		w14 = ((w14 >>> 16) | (w14 << 16)) >>> 0;
		w9 = (w9 + w14) >>> 0;
		w4 ^= w9;
		w4 = ((w4 >>> 12) | (w4 << 20)) >>> 0;
		w3 = (w3 + w4 + ms[yi]) >>> 0;
		w14 ^= w3;
		w14 = ((w14 >>> 8) | (w14 << 24)) >>> 0;
		w9 = (w9 + w14) >>> 0;
		w4 ^= w9;
		w4 = ((w4 >>> 7) | (w4 << 25)) >>> 0;
	}
	h[0] ^= w0 ^ w8;
	h[1] ^= w1 ^ w9;
	h[2] ^= w2 ^ w10;
	h[3] ^= w3 ^ w11;
	h[4] ^= w4 ^ w12;
	h[5] ^= w5 ^ w13;
	h[6] ^= w6 ^ w14;
	h[7] ^= w7 ^ w15;
}

compressBlockB = nativeLayer?.blake2bCompress ?? compressB;
compressBlockS = nativeLayer?.blake2sCompress ?? compressS;

/* ---------------------------------------------------------------------------------------- the hashes */

/* Incremental BLAKE2b (`wide` true) or BLAKE2s: update() any number of times, digest() once, copy() at any point. */
class Blake2 {
	constructor(wide, outlen) {
		this.wide = wide;
		this.outlen = outlen;
		this.blockSize = wide ? 128 : 64;
		this.h = wide ? new Uint32Array(IV_B) : new Uint32Array(IV_S);
		this.h[0] ^= 0x01010000 ^ outlen;
		this.buf = new Uint8Array(this.blockSize);
		this.n = 0;
		this.count = 0;
	}
	_compress(block, offset, last) {
		const tLo = this.count % 4294967296;
		const tHi = Math.floor(this.count / 4294967296);
		if (this.wide) compressBlockB(this.h, block, offset, tLo, tHi, last);
		else compressBlockS(this.h, block, offset, tLo, tHi, last);
	}
	update(data) {
		const size = this.blockSize;
		let i = 0;
		const length = data.length;
		if (this.n > 0) {
			const fill = size - this.n;
			if (length <= fill) {
				this.buf.set(data, this.n);
				this.n += length;
				return this;
			}
			this.buf.set(data.subarray(0, fill), this.n);
			this.count += size;
			this._compress(this.buf, 0, false);
			this.n = 0;
			i = fill;
		}
		// The last block, full or not, is held back: it is the one compressed with the final flag.
		while (length - i > size) {
			this.count += size;
			this._compress(data, i, false);
			i += size;
		}
		this.buf.set(data.subarray(i), 0);
		this.n = length - i;
		return this;
	}
	digest() {
		this.count += this.n;
		this.buf.fill(0, this.n);
		this._compress(this.buf, 0, true);
		const out = new Uint8Array(this.outlen);
		const h = this.h;
		for (let i = 0; i < this.outlen; i++) out[i] = (h[i >> 2] >>> ((i & 3) * 8)) & 0xff;
		return out;
	}
	copy() {
		const clone = new Blake2(this.wide, this.outlen);
		clone.h.set(this.h);
		clone.buf.set(this.buf);
		clone.n = this.n;
		clone.count = this.count;
		return clone;
	}
}

const SPECS = { blake2b512: [true, 64], blake2s256: [false, 32] };

/* Node's names for the two algorithms, in every spelling OpenSSL takes; null for a name that is not BLAKE2. */
function blake2Name(name) {
	const key = String(name).toLowerCase();
	if (key === "blake2b512" || key === "blake2b-512") return "blake2b512";
	if (key === "blake2s256" || key === "blake2s-256") return "blake2s256";
	return null;
}

function newBlake2(name, outlen) {
	const [wide, size] = SPECS[name];
	return new Blake2(wide, outlen ?? size);
}

/* HMAC (RFC 2104) over BLAKE2: 128-byte blocks for BLAKE2b, 64-byte for BLAKE2s. */
class Blake2Hmac {
	constructor(name, key, parts) {
		this.name = name;
		this.size = SPECS[name][1];
		if (parts) {
			this.inner = parts.inner.copy();
			this.outer = parts.outer;
			return;
		}
		const block = SPECS[name][0] ? 128 : 64;
		let k = key;
		if (k.length > block) k = newBlake2(name).update(k).digest();
		const ipad = new Uint8Array(block).fill(0x36);
		const opad = new Uint8Array(block).fill(0x5c);
		for (let i = 0; i < k.length; i++) {
			ipad[i] ^= k[i];
			opad[i] ^= k[i];
		}
		this.inner = newBlake2(name).update(ipad);
		this.outer = newBlake2(name).update(opad);
	}
	update(data) {
		this.inner.update(data);
		return this;
	}
	digest() {
		const outer = this.outer.copy();
		return outer.update(this.inner.digest()).digest();
	}
	/* A fresh HMAC with the same key, for PBKDF2 and HKDF rounds. */
	fresh() {
		return new Blake2Hmac(this.name, null, { inner: this.keyed, outer: this.outer });
	}
}

function hmacWithKey(name, key) {
	const mac = new Blake2Hmac(name, key);
	mac.keyed = mac.inner.copy();
	return mac;
}

/* PBKDF2 (RFC 8018) with HMAC-BLAKE2 as the PRF. */
function blake2Pbkdf2(name, password, salt, iterations, keylen) {
	const base = hmacWithKey(name, password);
	const size = base.size;
	const out = new Uint8Array(keylen);
	const index = new Uint8Array(4);
	for (let block = 1, pos = 0; pos < keylen; block++, pos += size) {
		index[0] = block >>> 24;
		index[1] = block >>> 16;
		index[2] = block >>> 8;
		index[3] = block;
		let u = base.fresh().update(salt).update(index).digest();
		const t = new Uint8Array(u);
		for (let i = 1; i < iterations; i++) {
			u = base.fresh().update(u).digest();
			for (let j = 0; j < size; j++) t[j] ^= u[j];
		}
		out.set(t.subarray(0, Math.min(size, keylen - pos)), pos);
	}
	return out;
}

/* HKDF (RFC 5869); an empty salt is HashLen zero bytes, which HMAC's zero padding makes the same as an empty key. */
function blake2Hkdf(name, ikm, salt, info, keylen) {
	const size = SPECS[name][1];
	if (keylen === 0) throw new Error("HKDF derivation failed");
	if (keylen > 255 * size) throw Object.assign(new RangeError("Invalid key length"), { code: "ERR_CRYPTO_INVALID_KEYLEN" });
	const prk = new Blake2Hmac(name, salt).update(ikm).digest();
	const expand = hmacWithKey(name, prk);
	const out = new Uint8Array(keylen);
	let previous = new Uint8Array(0);
	for (let i = 1, pos = 0; pos < keylen; i++, pos += size) {
		previous = expand.fresh().update(previous).update(info).update(new Uint8Array([i])).digest();
		out.set(previous.subarray(0, Math.min(size, keylen - pos)), pos);
	}
	return out;
}

export { Blake2, Blake2Hmac, blake2Hkdf, blake2Name, blake2Pbkdf2, newBlake2 };

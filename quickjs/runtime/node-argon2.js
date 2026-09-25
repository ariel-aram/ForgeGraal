/*
 * Argon2 (RFC 9106: argon2d, argon2i, argon2id, versions 0x10 and 0x13) for `crypto.argon2` and `crypto.argon2Sync`, and the
 * derivation Web Crypto's Argon2 algorithms share. Blocks of 1024 bytes live in one Uint32Array (each 64-bit word a low and
 * a high 32-bit word); the compression function is BLAKE2b's round with the multiplication of RFC 9106 section 3.5, done on
 * 32-bit halves so nothing here needs BigInt.
 */

import { Blake2 } from "./node-blake2.js";

const TYPES = { argon2d: 0, argon2i: 1, argon2id: 2 };
const BLOCK = 256; // 32-bit words in a block
const SYNC_POINTS = 4;

/* The high 32 bits of a * b for two unsigned 32-bit values. */
function mulHigh(a, b) {
	const a0 = a & 0xffff;
	const a1 = a >>> 16;
	const b0 = b & 0xffff;
	const b1 = b >>> 16;
	const mid = a1 * b0 + a0 * b1 + ((a0 * b0) >>> 16);
	return a1 * b1 + Math.floor(mid / 65536);
}

/* Word offsets of the sixteen registers of each of the eight row and eight column applications of P. */
const OFFSETS = new Int32Array(16 * 16);
for (let i = 0; i < 8; i++) {
	for (let k = 0; k < 16; k++) {
		OFFSETS[i * 16 + k] = 2 * (16 * i + k);
		OFFSETS[(8 + i) * 16 + k] = 2 * (16 * (k >> 1) + 2 * i + (k & 1));
	}
}

/* P of RFC 9106 on the sixteen 64-bit registers a table row of OFFSETS names: loaded into locals, eight GB steps in place
 * (GB is BLAKE2b's G with the multiplication 2 * lo(a) * lo(b) added, done on 32-bit halves), stored back. */
function permute(z, table) {
	const o = table * 16;
	const p16 = OFFSETS;
	let z0l, z0h, z1l, z1h, z2l, z2h, z3l, z3h, z4l, z4h, z5l, z5h, z6l, z6h, z7l, z7h, z8l, z8h, z9l, z9h, z10l, z10h, z11l, z11h, z12l, z12h, z13l, z13h, z14l, z14h, z15l, z15h;
	let a0;
	let a1;
	let b0;
	let b1;
	let p;
	let mid;
	let ml;
	let mh;
	let t;
	let u;
	z0l = z[p16[o + 0]];
	z0h = z[p16[o + 0] + 1];
	z1l = z[p16[o + 1]];
	z1h = z[p16[o + 1] + 1];
	z2l = z[p16[o + 2]];
	z2h = z[p16[o + 2] + 1];
	z3l = z[p16[o + 3]];
	z3h = z[p16[o + 3] + 1];
	z4l = z[p16[o + 4]];
	z4h = z[p16[o + 4] + 1];
	z5l = z[p16[o + 5]];
	z5h = z[p16[o + 5] + 1];
	z6l = z[p16[o + 6]];
	z6h = z[p16[o + 6] + 1];
	z7l = z[p16[o + 7]];
	z7h = z[p16[o + 7] + 1];
	z8l = z[p16[o + 8]];
	z8h = z[p16[o + 8] + 1];
	z9l = z[p16[o + 9]];
	z9h = z[p16[o + 9] + 1];
	z10l = z[p16[o + 10]];
	z10h = z[p16[o + 10] + 1];
	z11l = z[p16[o + 11]];
	z11h = z[p16[o + 11] + 1];
	z12l = z[p16[o + 12]];
	z12h = z[p16[o + 12] + 1];
	z13l = z[p16[o + 13]];
	z13h = z[p16[o + 13] + 1];
	z14l = z[p16[o + 14]];
	z14h = z[p16[o + 14] + 1];
	z15l = z[p16[o + 15]];
	z15h = z[p16[o + 15] + 1];
	a0 = z0l & 0xffff;
	a1 = z0l >>> 16;
	b0 = z4l & 0xffff;
	b1 = z4l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z0l + z4l + ((ml << 1) >>> 0);
	z0h = (z0h + z4h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z0l = t >>> 0;
	t = (z12h ^ z0h) >>> 0;
	z12h = (z12l ^ z0l) >>> 0;
	z12l = t;
	a0 = z8l & 0xffff;
	a1 = z8l >>> 16;
	b0 = z12l & 0xffff;
	b1 = z12l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z8l + z12l + ((ml << 1) >>> 0);
	z8h = (z8h + z12h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z8l = t >>> 0;
	t = z4l ^ z8l;
	u = z4h ^ z8h;
	z4l = ((t >>> 24) | (u << 8)) >>> 0;
	z4h = ((u >>> 24) | (t << 8)) >>> 0;
	a0 = z0l & 0xffff;
	a1 = z0l >>> 16;
	b0 = z4l & 0xffff;
	b1 = z4l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z0l + z4l + ((ml << 1) >>> 0);
	z0h = (z0h + z4h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z0l = t >>> 0;
	t = z12l ^ z0l;
	u = z12h ^ z0h;
	z12l = ((t >>> 16) | (u << 16)) >>> 0;
	z12h = ((u >>> 16) | (t << 16)) >>> 0;
	a0 = z8l & 0xffff;
	a1 = z8l >>> 16;
	b0 = z12l & 0xffff;
	b1 = z12l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z8l + z12l + ((ml << 1) >>> 0);
	z8h = (z8h + z12h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z8l = t >>> 0;
	t = z4l ^ z8l;
	u = z4h ^ z8h;
	z4l = ((t << 1) | (u >>> 31)) >>> 0;
	z4h = ((u << 1) | (t >>> 31)) >>> 0;
	a0 = z1l & 0xffff;
	a1 = z1l >>> 16;
	b0 = z5l & 0xffff;
	b1 = z5l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z1l + z5l + ((ml << 1) >>> 0);
	z1h = (z1h + z5h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z1l = t >>> 0;
	t = (z13h ^ z1h) >>> 0;
	z13h = (z13l ^ z1l) >>> 0;
	z13l = t;
	a0 = z9l & 0xffff;
	a1 = z9l >>> 16;
	b0 = z13l & 0xffff;
	b1 = z13l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z9l + z13l + ((ml << 1) >>> 0);
	z9h = (z9h + z13h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z9l = t >>> 0;
	t = z5l ^ z9l;
	u = z5h ^ z9h;
	z5l = ((t >>> 24) | (u << 8)) >>> 0;
	z5h = ((u >>> 24) | (t << 8)) >>> 0;
	a0 = z1l & 0xffff;
	a1 = z1l >>> 16;
	b0 = z5l & 0xffff;
	b1 = z5l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z1l + z5l + ((ml << 1) >>> 0);
	z1h = (z1h + z5h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z1l = t >>> 0;
	t = z13l ^ z1l;
	u = z13h ^ z1h;
	z13l = ((t >>> 16) | (u << 16)) >>> 0;
	z13h = ((u >>> 16) | (t << 16)) >>> 0;
	a0 = z9l & 0xffff;
	a1 = z9l >>> 16;
	b0 = z13l & 0xffff;
	b1 = z13l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z9l + z13l + ((ml << 1) >>> 0);
	z9h = (z9h + z13h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z9l = t >>> 0;
	t = z5l ^ z9l;
	u = z5h ^ z9h;
	z5l = ((t << 1) | (u >>> 31)) >>> 0;
	z5h = ((u << 1) | (t >>> 31)) >>> 0;
	a0 = z2l & 0xffff;
	a1 = z2l >>> 16;
	b0 = z6l & 0xffff;
	b1 = z6l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z2l + z6l + ((ml << 1) >>> 0);
	z2h = (z2h + z6h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z2l = t >>> 0;
	t = (z14h ^ z2h) >>> 0;
	z14h = (z14l ^ z2l) >>> 0;
	z14l = t;
	a0 = z10l & 0xffff;
	a1 = z10l >>> 16;
	b0 = z14l & 0xffff;
	b1 = z14l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z10l + z14l + ((ml << 1) >>> 0);
	z10h = (z10h + z14h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z10l = t >>> 0;
	t = z6l ^ z10l;
	u = z6h ^ z10h;
	z6l = ((t >>> 24) | (u << 8)) >>> 0;
	z6h = ((u >>> 24) | (t << 8)) >>> 0;
	a0 = z2l & 0xffff;
	a1 = z2l >>> 16;
	b0 = z6l & 0xffff;
	b1 = z6l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z2l + z6l + ((ml << 1) >>> 0);
	z2h = (z2h + z6h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z2l = t >>> 0;
	t = z14l ^ z2l;
	u = z14h ^ z2h;
	z14l = ((t >>> 16) | (u << 16)) >>> 0;
	z14h = ((u >>> 16) | (t << 16)) >>> 0;
	a0 = z10l & 0xffff;
	a1 = z10l >>> 16;
	b0 = z14l & 0xffff;
	b1 = z14l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z10l + z14l + ((ml << 1) >>> 0);
	z10h = (z10h + z14h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z10l = t >>> 0;
	t = z6l ^ z10l;
	u = z6h ^ z10h;
	z6l = ((t << 1) | (u >>> 31)) >>> 0;
	z6h = ((u << 1) | (t >>> 31)) >>> 0;
	a0 = z3l & 0xffff;
	a1 = z3l >>> 16;
	b0 = z7l & 0xffff;
	b1 = z7l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z3l + z7l + ((ml << 1) >>> 0);
	z3h = (z3h + z7h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z3l = t >>> 0;
	t = (z15h ^ z3h) >>> 0;
	z15h = (z15l ^ z3l) >>> 0;
	z15l = t;
	a0 = z11l & 0xffff;
	a1 = z11l >>> 16;
	b0 = z15l & 0xffff;
	b1 = z15l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z11l + z15l + ((ml << 1) >>> 0);
	z11h = (z11h + z15h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z11l = t >>> 0;
	t = z7l ^ z11l;
	u = z7h ^ z11h;
	z7l = ((t >>> 24) | (u << 8)) >>> 0;
	z7h = ((u >>> 24) | (t << 8)) >>> 0;
	a0 = z3l & 0xffff;
	a1 = z3l >>> 16;
	b0 = z7l & 0xffff;
	b1 = z7l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z3l + z7l + ((ml << 1) >>> 0);
	z3h = (z3h + z7h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z3l = t >>> 0;
	t = z15l ^ z3l;
	u = z15h ^ z3h;
	z15l = ((t >>> 16) | (u << 16)) >>> 0;
	z15h = ((u >>> 16) | (t << 16)) >>> 0;
	a0 = z11l & 0xffff;
	a1 = z11l >>> 16;
	b0 = z15l & 0xffff;
	b1 = z15l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z11l + z15l + ((ml << 1) >>> 0);
	z11h = (z11h + z15h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z11l = t >>> 0;
	t = z7l ^ z11l;
	u = z7h ^ z11h;
	z7l = ((t << 1) | (u >>> 31)) >>> 0;
	z7h = ((u << 1) | (t >>> 31)) >>> 0;
	a0 = z0l & 0xffff;
	a1 = z0l >>> 16;
	b0 = z5l & 0xffff;
	b1 = z5l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z0l + z5l + ((ml << 1) >>> 0);
	z0h = (z0h + z5h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z0l = t >>> 0;
	t = (z15h ^ z0h) >>> 0;
	z15h = (z15l ^ z0l) >>> 0;
	z15l = t;
	a0 = z10l & 0xffff;
	a1 = z10l >>> 16;
	b0 = z15l & 0xffff;
	b1 = z15l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z10l + z15l + ((ml << 1) >>> 0);
	z10h = (z10h + z15h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z10l = t >>> 0;
	t = z5l ^ z10l;
	u = z5h ^ z10h;
	z5l = ((t >>> 24) | (u << 8)) >>> 0;
	z5h = ((u >>> 24) | (t << 8)) >>> 0;
	a0 = z0l & 0xffff;
	a1 = z0l >>> 16;
	b0 = z5l & 0xffff;
	b1 = z5l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z0l + z5l + ((ml << 1) >>> 0);
	z0h = (z0h + z5h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z0l = t >>> 0;
	t = z15l ^ z0l;
	u = z15h ^ z0h;
	z15l = ((t >>> 16) | (u << 16)) >>> 0;
	z15h = ((u >>> 16) | (t << 16)) >>> 0;
	a0 = z10l & 0xffff;
	a1 = z10l >>> 16;
	b0 = z15l & 0xffff;
	b1 = z15l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z10l + z15l + ((ml << 1) >>> 0);
	z10h = (z10h + z15h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z10l = t >>> 0;
	t = z5l ^ z10l;
	u = z5h ^ z10h;
	z5l = ((t << 1) | (u >>> 31)) >>> 0;
	z5h = ((u << 1) | (t >>> 31)) >>> 0;
	a0 = z1l & 0xffff;
	a1 = z1l >>> 16;
	b0 = z6l & 0xffff;
	b1 = z6l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z1l + z6l + ((ml << 1) >>> 0);
	z1h = (z1h + z6h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z1l = t >>> 0;
	t = (z12h ^ z1h) >>> 0;
	z12h = (z12l ^ z1l) >>> 0;
	z12l = t;
	a0 = z11l & 0xffff;
	a1 = z11l >>> 16;
	b0 = z12l & 0xffff;
	b1 = z12l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z11l + z12l + ((ml << 1) >>> 0);
	z11h = (z11h + z12h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z11l = t >>> 0;
	t = z6l ^ z11l;
	u = z6h ^ z11h;
	z6l = ((t >>> 24) | (u << 8)) >>> 0;
	z6h = ((u >>> 24) | (t << 8)) >>> 0;
	a0 = z1l & 0xffff;
	a1 = z1l >>> 16;
	b0 = z6l & 0xffff;
	b1 = z6l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z1l + z6l + ((ml << 1) >>> 0);
	z1h = (z1h + z6h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z1l = t >>> 0;
	t = z12l ^ z1l;
	u = z12h ^ z1h;
	z12l = ((t >>> 16) | (u << 16)) >>> 0;
	z12h = ((u >>> 16) | (t << 16)) >>> 0;
	a0 = z11l & 0xffff;
	a1 = z11l >>> 16;
	b0 = z12l & 0xffff;
	b1 = z12l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z11l + z12l + ((ml << 1) >>> 0);
	z11h = (z11h + z12h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z11l = t >>> 0;
	t = z6l ^ z11l;
	u = z6h ^ z11h;
	z6l = ((t << 1) | (u >>> 31)) >>> 0;
	z6h = ((u << 1) | (t >>> 31)) >>> 0;
	a0 = z2l & 0xffff;
	a1 = z2l >>> 16;
	b0 = z7l & 0xffff;
	b1 = z7l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z2l + z7l + ((ml << 1) >>> 0);
	z2h = (z2h + z7h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z2l = t >>> 0;
	t = (z13h ^ z2h) >>> 0;
	z13h = (z13l ^ z2l) >>> 0;
	z13l = t;
	a0 = z8l & 0xffff;
	a1 = z8l >>> 16;
	b0 = z13l & 0xffff;
	b1 = z13l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z8l + z13l + ((ml << 1) >>> 0);
	z8h = (z8h + z13h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z8l = t >>> 0;
	t = z7l ^ z8l;
	u = z7h ^ z8h;
	z7l = ((t >>> 24) | (u << 8)) >>> 0;
	z7h = ((u >>> 24) | (t << 8)) >>> 0;
	a0 = z2l & 0xffff;
	a1 = z2l >>> 16;
	b0 = z7l & 0xffff;
	b1 = z7l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z2l + z7l + ((ml << 1) >>> 0);
	z2h = (z2h + z7h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z2l = t >>> 0;
	t = z13l ^ z2l;
	u = z13h ^ z2h;
	z13l = ((t >>> 16) | (u << 16)) >>> 0;
	z13h = ((u >>> 16) | (t << 16)) >>> 0;
	a0 = z8l & 0xffff;
	a1 = z8l >>> 16;
	b0 = z13l & 0xffff;
	b1 = z13l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z8l + z13l + ((ml << 1) >>> 0);
	z8h = (z8h + z13h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z8l = t >>> 0;
	t = z7l ^ z8l;
	u = z7h ^ z8h;
	z7l = ((t << 1) | (u >>> 31)) >>> 0;
	z7h = ((u << 1) | (t >>> 31)) >>> 0;
	a0 = z3l & 0xffff;
	a1 = z3l >>> 16;
	b0 = z4l & 0xffff;
	b1 = z4l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z3l + z4l + ((ml << 1) >>> 0);
	z3h = (z3h + z4h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z3l = t >>> 0;
	t = (z14h ^ z3h) >>> 0;
	z14h = (z14l ^ z3l) >>> 0;
	z14l = t;
	a0 = z9l & 0xffff;
	a1 = z9l >>> 16;
	b0 = z14l & 0xffff;
	b1 = z14l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z9l + z14l + ((ml << 1) >>> 0);
	z9h = (z9h + z14h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z9l = t >>> 0;
	t = z4l ^ z9l;
	u = z4h ^ z9h;
	z4l = ((t >>> 24) | (u << 8)) >>> 0;
	z4h = ((u >>> 24) | (t << 8)) >>> 0;
	a0 = z3l & 0xffff;
	a1 = z3l >>> 16;
	b0 = z4l & 0xffff;
	b1 = z4l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z3l + z4l + ((ml << 1) >>> 0);
	z3h = (z3h + z4h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z3l = t >>> 0;
	t = z14l ^ z3l;
	u = z14h ^ z3h;
	z14l = ((t >>> 16) | (u << 16)) >>> 0;
	z14h = ((u >>> 16) | (t << 16)) >>> 0;
	a0 = z9l & 0xffff;
	a1 = z9l >>> 16;
	b0 = z14l & 0xffff;
	b1 = z14l >>> 16;
	p = a0 * b0;
	mid = a1 * b0 + a0 * b1 + (p >>> 16);
	ml = ((mid << 16) | (p & 0xffff)) >>> 0;
	mh = a1 * b1 + ((mid / 65536) | 0);
	t = z9l + z14l + ((ml << 1) >>> 0);
	z9h = (z9h + z14h + (((mh << 1) | (ml >>> 31)) >>> 0) + ((t / 4294967296) | 0)) >>> 0;
	z9l = t >>> 0;
	t = z4l ^ z9l;
	u = z4h ^ z9h;
	z4l = ((t << 1) | (u >>> 31)) >>> 0;
	z4h = ((u << 1) | (t >>> 31)) >>> 0;
	z[p16[o + 0]] = z0l;
	z[p16[o + 0] + 1] = z0h;
	z[p16[o + 1]] = z1l;
	z[p16[o + 1] + 1] = z1h;
	z[p16[o + 2]] = z2l;
	z[p16[o + 2] + 1] = z2h;
	z[p16[o + 3]] = z3l;
	z[p16[o + 3] + 1] = z3h;
	z[p16[o + 4]] = z4l;
	z[p16[o + 4] + 1] = z4h;
	z[p16[o + 5]] = z5l;
	z[p16[o + 5] + 1] = z5h;
	z[p16[o + 6]] = z6l;
	z[p16[o + 6] + 1] = z6h;
	z[p16[o + 7]] = z7l;
	z[p16[o + 7] + 1] = z7h;
	z[p16[o + 8]] = z8l;
	z[p16[o + 8] + 1] = z8h;
	z[p16[o + 9]] = z9l;
	z[p16[o + 9] + 1] = z9h;
	z[p16[o + 10]] = z10l;
	z[p16[o + 10] + 1] = z10h;
	z[p16[o + 11]] = z11l;
	z[p16[o + 11] + 1] = z11h;
	z[p16[o + 12]] = z12l;
	z[p16[o + 12] + 1] = z12h;
	z[p16[o + 13]] = z13l;
	z[p16[o + 13] + 1] = z13h;
	z[p16[o + 14]] = z14l;
	z[p16[o + 14] + 1] = z14h;
	z[p16[o + 15]] = z15l;
	z[p16[o + 15] + 1] = z15h;
}

const R = new Uint32Array(BLOCK);
const Z = new Uint32Array(BLOCK);

/* next = compress(prev, ref), xored into what `next` held when `withXor` (passes after the first, version 0x13). */
function fillBlock(prevArr, prevOff, refArr, refOff, nextArr, nextOff, withXor) {
	for (let i = 0; i < BLOCK; i++) {
		const r = prevArr[prevOff + i] ^ refArr[refOff + i];
		R[i] = r;
		Z[i] = r;
	}
	for (let i = 0; i < 8; i++) permute(Z, i);
	for (let i = 8; i < 16; i++) permute(Z, i);
	if (withXor) for (let i = 0; i < BLOCK; i++) nextArr[nextOff + i] ^= R[i] ^ Z[i];
	else for (let i = 0; i < BLOCK; i++) nextArr[nextOff + i] = R[i] ^ Z[i];
}

const le32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

/* The variable-length hash H' of RFC 9106 section 3.3. */
function hPrime(length, input) {
	const out = new Uint8Array(length);
	let h = new Blake2(true, length <= 64 ? length : 64).update(le32(length)).update(input);
	let v = h.digest();
	if (length <= 64) return v;
	out.set(v.subarray(0, 32), 0);
	let pos = 32;
	let remaining = length - 32;
	while (remaining > 64) {
		v = new Blake2(true, 64).update(v).digest();
		out.set(v.subarray(0, 32), pos);
		pos += 32;
		remaining -= 32;
	}
	h = new Blake2(true, remaining).update(v);
	out.set(h.digest(), pos);
	return out;
}

const ZERO_BLOCK = new Uint32Array(BLOCK);

/*
 * The Argon2 tag. `p` holds Uint8Array `message`, `nonce`, `secret`, `associatedData` and the numbers `parallelism`,
 * `tagLength`, `memory` (KiB), `passes` and `version`.
 */
function argon2Derive(algorithm, p) {
	const type = TYPES[algorithm];
	const lanes = p.parallelism;
	const passes = p.passes;
	const version = p.version ?? 0x13;
	const blocks = 4 * lanes * Math.floor(p.memory / (4 * lanes));
	const laneLength = blocks / lanes;
	const segmentLength = laneLength / SYNC_POINTS;
	const seed = new Blake2(true, 64);
	for (const n of [lanes, p.tagLength, p.memory, passes, version, type]) seed.update(le32(n));
	for (const part of [p.message, p.nonce, p.secret, p.associatedData]) seed.update(le32(part.length)).update(part);
	const h0 = seed.digest();

	const memory = new Uint32Array(blocks * BLOCK);
	const initial = new Uint8Array(72);
	initial.set(h0);
	for (let lane = 0; lane < lanes; lane++) {
		for (let column = 0; column < 2; column++) {
			initial.set(le32(column), 64);
			initial.set(le32(lane), 68);
			const bytes = hPrime(1024, initial);
			const base = (lane * laneLength + column) * BLOCK;
			for (let i = 0; i < BLOCK; i++) memory[base + i] = (bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16) | (bytes[4 * i + 3] << 24)) >>> 0;
		}
	}

	const input = new Uint32Array(BLOCK);
	const address = new Uint32Array(BLOCK);
	const nextAddresses = () => {
		input[12] += 1; // the counter is the seventh 64-bit word
		fillBlock(ZERO_BLOCK, 0, input, 0, address, 0, false);
		fillBlock(ZERO_BLOCK, 0, address, 0, address, 0, false);
	};

	for (let pass = 0; pass < passes; pass++) {
		const withXor = pass > 0 && version === 0x13;
		for (let slice = 0; slice < SYNC_POINTS; slice++) {
			const independent = type === 1 || (type === 2 && pass === 0 && slice < 2);
			for (let lane = 0; lane < lanes; lane++) {
				let start = 0;
				if (independent) {
					input.fill(0);
					input[0] = pass;
					input[2] = lane;
					input[4] = slice;
					input[6] = blocks;
					input[8] = passes;
					input[10] = type;
				}
				if (pass === 0 && slice === 0) {
					start = 2;
					if (independent) nextAddresses();
				}
				const laneBase = lane * laneLength;
				for (let i = start; i < segmentLength; i++) {
					const column = slice * segmentLength + i;
					const current = laneBase + column;
					const previous = column === 0 ? laneBase + laneLength - 1 : current - 1;
					let j1;
					let j2;
					if (independent) {
						if (i % 128 === 0) nextAddresses();
						j1 = address[2 * (i % 128)];
						j2 = address[2 * (i % 128) + 1];
					} else {
						j1 = memory[previous * BLOCK];
						j2 = memory[previous * BLOCK + 1];
					}
					const refLane = pass === 0 && slice === 0 ? lane : j2 % lanes;
					const sameLane = refLane === lane;
					let area;
					if (pass === 0) {
						if (slice === 0) area = i - 1;
						else if (sameLane) area = slice * segmentLength + i - 1;
						else area = slice * segmentLength + (i === 0 ? -1 : 0);
					} else if (sameLane) area = laneLength - segmentLength + i - 1;
					else area = laneLength - segmentLength + (i === 0 ? -1 : 0);
					const relative = area - 1 - mulHigh(area, mulHigh(j1, j1));
					const offset = pass === 0 ? 0 : slice === SYNC_POINTS - 1 ? 0 : (slice + 1) * segmentLength;
					const reference = refLane * laneLength + ((offset + relative) % laneLength);
					fillBlock(memory, previous * BLOCK, memory, reference * BLOCK, memory, current * BLOCK, withXor);
				}
			}
		}
	}

	const last = new Uint32Array(BLOCK);
	for (let lane = 0; lane < lanes; lane++) {
		const base = (lane * laneLength + laneLength - 1) * BLOCK;
		for (let i = 0; i < BLOCK; i++) last[i] ^= memory[base + i];
	}
	const bytes = new Uint8Array(BLOCK * 4);
	for (let i = 0; i < BLOCK; i++) {
		bytes[4 * i] = last[i];
		bytes[4 * i + 1] = last[i] >>> 8;
		bytes[4 * i + 2] = last[i] >>> 16;
		bytes[4 * i + 3] = last[i] >>> 24;
	}
	return hPrime(p.tagLength, bytes);
}

/* ------------------------------------------------------------------------------------- the crypto API */

const MAX = 4294967295;

/* How Node words a value it did not expect. */
function received(value) {
	if (value === null || value === undefined) return String(value);
	if (typeof value === "function") return `function ${value.name}`;
	if (typeof value === "object") {
		const name = value.constructor?.name;
		return name ? `an instance of ${name}` : "an object";
	}
	let shown = typeof value === "string" ? value : String(value);
	if (typeof value === "string") {
		if (shown.length > 28) shown = `${shown.slice(0, 25)}...`;
		shown = shown.includes("'") ? JSON.stringify(shown) : `'${shown}'`;
	} else if (typeof value === "bigint") shown += "n";
	return `type ${typeof value} (${shown})`;
}
const withSeparators = (n) => (Number.isInteger(n) && Math.abs(n) > 2 ** 32 ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_") : String(n));

function createArgon2({ Buffer }) {
	const typeErr = (name, expected, value, property) =>
		Object.assign(new TypeError(`The "${name}" ${property ? "property" : "argument"} must be ${expected}. Received ${received(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
	const rangeErr = (name, range, value) => Object.assign(new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${typeof value === "number" ? withSeparators(value) : received(value)}`), { code: "ERR_OUT_OF_RANGE" });
	const BYTES = "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView";
	const bytesOf = (value) => {
		if (typeof value === "string") return new Uint8Array(Buffer.from(value, "utf8"));
		if (value instanceof ArrayBuffer) return new Uint8Array(value);
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	};
	const isBytes = (value) => typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
	const integer = (parameters, name, min) => {
		const value = parameters[name];
		if (typeof value !== "number") throw typeErr(`parameters.${name}`, "of type number", value, true);
		if (!Number.isInteger(value)) throw rangeErr(`parameters.${name}`, "an integer", value);
		if (value < min || value > (name === "parallelism" ? 16777215 : MAX)) throw rangeErr(`parameters.${name}`, `>= ${min} && <= ${name === "parallelism" ? 16777215 : MAX}`, value);
		return value;
	};

	/* Node's checks, in Node's order; returns what argon2Derive takes. */
	const check = (algorithm, parameters) => {
		if (typeof algorithm !== "string") throw typeErr("algorithm", "of type string", algorithm);
		if (!Object.hasOwn(TYPES, algorithm)) throw Object.assign(new TypeError(`The argument 'algorithm' must be one of: 'argon2d', 'argon2i', 'argon2id'. Received ${JSON.stringify(algorithm).replace(/^"|"$/g, "'")}`), { code: "ERR_INVALID_ARG_VALUE" });
		if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) throw typeErr("parameters", "of type object", parameters);
		const { message, nonce, secret, associatedData } = parameters;
		if (!isBytes(message)) throw typeErr("parameters.message", BYTES, message, true);
		if (!isBytes(nonce)) throw typeErr("parameters.nonce", BYTES, nonce, true);
		const nonceBytes = bytesOf(nonce);
		if (nonceBytes.length < 8) throw rangeErr("parameters.nonce.byteLength", `>= 8 && <= ${MAX}`, nonceBytes.length);
		const parallelism = integer(parameters, "parallelism", 1);
		const tagLength = integer(parameters, "tagLength", 4);
		const memory = integer(parameters, "memory", 8 * parallelism);
		const passes = integer(parameters, "passes", 1);
		if (secret !== undefined && !isBytes(secret)) throw typeErr("parameters.secret", BYTES, secret, true);
		if (associatedData !== undefined && !isBytes(associatedData)) throw typeErr("parameters.associatedData", BYTES, associatedData, true);
		return {
			message: bytesOf(message),
			nonce: nonceBytes,
			secret: secret === undefined ? new Uint8Array(0) : bytesOf(secret),
			associatedData: associatedData === undefined ? new Uint8Array(0) : bytesOf(associatedData),
			parallelism,
			tagLength,
			memory,
			passes,
			version: 0x13,
		};
	};

	const argon2Sync = (algorithm, parameters) => Buffer.from(argon2Derive(algorithm, check(algorithm, parameters)));
	const argon2 = (algorithm, parameters, callback) => {
		const checked = check(algorithm, parameters);
		if (typeof callback !== "function") throw typeErr("callback", "of type function", callback);
		const run = () => {
			let result;
			let error = null;
			try {
				result = Buffer.from(argon2Derive(algorithm, checked));
			} catch (err) {
				error = err;
			}
			if (error) callback(error);
			else callback(null, result);
		};
		if (typeof setImmediate === "function") setImmediate(run);
		else queueMicrotask(run);
	};
	return { argon2, argon2Sync };
}

export { argon2Derive, createArgon2, received };

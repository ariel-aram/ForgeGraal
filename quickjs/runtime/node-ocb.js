/*
 * AES-OCB (RFC 7253) for createCipheriv/createDecipheriv, in JavaScript over the host's AES-ECB block primitive
 * (`native.cipher` with an ECB mbedTLS cipher and no padding). Full blocks are transformed as they arrive, as OpenSSL does,
 * so update() returns whole 16-byte blocks and final() the rest; the additional data is hashed when the tag is computed.
 */

const ZERO = new Uint8Array(0);
const BLOCK = 16;

const double = (block) => {
	const out = new Uint8Array(BLOCK);
	for (let i = 0; i < BLOCK; i++) out[i] = ((block[i] << 1) | (i < BLOCK - 1 ? block[i + 1] >> 7 : 0)) & 0xff;
	if (block[0] & 0x80) out[BLOCK - 1] ^= 0x87;
	return out;
};
const xorInto = (target, source, offset = 0) => {
	for (let i = 0; i < BLOCK; i++) target[i] ^= source[offset + i];
};
const trailingZeros = (n) => {
	let count = 0;
	while ((n & 1) === 0) {
		n >>= 1;
		count++;
	}
	return count;
};

export class Ocb {
	constructor(native, key, nonce, tagLength, decrypt) {
		this.tagLength = tagLength;
		this.decrypt = decrypt;
		const name = `AES-${key.length * 8}-ECB`;
		this.encryptBlocks = (data) => new Uint8Array(native.cipher(true, name, key, ZERO, data, null, 0, false));
		this.decryptBlocks = (data) => new Uint8Array(native.cipher(false, name, key, ZERO, data, null, 0, false));
		this.lStar = this.encryptBlocks(new Uint8Array(BLOCK));
		this.lDollar = double(this.lStar);
		this.l = [double(this.lDollar)];
		// Initial offset from the nonce (RFC 7253 section 4.2).
		const block = new Uint8Array(BLOCK);
		block[0] = ((tagLength * 8) % 128) << 1;
		block[BLOCK - 1 - nonce.length] |= 1;
		block.set(nonce, BLOCK - nonce.length);
		const bottom = block[BLOCK - 1] & 63;
		block[BLOCK - 1] &= 0xc0;
		const top = this.encryptBlocks(block);
		const stretch = new Uint8Array(24);
		stretch.set(top);
		for (let i = 0; i < 8; i++) stretch[16 + i] = top[i] ^ top[i + 1];
		const bytes = bottom >> 3;
		const bits = bottom & 7;
		this.offset = new Uint8Array(BLOCK);
		for (let i = 0; i < BLOCK; i++) this.offset[i] = ((stretch[i + bytes] << bits) | (stretch[i + bytes + 1] >> (8 - bits))) & 0xff;
		this.checksum = new Uint8Array(BLOCK);
		this.index = 0;
		this.pending = ZERO;
		this.aad = [];
		this.finished = false;
	}
	addAad(bytes) {
		this.aad.push(bytes);
	}
	lAt(i) {
		while (this.l.length <= i) this.l.push(double(this.l[this.l.length - 1]));
		return this.l[i];
	}
	/* Transforms the full blocks of `pending + data` and keeps the remainder. */
	update(data) {
		let input = data;
		if (this.pending.length) {
			input = new Uint8Array(this.pending.length + data.length);
			input.set(this.pending);
			input.set(data, this.pending.length);
		}
		const count = Math.floor(input.length / BLOCK);
		this.pending = input.slice(count * BLOCK);
		if (!count) return ZERO;
		const masks = new Uint8Array(count * BLOCK);
		const work = new Uint8Array(count * BLOCK);
		for (let j = 0; j < count; j++) {
			xorInto(this.offset, this.lAt(trailingZeros(++this.index)));
			masks.set(this.offset, j * BLOCK);
			for (let i = 0; i < BLOCK; i++) {
				const byte = input[j * BLOCK + i];
				work[j * BLOCK + i] = byte ^ this.offset[i];
				if (!this.decrypt) this.checksum[i] ^= byte;
			}
		}
		const mixed = this.decrypt ? this.decryptBlocks(work) : this.encryptBlocks(work);
		const out = new Uint8Array(count * BLOCK);
		for (let j = 0; j < count; j++) {
			for (let i = 0; i < BLOCK; i++) {
				const at = j * BLOCK + i;
				out[at] = mixed[at] ^ masks[at];
				if (this.decrypt) this.checksum[i] ^= out[at];
			}
		}
		return out;
	}
	hashAad() {
		let total = 0;
		for (const part of this.aad) total += part.length;
		const data = new Uint8Array(total);
		let at = 0;
		for (const part of this.aad) {
			data.set(part, at);
			at += part.length;
		}
		const sum = new Uint8Array(BLOCK);
		const count = Math.floor(data.length / BLOCK);
		if (count) {
			const offset = new Uint8Array(BLOCK);
			const work = new Uint8Array(count * BLOCK);
			for (let j = 0; j < count; j++) {
				xorInto(offset, this.lAt(trailingZeros(j + 1)));
				for (let i = 0; i < BLOCK; i++) work[j * BLOCK + i] = data[j * BLOCK + i] ^ offset[i];
			}
			const mixed = this.encryptBlocks(work);
			for (let j = 0; j < count; j++) xorInto(sum, mixed, j * BLOCK);
			const last = data.length % BLOCK;
			if (last) {
				const tail = new Uint8Array(BLOCK);
				tail.set(data.subarray(count * BLOCK));
				tail[last] = 0x80;
				xorInto(offset, this.lStar);
				xorInto(tail, offset);
				xorInto(sum, this.encryptBlocks(tail));
			}
		} else if (data.length) {
			const tail = new Uint8Array(BLOCK);
			tail.set(data);
			tail[data.length] = 0x80;
			xorInto(tail, this.lStar);
			xorInto(sum, this.encryptBlocks(tail));
		}
		return sum;
	}
	/* Finishes the message: the last partial block and the tag (of the plaintext-side checksum). */
	finish() {
		let tail = ZERO;
		if (this.pending.length) {
			xorInto(this.offset, this.lStar);
			const pad = this.encryptBlocks(this.offset);
			tail = new Uint8Array(this.pending.length);
			const plain = new Uint8Array(BLOCK);
			for (let i = 0; i < tail.length; i++) {
				tail[i] = this.pending[i] ^ pad[i];
				plain[i] = this.decrypt ? tail[i] : this.pending[i];
			}
			plain[tail.length] = 0x80;
			xorInto(this.checksum, plain);
			this.pending = ZERO;
		}
		const block = new Uint8Array(BLOCK);
		for (let i = 0; i < BLOCK; i++) block[i] = this.checksum[i] ^ this.offset[i] ^ this.lDollar[i];
		const tag = this.encryptBlocks(block);
		xorInto(tag, this.hashAad());
		return { tail, tag: tag.slice(0, this.tagLength) };
	}
}

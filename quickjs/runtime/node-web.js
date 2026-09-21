/*
 * Web Streams (web-streams.js, the spec-compliant polyfill) and Blob/File, in pure JavaScript. The Fetch API built on them lives in node-fetch.js
 * and the HTTP client and server in node-http.js.
 */

/* ------------------------------------------------------------------ streams */

import {
	ByteLengthQueuingStrategy,
	CountQueuingStrategy,
	ReadableByteStreamController,
	ReadableStream,
	ReadableStreamBYOBReader,
	ReadableStreamBYOBRequest,
	ReadableStreamDefaultController,
	ReadableStreamDefaultReader,
	TransformStream,
	TransformStreamDefaultController,
	WritableStream,
	WritableStreamDefaultController,
	WritableStreamDefaultWriter,
} from "./web-streams.js";

/* --------------------------------------------------------------- Blob / File */

function concatParts(parts) {
	const chunks = [];
	let total = 0;
	for (const part of parts) {
		let bytes;
		if (typeof part === "string") bytes = new TextEncoder().encode(part);
		else if (part instanceof Blob) bytes = part._bytes;
		else if (ArrayBuffer.isView(part)) bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
		else if (part instanceof ArrayBuffer) bytes = new Uint8Array(part);
		else bytes = new TextEncoder().encode(String(part));
		chunks.push(bytes);
		total += bytes.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

class Blob {
	constructor(parts = [], options = {}) {
		this._bytes = concatParts(parts);
		this.type = options.type ?? "";
	}
	get size() {
		return this._bytes.length;
	}
	async text() {
		return new TextDecoder().decode(this._bytes);
	}
	async arrayBuffer() {
		return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.length);
	}
	async bytes() {
		return this._bytes.slice();
	}
	slice(start = 0, end = this.size, type = "") {
		const blob = new Blob([], { type });
		blob._bytes = this._bytes.slice(start, end);
		return blob;
	}
	stream() {
		const bytes = this._bytes;
		return new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		});
	}
}

class File extends Blob {
	constructor(parts, name, options = {}) {
		super(parts, options);
		this.name = String(name);
		this.lastModified = options.lastModified ?? Date.now();
	}
}

export {
	ReadableStream,
	WritableStream,
	TransformStream,
	ByteLengthQueuingStrategy,
	CountQueuingStrategy,
	ReadableByteStreamController,
	ReadableStreamBYOBReader,
	ReadableStreamBYOBRequest,
	ReadableStreamDefaultController,
	ReadableStreamDefaultReader,
	TransformStreamDefaultController,
	WritableStreamDefaultController,
	WritableStreamDefaultWriter,
	Blob,
	File,
};

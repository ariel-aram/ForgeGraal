/*
 * Web Streams and Blob/File, in pure JavaScript. The Fetch API built on them lives in node-fetch.js
 * and the HTTP client and server in node-http.js.
 */

/* ------------------------------------------------------------------ streams */

/*
 * A spec-shaped ReadableStream, not the whole specification: what libraries actually use is
 * getReader/read/cancel, tee, and async iteration. Byte streams ('bytes' type with BYOB readers)
 * are not implemented, and asking for one throws rather than silently handing back a default
 * reader whose chunks arrive with different semantics.
 */
class ReadableStream {
	constructor(source = {}, strategy = {}) {
		if (source.type === "bytes") {
			throw new TypeError(
				"ReadableStream byte sources are not implemented in this runtime. A default (non-BYOB) " +
					"source works; a byte source would differ in how chunks are delivered, so it is refused " +
					"rather than quietly substituted."
			);
		}
		this._source = source;
		this._queue = [];
		this._closed = false;
		this._errored = null;
		this._locked = false;
		this._pullWaiters = [];
		this._highWaterMark = strategy.highWaterMark ?? 1;

		const controller = {
			enqueue: (chunk) => {
				if (this._closed) throw new TypeError("cannot enqueue on a closed stream");
				this._queue.push(chunk);
				this._wake();
			},
			close: () => {
				this._closed = true;
				this._wake();
			},
			error: (reason) => {
				this._errored = reason ?? new Error("stream errored");
				this._wake();
			},
			get desiredSize() {
				return this._highWaterMark - this._queue.length;
			},
		};
		this._controller = controller;
		try {
			source.start?.(controller);
		} catch (err) {
			this._errored = err;
		}
	}

	get locked() {
		return this._locked;
	}

	_wake() {
		for (const resolve of this._pullWaiters.splice(0)) resolve();
	}

	async _read() {
		for (;;) {
			if (this._errored) throw this._errored;
			if (this._queue.length) return { done: false, value: this._queue.shift() };
			if (this._closed) return { done: true, value: undefined };
			// Ask the source for more before parking, which is how a pull source makes progress.
			try {
				await this._source.pull?.(this._controller);
			} catch (err) {
				this._errored = err;
				continue;
			}
			if (this._queue.length || this._closed || this._errored) continue;
			await new Promise((resolve) => this._pullWaiters.push(resolve));
		}
	}

	getReader(options = {}) {
		if (options.mode === "byob") {
			throw new TypeError("BYOB readers are not implemented in this runtime");
		}
		if (this._locked) throw new TypeError("stream is already locked");
		this._locked = true;
		const stream = this;
		return {
			read: () => stream._read(),
			cancel: (reason) => stream.cancel(reason),
			releaseLock: () => {
				stream._locked = false;
			},
			get closed() {
				return Promise.resolve();
			},
		};
	}

	async cancel(reason) {
		this._closed = true;
		this._queue.length = 0;
		await this._source.cancel?.(reason);
		this._wake();
	}

	tee() {
		// Both branches get every chunk, so the source is drained once into two queues.
		const chunks = [];
		let done = false;
		const pump = (async () => {
			const reader = this.getReader();
			for (;;) {
				const { done: finished, value } = await reader.read();
				if (finished) break;
				chunks.push(value);
			}
			done = true;
		})();
		const branch = () =>
			new ReadableStream({
				async pull(controller) {
					await pump;
					for (const chunk of chunks) controller.enqueue(chunk);
					if (done) controller.close();
				},
			});
		return [branch(), branch()];
	}

	async *[Symbol.asyncIterator]() {
		const reader = this.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	}

	static from(iterable) {
		const iterator = iterable[Symbol.asyncIterator]?.() ?? iterable[Symbol.iterator]();
		return new ReadableStream({
			async pull(controller) {
				const { done, value } = await iterator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			},
		});
	}
}

class WritableStream {
	constructor(sink = {}, strategy = {}) {
		this._sink = sink;
		this._locked = false;
		this._closed = false;
		this.highWaterMark = strategy.highWaterMark ?? 1;
		sink.start?.(this._controller());
	}

	_controller() {
		return { error: (reason) => { this._errored = reason; } };
	}

	get locked() {
		return this._locked;
	}

	getWriter() {
		if (this._locked) throw new TypeError("stream is already locked");
		this._locked = true;
		const stream = this;
		return {
			write: async (chunk) => stream._sink.write?.(chunk, stream._controller()),
			close: async () => {
				stream._closed = true;
				await stream._sink.close?.();
			},
			abort: async (reason) => stream._sink.abort?.(reason),
			releaseLock: () => {
				stream._locked = false;
			},
			get desiredSize() {
				return stream.highWaterMark;
			},
			get closed() {
				return Promise.resolve();
			},
			get ready() {
				return Promise.resolve();
			},
		};
	}

	async close() {
		this._closed = true;
		await this._sink.close?.();
	}

	async abort(reason) {
		await this._sink.abort?.(reason);
	}
}

class TransformStream {
	constructor(transformer = {}, writableStrategy = {}, readableStrategy = {}) {
		let readableController;
		this.readable = new ReadableStream(
			{
				start(controller) {
					readableController = controller;
				},
			},
			readableStrategy
		);
		const transform = transformer.transform ?? ((chunk, controller) => controller.enqueue(chunk));
		this.writable = new WritableStream(
			{
				async write(chunk) {
					await transform(chunk, readableController);
				},
				async close() {
					await transformer.flush?.(readableController);
					readableController.close();
				},
			},
			writableStrategy
		);
		transformer.start?.(readableController);
	}
}

class ByteLengthQueuingStrategy {
	constructor({ highWaterMark }) {
		this.highWaterMark = highWaterMark;
	}
	size(chunk) {
		return chunk?.byteLength ?? 0;
	}
}

class CountQueuingStrategy {
	constructor({ highWaterMark }) {
		this.highWaterMark = highWaterMark;
	}
	size() {
		return 1;
	}
}

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
	Blob,
	File,
};

/*
 * Node's `stream`: Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished and the
 * promise and web-stream bridges, following the reference implementation's semantics -- highWaterMark
 * and backpressure, flowing and paused modes, 'readable' and 'data', destroy/error/close ordering,
 * pipe with drain handling, object mode, async iteration.
 *
 * The constructors are plain functions with prototype methods, as Node's are, because published code
 * inherits both ways: `class X extends Readable` and `util.inherits(X, Readable)` followed by
 * `Readable.call(this, options)`.
 */

const nop = () => {};
const nextTick = (fn, ...args) => queueMicrotask(() => fn(...args));

function makeError(Base, code, message, extra) {
	const err = new Base(message);
	err.code = code;
	if (extra) Object.assign(err, extra);
	return err;
}
const ERR = {
	invalidArg: (name, expected, value) =>
		makeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be ${expected}. Received ${value === null ? "null" : typeof value}`),
	nullValues: () => makeError(TypeError, "ERR_STREAM_NULL_VALUES", "May not write null values to stream"),
	writeAfterEnd: () => makeError(Error, "ERR_STREAM_WRITE_AFTER_END", "write after end"),
	destroyed: (method) => makeError(Error, "ERR_STREAM_DESTROYED", `Cannot call ${method} after a stream was destroyed`),
	pushAfterEof: () => makeError(Error, "ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF"),
	unshiftAfterEnd: () => makeError(Error, "ERR_STREAM_UNSHIFT_AFTER_END_EVENT", "stream.unshift() after end event"),
	prematureClose: () => makeError(Error, "ERR_STREAM_PREMATURE_CLOSE", "Premature close"),
	notImplemented: (name) => makeError(Error, "ERR_METHOD_NOT_IMPLEMENTED", `The ${name} method is not implemented`),
	alreadyFinished: () => makeError(Error, "ERR_STREAM_ALREADY_FINISHED", "Cannot call end after a stream was finished"),
	cannotPipe: () => makeError(Error, "ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable"),
	abort: (cause) => Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause }),
};

function aggregate(a, b) {
	if (!a) return b;
	if (!b || a === b) return a;
	const err = new Error("Multiple errors", { cause: [a, b] });
	err.errors = [a, b];
	return err;
}

function createStreamModule(EventEmitter, Buffer, StringDecoder, web) {
	const hasInstance = Function.prototype[Symbol.hasInstance];

	/* ---------------------------------------------------------------- legacy Stream */

	function Stream(options) {
		EventEmitter.call(this, options);
	}
	Object.setPrototypeOf(Stream.prototype, EventEmitter.prototype);
	Object.setPrototypeOf(Stream, EventEmitter);

	/* The pre-streams2 pipe, which Readable overrides. */
	Stream.prototype.pipe = function pipe(dest, options) {
		const source = this;
		function ondata(chunk) {
			if (dest.writable && dest.write(chunk) === false && source.pause) source.pause();
		}
		source.on("data", ondata);
		function ondrain() {
			if (source.readable && source.resume) source.resume();
		}
		dest.on("drain", ondrain);
		if (!dest._isStdio && (!options || options.end !== false)) {
			source.on("end", onend);
			source.on("close", onclose);
		}
		let didOnEnd = false;
		function onend() {
			if (didOnEnd) return;
			didOnEnd = true;
			dest.end();
		}
		function onclose() {
			if (didOnEnd) return;
			didOnEnd = true;
			if (typeof dest.destroy === "function") dest.destroy();
		}
		function onerror(er) {
			cleanup();
			if (EventEmitter.listenerCount(this, "error") === 0) this.emit("error", er);
		}
		source.on("error", onerror);
		dest.on("error", onerror);
		function cleanup() {
			source.removeListener("data", ondata);
			dest.removeListener("drain", ondrain);
			source.removeListener("end", onend);
			source.removeListener("close", onclose);
			source.removeListener("error", onerror);
			dest.removeListener("error", onerror);
			source.removeListener("end", cleanup);
			source.removeListener("close", cleanup);
			dest.removeListener("close", cleanup);
		}
		source.on("end", cleanup);
		source.on("close", cleanup);
		dest.on("close", cleanup);
		dest.emit("pipe", source);
		return dest;
	};

	/* ------------------------------------------------------------------- destroy */

	function checkError(err, w, r) {
		if (err) {
			err.stack; // eslint-disable-line no-unused-expressions
			if (w && !w.errored) w.errored = err;
			if (r && !r.errored) r.errored = err;
		}
	}

	function emitErrorNT(self, err) {
		const r = self._readableState;
		const w = self._writableState;
		if ((w && w.errorEmitted) || (r && r.errorEmitted)) return;
		if (w) w.errorEmitted = true;
		if (r) r.errorEmitted = true;
		self.emit("error", err);
	}

	function emitCloseNT(self) {
		const r = self._readableState;
		const w = self._writableState;
		if (w) w.closeEmitted = true;
		if (r) r.closeEmitted = true;
		if ((w && w.emitClose) || (r && r.emitClose)) self.emit("close");
	}

	function emitErrorCloseNT(self, err) {
		emitErrorNT(self, err);
		emitCloseNT(self);
	}

	function runDestroy(self, err, cb) {
		let called = false;
		function onDestroy(error) {
			if (called) return;
			called = true;
			const r = self._readableState;
			const w = self._writableState;
			checkError(error, w, r);
			if (w) w.closed = true;
			if (r) r.closed = true;
			if (typeof cb === "function") cb(error);
			if (error) nextTick(emitErrorCloseNT, self, error);
			else nextTick(emitCloseNT, self);
		}
		try {
			self._destroy(err || null, onDestroy);
		} catch (error) {
			onDestroy(error);
		}
	}

	function destroy(err, cb) {
		const r = this._readableState;
		const w = this._writableState;
		const s = w || r;
		if ((w && w.destroyed) || (r && r.destroyed)) {
			if (typeof cb === "function") cb();
			return this;
		}
		checkError(err, w, r);
		if (w) w.destroyed = true;
		if (r) r.destroyed = true;
		if (!s.constructed) this.once("__fgDestroy", (er) => runDestroy(this, aggregate(er, err), cb));
		else runDestroy(this, err, cb);
		return this;
	}

	function errorOrDestroy(stream, err, sync) {
		const r = stream._readableState;
		const w = stream._writableState;
		if ((w && w.destroyed) || (r && r.destroyed)) return;
		if ((r && r.autoDestroy) || (w && w.autoDestroy)) stream.destroy(err);
		else if (err) {
			if (w && !w.errored) w.errored = err;
			if (r && !r.errored) r.errored = err;
			if (sync) nextTick(emitErrorNT, stream, err);
			else emitErrorNT(stream, err);
		}
	}

	function construct(stream, cb) {
		if (typeof stream._construct !== "function") return;
		const r = stream._readableState;
		const w = stream._writableState;
		if (r) r.constructed = false;
		if (w) w.constructed = false;
		stream.once("__fgConstructed", cb);
		if (stream.listenerCount("__fgConstructed") > 1) return;
		nextTick(() => {
			let called = false;
			const done = (err) => {
				if (called) return;
				called = true;
				if (r) r.constructed = true;
				if (w) w.constructed = true;
				if (r?.destroyed || w?.destroyed) stream.emit("__fgDestroy", err);
				else if (err) errorOrDestroy(stream, err, true);
				else nextTick(() => stream.emit("__fgConstructed"));
			};
			try {
				stream._construct((err) => nextTick(done, err));
			} catch (err) {
				nextTick(done, err);
			}
		});
	}

	function destroyer(stream, err) {
		if (!stream || (stream.destroyed ?? stream._readableState?.destroyed)) return;
		if (typeof stream.destroy === "function") stream.destroy(err);
		else if (typeof stream.close === "function") stream.close();
		else if (err) nextTick(() => stream.emit("error", err));
		if (!stream.destroyed) stream.destroyed = true;
	}

	/* ------------------------------------------------------------------ finished */

	function isReadableNodeStream(obj) {
		return Boolean(obj && typeof obj.pipe === "function" && typeof obj.on === "function" && (!obj._writableState || obj._readableState?.readable !== false) && (!obj._writableState || obj._readableState));
	}
	function isWritableNodeStream(obj) {
		return Boolean(obj && typeof obj.write === "function" && typeof obj.on === "function" && (!obj._readableState || obj._writableState?.writable !== false));
	}
	function isNodeStream(obj) {
		return Boolean(obj && (obj._readableState || obj._writableState || (typeof obj.write === "function" && typeof obj.on === "function") || (typeof obj.pipe === "function" && typeof obj.on === "function")));
	}

	function eos(stream, options, callback) {
		if (arguments.length === 2) {
			callback = options;
			options = {};
		} else if (options == null) options = {};
		callback = once(callback);
		const readable = options.readable ?? isReadableNodeStream(stream);
		const writable = options.writable ?? isWritableNodeStream(stream);
		const wState = stream._writableState;
		const rState = stream._readableState;
		const onlegacyfinish = () => {
			if (!stream.writable) onfinish();
		};
		let willEmitClose = wState?.autoDestroy && wState?.emitClose && wState?.closed === false ? true : rState?.autoDestroy && rState?.emitClose && rState?.closed === false;
		let writableFinished = Boolean(wState?.finished);
		let readableFinished = Boolean(rState?.endEmitted);
		const onfinish = () => {
			writableFinished = true;
			if (stream.destroyed) willEmitClose = false;
			if (willEmitClose && (!stream.readable || readable)) return;
			if (!readable || readableFinished) callback.call(stream);
		};
		const onend = () => {
			readableFinished = true;
			if (stream.destroyed) willEmitClose = false;
			if (willEmitClose && (!stream.writable || writable)) return;
			if (!writable || writableFinished) callback.call(stream);
		};
		const onerror = (err) => callback.call(stream, err);
		let closed = Boolean(wState?.closed || rState?.closed);
		const onclose = () => {
			closed = true;
			const errored = wState?.errored || rState?.errored;
			if (errored && typeof errored !== "boolean") return callback.call(stream, errored);
			if (readable && !readableFinished && isReadableNodeStream(stream)) {
				if (!rState?.endEmitted) return callback.call(stream, ERR.prematureClose());
			}
			if (writable && !writableFinished) {
				if (!wState?.finished) return callback.call(stream, ERR.prematureClose());
			}
			callback.call(stream);
		};
		const onrequest = () => {
			stream.req.on("finish", onfinish);
		};
		if (stream.setHeader && typeof stream.abort === "function") {
			stream.on("complete", onfinish);
			if (!willEmitClose) stream.on("abort", onclose);
			if (stream.req) onrequest();
			else stream.on("request", onrequest);
		} else if (writable && !wState) {
			stream.on("end", onlegacyfinish);
			stream.on("close", onlegacyfinish);
		}
		if (!willEmitClose && typeof stream.aborted === "boolean") stream.on("aborted", onclose);
		stream.on("end", onend);
		stream.on("finish", onfinish);
		if (options.error !== false) stream.on("error", onerror);
		stream.on("close", onclose);
		if (closed) nextTick(onclose);
		else if (wState?.errorEmitted || rState?.errorEmitted) {
			if (!willEmitClose) nextTick(onclose);
		} else if (!readable && (!willEmitClose || stream.readable) && writableFinished) nextTick(onclose);
		else if (!writable && (!willEmitClose || stream.writable) && readableFinished) nextTick(onclose);
		else if (rState && stream.req && stream.aborted) nextTick(onclose);
		const cleanup = () => {
			callback = nop;
			stream.removeListener("aborted", onclose);
			stream.removeListener("complete", onfinish);
			stream.removeListener("abort", onclose);
			stream.removeListener("request", onrequest);
			if (stream.req) stream.req.removeListener("finish", onfinish);
			stream.removeListener("end", onlegacyfinish);
			stream.removeListener("close", onlegacyfinish);
			stream.removeListener("finish", onfinish);
			stream.removeListener("end", onend);
			stream.removeListener("error", onerror);
			stream.removeListener("close", onclose);
		};
		if (options.signal && !closed) {
			const abort = () => {
				const endCallback = callback;
				cleanup();
				endCallback.call(stream, ERR.abort(options.signal.reason));
			};
			if (options.signal.aborted) nextTick(abort);
			else {
				options.signal.addEventListener("abort", abort, { once: true });
				const original = callback;
				callback = function wrapped(...args) {
					options.signal.removeEventListener("abort", abort);
					original.apply(this, args);
				};
			}
		}
		return cleanup;
	}
	function once(fn) {
		let called = false;
		return function onceWrapper(...args) {
			if (called) return undefined;
			called = true;
			return fn.apply(this, args);
		};
	}

	/* ------------------------------------------------------------------ Readable */

	function ReadableState(options, stream, isDuplex) {
		options = options ?? {};
		this.objectMode = Boolean(options.objectMode || (isDuplex && options.readableObjectMode));
		this.highWaterMark = highWaterMarkOf(options, "readableHighWaterMark", this.objectMode, isDuplex);
		this.buffer = [];
		this.length = 0;
		this.pipes = [];
		this.flowing = null;
		this.ended = false;
		this.endEmitted = false;
		this.reading = false;
		this.constructed = true;
		this.sync = true;
		this.needReadable = false;
		this.emittedReadable = false;
		this.readableListening = false;
		this.resumeScheduled = false;
		this.errorEmitted = false;
		this.emitClose = options.emitClose !== false;
		this.autoDestroy = options.autoDestroy !== false;
		this.destroyed = false;
		this.errored = null;
		this.closed = false;
		this.closeEmitted = false;
		this.defaultEncoding = options.defaultEncoding || "utf8";
		this.awaitDrainWriters = null;
		this.multiAwaitDrain = false;
		this.readingMore = false;
		this.dataEmitted = false;
		this.decoder = null;
		this.encoding = null;
		if (options.encoding) {
			this.decoder = new StringDecoder(options.encoding);
			this.encoding = options.encoding;
		}
	}

	let defaultHighWaterMark = 16384;
	let defaultObjectHighWaterMark = 16;
	function highWaterMarkOf(options, duplexKey, objectMode, isDuplex) {
		let hwm = options.highWaterMark != null ? options.highWaterMark : isDuplex ? options[duplexKey] : null;
		if (hwm != null) {
			if (!Number.isInteger(hwm) || hwm < 0) {
				throw makeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.${options.highWaterMark != null ? "highWaterMark" : duplexKey}' is invalid. Received ${hwm}`);
			}
			return Math.floor(hwm);
		}
		return objectMode ? defaultObjectHighWaterMark : defaultHighWaterMark;
	}

	function Readable(options) {
		if (!(this instanceof Readable)) return new Readable(options);
		const isDuplex = this instanceof Duplex;
		this._readableState = new ReadableState(options, this, isDuplex);
		if (options) {
			if (typeof options.read === "function") this._read = options.read;
			if (typeof options.destroy === "function") this._destroy = options.destroy;
			if (typeof options.construct === "function") this._construct = options.construct;
			if (options.signal && !isDuplex) addAbortSignal(options.signal, this);
		}
		Stream.call(this, options);
		construct(this, () => {
			if (this._readableState.needReadable) maybeReadMore(this, this._readableState);
		});
	}
	Object.setPrototypeOf(Readable.prototype, Stream.prototype);
	Object.setPrototypeOf(Readable, Stream);

	Readable.prototype.destroy = destroy;
	Readable.prototype._undestroy = function _undestroy() {
		const r = this._readableState;
		r.constructed = true;
		r.closed = false;
		r.closeEmitted = false;
		r.destroyed = false;
		r.errored = null;
		r.errorEmitted = false;
		r.reading = false;
		r.ended = false;
		r.endEmitted = false;
	};
	Readable.prototype._destroy = function (err, cb) {
		cb(err);
	};

	Readable.prototype.push = function push(chunk, encoding) {
		return readableAddChunk(this, chunk, encoding, false);
	};
	Readable.prototype.unshift = function unshift(chunk, encoding) {
		return readableAddChunk(this, chunk, encoding, true);
	};

	function readableAddChunk(stream, chunk, encoding, addToFront) {
		const state = stream._readableState;
		let err;
		if (!state.objectMode) {
			if (typeof chunk === "string") {
				encoding = encoding || state.defaultEncoding;
				if (state.encoding !== encoding) {
					if (addToFront && state.encoding) chunk = Buffer.from(chunk, encoding).toString(state.encoding);
					else {
						chunk = Buffer.from(chunk, encoding);
						encoding = "";
					}
				}
			} else if (chunk instanceof Buffer) encoding = "";
			else if (chunk instanceof Uint8Array) {
				chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
				encoding = "";
			} else if (chunk != null) err = ERR.invalidArg("chunk", "of type string or an instance of Buffer or Uint8Array", chunk);
		}
		if (err) errorOrDestroy(stream, err);
		else if (chunk === null) {
			state.reading = false;
			onEofChunk(stream, state);
		} else if (state.objectMode || (chunk && chunk.length > 0)) {
			if (addToFront) {
				if (state.endEmitted) errorOrDestroy(stream, ERR.unshiftAfterEnd());
				else if (state.destroyed || state.errored) return false;
				else addChunk(stream, state, chunk, true);
			} else if (state.ended) errorOrDestroy(stream, ERR.pushAfterEof());
			else if (state.destroyed || state.errored) return false;
			else {
				state.reading = false;
				if (state.decoder && !encoding) {
					chunk = state.decoder.write(chunk);
					if (state.objectMode || chunk.length !== 0) addChunk(stream, state, chunk, false);
					else maybeReadMore(stream, state);
				} else addChunk(stream, state, chunk, false);
			}
		} else if (!addToFront) {
			state.reading = false;
			maybeReadMore(stream, state);
		}
		return !state.ended && (state.length < state.highWaterMark || state.length === 0);
	}

	function addChunk(stream, state, chunk, addToFront) {
		if (state.flowing && state.length === 0 && !state.sync && stream.listenerCount("data") > 0) {
			if (state.multiAwaitDrain) state.awaitDrainWriters.clear();
			else state.awaitDrainWriters = null;
			state.dataEmitted = true;
			stream.emit("data", chunk);
		} else {
			state.length += state.objectMode ? 1 : chunk.length;
			if (addToFront) state.buffer.unshift(chunk);
			else state.buffer.push(chunk);
			if (state.needReadable) emitReadable(stream);
		}
		maybeReadMore(stream, state);
	}

	Readable.prototype.isPaused = function isPaused() {
		const state = this._readableState;
		return state.paused === true || state.flowing === false;
	};

	Readable.prototype.setEncoding = function setEncoding(enc) {
		const decoder = new StringDecoder(enc);
		this._readableState.decoder = decoder;
		this._readableState.encoding = decoder.encoding;
		const buffer = this._readableState.buffer;
		let content = "";
		for (const data of buffer) content += decoder.write(data);
		buffer.length = 0;
		if (content !== "") buffer.push(content);
		this._readableState.length = content.length;
		return this;
	};

	const MAX_HWM = 0x40000000;
	function computeNewHighWaterMark(n) {
		if (n > MAX_HWM) throw makeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "size" is out of range. Received ${n}`);
		n--;
		n |= n >>> 1;
		n |= n >>> 2;
		n |= n >>> 4;
		n |= n >>> 8;
		n |= n >>> 16;
		n++;
		return n;
	}

	function howMuchToRead(n, state) {
		if (n <= 0 || (state.length === 0 && state.ended)) return 0;
		if (state.objectMode) return 1;
		if (Number.isNaN(n)) {
			if (state.flowing && state.length) return state.buffer[0].length;
			return state.length;
		}
		if (n <= state.length) return n;
		return state.ended ? state.length : 0;
	}

	Readable.prototype.read = function read(n) {
		if (n === undefined) n = Number.NaN;
		else if (!Number.isInteger(n)) n = Number.parseInt(n, 10);
		const state = this._readableState;
		const nOrig = n;
		if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);
		if (n !== 0) state.emittedReadable = false;
		if (n === 0 && state.needReadable && ((state.highWaterMark !== 0 ? state.length >= state.highWaterMark : state.length > 0) || state.ended)) {
			if (state.length === 0 && state.ended) endReadable(this);
			else emitReadable(this);
			return null;
		}
		n = howMuchToRead(n, state);
		if (n === 0 && state.ended) {
			if (state.length === 0) endReadable(this);
			return null;
		}
		let doRead = state.needReadable;
		if (state.length === 0 || state.length - n < state.highWaterMark) doRead = true;
		if (state.ended || state.reading || state.destroyed || state.errored || !state.constructed) doRead = false;
		else if (doRead) {
			state.reading = true;
			state.sync = true;
			if (state.length === 0) state.needReadable = true;
			try {
				this._read(state.highWaterMark);
			} catch (err) {
				errorOrDestroy(this, err);
			}
			state.sync = false;
			if (!state.reading) n = howMuchToRead(nOrig, state);
		}
		let ret;
		if (n > 0) ret = fromList(n, state);
		else ret = null;
		if (ret === null) {
			state.needReadable = state.length <= state.highWaterMark;
			n = 0;
		} else {
			state.length -= n;
			if (state.multiAwaitDrain) state.awaitDrainWriters.clear();
			else state.awaitDrainWriters = null;
		}
		if (state.length === 0) {
			if (!state.ended) state.needReadable = true;
			if (nOrig !== n && state.ended) endReadable(this);
		}
		if (ret !== null && !state.errorEmitted && !state.closeEmitted) {
			state.dataEmitted = true;
			this.emit("data", ret);
		}
		return ret;
	};

	function onEofChunk(stream, state) {
		if (state.ended) return;
		if (state.decoder) {
			const chunk = state.decoder.end();
			if (chunk && chunk.length) {
				state.buffer.push(chunk);
				state.length += state.objectMode ? 1 : chunk.length;
			}
		}
		state.ended = true;
		if (state.sync) emitReadable(stream);
		else {
			state.needReadable = false;
			state.emittedReadable = true;
			emitReadable_(stream);
		}
	}

	function emitReadable(stream) {
		const state = stream._readableState;
		state.needReadable = false;
		if (!state.emittedReadable) {
			state.emittedReadable = true;
			nextTick(emitReadable_, stream);
		}
	}

	function emitReadable_(stream) {
		const state = stream._readableState;
		if (!state.destroyed && !state.errored && (state.length || state.ended)) {
			stream.emit("readable");
			state.emittedReadable = false;
		}
		state.needReadable = !state.flowing && !state.ended && state.length <= state.highWaterMark;
		flow(stream);
	}

	function maybeReadMore(stream, state) {
		if (!state.readingMore && state.constructed) {
			state.readingMore = true;
			nextTick(maybeReadMore_, stream, state);
		}
	}

	function maybeReadMore_(stream, state) {
		while (!state.reading && !state.ended && (state.length < state.highWaterMark || (state.flowing && state.length === 0))) {
			const len = state.length;
			stream.read(0);
			if (len === state.length) break;
		}
		state.readingMore = false;
	}

	Readable.prototype._read = function (_n) {
		throw ERR.notImplemented("_read()");
	};

	Readable.prototype.pipe = function pipe(dest, pipeOpts) {
		const src = this;
		const state = this._readableState;
		if (state.pipes.length === 1 && !state.multiAwaitDrain) {
			state.multiAwaitDrain = true;
			state.awaitDrainWriters = new Set(state.awaitDrainWriters ? [state.awaitDrainWriters] : []);
		}
		state.pipes.push(dest);
		const doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== globalThis.process?.stdout && dest !== globalThis.process?.stderr;
		const endFn = doEnd ? onend : unpipe;
		if (state.endEmitted) nextTick(endFn);
		else src.once("end", endFn);
		dest.on("unpipe", onunpipe);
		function onunpipe(readable, unpipeInfo) {
			if (readable === src && unpipeInfo && unpipeInfo.hasUnpiped === false) {
				unpipeInfo.hasUnpiped = true;
				cleanup();
			}
		}
		function onend() {
			dest.end();
		}
		let ondrain;
		let cleanedUp = false;
		function cleanup() {
			dest.removeListener("close", onclose);
			dest.removeListener("finish", onfinish);
			if (ondrain) dest.removeListener("drain", ondrain);
			dest.removeListener("error", onerror);
			dest.removeListener("unpipe", onunpipe);
			src.removeListener("end", onend);
			src.removeListener("end", unpipe);
			src.removeListener("data", ondata);
			cleanedUp = true;
			if (ondrain && state.awaitDrainWriters && (!dest._writableState || dest._writableState.needDrain)) ondrain();
		}
		function pause() {
			if (!cleanedUp) {
				if (state.pipes.length === 1 && state.pipes[0] === dest) {
					state.awaitDrainWriters = dest;
					state.multiAwaitDrain = false;
				} else if (state.pipes.length > 1 && state.pipes.includes(dest)) state.awaitDrainWriters.add(dest);
				src.pause();
			}
			if (!ondrain) {
				ondrain = pipeOnDrain(src, dest);
				dest.on("drain", ondrain);
			}
		}
		src.on("data", ondata);
		function ondata(chunk) {
			const ret = dest.write(chunk);
			if (ret === false) pause();
		}
		function onerror(er) {
			unpipe();
			dest.removeListener("error", onerror);
			if (dest.listenerCount("error") === 0) {
				const s = dest._writableState || dest._readableState;
				if (s && !s.errorEmitted) errorOrDestroy(dest, er);
				else dest.emit("error", er);
			}
		}
		dest.prependListener("error", onerror);
		function onclose() {
			dest.removeListener("finish", onfinish);
			unpipe();
		}
		dest.once("close", onclose);
		function onfinish() {
			dest.removeListener("close", onclose);
			unpipe();
		}
		dest.once("finish", onfinish);
		function unpipe() {
			src.unpipe(dest);
		}
		dest.emit("pipe", src);
		if (dest.writableNeedDrain === true) pause();
		else if (!state.flowing) src.resume();
		return dest;
	};

	function pipeOnDrain(src, dest) {
		return function pipeOnDrainFunctionResult() {
			const state = src._readableState;
			if (state.awaitDrainWriters === dest) state.awaitDrainWriters = null;
			else if (state.multiAwaitDrain) state.awaitDrainWriters.delete(dest);
			if ((!state.awaitDrainWriters || state.awaitDrainWriters.size === 0) && src.listenerCount("data")) src.resume();
		};
	}

	Readable.prototype.unpipe = function unpipe(dest) {
		const state = this._readableState;
		const unpipeInfo = { hasUnpiped: false };
		if (state.pipes.length === 0) return this;
		if (!dest) {
			const dests = state.pipes;
			state.pipes = [];
			this.pause();
			for (const d of dests) d.emit("unpipe", this, { hasUnpiped: false });
			return this;
		}
		const index = state.pipes.indexOf(dest);
		if (index === -1) return this;
		state.pipes.splice(index, 1);
		if (state.pipes.length === 0) this.pause();
		dest.emit("unpipe", this, unpipeInfo);
		return this;
	};

	Readable.prototype.on = function on(ev, fn) {
		const res = Stream.prototype.on.call(this, ev, fn);
		const state = this._readableState;
		if (ev === "data") {
			state.readableListening = this.listenerCount("readable") > 0;
			if (state.flowing !== false) this.resume();
		} else if (ev === "readable") {
			if (!state.endEmitted && !state.readableListening) {
				state.readableListening = state.needReadable = true;
				state.flowing = false;
				state.emittedReadable = false;
				if (state.length) emitReadable(this);
				else if (!state.reading) nextTick(nReadingNextTick, this);
			}
		}
		return res;
	};
	Readable.prototype.addListener = Readable.prototype.on;

	Readable.prototype.removeListener = function removeListener(ev, fn) {
		const res = Stream.prototype.removeListener.call(this, ev, fn);
		if (ev === "readable") nextTick(updateReadableListening, this);
		return res;
	};
	Readable.prototype.off = Readable.prototype.removeListener;

	Readable.prototype.removeAllListeners = function removeAllListeners(ev) {
		const res = Stream.prototype.removeAllListeners.call(this, ev);
		if (ev === "readable" || ev === undefined) nextTick(updateReadableListening, this);
		return res;
	};

	function updateReadableListening(self) {
		const state = self._readableState;
		state.readableListening = self.listenerCount("readable") > 0;
		if (state.resumeScheduled && state.paused === false) state.flowing = true;
		else if (self.listenerCount("data") > 0) self.resume();
		else if (!state.readableListening) state.flowing = null;
	}

	function nReadingNextTick(self) {
		self.read(0);
	}

	Readable.prototype.resume = function resume() {
		const state = this._readableState;
		if (!state.flowing) {
			state.flowing = !state.readableListening;
			resumeScheduled(this, state);
		}
		state.paused = false;
		return this;
	};

	function resumeScheduled(stream, state) {
		if (!state.resumeScheduled) {
			state.resumeScheduled = true;
			nextTick(resume_, stream, state);
		}
	}

	function resume_(stream, state) {
		if (!state.reading) stream.read(0);
		state.resumeScheduled = false;
		stream.emit("resume");
		flow(stream);
		if (state.flowing && !state.reading) stream.read(0);
	}

	Readable.prototype.pause = function pause() {
		if (this._readableState.flowing !== false) {
			this._readableState.flowing = false;
			this.emit("pause");
		}
		this._readableState.paused = true;
		return this;
	};

	function flow(stream) {
		const state = stream._readableState;
		while (state.flowing && stream.read() !== null);
	}

	Readable.prototype.wrap = function wrap(stream) {
		let paused = false;
		stream.on("data", (chunk) => {
			if (!this.push(chunk) && stream.pause) {
				paused = true;
				stream.pause();
			}
		});
		stream.on("end", () => this.push(null));
		stream.on("error", (err) => errorOrDestroy(this, err));
		stream.on("close", () => this.destroy());
		stream.on("destroy", () => this.destroy());
		this._read = () => {
			if (paused && stream.resume) {
				paused = false;
				stream.resume();
			}
		};
		return this;
	};

	Readable.prototype[Symbol.asyncIterator] = function () {
		return createAsyncIterator(this);
	};
	Readable.prototype.iterator = function iterator(options) {
		return createAsyncIterator(this, options);
	};

	async function* createAsyncIterator(stream, options) {
		let callback = nop;
		function next(resolve) {
			if (this === stream) {
				callback();
				callback = nop;
			} else callback = resolve;
		}
		stream.on("readable", next);
		let error;
		const cleanup = eos(stream, { writable: false }, (err) => {
			error = err ? aggregate(error, err) : null;
			callback();
			callback = nop;
		});
		try {
			for (;;) {
				const chunk = stream.destroyed ? null : stream.read();
				if (chunk !== null) yield chunk;
				else if (error) throw error;
				else if (error === null) return;
				else await new Promise(next);
			}
		} catch (err) {
			error = aggregate(error, err);
			throw error;
		} finally {
			if ((error || options?.destroyOnReturn !== false) && (error === undefined || stream._readableState.autoDestroy)) destroyer(stream, null);
			else {
				stream.off("readable", next);
				cleanup();
			}
		}
	}

	for (const [name, getter] of Object.entries({
		readable: function () {
			const r = this._readableState;
			return Boolean(r) && r.readable !== false && !r.destroyed && !r.errorEmitted && !r.endEmitted;
		},
		readableDidRead: function () {
			return this._readableState.dataEmitted;
		},
		readableAborted: function () {
			return Boolean(this._readableState.readable !== false && (this._readableState.destroyed || this._readableState.errored) && !this._readableState.endEmitted);
		},
		readableHighWaterMark: function () {
			return this._readableState.highWaterMark;
		},
		readableBuffer: function () {
			return this._readableState?.buffer;
		},
		readableFlowing: function () {
			return this._readableState.flowing;
		},
		readableLength: function () {
			return this._readableState.length;
		},
		readableObjectMode: function () {
			return this._readableState ? this._readableState.objectMode : false;
		},
		readableEncoding: function () {
			return this._readableState ? this._readableState.encoding : null;
		},
		errored: function () {
			return this._readableState ? this._readableState.errored : null;
		},
		closed: function () {
			return this._readableState ? this._readableState.closed : false;
		},
		readableEnded: function () {
			return this._readableState ? this._readableState.endEmitted : false;
		},
	})) {
		Object.defineProperty(Readable.prototype, name, {
			get: getter,
			set:
				name === "readable"
					? function (val) {
							if (this._readableState) this._readableState.readable = Boolean(val);
					  }
					: undefined,
			configurable: true,
			enumerable: false,
		});
	}
	Object.defineProperty(Readable.prototype, "destroyed", {
		get() {
			return this._readableState ? this._readableState.destroyed : false;
		},
		set(value) {
			if (this._readableState) this._readableState.destroyed = value;
		},
		configurable: true,
		enumerable: false,
	});

	function fromList(n, state) {
		if (state.length === 0) return null;
		let ret;
		if (state.objectMode) ret = state.buffer.shift();
		else if (!n || n >= state.length) {
			if (state.decoder) ret = state.buffer.join("");
			else if (state.buffer.length === 1) ret = state.buffer[0];
			else ret = Buffer.concat(state.buffer, state.length);
			state.buffer.length = 0;
		} else {
			const first = state.buffer[0];
			if (n < first.length) {
				ret = first.slice(0, n);
				state.buffer[0] = first.slice(n);
			} else if (n === first.length) ret = state.buffer.shift();
			else if (state.decoder) {
				ret = "";
				while (n > 0) {
					const head = state.buffer[0];
					if (n >= head.length) {
						ret += head;
						n -= head.length;
						state.buffer.shift();
					} else {
						ret += head.slice(0, n);
						state.buffer[0] = head.slice(n);
						n = 0;
					}
				}
			} else {
				ret = Buffer.allocUnsafe(n);
				let offset = 0;
				while (n > 0) {
					const head = state.buffer[0];
					if (n >= head.length) {
						ret.set(head, offset);
						offset += head.length;
						n -= head.length;
						state.buffer.shift();
					} else {
						ret.set(head.subarray(0, n), offset);
						state.buffer[0] = head.subarray(n);
						offset += n;
						n = 0;
					}
				}
			}
		}
		return ret;
	}

	function endReadable(stream) {
		const state = stream._readableState;
		if (!state.endEmitted) {
			state.ended = true;
			nextTick(endReadableNT, state, stream);
		}
	}

	function endReadableNT(state, stream) {
		if (!state.errored && !state.closeEmitted && !state.endEmitted && state.length === 0) {
			state.endEmitted = true;
			stream.emit("end");
			if (stream.writable && stream.allowHalfOpen === false) nextTick(() => stream.end());
			else if (state.autoDestroy) {
				const wState = stream._writableState;
				const autoDestroy = !wState || (wState.autoDestroy && (wState.finished || wState.writable === false));
				if (autoDestroy) stream.destroy();
			}
		}
	}

	Readable.from = function from(iterable, opts) {
		let iterator;
		if (typeof iterable === "string" || iterable instanceof Buffer) {
			return new Readable({
				objectMode: true,
				...opts,
				read() {
					this.push(iterable);
					this.push(null);
				},
			});
		}
		let isAsync;
		if (iterable && iterable[Symbol.asyncIterator]) {
			isAsync = true;
			iterator = iterable[Symbol.asyncIterator]();
		} else if (iterable && iterable[Symbol.iterator]) {
			isAsync = false;
			iterator = iterable[Symbol.iterator]();
		} else throw ERR.invalidArg("iterable", "an instance of Iterable", iterable);
		const readable = new Readable({ objectMode: true, highWaterMark: 1, ...opts });
		let reading = false;
		readable._read = function () {
			if (!reading) {
				reading = true;
				next();
			}
		};
		readable._destroy = function (error, cb) {
			close(error).then(
				() => nextTick(cb, error),
				(e) => nextTick(cb, e || error)
			);
		};
		async function close(error) {
			const hadError = error !== undefined && error !== null;
			const hasThrow = typeof iterator.throw === "function";
			if (hadError && hasThrow) {
				const { value, done } = await iterator.throw(error);
				await value;
				if (done) return;
			}
			if (typeof iterator.return === "function") {
				const { value } = await iterator.return();
				await value;
			}
		}
		async function next() {
			for (;;) {
				try {
					const { value, done } = isAsync ? await iterator.next() : iterator.next();
					if (done) readable.push(null);
					else {
						const res = value && typeof value.then === "function" ? await value : value;
						if (res === null) {
							reading = false;
							throw makeError(TypeError, "ERR_STREAM_NULL_VALUES", "May not write null values to stream");
						} else if (readable.push(res)) continue;
						else reading = false;
					}
				} catch (err) {
					readable.destroy(err);
				}
				break;
			}
		}
		return readable;
	};

	Readable.isDisturbed = (stream) => Boolean(stream && (stream._readableState?.dataEmitted || stream._readableState?.endEmitted || stream.destroyed));

	/* Web stream bridges. */
	Readable.fromWeb = function fromWeb(webStream, options) {
		const reader = webStream.getReader();
		const readable = new Readable({
			objectMode: false,
			...options,
			read() {
				reader.read().then(
					({ done, value }) => {
						if (done) this.push(null);
						else this.push(typeof value === "string" ? value : Buffer.from(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength));
					},
					(err) => this.destroy(err)
				);
			},
			destroy(err, cb) {
				reader.cancel(err).then(() => cb(err), cb);
			},
		});
		return readable;
	};
	Readable.toWeb = function toWeb(readable) {
		return new web.ReadableStream({
			start(controller) {
				readable.on("data", (chunk) => controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength))));
				readable.on("end", () => controller.close());
				readable.on("error", (err) => controller.error(err));
			},
			cancel(reason) {
				readable.destroy(reason);
			},
		});
	};

	/* Async-iterator helpers on Readable (map/filter/toArray/...), the ones programs reach for. */
	Readable.prototype.toArray = async function toArray() {
		const out = [];
		for await (const chunk of this) out.push(chunk);
		return out;
	};
	Readable.prototype.forEach = async function forEach(fn) {
		for await (const chunk of this) await fn(chunk);
	};
	Readable.prototype.map = function map(fn) {
		const source = this;
		return Readable.from(
			(async function* () {
				for await (const chunk of source) yield await fn(chunk);
			})()
		);
	};
	Readable.prototype.filter = function filter(fn) {
		const source = this;
		return Readable.from(
			(async function* () {
				for await (const chunk of source) if (await fn(chunk)) yield chunk;
			})()
		);
	};

	/* ------------------------------------------------------------------ Writable */

	function WritableState(options, stream, isDuplex) {
		options = options ?? {};
		this.objectMode = Boolean(options.objectMode || (isDuplex && options.writableObjectMode));
		this.highWaterMark = highWaterMarkOf(options, "writableHighWaterMark", this.objectMode, isDuplex);
		this.finalCalled = false;
		this.needDrain = false;
		this.ending = false;
		this.ended = false;
		this.finished = false;
		this.destroyed = false;
		this.decodeStrings = options.decodeStrings !== false;
		this.defaultEncoding = options.defaultEncoding || "utf8";
		this.length = 0;
		this.writing = false;
		this.corked = 0;
		this.sync = true;
		this.bufferProcessing = false;
		this.onwrite = onwrite.bind(undefined, stream);
		this.writecb = null;
		this.writelen = 0;
		this.afterWriteTickInfo = null;
		this.buffered = [];
		this.bufferedIndex = 0;
		this.allBuffers = true;
		this.allNoop = true;
		this.pendingcb = 0;
		this.constructed = true;
		this.prefinished = false;
		this.errorEmitted = false;
		this.emitClose = options.emitClose !== false;
		this.autoDestroy = options.autoDestroy !== false;
		this.errored = null;
		this.closed = false;
		this.closeEmitted = false;
		this.finishCallbacks = [];
	}
	WritableState.prototype.getBuffer = function getBuffer() {
		return this.buffered.slice(this.bufferedIndex);
	};

	function Writable(options) {
		const isDuplex = this instanceof Duplex;
		if (!isDuplex && !hasInstance.call(Writable, this)) return new Writable(options);
		this._writableState = new WritableState(options, this, isDuplex);
		if (options) {
			if (typeof options.write === "function") this._write = options.write;
			if (typeof options.writev === "function") this._writev = options.writev;
			if (typeof options.destroy === "function") this._destroy = options.destroy;
			if (typeof options.final === "function") this._final = options.final;
			if (typeof options.construct === "function") this._construct = options.construct;
			if (options.signal) addAbortSignal(options.signal, this);
		}
		Stream.call(this, options);
		construct(this, () => {
			const state = this._writableState;
			if (!state.writing) clearBuffer(this, state);
			finishMaybe(this, state);
		});
	}
	Object.setPrototypeOf(Writable.prototype, Stream.prototype);
	Object.setPrototypeOf(Writable, Stream);
	Object.defineProperty(Writable, Symbol.hasInstance, {
		value(object) {
			if (hasInstance.call(this, object)) return true;
			if (this !== Writable) return false;
			return Boolean(object?._writableState instanceof WritableState);
		},
	});

	Writable.prototype.pipe = function () {
		errorOrDestroy(this, ERR.cannotPipe());
	};

	function writeOrBuffer(stream, state, chunk, encoding, callback) {
		const len = state.objectMode ? 1 : chunk.length;
		state.length += len;
		const ret = state.length < state.highWaterMark;
		if (!ret) state.needDrain = true;
		if (state.writing || state.corked || state.errored || !state.constructed) {
			state.buffered.push({ chunk, encoding, callback });
			if (state.allBuffers && encoding !== "buffer") state.allBuffers = false;
			if (state.allNoop && callback !== nop) state.allNoop = false;
		} else {
			state.writelen = len;
			state.writecb = callback;
			state.writing = true;
			state.sync = true;
			stream._write(chunk, encoding, state.onwrite);
			state.sync = false;
		}
		return ret && !state.errored && !state.destroyed;
	}

	function doWrite(stream, state, writev, len, chunk, encoding, cb) {
		state.writelen = len;
		state.writecb = cb;
		state.writing = true;
		state.sync = true;
		if (state.destroyed) state.onwrite(ERR.destroyed("write"));
		else if (writev) stream._writev(chunk, state.onwrite);
		else stream._write(chunk, encoding, state.onwrite);
		state.sync = false;
	}

	function onwriteError(stream, state, er, cb) {
		--state.pendingcb;
		cb(er);
		errorBuffer(state);
		errorOrDestroy(stream, er);
	}

	function onwrite(stream, er) {
		const state = stream._writableState;
		const sync = state.sync;
		const cb = state.writecb;
		if (typeof cb !== "function") {
			errorOrDestroy(stream, makeError(Error, "ERR_MULTIPLE_CALLBACK", "Callback called multiple times"));
			return;
		}
		state.writing = false;
		state.writecb = null;
		state.length -= state.writelen;
		state.writelen = 0;
		if (er) {
			if (!state.errored) state.errored = er;
			if (stream._readableState && !stream._readableState.errored) stream._readableState.errored = er;
			if (sync) nextTick(onwriteError, stream, state, er, cb);
			else onwriteError(stream, state, er, cb);
		} else {
			if (state.buffered.length > state.bufferedIndex) clearBuffer(stream, state);
			if (sync) {
				if (state.afterWriteTickInfo !== null && state.afterWriteTickInfo.cb === cb) state.afterWriteTickInfo.count++;
				else {
					state.afterWriteTickInfo = { count: 1, cb, stream, state };
					nextTick(afterWriteTick, state.afterWriteTickInfo);
				}
			} else afterWrite(stream, state, 1, cb);
		}
	}

	function afterWriteTick({ stream, state, count, cb }) {
		state.afterWriteTickInfo = null;
		return afterWrite(stream, state, count, cb);
	}

	function afterWrite(stream, state, count, cb) {
		const needDrain = !state.ending && !stream.destroyed && state.length === 0 && state.needDrain;
		if (needDrain) {
			state.needDrain = false;
			stream.emit("drain");
		}
		while (count-- > 0) {
			state.pendingcb--;
			cb(null);
		}
		if (state.destroyed) errorBuffer(state);
		finishMaybe(stream, state);
	}

	function errorBuffer(state) {
		if (state.writing) return;
		for (let n = state.bufferedIndex; n < state.buffered.length; ++n) {
			const { chunk, callback } = state.buffered[n];
			const len = state.objectMode ? 1 : chunk.length;
			state.length -= len;
			callback(state.errored ?? ERR.destroyed("write"));
		}
		state.buffered = [];
		state.bufferedIndex = 0;
		state.allBuffers = true;
		state.allNoop = true;
	}

	function clearBuffer(stream, state) {
		if (state.corked || state.bufferProcessing || state.destroyed || !state.constructed) return;
		const { buffered, bufferedIndex, objectMode } = state;
		const bufferedLength = buffered.length - bufferedIndex;
		if (!bufferedLength) return;
		let i = bufferedIndex;
		state.bufferProcessing = true;
		if (bufferedLength > 1 && stream._writev) {
			state.pendingcb -= bufferedLength - 1;
			const callback = state.allNoop
				? nop
				: (err) => {
						for (let n = i; n < buffered.length; ++n) buffered[n].callback(err);
				  };
			const chunks = state.allNoop && i === 0 ? buffered : buffered.slice(i);
			chunks.allBuffers = state.allBuffers;
			doWrite(stream, state, true, state.length, chunks, "", callback);
			state.buffered = [];
			state.bufferedIndex = 0;
			state.allBuffers = true;
			state.allNoop = true;
		} else {
			do {
				const { chunk, encoding, callback } = buffered[i];
				buffered[i++] = null;
				const len = objectMode ? 1 : chunk.length;
				doWrite(stream, state, false, len, chunk, encoding, callback);
			} while (i < buffered.length && !state.writing);
			if (i === buffered.length) {
				state.buffered = [];
				state.bufferedIndex = 0;
				state.allBuffers = true;
				state.allNoop = true;
			} else if (i > 256) {
				buffered.splice(0, i);
				state.bufferedIndex = 0;
			} else state.bufferedIndex = i;
		}
		state.bufferProcessing = false;
	}

	Writable.prototype._write = function (chunk, encoding, cb) {
		if (this._writev) this._writev([{ chunk, encoding }], cb);
		else throw ERR.notImplemented("_write()");
	};
	Writable.prototype._writev = null;

	Writable.prototype.write = function write(chunk, encoding, cb) {
		const state = this._writableState;
		if (typeof encoding === "function") {
			cb = encoding;
			encoding = state.defaultEncoding;
		} else {
			if (!encoding) encoding = state.defaultEncoding;
			if (typeof cb !== "function") cb = nop;
		}
		if (chunk === null) throw ERR.nullValues();
		if (!state.objectMode) {
			if (typeof chunk === "string") {
				if (state.decodeStrings !== false) {
					chunk = Buffer.from(chunk, encoding);
					encoding = "buffer";
				}
			} else if (chunk instanceof Buffer) encoding = "buffer";
			else if (chunk instanceof Uint8Array) {
				chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
				encoding = "buffer";
			} else throw ERR.invalidArg("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", chunk);
		}
		let err;
		if (state.ending) err = ERR.writeAfterEnd();
		else if (state.destroyed) err = ERR.destroyed("write");
		if (err) {
			nextTick(cb, err);
			errorOrDestroy(this, err, true);
			return false;
		}
		state.pendingcb++;
		return writeOrBuffer(this, state, chunk, encoding, cb);
	};

	Writable.prototype.cork = function cork() {
		this._writableState.corked++;
	};
	Writable.prototype.uncork = function uncork() {
		const state = this._writableState;
		if (state.corked) {
			state.corked--;
			if (!state.writing) clearBuffer(this, state);
		}
	};
	Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
		if (typeof encoding === "string") encoding = encoding.toLowerCase();
		if (!Buffer.isEncoding(encoding)) throw makeError(TypeError, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${encoding}`);
		this._writableState.defaultEncoding = encoding;
		return this;
	};

	Writable.prototype.end = function end(chunk, encoding, cb) {
		const state = this._writableState;
		if (typeof chunk === "function") {
			cb = chunk;
			chunk = null;
			encoding = null;
		} else if (typeof encoding === "function") {
			cb = encoding;
			encoding = null;
		}
		let err;
		if (chunk !== null && chunk !== undefined) {
			const ret = this.write(chunk, encoding);
			if (ret instanceof Error) err = ret;
		}
		if (state.corked) {
			state.corked = 1;
			this.uncork();
		}
		if (err) {
			// Already reported by write().
		} else if (!state.errored && !state.ending) {
			state.ending = true;
			finishMaybe(this, state, true);
			state.ended = true;
		} else if (state.finished) err = ERR.alreadyFinished();
		else if (state.destroyed) err = ERR.destroyed("end");
		if (typeof cb === "function") {
			if (err || state.finished) nextTick(cb, err);
			else state.finishCallbacks.push(cb);
		}
		return this;
	};

	function needFinish(state) {
		return state.ending && !state.destroyed && state.constructed && state.length === 0 && !state.errored && state.buffered.length === 0 && !state.finished && !state.writing && !state.errorEmitted && !state.closeEmitted;
	}

	function callFinal(stream, state) {
		let called = false;
		function onFinish(err) {
			if (called) {
				errorOrDestroy(stream, makeError(Error, "ERR_MULTIPLE_CALLBACK", "Callback called multiple times"));
				return;
			}
			called = true;
			state.pendingcb--;
			if (err) {
				for (const cb of state.finishCallbacks.splice(0)) cb(err);
				errorOrDestroy(stream, err, state.sync);
			} else if (needFinish(state)) {
				state.prefinished = true;
				stream.emit("prefinish");
				state.pendingcb++;
				nextTick(finish, stream, state);
			}
		}
		state.sync = true;
		state.pendingcb++;
		try {
			stream._final(onFinish);
		} catch (err) {
			onFinish(err);
		}
		state.sync = false;
	}

	function prefinish(stream, state) {
		if (!state.prefinished && !state.finalCalled) {
			if (typeof stream._final === "function" && !state.destroyed) {
				state.finalCalled = true;
				callFinal(stream, state);
			} else {
				state.prefinished = true;
				stream.emit("prefinish");
			}
		}
	}

	function finishMaybe(stream, state, sync) {
		if (needFinish(state)) {
			prefinish(stream, state);
			if (state.pendingcb === 0) {
				if (sync) {
					state.pendingcb++;
					nextTick((stream, state) => {
						if (needFinish(state)) finish(stream, state);
						else state.pendingcb--;
					}, stream, state);
				} else if (needFinish(state)) {
					state.pendingcb++;
					finish(stream, state);
				}
			}
		}
	}

	function finish(stream, state) {
		state.pendingcb--;
		state.finished = true;
		for (const cb of state.finishCallbacks.splice(0)) cb();
		stream.emit("finish");
		if (state.autoDestroy) {
			const rState = stream._readableState;
			const autoDestroy = !rState || (rState.autoDestroy && (rState.endEmitted || rState.readable === false));
			if (autoDestroy) stream.destroy();
		}
	}

	for (const [name, getter] of Object.entries({
		closed: function () {
			return this._writableState ? this._writableState.closed : false;
		},
		writable: function () {
			const w = this._writableState;
			return Boolean(w) && w.writable !== false && !w.destroyed && !w.errored && !w.ending && !w.ended;
		},
		writableFinished: function () {
			return this._writableState ? this._writableState.finished : false;
		},
		writableObjectMode: function () {
			return this._writableState ? this._writableState.objectMode : false;
		},
		writableBuffer: function () {
			return this._writableState?.getBuffer();
		},
		writableEnded: function () {
			return this._writableState ? this._writableState.ending : false;
		},
		writableNeedDrain: function () {
			const w = this._writableState;
			if (!w) return false;
			return !w.destroyed && !w.ending && w.needDrain;
		},
		writableHighWaterMark: function () {
			return this._writableState?.highWaterMark;
		},
		writableCorked: function () {
			return this._writableState ? this._writableState.corked : 0;
		},
		writableLength: function () {
			return this._writableState?.length;
		},
		errored: function () {
			return this._writableState ? this._writableState.errored : null;
		},
		writableAborted: function () {
			return Boolean(this._writableState.writable !== false && (this._writableState.destroyed || this._writableState.errored) && !this._writableState.finished);
		},
	})) {
		Object.defineProperty(Writable.prototype, name, {
			get: getter,
			set:
				name === "writable"
					? function (val) {
							if (this._writableState) this._writableState.writable = Boolean(val);
					  }
					: undefined,
			configurable: true,
			enumerable: false,
		});
	}
	Object.defineProperty(Writable.prototype, "destroyed", {
		get() {
			return this._writableState ? this._writableState.destroyed : false;
		},
		set(value) {
			if (this._writableState) this._writableState.destroyed = value;
		},
		configurable: true,
		enumerable: false,
	});
	Writable.prototype.destroy = function (err, cb) {
		const state = this._writableState;
		if (!state.destroyed && (state.bufferedIndex < state.buffered.length || state.finishCallbacks.length)) nextTick(errorBuffer, state);
		destroy.call(this, err, cb);
		return this;
	};
	Writable.prototype._undestroy = function () {
		const w = this._writableState;
		w.constructed = true;
		w.destroyed = false;
		w.closed = false;
		w.closeEmitted = false;
		w.errored = null;
		w.errorEmitted = false;
		w.finalCalled = false;
		w.prefinished = false;
		w.ended = false;
		w.ending = false;
		w.finished = false;
	};
	Writable.prototype._destroy = function (err, cb) {
		cb(err);
	};
	Writable.fromWeb = (webStream, options) => {
		const writer = webStream.getWriter();
		return new Writable({
			...options,
			write(chunk, enc, cb) {
				writer.write(chunk).then(() => cb(), cb);
			},
			final(cb) {
				writer.close().then(() => cb(), cb);
			},
			destroy(err, cb) {
				writer.abort(err).then(() => cb(err), () => cb(err));
			},
		});
	};
	Writable.toWeb = (writable) =>
		new web.WritableStream({
			write(chunk) {
				return new Promise((resolve, reject) => writable.write(chunk, (err) => (err ? reject(err) : resolve())));
			},
			close() {
				return new Promise((resolve, reject) => writable.end((err) => (err ? reject(err) : resolve())));
			},
			abort(reason) {
				writable.destroy(reason);
			},
		});

	/* -------------------------------------------------------------------- Duplex */

	function Duplex(options) {
		if (!(this instanceof Duplex)) return new Duplex(options);
		Readable.call(this, options);
		Writable.call(this, options);
		if (options) {
			this.allowHalfOpen = options.allowHalfOpen !== false;
			if (options.readable === false) {
				this._readableState.readable = false;
				this._readableState.ended = true;
				this._readableState.endEmitted = true;
			}
			if (options.writable === false) {
				this._writableState.writable = false;
				this._writableState.ending = true;
				this._writableState.ended = true;
				this._writableState.finished = true;
			}
		} else this.allowHalfOpen = true;
	}
	Object.setPrototypeOf(Duplex.prototype, Readable.prototype);
	Object.setPrototypeOf(Duplex, Readable);
	for (const method of Object.keys(Writable.prototype)) {
		if (!Duplex.prototype[method]) Duplex.prototype[method] = Writable.prototype[method];
	}
	for (const name of Object.getOwnPropertyNames(Writable.prototype)) {
		// What Duplex already resolves (through Readable) stays: Writable's `pipe` would replace the real one.
		if (name === "constructor" || name in Duplex.prototype) continue;
		const descriptor = Object.getOwnPropertyDescriptor(Writable.prototype, name);
		if (!descriptor) continue;
		// Readable's closed/errored/destroyed already cover the shared state; the rest are Writable's.
		Object.defineProperty(Duplex.prototype, name, descriptor);
	}
	Object.defineProperty(Duplex.prototype, "destroyed", {
		get() {
			if (this._readableState === undefined || this._writableState === undefined) return false;
			return this._readableState.destroyed && this._writableState.destroyed;
		},
		set(value) {
			if (this._readableState && this._writableState) {
				this._readableState.destroyed = value;
				this._writableState.destroyed = value;
			}
		},
		configurable: true,
		enumerable: false,
	});
	Duplex.prototype.destroy = function (err, cb) {
		const w = this._writableState;
		if (!w.destroyed && (w.bufferedIndex < w.buffered.length || w.finishCallbacks.length)) nextTick(errorBuffer, w);
		destroy.call(this, err, cb);
		return this;
	};
	Duplex.from = function (body) {
		if (body instanceof Duplex) return body;
		if (typeof body?.pipe === "function") return body;
		if (typeof body?.[Symbol.asyncIterator] === "function" || typeof body?.[Symbol.iterator] === "function") {
			return Object.assign(Readable.from(body), {});
		}
		throw ERR.invalidArg("body", "a stream, iterable or function", body);
	};

	/* ----------------------------------------------------------------- Transform */

	function Transform(options) {
		if (!(this instanceof Transform)) return new Transform(options);
		const readableHighWaterMark = options ? highWaterMarkOf(options, "readableHighWaterMark", Boolean(options.objectMode || options.readableObjectMode), true) : null;
		if (readableHighWaterMark === 0) options = { ...options, highWaterMark: null, readableHighWaterMark, writableHighWaterMark: options.writableHighWaterMark || 0 };
		Duplex.call(this, options);
		this._readableState.sync = false;
		this._callback = null;
		if (options) {
			if (typeof options.transform === "function") this._transform = options.transform;
			if (typeof options.flush === "function") this._flush = options.flush;
		}
		this.on("prefinish", prefinishTransform);
	}
	Object.setPrototypeOf(Transform.prototype, Duplex.prototype);
	Object.setPrototypeOf(Transform, Duplex);

	function finalTransform(cb) {
		if (typeof this._flush === "function" && !this.destroyed) {
			this._flush((er, data) => {
				if (er) {
					if (cb) cb(er);
					else this.destroy(er);
					return;
				}
				if (data != null) this.push(data);
				this.push(null);
				if (cb) cb();
			});
		} else {
			this.push(null);
			if (cb) cb();
		}
	}
	function prefinishTransform() {
		if (this._final !== finalTransform) finalTransform.call(this);
	}
	Transform.prototype._final = finalTransform;
	Transform.prototype._transform = function () {
		throw ERR.notImplemented("_transform()");
	};
	Transform.prototype._write = function (chunk, encoding, callback) {
		const rState = this._readableState;
		const wState = this._writableState;
		const length = rState.length;
		this._transform(chunk, encoding, (err, val) => {
			if (err) {
				callback(err);
				return;
			}
			if (val != null) this.push(val);
			if (wState.ended || length === rState.length || rState.length < rState.highWaterMark) callback();
			else this._callback = callback;
		});
	};
	Transform.prototype._read = function () {
		if (this._callback) {
			const callback = this._callback;
			this._callback = null;
			callback();
		}
	};

	function PassThrough(options) {
		if (!(this instanceof PassThrough)) return new PassThrough(options);
		Transform.call(this, options);
	}
	Object.setPrototypeOf(PassThrough.prototype, Transform.prototype);
	Object.setPrototypeOf(PassThrough, Transform);
	PassThrough.prototype._transform = function (chunk, encoding, cb) {
		cb(null, chunk);
	};

	/* ------------------------------------------------------------------ pipeline */

	function addAbortSignal(signal, stream) {
		if (typeof signal?.aborted !== "boolean") throw ERR.invalidArg("signal", "an instance of AbortSignal", signal);
		const onAbort = () => stream.destroy(ERR.abort(signal.reason));
		if (signal.aborted) onAbort();
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			eos(stream, () => signal.removeEventListener("abort", onAbort));
		}
		return stream;
	}

	function pipeline(...streams) {
		let callback = typeof streams[streams.length - 1] === "function" ? streams.pop() : null;
		if (streams.length === 1 && Array.isArray(streams[0])) streams = streams[0];
		if (streams.length < 2) throw makeError(TypeError, "ERR_MISSING_ARGS", 'The "streams" argument must be specified');
		let error;
		let value;
		const destroys = [];
		const cleanups = [];
		let finishCount = 0;
		function finish(err) {
			finishImpl(err, --finishCount === 0);
		}
		function finishImpl(err, final) {
			if (err && (!error || error.code === "ERR_STREAM_PREMATURE_CLOSE")) error = err;
			if (!error && !final) return;
			while (destroys.length) destroys.shift()(error);
			if (final) {
				// On failure the listeners stay: the streams destroyed above still emit their errors, and
				// something has to be listening when they do.
				if (!error) while (cleanups.length) cleanups.shift()();
				if (callback) nextTick(callback, error, value);
			}
		}
		let ret;
		for (let i = 0; i < streams.length; i++) {
			const stream = streams[i];
			const reading = i < streams.length - 1;
			const writing = i > 0;
			if (isNodeStream(stream)) {
				finishCount++;
				const { destroy: destroyStream, cleanup } = destroyOnFinish(stream, reading, writing, finish);
				destroys.push(destroyStream);
				cleanups.push(cleanup);
			}
			if (i === 0) {
				if (typeof stream === "function") {
					ret = stream({ signal: undefined });
					if (!ret || (typeof ret[Symbol.asyncIterator] !== "function" && typeof ret[Symbol.iterator] !== "function" && typeof ret.then !== "function")) {
						throw makeError(TypeError, "ERR_INVALID_RETURN_VALUE", "Expected Iterable, AsyncIterable or Stream to be returned from the source function");
					}
					if (typeof ret[Symbol.asyncIterator] === "function" || typeof ret[Symbol.iterator] === "function") ret = Readable.from(ret);
				} else if (isNodeStream(stream)) ret = stream;
				else ret = Readable.from(stream);
			} else if (typeof stream === "function") {
				const source = isNodeStream(ret) ? ret : Readable.from(ret);
				ret = stream(source, { signal: undefined });
				if (reading) {
					if (!ret || typeof ret[Symbol.asyncIterator] !== "function") {
						throw makeError(TypeError, "ERR_INVALID_RETURN_VALUE", "Expected AsyncIterable to be returned from the transform function");
					}
					ret = Readable.from(ret);
					finishCount++;
					const { destroy: destroyStream, cleanup } = destroyOnFinish(ret, true, false, finish);
					destroys.push(destroyStream);
					cleanups.push(cleanup);
				} else {
					finishCount++;
					Promise.resolve(ret).then(
						(v) => {
							value = v;
							finish();
						},
						(err) => finish(err)
					);
				}
			} else if (isNodeStream(stream)) {
				if (isReadableNodeStream(ret)) {
					ret.pipe(stream);
					if (stream === globalThis.process?.stdout || stream === globalThis.process?.stderr) ret.on("end", () => stream.end?.());
				} else ret = Readable.from(ret).pipe(stream);
				ret = stream;
			} else throw ERR.invalidArg(`streams[${i}]`, "a stream or function", stream);
		}
		return ret;
	}

	function destroyOnFinish(stream, reading, writing, callback) {
		let finished = false;
		stream.on("close", () => {
			finished = true;
		});
		const cleanup = eos(stream, { readable: reading, writable: writing }, (err) => {
			finished = !err;
			callback(err);
		});
		return {
			destroy: (err) => {
				if (finished) return;
				finished = true;
				destroyer(stream, err || ERR.prematureClose());
			},
			cleanup,
		};
	}

	const promises = {
		pipeline: (...streams) =>
			new Promise((resolve, reject) => {
				let signal;
				const last = streams[streams.length - 1];
				if (last && typeof last === "object" && !isNodeStream(last) && !Array.isArray(last) && typeof last[Symbol.asyncIterator] !== "function") {
					signal = last.signal;
					streams.pop();
				}
				const stream = pipeline(...streams, (err, value) => (err ? reject(err) : resolve(value)));
				if (signal) addAbortSignal(signal, stream);
			}),
		finished: (stream, options) =>
			new Promise((resolve, reject) => {
				eos(stream, options ?? {}, (err) => (err ? reject(err) : resolve()));
			}),
	};

	function compose(...streams) {
		if (streams.length === 1) return streams[0];
		const head = streams[0];
		const tail = streams[streams.length - 1];
		const composed = new Duplex({
			objectMode: true,
			write(chunk, enc, cb) {
				head.write(chunk, enc) ? cb() : head.once("drain", cb);
			},
			final(cb) {
				head.end();
				cb();
			},
			read() {
				tail.resume();
			},
		});
		tail.on("data", (chunk) => composed.push(chunk));
		tail.on("end", () => composed.push(null));
		pipeline(...streams, () => {});
		return composed;
	}

	/* ------------------------------------------------------------------ exports */

	Stream.Stream = Stream;
	Stream.Readable = Readable;
	Stream.Writable = Writable;
	Stream.Duplex = Duplex;
	Stream.Transform = Transform;
	Stream.PassThrough = PassThrough;
	Stream.pipeline = pipeline;
	Stream.finished = eos;
	Stream.addAbortSignal = addAbortSignal;
	Stream.compose = compose;
	Stream.destroy = destroyer;
	Stream.promises = promises;
	Stream.isReadable = (stream) => Boolean(stream && stream.readable && !stream.destroyed);
	Stream.isWritable = (stream) => Boolean(stream && stream.writable && !stream.destroyed);
	Stream.isErrored = (stream) => Boolean(stream && (stream.errored || stream._readableState?.errored || stream._writableState?.errored));
	Stream.isDisturbed = Readable.isDisturbed;
	Stream.isDestroyed = (stream) => Boolean(stream?.destroyed);
	Stream.getDefaultHighWaterMark = (objectMode) => (objectMode ? defaultObjectHighWaterMark : defaultHighWaterMark);
	Stream.setDefaultHighWaterMark = (objectMode, value) => {
		if (objectMode) defaultObjectHighWaterMark = value;
		else defaultHighWaterMark = value;
	};
	Object.defineProperty(promises.pipeline, "custom", { value: promises.pipeline });
	Object.defineProperty(pipeline, Symbol.for("nodejs.util.promisify.custom"), { value: promises.pipeline, enumerable: false });
	Object.defineProperty(eos, Symbol.for("nodejs.util.promisify.custom"), { value: promises.finished, enumerable: false });

	return Stream;
}

/* stream/consumers: read a whole stream into one value. */
function createConsumers(Buffer) {
	const collect = async (stream) => {
		const chunks = [];
		for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		return Buffer.concat(chunks);
	};
	return {
		buffer: collect,
		arrayBuffer: async (stream) => {
			const buf = await collect(stream);
			return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		},
		text: async (stream) => (await collect(stream)).toString("utf8"),
		json: async (stream) => JSON.parse((await collect(stream)).toString("utf8")),
		blob: async (stream) => new globalThis.Blob([await collect(stream)]),
	};
}

export { createStreamModule, createConsumers };

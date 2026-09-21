/*
 * The Fetch API: Headers, FormData, Request, Response and fetch(), following the WHATWG spec where
 * programs can observe it -- header semantics, body consumption and cloning, content-type inference,
 * redirects, aborting -- and running over the http/https client in node-http.js, so bodies stream.
 *
 * Server frameworks lean on this too (Hono, and anything built on Request/Response): a handler
 * returns a Response, and the server reads its body as a ReadableStream.
 */

import { Blob, File, ReadableStream } from "./node-web.js";

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);

function concatBytes(parts) {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

const bodyUnusable = () => new TypeError("Body is unusable: Body has already been read");

/* ------------------------------------------------------------------ Headers */

function normalizeValue(value) {
	return String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
}

class Headers {
	#map = new Map(); // lowercase name -> { name, values: [] }

	constructor(init) {
		if (init === undefined || init === null) return;
		if (init instanceof Headers) {
			for (const [name, value] of init) this.append(name, value);
		} else if (typeof init === "object" || typeof init === "function") {
			if (typeof init[Symbol.iterator] === "function") {
				for (const pair of init) {
					const items = [...pair];
					if (items.length !== 2) throw new TypeError("Headers constructor: expected name/value pair to be length 2");
					this.append(items[0], items[1]);
				}
			} else {
				for (const key of Reflect.ownKeys(init)) {
					if (typeof key === "symbol") continue;
					this.append(key, init[key]);
				}
			}
		} else {
			throw new TypeError("Headers constructor: The provided value is not of type '(record<ByteString, ByteString> or sequence<sequence<ByteString>>)'");
		}
	}

	#check(name) {
		name = String(name);
		if (!TOKEN.test(name)) throw new TypeError(`Headers: "${name}" is an invalid header name.`);
		return name;
	}

	append(name, value) {
		name = this.#check(name);
		const key = name.toLowerCase();
		const entry = this.#map.get(key);
		if (entry) entry.values.push(normalizeValue(value));
		else this.#map.set(key, { name: key, values: [normalizeValue(value)] });
	}
	set(name, value) {
		name = this.#check(name);
		const key = name.toLowerCase();
		this.#map.set(key, { name: key, values: [normalizeValue(value)] });
	}
	get(name) {
		const entry = this.#map.get(this.#check(name).toLowerCase());
		return entry ? entry.values.join(", ") : null;
	}
	getSetCookie() {
		return [...(this.#map.get("set-cookie")?.values ?? [])];
	}
	has(name) {
		return this.#map.has(this.#check(name).toLowerCase());
	}
	delete(name) {
		this.#map.delete(this.#check(name).toLowerCase());
	}
	forEach(callback, thisArg) {
		for (const [name, value] of this) callback.call(thisArg, value, name, this);
	}
	*entries() {
		// Sorted by name, one entry per Set-Cookie, as the spec's iteration order requires.
		for (const key of [...this.#map.keys()].sort()) {
			const entry = this.#map.get(key);
			if (key === "set-cookie") for (const value of entry.values) yield [key, value];
			else yield [key, entry.values.join(", ")];
		}
	}
	*keys() {
		for (const [name] of this.entries()) yield name;
	}
	*values() {
		for (const [, value] of this.entries()) yield value;
	}
	[Symbol.iterator]() {
		return this.entries();
	}
	get [Symbol.toStringTag]() {
		return "Headers";
	}
	/* Node's own inspect shows the entries; this is what console.log(headers) prints. */
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return `Headers ${JSON.stringify(Object.fromEntries(this.entries()))}`;
	}
}

/* ----------------------------------------------------------------- FormData */

class FormData {
	#entries = [];

	constructor(form) {
		if (form !== undefined) throw new TypeError("FormData constructor: HTML forms are not supported");
	}

	static #toValue(value, filename) {
		if (value instanceof Blob) {
			if (value instanceof File && filename === undefined) return value;
			return new File([value], filename ?? (value instanceof File ? value.name : "blob"), { type: value.type });
		}
		return String(value);
	}

	append(name, value, filename) {
		this.#entries.push([String(name), FormData.#toValue(value, filename)]);
	}
	set(name, value, filename) {
		name = String(name);
		const item = [name, FormData.#toValue(value, filename)];
		const at = this.#entries.findIndex(([n]) => n === name);
		if (at < 0) this.#entries.push(item);
		else {
			this.#entries[at] = item;
			this.#entries = this.#entries.filter(([n], i) => n !== name || i === at);
		}
	}
	get(name) {
		return this.#entries.find(([n]) => n === String(name))?.[1] ?? null;
	}
	getAll(name) {
		return this.#entries.filter(([n]) => n === String(name)).map(([, v]) => v);
	}
	has(name) {
		return this.#entries.some(([n]) => n === String(name));
	}
	delete(name) {
		this.#entries = this.#entries.filter(([n]) => n !== String(name));
	}
	forEach(callback, thisArg) {
		for (const [name, value] of this) callback.call(thisArg, value, name, this);
	}
	*entries() {
		for (const [name, value] of this.#entries) yield [name, value];
	}
	*keys() {
		for (const [name] of this.#entries) yield name;
	}
	*values() {
		for (const [, value] of this.#entries) yield value;
	}
	[Symbol.iterator]() {
		return this.entries();
	}
	get [Symbol.toStringTag]() {
		return "FormData";
	}
}

function encodeMultipart(form) {
	const boundary = `----formdata-graak-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
	const parts = [];
	const quote = (text) => text.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
	for (const [name, value] of form) {
		if (typeof value === "string") {
			parts.push(encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value.replace(/\r?\n|\r/g, "\r\n")}\r\n`));
		} else {
			parts.push(
				encode(
					`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"; filename="${quote(value.name)}"\r\n` +
						`Content-Type: ${value.type || "application/octet-stream"}\r\n\r\n`
				),
				value._bytes,
				encode("\r\n")
			);
		}
	}
	parts.push(encode(`--${boundary}--\r\n`));
	return { bytes: concatBytes(parts), type: `multipart/form-data; boundary=${boundary}` };
}

function decodeMultipart(bytes, contentType) {
	const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
	if (!match) throw new TypeError("multipart/form-data body has no boundary");
	const boundary = encode(`--${match[1] ?? match[2]}`);
	const form = new FormData();
	const find = (needle, from) => {
		outer: for (let i = from; i <= bytes.length - needle.length; i++) {
			for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
			return i;
		}
		return -1;
	};
	let at = find(boundary, 0);
	while (at >= 0) {
		const start = at + boundary.length;
		if (bytes[start] === 45 && bytes[start + 1] === 45) break; // closing "--"
		const next = find(boundary, start);
		if (next < 0) break;
		// The part is between the boundary line's CRLF and the CRLF before the next boundary.
		const part = bytes.subarray(start + 2, next - 2);
		let headEnd = -1;
		for (let i = 0; i + 3 < part.length; i++) {
			if (part[i] === 13 && part[i + 1] === 10 && part[i + 2] === 13 && part[i + 3] === 10) {
				headEnd = i;
				break;
			}
		}
		if (headEnd >= 0) {
			const head = decode(part.subarray(0, headEnd));
			const body = part.subarray(headEnd + 4);
			const name = /name="([^"]*)"/i.exec(head)?.[1] ?? "";
			const filename = /filename="([^"]*)"/i.exec(head)?.[1];
			const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "";
			if (filename !== undefined) form.append(name, new File([body.slice()], filename, { type }));
			else form.append(name, decode(body));
		}
		at = next;
	}
	return form;
}

/* --------------------------------------------------------------------- Body */

/* The value handed to a Request/Response constructor, as { bytes | stream, type }. */
function extractBody(body) {
	if (body === null || body === undefined) return { bytes: null, stream: null, type: null };
	if (typeof body === "string") return { bytes: encode(body), stream: null, type: "text/plain;charset=UTF-8" };
	if (body instanceof URLSearchParams) {
		return { bytes: encode(body.toString()), stream: null, type: "application/x-www-form-urlencoded;charset=UTF-8" };
	}
	if (body instanceof Blob) return { bytes: body._bytes, stream: null, type: body.type || null };
	if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body.slice(0)), stream: null, type: null };
	if (ArrayBuffer.isView(body)) {
		return { bytes: new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)), stream: null, type: null };
	}
	if (body instanceof FormData) {
		const { bytes, type } = encodeMultipart(body);
		return { bytes, stream: null, type };
	}
	if (body instanceof ReadableStream) return { bytes: null, stream: body, type: null };
	if (typeof body[Symbol.asyncIterator] === "function" || typeof body[Symbol.iterator] === "function") {
		return { bytes: null, stream: ReadableStream.from(body), type: null };
	}
	return { bytes: encode(String(body)), stream: null, type: "text/plain;charset=UTF-8" };
}

async function drain(stream) {
	const chunks = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(typeof value === "string" ? encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value));
	}
	return concatBytes(chunks);
}

/* Shared by Request and Response. */
class BodyState {
	constructor(extracted) {
		this.bytes = extracted.bytes;
		this.stream = extracted.stream;
		this.used = false;
		this.exposed = null;
	}
	get hasBody() {
		return this.bytes !== null || this.stream !== null;
	}
	/* The ReadableStream view of the body; null when there is none. */
	get streamView() {
		if (this.exposed) return this.exposed;
		if (this.stream) return (this.exposed = this.stream);
		if (this.bytes === null) return null;
		const bytes = this.bytes;
		let sent = false;
		return (this.exposed = new ReadableStream({
			pull: (controller) => {
				if (sent) return;
				sent = true;
				if (bytes.length) controller.enqueue(bytes);
				controller.close();
			},
		}));
	}
	async consume() {
		if (this.used) throw bodyUnusable();
		this.used = true;
		if (this.bytes !== null) return this.bytes;
		if (this.stream) return drain(this.stream);
		return new Uint8Array(0);
	}
	clone() {
		if (this.used) throw new TypeError("Response.clone: Body has already been consumed.");
		if (this.stream) {
			const [a, b] = this.stream.tee();
			this.stream = a;
			this.exposed = null;
			return { bytes: null, stream: b, type: null };
		}
		return { bytes: this.bytes, stream: null, type: null };
	}
}

function installBodyMixin(Class, stateKey) {
	const state = (self) => self[stateKey];
	Object.defineProperties(Class.prototype, {
		body: {
			get() {
				return state(this).streamView;
			},
			enumerable: true,
			configurable: true,
		},
		bodyUsed: {
			get() {
				return state(this).used || Boolean(state(this).exposed?.locked && state(this).stream);
			},
			enumerable: true,
			configurable: true,
		},
	});
	const methods = {
		async arrayBuffer() {
			const bytes = await state(this).consume();
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		},
		async bytes() {
			return (await state(this).consume()).slice();
		},
		async text() {
			return decode(await state(this).consume());
		},
		async json() {
			return JSON.parse(decode(await state(this).consume()));
		},
		async blob() {
			const bytes = await state(this).consume();
			return new Blob([bytes], { type: this.headers.get("content-type") ?? "" });
		},
		async formData() {
			const type = this.headers.get("content-type") ?? "";
			const bytes = await state(this).consume();
			if (/^multipart\/form-data/i.test(type)) return decodeMultipart(bytes, type);
			if (/^application\/x-www-form-urlencoded/i.test(type)) {
				const form = new FormData();
				for (const [name, value] of new URLSearchParams(decode(bytes))) form.append(name, value);
				return form;
			}
			throw new TypeError("Content-Type was not one of \"multipart/form-data\" or \"application/x-www-form-urlencoded\".");
		},
	};
	for (const [name, fn] of Object.entries(methods)) {
		Object.defineProperty(Class.prototype, name, { value: fn, writable: true, configurable: true, enumerable: true });
	}
}

/* ------------------------------------------------------------------ Request */

class Request {
	#body;
	#url;
	#method;
	#headers;
	#signal;
	#init;

	constructor(input, init = {}) {
		let source = null;
		if (input instanceof Request) {
			source = input;
			this.#url = input.url;
			this.#method = input.method;
			this.#headers = new Headers(input.headers);
			this.#signal = input.signal;
		} else {
			let parsed;
			try {
				parsed = new URL(String(input));
			} catch (cause) {
				throw Object.assign(new TypeError(`Failed to parse URL from ${input}`), { cause });
			}
			if (parsed.username || parsed.password) {
				throw new TypeError("Request cannot be constructed from a URL that includes credentials: " + input);
			}
			this.#url = parsed.href;
			this.#method = "GET";
			this.#headers = new Headers();
			this.#signal = null;
		}
		if (init.method !== undefined) {
			const method = String(init.method);
			if (!TOKEN.test(method)) throw new TypeError(`'${method}' is not a valid HTTP method.`);
			const upper = method.toUpperCase();
			if (["CONNECT", "TRACE", "TRACK"].includes(upper)) throw new TypeError(`'${method}' HTTP method is unsupported.`);
			this.#method = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].includes(upper) ? upper : method;
		}
		if (init.headers !== undefined) this.#headers = new Headers(init.headers);
		if (init.signal !== undefined && init.signal !== null) this.#signal = init.signal;
		this.#signal ??= new AbortController().signal;

		let extracted = { bytes: null, stream: null, type: null };
		if (init.body !== undefined && init.body !== null) {
			if (this.#method === "GET" || this.#method === "HEAD") throw new TypeError("Request with GET/HEAD method cannot have body.");
			extracted = extractBody(init.body);
			if (extracted.type && !this.#headers.has("content-type")) this.#headers.set("content-type", extracted.type);
		} else if (source && source.body !== null) {
			if (source.bodyUsed) throw bodyUnusable();
			extracted = { bytes: null, stream: null, type: null };
			const carried = source.#body;
			extracted = { bytes: carried.bytes, stream: carried.stream, type: null };
			carried.used = true; // the body moves to this request
		}
		this.#body = new BodyState(extracted);
		this.#init = {
			redirect: init.redirect ?? source?.redirect ?? "follow",
			mode: init.mode ?? source?.mode ?? "cors",
			credentials: init.credentials ?? source?.credentials ?? "same-origin",
			cache: init.cache ?? source?.cache ?? "default",
			referrer: init.referrer ?? source?.referrer ?? "about:client",
			referrerPolicy: init.referrerPolicy ?? source?.referrerPolicy ?? "",
			integrity: init.integrity ?? source?.integrity ?? "",
			keepalive: Boolean(init.keepalive ?? source?.keepalive),
			duplex: init.duplex ?? "half",
		};
	}

	get url() {
		return this.#url;
	}
	get method() {
		return this.#method;
	}
	get headers() {
		return this.#headers;
	}
	get signal() {
		return this.#signal;
	}
	get redirect() {
		return this.#init.redirect;
	}
	get mode() {
		return this.#init.mode;
	}
	get credentials() {
		return this.#init.credentials;
	}
	get cache() {
		return this.#init.cache;
	}
	get referrer() {
		return this.#init.referrer;
	}
	get referrerPolicy() {
		return this.#init.referrerPolicy;
	}
	get integrity() {
		return this.#init.integrity;
	}
	get keepalive() {
		return this.#init.keepalive;
	}
	get duplex() {
		return this.#init.duplex;
	}
	get destination() {
		return "";
	}
	get isReloadNavigation() {
		return false;
	}
	get isHistoryNavigation() {
		return false;
	}
	get [Symbol.toStringTag]() {
		return "Request";
	}
	get _state() {
		return this.#body;
	}

	clone() {
		if (this.#body.used) throw new TypeError("Request.clone: Body has already been consumed.");
		const copy = new Request(this.#url, { method: this.#method, headers: this.#headers, signal: this.#signal, ...this.#init });
		const cloned = this.#body.clone();
		copy.#body = new BodyState(cloned);
		return copy;
	}
}
installBodyMixin(Request, "_state");

/* ----------------------------------------------------------------- Response */

class Response {
	#body;
	#status;
	#statusText;
	#headers;
	#url = "";
	#redirected = false;
	#type = "default";

	constructor(body = null, init = {}) {
		const status = init.status === undefined ? 200 : Number(init.status);
		if (!Number.isInteger(status) || status < 200 || status > 599) {
			throw new RangeError(`init["status"] must be in the range of 200 to 599, inclusive.`);
		}
		this.#status = status;
		this.#statusText = init.statusText === undefined ? "" : String(init.statusText);
		this.#headers = new Headers(init.headers);
		if (body !== null && body !== undefined && NULL_BODY_STATUS.has(status)) {
			throw new TypeError("Response constructor: Invalid response status code " + status);
		}
		const extracted = extractBody(body);
		if (extracted.type && !this.#headers.has("content-type")) this.#headers.set("content-type", extracted.type);
		this.#body = new BodyState(extracted);
	}

	get status() {
		return this.#status;
	}
	get statusText() {
		return this.#statusText;
	}
	get ok() {
		return this.#status >= 200 && this.#status <= 299;
	}
	get headers() {
		return this.#headers;
	}
	get url() {
		return this.#url;
	}
	get redirected() {
		return this.#redirected;
	}
	get type() {
		return this.#type;
	}
	get [Symbol.toStringTag]() {
		return "Response";
	}
	get _state() {
		return this.#body;
	}

	/* fetch() fills in what a constructor cannot: the final URL, redirect flag, and 1xx-5xx statuses. */
	static _network(body, { status, statusText, headers, url, redirected }) {
		const response = new Response(null, { status: 200 });
		response.#status = status;
		response.#statusText = statusText;
		response.#headers = headers;
		response.#url = url;
		response.#redirected = redirected;
		response.#type = "basic";
		response.#body = new BodyState({ bytes: null, stream: NULL_BODY_STATUS.has(status) ? null : body, type: null });
		return response;
	}

	clone() {
		if (this.#body.used) throw new TypeError("Response.clone: Body has already been consumed.");
		const copy = new Response(null, { status: 200 });
		copy.#status = this.#status;
		copy.#statusText = this.#statusText;
		copy.#headers = new Headers(this.#headers);
		copy.#url = this.#url;
		copy.#redirected = this.#redirected;
		copy.#type = this.#type;
		copy.#body = new BodyState(this.#body.clone());
		return copy;
	}

	static json(data, init = {}) {
		const text = JSON.stringify(data);
		if (text === undefined) throw new TypeError("Value is not JSON serializable");
		const response = new Response(text, init);
		response.#headers.set("content-type", init.headers && new Headers(init.headers).get("content-type") ? new Headers(init.headers).get("content-type") : "application/json");
		return response;
	}
	static redirect(url, status = 302) {
		if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError(`Invalid status code ${status}`);
		const response = new Response(null, { status: 200 });
		response.#status = status;
		response.#headers.set("location", new URL(String(url)).href);
		return response;
	}
	static error() {
		const response = new Response(null, { status: 200 });
		response.#status = 0;
		response.#type = "error";
		return response;
	}
}
installBodyMixin(Response, "_state");

/* -------------------------------------------------------------------- fetch */

function makeFetch({ http, https }, zlib) {
	const failed = (cause) => Object.assign(new TypeError("fetch failed"), { cause });
	const abortReason = (signal) => signal.reason ?? Object.assign(new Error("This operation was aborted"), { name: "AbortError", code: 20 });

	function dataUrl(url) {
		const match = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url);
		if (!match) throw failed(new Error("invalid data: URL"));
		const bytes = match[2] ? Uint8Array.from(atobBytes(decodeURIComponent(match[3]))) : encode(decodeURIComponent(match[3]));
		return Response._network(
			new ReadableStream({ start: (c) => (bytes.length && c.enqueue(bytes), c.close()) }),
			{ status: 200, statusText: "OK", headers: new Headers({ "content-type": match[1] || "text/plain;charset=US-ASCII" }), url, redirected: false }
		);
	}
	const atobBytes = (text) => Array.from(globalThis.Buffer.from(text, "base64"));

	function once(request, target, bodyBytes, redirected) {
		return new Promise((resolve, reject) => {
			const url = new URL(target);
			const secure = url.protocol === "https:";
			const client = secure ? https : http;
			const headers = {};
			for (const [name, value] of request.headers) {
				if (name === "set-cookie") continue;
				headers[name] = value;
			}
			if (!("user-agent" in headers)) headers["user-agent"] = "node";
			if (!("accept" in headers)) headers.accept = "*/*";
			if (!("accept-language" in headers)) headers["accept-language"] = "*";
			if (!("sec-fetch-mode" in headers)) headers["sec-fetch-mode"] = "cors";
			if (!("accept-encoding" in headers) && zlib) headers["accept-encoding"] = "gzip, deflate";
			if (bodyBytes && bodyBytes.length) headers["content-length"] = String(bodyBytes.length);
			else if (bodyBytes && request.method !== "GET" && request.method !== "HEAD") headers["content-length"] = "0";

			const signal = request.signal;
			let settled = false;
			const nodeRequest = client.request({
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port ? Number(url.port) : secure ? 443 : 80,
				path: `${url.pathname}${url.search}`,
				method: request.method,
				headers,
				setHost: false,
			});
			if (!("host" in headers)) nodeRequest.setHeader("host", url.host);

			const onAbort = () => {
				if (settled) return;
				settled = true;
				nodeRequest.destroy();
				reject(abortReason(signal));
			};
			signal.addEventListener("abort", onAbort, { once: true });

			nodeRequest.on("error", (error) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(failed(error));
			});
			nodeRequest.on("response", (incoming) => {
				if (settled) return;
				settled = true;
				const responseHeaders = new Headers();
				for (let i = 0; i < incoming.rawHeaders.length; i += 2) responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);

				const encoding = (responseHeaders.get("content-encoding") ?? "").toLowerCase();
				const decoder = zlib && /gzip|deflate/.test(encoding) && request.method !== "HEAD" && incoming.statusCode !== 204 && incoming.statusCode !== 304;
				const chunks = [];
				const body = new ReadableStream({
					start(controller) {
						incoming.on("data", (chunk) => {
							const bytes = new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length));
							if (decoder) chunks.push(bytes);
							else controller.enqueue(bytes);
						});
						incoming.on("end", () => {
							if (decoder) {
								try {
									const raw = concatBytes(chunks);
									let out;
									if (/gzip/.test(encoding)) out = zlib.gunzipSync(raw);
									else {
										try {
											out = zlib.inflateSync(raw);
										} catch {
											out = zlib.inflateRawSync(raw);
										}
									}
									if (out.length) controller.enqueue(new Uint8Array(out));
								} catch (error) {
									controller.error(failed(error));
									return;
								}
							}
							signal.removeEventListener("abort", onAbort);
							controller.close();
						});
						incoming.on("error", (error) => controller.error(failed(error)));
						incoming.on("aborted", () => controller.error(failed(new Error("other side closed"))));
						signal.addEventListener("abort", () => {
							incoming.destroy();
							controller.error(abortReason(signal));
						}, { once: true });
					},
					cancel() {
						incoming.destroy();
					},
				});
				resolve(
					Response._network(body, {
						status: incoming.statusCode,
						statusText: incoming.statusMessage ?? "",
						headers: responseHeaders,
						url: target,
						redirected,
					})
				);
			});
			if (bodyBytes && bodyBytes.length) nodeRequest.write(bodyBytes);
			nodeRequest.end();
		});
	}

	return async function fetch(input, init) {
		const request = new Request(input, init);
		if (request.signal.aborted) throw abortReason(request.signal);
		const url = new URL(request.url);
		if (url.protocol === "data:") return dataUrl(request.url);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw failed(new Error(`unknown scheme`));
		}

		let target = request.url;
		let method = request.method;
		let bodyBytes = request._state.hasBody ? await request._state.consume() : null;
		let redirected = false;
		let headers = request.headers;
		for (let hops = 0; ; hops++) {
			const current = new Request(target, { method, headers, signal: request.signal, ...(bodyBytes && method !== "GET" && method !== "HEAD" ? { body: bodyBytes } : {}) });
			const response = await once(current, target, bodyBytes, redirected);
			const location = response.headers.get("location");
			if (!REDIRECT_STATUS.has(response.status) || location === null || request.redirect === "manual") return response;
			if (request.redirect === "error") throw failed(new Error("unexpected redirect"));
			if (hops >= 20) throw failed(new Error("redirect count exceeded"));
			await response.body?.cancel();
			const next = new URL(location, target);
			if (next.protocol !== "http:" && next.protocol !== "https:") throw failed(new Error("unknown scheme"));
			if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
				if (method !== "HEAD") method = "GET";
				bodyBytes = null;
				headers = new Headers(headers);
				for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(name);
			}
			if (next.origin !== new URL(target).origin) {
				headers = new Headers(headers);
				headers.delete("authorization");
				headers.delete("cookie");
				headers.delete("proxy-authorization");
			}
			target = next.href;
			redirected = true;
		}
	};
}

export { Headers, FormData, Request, Response, makeFetch };

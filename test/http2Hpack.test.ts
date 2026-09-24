import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import stream from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

/*
 * HPACK (RFC 7541) as node-http2.js implements it, checked against the RFC's own examples. The module is plain
 * JavaScript, so it runs here on Node.js as well as on the host; the differential http2 corpus covers the rest.
 */

interface Hpack {
	HpackEncoder: new (
		size: number
	) => { encode(headers: Array<[string, string, boolean?]>, enc: (s: string) => Uint8Array): Uint8Array };
	HpackDecoder: new (
		size: number
	) => { decode(bytes: Uint8Array, dec: (b: Uint8Array) => string): Array<[string, string, boolean]> };
	huffmanEncode(bytes: Uint8Array): Uint8Array;
	huffmanDecode(bytes: Uint8Array): Uint8Array;
}

async function load(): Promise<Hpack> {
	const url = pathToFileURL(join(process.cwd(), "quickjs/runtime/node-http2.js")).href;
	const mod = await import(url);
	const http2 = mod.createHttp2(
		{ net: { Server: class {} }, tls: { Server: class {} }, http: {}, fs: {}, url: { URL } },
		EventEmitter,
		stream,
		Buffer
	);
	return http2.__hpack;
}

const text = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const decodeText = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const hex = (s: string) => new Uint8Array(Buffer.from(s.replace(/\s+/g, ""), "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("Huffman coding matches the RFC 7541 examples", async () => {
	const { huffmanEncode, huffmanDecode } = await load();
	const cases: Array<[string, string]> = [
		["www.example.com", "f1e3c2e5f23a6ba0ab90f4ff"],
		["no-cache", "a8eb10649cbf"],
		["custom-key", "25a849e95ba97d7f"],
		["custom-value", "25a849e95bb8e8b4bf"],
	];
	for (const [plain, coded] of cases) {
		assert.equal(toHex(huffmanEncode(text(plain))), coded);
		assert.equal(decodeText(huffmanDecode(hex(coded))), plain);
	}
	const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);
	assert.deepEqual(huffmanDecode(huffmanEncode(everyByte)), everyByte);
});

test("Huffman decoding rejects bad padding and EOS", async () => {
	const { huffmanDecode } = await load();
	assert.throws(() => huffmanDecode(hex("f1e3c2e5f23a6ba0ab90f400")), /Compression/);
	assert.throws(() => huffmanDecode(hex("ffffffff")), /Compression/);
});

test("the decoder reads the RFC 7541 C.4 request sequence with a dynamic table", async () => {
	const { HpackDecoder } = await load();
	const decoder = new HpackDecoder(4096);
	const first = decoder.decode(hex("8286 8441 8cf1 e3c2 e5f2 3a6b a0ab 90f4 ff"), decodeText);
	assert.deepEqual(
		first.map(([n, v]) => [n, v]),
		[
			[":method", "GET"],
			[":scheme", "http"],
			[":path", "/"],
			[":authority", "www.example.com"],
		]
	);
	const second = decoder.decode(hex("8286 84be 5886 a8eb 1064 9cbf"), decodeText);
	assert.deepEqual(
		second.map(([n, v]) => [n, v]),
		[
			[":method", "GET"],
			[":scheme", "http"],
			[":path", "/"],
			[":authority", "www.example.com"],
			["cache-control", "no-cache"],
		]
	);
	const third = decoder.decode(hex("8287 85bf 4088 25a8 49e9 5ba9 7d7f 8925 a849 e95b b8e8 b4bf"), decodeText);
	assert.deepEqual(
		third.map(([n, v]) => [n, v]),
		[
			[":method", "GET"],
			[":scheme", "https"],
			[":path", "/index.html"],
			[":authority", "www.example.com"],
			["custom-key", "custom-value"],
		]
	);
});

test("the decoder honours a table size update and a literal that is never indexed", async () => {
	const { HpackDecoder } = await load();
	const decoder = new HpackDecoder(4096);
	// Table size 0, then "authorization: secret" as a never-indexed literal whose name is static entry 23 (0x1f 0x08).
	const headers = decoder.decode(hex(`20 1f08 06 ${toHex(text("secret"))}`), decodeText);
	assert.deepEqual(headers, [["authorization", "secret", true]]);
	assert.throws(() => decoder.decode(hex("3fe2 1f"), decodeText), /Compression/);
});

test("an encoder's output decodes to the same headers, across blocks and with a shrinking table", async () => {
	const { HpackEncoder, HpackDecoder } = await load();
	const encoder = new HpackEncoder(4096);
	const decoder = new HpackDecoder(4096);
	const blocks: Array<Array<[string, string, boolean?]>> = [
		[
			[":status", "200"],
			["content-type", "text/html"],
			["x-long", "v".repeat(300)],
		],
		[
			[":status", "200"],
			["content-type", "text/html"],
			["x-long", "v".repeat(300)],
			["set-cookie", "a=1"],
			["set-cookie", "b=2"],
		],
		[
			[":status", "404"],
			["authorization", "Bearer abc", true],
			["x-new", "1"],
		],
	];
	for (const block of blocks) {
		const out = decoder.decode(encoder.encode(block, text), decodeText);
		assert.deepEqual(
			out.map(([n, v]) => [n, v]),
			block.map(([n, v]) => [n, v])
		);
		if (block.some((h) => h[2])) assert.equal(out.find(([n]) => n === "authorization")?.[2], true);
	}
});

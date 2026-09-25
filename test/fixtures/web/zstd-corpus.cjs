/* Differential corpus: zlib Zstandard (sync, callback, stream, options, errors). */
const zlib = require("zlib");
const { pipeline, Readable } = require("stream");

const line = (label, value) => console.log(label + ": " + (typeof value === "string" ? value : JSON.stringify(value)));
const attempt = (label, fn) => {
	try {
		line(label, fn());
	} catch (err) {
		line(label, ["throws", err.constructor.name, String(err.code).replace("FAILED", "FAIL"), err.errno, err.message]);
	}
};
const c = zlib.constants;
const text = Buffer.from("The quick brown fox jumps over the lazy dog. ".repeat(40));
const binary = Buffer.alloc(4096);
for (let i = 0; i < binary.length; i++) binary[i] = (i * 31 + (i >> 3)) & 255;
const big = Buffer.from("graak ".repeat(60000));

line("constants", [c.ZSTD_c_compressionLevel, c.ZSTD_e_end, c.ZSTD_CLEVEL_DEFAULT, c.ZSTD_error_prefix_unknown, c.ZSTD_c_checksumFlag, c.ZSTD_btultra2]);
for (const [name, input] of [["text", text], ["binary", binary], ["empty", Buffer.alloc(0)], ["big", big]]) {
	const packed = zlib.zstdCompressSync(input);
	line("roundtrip " + name, [zlib.zstdDecompressSync(packed).equals(input), packed.length < input.length || input.length < 64]);
	line("magic " + name, packed.subarray(0, 4).toString("hex"));
}
for (const level of [1, 3, 9, 19]) {
	const packed = zlib.zstdCompressSync(text, { params: { [c.ZSTD_c_compressionLevel]: level } });
	line("level " + level, [zlib.zstdDecompressSync(packed).equals(text), packed.length < text.length]);
}
const withSum = zlib.zstdCompressSync("abc", { params: { [c.ZSTD_c_checksumFlag]: 1 } });
line("checksum flag", [withSum.length - zlib.zstdCompressSync("abc").length, zlib.zstdDecompressSync(withSum).toString()]);
line("string input", zlib.zstdDecompressSync(zlib.zstdCompressSync("héllo wörld")).toString());
line("concatenated frames", zlib.zstdDecompressSync(Buffer.concat([zlib.zstdCompressSync("ab"), zlib.zstdCompressSync("cd")])).toString());
line("window log", zlib.zstdDecompressSync(zlib.zstdCompressSync(big, { params: { [c.ZSTD_c_windowLog]: 12 } })).equals(big));
attempt("empty input", () => zlib.zstdDecompressSync(Buffer.alloc(0)).length);
attempt("garbage", () => zlib.zstdDecompressSync(Buffer.from("this is not zstd data at all")).length);
attempt("truncated", () => zlib.zstdDecompressSync(zlib.zstdCompressSync(text).subarray(0, 10)).length);
const damaged = Buffer.from(withSum);
damaged[damaged.length - 1] ^= 1;
attempt("bad checksum", () => zlib.zstdDecompressSync(damaged).length);
attempt("maxOutputLength", () => zlib.zstdDecompressSync(zlib.zstdCompressSync(big), { maxOutputLength: 1000 }).length);
attempt("bad type", () => zlib.zstdCompressSync(42).length);
attempt("unknown parameter", () => zlib.zstdCompressSync("x", { params: { 999: 1 } }).length);
attempt("parameter out of range", () => zlib.zstdCompressSync("x", { params: { [c.ZSTD_c_windowLog]: 99 } }).length);
attempt("pledged size", () => zlib.zstdCompressSync("abc", { pledgedSrcSize: 2 }).length);

const steps = [];
steps.push((next) =>
	zlib.zstdCompress(text, (err, packed) => {
		line("callback compress", [err === null, packed.length < text.length]);
		zlib.zstdDecompress(packed, (err2, plain) => {
			line("callback decompress", [err2 === null, plain.equals(text)]);
			next();
		});
	})
);
steps.push((next) =>
	zlib.zstdDecompress(Buffer.from("nonsense"), (err) => {
		line("callback error", [err && err.code, err && err.errno]);
		next();
	})
);
steps.push((next) => {
	const source = Readable.from([text.subarray(0, 300), text.subarray(300, 500), text.subarray(500)]);
	const chunks = [];
	pipeline(source, zlib.createZstdCompress(), zlib.createZstdDecompress(), (err) => {
		line("stream pipeline", [err === undefined || err === null, Buffer.concat(chunks).equals(text)]);
		next();
	}).on("data", (chunk) => chunks.push(chunk));
});
steps.push((next) => {
	const compress = zlib.createZstdCompress({ params: { [c.ZSTD_c_compressionLevel]: 5 } });
	const parts = [];
	compress.on("data", (chunk) => parts.push(chunk));
	compress.on("end", () => {
		line("stream compress", zlib.zstdDecompressSync(Buffer.concat(parts)).equals(text));
		next();
	});
	compress.write(text.subarray(0, 100));
	compress.end(text.subarray(100));
});
steps.push((next) => {
	const decompress = zlib.createZstdDecompress();
	decompress.on("error", (err) => {
		line("stream decompress error", [err.code, err.errno]);
		next();
	});
	decompress.end(Buffer.from("garbage garbage"));
});
(function run(i) {
	if (i < steps.length) steps[i](() => run(i + 1));
})(0);

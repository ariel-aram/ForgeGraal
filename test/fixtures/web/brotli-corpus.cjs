/* Differential corpus: zlib Brotli (sync, callback, stream, options, errors). */
const zlib = require("zlib");
const { pipeline, Readable } = require("stream");

const line = (label, value) => console.log(label + ": " + (typeof value === "string" ? value : JSON.stringify(value)));
const attempt = (label, fn) => {
	try {
		line(label, fn());
	} catch (err) {
		line(label, ["throws", err.code, err.errno, err.message]);
	}
};
const text = Buffer.from("The quick brown fox jumps over the lazy dog. ".repeat(40));
const binary = Buffer.alloc(4096);
for (let i = 0; i < binary.length; i++) binary[i] = (i * 31 + (i >> 3)) & 255;
const big = Buffer.from("graak ".repeat(60000));

line("constants", [zlib.constants.BROTLI_PARAM_QUALITY, zlib.constants.BROTLI_MAX_QUALITY, zlib.constants.BROTLI_DEFAULT_WINDOW, zlib.constants.BROTLI_OPERATION_FINISH, zlib.constants.BROTLI_DECODER_ERROR_FORMAT_PADDING_1, zlib.BROTLI_MODE_TEXT]);
for (const [name, input] of [["text", text], ["binary", binary], ["empty", Buffer.alloc(0)], ["big", big]]) {
	const packed = zlib.brotliCompressSync(input);
	line("roundtrip " + name, [zlib.brotliDecompressSync(packed).equals(input), packed.length < input.length || input.length < 64]);
}
for (const quality of [0, 1, 4, 9, 11]) {
	const packed = zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } });
	line("quality " + quality, [zlib.brotliDecompressSync(packed).equals(text), packed.length < text.length]);
}
line("lgwin and mode", zlib.brotliDecompressSync(zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_LGWIN]: 16, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: text.length } })).equals(text));
line("string input", zlib.brotliDecompressSync(zlib.brotliCompressSync("héllo wörld")).toString());
line("quality 1 stable size", zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } }).length);
attempt("garbage", () => zlib.brotliDecompressSync(Buffer.from("this is not brotli data at all")).length);
attempt("truncated", () => zlib.brotliDecompressSync(zlib.brotliCompressSync(text).subarray(0, 10)).length);
attempt("maxOutputLength", () => zlib.brotliDecompressSync(zlib.brotliCompressSync(big), { maxOutputLength: 1000 }).length);
attempt("bad type", () => zlib.brotliCompressSync(42).length);

const steps = [];
steps.push((next) =>
	zlib.brotliCompress(text, (err, packed) => {
		line("callback compress", [err === null, packed.length < text.length]);
		zlib.brotliDecompress(packed, (err2, plain) => {
			line("callback decompress", [err2 === null, plain.equals(text)]);
			next();
		});
	})
);
steps.push((next) =>
	zlib.brotliDecompress(Buffer.from("nonsense"), (err) => {
		line("callback error", [err && err.code, err && err.errno]);
		next();
	})
);
steps.push((next) => {
	const chunks = [];
	const source = Readable.from([text.subarray(0, 300), text.subarray(300, 500), text.subarray(500)]);
	pipeline(source, zlib.createBrotliCompress(), zlib.createBrotliDecompress(), (err) => {
		line("stream pipeline", [err === undefined || err === null]);
		next();
	}).on("data", (chunk) => chunks.push(chunk));
});
steps.push((next) => {
	const compress = zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
	const parts = [];
	compress.on("data", (chunk) => parts.push(chunk));
	compress.on("end", () => {
		line("stream compress", zlib.brotliDecompressSync(Buffer.concat(parts)).equals(text));
		next();
	});
	compress.write(text.subarray(0, 100));
	compress.end(text.subarray(100));
});
steps.push((next) => {
	const decompress = zlib.createBrotliDecompress();
	decompress.on("error", (err) => {
		line("stream decompress error", [err.code, err.errno]);
		next();
	});
	decompress.end(Buffer.from("garbage garbage"));
});
(function run(i) {
	if (i < steps.length) steps[i](() => run(i + 1));
})(0);

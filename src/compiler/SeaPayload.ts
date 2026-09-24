import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants, inflateRawSync } from "node:zlib";
import { RuntimeError } from "../structures";

/**
 * Single-file executables for the native host: the application is appended to a copy of the host, which runs it
 * straight from there (quickjs/native/fg_sea.c reads what this writes; quickjs/runtime/node-sea.js serves it as files).
 *
 *   payload := u32 indexLength, index, blocks
 *   index   := u32 blockCount, u32 entryCount, u16 mainLength, main (the file the host runs)
 *              per block: u64 offset (from the payload's start), u32 storedSize, u32 rawSize,
 *                         u8 method (0 stored, 1 raw deflate, 2 Brotli)
 *              per entry, sorted by the bytes of its path:
 *                         u16 pathLength, path (UTF-8, forward slashes), u32 mode, u32 block, u32 offsetInBlock, u32 size
 *   trailer := "FGSEA\0\0\2", u64 payloadOffset, u64 payloadLength, 64 hex characters (payload SHA-256)
 *
 * Files are packed together into blocks of about SEA_BLOCK_BYTES and each block is compressed as one, so the many small
 * modules of a node_modules tree compress against each other; the host decompresses a block when a file in it is read.
 */
export const SEA_FORMAT_VERSION = 2;
export const SEA_MAGIC = Buffer.from(`FGSEA\0\0${String.fromCharCode(SEA_FORMAT_VERSION)}`, "latin1");
export const SEA_TRAILER_BYTES = 88;
/** What a host able to run this format says about itself (see fg_sea.c). */
export const SEA_HOST_MARKER = `graak-sea-format:${SEA_FORMAT_VERSION}`;
export const SEA_BLOCK_BYTES = 2 << 20;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 1;
const METHOD_BROTLI = 2;
const BLOCK_ENTRY_BYTES = 21;

export interface SeaEntry {
	/** Path inside the application's root directory, forward slashes. */
	path: string;
	data: Buffer;
	mode: number;
}

/** Every file under `dirs` (relative to `root`), skipping anything in `exclude` (root-relative paths). */
export function collectSeaEntries(
	root: string,
	dirs: readonly string[],
	exclude: ReadonlySet<string> = new Set()
): SeaEntry[] {
	const entries: SeaEntry[] = [];
	const walk = (dir: string) => {
		for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(dir, item.name);
			if (item.isDirectory()) walk(full);
			else if (item.isFile()) {
				const rel = relative(root, full).split(sep).join("/");
				if (exclude.has(rel)) continue;
				entries.push({ path: rel, data: readFileSync(full), mode: statSync(full).mode & 0o777 });
			}
		}
	};
	for (const dir of dirs) walk(join(root, dir));
	return entries;
}

/**
 * The generated Intl data is large and read one locale at a time, if at all; packed after everything else it does not
 * share blocks with the modules every start needs.
 */
const coldFile = (path: string) => /^runtime\/intl-(?!zone\.js$)/.test(path);

function compressBlock(raw: Buffer): { method: number; stored: Buffer } {
	const window = Math.max(16, Math.min(24, Math.ceil(Math.log2(Math.max(raw.length, 1)))));
	const packed = brotliCompressSync(raw, {
		params: {
			[constants.BROTLI_PARAM_QUALITY]: 9,
			[constants.BROTLI_PARAM_LGWIN]: window,
			[constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
		},
	});
	return packed.length < raw.length
		? { method: METHOD_BROTLI, stored: packed }
		: { method: METHOD_STORED, stored: raw };
}

export function packSeaPayload(entries: readonly SeaEntry[], entry: string): Buffer {
	const main = Buffer.from(entry, "utf-8");
	if (main.length === 0 || main.length > 0xffff)
		throw new RuntimeError(`The entry file '${entry}' is empty or too long`);
	const seen = new Set<string>();
	const items = entries.map((item) => {
		const path = Buffer.from(item.path, "utf-8");
		if (path.length === 0 || path.length > 0xffff || /^(\/|[A-Za-z]:)|\\|(^|\/)\.\.(\/|$)/.test(item.path)) {
			throw new RuntimeError(`Cannot embed '${item.path}': the path is empty, too long or unsafe`);
		}
		if (seen.has(item.path)) throw new RuntimeError(`Duplicate path '${item.path}' in the embedded application`);
		seen.add(item.path);
		if (item.data.length > 0xffffffff) {
			throw new RuntimeError(`'${item.path}' is larger than 4 GiB and cannot be embedded`);
		}
		return { ...item, key: path, block: 0, offset: 0 };
	});

	// Blocks follow the tree's order, so the files a package loads together are decompressed together.
	const packOrder = [...items].sort(
		(a, b) => Number(coldFile(a.path)) - Number(coldFile(b.path)) || Buffer.compare(a.key, b.key)
	);
	const blocks: { method: number; stored: Buffer; raw: number }[] = [];
	let pending: typeof items = [];
	let pendingBytes = 0;
	const flush = () => {
		if (!pending.length) return;
		const raw = Buffer.concat(pending.map((item) => item.data));
		blocks.push({ ...compressBlock(raw), raw: raw.length });
		pending = [];
		pendingBytes = 0;
	};
	for (const item of packOrder) {
		if (pendingBytes > 0 && pendingBytes + item.data.length > SEA_BLOCK_BYTES) flush();
		if (pendingBytes + item.data.length > 0xffffffff) flush();
		item.block = blocks.length;
		item.offset = pendingBytes;
		pending.push(item);
		pendingBytes += item.data.length;
	}
	flush();

	// The index is searched by path in the host, so it is sorted by the same bytes the host compares.
	const sorted = [...items].sort((a, b) => Buffer.compare(a.key, b.key));
	const head = Buffer.alloc(10);
	head.writeUInt32LE(blocks.length, 0);
	head.writeUInt32LE(sorted.length, 4);
	head.writeUInt16LE(main.length, 8);
	const entryParts = sorted.map((item) => {
		const part = Buffer.alloc(2 + item.key.length + 16);
		part.writeUInt16LE(item.key.length, 0);
		item.key.copy(part, 2);
		part.writeUInt32LE(item.mode & 0o777, 2 + item.key.length);
		part.writeUInt32LE(item.block, 6 + item.key.length);
		part.writeUInt32LE(item.offset, 10 + item.key.length);
		part.writeUInt32LE(item.data.length, 14 + item.key.length);
		return part;
	});
	const indexLength =
		head.length + main.length + blocks.length * BLOCK_ENTRY_BYTES + entryParts.reduce((n, p) => n + p.length, 0);
	const table = Buffer.alloc(blocks.length * BLOCK_ENTRY_BYTES);
	let offset = 4 + indexLength;
	blocks.forEach((block, i) => {
		const at = i * BLOCK_ENTRY_BYTES;
		table.writeBigUInt64LE(BigInt(offset), at);
		table.writeUInt32LE(block.stored.length, at + 8);
		table.writeUInt32LE(block.raw, at + 12);
		table.writeUInt8(block.method, at + 20);
		offset += block.stored.length;
	});
	const length = Buffer.alloc(4);
	length.writeUInt32LE(indexLength);
	return Buffer.concat([length, head, main, table, ...entryParts, ...blocks.map((b) => b.stored)]);
}

/** Reads a payload back: the entry file and every file's bytes and mode. The inverse of packSeaPayload. */
export function unpackSeaPayload(payload: Buffer): {
	entry: string;
	files: Map<string, { data: Buffer; mode: number }>;
} {
	const indexLength = payload.readUInt32LE(0);
	let pos = 4;
	const blockCount = payload.readUInt32LE(pos);
	const entryCount = payload.readUInt32LE(pos + 4);
	const mainLength = payload.readUInt16LE(pos + 8);
	pos += 10;
	const entry = payload.toString("utf-8", pos, pos + mainLength);
	pos += mainLength;
	const blocks: Buffer[] = [];
	for (let i = 0; i < blockCount; i++, pos += BLOCK_ENTRY_BYTES) {
		const offset = Number(payload.readBigUInt64LE(pos));
		const stored = payload.subarray(offset, offset + payload.readUInt32LE(pos + 8));
		const method = payload.readUInt8(pos + 20);
		blocks.push(
			method === METHOD_BROTLI
				? brotliDecompressSync(stored)
				: method === METHOD_DEFLATE
					? inflateRawSync(stored)
					: Buffer.from(stored)
		);
	}
	const files = new Map<string, { data: Buffer; mode: number }>();
	for (let i = 0; i < entryCount; i++) {
		const length = payload.readUInt16LE(pos);
		const path = payload.toString("utf-8", pos + 2, pos + 2 + length);
		pos += 2 + length;
		const mode = payload.readUInt32LE(pos);
		const block = blocks[payload.readUInt32LE(pos + 4)];
		const offset = payload.readUInt32LE(pos + 8);
		files.set(path, { data: block.subarray(offset, offset + payload.readUInt32LE(pos + 12)), mode });
		pos += 16;
	}
	if (pos !== 4 + indexLength) throw new RuntimeError("The embedded application's index is damaged");
	return { entry, files };
}

/** Writes `host` + payload + trailer to `outputFile`, and returns the payload's SHA-256. */
export function writeSeaExecutable(hostBinary: string, payload: Buffer, outputFile: string): string {
	const host = readFileSync(hostBinary);
	if (!host.includes(SEA_HOST_MARKER)) {
		throw new RuntimeError(
			`The native host '${hostBinary}' cannot run single-file format ${SEA_FORMAT_VERSION}: it predates it. ` +
				"Delete it (or the Graak cache) so a current host is prepared, then build again."
		);
	}
	const sha = createHash("sha256").update(payload).digest("hex");
	const trailer = Buffer.alloc(SEA_TRAILER_BYTES);
	SEA_MAGIC.copy(trailer, 0);
	trailer.writeBigUInt64LE(BigInt(host.length), 8);
	trailer.writeBigUInt64LE(BigInt(payload.length), 16);
	trailer.write(sha, 24, "ascii");
	writeFileSync(outputFile, Buffer.concat([host, payload, trailer]), { mode: 0o755 });
	return sha;
}

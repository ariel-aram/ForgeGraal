import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { RuntimeError } from "../structures";

/**
 * Single-file executables for the native host: the application is appended to a copy of the host, and the host
 * unpacks itself on first start (quickjs/native/fg_sea.c reads what this writes).
 *
 *   payload := u32 count, then per entry
 *              u16 pathLength, path (UTF-8, forward slashes), u32 mode, u32 rawSize, u32 storedSize,
 *              u8 method (0 stored, 1 raw deflate), storedSize bytes
 *   trailer := "FGSEA\0\0\1", u64 payloadOffset, u64 payloadLength, 64 hex characters (payload SHA-256)
 *
 * The entry ".graak" holds the path of the file the host should run.
 */
export const SEA_MAGIC = Buffer.from("FGSEA\0\0\u0001", "latin1");
export const SEA_TRAILER_BYTES = 88;
export const SEA_ENTRY_MARKER = ".graak";

export interface SeaEntry {
	/** Path inside the unpacked directory, forward slashes. */
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

export function packSeaPayload(entries: readonly SeaEntry[], entry: string): Buffer {
	const all: SeaEntry[] = [...entries, { path: SEA_ENTRY_MARKER, data: Buffer.from(entry, "utf-8"), mode: 0o644 }];
	const seen = new Set<string>();
	const parts: Buffer[] = [];
	const count = Buffer.alloc(4);
	count.writeUInt32LE(all.length);
	parts.push(count);
	for (const item of all) {
		const path = Buffer.from(item.path, "utf-8");
		if (path.length === 0 || path.length > 0xffff || /^(\/|[A-Za-z]:)|\\|(^|\/)\.\.(\/|$)/.test(item.path)) {
			throw new RuntimeError(`Cannot embed '${item.path}': the path is empty, too long or unsafe`);
		}
		if (seen.has(item.path)) throw new RuntimeError(`Duplicate path '${item.path}' in the embedded application`);
		seen.add(item.path);
		if (item.data.length > 0xffffffff)
			throw new RuntimeError(`'${item.path}' is larger than 4 GiB and cannot be embedded`);

		const packed = item.data.length > 64 ? deflateRawSync(item.data, { level: 9 }) : item.data;
		const deflated = packed !== item.data && packed.length < item.data.length;
		const stored = deflated ? packed : item.data;
		const head = Buffer.alloc(2 + path.length + 13);
		head.writeUInt16LE(path.length, 0);
		path.copy(head, 2);
		head.writeUInt32LE(item.mode & 0o777, 2 + path.length);
		head.writeUInt32LE(item.data.length, 2 + path.length + 4);
		head.writeUInt32LE(stored.length, 2 + path.length + 8);
		head.writeUInt8(deflated ? 1 : 0, 2 + path.length + 12);
		parts.push(head, stored);
	}
	return Buffer.concat(parts);
}

/** Writes `host` + payload + trailer to `outputFile`, and returns the payload's SHA-256. */
export function writeSeaExecutable(hostBinary: string, payload: Buffer, outputFile: string): string {
	const host = readFileSync(hostBinary);
	const sha = createHash("sha256").update(payload).digest("hex");
	const trailer = Buffer.alloc(SEA_TRAILER_BYTES);
	SEA_MAGIC.copy(trailer, 0);
	trailer.writeBigUInt64LE(BigInt(host.length), 8);
	trailer.writeBigUInt64LE(BigInt(payload.length), 16);
	trailer.write(sha, 24, "ascii");
	writeFileSync(outputFile, Buffer.concat([host, payload, trailer]), { mode: 0o755 });
	return sha;
}

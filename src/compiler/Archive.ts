import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { ForgeGraalError } from "../structures";

/**
 * FGAR: the application archive embedded into executables and portable bundles.
 *
 * gzip( "FGAR1\0" | uint32le manifestLength | manifest JSON | file bytes in manifest order )
 *
 * The runtime launcher (src/runtime/launcher.ts) contains an ES5 copy of the reader and
 * must be kept in sync with this format.
 */
export const ARCHIVE_MAGIC = "FGAR1\0";

export interface ArchiveEntry {
	/** Relative POSIX path inside the application directory. */
	path: string;
	/** Absolute path to read from disk, or in-memory contents. */
	source: string | Buffer;
	mode: number;
}

export interface ArchiveManifestFile {
	path: string;
	size: number;
	mode: number;
}

export interface PackedArchive {
	buffer: Buffer;
	sha256: string;
	files: number;
	uncompressedBytes: number;
}

/**
 * Rejects absolute paths, drive letters, backslashes, empty and `..` segments.
 */
export function assertSafeArchivePath(path: string): void {
	const segments = path.split("/");
	const unsafe =
		path.length === 0 ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.startsWith("/") ||
		/^[a-zA-Z]:/.test(path) ||
		segments.some((s) => s === "" || s === "." || s === "..");
	if (unsafe) throw new ForgeGraalError(`Unsafe archive path '${path}'`);
}

export class Archive {
	public static pack(entries: readonly ArchiveEntry[]): PackedArchive {
		const seen = new Set<string>();
		const manifest: ArchiveManifestFile[] = [];
		const chunks: Buffer[] = [];
		let uncompressedBytes = 0;

		for (const entry of entries) {
			assertSafeArchivePath(entry.path);
			const key = entry.path.toLowerCase();
			if (seen.has(key)) {
				throw new ForgeGraalError(
					`Duplicate archive path '${entry.path}' (paths must be unique case-insensitively for Windows targets)`,
				);
			}
			seen.add(key);

			const data =
				typeof entry.source === "string"
					? readFileSync(entry.source)
					: entry.source;
			manifest.push({
				path: entry.path,
				size: data.length,
				mode: entry.mode & 0o777,
			});
			chunks.push(data);
			uncompressedBytes += data.length;
		}

		const manifestBuf = Buffer.from(
			JSON.stringify({ version: 1, files: manifest }),
			"utf-8",
		);
		const lengthBuf = Buffer.alloc(4);
		lengthBuf.writeUInt32LE(manifestBuf.length, 0);

		const buffer = gzipSync(
			Buffer.concat([
				Buffer.from(ARCHIVE_MAGIC, "latin1"),
				lengthBuf,
				manifestBuf,
				...chunks,
			]),
			{ level: 9 },
		);

		return {
			buffer,
			sha256: createHash("sha256").update(buffer).digest("hex"),
			files: manifest.length,
			uncompressedBytes,
		};
	}

	public static unpack(
		buffer: Buffer,
	): Array<ArchiveManifestFile & { data: Buffer }> {
		const raw = gunzipSync(buffer);
		if (raw.toString("latin1", 0, ARCHIVE_MAGIC.length) !== ARCHIVE_MAGIC) {
			throw new ForgeGraalError("Invalid ForgeGraal archive header");
		}
		const manifestLength = raw.readUInt32LE(ARCHIVE_MAGIC.length);
		let offset = ARCHIVE_MAGIC.length + 4;
		const manifest = JSON.parse(
			raw.toString("utf-8", offset, offset + manifestLength),
		) as {
			files: ArchiveManifestFile[];
		};
		offset += manifestLength;

		return manifest.files.map((file) => {
			assertSafeArchivePath(file.path);
			const data = raw.subarray(offset, offset + file.size);
			if (data.length !== file.size)
				throw new ForgeGraalError("Truncated ForgeGraal archive");
			offset += file.size;
			return { ...file, data };
		});
	}
}

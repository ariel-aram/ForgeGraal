"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Archive = exports.ARCHIVE_MAGIC = void 0;
exports.assertSafeArchivePath = assertSafeArchivePath;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_zlib_1 = require("node:zlib");
const structures_1 = require("../structures");
/**
 * FGAR: the application archive embedded into executables and portable bundles.
 *
 * gzip( "FGAR1\0" | uint32le manifestLength | manifest JSON | file bytes in manifest order )
 *
 * The runtime launcher (src/runtime/launcher.ts) contains an ES5 copy of the reader and
 * must be kept in sync with this format.
 */
exports.ARCHIVE_MAGIC = "FGAR1\0";
/**
 * Rejects absolute paths, drive letters, backslashes, empty and `..` segments.
 */
function assertSafeArchivePath(path) {
    const segments = path.split("/");
    const unsafe = path.length === 0 ||
        path.includes("\\") ||
        path.includes("\0") ||
        path.startsWith("/") ||
        /^[a-zA-Z]:/.test(path) ||
        segments.some((s) => s === "" || s === "." || s === "..");
    if (unsafe)
        throw new structures_1.ForgeGraalError(`Unsafe archive path '${path}'`);
}
class Archive {
    static pack(entries) {
        const seen = new Set();
        const manifest = [];
        const chunks = [];
        let uncompressedBytes = 0;
        for (const entry of entries) {
            assertSafeArchivePath(entry.path);
            const key = entry.path.toLowerCase();
            if (seen.has(key)) {
                throw new structures_1.ForgeGraalError(`Duplicate archive path '${entry.path}' (paths must be unique case-insensitively for Windows targets)`);
            }
            seen.add(key);
            const data = typeof entry.source === "string" ? (0, node_fs_1.readFileSync)(entry.source) : entry.source;
            manifest.push({
                path: entry.path,
                size: data.length,
                mode: entry.mode & 0o777,
            });
            chunks.push(data);
            uncompressedBytes += data.length;
        }
        const manifestBuf = Buffer.from(JSON.stringify({ version: 1, files: manifest }), "utf-8");
        const lengthBuf = Buffer.alloc(4);
        lengthBuf.writeUInt32LE(manifestBuf.length, 0);
        const buffer = (0, node_zlib_1.gzipSync)(Buffer.concat([Buffer.from(exports.ARCHIVE_MAGIC, "latin1"), lengthBuf, manifestBuf, ...chunks]), {
            level: 9,
        });
        return {
            buffer,
            sha256: (0, node_crypto_1.createHash)("sha256").update(buffer).digest("hex"),
            files: manifest.length,
            uncompressedBytes,
        };
    }
    static unpack(buffer) {
        const raw = (0, node_zlib_1.gunzipSync)(buffer);
        if (raw.toString("latin1", 0, exports.ARCHIVE_MAGIC.length) !== exports.ARCHIVE_MAGIC) {
            throw new structures_1.ForgeGraalError("Invalid ForgeGraal archive header");
        }
        const manifestLength = raw.readUInt32LE(exports.ARCHIVE_MAGIC.length);
        let offset = exports.ARCHIVE_MAGIC.length + 4;
        const manifest = JSON.parse(raw.toString("utf-8", offset, offset + manifestLength));
        offset += manifestLength;
        return manifest.files.map((file) => {
            assertSafeArchivePath(file.path);
            const data = raw.subarray(offset, offset + file.size);
            if (data.length !== file.size)
                throw new structures_1.ForgeGraalError("Truncated ForgeGraal archive");
            offset += file.size;
            return { ...file, data };
        });
    }
}
exports.Archive = Archive;
//# sourceMappingURL=Archive.js.map
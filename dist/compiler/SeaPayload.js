"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEA_ENTRY_MARKER = exports.SEA_TRAILER_BYTES = exports.SEA_MAGIC = void 0;
exports.collectSeaEntries = collectSeaEntries;
exports.packSeaPayload = packSeaPayload;
exports.writeSeaExecutable = writeSeaExecutable;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_zlib_1 = require("node:zlib");
const structures_1 = require("../structures");
/**
 * Single-file executables for the native host: the application is appended to a copy of the host, and the host
 * unpacks itself on first start (quickjs/native/fg_sea.c reads what this writes).
 *
 *   payload := u32 count, then per entry
 *              u16 pathLength, path (UTF-8, forward slashes), u32 mode, u32 rawSize, u32 storedSize,
 *              u8 method (0 stored, 1 raw deflate), storedSize bytes
 *   trailer := "FGSEA\0\0\1", u64 payloadOffset, u64 payloadLength, 64 hex characters (payload SHA-256)
 *
 * The entry ".forgegraal" holds the path of the file the host should run.
 */
exports.SEA_MAGIC = Buffer.from("FGSEA\0\0\u0001", "latin1");
exports.SEA_TRAILER_BYTES = 88;
exports.SEA_ENTRY_MARKER = ".forgegraal";
/** Every file under `dirs` (relative to `root`), skipping anything in `exclude` (root-relative paths). */
function collectSeaEntries(root, dirs, exclude = new Set()) {
    const entries = [];
    const walk = (dir) => {
        for (const item of (0, node_fs_1.readdirSync)(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = (0, node_path_1.join)(dir, item.name);
            if (item.isDirectory())
                walk(full);
            else if (item.isFile()) {
                const rel = (0, node_path_1.relative)(root, full).split(node_path_1.sep).join("/");
                if (exclude.has(rel))
                    continue;
                entries.push({ path: rel, data: (0, node_fs_1.readFileSync)(full), mode: (0, node_fs_1.statSync)(full).mode & 0o777 });
            }
        }
    };
    for (const dir of dirs)
        walk((0, node_path_1.join)(root, dir));
    return entries;
}
function packSeaPayload(entries, entry) {
    const all = [...entries, { path: exports.SEA_ENTRY_MARKER, data: Buffer.from(entry, "utf-8"), mode: 0o644 }];
    const seen = new Set();
    const parts = [];
    const count = Buffer.alloc(4);
    count.writeUInt32LE(all.length);
    parts.push(count);
    for (const item of all) {
        const path = Buffer.from(item.path, "utf-8");
        if (path.length === 0 || path.length > 0xffff || /^(\/|[A-Za-z]:)|\\|(^|\/)\.\.(\/|$)/.test(item.path)) {
            throw new structures_1.RuntimeError(`Cannot embed '${item.path}': the path is empty, too long or unsafe`);
        }
        if (seen.has(item.path))
            throw new structures_1.RuntimeError(`Duplicate path '${item.path}' in the embedded application`);
        seen.add(item.path);
        if (item.data.length > 0xffffffff)
            throw new structures_1.RuntimeError(`'${item.path}' is larger than 4 GiB and cannot be embedded`);
        const packed = item.data.length > 64 ? (0, node_zlib_1.deflateRawSync)(item.data, { level: 9 }) : item.data;
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
function writeSeaExecutable(hostBinary, payload, outputFile) {
    const host = (0, node_fs_1.readFileSync)(hostBinary);
    const sha = (0, node_crypto_1.createHash)("sha256").update(payload).digest("hex");
    const trailer = Buffer.alloc(exports.SEA_TRAILER_BYTES);
    exports.SEA_MAGIC.copy(trailer, 0);
    trailer.writeBigUInt64LE(BigInt(host.length), 8);
    trailer.writeBigUInt64LE(BigInt(payload.length), 16);
    trailer.write(sha, 24, "ascii");
    (0, node_fs_1.writeFileSync)(outputFile, Buffer.concat([host, payload, trailer]), { mode: 0o755 });
    return sha;
}
//# sourceMappingURL=SeaPayload.js.map
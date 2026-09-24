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
export declare const SEA_FORMAT_VERSION = 2;
export declare const SEA_MAGIC: Buffer<ArrayBuffer>;
export declare const SEA_TRAILER_BYTES = 88;
/** What a host able to run this format says about itself (see fg_sea.c). */
export declare const SEA_HOST_MARKER = "graak-sea-format:2";
export declare const SEA_BLOCK_BYTES: number;
export interface SeaEntry {
    /** Path inside the application's root directory, forward slashes. */
    path: string;
    data: Buffer;
    mode: number;
}
/** Every file under `dirs` (relative to `root`), skipping anything in `exclude` (root-relative paths). */
export declare function collectSeaEntries(root: string, dirs: readonly string[], exclude?: ReadonlySet<string>): SeaEntry[];
export declare function packSeaPayload(entries: readonly SeaEntry[], entry: string): Buffer;
/** Reads a payload back: the entry file and every file's bytes and mode. The inverse of packSeaPayload. */
export declare function unpackSeaPayload(payload: Buffer): {
    entry: string;
    files: Map<string, {
        data: Buffer;
        mode: number;
    }>;
};
/** Writes `host` + payload + trailer to `outputFile`, and returns the payload's SHA-256. */
export declare function writeSeaExecutable(hostBinary: string, payload: Buffer, outputFile: string): string;
//# sourceMappingURL=SeaPayload.d.ts.map
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
export declare const SEA_MAGIC: Buffer<ArrayBuffer>;
export declare const SEA_TRAILER_BYTES = 88;
export declare const SEA_ENTRY_MARKER = ".forgegraal";
export interface SeaEntry {
    /** Path inside the unpacked directory, forward slashes. */
    path: string;
    data: Buffer;
    mode: number;
}
/** Every file under `dirs` (relative to `root`), skipping anything in `exclude` (root-relative paths). */
export declare function collectSeaEntries(root: string, dirs: readonly string[], exclude?: ReadonlySet<string>): SeaEntry[];
export declare function packSeaPayload(entries: readonly SeaEntry[], entry: string): Buffer;
/** Writes `host` + payload + trailer to `outputFile`, and returns the payload's SHA-256. */
export declare function writeSeaExecutable(hostBinary: string, payload: Buffer, outputFile: string): string;
//# sourceMappingURL=SeaPayload.d.ts.map
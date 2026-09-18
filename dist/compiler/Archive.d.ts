/**
 * FGAR: the application archive embedded into executables and portable bundles.
 *
 * gzip( "FGAR1\0" | uint32le manifestLength | manifest JSON | file bytes in manifest order )
 *
 * The runtime launcher (src/runtime/launcher.ts) contains an ES5 copy of the reader and
 * must be kept in sync with this format.
 */
export declare const ARCHIVE_MAGIC = "FGAR1\0";
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
export declare function assertSafeArchivePath(path: string): void;
export declare class Archive {
    static pack(entries: readonly ArchiveEntry[]): PackedArchive;
    static unpack(buffer: Buffer): Array<ArchiveManifestFile & {
        data: Buffer;
    }>;
}
//# sourceMappingURL=Archive.d.ts.map
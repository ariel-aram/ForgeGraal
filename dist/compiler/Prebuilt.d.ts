/**
 * Prebuilt copies of what Graak would otherwise compile on the machine that runs a build: the
 * native hosts (quickjs-ng + mbedTLS + wasm3, minutes of C compiling and a cross-compiler download)
 * and the Windows 7 compatibility DLLs. Neither can be built at all where there is no POSIX shell and
 * no mingw-w64/musl toolchain, which is every ordinary Windows machine.
 *
 * They live in `quickjs/prebuilt/` and are trusted only while the sources they were built from are the
 * sources on disk, so a change to the C code can never silently ship an old binary: the manifest carries
 * the digest of those sources, and `test/prebuilt.test.ts` fails when it goes stale.
 */
export interface PrebuiltHost {
    /** Gzip file name inside `quickjs/prebuilt/hosts/`. */
    file: string;
    /** SHA-256 of the executable itself (not the gzip), checked after extraction. */
    sha256: string;
    size: number;
}
export interface PrebuiltManifest {
    /** `Prebuilt.digest()` of the host sources these were built from. */
    sourceHash: string;
    hosts: Record<string, PrebuiltHost>;
}
export declare class Prebuilt {
    /** Digest of named files, independent of line endings. Names are part of the digest, order is not. */
    static digest(files: ReadonlyArray<readonly [name: string, path: string]>): string;
    /** Every `.c/.h/.sh/.py` file under `dir`, named relative to it, for `digest()`. */
    static sourcesUnder(dir: string, prefix?: string): Array<[string, string]>;
    static manifest(repoRoot: string): PrebuiltManifest | null;
    /**
     * The prebuilt host for `buildTarget` as bytes, or null when there is none, it was built from other
     * sources than `sourceHash`, or it does not match its recorded checksum.
     */
    static host(repoRoot: string, buildTarget: string, sourceHash: string): Buffer | null;
}
//# sourceMappingURL=Prebuilt.d.ts.map
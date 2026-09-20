import { TargetDevice } from "../structures";
import type { ArchiveEntry } from "./Archive";
export type NativeHostLibc = "musl" | "glibc";
export interface QuickJsBuildOptions {
    target: TargetDevice;
    name: string;
    /** Entry file, relative to the project root, POSIX separators (as `ProjectCollector` gives it). */
    entry: string;
    entries: ArchiveEntry[];
    outputPath: string;
    /** Path to a `forgegraal-c`(.exe) built by `ensureNativeHost()`. */
    nativeHostBinary: string;
}
export interface QuickJsBuildResult {
    outputPath: string;
    launcherPath: string;
    nativeHostBinary: string;
    sizeBytes: number;
    /** SHA-256 over the bundled app files and the native host binary, in write order. */
    sha256: string;
    warnings: string[];
}
export declare class QuickJsPackager {
    /** Whether this target has a wired-up native host build (see the module doc for why so few do). */
    static supports(target: TargetDevice): boolean;
    /**
     * Builds (and caches) the `forgegraal-c` binary for a target by invoking
     * `quickjs/native/build.sh`. Not a download: there is no published, checksummed release of
     * this binary yet (unlike `QuickJsRuntime`'s bare engine builds or Node.js itself), so the
     * only trustworthy source right now is building it from the pinned quickjs-ng/mbedTLS/miniz
     * versions the script fetches itself. Slow the first time, instant after — same cache
     * directory convention as `NodeRuntime`.
     */
    static ensureNativeHost(target: TargetDevice, libc?: NativeHostLibc, onLog?: (message: string) => void): Promise<string>;
    /**
     * Writes the project, the compatibility layer and the native host into `outputPath`, plus a
     * launcher script that runs them with no Node.js involved at any point.
     */
    static build(options: QuickJsBuildOptions): QuickJsBuildResult;
}
//# sourceMappingURL=QuickJsPackager.d.ts.map
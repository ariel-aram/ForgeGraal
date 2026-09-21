import { TargetDevice } from "../structures";
import type { ArchiveEntry } from "./Archive";
/** "musl" is the static host, "musl-dynamic" and "glibc" the ones that can load native addons. */
export type NativeHostLibc = "musl" | "musl-dynamic" | "glibc";
/**
 * Maps an addon's archive path to the package a developer actually depends on. Native packages
 * usually ship as a per-platform sibling (`@lmdb/lmdb-win32-x64`, `mediaplex-win32-x64-msvc`), so
 * the platform suffix is stripped and both the scoped and unscoped spellings are returned.
 */
export declare function addonPackageNames(addonPath: string): string[];
/**
 * Splits the native addons found in a project into the ones the bot can live without and the ones
 * it needs. `required` addons decide which host gets built: a static executable cannot dlopen, so a
 * bot that depends on one needs a dynamically linked host. `optional` ones are accelerators whose own
 * library falls back to pure JavaScript, and must not be the reason a build gives up the portable
 * static host.
 */
export declare function classifyNativeAddons(addonPaths: readonly string[]): {
    required: Map<string, string[]>;
    optional: Map<string, string[]>;
};
export interface QuickJsBuildOptions {
    target: TargetDevice;
    name: string;
    /** Entry file, relative to the project root, POSIX separators (as `ProjectCollector` gives it). */
    entry: string;
    entries: ArchiveEntry[];
    outputPath: string;
    /** Path to a `graak-c`(.exe) built by `ensureNativeHost()`. */
    nativeHostBinary: string;
    /**
     * Whether to ship the data behind `Intl` (about 7 MB, 1.5 MB compressed): `all`, `none`, or `auto` (the default), which
     * ships it when the program or a package it bundles mentions `Intl`, `toLocale*String` or `localeCompare`.
     */
    intl?: IntlData;
}
export type IntlData = "auto" | "all" | "none";
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
     * Whether the host built for `target` with `libc` can `dlopen` a native addon. Windows hosts are
     * ordinary dynamic executables and always can. On Linux only the dynamically linked glibc build
     * can: a static musl executable has no dynamic loader to load a library with, and this is a
     * property of static linking, not a limitation of the host's Node-API layer.
     */
    static loadsAddons(target: TargetDevice, libc: NativeHostLibc): boolean;
    /** Every distinct `build.sh` argument a host is built for, in a stable order. */
    static hostBuildTargets(): string[];
    /**
     * Compiles the host for one `build.sh` argument from source into `cacheDir` and returns the
     * executable. Needs a POSIX shell and the target's C toolchain; `ensureNativeHost` only comes here
     * when there is no matching prebuilt host.
     */
    static compileHost(repoRoot: string, buildTarget: string, cacheDir: string, onLog?: (message: string) => void): string;
    /**
     * Returns the `graak-c` binary for a target, from the cheapest place that has it: the cache
     * (instant), the prebuilt host that ships with Graak (a decompress), or `quickjs/native/build.sh`
     * (minutes; needs a shell and a C toolchain). Not a download: there is no published, checksummed
     * release of this binary, so the only trustworthy sources are the ones built from the pinned
     * quickjs-ng/mbedTLS/miniz/wasm3 versions the script fetches itself.
     */
    static ensureNativeHost(target: TargetDevice, libc?: NativeHostLibc, onLog?: (message: string) => void): Promise<string>;
    /**
     * Whether every one of these addon files is linked against musl rather than glibc, which decides
     * which dynamic host fits them: a musl-linked addon cannot load into a glibc process, or the reverse.
     */
    static addonsAreMusl(entries: readonly ArchiveEntry[], paths: readonly string[]): boolean;
    /**
     * Hash of everything under `quickjs/native/` that ends up inside the host binary. Line endings do
     * not count: a Windows checkout with CRLF must still recognise the prebuilt hosts.
     */
    static nativeSourceHash(repoRoot: string): string;
    /**
     * Writes the project, the compatibility layer and the native host into `outputPath`, plus a
     * launcher script that runs them with no Node.js involved at any point.
     */
    static build(options: QuickJsBuildOptions): QuickJsBuildResult;
}
//# sourceMappingURL=QuickJsPackager.d.ts.map
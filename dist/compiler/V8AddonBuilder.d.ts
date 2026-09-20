import { TargetDevice } from "../structures";
import type { ArchiveEntry } from "./Archive";
/** Whether an addon was compiled against V8 itself (and so cannot load outside Node.js as-is). */
export declare function isV8Addon(file: string): boolean;
type GypValue = string | number | boolean | null | GypValue[] | {
    [key: string]: GypValue;
};
type GypDict = {
    [key: string]: GypValue;
};
/** gyp files are Python dict literals: single or double quotes, `#` comments, trailing commas. */
export declare function parseGyp(text: string): GypDict;
export interface V8AddonPackage {
    /** Absolute directory of the package that owns the addon. */
    packageDir: string;
    /** Package name as it appears under node_modules. */
    name: string;
    /** Archive paths of that package's V8 `.node` files. */
    addonPaths: string[];
}
export interface V8BuildResult {
    /** Built addon, on disk. */
    file: string;
    /** Where the addon belongs inside the package (`build/Release/<target>.node`). */
    relativePath: string;
}
export declare class V8AddonBuilder {
    /** Whether V8 addons can be built for this target at all (needs the target's cross toolchain). */
    static supports(target: TargetDevice): boolean;
    /** Groups the project's V8 addons by owning package. `entries` are what the archive will contain. */
    static find(entries: readonly ArchiveEntry[]): V8AddonPackage[];
    private static packageDirOf;
    /** Compiles the package's addon for `target`. Throws, naming the reason, when it cannot. */
    static build(options: {
        pkg: V8AddonPackage;
        target: TargetDevice;
        onLog?: (message: string) => void;
    }): V8BuildResult;
    /**
     * Replaces a package's V8 `.node` files in the archive with the one built from source. The built
     * file goes where `bindings` and `node-gyp-build` look first, and any prebuilt binary for another
     * platform is dropped: it cannot run here and only adds weight.
     */
    static replace(entries: ArchiveEntry[], pkg: V8AddonPackage, built: V8BuildResult, packageArchiveDir: string): void;
    /** Archive directory of a package, from the archive path of one of its files. */
    static archiveDirOf(addonPath: string): string;
    private static topLevelVariables;
    private static expand;
    private static resolveTarget;
    /** `deps/zlib.gyp:zlib` -> the settings of that target in that file. */
    private static resolveDependency;
    private static findPackage;
    private static findNan;
    /**
     * Windows addons import their Node-API functions from a named module. Naming the host's own
     * executable makes the loader bind them to the running ForgeGraal host, which exports them.
     */
    private static writeImportLibrary;
    private static cacheKey;
}
export declare function copyAddon(from: string, to: string): void;
export {};
//# sourceMappingURL=V8AddonBuilder.d.ts.map
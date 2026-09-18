import type { ArchiveEntry } from "./Archive";
import { type BinaryInfo } from "./BinaryInspector";
export interface CollectOptions {
    entrypoint: string;
    /** Include devDependencies of the root project. */
    includeDev?: boolean;
    /** Include `.env*` files (they usually contain the bot token). */
    includeEnv?: boolean;
    /** Absolute paths that must never be bundled (e.g. the build output). */
    excludePaths?: readonly string[];
}
export interface NativeAddon {
    /** Path inside the bundle. */
    path: string;
    info: BinaryInfo | null;
}
export interface CollectedProject {
    root: string;
    name: string;
    /** Entrypoint relative to the root, POSIX separators. */
    entry: string;
    entries: ArchiveEntry[];
    nativeAddons: NativeAddon[];
    /** Highest `engines.node` lower bound across the bundle, if any. */
    minNode: string | null;
    usesBunApis: string[];
    packages: number;
}
export declare function isInside(child: string, parent: string): boolean;
/**
 * Resolves `input` against `root` and throws when it escapes `root` (symlinks included).
 */
export declare function resolveInside(root: string, input: string): string;
export declare function compareVersions(a: string, b: string): number;
export declare class ProjectCollector {
    private readonly root;
    private readonly options;
    private readonly excluded;
    /**
     * Finds the closest directory above `start` that contains a package.json.
     */
    static findProjectRoot(start: string): string;
    static collect(options: CollectOptions): CollectedProject;
    private readonly entries;
    private readonly nativeAddons;
    private readonly usesBunApis;
    private minNode;
    /** Destination package dir (e.g. "node_modules/a/node_modules/b") -> real source dir. */
    private readonly placed;
    /** Positions that must stay empty because a package resolves past them. */
    private readonly reserved;
    private readonly visitedDirs;
    private constructor();
    private isExcluded;
    private addFile;
    /**
     * Copies a directory tree, following symlinks while guarding against cycles.
     */
    private walk;
    private addProjectFiles;
    private addEngines;
    /**
     * Node.js resolution: look for `name` in node_modules directories from `fromDir` upwards.
     */
    private resolvePackageDir;
    private addDependencies;
    private place;
    private reserve;
}
//# sourceMappingURL=ProjectCollector.d.ts.map
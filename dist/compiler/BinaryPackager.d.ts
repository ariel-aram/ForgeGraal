import { type TargetDevice, type TargetMetadata } from "../structures";
import { type PackageManager } from "./PolicyEnforcer";
export type BuildStrategy = "auto" | "sea" | "portable";
export interface BuildOptions {
    entrypoint: string;
    target: TargetDevice | string;
    /** File path for SEA builds, directory path for portable builds. */
    output?: string;
    packageManager?: PackageManager | string;
    strategy?: BuildStrategy;
    /** Node.js runtime for the target (required for targets without official builds). */
    nodeBinary?: string;
    /** Official Node.js version to download, e.g. "22" or "22.11.0". */
    nodeVersion?: string;
    /** Disallow network access (no runtime downloads). */
    offline?: boolean;
    includeDev?: boolean;
    includeEnv?: boolean;
    allowNativeMismatch?: boolean;
    onLog?: (message: string) => void;
}
export interface BuildResult {
    success: true;
    strategy: "sea" | "portable";
    outputPath: string;
    /** Executable to start: the SEA binary or the portable launcher script. */
    launcherPath: string;
    target: TargetDevice;
    packageManager: PackageManager;
    sizeBytes: number;
    is32BitOrLegacy: boolean;
    metadata: TargetMetadata;
    runtimeVersion: string | null;
    archiveSha256: string;
    files: number;
    packages: number;
    durationMs: number;
    warnings: string[];
}
export declare const DEFAULT_OUTPUT_DIR = "forgegraal-out";
export declare class BinaryPackager {
    /**
     * Builds a ForgeScript bot into a Node.js Single Executable Application when the target
     * runtime supports it, otherwise into a portable bundle (launcher + archive + runtime).
     */
    static compile(options: BuildOptions): Promise<BuildResult>;
    private static checkNativeAddons;
    private static selectRuntime;
    /**
     * The SEA blob should be produced by the same Node.js version it is injected into.
     */
    private static selectGenerator;
}
//# sourceMappingURL=BinaryPackager.d.ts.map
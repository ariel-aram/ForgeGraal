import { type TargetDevice, type TargetMetadata } from "../structures";
import { type PackageManager } from "./PolicyEnforcer";
export type BuildStrategy = "auto" | "sea" | "portable";
/**
 * Runtimes below this major need their bundled code lowered and the modern platform APIs
 * supplied. Node.js 20 is the floor because that is where the last of what current discord.js
 * reaches for lands: `fetch`, Web Streams and `AbortController` are Node 18, but undici also
 * calls `String.prototype.toWellFormed`, which is Node 20.
 */
export declare const MIN_MODERN_API_NODE_MAJOR = 20;
/**
 * Lowest runtime the legacy pipeline can actually serve. esbuild refuses to emit below ES6
 * ("Transforming const to the configured target environment is not supported yet"), so a
 * runtime older than Node.js 6 cannot have modern code lowered for it at all. That is a real
 * ceiling, not a setting: the Windows Vista pin (Node.js 5.12.0) sits below it.
 */
export declare const MIN_TRANSPILABLE_NODE_MAJOR = 6;
export type LegacyRuntimePlan = {
    kind: "modern";
} | {
    kind: "lower";
    jsTarget: string;
} | {
    kind: "unreachable";
    reason: string;
};
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
    /**
     * Decides whether a build needs the legacy treatment, and which language level to lower to.
     * `null` means the runtime is modern enough to run current code as published.
     *
     * The esbuild target is built from the runtime's own major and minor rather than a fixed
     * string, so lowering is never more aggressive than the runtime requires.
     */
    static legacyRuntimePlan(runtimeVersion: string | null): LegacyRuntimePlan;
    private static checkNativeAddons;
    private static selectRuntime;
    /**
     * The SEA blob should be produced by the same Node.js version it is injected into.
     */
    private static selectGenerator;
}
//# sourceMappingURL=BinaryPackager.d.ts.map
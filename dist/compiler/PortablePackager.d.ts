import { type TargetMetadata } from "../structures";
export interface PortableBuildOptions {
    target: string;
    name: string;
    launcherSource: string;
    archive: Buffer;
    /** Output directory of the bundle. */
    outputPath: string;
    /** Optional target runtime copied next to the launcher. */
    runtimeBinary?: string | null;
}
export interface PortableBuildResult {
    outputPath: string;
    launcherPath: string;
    sizeBytes: number;
    bundledRuntime: boolean;
    warnings: string[];
}
export declare const BUNDLE_MARKER = ".forgegraal-bundle";
export declare class PortablePackager {
    static windowsLauncher(): string;
    /**
     * When `bootstrapInstall` is set (iSH's `apk`, FreeBSD's `pkg`), the launcher runs it
     * itself instead of just telling the user to — the device already has a real package
     * manager that ships a real Node.js build for its own platform, so there is nothing to
     * hunt down or verify a checksum for. Announced on stderr before it runs, since it does
     * modify the system; not silent.
     */
    static unixLauncher(meta: Pick<TargetMetadata, "runtimeHint" | "bootstrapInstall">): string;
    static build(options: PortableBuildOptions): PortableBuildResult;
}
//# sourceMappingURL=PortablePackager.d.ts.map
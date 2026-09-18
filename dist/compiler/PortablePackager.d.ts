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
    static unixLauncher(runtimeHint: string): string;
    static build(options: PortableBuildOptions): PortableBuildResult;
}
//# sourceMappingURL=PortablePackager.d.ts.map
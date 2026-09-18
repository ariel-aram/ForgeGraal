export interface SeaBuildOptions {
    target: string;
    /** Node.js runtime for the target platform the blob is injected into. */
    runtimeBinary: string;
    /** Node.js runtime runnable on this host, same version as the target runtime when possible. */
    generatorBinary: string;
    launcherSource: string;
    archive: Buffer;
    outputPath: string;
}
export interface SeaBuildResult {
    outputPath: string;
    sizeBytes: number;
    warnings: string[];
}
export declare class SeaPackager {
    /**
     * The SEA configuration consumed by `node --experimental-sea-config`.
     * Snapshots and code cache are disabled because they are only valid for the exact
     * platform and binary that generated them, which breaks cross compilation.
     */
    static createConfig(main: string, blob: string, assets?: Record<string, string>): {
        main: string;
        output: string;
        disableExperimentalSEAWarning: boolean;
        useSnapshot: boolean;
        useCodeCache: boolean;
        assets: Record<string, string>;
    };
    static build(options: SeaBuildOptions): Promise<SeaBuildResult>;
}
//# sourceMappingURL=SeaPackager.d.ts.map
import { type ForgeClient, ForgeExtension } from "@tryforge/forgescript";
export * from "./compiler";
export * from "./integrations";
export * from "./runtime/launcher";
export * from "./runtime/nativeShim";
export * from "./structures";
export interface IForgeGraalOptions {
    /**
     * Enables `$compileBinary`. Compiling reads the whole project, may download Node.js
     * runtimes and writes executables, so it is disabled unless explicitly allowed.
     */
    allowCompile?: boolean;
    /**
     * Directory that file-based functions (`$binarySize`, `$sha256Binary`, `$compileBinary`, ...)
     * are confined to. Defaults to the process working directory.
     */
    root?: string;
}
export declare const VERSION: string;
export declare class ForgeGraal extends ForgeExtension {
    readonly options: IForgeGraalOptions;
    name: string;
    description: string;
    version: string;
    constructor(options?: IForgeGraalOptions);
    init(_client: ForgeClient): void;
}
export default ForgeGraal;
//# sourceMappingURL=index.d.ts.map
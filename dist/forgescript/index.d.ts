import { type ForgeClient, ForgeExtension } from "@tryforge/forgescript";
export interface IGraakOptions {
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
/**
 * Graak as a ForgeScript extension: the target, policy and binary helpers as `$functions`, and
 * `$compileBinary` to build from inside a bot. Everything else in Graak works without ForgeScript;
 * this adapter is the only part of the package that imports it.
 */
export declare class Graak extends ForgeExtension {
    readonly options: IGraakOptions;
    name: string;
    description: string;
    version: string;
    constructor(options?: IGraakOptions);
    init(_client: ForgeClient): void;
}
export default Graak;
//# sourceMappingURL=index.d.ts.map
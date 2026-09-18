import { type ForgeClient, ForgeExtension } from "@tryforge/forgescript";

export * from "./compiler";
export * from "./integrations";
export * from "./runtime/bunCompat";
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

export const VERSION: string = require("../package.json").version;

export class ForgeGraal extends ForgeExtension {
	public name = "forgegraal";
	public description =
		"Compile ForgeScript bots into standalone executables for 32-bit (iSH, x86, ARMv7), legacy Windows and modern targets.";
	public version = VERSION;

	public constructor(public readonly options: IForgeGraalOptions = {}) {
		super();
	}

	public init(_client: ForgeClient): void {
		this.load(`${__dirname}/functions`);
	}
}

export default ForgeGraal;

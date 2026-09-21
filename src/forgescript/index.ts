import { type ForgeClient, ForgeExtension } from "@tryforge/forgescript";
import { VERSION } from "../index";

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
export class Graak extends ForgeExtension {
	public name = "graak";
	public description =
		"Package JavaScript and TypeScript programs into standalone executables for every device, including legacy Windows and 32-bit systems.";
	public version = VERSION;

	public constructor(public readonly options: IGraakOptions = {}) {
		super();
	}

	public init(_client: ForgeClient): void {
		this.load(`${__dirname}/functions`);
	}
}

export default Graak;

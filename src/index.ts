import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type ForgeClient, ForgeExtension } from "@tryforge/forgescript";

export * from "./compiler/index.js";
export * from "./native/index.js";
export * from "./structures/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ForgeGraal extends ForgeExtension {
	public override name = "forgegraal";
	public override description =
		"ForgeScript extension to compile bots into standalone binaries for 32-bit iSH, legacy Windows, and modern devices.";
	public override version = "1.0.0";

	public override init(_client: ForgeClient): void {
		this.load(`${__dirname}/native`);
	}
}

export default ForgeGraal;

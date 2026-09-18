import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { SeaPackager } from "../../compiler/SeaPackager";

export default new NativeFunction({
	name: "$generateSeaConfig",
	version: "1.0.0",
	description: "Returns a Node.js Single Executable Application configuration as JSON",
	unwrap: true,
	brackets: true,
	output: ArgType.Json,
	args: [
		{
			name: "main",
			description: "Entry script of the application",
			rest: false,
			type: ArgType.String,
			required: true,
		},
		{
			name: "output",
			description: "Path of the generated blob, defaults to sea-prep.blob",
			rest: false,
			type: ArgType.String,
		},
	],
	execute(_ctx, [main, output]) {
		return this.successJSON(SeaPackager.createConfig(main, output || "sea-prep.blob"));
	},
});

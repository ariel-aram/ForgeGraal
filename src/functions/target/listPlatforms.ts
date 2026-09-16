import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { ALL_TARGETS } from "../../structures";

export default new NativeFunction({
	name: "$listPlatforms",
	version: "1.0.0",
	description: "Returns every ForgeGraal target identifier",
	unwrap: true,
	brackets: false,
	output: ArgType.String,
	args: [
		{
			name: "separator",
			description: "Separator between targets, defaults to ,",
			rest: false,
			type: ArgType.String,
		},
	],
	execute(_ctx, [separator]) {
		return this.success(ALL_TARGETS.join(separator ?? ","));
	},
});

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { is32BitOrLegacy } from "../structures/index.js";

export default new NativeFunction({
	name: "$is32BitOrLegacy",
	version: "1.0.0",
	description:
		"Returns whether a target platform is 32-bit (iOS iSH, x86, ARMv7) or legacy Windows (Win 7/Vista)",
	unwrap: true,
	brackets: true,
	output: ArgType.Boolean,
	args: [
		{
			name: "target",
			description: "Target platform name to check",
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	execute(_ctx, [target]) {
		const result = is32BitOrLegacy(target);
		return this.success(result);
	},
});

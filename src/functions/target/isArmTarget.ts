import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { requireTarget, toError } from "../../util/functions";

export default new NativeFunction({
	name: "$isArmTarget",
	version: "1.0.0",
	description: "Returns whether a target uses an ARM CPU (armv7 or arm64)",
	unwrap: true,
	brackets: true,
	output: ArgType.Boolean,
	args: [
		{
			name: "target",
			description: "Target identifier (e.g. ios-ish-x86, win-legacy-x86, linux-modern-x64)",
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	execute(_ctx, [target]) {
		try {
			const meta = requireTarget(target);
			return this.success(meta.arch === "armv7" || meta.arch === "arm64");
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

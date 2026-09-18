import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { requireTarget, toError } from "../../util/functions";

export default new NativeFunction({
	name: "$isIsh",
	version: "1.0.0",
	description: "Returns whether a target is the 32-bit iSH emulator on iOS",
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
			return this.success(meta.os === "ios-ish");
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { requireTarget, toError } from "../../util";

export default new NativeFunction({
	name: "$targetBits",
	version: "1.0.0",
	description: "Returns the bitness of a target (32 or 64)",
	unwrap: true,
	brackets: true,
	output: ArgType.Number,
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
			return this.success(meta.bits);
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

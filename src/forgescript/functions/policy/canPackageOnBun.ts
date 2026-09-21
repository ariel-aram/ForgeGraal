import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { requireTarget, toError } from "../../util";

export default new NativeFunction({
	name: "$canPackageOnBun",
	version: "1.0.0",
	description:
		"Returns whether a target is one Bun cannot compile itself (32-bit or legacy), so Graak is the way to build it",
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
			return this.success(meta.is32BitOrLegacy);
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

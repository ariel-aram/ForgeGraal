import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { requireTarget, toError } from "../../util/functions";

export default new NativeFunction({
	name: "$targetPlatform",
	version: "1.0.0",
	description:
		"Returns the operating system family of a target (ios-ish, windows-legacy, windows, linux, darwin, freebsd)",
	unwrap: true,
	brackets: true,
	output: ArgType.String,
	args: [
		{
			name: "target",
			description:
				"Target identifier (e.g. ios-ish-x86, win-legacy-x86, linux-modern-x64)",
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	execute(_ctx, [target]) {
		try {
			const meta = requireTarget(target);
			return this.success(meta.os);
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

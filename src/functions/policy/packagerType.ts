import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { QuickJsPackager } from "../../compiler/QuickJsPackager";
import { requireTarget, toError } from "../../util/functions";

export default new NativeFunction({
	name: "$packagerType",
	version: "1.0.0",
	description:
		"Returns the default build strategy of a target: native when it runs on the ForgeGraal native host, otherwise sea when an official Node.js runtime is downloadable, portable if not",
	unwrap: true,
	brackets: true,
	output: ArgType.String,
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
			if (QuickJsPackager.supports(meta.id)) return this.success("native");
			return this.success(meta.officialNodeFile ? "sea" : "portable");
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

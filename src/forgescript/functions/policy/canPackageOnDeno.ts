import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { DenoProject } from "../../../compiler/DenoProject";
import { requireTarget, toError } from "../../util";

export default new NativeFunction({
	name: "$canPackageOnDeno",
	version: "1.0.0",
	description:
		"Returns whether a target is one `deno compile` cannot build itself (32-bit, legacy Windows, iSH, ARMv7, FreeBSD), so Graak is the way to build it",
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
			return this.success(!DenoProject.canDenoCompile(requireTarget(target).id));
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

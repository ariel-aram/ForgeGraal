import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { type PackageManager, PolicyEnforcer } from "../compiler/index.js";

export default new NativeFunction({
	name: "$isTargetSupported",
	version: "1.0.0",
	description:
		"Returns whether a target device is supported under the current or specified package manager",
	unwrap: true,
	brackets: true,
	output: ArgType.Boolean,
	args: [
		{
			name: "target",
			description: "Target identifier (e.g. ios-ish-x86, win-legacy-x86)",
			rest: false,
			type: ArgType.String,
			required: true,
		},
		{
			name: "packageManager",
			description: "Optional package manager override (bun, pnpm, npm, yarn)",
			rest: false,
			type: ArgType.String,
			required: false,
		},
	],
	execute(_ctx, [target, pm]) {
		const targetPm =
			(pm?.toLowerCase() as PackageManager) ??
			PolicyEnforcer.detectPackageManager();
		const check = PolicyEnforcer.checkTarget(target, targetPm);
		return this.success(check.allowed);
	},
});

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { type PackageManager, PolicyEnforcer } from "../compiler/index.js";

export default new NativeFunction({
	name: "$supportedTargets",
	version: "1.0.0",
	description:
		"Returns the list of supported compilation targets for a package manager (restricted to 32-bit & legacy Windows on Bun)",
	unwrap: true,
	brackets: true,
	args: [
		{
			name: "packageManager",
			description: "Optional package manager name (bun, pnpm, npm, yarn)",
			rest: false,
			type: ArgType.String,
			required: false,
		},
	],
	execute(_ctx, [pm]) {
		const targetPm =
			(pm?.toLowerCase() as PackageManager) ??
			PolicyEnforcer.detectPackageManager();
		const targets = PolicyEnforcer.getAllowedTargets(targetPm);
		return this.success(targets.join(","));
	},
});

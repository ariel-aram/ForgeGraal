import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { PolicyEnforcer } from "../compiler/index.js";

export default new NativeFunction({
	name: "$packageManager",
	version: "1.0.0",
	description:
		"Returns the detected active package manager (bun, pnpm, npm, yarn)",
	unwrap: true,
	output: ArgType.String,
	execute(_ctx) {
		const pm = PolicyEnforcer.detectPackageManager();
		return this.success(pm);
	},
});

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import {
	BinaryPackager,
	type PackageManager,
	PolicyEnforcer,
} from "../compiler/index.js";

export default new NativeFunction({
	name: "$compileBinary",
	version: "1.0.0",
	description:
		"Compiles a ForgeScript bot into a standalone binary for 32-bit iSH, legacy Windows, or modern devices",
	unwrap: true,
	brackets: true,
	args: [
		{
			name: "entrypoint",
			description: "Path to the bot main entrypoint script",
			rest: false,
			type: ArgType.String,
			required: true,
		},
		{
			name: "target",
			description:
				"Target device platform (e.g. ios-ish-x86, win-legacy-x86, win-modern-x64)",
			rest: false,
			type: ArgType.String,
			required: true,
		},
		{
			name: "output",
			description: "Optional destination path for the compiled binary",
			rest: false,
			type: ArgType.String,
			required: false,
		},
		{
			name: "packageManager",
			description: "Optional package manager override (bun, pnpm, npm, yarn)",
			rest: false,
			type: ArgType.String,
			required: false,
		},
	],
	async execute(_ctx, [entrypoint, target, output, pm]) {
		try {
			const detectedPm =
				(pm?.toLowerCase() as PackageManager) ??
				PolicyEnforcer.detectPackageManager();
			const result = await BinaryPackager.compile({
				entrypoint,
				target,
				output: output || undefined,
				packageManager: detectedPm,
			});
			return this.success(result.outputPath);
		} catch (err: unknown) {
			const errObj = err instanceof Error ? err : new Error(String(err));
			return this.error(errObj);
		}
	},
});

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { BinaryPackager, type BuildStrategy } from "../../../compiler/BinaryPackager";
import { getGraak, resolveFileArg, toError } from "../../util";

export default new NativeFunction({
	name: "$compileBinary",
	version: "1.0.0",
	description:
		"Compiles a bot into a standalone executable or portable bundle and returns its path. Requires `new Graak({ allowCompile: true })`",
	unwrap: true,
	brackets: true,
	output: ArgType.String,
	args: [
		{
			name: "entrypoint",
			description: "Built JavaScript entrypoint of the bot, relative to the bot root",
			rest: false,
			type: ArgType.String,
			required: true,
		},
		{
			name: "target",
			description: "Target identifier (e.g. ios-ish-x86, win-legacy-x86, linux-modern-x64)",
			rest: false,
			type: ArgType.String,
			required: true,
		},
		{
			name: "output",
			description: "Output file (sea) or directory (portable), relative to the bot root",
			rest: false,
			type: ArgType.String,
		},
		{
			name: "strategy",
			description: "auto, sea or portable",
			rest: false,
			type: ArgType.String,
		},
		{
			name: "packageManager",
			description: "Package manager (bun, pnpm, npm, yarn), detected from the project when empty",
			rest: false,
			type: ArgType.String,
		},
	],
	async execute(ctx, [entrypoint, target, output, strategy, pm]) {
		if (!getGraak(ctx)?.options.allowCompile) {
			return this.customError("$compileBinary is disabled; enable it with new Graak({ allowCompile: true })");
		}
		try {
			const result = await BinaryPackager.compile({
				entrypoint: resolveFileArg(ctx, entrypoint),
				target,
				output: output ? resolveFileArg(ctx, output) : undefined,
				strategy: (strategy?.trim().toLowerCase() || "auto") as BuildStrategy,
				packageManager: pm ?? undefined,
			});
			return this.success(result.launcherPath);
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

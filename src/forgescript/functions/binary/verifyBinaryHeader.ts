import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { BinaryInspector } from "../../../compiler/BinaryInspector";
import { requireTarget, resolveFileArg, toError } from "../../util";

export default new NativeFunction({
	name: "$verifyBinaryHeader",
	version: "1.0.0",
	description: "Returns whether a file is a valid ELF, PE or Mach-O executable, optionally for a specific target",
	unwrap: true,
	brackets: true,
	output: ArgType.Boolean,
	args: [
		{
			name: "path",
			description: "Path to the file, relative to the bot root",
			rest: false,
			type: ArgType.String,
			required: true,
		},
		{
			name: "target",
			description: "Target the executable must run on",
			rest: false,
			type: ArgType.String,
		},
	],
	execute(ctx, [path, target]) {
		try {
			const info = BinaryInspector.inspect(resolveFileArg(ctx, path));
			if (!info) return this.success(false);
			if (!target) return this.success(true);
			return this.success(BinaryInspector.matchesTarget(info, requireTarget(target).id));
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

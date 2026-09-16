import { statSync } from "node:fs";
import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { resolveFileArg, toError } from "../../util/functions";

export default new NativeFunction({
	name: "$binarySize",
	version: "1.0.0",
	description: "Returns the size in bytes of a compiled executable",
	unwrap: true,
	brackets: true,
	output: ArgType.Number,
	args: [
		{
			name: "path",
			description: "Path to the file, relative to the bot root",
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	execute(ctx, [path]) {
		try {
			const stats = statSync(resolveFileArg(ctx, path));
			if (!stats.isFile()) return this.customError(`'${path}' is not a file`);
			return this.success(stats.size);
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

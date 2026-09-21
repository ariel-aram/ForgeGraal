import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { resolveFileArg, toError } from "../../util";

export default new NativeFunction({
	name: "$sha256Binary",
	version: "1.0.0",
	description: "Returns the SHA-256 hex digest of a compiled executable",
	unwrap: true,
	brackets: true,
	output: ArgType.String,
	args: [
		{
			name: "path",
			description: "Path to the file, relative to the bot root",
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	async execute(ctx, [path]) {
		try {
			const hash = createHash("sha256");
			await pipeline(createReadStream(resolveFileArg(ctx, path)), hash);
			return this.success(hash.digest("hex"));
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

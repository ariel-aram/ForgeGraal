/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import fs from "node:fs";
import { ArgType, NativeFunction } from "@tryforge/forgescript";

export default new NativeFunction({
	name: "$binarySize",
	version: "1.0.0",
	description: "Returns the byte size of a target executable binary",
	unwrap: true,
	brackets: true,
	output: ArgType.Number,
	args: [
		{
			name: "filePath",
			description: "Path to binary file",
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	execute(_ctx, [filePath]) {
		if (!filePath || !fs.existsSync(filePath)) {
			return this.error(new Error(`Binary file not found: '${filePath}'`));
		}
		const stats = fs.statSync(filePath);
		return this.success(stats.size);
	},
});

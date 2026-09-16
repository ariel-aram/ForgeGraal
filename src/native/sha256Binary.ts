/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { ArgType, NativeFunction } from "@tryforge/forgescript";

export default new NativeFunction({
	name: "$sha256Binary",
	version: "1.0.0",
	description: "Computes SHA-256 hex digest of a compiled binary file",
	unwrap: true,
	brackets: true,
	output: ArgType.String,
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
		const buffer = fs.readFileSync(filePath);
		const hash = crypto.createHash("sha256").update(buffer).digest("hex");
		return this.success(hash);
	},
});

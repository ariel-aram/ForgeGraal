/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { TARGET_METADATA_MAP, type TargetDevice } from "../structures/index.js";

export default new NativeFunction({
	name: "$binaryFormat",
	version: "1.0.0",
	description:
		"Returns the executable wrapper format of a target (elf32, elf64, pe32, pe32plus, macho)",
	unwrap: true,
	brackets: true,
	output: ArgType.String,
	args: [
		{
			name: "target",
			description: "Target identifier",
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	execute(_ctx, [target]) {
		const meta = TARGET_METADATA_MAP[target as TargetDevice];
		if (!meta) {
			return this.error(new Error(`Unknown target '${target}'`));
		}
		return this.success(meta.binaryFormat);
	},
});

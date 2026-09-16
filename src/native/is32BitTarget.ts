/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { TARGET_METADATA_MAP, type TargetDevice } from "../structures/index.js";

export default new NativeFunction({
	name: "$is32BitTarget",
	version: "1.0.0",
	description:
		"Returns whether a target platform runs on a 32-bit CPU architecture",
	unwrap: true,
	brackets: true,
	output: ArgType.Boolean,
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
		return this.success(meta.bits === 32);
	},
});

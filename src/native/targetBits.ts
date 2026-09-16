/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { TARGET_METADATA_MAP, type TargetDevice } from "../structures/index.js";

export default new NativeFunction({
	name: "$targetBits",
	version: "1.0.0",
	description: "Returns the bitness of a target device architecture (32 or 64)",
	unwrap: true,
	brackets: true,
	output: ArgType.Number,
	args: [
		{
			name: "target",
			description: "Target identifier (e.g. ios-ish-x86, win-modern-x64)",
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
		return this.success(meta.bits);
	},
});

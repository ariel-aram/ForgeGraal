/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { TARGET_METADATA_MAP, type TargetDevice } from "../structures/index.js";

export default new NativeFunction({
	name: "$canPackageOnBun",
	version: "1.0.0",
	description:
		"Checks whether a target platform is legally allowed when bot uses Bun",
	unwrap: true,
	brackets: true,
	output: ArgType.Boolean,
	args: [
		{
			name: "target",
			description: "Target device identifier to check",
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	execute(_ctx, [target]) {
		const meta = TARGET_METADATA_MAP[target as TargetDevice];
		if (!meta) {
			return this.success(false);
		}
		return this.success(meta.is32BitOrLegacy);
	},
});

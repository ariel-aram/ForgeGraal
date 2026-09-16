/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { TARGET_METADATA_MAP, type TargetDevice } from "../structures/index.js";

export default new NativeFunction({
	name: "$binaryArchitecture",
	version: "1.0.0",
	description:
		"Returns the CPU architecture of a target platform (x86, x64, armv7, arm64)",
	unwrap: true,
	brackets: true,
	output: ArgType.String,
	args: [
		{
			name: "target",
			description: "Target identifier (e.g. ios-ish-x86, win-legacy-x86)",
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
		return this.success(meta.arch);
	},
});

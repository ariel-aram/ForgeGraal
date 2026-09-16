/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { TargetDevice } from "../structures/index.js";

export default new NativeFunction({
	name: "$isIsh",
	version: "1.0.0",
	description:
		"Returns whether a target represents the 32-bit iSH iOS emulator platform",
	unwrap: true,
	brackets: true,
	output: ArgType.Boolean,
	args: [
		{
			name: "target",
			description: "Target identifier to evaluate",
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	execute(_ctx, [target]) {
		const isIshTarget = target.trim().toLowerCase() === TargetDevice.IosIshX86;
		return this.success(isIshTarget);
	},
});

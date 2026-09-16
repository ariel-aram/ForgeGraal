/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { TargetDevice } from "../structures/index.js";

export default new NativeFunction({
	name: "$packagerType",
	version: "1.0.0",
	description:
		"Returns the compiler packager engine that handles the target (ish, win-legacy, modern)",
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
		const clean = target.trim().toLowerCase();
		if (clean === TargetDevice.IosIshX86) {
			return this.success("ish");
		}
		if (
			clean === TargetDevice.WinLegacyX86 ||
			clean === TargetDevice.WinLegacyX64
		) {
			return this.success("win-legacy");
		}
		return this.success("modern");
	},
});

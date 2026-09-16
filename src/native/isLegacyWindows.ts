/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { TargetDevice } from "../structures/index.js";

export default new NativeFunction({
	name: "$isLegacyWindows",
	version: "1.0.0",
	description:
		"Returns whether a target platform is legacy Windows (Windows 7 or Vista)",
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
		const clean = target.trim().toLowerCase();
		const isLegacy =
			clean === TargetDevice.WinLegacyX86 ||
			clean === TargetDevice.WinLegacyX64;
		return this.success(isLegacy);
	},
});

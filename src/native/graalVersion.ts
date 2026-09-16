/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";

export default new NativeFunction({
	name: "$graalVersion",
	version: "1.0.0",
	description:
		"Returns the current ForgeGraal compiler version and engine name",
	unwrap: true,
	output: ArgType.String,
	execute(_ctx) {
		return this.success("forgegraal@1.0.0");
	},
});

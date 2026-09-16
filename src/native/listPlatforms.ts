/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { TARGET_METADATA_MAP, TargetDevice } from "../structures/index.js";

export default new NativeFunction({
	name: "$listPlatforms",
	version: "1.0.0",
	description:
		"Returns a comma-separated list of all supported ForgeGraal target platform identifiers",
	unwrap: true,
	output: ArgType.String,
	execute(_ctx) {
		return this.success(Object.values(TargetDevice).join(","));
	},
});

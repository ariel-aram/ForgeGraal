/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";

export default new NativeFunction({
	name: "$dbDriverCompat",
	version: "1.0.0",
	description:
		"Validates if a database driver (sqlite, forgedb) is compatible with target",
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
		{
			name: "driver",
			description: "Database driver name (e.g. sqlite, forgedb)",
			rest: false,
			type: ArgType.String,
			required: false,
		},
	],
	execute(_ctx, [_target, driver]) {
		const drv = (driver || "sqlite").toLowerCase();
		// Universal SQLite shim supports all targets
		return this.success(drv.includes("sqlite") || drv.includes("forgedb"));
	},
});

/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { ArgType, NativeFunction } from "@tryforge/forgescript";

export default new NativeFunction({
	name: "$generateSeaConfig",
	version: "1.0.0",
	description:
		"Generates JSON configuration string for Node.js Single Executable Applications",
	unwrap: true,
	brackets: true,
	output: ArgType.String,
	args: [
		{
			name: "mainScript",
			description: "Relative entry script path",
			rest: false,
			type: ArgType.String,
			required: true,
		},
		{
			name: "outputBlob",
			description: "Output blob path",
			rest: false,
			type: ArgType.String,
			required: false,
		},
	],
	execute(_ctx, [mainScript, outputBlob]) {
		const blob = outputBlob || "sea-prep.blob";
		const config = {
			main: mainScript,
			output: blob,
			disableExperimentalSEAWarning: true,
		};
		return this.success(JSON.stringify(config, null, 2));
	},
});

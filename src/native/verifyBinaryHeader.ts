/*
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * ForgeGraal Autonomous Evolution Engine
 */

import { Buffer } from "node:buffer";
import fs from "node:fs";
import { ArgType, NativeFunction } from "@tryforge/forgescript";

export default new NativeFunction({
	name: "$verifyBinaryHeader",
	version: "1.0.0",
	description:
		"Verifies magic headers of compiled binary (ELF for iSH/Linux or PE for Windows)",
	unwrap: true,
	brackets: true,
	output: ArgType.Boolean,
	args: [
		{
			name: "filePath",
			description: "Path to binary file",
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	execute(_ctx, [filePath]) {
		if (!filePath || !fs.existsSync(filePath)) {
			return this.success(false);
		}
		const fd = fs.openSync(filePath, "r");
		const buf = Buffer.alloc(4);
		fs.readSync(fd, buf, 0, 4, 0);
		fs.closeSync(fd);
		const isElf =
			buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
		const isPe = buf[0] === 0x4d && buf[1] === 0x5a;
		return this.success(isElf || isPe);
	},
});

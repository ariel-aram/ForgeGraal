import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { VERSION } from "../../../index";

export default new NativeFunction({
	name: "$graakVersion",
	version: "1.0.0",
	description: "Returns the installed Graak version",
	unwrap: false,
	output: ArgType.String,
	execute(_ctx) {
		return this.success(VERSION);
	},
});

import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { VERSION } from "../../index";

export default new NativeFunction({
	name: "$graalVersion",
	version: "1.0.0",
	description: "Returns the installed ForgeGraal version",
	unwrap: false,
	output: ArgType.String,
	execute(_ctx) {
		return this.success(VERSION);
	},
});

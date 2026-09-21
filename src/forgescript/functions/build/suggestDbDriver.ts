import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { FORGEDB_DRIVERS, ForgeDBIntegration } from "../../../integrations/ForgeDBIntegration";
import { toError } from "../../util";

export default new NativeFunction({
	name: "$suggestDbDriver",
	version: "1.0.0",
	description:
		"Returns a pure JavaScript ForgeDB driver to switch to when `driver` is native (empty string when it already is one)",
	unwrap: true,
	brackets: true,
	output: ArgType.String,
	args: [
		{
			name: "driver",
			description: `ForgeDB database type (${Object.keys(FORGEDB_DRIVERS).join(", ")})`,
			rest: false,
			type: ArgType.String,
			required: true,
		},
	],
	execute(_ctx, [driver]) {
		try {
			const parsed = ForgeDBIntegration.parseDriver(driver);
			if (!parsed) return this.customError(`Unknown ForgeDB driver '${driver}'`);
			return this.success(ForgeDBIntegration.suggestAlternative(parsed) ?? "");
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

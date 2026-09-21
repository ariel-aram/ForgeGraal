import { ArgType, NativeFunction } from "@tryforge/forgescript";
import { FORGEDB_DRIVERS, ForgeDBIntegration } from "../../../integrations/ForgeDBIntegration";
import { getRoot, requireTarget, toError } from "../../util";

export default new NativeFunction({
	name: "$dbDriverCompat",
	version: "1.0.0",
	description:
		"Returns whether the installed ForgeDB driver of the bot can run on a target (native drivers need an addon built for it)",
	unwrap: true,
	brackets: true,
	output: ArgType.Boolean,
	args: [
		{
			name: "target",
			description: "Target identifier (e.g. ios-ish-x86, win-legacy-x86, linux-modern-x64)",
			rest: false,
			type: ArgType.String,
			required: true,
		},
		{
			name: "driver",
			description: `ForgeDB database type (${Object.keys(FORGEDB_DRIVERS).join(", ")}), defaults to sqlite`,
			rest: false,
			type: ArgType.String,
		},
	],
	execute(ctx, [target, driver]) {
		try {
			const meta = requireTarget(target);
			const parsed = ForgeDBIntegration.parseDriver(driver || "sqlite");
			if (!parsed) return this.customError(`Unknown ForgeDB driver '${driver}'`);
			return this.success(ForgeDBIntegration.checkDriver(parsed, meta.id, getRoot(ctx)).compatible);
		} catch (err) {
			return this.error(toError(err));
		}
	},
});

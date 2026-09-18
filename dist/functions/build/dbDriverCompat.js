"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const ForgeDBIntegration_1 = require("../../integrations/ForgeDBIntegration");
const functions_1 = require("../../util/functions");
exports.default = new forgescript_1.NativeFunction({
    name: "$dbDriverCompat",
    version: "1.0.0",
    description: "Returns whether the installed ForgeDB driver of the bot can run on a target (native drivers need an addon built for it)",
    unwrap: true,
    brackets: true,
    output: forgescript_1.ArgType.Boolean,
    args: [
        {
            name: "target",
            description: "Target identifier (e.g. ios-ish-x86, win-legacy-x86, linux-modern-x64)",
            rest: false,
            type: forgescript_1.ArgType.String,
            required: true,
        },
        {
            name: "driver",
            description: `ForgeDB database type (${Object.keys(ForgeDBIntegration_1.FORGEDB_DRIVERS).join(", ")}), defaults to sqlite`,
            rest: false,
            type: forgescript_1.ArgType.String,
        },
    ],
    execute(ctx, [target, driver]) {
        try {
            const meta = (0, functions_1.requireTarget)(target);
            const parsed = ForgeDBIntegration_1.ForgeDBIntegration.parseDriver(driver || "sqlite");
            if (!parsed)
                return this.customError(`Unknown ForgeDB driver '${driver}'`);
            return this.success(ForgeDBIntegration_1.ForgeDBIntegration.checkDriver(parsed, meta.id, (0, functions_1.getRoot)(ctx))
                .compatible);
        }
        catch (err) {
            return this.error((0, functions_1.toError)(err));
        }
    },
});
//# sourceMappingURL=dbDriverCompat.js.map
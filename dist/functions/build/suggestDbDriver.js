"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const ForgeDBIntegration_1 = require("../../integrations/ForgeDBIntegration");
const functions_1 = require("../../util/functions");
exports.default = new forgescript_1.NativeFunction({
    name: "$suggestDbDriver",
    version: "1.0.0",
    description: "Returns a pure JavaScript ForgeDB driver to switch to when `driver` is native (empty string when it already is one)",
    unwrap: true,
    brackets: true,
    output: forgescript_1.ArgType.String,
    args: [
        {
            name: "driver",
            description: `ForgeDB database type (${Object.keys(ForgeDBIntegration_1.FORGEDB_DRIVERS).join(", ")})`,
            rest: false,
            type: forgescript_1.ArgType.String,
            required: true,
        },
    ],
    execute(_ctx, [driver]) {
        try {
            const parsed = ForgeDBIntegration_1.ForgeDBIntegration.parseDriver(driver);
            if (!parsed)
                return this.customError(`Unknown ForgeDB driver '${driver}'`);
            return this.success(ForgeDBIntegration_1.ForgeDBIntegration.suggestAlternative(parsed) ?? "");
        }
        catch (err) {
            return this.error((0, functions_1.toError)(err));
        }
    },
});
//# sourceMappingURL=suggestDbDriver.js.map
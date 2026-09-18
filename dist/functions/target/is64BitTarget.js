"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const functions_1 = require("../../util/functions");
exports.default = new forgescript_1.NativeFunction({
    name: "$is64BitTarget",
    version: "1.0.0",
    description: "Returns whether a target uses a 64-bit CPU architecture",
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
    ],
    execute(_ctx, [target]) {
        try {
            const meta = (0, functions_1.requireTarget)(target);
            return this.success(meta.bits === 64);
        }
        catch (err) {
            return this.error((0, functions_1.toError)(err));
        }
    },
});
//# sourceMappingURL=is64BitTarget.js.map
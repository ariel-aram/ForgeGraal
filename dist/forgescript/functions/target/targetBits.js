"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const util_1 = require("../../util");
exports.default = new forgescript_1.NativeFunction({
    name: "$targetBits",
    version: "1.0.0",
    description: "Returns the bitness of a target (32 or 64)",
    unwrap: true,
    brackets: true,
    output: forgescript_1.ArgType.Number,
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
            const meta = (0, util_1.requireTarget)(target);
            return this.success(meta.bits);
        }
        catch (err) {
            return this.error((0, util_1.toError)(err));
        }
    },
});
//# sourceMappingURL=targetBits.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const util_1 = require("../../util");
exports.default = new forgescript_1.NativeFunction({
    name: "$canPackageOnBun",
    version: "1.0.0",
    description: "Returns whether a target is one Bun cannot compile itself (32-bit or legacy), so Graak is the way to build it",
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
            const meta = (0, util_1.requireTarget)(target);
            return this.success(meta.is32BitOrLegacy);
        }
        catch (err) {
            return this.error((0, util_1.toError)(err));
        }
    },
});
//# sourceMappingURL=canPackageOnBun.js.map
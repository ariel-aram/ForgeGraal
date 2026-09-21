"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const util_1 = require("../../util");
exports.default = new forgescript_1.NativeFunction({
    name: "$targetPlatform",
    version: "1.0.0",
    description: "Returns the operating system family of a target (ios-ish, windows-legacy, windows, linux, darwin, freebsd)",
    unwrap: true,
    brackets: true,
    output: forgescript_1.ArgType.String,
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
            return this.success(meta.os);
        }
        catch (err) {
            return this.error((0, util_1.toError)(err));
        }
    },
});
//# sourceMappingURL=targetPlatform.js.map
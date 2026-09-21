"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const util_1 = require("../../util");
exports.default = new forgescript_1.NativeFunction({
    name: "$binaryArchitecture",
    version: "1.0.0",
    description: "Returns the CPU architecture of a target (x86, x64, armv7, arm64)",
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
            return this.success(meta.arch);
        }
        catch (err) {
            return this.error((0, util_1.toError)(err));
        }
    },
});
//# sourceMappingURL=binaryArchitecture.js.map
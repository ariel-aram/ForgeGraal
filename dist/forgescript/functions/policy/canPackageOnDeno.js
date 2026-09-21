"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const DenoProject_1 = require("../../../compiler/DenoProject");
const util_1 = require("../../util");
exports.default = new forgescript_1.NativeFunction({
    name: "$canPackageOnDeno",
    version: "1.0.0",
    description: "Returns whether a target is one `deno compile` cannot build itself (32-bit, legacy Windows, iSH, ARMv7, FreeBSD), so Graak is the way to build it",
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
            return this.success(!DenoProject_1.DenoProject.canDenoCompile((0, util_1.requireTarget)(target).id));
        }
        catch (err) {
            return this.error((0, util_1.toError)(err));
        }
    },
});
//# sourceMappingURL=canPackageOnDeno.js.map
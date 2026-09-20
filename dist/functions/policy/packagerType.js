"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const QuickJsPackager_1 = require("../../compiler/QuickJsPackager");
const functions_1 = require("../../util/functions");
exports.default = new forgescript_1.NativeFunction({
    name: "$packagerType",
    version: "1.0.0",
    description: "Returns the default build strategy of a target: native when it runs on the ForgeGraal native host, otherwise sea when an official Node.js runtime is downloadable, portable if not",
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
            const meta = (0, functions_1.requireTarget)(target);
            if (QuickJsPackager_1.QuickJsPackager.supports(meta.id))
                return this.success("native");
            return this.success(meta.officialNodeFile ? "sea" : "portable");
        }
        catch (err) {
            return this.error((0, functions_1.toError)(err));
        }
    },
});
//# sourceMappingURL=packagerType.js.map
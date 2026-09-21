"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const BinaryInspector_1 = require("../../../compiler/BinaryInspector");
const util_1 = require("../../util");
exports.default = new forgescript_1.NativeFunction({
    name: "$verifyBinaryHeader",
    version: "1.0.0",
    description: "Returns whether a file is a valid ELF, PE or Mach-O executable, optionally for a specific target",
    unwrap: true,
    brackets: true,
    output: forgescript_1.ArgType.Boolean,
    args: [
        {
            name: "path",
            description: "Path to the file, relative to the bot root",
            rest: false,
            type: forgescript_1.ArgType.String,
            required: true,
        },
        {
            name: "target",
            description: "Target the executable must run on",
            rest: false,
            type: forgescript_1.ArgType.String,
        },
    ],
    execute(ctx, [path, target]) {
        try {
            const info = BinaryInspector_1.BinaryInspector.inspect((0, util_1.resolveFileArg)(ctx, path));
            if (!info)
                return this.success(false);
            if (!target)
                return this.success(true);
            return this.success(BinaryInspector_1.BinaryInspector.matchesTarget(info, (0, util_1.requireTarget)(target).id));
        }
        catch (err) {
            return this.error((0, util_1.toError)(err));
        }
    },
});
//# sourceMappingURL=verifyBinaryHeader.js.map
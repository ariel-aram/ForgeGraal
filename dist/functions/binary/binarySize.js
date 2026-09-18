"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const forgescript_1 = require("@tryforge/forgescript");
const functions_1 = require("../../util/functions");
exports.default = new forgescript_1.NativeFunction({
    name: "$binarySize",
    version: "1.0.0",
    description: "Returns the size in bytes of a compiled executable",
    unwrap: true,
    brackets: true,
    output: forgescript_1.ArgType.Number,
    args: [
        {
            name: "path",
            description: "Path to the file, relative to the bot root",
            rest: false,
            type: forgescript_1.ArgType.String,
            required: true,
        },
    ],
    execute(ctx, [path]) {
        try {
            const stats = (0, node_fs_1.statSync)((0, functions_1.resolveFileArg)(ctx, path));
            if (!stats.isFile())
                return this.customError(`'${path}' is not a file`);
            return this.success(stats.size);
        }
        catch (err) {
            return this.error((0, functions_1.toError)(err));
        }
    },
});
//# sourceMappingURL=binarySize.js.map
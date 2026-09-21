"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:stream/promises");
const forgescript_1 = require("@tryforge/forgescript");
const util_1 = require("../../util");
exports.default = new forgescript_1.NativeFunction({
    name: "$sha256Binary",
    version: "1.0.0",
    description: "Returns the SHA-256 hex digest of a compiled executable",
    unwrap: true,
    brackets: true,
    output: forgescript_1.ArgType.String,
    args: [
        {
            name: "path",
            description: "Path to the file, relative to the bot root",
            rest: false,
            type: forgescript_1.ArgType.String,
            required: true,
        },
    ],
    async execute(ctx, [path]) {
        try {
            const hash = (0, node_crypto_1.createHash)("sha256");
            await (0, promises_1.pipeline)((0, node_fs_1.createReadStream)((0, util_1.resolveFileArg)(ctx, path)), hash);
            return this.success(hash.digest("hex"));
        }
        catch (err) {
            return this.error((0, util_1.toError)(err));
        }
    },
});
//# sourceMappingURL=sha256Binary.js.map
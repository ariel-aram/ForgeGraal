"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const SeaPackager_1 = require("../../../compiler/SeaPackager");
exports.default = new forgescript_1.NativeFunction({
    name: "$generateSeaConfig",
    version: "1.0.0",
    description: "Returns a Node.js Single Executable Application configuration as JSON",
    unwrap: true,
    brackets: true,
    output: forgescript_1.ArgType.Json,
    args: [
        {
            name: "main",
            description: "Entry script of the application",
            rest: false,
            type: forgescript_1.ArgType.String,
            required: true,
        },
        {
            name: "output",
            description: "Path of the generated blob, defaults to sea-prep.blob",
            rest: false,
            type: forgescript_1.ArgType.String,
        },
    ],
    execute(_ctx, [main, output]) {
        return this.successJSON(SeaPackager_1.SeaPackager.createConfig(main, output || "sea-prep.blob"));
    },
});
//# sourceMappingURL=generateSeaConfig.js.map
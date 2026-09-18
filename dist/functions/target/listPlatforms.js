"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const structures_1 = require("../../structures");
exports.default = new forgescript_1.NativeFunction({
    name: "$listPlatforms",
    version: "1.0.0",
    description: "Returns every ForgeGraal target identifier",
    unwrap: true,
    brackets: false,
    output: forgescript_1.ArgType.String,
    args: [
        {
            name: "separator",
            description: "Separator between targets, defaults to ,",
            rest: false,
            type: forgescript_1.ArgType.String,
        },
    ],
    execute(_ctx, [separator]) {
        return this.success(structures_1.ALL_TARGETS.join(separator ?? ","));
    },
});
//# sourceMappingURL=listPlatforms.js.map
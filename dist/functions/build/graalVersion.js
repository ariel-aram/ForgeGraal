"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const index_1 = require("../../index");
exports.default = new forgescript_1.NativeFunction({
    name: "$graalVersion",
    version: "1.0.0",
    description: "Returns the installed ForgeGraal version",
    unwrap: false,
    output: forgescript_1.ArgType.String,
    execute(_ctx) {
        return this.success(index_1.VERSION);
    },
});
//# sourceMappingURL=graalVersion.js.map
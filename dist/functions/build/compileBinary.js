"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forgescript_1 = require("@tryforge/forgescript");
const BinaryPackager_1 = require("../../compiler/BinaryPackager");
const functions_1 = require("../../util/functions");
exports.default = new forgescript_1.NativeFunction({
    name: "$compileBinary",
    version: "1.0.0",
    description: "Compiles a bot into a standalone executable or portable bundle and returns its path. Requires `new ForgeGraal({ allowCompile: true })`",
    unwrap: true,
    brackets: true,
    output: forgescript_1.ArgType.String,
    args: [
        {
            name: "entrypoint",
            description: "Built JavaScript entrypoint of the bot, relative to the bot root",
            rest: false,
            type: forgescript_1.ArgType.String,
            required: true,
        },
        {
            name: "target",
            description: "Target identifier (e.g. ios-ish-x86, win-legacy-x86, linux-modern-x64)",
            rest: false,
            type: forgescript_1.ArgType.String,
            required: true,
        },
        {
            name: "output",
            description: "Output file (sea) or directory (portable), relative to the bot root",
            rest: false,
            type: forgescript_1.ArgType.String,
        },
        {
            name: "strategy",
            description: "auto, sea or portable",
            rest: false,
            type: forgescript_1.ArgType.String,
        },
        {
            name: "packageManager",
            description: "Package manager (bun, pnpm, npm, yarn), detected from the project when empty",
            rest: false,
            type: forgescript_1.ArgType.String,
        },
    ],
    async execute(ctx, [entrypoint, target, output, strategy, pm]) {
        if (!(0, functions_1.getGraal)(ctx)?.options.allowCompile) {
            return this.customError("$compileBinary is disabled; enable it with new ForgeGraal({ allowCompile: true })");
        }
        try {
            const result = await BinaryPackager_1.BinaryPackager.compile({
                entrypoint: (0, functions_1.resolveFileArg)(ctx, entrypoint),
                target,
                output: output ? (0, functions_1.resolveFileArg)(ctx, output) : undefined,
                strategy: (strategy?.trim().toLowerCase() || "auto"),
                packageManager: pm ?? undefined,
            });
            return this.success(result.launcherPath);
        }
        catch (err) {
            return this.error((0, functions_1.toError)(err));
        }
    },
});
//# sourceMappingURL=compileBinary.js.map
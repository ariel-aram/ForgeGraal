"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGraak = getGraak;
exports.getRoot = getRoot;
exports.resolveFileArg = resolveFileArg;
exports.requireTarget = requireTarget;
exports.packageManagerArg = packageManagerArg;
exports.toError = toError;
const PolicyEnforcer_1 = require("../compiler/PolicyEnforcer");
const ProjectCollector_1 = require("../compiler/ProjectCollector");
const structures_1 = require("../structures");
function getGraak(ctx) {
    return ctx.client.getExtension("graak");
}
/** Root directory file arguments are confined to. */
function getRoot(ctx) {
    return getGraak(ctx)?.options.root ?? process.cwd();
}
function resolveFileArg(ctx, input) {
    return (0, ProjectCollector_1.resolveInside)(getRoot(ctx), input);
}
function requireTarget(input) {
    const meta = (0, structures_1.getTargetMetadata)(input);
    if (!meta)
        throw new structures_1.InvalidTargetError(input, structures_1.ALL_TARGETS);
    return meta;
}
function packageManagerArg(ctx, input) {
    return PolicyEnforcer_1.PolicyEnforcer.resolvePackageManager(input, getRoot(ctx));
}
function toError(err) {
    return err instanceof Error ? err : new Error(String(err));
}
//# sourceMappingURL=util.js.map
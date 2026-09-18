"use strict";
/**
 * Error hierarchy for the ForgeGraal compiler and package manager policy.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeAddonMismatchError = exports.RuntimeError = exports.PathOutsideRootError = exports.ProjectError = exports.InvalidPackageManagerError = exports.InvalidTargetError = exports.ForgeGraalError = void 0;
class ForgeGraalError extends Error {
    name = "ForgeGraalError";
    constructor(message) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.ForgeGraalError = ForgeGraalError;
class InvalidTargetError extends ForgeGraalError {
    name = "InvalidTargetError";
    invalidTarget;
    constructor(invalidTarget, validTargets) {
        super(`Unknown target device '${invalidTarget}'. Supported targets: ${validTargets.join(", ")}`);
        this.invalidTarget = invalidTarget;
    }
}
exports.InvalidTargetError = InvalidTargetError;
class InvalidPackageManagerError extends ForgeGraalError {
    name = "InvalidPackageManagerError";
    constructor(value, valid) {
        super(`Unknown package manager '${value}'. Supported package managers: ${valid.join(", ")}`);
    }
}
exports.InvalidPackageManagerError = InvalidPackageManagerError;
class ProjectError extends ForgeGraalError {
    name = "ProjectError";
}
exports.ProjectError = ProjectError;
class PathOutsideRootError extends ForgeGraalError {
    name = "PathOutsideRootError";
    constructor(path, root) {
        super(`Path '${path}' resolves outside of the allowed root '${root}'`);
    }
}
exports.PathOutsideRootError = PathOutsideRootError;
class RuntimeError extends ForgeGraalError {
    name = "RuntimeError";
}
exports.RuntimeError = RuntimeError;
class NativeAddonMismatchError extends ForgeGraalError {
    name = "NativeAddonMismatchError";
    addons;
    constructor(target, addons, hint) {
        super(`The project contains native addons that cannot run on '${target}':\n` +
            addons.map((x) => `  - ${x}`).join("\n") +
            "\nReinstall them for the target platform (e.g. rebuild on the target device), " +
            "switch to a pure JavaScript driver, or pass --allow-native-mismatch to bundle anyway." +
            (hint ? `\n${hint}` : ""));
        this.addons = addons;
    }
}
exports.NativeAddonMismatchError = NativeAddonMismatchError;
//# sourceMappingURL=ForgeGraalError.js.map
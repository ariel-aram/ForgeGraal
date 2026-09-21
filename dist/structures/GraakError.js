"use strict";
/**
 * Error hierarchy for the Graak compiler and package manager policy.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeAddonMismatchError = exports.RuntimeError = exports.PathOutsideRootError = exports.ProjectError = exports.InvalidPackageManagerError = exports.InvalidTargetError = exports.GraakError = void 0;
class GraakError extends Error {
    name = "GraakError";
    constructor(message) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.GraakError = GraakError;
class InvalidTargetError extends GraakError {
    name = "InvalidTargetError";
    invalidTarget;
    constructor(invalidTarget, validTargets) {
        super(`Unknown target device '${invalidTarget}'. Supported targets: ${validTargets.join(", ")}`);
        this.invalidTarget = invalidTarget;
    }
}
exports.InvalidTargetError = InvalidTargetError;
class InvalidPackageManagerError extends GraakError {
    name = "InvalidPackageManagerError";
    constructor(value, valid) {
        super(`Unknown package manager '${value}'. Supported package managers: ${valid.join(", ")}`);
    }
}
exports.InvalidPackageManagerError = InvalidPackageManagerError;
class ProjectError extends GraakError {
    name = "ProjectError";
}
exports.ProjectError = ProjectError;
class PathOutsideRootError extends GraakError {
    name = "PathOutsideRootError";
    constructor(path, root) {
        super(`Path '${path}' resolves outside of the allowed root '${root}'`);
    }
}
exports.PathOutsideRootError = PathOutsideRootError;
class RuntimeError extends GraakError {
    name = "RuntimeError";
}
exports.RuntimeError = RuntimeError;
class NativeAddonMismatchError extends GraakError {
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
//# sourceMappingURL=GraakError.js.map
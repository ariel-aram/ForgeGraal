"use strict";
/**
 * Error hierarchy for the ForgeGraal compiler and package manager policy.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeAddonMismatchError = exports.RuntimeError = exports.PathOutsideRootError = exports.ProjectError = exports.InvalidPackageManagerError = exports.InvalidTargetError = exports.BunTargetRestrictionError = exports.ForgeGraalError = void 0;
class ForgeGraalError extends Error {
    name = "ForgeGraalError";
    constructor(message) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.ForgeGraalError = ForgeGraalError;
class BunTargetRestrictionError extends ForgeGraalError {
    name = "BunTargetRestrictionError";
    target;
    constructor(target) {
        super(`Target '${target}' is not available for Bun projects. ` +
            "Bun already compiles modern 64-bit executables with 'bun build --compile' " +
            "(linux-x64, linux-arm64, windows-x64, darwin-x64, darwin-arm64), but not 32-bit " +
            "(iSH, x86, ARMv7) or legacy Windows (7 / Vista) executables. " +
            "ForgeGraal therefore only builds 32-bit and legacy targets for Bun projects; " +
            "use 'bun build --compile' for modern targets, or NPM, PNPM, or Yarn for the full matrix.");
        this.target = target;
    }
}
exports.BunTargetRestrictionError = BunTargetRestrictionError;
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
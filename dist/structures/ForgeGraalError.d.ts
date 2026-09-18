/**
 * Error hierarchy for the ForgeGraal compiler and package manager policy.
 */
export declare class ForgeGraalError extends Error {
    readonly name: string;
    constructor(message: string);
}
export declare class InvalidTargetError extends ForgeGraalError {
    readonly name: string;
    readonly invalidTarget: string;
    constructor(invalidTarget: string, validTargets: readonly string[]);
}
export declare class InvalidPackageManagerError extends ForgeGraalError {
    readonly name: string;
    constructor(value: string, valid: readonly string[]);
}
export declare class ProjectError extends ForgeGraalError {
    readonly name: string;
}
export declare class PathOutsideRootError extends ForgeGraalError {
    readonly name: string;
    constructor(path: string, root: string);
}
export declare class RuntimeError extends ForgeGraalError {
    readonly name: string;
}
export declare class NativeAddonMismatchError extends ForgeGraalError {
    readonly name: string;
    readonly addons: readonly string[];
    constructor(target: string, addons: readonly string[], hint?: string);
}
//# sourceMappingURL=ForgeGraalError.d.ts.map
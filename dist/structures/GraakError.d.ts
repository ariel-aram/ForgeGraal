/**
 * Error hierarchy for the Graak compiler and package manager policy.
 */
export declare class GraakError extends Error {
    readonly name: string;
    constructor(message: string);
}
export declare class InvalidTargetError extends GraakError {
    readonly name: string;
    readonly invalidTarget: string;
    constructor(invalidTarget: string, validTargets: readonly string[]);
}
export declare class InvalidPackageManagerError extends GraakError {
    readonly name: string;
    constructor(value: string, valid: readonly string[]);
}
export declare class ProjectError extends GraakError {
    readonly name: string;
}
export declare class PathOutsideRootError extends GraakError {
    readonly name: string;
    constructor(path: string, root: string);
}
export declare class RuntimeError extends GraakError {
    readonly name: string;
}
export declare class NativeAddonMismatchError extends GraakError {
    readonly name: string;
    readonly addons: readonly string[];
    constructor(target: string, addons: readonly string[], hint?: string);
}
//# sourceMappingURL=GraakError.d.ts.map
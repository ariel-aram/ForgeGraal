import type { Context } from "@tryforge/forgescript";
import { type PackageManager } from "../compiler/PolicyEnforcer";
import type { ForgeGraal } from "../index";
import { type TargetMetadata } from "../structures";
export declare function getGraal(ctx: Context): ForgeGraal | null;
/** Root directory file arguments are confined to. */
export declare function getRoot(ctx: Context): string;
export declare function resolveFileArg(ctx: Context, input: string): string;
export declare function requireTarget(input: string): TargetMetadata;
export declare function packageManagerArg(ctx: Context, input: string | null): PackageManager;
export declare function toError(err: unknown): Error;
//# sourceMappingURL=functions.d.ts.map
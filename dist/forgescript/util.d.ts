import type { Context } from "@tryforge/forgescript";
import { type PackageManager } from "../compiler/PolicyEnforcer";
import { type TargetMetadata } from "../structures";
import type { Graak } from "./index";
export declare function getGraak(ctx: Context): Graak | null;
/** Root directory file arguments are confined to. */
export declare function getRoot(ctx: Context): string;
export declare function resolveFileArg(ctx: Context, input: string): string;
export declare function requireTarget(input: string): TargetMetadata;
export declare function packageManagerArg(ctx: Context, input: string | null): PackageManager;
export declare function toError(err: unknown): Error;
//# sourceMappingURL=util.d.ts.map
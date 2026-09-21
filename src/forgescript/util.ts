import type { Context } from "@tryforge/forgescript";
import { type PackageManager, PolicyEnforcer } from "../compiler/PolicyEnforcer";
import { resolveInside } from "../compiler/ProjectCollector";
import { ALL_TARGETS, getTargetMetadata, InvalidTargetError, type TargetMetadata } from "../structures";
import type { Graak } from "./index";

export function getGraak(ctx: Context): Graak | null {
	return ctx.client.getExtension("graak") as Graak | null;
}

/** Root directory file arguments are confined to. */
export function getRoot(ctx: Context): string {
	return getGraak(ctx)?.options.root ?? process.cwd();
}

export function resolveFileArg(ctx: Context, input: string): string {
	return resolveInside(getRoot(ctx), input);
}

export function requireTarget(input: string): TargetMetadata {
	const meta = getTargetMetadata(input);
	if (!meta) throw new InvalidTargetError(input, ALL_TARGETS);
	return meta;
}

export function packageManagerArg(ctx: Context, input: string | null): PackageManager {
	return PolicyEnforcer.resolvePackageManager(input, getRoot(ctx));
}

export function toError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

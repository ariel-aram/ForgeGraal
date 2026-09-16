import type { Context } from "@tryforge/forgescript";
import {
	type PackageManager,
	PolicyEnforcer,
} from "../compiler/PolicyEnforcer";
import { resolveInside } from "../compiler/ProjectCollector";
import type { ForgeGraal } from "../index";
import {
	ALL_TARGETS,
	getTargetMetadata,
	InvalidTargetError,
	type TargetMetadata,
} from "../structures";

export function getGraal(ctx: Context): ForgeGraal | null {
	return ctx.client.getExtension("forgegraal") as ForgeGraal | null;
}

/** Root directory file arguments are confined to. */
export function getRoot(ctx: Context): string {
	return getGraal(ctx)?.options.root ?? process.cwd();
}

export function resolveFileArg(ctx: Context, input: string): string {
	return resolveInside(getRoot(ctx), input);
}

export function requireTarget(input: string): TargetMetadata {
	const meta = getTargetMetadata(input);
	if (!meta) throw new InvalidTargetError(input, ALL_TARGETS);
	return meta;
}

export function packageManagerArg(
	ctx: Context,
	input: string | null,
): PackageManager {
	return PolicyEnforcer.resolvePackageManager(input, getRoot(ctx));
}

export function toError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

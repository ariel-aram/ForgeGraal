/**
 * Error hierarchy for the ForgeGraal compiler and package manager policy.
 */

export class ForgeGraalError extends Error {
	public override readonly name: string = "ForgeGraalError";

	constructor(message: string) {
		super(message);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export class BunTargetRestrictionError extends ForgeGraalError {
	public override readonly name: string = "BunTargetRestrictionError";
	public readonly target: string;

	constructor(target: string) {
		super(
			`Target '${target}' is not available for Bun projects. ` +
				"Bun already compiles modern 64-bit executables with 'bun build --compile' " +
				"(linux-x64, linux-arm64, windows-x64, darwin-x64, darwin-arm64), but not 32-bit " +
				"(iSH, x86, ARMv7) or legacy Windows (7 / Vista) executables. " +
				"ForgeGraal therefore only builds 32-bit and legacy targets for Bun projects; " +
				"use 'bun build --compile' for modern targets, or NPM, PNPM, or Yarn for the full matrix.",
		);
		this.target = target;
	}
}

export class InvalidTargetError extends ForgeGraalError {
	public override readonly name: string = "InvalidTargetError";
	public readonly invalidTarget: string;

	constructor(invalidTarget: string, validTargets: readonly string[]) {
		super(
			`Unknown target device '${invalidTarget}'. Supported targets: ${validTargets.join(", ")}`,
		);
		this.invalidTarget = invalidTarget;
	}
}

export class InvalidPackageManagerError extends ForgeGraalError {
	public override readonly name: string = "InvalidPackageManagerError";

	constructor(value: string, valid: readonly string[]) {
		super(
			`Unknown package manager '${value}'. Supported package managers: ${valid.join(", ")}`,
		);
	}
}

export class ProjectError extends ForgeGraalError {
	public override readonly name: string = "ProjectError";
}

export class PathOutsideRootError extends ForgeGraalError {
	public override readonly name: string = "PathOutsideRootError";

	constructor(path: string, root: string) {
		super(`Path '${path}' resolves outside of the allowed root '${root}'`);
	}
}

export class RuntimeError extends ForgeGraalError {
	public override readonly name: string = "RuntimeError";
}

export class NativeAddonMismatchError extends ForgeGraalError {
	public override readonly name: string = "NativeAddonMismatchError";
	public readonly addons: readonly string[];

	constructor(target: string, addons: readonly string[]) {
		super(
			`The project contains native addons that cannot run on '${target}':\n` +
				addons.map((x) => `  - ${x}`).join("\n") +
				"\nReinstall them for the target platform (e.g. rebuild on the target device), " +
				"switch to a pure JavaScript driver, or pass --allow-native-mismatch to bundle anyway.",
		);
		this.addons = addons;
	}
}

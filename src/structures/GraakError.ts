/**
 * Error hierarchy for the Graak compiler and package manager policy.
 */

export class GraakError extends Error {
	public override readonly name: string = "GraakError";

	constructor(message: string) {
		super(message);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export class InvalidTargetError extends GraakError {
	public override readonly name: string = "InvalidTargetError";
	public readonly invalidTarget: string;

	constructor(invalidTarget: string, validTargets: readonly string[]) {
		super(`Unknown target device '${invalidTarget}'. Supported targets: ${validTargets.join(", ")}`);
		this.invalidTarget = invalidTarget;
	}
}

export class InvalidPackageManagerError extends GraakError {
	public override readonly name: string = "InvalidPackageManagerError";

	constructor(value: string, valid: readonly string[]) {
		super(`Unknown package manager '${value}'. Supported package managers: ${valid.join(", ")}`);
	}
}

export class ProjectError extends GraakError {
	public override readonly name: string = "ProjectError";
}

export class PathOutsideRootError extends GraakError {
	public override readonly name: string = "PathOutsideRootError";

	constructor(path: string, root: string) {
		super(`Path '${path}' resolves outside of the allowed root '${root}'`);
	}
}

export class RuntimeError extends GraakError {
	public override readonly name: string = "RuntimeError";
}

export class NativeAddonMismatchError extends GraakError {
	public override readonly name: string = "NativeAddonMismatchError";
	public readonly addons: readonly string[];

	constructor(target: string, addons: readonly string[], hint?: string) {
		super(
			`The project contains native addons that cannot run on '${target}':\n` +
				addons.map((x) => `  - ${x}`).join("\n") +
				"\nReinstall them for the target platform (e.g. rebuild on the target device), " +
				"switch to a pure JavaScript driver, or pass --allow-native-mismatch to bundle anyway." +
				(hint ? `\n${hint}` : "")
		);
		this.addons = addons;
	}
}

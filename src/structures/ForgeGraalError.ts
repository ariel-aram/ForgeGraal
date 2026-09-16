/**
 * Custom error hierarchy for ForgeGraal compiler and package manager policy.
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
		const message =
			`Bun runtime policy restriction: Target '${target}' is not permitted when using Bun. ` +
			"Bun already includes a native single-file compiler ('bun build --compile') for modern 64-bit platforms " +
			"(linux-x64, darwin-arm64, windows-x64), but does NOT support 32-bit platforms (iOS 32-bit iSH, 32-bit Linux, 32-bit Windows) " +
			"or legacy Windows (Windows 7 / Vista). " +
			"Therefore, ForgeGraal exclusively generates 32-bit and legacy Windows binaries when running on Bun. " +
			"To compile binaries for all target architectures, run ForgeGraal with NPM, PNPM, or Yarn.";
		super(message);
		this.target = target;
	}
}

export class InvalidTargetError extends ForgeGraalError {
	public override readonly name: string = "InvalidTargetError";
	public readonly invalidTarget: string;

	constructor(invalidTarget: string, validTargets: string[]) {
		super(
			`Unknown target device '${invalidTarget}'. Supported targets: ${validTargets.join(", ")}`,
		);
		this.invalidTarget = invalidTarget;
	}
}

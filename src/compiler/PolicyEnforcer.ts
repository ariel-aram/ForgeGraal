import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	BunTargetRestrictionError,
	InvalidTargetError,
	is32BitOrLegacy,
	parseTargetDevice,
	TargetDevice,
} from "../structures/index.js";

export type PackageManager = "bun" | "pnpm" | "npm" | "yarn";

export class PolicyEnforcer {
	/**
	 * Detects the active package manager from local lockfiles or the runtime environment.
	 */
	public static detectPackageManager(
		rootDir: string = process.cwd(),
	): PackageManager {
		// 1. Check Bun runtime or Bun lockfile
		if (
			typeof (process as unknown as { versions: { bun?: string } }).versions
				?.bun === "string" ||
			existsSync(join(rootDir, "bun.lockb")) ||
			existsSync(join(rootDir, "bun.lock"))
		) {
			return "bun";
		}

		// 2. Check PNPM
		if (existsSync(join(rootDir, "pnpm-lock.yaml"))) {
			return "pnpm";
		}

		// 3. Check Yarn
		if (existsSync(join(rootDir, "yarn.lock"))) {
			return "yarn";
		}

		// 4. Check NPM
		if (existsSync(join(rootDir, "package-lock.json"))) {
			return "npm";
		}

		// 5. Inspect user-agent
		const userAgent = process.env.npm_config_user_agent || "";
		if (userAgent.includes("bun")) return "bun";
		if (userAgent.includes("pnpm")) return "pnpm";
		if (userAgent.includes("yarn")) return "yarn";
		if (userAgent.includes("npm")) return "npm";

		// Default fallback
		return "pnpm";
	}

	/**
	 * Returns the list of permissible target devices for the given package manager.
	 * When using Bun, modern 64-bit targets are restricted since Bun includes native 'bun build --compile'.
	 * Therefore, Bun bots exclusively produce 32-bit (iOS iSH, x86, ARMv7) and legacy Windows binaries.
	 */
	public static getAllowedTargets(
		packageManager: PackageManager,
	): TargetDevice[] {
		const allTargets = Object.values(TargetDevice);
		if (packageManager === "bun") {
			return allTargets.filter((target) => is32BitOrLegacy(target));
		}
		// NPM, PNPM, and Yarn support the entire target matrix
		return allTargets;
	}

	/**
	 * Validates whether a target is permitted for the specified package manager.
	 * Throws BunTargetRestrictionError if Bun attempts a modern 64-bit target.
	 */
	public static assertTargetAllowed(
		targetInput: TargetDevice | string,
		packageManager: PackageManager = PolicyEnforcer.detectPackageManager(),
	): TargetDevice {
		const target =
			typeof targetInput === "string"
				? parseTargetDevice(targetInput)
				: targetInput;

		if (!target) {
			const valid = Object.values(TargetDevice);
			throw new InvalidTargetError(String(targetInput), valid);
		}

		if (packageManager === "bun") {
			if (!is32BitOrLegacy(target)) {
				throw new BunTargetRestrictionError(target);
			}
		}

		return target;
	}

	/**
	 * Non-throwing query returning a status and explanatory rationale.
	 */
	public static checkTarget(
		targetInput: TargetDevice | string,
		packageManager: PackageManager = PolicyEnforcer.detectPackageManager(),
	): { allowed: boolean; reason?: string; target?: TargetDevice } {
		try {
			const target = PolicyEnforcer.assertTargetAllowed(
				targetInput,
				packageManager,
			);
			return { allowed: true, target };
		} catch (err: unknown) {
			return {
				allowed: false,
				reason: err instanceof Error ? err.message : String(err),
			};
		}
	}
}

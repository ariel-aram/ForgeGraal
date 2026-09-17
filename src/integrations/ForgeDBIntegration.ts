import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { BinaryInspector } from "../compiler/BinaryInspector";
import { getTargetMetadata } from "../structures";

/** Database types accepted by `new ForgeDB({ type })` and the driver package typeorm loads. */
export const FORGEDB_DRIVERS = {
	sqlite: { package: "sqlite3", native: true },
	"better-sqlite3": { package: "better-sqlite3", native: true },
	mongodb: { package: "mongodb", native: false },
	mysql: { package: "mysql2", native: false },
	postgres: { package: "pg", native: false },
} as const;

export type ForgeDBDriver = keyof typeof FORGEDB_DRIVERS;

/** Pure JavaScript ForgeDB drivers, in suggestion order. They run on every target. */
export const PURE_JS_FORGEDB_DRIVERS: readonly ForgeDBDriver[] = Object.entries(
	FORGEDB_DRIVERS,
)
	.filter(([, spec]) => !spec.native)
	.map(([driver]) => driver as ForgeDBDriver);

export interface DriverCompatibility {
	driver: ForgeDBDriver;
	package: string;
	installed: boolean;
	native: boolean;
	compatible: boolean;
	reason: string;
}

export class ForgeDBIntegration {
	public static parseDriver(value: unknown): ForgeDBDriver | null {
		if (typeof value !== "string") return null;
		const normalized = value.trim().toLowerCase();
		return normalized in FORGEDB_DRIVERS ? (normalized as ForgeDBDriver) : null;
	}

	/**
	 * Returns the best pure JavaScript driver to switch to when `driver` is native, or `null`
	 * when `driver` is already pure JavaScript (no swap needed).
	 */
	public static suggestAlternative(
		driver: ForgeDBDriver,
	): ForgeDBDriver | null {
		if (!FORGEDB_DRIVERS[driver].native) return null;
		return PURE_JS_FORGEDB_DRIVERS[0] ?? null;
	}

	private static findPackage(name: string, fromDir: string): string | null {
		let dir = fromDir;
		for (;;) {
			const candidate = join(dir, "node_modules", name);
			if (existsSync(join(candidate, "package.json")))
				return realpathSync(candidate);
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	}

	private static findAddons(
		dir: string,
		depth = 0,
		out: string[] = [],
	): string[] {
		if (depth > 8) return out;
		for (const name of readdirSync(dir)) {
			if (name === "node_modules" || name.startsWith(".")) continue;
			const abs = join(dir, name);
			const stats = statSync(abs, { throwIfNoEntry: false });
			if (!stats) continue;
			if (stats.isDirectory())
				ForgeDBIntegration.findAddons(abs, depth + 1, out);
			else if (name.endsWith(".node")) out.push(abs);
		}
		return out;
	}

	/**
	 * Checks whether the installed ForgeDB driver of a project can run on a target.
	 * Pure JavaScript drivers work everywhere; native drivers (sqlite3, better-sqlite3)
	 * need a compiled addon for the target's OS and CPU.
	 */
	public static checkDriver(
		driver: ForgeDBDriver,
		target: unknown,
		projectRoot: string = process.cwd(),
	): DriverCompatibility {
		const spec = FORGEDB_DRIVERS[driver];
		const base = { driver, package: spec.package, native: spec.native };
		const meta = getTargetMetadata(target);
		if (!meta) {
			return {
				...base,
				installed: false,
				compatible: false,
				reason: `Unknown target '${String(target)}'`,
			};
		}

		const pkgDir = ForgeDBIntegration.findPackage(spec.package, projectRoot);
		if (!pkgDir) {
			return {
				...base,
				installed: false,
				compatible: false,
				reason: spec.native
					? `'${spec.package}' is not installed; switch to a pure JavaScript driver (${PURE_JS_FORGEDB_DRIVERS.join(", ")}) or install it for the target`
					: `'${spec.package}' is not installed`,
			};
		}
		if (!spec.native) {
			return {
				...base,
				installed: true,
				compatible: true,
				reason: "Pure JavaScript driver",
			};
		}

		const addons = ForgeDBIntegration.findAddons(pkgDir);
		const match = addons.find((file) => {
			const info = BinaryInspector.inspect(file);
			return info !== null && BinaryInspector.matchesTarget(info, meta.id);
		});
		return {
			...base,
			installed: true,
			compatible: match !== undefined,
			reason: match
				? `Native addon for ${meta.name} found`
				: addons.length
					? `Installed native addon does not match ${meta.name}; reinstall '${spec.package}' on/for the target, ` +
						`or switch to a pure JavaScript driver (${PURE_JS_FORGEDB_DRIVERS.join(", ")})`
					: `No compiled addon found for '${spec.package}'; switch to a pure JavaScript driver ` +
						`(${PURE_JS_FORGEDB_DRIVERS.join(", ")}) or install '${spec.package}' for the target`,
		};
	}
}

import { TargetDevice } from "../structures/index.js";

export interface ForgeDBBundleConfig {
	dbPath?: string;
	enablePureJsFallback?: boolean;
	target: TargetDevice;
}

export class ForgeDBIntegration {
	/**
	 * Generates a database bootstrap stub ensuring ForgeDB works across 32-bit iSH and legacy Windows.
	 */
	public static generateDbShim(config: ForgeDBBundleConfig): string {
		const isIsh = config.target === TargetDevice.IosIshX86;
		const isWinLegacy =
			config.target === TargetDevice.WinLegacyX86 ||
			config.target === TargetDevice.WinLegacyX64;

		return (
			`/* ForgeGraal ForgeDB Universal Storage Shim */\n` +
			`// Configured for Target: ${config.target}\n` +
			`if (typeof globalThis.__FORGEDB_SHIM__ === "undefined") {\n` +
			`  globalThis.__FORGEDB_SHIM__ = {\n` +
			`    isIsh: ${isIsh},\n` +
			`    isLegacyWindows: ${isWinLegacy},\n` +
			`    target: ${JSON.stringify(config.target)},\n` +
			`    defaultDbPath: ${JSON.stringify(config.dbPath ?? "./forgedb.sqlite")},\n` +
			`    init() {\n` +
			`      if (this.isIsh) {\n` +
			`        process.env.SQLITE3_BINARY_SITE = "alpine-i686";\n` +
			`      }\n` +
			`      if (this.isLegacyWindows) {\n` +
			`        process.env.SQLITE3_LEGACY_WIN = "1";\n` +
			`      }\n` +
			`    }\n` +
			`  };\n` +
			`  globalThis.__FORGEDB_SHIM__.init();\n` +
			`}\n\n`
		);
	}

	/**
	 * Injects the ForgeDB compatibility layer into a bot bundle script.
	 */
	public static injectIntoBundle(
		bundleContent: string,
		config: ForgeDBBundleConfig,
	): string {
		const shim = ForgeDBIntegration.generateDbShim(config);
		return shim + bundleContent;
	}
}

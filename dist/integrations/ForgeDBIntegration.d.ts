/** Database types accepted by `new ForgeDB({ type })` and the driver package typeorm loads. */
export declare const FORGEDB_DRIVERS: {
    readonly sqlite: {
        readonly package: "sqlite3";
        readonly native: true;
    };
    readonly "better-sqlite3": {
        readonly package: "better-sqlite3";
        readonly native: true;
    };
    readonly mongodb: {
        readonly package: "mongodb";
        readonly native: false;
    };
    readonly mysql: {
        readonly package: "mysql2";
        readonly native: false;
    };
    readonly postgres: {
        readonly package: "pg";
        readonly native: false;
    };
};
export type ForgeDBDriver = keyof typeof FORGEDB_DRIVERS;
/** Pure JavaScript ForgeDB drivers, in suggestion order. They run on every target. */
export declare const PURE_JS_FORGEDB_DRIVERS: readonly ForgeDBDriver[];
export interface DriverCompatibility {
    driver: ForgeDBDriver;
    package: string;
    installed: boolean;
    native: boolean;
    compatible: boolean;
    reason: string;
}
export declare class ForgeDBIntegration {
    static parseDriver(value: unknown): ForgeDBDriver | null;
    /**
     * Returns the best pure JavaScript driver to switch to when `driver` is native, or `null`
     * when `driver` is already pure JavaScript (no swap needed).
     */
    static suggestAlternative(driver: ForgeDBDriver): ForgeDBDriver | null;
    private static findPackage;
    private static findAddons;
    /**
     * Checks whether the installed ForgeDB driver of a project can run on a target.
     * Pure JavaScript drivers work everywhere; native drivers (sqlite3, better-sqlite3)
     * need a compiled addon for the target's OS and CPU.
     */
    static checkDriver(driver: ForgeDBDriver, target: unknown, projectRoot?: string): DriverCompatibility;
}
//# sourceMappingURL=ForgeDBIntegration.d.ts.map
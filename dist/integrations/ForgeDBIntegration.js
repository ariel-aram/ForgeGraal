"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForgeDBIntegration = exports.PURE_JS_FORGEDB_DRIVERS = exports.FORGEDB_DRIVERS = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const BinaryInspector_1 = require("../compiler/BinaryInspector");
const structures_1 = require("../structures");
/** Database types accepted by `new ForgeDB({ type })` and the driver package typeorm loads. */
exports.FORGEDB_DRIVERS = {
    sqlite: { package: "sqlite3", native: true },
    "better-sqlite3": { package: "better-sqlite3", native: true },
    mongodb: { package: "mongodb", native: false },
    mysql: { package: "mysql2", native: false },
    postgres: { package: "pg", native: false },
};
/** Pure JavaScript ForgeDB drivers, in suggestion order. They run on every target. */
exports.PURE_JS_FORGEDB_DRIVERS = Object.entries(exports.FORGEDB_DRIVERS)
    .filter(([, spec]) => !spec.native)
    .map(([driver]) => driver);
class ForgeDBIntegration {
    static parseDriver(value) {
        if (typeof value !== "string")
            return null;
        const normalized = value.trim().toLowerCase();
        return normalized in exports.FORGEDB_DRIVERS ? normalized : null;
    }
    /**
     * Returns the best pure JavaScript driver to switch to when `driver` is native, or `null`
     * when `driver` is already pure JavaScript (no swap needed).
     */
    static suggestAlternative(driver) {
        if (!exports.FORGEDB_DRIVERS[driver].native)
            return null;
        return exports.PURE_JS_FORGEDB_DRIVERS[0] ?? null;
    }
    static findPackage(name, fromDir) {
        let dir = fromDir;
        for (;;) {
            const candidate = (0, node_path_1.join)(dir, "node_modules", name);
            if ((0, node_fs_1.existsSync)((0, node_path_1.join)(candidate, "package.json")))
                return (0, node_fs_1.realpathSync)(candidate);
            const parent = (0, node_path_1.dirname)(dir);
            if (parent === dir)
                return null;
            dir = parent;
        }
    }
    static findAddons(dir, depth = 0, out = []) {
        if (depth > 8)
            return out;
        for (const name of (0, node_fs_1.readdirSync)(dir)) {
            if (name === "node_modules" || name.startsWith("."))
                continue;
            const abs = (0, node_path_1.join)(dir, name);
            const stats = (0, node_fs_1.statSync)(abs, { throwIfNoEntry: false });
            if (!stats)
                continue;
            if (stats.isDirectory())
                ForgeDBIntegration.findAddons(abs, depth + 1, out);
            else if (name.endsWith(".node"))
                out.push(abs);
        }
        return out;
    }
    /**
     * Checks whether the installed ForgeDB driver of a project can run on a target.
     * Pure JavaScript drivers work everywhere; native drivers (sqlite3, better-sqlite3)
     * need a compiled addon for the target's OS and CPU.
     */
    static checkDriver(driver, target, projectRoot = process.cwd()) {
        const spec = exports.FORGEDB_DRIVERS[driver];
        const base = { driver, package: spec.package, native: spec.native };
        const meta = (0, structures_1.getTargetMetadata)(target);
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
                    ? `'${spec.package}' is not installed; switch to a pure JavaScript driver (${exports.PURE_JS_FORGEDB_DRIVERS.join(", ")}) or install it for the target`
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
            const info = BinaryInspector_1.BinaryInspector.inspect(file);
            return info !== null && BinaryInspector_1.BinaryInspector.matchesTarget(info, meta.id);
        });
        return {
            ...base,
            installed: true,
            compatible: match !== undefined,
            reason: match
                ? `Native addon for ${meta.name} found`
                : addons.length
                    ? `Installed native addon does not match ${meta.name}; reinstall '${spec.package}' on/for the target, ` +
                        `or switch to a pure JavaScript driver (${exports.PURE_JS_FORGEDB_DRIVERS.join(", ")})`
                    : `No compiled addon found for '${spec.package}'; switch to a pure JavaScript driver ` +
                        `(${exports.PURE_JS_FORGEDB_DRIVERS.join(", ")}) or install '${spec.package}' for the target`,
        };
    }
}
exports.ForgeDBIntegration = ForgeDBIntegration;
//# sourceMappingURL=ForgeDBIntegration.js.map
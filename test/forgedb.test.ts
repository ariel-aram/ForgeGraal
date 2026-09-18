import assert from "node:assert/strict";
import { test } from "node:test";
import { FORGEDB_DRIVERS, ForgeDBIntegration, PURE_JS_FORGEDB_DRIVERS } from "../dist/index.js";

test("PURE_JS_FORGEDB_DRIVERS lists exactly the non-native drivers", () => {
	for (const driver of PURE_JS_FORGEDB_DRIVERS) {
		assert.equal(FORGEDB_DRIVERS[driver].native, false);
	}
	for (const [driver, spec] of Object.entries(FORGEDB_DRIVERS)) {
		assert.equal(PURE_JS_FORGEDB_DRIVERS.includes(driver as never), !spec.native);
	}
});

test("suggestAlternative recommends a pure JS driver only for native ones", () => {
	assert.equal(ForgeDBIntegration.suggestAlternative("sqlite"), PURE_JS_FORGEDB_DRIVERS[0]);
	assert.equal(ForgeDBIntegration.suggestAlternative("better-sqlite3"), PURE_JS_FORGEDB_DRIVERS[0]);
	assert.equal(ForgeDBIntegration.suggestAlternative("mongodb"), null);
	assert.equal(ForgeDBIntegration.suggestAlternative("postgres"), null);
});

test("checkDriver mentions the pure JS alternative when a native driver is missing", () => {
	const res = ForgeDBIntegration.checkDriver("sqlite", "linux-modern-x64", "/nonexistent-root");
	assert.equal(res.compatible, false);
	assert.match(res.reason, /pure JavaScript driver/);
	assert.match(res.reason, new RegExp(PURE_JS_FORGEDB_DRIVERS[0]));
});

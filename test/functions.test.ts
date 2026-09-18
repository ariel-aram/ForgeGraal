import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FunctionManager } from "@tryforge/forgescript";

const functionsDir = join(import.meta.dirname, "..", "dist", "functions");

test("Every file in dist/functions is loadable by ForgeScript's FunctionManager", () => {
	const files = readdirSync(functionsDir, { recursive: true }).filter((f) => String(f).endsWith(".js"));
	FunctionManager.load("forgegraal", functionsDir);

	const names = FunctionManager.toJSON().map((f) => f.name);
	assert.equal(names.length, files.length, "each function file must default-export a NativeFunction");
	for (const name of names) assert.match(name, /^\$[a-zA-Z0-9]+$/);
	assert.ok(!names.some((n) => /dummy/i.test(n)));
});

test("Functions with arguments declare them consistently", () => {
	for (const fn of FunctionManager.toJSON()) {
		if (fn.args?.length) {
			const firstOptional = fn.args.findIndex((a) => !a.required);
			if (firstOptional !== -1) {
				assert.ok(
					fn.args.slice(firstOptional).every((a) => !a.required),
					`${fn.name}: required args must come before optional args`
				);
			}
			assert.equal(fn.brackets, firstOptional !== 0, `${fn.name}: brackets must match required args`);
		}
	}
});

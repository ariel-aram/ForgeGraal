import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { FunctionManager } from "@tryforge/forgescript";

const functionsDir = join(import.meta.dirname, "..", "dist", "forgescript", "functions");

test("Every file in dist/forgescript/functions is loadable by ForgeScript's FunctionManager", () => {
	const files = readdirSync(functionsDir, { recursive: true }).filter((f) => String(f).endsWith(".js"));
	FunctionManager.load("graak", functionsDir);

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

test("The core package loads without ForgeScript; only the adapter needs it", () => {
	const root = join(import.meta.dirname, "..");
	const probe = spawnSync(
		process.execPath,
		["-e", `require("./dist/index.js"); console.log(Object.keys(require.cache).some((k) => k.includes("@tryforge")))`],
		{ cwd: root, encoding: "utf-8" }
	);
	assert.equal(probe.stdout.trim(), "false", probe.stderr);
});

test("The ForgeScript adapter is the Graak extension", () => {
	const { Graak, default: fallback } = createRequire(import.meta.url)("../dist/forgescript/index.js");
	assert.equal(Graak, fallback);
	const extension = new Graak({ allowCompile: false });
	assert.equal(extension.name, "graak");
	assert.equal(extension.options.allowCompile, false);
});

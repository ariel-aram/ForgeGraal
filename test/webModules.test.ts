import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BinaryPackager, TargetDevice } from "../dist/index.js";

/** Writes `files` (relative path to contents) into a fresh project directory. */
function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "graak-modules-"));
	for (const [path, contents] of Object.entries({
		"package.json": JSON.stringify({
			name: "modules-app",
			version: "1.0.0",
			dependencies: { "esm-only": "1.0.0", react: "1.0.0" },
		}),
		...files,
	})) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	return root;
}

async function run(root: string, entry: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
	const result = await BinaryPackager.compile({
		entrypoint: join(root, entry),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
		// Outside the project, so nothing the program finds by walking up from its output is the source tree.
		output: join(mkdtempSync(join(tmpdir(), "graak-modules-out-")), "app"),
	});
	assert.equal(result.strategy, "quickjs");
	return spawnSync(result.launcherPath, [], { encoding: "utf-8", timeout: 60_000 });
}

test("ES modules, ES-module-only packages, TypeScript and JSX all run on the native host", {
	timeout: 300_000,
}, async () => {
	const root = project({
		// an ES-module-only package: "type": "module", and only an "import" export condition
		"node_modules/esm-only/package.json": JSON.stringify({
			name: "esm-only",
			version: "1.0.0",
			type: "module",
			exports: { ".": { import: "./index.js" } },
		}),
		"node_modules/esm-only/index.js":
			'export const greet = (name) => "hello " + name;\nexport default function shout(s) { return s.toUpperCase(); }\n',
		// the automatic JSX runtime, standing in for react/jsx-runtime
		"node_modules/react/package.json": JSON.stringify({
			name: "react",
			version: "1.0.0",
			exports: { "./jsx-runtime": "./jsx-runtime.js" },
		}),
		"node_modules/react/jsx-runtime.js":
			'exports.jsx = exports.jsxs = (type, props) => ({ type, props });\nexports.Fragment = "fragment";\n',
		"src/types.ts":
			"export enum Color { Red = 1, Green }\nexport interface Shape { sides: number }\nexport const sides: Shape = { sides: 4 };\n",
		"src/lib.mjs":
			"export const twice = (n) => n * 2;\nexport const here = import.meta.url.startsWith('file://');\nexport const dir = typeof import.meta.dirname;\n",
		"src/view.tsx": "export const View = ({ label }: { label: string }) => <b>{label}</b>;\n",
		"src/index.ts":
			`import shout, { greet } from "esm-only";
import { Color, sides, type Shape } from "./types.ts";
import { twice, here, dir } from "./lib.mjs";
import { View } from "./view.tsx";
import * as path from "node:path";

const shape: Shape = sides;

`.replace("\n", "") +
			`
async function main() {
	const dynamic = await import("./lib.mjs");
	console.log(JSON.stringify({
		greet: greet("world"), shout: shout("quiet"), color: Color.Green, sides: shape.sides,
		twice: twice(21), here, dir, dynamic: dynamic.twice(4), view: View({ label: "hi" }), base: path.basename("/a/b.ts"),
		main: require.main === module,
	}));
}
main();
`,
	});
	const out = await run(root, "src/index.ts");
	assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
	assert.deepEqual(JSON.parse(out.stdout), {
		greet: "hello world",
		shout: "QUIET",
		color: 2,
		sides: 4,
		twice: 42,
		here: true,
		dir: "string",
		dynamic: 8,
		view: { type: "b", props: { children: "hi" } },
		base: "b.ts",
		main: true,
	});
});

test("a TypeScript entrypoint is refused for a Node.js build, with the way out", async () => {
	const root = project({
		"index.ts": "export const x: number = 1;\n",
		"package.json": JSON.stringify({ name: "ts-only" }),
	});
	await assert.rejects(
		BinaryPackager.compile({
			entrypoint: join(root, "index.ts"),
			target: TargetDevice.WinModernX64,
			packageManager: "npm",
			offline: true,
			engine: "node",
		}),
		/only the Graak native host converts/
	);
});

test("system-corpus.cjs prints exactly what Node.js prints (os, vm, module, punycode, process)", {
	timeout: 300_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "graak-system-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "system-fixture" }));
	copyFileSync(join(process.cwd(), "test/fixtures/web/system-corpus.cjs"), join(root, "system-corpus.cjs"));
	const onNode = spawnSync(process.execPath, [join(root, "system-corpus.cjs")], { encoding: "utf-8" });
	const onHost = await run(root, "system-corpus.cjs");
	// Node 3 is process.exitCode in the fixture, on both.
	assert.equal(onHost.status, onNode.status, "exit codes match");
	assert.equal(onHost.stdout, onNode.stdout);
});

test("an ES module that awaits at its top level runs, as a program and as an ES-module-only dependency's consumer", {
	timeout: 300_000,
}, async () => {
	const root = project({
		"package.json": JSON.stringify({ name: "tla-app", version: "1.0.0" }),
		"main.mjs": `import path from "node:path";
import { readFile } from "node:fs/promises";
import { later } from "./later.mjs";
const own = await readFile(new URL(import.meta.url));
const value = await new Promise((resolve) => setTimeout(() => resolve("waited"), 5));
console.log(JSON.stringify({ name: path.basename(import.meta.url), own: own.length > 10, value, later }));
export const done = true;
`,
		"later.mjs": `export const later = await Promise.resolve("imported");\n`,
	});
	const result = await run(root, "main.mjs");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { name: "main.mjs", own: true, value: "waited", later: "imported" });
});

test("tsconfig paths and baseUrl resolve at run time, including extends and fallback targets", {
	timeout: 300_000,
}, async () => {
	const root = project({
		"package.json": JSON.stringify({ name: "paths-app", version: "1.0.0" }),
		"tsconfig.base.json": `{ // shared
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } },
}`,
		"tsconfig.json": `{ "extends": "./tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["src/*"], "@lib": ["src/lib/index.ts"], "~u/*": ["nowhere/*", "src/lib/*"] } } }`,
		"src/components/Button.ts": `import { greet } from "@lib";\nexport const label = (n: string): string => \`[\${greet(n)}]\`;\n`,
		"src/lib/index.ts": `export const greet = (n: string): string => "hello " + n;\n`,
		"src/lib/math.ts": `export const twice = (n: number): number => n * 2;\n`,
		"src/main.ts": `import { label } from "@/components/Button";
import { twice } from "~u/math";
import * as lib from "src/lib/index";
console.log(JSON.stringify([label("paths"), twice(21), typeof lib.greet]));
`,
	});
	const result = await run(root, "src/main.ts");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), ["[hello paths]", 42, "function"]);
});

test("module.createRequire with file URL resolves packages and Windows paths without drive letter duplication", async () => {
	const root = project({
		"package.json": JSON.stringify({
			name: "url-require-app",
			version: "1.0.0",
			dependencies: { "fake-native": "1.0.0" },
		}),
		"node_modules/fake-native/package.json": JSON.stringify({ name: "fake-native", main: "index.js" }),
		"node_modules/fake-native/index.js": "module.exports = { ok: true };",
		"main.cjs": `
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { createRequire } = require("node:module");
const assert = require("node:assert");

// Test Windows path resolution does not double drive letters
const win = path.win32;
assert.equal(win.resolve("C:\\\\Users\\\\User", "/C:/app/package.json"), "C:\\\\app\\\\package.json");
assert.equal(win.resolve("C:\\\\Users\\\\User", "\\\\C:\\\\app\\\\package.json"), "C:\\\\app\\\\package.json");

// Test createRequire with URL
const req = createRequire(pathToFileURL(path.join(__dirname, "package.json")));
const loaded = req("fake-native");
assert.equal(loaded.ok, true);
assert.ok(req.resolve("fake-native").includes("fake-native"));

console.log(JSON.stringify({ ok: true }));
`,
	});
	const result = await run(root, "main.cjs");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { ok: true });
});

test("WebAssembly handles multiple export aliases pointing to the same function index (libsodium pattern)", async () => {
	// Wasm module with 1 function and 4 export aliases all pointing to func 0 ('a', 'b', 'c', 'd')
	const wasmBytes = new Uint8Array([
		0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00,
		0x07, 0x11, 0x04, 0x01, 0x61, 0x00, 0x00, 0x01, 0x62, 0x00, 0x00, 0x01, 0x63, 0x00, 0x00, 0x01, 0x64, 0x00, 0x00,
		0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b,
	]);
	const root = project({
		"package.json": JSON.stringify({ name: "wasm-aliases", version: "1.0.0" }),
		"wasm.bin": Buffer.from(wasmBytes).toString("base64"),
		"main.cjs": `
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const bytes = Buffer.from(fs.readFileSync(path.join(__dirname, "wasm.bin"), "utf8"), "base64");
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
assert.equal(typeof instance.exports.a, "function");
assert.equal(typeof instance.exports.b, "function");
assert.equal(typeof instance.exports.c, "function");
assert.equal(typeof instance.exports.d, "function");
assert.equal(instance.exports.a(), 42);
assert.equal(instance.exports.d(), 42);
console.log(JSON.stringify({ ok: true, d: instance.exports.d() }));
`,
	});
	const result = await run(root, "main.cjs");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { ok: true, d: 42 });
});

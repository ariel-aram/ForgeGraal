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

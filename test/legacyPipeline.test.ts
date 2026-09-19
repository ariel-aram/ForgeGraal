import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as esbuild from "esbuild";

import {
	BinaryPackager,
	createLauncherSource,
	createLegacyPolyfillSource,
	LEGACY_ASSET_DIR,
	LegacyRuntimeAssets,
	LegacyTranspiler,
	MIN_MODERN_API_NODE_MAJOR,
	MIN_TRANSPILABLE_NODE_MAJOR,
	TargetDevice,
} from "../dist/index.js";

async function withFetch<T>(handler: (url: string) => Response, fn: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	// @ts-expect-error test-only stub
	globalThis.fetch = (url: string) => handler(String(url));
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

async function withIsolatedCache<T>(fn: () => Promise<T>): Promise<T> {
	const previous = process.env.FORGEGRAAL_CACHE;
	process.env.FORGEGRAAL_CACHE = mkdtempSync(join(tmpdir(), "forgegraal-lp-cache-"));
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.FORGEGRAAL_CACHE;
		else process.env.FORGEGRAAL_CACHE = previous;
	}
}

function response(body: Buffer): Response {
	return {
		ok: true,
		status: 200,
		arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
	} as Response;
}

function fakeOfficialNodeExe(machine: number, version: string): Buffer {
	const header = Buffer.alloc(256);
	header.write("MZ", 0, "latin1");
	header.writeUInt32LE(0x80, 0x3c);
	header.writeUInt32BE(0x50450000, 0x80);
	header.writeUInt16LE(machine, 0x84);
	header.writeUInt16LE(0x10b, 0x98);
	const marker = Buffer.from(`https://nodejs.org/download/release/v${version}/`, "latin1");
	return Buffer.concat([header, marker, Buffer.alloc(16)]);
}

function serveFakeDist(fileKey: string, content: Buffer) {
	const remotePath = `${fileKey.replace(/-exe$/, "")}/node.exe`;
	const sha256 = createHash("sha256").update(content).digest("hex");
	const shasums = `${sha256}  ${remotePath}\n`;
	return (url: string) => {
		if (url.endsWith("SHASUMS256.txt")) return response(Buffer.from(shasums, "utf-8"));
		if (url.endsWith(remotePath)) return response(content);
		throw new Error(`unexpected fetch: ${url}`);
	};
}

function entry(path: string, contents: string) {
	return { path, source: Buffer.from(contents, "utf-8"), mode: 0o644 };
}

function textOf(e: { source: string | Buffer }): string {
	return typeof e.source === "string" ? "" : e.source.toString("utf-8");
}

test("legacyRuntimePlan splits runtimes into modern, lowerable and out of reach", () => {
	assert.deepEqual(BinaryPackager.legacyRuntimePlan(null), { kind: "modern" });
	assert.deepEqual(BinaryPackager.legacyRuntimePlan("22.11.0"), { kind: "modern" });
	assert.deepEqual(BinaryPackager.legacyRuntimePlan(`${MIN_MODERN_API_NODE_MAJOR}.0.0`), { kind: "modern" });

	const win7 = BinaryPackager.legacyRuntimePlan("12.22.12");
	assert.equal(win7.kind, "lower");
	assert.equal(win7.jsTarget, "node12.22", "the esbuild target must follow the runtime, not a fixed string");

	// Windows Vista's pin. esbuild cannot emit below ES6, so this must be reported rather than
	// silently producing a bundle that cannot parse.
	const vista = BinaryPackager.legacyRuntimePlan("5.12.0");
	assert.equal(vista.kind, "unreachable");
	assert.match(vista.reason, /ES6/);
	assert.ok(MIN_TRANSPILABLE_NODE_MAJOR === 6);
});

test("LegacyTranspiler lowers post-ES2019 syntax, including super inside a private method", async () => {
	// The exact shape that made the TypeScript compiler emit invalid code: a private method
	// referencing super. TypeScript hoists the method out of the class and leaves `super` behind.
	const source = [
		"class Base { onData(x) { return x; } }",
		"class Child extends Base {",
		"  #handle(x) { return super.onData(x) ?? 0; }",
		"  run(x) { return this.#handle(x); }",
		"}",
		"module.exports = Child;",
	].join("\n");

	const result = await LegacyTranspiler.transpile([entry("index.js", source)], { jsTarget: "node12.22" });
	const out = textOf(result.entries[0]);

	assert.equal(result.rewritten, 1);
	assert.ok(!out.includes("??"), "nullish coalescing must be lowered");
	assert.ok(!/#handle/.test(out), "private methods must be lowered");
	// The real regression: the emitted file has to actually parse on the old runtime.
	assert.doesNotThrow(
		() => esbuild.transformSync(out, { target: "node12.22", format: "cjs", platform: "node", loader: "js" }),
		"lowered output must be valid for the target"
	);
});

test("LegacyTranspiler resolves module format from package.json instead of assuming it", async () => {
	// An ESM package: its .js files must be converted to CommonJS and the declaration removed,
	// because require() of an ES module only works on Node 20.19+/22.12+.
	const entries = [
		entry("node_modules/esm-pkg/package.json", JSON.stringify({ name: "esm-pkg", type: "module" })),
		entry("node_modules/esm-pkg/index.js", "export default function hi() { return 1; }\n"),
		entry("node_modules/cjs-pkg/package.json", JSON.stringify({ name: "cjs-pkg" })),
		entry("node_modules/cjs-pkg/index.js", "module.exports = function hi() { return 1; };\n"),
	];

	const result = await LegacyTranspiler.transpile(entries, { jsTarget: "node12.22" });
	const esm = textOf(result.entries[1]);
	const manifest = JSON.parse(textOf(result.entries[0]));

	assert.equal(result.esmConverted, 1, "only the file inside the ESM package counts as converted");
	assert.ok(esm.includes("module.exports") || esm.includes("exports."), "ESM must become CommonJS");
	assert.ok(!esm.includes("export default"), "ESM syntax must not survive");
	assert.equal(manifest.type, undefined, "a surviving type:module would make Node reject the converted files");
	assert.equal(result.manifestsRewritten, 1);
});

test("LegacyTranspiler keeps sloppy-mode semantics, which strict mode would break", async () => {
	const sloppy = "function f() { undeclared = 1; return undeclared; }\nmodule.exports = f;\n";
	const result = await LegacyTranspiler.transpile([entry("sloppy.js", sloppy)], { jsTarget: "node12.22" });
	assert.ok(!textOf(result.entries[0]).includes("use strict"), "adding strict mode would change behaviour");
});

test("LegacyTranspiler leaves unparseable files alone rather than failing the build", async () => {
	// Real packages ship files that are not JavaScript (editor backups, fixtures) and are never
	// loaded. One of them must not take the whole build down.
	const entries = [entry("good.js", "const a = 1 ?? 2;\n"), entry("broken.js", "this is ( not javascript\n")];
	const result = await LegacyTranspiler.transpile(entries, { jsTarget: "node12.22" });

	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0], /^broken\.js:/);
	assert.equal(textOf(result.entries[1]), "this is ( not javascript\n", "the original must be preserved");
	assert.ok(!textOf(result.entries[0]).includes("??"), "other files are still lowered");
});

test("the legacy polyfill source parses as ES5, so an old engine reaches it", () => {
	const source = createLegacyPolyfillSource({
		target: "win-legacy-x86",
		jsTarget: "node12.22",
		assetDir: LEGACY_ASSET_DIR,
		runtimeCodegen: true,
	});

	// Targeting es5 fails if the source contains anything esbuild would have to lower below ES6
	// (let/const, arrow functions, classes, template literals). That is exactly the property
	// needed: the polyfills must parse before they can fix anything.
	assert.doesNotThrow(
		() => esbuild.transformSync(source, { target: "es5", format: "cjs", loader: "js" }),
		"the polyfill prelude must itself be ES5"
	);
});

test("structuredClone is a real clone, not a JSON round-trip", () => {
	const source = createLegacyPolyfillSource({
		target: "win-legacy-x86",
		jsTarget: "node12.22",
		assetDir: LEGACY_ASSET_DIR,
		runtimeCodegen: false,
	});

	// A JSON-based structuredClone makes web-streams-polyfill take its TransferArrayBuffer
	// branch and detach every byte-stream chunk, which turns HTTP responses into empty bodies.
	assert.ok(source.includes("v8.serialize"), "structuredClone must clone binary data for real");
	assert.ok(
		!/structuredClone[\s\S]{0,200}JSON\.parse/.test(source),
		"structuredClone must not be implemented as a JSON round-trip"
	);
});

test("Intl.Segmenter is refused loudly rather than approximated", () => {
	const source = createLegacyPolyfillSource({
		target: "win-legacy-x86",
		jsTarget: "node12.22",
		assetDir: LEGACY_ASSET_DIR,
		runtimeCodegen: false,
	});
	assert.ok(source.includes("Intl.Segmenter"), "the constructor must exist or ForgeScript will not load");
	assert.match(source, /throw new Error\([\s\S]{0,400}Intl\.Segmenter is not available/);
});

test("the runtime code generation patch is only installed when asked for", () => {
	const withCodegen = createLegacyPolyfillSource({
		target: "win-legacy-x86",
		jsTarget: "node12.22",
		assetDir: LEGACY_ASSET_DIR,
		runtimeCodegen: true,
	});
	const without = createLegacyPolyfillSource({
		target: "win-legacy-x86",
		jsTarget: "node12.22",
		assetDir: LEGACY_ASSET_DIR,
		runtimeCodegen: false,
	});

	assert.ok(withCodegen.includes("esbuild-wasm"), "the on-device transpiler is needed for generated code");
	assert.ok(withCodegen.includes("PatchedFunction"));
	assert.ok(!without.includes("esbuild-wasm"));
	assert.ok(without.includes("__forgegraalLegacyReady = null"), "the launcher still needs the readiness signal");
});

test("LegacyRuntimeAssets bundles the polyfills into one file that exposes the missing globals", async () => {
	const result = await LegacyRuntimeAssets.build({ jsTarget: "node12.22", runtimeCodegen: false });
	const polyfills = result.entries.find((e) => e.path === `${LEGACY_ASSET_DIR}/polyfills.js`);
	assert.ok(polyfills, "a bundled polyfill file must be produced");

	const code = LegacyRuntimeAssets.readEntry(polyfills).toString("utf-8");
	for (const name of ["ReadableStream", "AbortController", "EventTarget", "FormData", "Blob", "File"]) {
		assert.ok(code.includes(name), `${name} must be exported from the bundle`);
	}
	assert.equal(result.entries.length, 1, "without runtime codegen, only the bundle ships");
	assert.doesNotThrow(
		() => esbuild.transformSync(code, { target: "node12.22", format: "cjs", platform: "node", loader: "js" }),
		"the bundle must be valid for the target runtime"
	);
});

test("LegacyRuntimeAssets ships esbuild's WebAssembly build when runtime codegen is needed", async () => {
	const result = await LegacyRuntimeAssets.build({ jsTarget: "node12.22", runtimeCodegen: true });
	const paths = result.entries.map((e) => e.path);

	// lib/main.js checks it is loaded from a directory named `lib`, so the layout has to survive.
	assert.ok(paths.includes(`${LEGACY_ASSET_DIR}/esbuild-wasm/lib/main.js`));
	assert.ok(paths.some((p) => p.endsWith("esbuild.wasm")));
	assert.ok(!paths.some((p) => p.includes("/esbuild-wasm/esm/")), "the browser ES module build is not used here");
});

test("the launcher waits for the runtime transpiler before loading the bot", () => {
	const source = createLauncherSource({
		name: "bot",
		entry: "index.js",
		hash: "abc",
		minNode: "12.22.12",
		target: "win-legacy-x86",
		mode: "portable",
		windowsLegacy: true,
		simdUnsafe: true,
		nativeShim: true,
		bunCompat: false,
		legacyPolyfills: {
			target: "win-legacy-x86",
			jsTarget: "node12.22",
			assetDir: LEGACY_ASSET_DIR,
			runtimeCodegen: true,
		},
	});

	// ForgeScript compiles through new Function() while its modules are still being required, so
	// loading the bot before the patch is live would defeat the whole mechanism.
	assert.ok(source.includes("__forgegraalLegacyReady"));
	assert.match(source, /legacyReady\.then\(loadEntry/);
	assert.ok(source.includes("function loadEntry()"));
});

test("a modern build carries none of the legacy machinery", () => {
	const source = createLauncherSource({
		name: "bot",
		entry: "index.js",
		hash: "abc",
		minNode: null,
		target: "linux-modern-x64",
		mode: "sea",
		windowsLegacy: false,
		simdUnsafe: false,
		nativeShim: false,
		bunCompat: false,
		legacyPolyfills: null,
	});
	assert.ok(!source.includes("esbuild-wasm"));
	assert.ok(!source.includes("installForgeGraalLegacyPolyfills"));
	assert.ok(source.includes("loadEntry()"), "the entry is still loaded, just without waiting");
});

test("the legacy polyfills provide global fetch, which is what a bot actually calls", () => {
	const source = createLegacyPolyfillSource({
		target: "win-legacy-x64",
		jsTarget: "node12.22",
		assetDir: LEGACY_ASSET_DIR,
		runtimeCodegen: true,
	});

	// Found on a real Windows machine: a bot died with "fetch is not defined" because this layer
	// polyfilled everything undici needs and then omitted the global the bot calls. Node itself
	// does not implement fetch -- from v18 it exposes undici's -- so the fix is to wire the same
	// implementation to the same global.
	assert.match(source, /typeof g\.fetch === "undefined"/, "fetch must be installed when missing");
	assert.match(source, /appRequire\("undici"\)/, "fetch must come from undici, as it does in Node");
	for (const name of ["fetch", "Headers", "Request", "Response"]) {
		assert.ok(source.includes(`def("${name}", undici.`), `${name} must be taken from undici`);
	}
	// Ordering matters: undici's fetch is built on these, so requiring it earlier would fail.
	assert.ok(
		source.indexOf('def("ReadableStream"') < source.indexOf('appRequire("undici")'),
		"fetch must be wired after the streams it depends on"
	);
	// With no undici in the bundle it must still explain itself rather than leave a bare
	// ReferenceError at the call site.
	assert.match(source, /fetch\(\) is not available on/);
});

test("a native addon that matches the target's architecture but cannot load is still flagged", async () => {
	// The case that reached a real Windows machine unannounced: @lmdb/lmdb-win32-x64 is a valid
	// win32 x64 PE, so the architecture check passed and the build said nothing. It still failed
	// to load, because it is built for a newer Node ABI and a newer Windows.
	const root = mkdtempSync(join(tmpdir(), "forgegraal-lmdb-"));
	mkdirSync(join(root, "node_modules/lmdb"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lmdb-bot", dependencies: { lmdb: "^3" } }));
	writeFileSync(
		join(root, "node_modules/lmdb/package.json"),
		JSON.stringify({ name: "lmdb", version: "3.0.0", main: "index.js" })
	);
	writeFileSync(join(root, "node_modules/lmdb/index.js"), "module.exports = {};");

	// A PE32+ header for x86-64: architecturally correct for win-legacy-x64.
	const pe = Buffer.alloc(512);
	pe.write("MZ", 0, "latin1");
	pe.writeUInt32LE(0x80, 0x3c);
	pe.writeUInt32BE(0x50450000, 0x80);
	pe.writeUInt16LE(0x8664, 0x84);
	pe.writeUInt16LE(0x20b, 0x98);
	writeFileSync(join(root, "node_modules/lmdb/node.napi.node"), pe);
	writeFileSync(join(root, "index.js"), 'require("lmdb");');

	const content = fakeOfficialNodeExe(0x8664, "12.22.12");
	await withIsolatedCache(() =>
		withFetch(serveFakeDist("win-x64-exe", content), async () => {
			const result = await BinaryPackager.compile({
				entrypoint: join(root, "index.js"),
				target: TargetDevice.WinLegacyX64,
				packageManager: "npm",
				offline: false,
			});
			assert.ok(
				result.warnings.some((w: string) => w.includes("lmdb") && w.includes("procedure could not be found")),
				`the build must warn before deployment, not leave it to the target machine:\n${result.warnings.join("\n")}`
			);
		})
	);
});

test("a modern target does not get the legacy native-addon warning", async () => {
	const root = mkdtempSync(join(tmpdir(), "forgegraal-lmdb-modern-"));
	mkdirSync(join(root, "node_modules/lmdb"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lmdb-bot" }));
	writeFileSync(join(root, "node_modules/lmdb/package.json"), JSON.stringify({ name: "lmdb", main: "index.js" }));
	writeFileSync(join(root, "node_modules/lmdb/index.js"), "module.exports = {};");
	writeFileSync(join(root, "index.js"), 'require("lmdb");');

	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
		strategy: "portable",
	});
	assert.ok(
		!result.warnings.some((w: string) => w.includes("procedure could not be found")),
		"the warning is about old Windows, so a modern target must not get it"
	);
});

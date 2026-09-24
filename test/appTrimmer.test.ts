import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AppTrimmer, type ArchiveEntry, BinaryPackager, TargetDevice } from "../dist/index.js";

function entries(files: Record<string, string | Buffer>): ArchiveEntry[] {
	return Object.entries(files).map(([path, contents]) => ({
		path,
		source: Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
		mode: 0o644,
	}));
}

const pkg = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: "1.0.0", ...extra });

function trimmed(files: Record<string, string | Buffer>, options: Partial<Parameters<typeof AppTrimmer.trim>[1]> = {}) {
	const result = AppTrimmer.trim(entries(files), { target: TargetDevice.WinLegacyX64, ...options });
	return { ...result, paths: new Set(result.entries.map((e) => e.path)) };
}

/** Just enough of an ELF (x86-64) or PE (x64) header for BinaryInspector. */
function elf(): Buffer {
	const b = Buffer.alloc(128);
	b.writeUInt32BE(0x7f454c46, 0);
	b[4] = 2;
	b[5] = 1;
	b.writeUInt16LE(62, 18);
	return b;
}
function pe(): Buffer {
	const b = Buffer.alloc(256);
	b.write("MZ", 0, "latin1");
	b.writeUInt32LE(0x40, 0x3c);
	b.writeUInt32BE(0x50450000, 0x40);
	b.writeUInt16LE(0x8664, 0x44);
	b.writeUInt16LE(0x20b, 0x40 + 24);
	return b;
}

test("only what the program reaches ships: unused packages, unused files, docs and types are left out", () => {
	const { paths, droppedPackages, before, after } = trimmed({
		"package.json": pkg("app", { dependencies: { used: "1", unused: "1" } }),
		"index.js": 'const u = require("used");\nconsole.log(u);',
		"README.md": "the program's own files always ship",
		"lib/helper.js": "module.exports = 1; // not required by anything, still the program's own",
		"node_modules/used/package.json": pkg("used", { main: "lib/main.js" }),
		"node_modules/used/lib/main.js": 'module.exports = require("./part");',
		"node_modules/used/lib/part.js": "module.exports = 42;",
		"node_modules/used/lib/unreached.js": "module.exports = 0;",
		"node_modules/used/lib/main.d.ts": "export {};",
		"node_modules/used/README.md": "# used",
		"node_modules/used/LICENSE": "MIT",
		"node_modules/unused/package.json": pkg("unused"),
		"node_modules/unused/index.js": "module.exports = 1;",
	});
	assert.deepEqual(
		[...paths].sort(),
		[
			"README.md",
			"index.js",
			"lib/helper.js",
			"node_modules/used/LICENSE",
			"node_modules/used/lib/main.js",
			"node_modules/used/lib/part.js",
			"node_modules/used/package.json",
			"package.json",
		].sort()
	);
	assert.deepEqual(droppedPackages, ["node_modules/unused"]);
	assert.equal(before.files, 13);
	assert.equal(after.files, 8);
});

test("resolution follows the host: exports with require first, #imports, nested installs, extensionless paths", () => {
	const { paths } = trimmed({
		"package.json": pkg("app"),
		"index.mjs": 'import a from "dual";\nimport "dual/extra";\nconst b = await import("nested-user");',
		"node_modules/dual/package.json": pkg("dual", {
			exports: {
				".": { import: "./esm/index.mjs", require: "./cjs/index.cjs" },
				"./extra": { default: "./cjs/extra.js" },
			},
			imports: { "#internal": { node: "./cjs/internal.js", default: "./browser.js" } },
		}),
		"node_modules/dual/esm/index.mjs": "export default 1;",
		"node_modules/dual/cjs/index.cjs": 'module.exports = require("#internal");',
		"node_modules/dual/cjs/internal.js": "module.exports = 1;",
		"node_modules/dual/cjs/extra.js": "module.exports = 2;",
		"node_modules/dual/browser.js": "module.exports = 3;",
		"node_modules/nested-user/package.json": pkg("nested-user"),
		"node_modules/nested-user/index.js": 'require("dep/sub");',
		"node_modules/nested-user/node_modules/dep/package.json": pkg("dep"),
		"node_modules/nested-user/node_modules/dep/sub.js": "module.exports = 1;",
		"node_modules/nested-user/node_modules/dep/other.js": "module.exports = 1;",
		"node_modules/dep/package.json": pkg("dep"),
		"node_modules/dep/sub.js": "module.exports = 'the hoisted copy is not the one nested-user loads';",
	});
	for (const path of [
		"node_modules/dual/cjs/index.cjs",
		"node_modules/dual/cjs/internal.js",
		"node_modules/dual/cjs/extra.js",
		"node_modules/nested-user/index.js",
		"node_modules/nested-user/node_modules/dep/sub.js",
	])
		assert.ok(paths.has(path), path);
	for (const path of [
		"node_modules/dual/esm/index.mjs",
		"node_modules/dual/browser.js",
		"node_modules/nested-user/node_modules/dep/other.js",
		"node_modules/dep/sub.js",
	])
		assert.ok(!paths.has(path), path);
});

test("a package that computes what it loads ships whole, and so do the packages it depends on", () => {
	const { paths } = trimmed({
		"package.json": pkg("app", { dependencies: { loader: "1" } }),
		"index.js": 'require("loader");',
		"node_modules/loader/package.json": pkg("loader", { dependencies: { plugin: "1" } }),
		"node_modules/loader/index.js":
			'for (const f of require("fs").readdirSync(__dirname + "/commands")) require("./commands/" + f);',
		"node_modules/loader/commands/a.js": "module.exports = 1;",
		"node_modules/loader/data/table.bin": "binary data read by path",
		"node_modules/loader/test/a.test.js": 'require("devonly");',
		"node_modules/loader/docs/guide.md": "# guide",
		"node_modules/plugin/package.json": pkg("plugin"),
		"node_modules/plugin/index.js": "module.exports = 1;",
		"node_modules/plugin/extra/loaded-by-name.js": "module.exports = 1;",
		"node_modules/plugin/index.d.ts": "export {};",
	});
	for (const path of [
		"node_modules/loader/commands/a.js",
		"node_modules/loader/data/table.bin",
		"node_modules/plugin/index.js",
		"node_modules/plugin/extra/loaded-by-name.js",
	])
		assert.ok(paths.has(path), path);
	for (const path of [
		"node_modules/loader/test/a.test.js",
		"node_modules/loader/docs/guide.md",
		"node_modules/plugin/index.d.ts",
	])
		assert.ok(!paths.has(path), path);
});

test("a require spelled in another case still reaches the file, as it does on Windows", () => {
	const { paths } = trimmed({
		"package.json": pkg("app"),
		"index.js": 'require("lib");',
		"node_modules/lib/package.json": pkg("lib"),
		"node_modules/lib/index.js": 'require("./Util/Strings");',
		"node_modules/lib/util/strings.js": "module.exports = 1;",
	});
	assert.ok(paths.has("node_modules/lib/util/strings.js"));
});

test("once anything loads a package by name, the program's own dependencies all ship (knex is told 'pg' at run time)", () => {
	const files = {
		"package.json": pkg("app", { dependencies: { knex: "1", pg: "1" } }),
		"index.js": 'require("knex")({ client: "pg" });',
		"node_modules/knex/package.json": pkg("knex"),
		"node_modules/knex/index.js": "module.exports = (config) => require(config.client);",
		"node_modules/pg/package.json": pkg("pg", { main: "lib/index.js" }),
		"node_modules/pg/lib/index.js": 'module.exports = require("./client");',
		"node_modules/pg/lib/client.js": "module.exports = 1;",
		"node_modules/pg/lib/unused.js": "module.exports = 1;",
	};
	const { paths } = trimmed(files);
	assert.ok(paths.has("node_modules/pg/lib/index.js"));
	assert.ok(paths.has("node_modules/pg/lib/client.js"));
	assert.ok(!paths.has("node_modules/pg/lib/unused.js"), "reached from its entry point like any other package");
	const literal = trimmed({ ...files, "node_modules/knex/index.js": 'module.exports = () => require("./x");' }).paths;
	assert.ok(
		!literal.has("node_modules/pg/lib/index.js"),
		"with nothing loaded by name, an unused dependency is left out"
	);
});

test("code that reads its own files by path keeps its package; require.resolve keeps the package it names", () => {
	const { paths } = trimmed({
		"package.json": pkg("app"),
		"index.js": 'require("assets"); require("finder");',
		"node_modules/assets/package.json": pkg("assets"),
		"node_modules/assets/index.js":
			'module.exports = require("fs").readFileSync(require("path").join(__dirname, "x.wasm"));',
		"node_modules/assets/x.wasm": "\0asm",
		"node_modules/finder/package.json": pkg("finder"),
		"node_modules/finder/index.js": 'module.exports = require.resolve("data-pkg/package.json");',
		"node_modules/data-pkg/package.json": pkg("data-pkg"),
		"node_modules/data-pkg/table.json": "{}",
	});
	assert.ok(paths.has("node_modules/assets/x.wasm"));
	assert.ok(paths.has("node_modules/data-pkg/table.json"));
});

test("binaries built for another platform and addon build inputs are left out", () => {
	const files = {
		"package.json": pkg("app"),
		"index.js": 'require("addon");',
		"node_modules/addon/package.json": pkg("addon"),
		"node_modules/addon/index.js": 'module.exports = require("node-gyp-build")(__dirname);',
		"node_modules/addon/prebuilds/win32-x64/addon.node": pe(),
		"node_modules/addon/prebuilds/linux-x64/addon.node": elf(),
		"node_modules/addon/src/addon.cc": "// C++ source",
		"node_modules/addon/binding.gyp": "{}",
	};
	const win = trimmed(files).paths;
	assert.ok(win.has("node_modules/addon/prebuilds/win32-x64/addon.node"));
	assert.ok(!win.has("node_modules/addon/prebuilds/linux-x64/addon.node"));
	assert.ok(!win.has("node_modules/addon/src/addon.cc"));
	assert.ok(!win.has("node_modules/addon/binding.gyp"));
	const linux = trimmed(files, { target: TargetDevice.LinuxModernX64 }).paths;
	assert.ok(linux.has("node_modules/addon/prebuilds/linux-x64/addon.node"));
	assert.ok(!linux.has("node_modules/addon/prebuilds/win32-x64/addon.node"));
});

test("source maps ship only when something reads them", () => {
	const files = {
		"package.json": pkg("app"),
		"index.js": 'require("lib");',
		"node_modules/lib/package.json": pkg("lib"),
		"node_modules/lib/index.js": "module.exports = 1;\n//# sourceMappingURL=index.js.map",
		"node_modules/lib/index.js.map": "{}",
	};
	assert.ok(!trimmed(files).paths.has("node_modules/lib/index.js.map"));
	const withSupport = trimmed({
		...files,
		"index.js": 'require("source-map-support").install(); require("lib");',
		"node_modules/source-map-support/package.json": pkg("source-map-support"),
		"node_modules/source-map-support/index.js": "module.exports = { install() {} };",
	});
	assert.ok(withSupport.paths.has("node_modules/lib/index.js.map"));
});

test("a trimmed native build runs exactly as the untrimmed one, with the unused package left out", {
	timeout: 300_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "graak-trim-"));
	const write = (path: string, contents: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	};
	write("package.json", pkg("trim-app", { dependencies: { greet: "1", unused: "1" } }));
	write(
		"index.js",
		'const greet = require("greet");\nconsole.log(JSON.stringify({ hello: greet("world"), data: require("greet/data.json").n }));'
	);
	write(
		"node_modules/greet/package.json",
		pkg("greet", { exports: { ".": "./index.js", "./data.json": "./data.json" } })
	);
	write("node_modules/greet/index.js", 'module.exports = (name) => "hello " + name;');
	write("node_modules/greet/data.json", '{"n":7}');
	write("node_modules/greet/README.md", "# greet");
	write("node_modules/greet/index.d.ts", "export {};");
	write("node_modules/unused/package.json", pkg("unused"));
	write("node_modules/unused/index.js", "module.exports = 1;");
	const expected = spawnSync(process.execPath, [join(root, "index.js")], { encoding: "utf-8" });
	assert.equal(expected.status, 0, expected.stderr);

	const run = async (trim: boolean) => {
		const out = join(mkdtempSync(join(tmpdir(), "graak-trim-out-")), "app");
		const logs: string[] = [];
		const result = await BinaryPackager.compile({
			entrypoint: join(root, "index.js"),
			target: TargetDevice.LinuxModernX64,
			packageManager: "npm",
			offline: true,
			engine: "native",
			strategy: "sea",
			output: out,
			trim,
			onLog: (message) => logs.push(message),
		});
		// No Node.js anywhere: the single executable needs nothing on PATH.
		const ran = spawnSync(out, [], { encoding: "utf-8", env: { PATH: "/nonexistent" } });
		return { unpacked: `${out}.graak`, logs, ran, result };
	};
	const lean = await run(true);
	assert.equal(lean.ran.status, 0, lean.ran.stderr);
	assert.equal(lean.ran.stdout, expected.stdout);
	assert.ok(!existsSync(join(lean.unpacked, "app/node_modules/unused")), "the unused package is left out");
	assert.ok(!existsSync(join(lean.unpacked, "app/node_modules/greet/README.md")));
	assert.ok(existsSync(join(lean.unpacked, "app/node_modules/greet/data.json")));
	assert.ok(lean.logs.some((line) => /Kept the \d+ of \d+ files the program can load/.test(line)));

	const full = await run(false);
	assert.equal(full.ran.stdout, expected.stdout);
	assert.ok(existsSync(join(full.unpacked, "app/node_modules/unused/index.js")), "trim: false ships everything");
	assert.ok(lean.result.files < full.result.files);
});

test("esbuild's __require is followed, and a package reached only by name still ships its binaries", () => {
	const { paths } = trimmed({
		"package.json": pkg("app"),
		"main.graak-build.cjs": 'var zod = __require("zod");\nrequire("dll-only");',
		"node_modules/zod/package.json": pkg("zod", { main: "lib/index.js" }),
		"node_modules/zod/lib/index.js": "module.exports = 1;",
		"node_modules/dll-only/package.json": pkg("dll-only"),
		"node_modules/dll-only/helper.dll": pe(),
	});
	assert.ok(paths.has("node_modules/zod/lib/index.js"));
	assert.ok(paths.has("node_modules/dll-only/helper.dll"));
});

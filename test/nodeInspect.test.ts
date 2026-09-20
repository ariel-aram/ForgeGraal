import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { QuickJsPackager, TargetDevice } from "../dist/index.js";

// The engine's own console prints every object as "[object Object]". The host's console has to read
// like Node's, so it is compared against Node on a corpus covering the shapes bots actually log.
test("console.log formats objects, collections, classes and errors exactly as Node.js does", {
	timeout: 600_000,
}, async () => {
	const corpus = join(process.cwd(), "test/fixtures/inspect-corpus.js");
	const expected = spawnSync(process.execPath, [corpus], { encoding: "utf-8" });
	assert.equal(expected.status, 0, expected.stderr);

	const host = await QuickJsPackager.ensureNativeHost(TargetDevice.LinuxModernX64, "glibc");
	const actual = spawnSync(host, [join(process.cwd(), "quickjs/runtime/node-compat.js"), corpus], {
		encoding: "utf-8",
		timeout: 60_000,
	});
	assert.equal(actual.status, 0, actual.stderr);
	assert.equal(actual.stdout, expected.stdout);
	assert.equal(actual.stderr, expected.stderr, "console.error goes to stderr, formatted the same way");
});

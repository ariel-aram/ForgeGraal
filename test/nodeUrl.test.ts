import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { QuickJsPackager, TargetDevice } from "../dist/index.js";

// The engine has no URL, and fetch, http and discord.js build one for every request. The host's
// implementation is compared against Node.js on inputs covering schemes, hosts, credentials, dot segments,
// percent-encoding, relative resolution, live searchParams, setters, and the legacy url module.
test("URL, URLSearchParams and the url module behave exactly as Node.js does", { timeout: 600_000 }, async () => {
	const corpus = join(process.cwd(), "test/fixtures/url-corpus.cjs");
	const expected = spawnSync(process.execPath, ["--no-warnings", corpus], { encoding: "utf-8" });
	assert.equal(expected.status, 0, expected.stderr);

	const host = await QuickJsPackager.ensureNativeHost(TargetDevice.LinuxModernX64, "glibc");
	const actual = spawnSync(host, [join(process.cwd(), "quickjs/runtime/node-compat.js"), corpus], {
		encoding: "utf-8",
		timeout: 60_000,
	});
	assert.equal(actual.status, 0, actual.stderr);
	assert.equal(actual.stdout, expected.stdout);
});

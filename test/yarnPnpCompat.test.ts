import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BinaryPackager, TargetDevice, YarnPnpCompat } from "../dist/index.js";

/**
 * Bootstraps a real Yarn Berry Plug'n'Play project: `.pnp.cjs`, `yarn.lock` and a pinned
 * `yarnPath` produced by the actual Yarn CLI, not hand-written. Returns `null` (rather than
 * failing) when the network or `npx` is unavailable, the same way `quickjsRuntime.test.ts` skips
 * when no `qjs` is on PATH -- this exercises real interop, so it needs the real tool.
 */
function setupPnpProject(): string | null {
	try {
		const root = mkdtempSync(join(tmpdir(), "graak-yarn-pnp-fixture-"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pnp-bot", private: true }));
		execFileSync("npx", ["--yes", "yarn@1.22.22", "set", "version", "berry"], {
			cwd: root,
			stdio: "ignore",
			timeout: 60_000,
		});
		const yarnScript = join(root, ".yarn/releases");
		const release = readdirSync(yarnScript).find((f) => f.endsWith(".cjs"));
		if (!release) return null;
		execFileSync(process.execPath, [join(yarnScript, release), "add", "left-pad@1.3.0"], {
			cwd: root,
			stdio: "ignore",
			timeout: 60_000,
		});
		if (!existsSync(join(root, ".pnp.cjs"))) return null;

		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(
			join(root, "src/index.js"),
			`const leftPad = require("left-pad");\nconsole.log(JSON.stringify({ padded: leftPad("1", 3, "0") }));`
		);
		return root;
	} catch {
		return null;
	}
}

const pnpRoot = setupPnpProject();

test("YarnPnpCompat.isPnpProject recognizes a real Berry install", {
	skip: pnpRoot ? false : "no network/npx to bootstrap Yarn Berry",
}, () => {
	assert.equal(YarnPnpCompat.isPnpProject(pnpRoot as string), true);
});

test("a Yarn PnP project builds and runs, with node_modules materialized rather than reimplemented", {
	skip: pnpRoot ? false : "no network/npx to bootstrap Yarn Berry",
	timeout: 120_000,
}, async () => {
	const root = pnpRoot as string;
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		// Node.js-path target: PnP materialization is orthogonal to the quickjs rollout, and
		// LinuxModernX64 now defaults elsewhere (see quickJsPackager.test.ts).
		target: TargetDevice.LinuxModernArm64,
		packageManager: "yarn",
		strategy: "portable",
		offline: true,
	});

	assert.equal(result.strategy, "portable");
	const output = execFileSync(process.execPath, [join(result.outputPath, "boot.cjs")], { encoding: "utf-8" });
	assert.deepEqual(JSON.parse(output), { padded: "001" });

	// The original project must be untouched: still PnP, .pnp.cjs still present, no
	// node_modules ever written into it.
	assert.equal(YarnPnpCompat.isPnpProject(root), true, "the original project's .pnp.cjs must survive the build");
	assert.ok(!existsSync(join(root, "node_modules")), "the original project must never get a real node_modules");
});

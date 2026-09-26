import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { QuickJsPackager, TargetDevice } from "../dist/index.js";

/*
 * child_process streaming and fork(), timers and cluster on the Windows hosts, under Wine: the IPC channel there is two
 * anonymous pipes (no AF_UNIX before Windows 10), and a non-blocking write to one has rules of its own. Each corpus must
 * print what Node.js prints; only the spawn part of fork-win-corpus differs by platform (cmd.exe against sh) and it
 * prints normalised results.
 */

const hasWine = spawnSync("docker", ["image", "inspect", "fg-wine"]).status === 0;
const corpora = ["fork-win-corpus.cjs", "cluster-corpus.cjs", "timers-corpus.cjs"];

function wine(dir: string, exe: string, corpus: string) {
	return spawnSync(
		"docker",
		[
			"run",
			"--rm",
			"-v",
			`${dir}:/w`,
			"-w",
			"/w",
			"-e",
			"WINEDEBUG=-all",
			"-e",
			"WINEPREFIX=/wine",
			"fg-wine",
			"sh",
			"-c",
			`wineboot -u >/dev/null 2>&1; wine ${exe} 'Z:\\\\w\\\\runtime\\\\node-compat.js' 'Z:\\\\w\\\\${corpus}'`,
		],
		{ encoding: "utf-8", timeout: 360_000 }
	);
}

for (const [label, target] of [
	["Windows 7 and later, 64-bit", TargetDevice.WinLegacyX64],
	["Windows XP, 32-bit", TargetDevice.WinXpX86],
] as const) {
	test(`child_process, fork, cluster and timers on the Windows host match Node.js (${label}, Wine)`, {
		skip: !hasWine && "no fg-wine Docker image",
		timeout: 1_500_000,
	}, async () => {
		const host = await QuickJsPackager.ensureNativeHost(target);
		const dir = mkdtempSync(join(tmpdir(), "graak-winproc-"));
		copyFileSync(host, join(dir, "graak-c.exe"));
		cpSync(join(process.cwd(), "quickjs/runtime"), join(dir, "runtime"), { recursive: true });
		for (const corpus of corpora) {
			const source = join(process.cwd(), "test/fixtures/web", corpus);
			copyFileSync(source, join(dir, corpus));
			const env = { ...process.env };
			delete env.FORCE_COLOR;
			const expected = spawnSync(process.execPath, [source], { encoding: "utf-8", env });
			assert.equal(expected.status, 0, `Node baseline failed for ${corpus}:\n${expected.stdout}${expected.stderr}`);
			const actual = wine(dir, "graak-c.exe", corpus);
			assert.equal(actual.stdout.replace(/\r/g, ""), expected.stdout, `${corpus} on ${label}:\n${actual.stderr}`);
		}
	});
}

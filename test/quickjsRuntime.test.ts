import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	QUICKJS_TARGET_ASSETS,
	QUICKJS_VERSION,
	QUICKJS_VISTA_ONLY_IMPORTS,
	QuickJsRuntime,
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
	process.env.FORGEGRAAL_CACHE = mkdtempSync(join(tmpdir(), "forgegraal-qjs-cache-"));
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

test("every mapped quickjs-ng asset carries a pinned checksum", () => {
	const entries = Object.entries(QUICKJS_TARGET_ASSETS);
	assert.ok(entries.length > 0);
	for (const [target, asset] of entries) {
		assert.ok(asset, target);
		// quickjs-ng publishes no SHASUMS file, so an unpinned asset means nothing vouches for
		// the bytes. Downloading an executable on that basis is what RuntimeRegistry refuses.
		assert.match(asset.sha256 ?? "", /^[0-9a-f]{64}$/, `${target} must pin a SHA-256`);
	}
});

test("32-bit targets Node.js cannot serve do have a quickjs-ng engine", () => {
	// The point of the engine: Node's last 32-bit Linux build is an unofficial 12.16.3, and
	// Windows 7 tops out at 12.22.12, both far below current discord.js. quickjs-ng publishes
	// current builds for exactly these.
	for (const target of [TargetDevice.LinuxX86, TargetDevice.WinLegacyX86, TargetDevice.WinVistaX86]) {
		const asset = QuickJsRuntime.assetFor(target);
		assert.ok(asset, `${target} should map to a published engine`);
	}
});

test("download URLs point at the pinned release", () => {
	const url = QuickJsRuntime.downloadUrl("qjs-linux-x86");
	assert.equal(url, `https://github.com/quickjs-ng/quickjs/releases/download/${QUICKJS_VERSION}/qjs-linux-x86`);
});

test("a failed download is reported rather than cached as an empty engine", async () => {
	await withIsolatedCache(() =>
		withFetch(
			() => ({ ok: false, status: 404 }) as Response,
			async () => {
				await assert.rejects(QuickJsRuntime.ensure(TargetDevice.LinuxX86), /Download failed \(404\)/);
			}
		)
	);
});

test("an engine that fails verification is never written to the cache", async () => {
	// The safety property that matters: a mismatch must leave nothing behind, or the next build
	// would find the bad file already cached and trust it.
	await withIsolatedCache(async () => {
		let attempts = 0;
		await withFetch(
			() => {
				attempts++;
				return response(Buffer.from("tampered"));
			},
			async () => {
				await assert.rejects(QuickJsRuntime.ensure(TargetDevice.LinuxX86), /Checksum mismatch/);
				await assert.rejects(QuickJsRuntime.ensure(TargetDevice.LinuxX86), /Checksum mismatch/);
			}
		);
		assert.equal(attempts, 2, "a rejected engine must not be served from the cache on the next call");
	});
});

test("ensure rejects a download whose bytes do not match the pin", async () => {
	await withIsolatedCache(() =>
		withFetch(
			() => response(Buffer.from("not the real engine")),
			async () => {
				await assert.rejects(QuickJsRuntime.ensure(TargetDevice.LinuxX86), /Checksum mismatch/);
			}
		)
	);
});

test("ensure caches a verified engine and does not re-download it", async () => {
	const payload = Buffer.from("pretend engine binary");
	const sha256 = createHash("sha256").update(payload).digest("hex");
	let downloads = 0;

	await withIsolatedCache(() =>
		withFetch(
			() => {
				downloads++;
				return response(payload);
			},
			async () => {
				const first = await QuickJsRuntime.ensure(TargetDevice.LinuxX86, { sha256 });
				const second = await QuickJsRuntime.ensure(TargetDevice.LinuxX86, { sha256 });
				assert.equal(first, second);
				assert.equal(downloads, 1, "a cached engine must not be fetched again");
			}
		)
	);
});

test("a target with no published build says so instead of guessing", async () => {
	await assert.rejects(QuickJsRuntime.ensure(TargetDevice.FreeBsdX86), /publishes no prebuilt engine for freebsd-x86/);
});

test("windowsFloor reads the imports, not the PE header's declared version", () => {
	const dir = mkdtempSync(join(tmpdir(), "forgegraal-qjs-pe-"));

	// The published 32-bit build declares subsystem 4.0 yet imports Vista-only functions, so the
	// header alone would put it on Windows 95. The imports are what decide.
	const vistaBuild = join(dir, "vista.exe");
	writeFileSync(vistaBuild, `MZ${"\0".repeat(64)}KERNEL32.dll\0${QUICKJS_VISTA_ONLY_IMPORTS.join("\0")}\0`);
	assert.equal(QuickJsRuntime.windowsFloor(vistaBuild), "vista");

	// The same engine with its JS_HAVE_THREADS block compiled out has none of them, which is what
	// an XP-capable build has to look like.
	const xpBuild = join(dir, "xp.exe");
	writeFileSync(xpBuild, `MZ${"\0".repeat(64)}KERNEL32.dll\0EnterCriticalSection\0`);
	assert.equal(QuickJsRuntime.windowsFloor(xpBuild), "xp");

	const notWindows = join(dir, "elf");
	writeFileSync(notWindows, "\x7fELF\0\0\0");
	assert.equal(QuickJsRuntime.windowsFloor(notWindows), null);
});

test("the Vista-only import list is the exact set an XP build has to remove", () => {
	// All four come from one block in the engine's cutils.h, guarded by JS_HAVE_THREADS. Keeping
	// the list here is what makes "XP needs one block changed, not a port" a checkable claim.
	assert.deepEqual([...QUICKJS_VISTA_ONLY_IMPORTS].sort(), [
		"InitOnceExecuteOnce",
		"InitializeConditionVariable",
		"SleepConditionVariableCS",
		"WakeConditionVariable",
	]);
});

/**
 * Behavioural checks for the Node compatibility layer, run against a real quickjs-ng engine.
 *
 * Skipped when no engine is on PATH (set FORGEGRAAL_QJS to point at one, or `qjs`), because the
 * binary is not a build dependency. The same selftest is also run against Node below, which is
 * what makes a pass meaningful: the file is not tailored to either runtime.
 */
function findEngine(): string | null {
	const explicit = process.env.FORGEGRAAL_QJS;
	if (explicit && existsSync(explicit)) return explicit;
	const result = spawnSync("sh", ["-c", "command -v qjs"], { encoding: "utf-8" });
	const found = result.stdout.trim();
	return found ? found : null;
}

const engine = findEngine();

test("the Node compatibility layer behaves the same on quickjs-ng as on Node", {
	skip: engine ? false : "no qjs engine found",
}, () => {
	const selftest = join(process.cwd(), "quickjs/runtime/selftest.js");
	const compat = join(process.cwd(), "quickjs/runtime/node-compat.js");

	const onQuickjs = spawnSync(engine as string, ["-m", compat, selftest], { encoding: "utf-8" });
	const onNode = spawnSync(process.execPath, [selftest], { encoding: "utf-8" });

	const summary = (out: string) => out.trim().split("\n").pop() ?? "";
	assert.match(summary(onNode.stdout), /selftest: (\d+)\/\1 passed/, `Node baseline failed:\n${onNode.stdout}`);
	assert.equal(
		summary(onQuickjs.stdout),
		summary(onNode.stdout),
		`quickjs-ng must match Node exactly:\n${onQuickjs.stdout}${onQuickjs.stderr}`
	);
});

test("the compatibility layer refuses to fake the modules it has not implemented", () => {
	const source = readFileSync(join(process.cwd(), "quickjs/runtime/node-compat.js"), "utf-8");
	// net/tls/http/crypto need native work the engine cannot do yet. Stubbing them would produce
	// a bot that looks like it started and then fails somewhere unrelated.
	for (const name of ["net", "tls", "http", "crypto", "zlib"]) {
		assert.match(source, new RegExp(`\\b${name}: notImplemented\\(`), `${name} must not be quietly stubbed`);
	}
	assert.ok(
		source.includes("__forgegraalUnavailable"),
		"unavailable modules must be detectable by the conformance tool"
	);
});

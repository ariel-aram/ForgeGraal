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

test("modules needing a socket are real with a native layer and explicit without one", () => {
	const source = readFileSync(join(process.cwd(), "quickjs/runtime/node-compat.js"), "utf-8");
	// The property that matters is not that these are unimplemented -- they are implemented now --
	// but that they are never quietly stubbed: with a native layer they are real, and without one
	// they say what is missing rather than half-working.
	for (const name of ["net", "tls", "http", "https", "crypto", "zlib"]) {
		assert.match(
			source,
			new RegExp(`\\b${name}: nativeModules\\?\\.\\w+ \\?\\? notImplemented\\(`),
			`${name} must be native-backed with an explicit fallback`
		);
	}
	// http2 is the one still outstanding, and it explains itself rather than pretending.
	assert.match(source, /http2: notImplemented\(/);
	assert.ok(
		source.includes("__forgegraalUnavailable"),
		"unavailable modules must stay detectable by the conformance tool"
	);
});

/**
 * The native backends. Both `runtime/` (Rust) and `quickjs/native/` (C) install the same
 * `__forgegraal_native` surface, so `native-modules.js` runs unchanged on either; this checks
 * they really do agree rather than having drifted.
 *
 * Skipped unless a built backend is present, since neither is a build dependency:
 * FORGEGRAAL_RUNTIME / FORGEGRAAL_C point at one, or they are looked for where the build
 * scripts put them.
 */
function findBackends(): Array<{ name: string; bin: string }> {
	const candidates = [
		{
			name: "rust",
			bin: process.env.FORGEGRAAL_RUNTIME ?? join(process.cwd(), "runtime/target/release/forgegraal-runtime"),
		},
		{ name: "c", bin: process.env.FORGEGRAAL_C ?? "" },
	];
	return candidates.filter((entry) => entry.bin && existsSync(entry.bin));
}

const backends = findBackends();

test("the native backends agree on crypto, compression and TLS", {
	skip: backends.length ? false : "no native backend built",
}, () => {
	const selftest = join(process.cwd(), "quickjs/runtime/native-selftest.js");
	for (const backend of backends) {
		const run = spawnSync(backend.bin, [selftest], { encoding: "utf-8", timeout: 60_000 });
		const output = run.stdout;

		// Known vectors, so a backend that quietly computes something else is caught rather
		// than merely producing bytes.
		assert.match(
			output,
			/sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/,
			`${backend.name}: sha256 must match the known vector\n${output}${run.stderr}`
		);
		assert.match(
			output,
			/createHmac sha256\s+: f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8/,
			`${backend.name}: HMAC must match the RFC vector\n${output}`
		);
		assert.match(output, /zlib deflate\/inflate\s+: true/, `${backend.name}: zlib must round-trip\n${output}`);
		// The whole point of the native layer: a Node-shaped tls.connect() reaching Discord.
		assert.match(
			output,
			/tls\.connect status\s+: HTTP\/1\.1 200 OK/,
			`${backend.name}: TLS must work\n${output}${run.stderr}`
		);
	}
});

test("native-modules.js works against a synchronous or an asynchronous backend", () => {
	const source = readFileSync(join(process.cwd(), "quickjs/runtime/native-modules.js"), "utf-8");
	// The Rust host's socket calls return promises; the C host's return values directly. Every
	// call is wrapped so the code above is written once, which is what keeps the two in step.
	assert.ok(source.includes("const settled ="), "a promise/value adapter must exist");
	assert.ok(
		!/native\.(write|close|connect|read)\([^)]*\)\.(then|catch)\(/.test(source),
		"native calls must go through it"
	);
});

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ALL_TARGETS,
	BunTargetRestrictionError,
	InvalidPackageManagerError,
	InvalidTargetError,
	is32BitOrLegacy,
	PolicyEnforcer,
	parseTargetDevice,
	TARGET_METADATA_MAP,
	TargetDevice,
} from "../dist/index.js";

test("Bun projects may build 32-bit and legacy Windows targets", () => {
	for (const target of [
		TargetDevice.IosIshX86,
		TargetDevice.WinLegacyX86,
		TargetDevice.WinLegacyX64,
		TargetDevice.LinuxX86,
		TargetDevice.WinX86,
		TargetDevice.LinuxArmV7,
		TargetDevice.FreeBsdX86,
	]) {
		assert.equal(PolicyEnforcer.assertTargetAllowed(target, "bun"), target);
	}
});

test("Bun projects are blocked from modern 64-bit targets", () => {
	for (const target of ALL_TARGETS.filter((t) => !is32BitOrLegacy(t))) {
		assert.throws(
			() => PolicyEnforcer.assertTargetAllowed(target, "bun"),
			BunTargetRestrictionError,
		);
	}
});

test("NPM, PNPM and Yarn projects may build every target", () => {
	for (const pm of ["npm", "pnpm", "yarn"] as const) {
		assert.deepEqual(PolicyEnforcer.getAllowedTargets(pm), [...ALL_TARGETS]);
		for (const target of ALL_TARGETS) {
			assert.doesNotThrow(() => PolicyEnforcer.assertTargetAllowed(target, pm));
		}
	}
});

test("Unknown package managers cannot bypass the Bun policy", () => {
	assert.throws(
		() =>
			PolicyEnforcer.assertTargetAllowed(
				TargetDevice.LinuxModernX64,
				"bunx" as never,
			),
		InvalidPackageManagerError,
	);
	assert.throws(
		() => PolicyEnforcer.resolvePackageManager("foo"),
		InvalidPackageManagerError,
	);
	assert.equal(PolicyEnforcer.resolvePackageManager(" PNPM "), "pnpm");
});

test("Target parsing is case and whitespace insensitive", () => {
	assert.equal(
		parseTargetDevice(" WIN-LEGACY-X86 "),
		TargetDevice.WinLegacyX86,
	);
	assert.equal(parseTargetDevice("win-legacy"), null);
	assert.equal(parseTargetDevice(undefined), null);
	assert.throws(
		() => PolicyEnforcer.assertTargetAllowed("nope", "npm"),
		InvalidTargetError,
	);
});

test("Package manager detection prefers the project's declaration and lockfiles", () => {
	const dir = mkdtempSync(join(tmpdir(), "forgegraal-pm-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
	writeFileSync(join(dir, "bun.lock"), "");
	assert.equal(PolicyEnforcer.detectPackageManager(dir), "bun");

	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "x", packageManager: "yarn@4.1.0" }),
	);
	assert.equal(PolicyEnforcer.detectPackageManager(dir), "yarn");
});

test("Target metadata is internally consistent", () => {
	for (const target of ALL_TARGETS) {
		const meta = TARGET_METADATA_MAP[target];
		assert.equal(meta.id, target);
		assert.equal(meta.bits === 64, ["x64", "arm64"].includes(meta.arch));
		assert.equal(
			meta.binaryFormat.startsWith("elf") || meta.binaryFormat === "macho",
			meta.nodePlatform !== "win32",
		);
		if (meta.binaryFormat === "elf32" || meta.binaryFormat === "pe32")
			assert.equal(meta.bits, 32);
		assert.equal(
			meta.is32BitOrLegacy,
			meta.bits === 32 || meta.os === "windows-legacy",
		);
	}
});

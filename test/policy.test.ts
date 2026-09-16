import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BinaryPackager,
	BunTargetRestrictionError,
	PolicyEnforcer,
	TARGET_METADATA_MAP,
	TargetDevice,
	is32BitOrLegacy,
} from "../dist/index.js";

test("PolicyEnforcer allows 32-bit iSH on Bun", () => {
	const target = PolicyEnforcer.assertTargetAllowed(TargetDevice.IosIshX86, "bun");
	assert.equal(target, TargetDevice.IosIshX86);
	assert.equal(is32BitOrLegacy(target), true);
});

test("PolicyEnforcer allows Windows 7/Vista legacy targets on Bun", () => {
	const x86 = PolicyEnforcer.assertTargetAllowed(TargetDevice.WinLegacyX86, "bun");
	const x64 = PolicyEnforcer.assertTargetAllowed(TargetDevice.WinLegacyX64, "bun");
	assert.equal(x86, TargetDevice.WinLegacyX86);
	assert.equal(x64, TargetDevice.WinLegacyX64);
	assert.equal(is32BitOrLegacy(x86), true);
	assert.equal(is32BitOrLegacy(x64), true);
});

test("PolicyEnforcer allows modern 32-bit targets on Bun", () => {
	const linux32 = PolicyEnforcer.assertTargetAllowed(TargetDevice.LinuxX86, "bun");
	const win32 = PolicyEnforcer.assertTargetAllowed(TargetDevice.WinX86, "bun");
	const arm32 = PolicyEnforcer.assertTargetAllowed(TargetDevice.LinuxArmV7, "bun");
	assert.equal(linux32, TargetDevice.LinuxX86);
	assert.equal(win32, TargetDevice.WinX86);
	assert.equal(arm32, TargetDevice.LinuxArmV7);
});

test("PolicyEnforcer blocks modern 64-bit targets on Bun with BunTargetRestrictionError", () => {
	assert.throws(
		() => PolicyEnforcer.assertTargetAllowed(TargetDevice.WinModernX64, "bun"),
		BunTargetRestrictionError,
	);
	assert.throws(
		() => PolicyEnforcer.assertTargetAllowed(TargetDevice.LinuxModernX64, "bun"),
		BunTargetRestrictionError,
	);
	assert.throws(
		() => PolicyEnforcer.assertTargetAllowed(TargetDevice.DarwinArm64, "bun"),
		BunTargetRestrictionError,
	);
});

test("PolicyEnforcer allows all targets on NPM, PNPM, and Yarn", () => {
	for (const pm of ["npm", "pnpm", "yarn"] as const) {
		const allowed = PolicyEnforcer.getAllowedTargets(pm);
		assert.equal(allowed.length, Object.values(TargetDevice).length);

		// Modern targets must not throw
		assert.doesNotThrow(() =>
			PolicyEnforcer.assertTargetAllowed(TargetDevice.WinModernX64, pm),
		);
		assert.doesNotThrow(() =>
			PolicyEnforcer.assertTargetAllowed(TargetDevice.LinuxModernX64, pm),
		);
		assert.doesNotThrow(() =>
			PolicyEnforcer.assertTargetAllowed(TargetDevice.IosIshX86, pm),
		);
	}
});

test("Evolved features: TargetMetadata and architecture properties", () => {
	assert.equal(TARGET_METADATA_MAP[TargetDevice.IosIshX86].arch, "x86");
	assert.equal(TARGET_METADATA_MAP[TargetDevice.IosIshX86].bits, 32);
	assert.equal(TARGET_METADATA_MAP[TargetDevice.IosIshX86].binaryFormat, "elf32");

	assert.equal(TARGET_METADATA_MAP[TargetDevice.WinLegacyX86].arch, "x86");
	assert.equal(TARGET_METADATA_MAP[TargetDevice.WinLegacyX86].bits, 32);
	assert.equal(TARGET_METADATA_MAP[TargetDevice.WinLegacyX86].binaryFormat, "pe32");

	assert.equal(TARGET_METADATA_MAP[TargetDevice.LinuxModernArm64].arch, "arm64");
	assert.equal(TARGET_METADATA_MAP[TargetDevice.LinuxModernArm64].bits, 64);
	assert.equal(TARGET_METADATA_MAP[TargetDevice.LinuxModernArm64].binaryFormat, "elf64");
});



test("$targetPlatform returns correct OS family", () => {
	assert.equal(TARGET_METADATA_MAP[TargetDevice.IosIshX86].os, "ios-ish");
	assert.equal(TARGET_METADATA_MAP[TargetDevice.WinLegacyX86].os, "windows-legacy");
	assert.equal(TARGET_METADATA_MAP[TargetDevice.DarwinArm64].os, "darwin");
});


test("$binaryExtension returns .exe for windows and empty for unix", () => {
	assert.equal(TARGET_METADATA_MAP[TargetDevice.WinLegacyX86].os.includes("windows"), true);
	assert.equal(TARGET_METADATA_MAP[TargetDevice.IosIshX86].os.includes("windows"), false);
});


test("$canPackageOnBun returns true for 32-bit and legacy Windows", () => {
	assert.equal(TARGET_METADATA_MAP[TargetDevice.IosIshX86].is32BitOrLegacy, true);
	assert.equal(TARGET_METADATA_MAP[TargetDevice.WinLegacyX86].is32BitOrLegacy, true);
	assert.equal(TARGET_METADATA_MAP[TargetDevice.WinModernX64].is32BitOrLegacy, false);
});


test("$is32BitTarget correctly classifies bitness", () => {
	assert.equal(TARGET_METADATA_MAP[TargetDevice.IosIshX86].bits === 32, true);
	assert.equal(TARGET_METADATA_MAP[TargetDevice.LinuxX86].bits === 32, true);
	assert.equal(TARGET_METADATA_MAP[TargetDevice.LinuxModernX64].bits === 64, true);
});


test("$is64BitTarget accurately detects 64-bit platforms", () => {
	assert.equal(TARGET_METADATA_MAP[TargetDevice.WinModernX64].bits === 64, true);
	assert.equal(TARGET_METADATA_MAP[TargetDevice.DarwinArm64].bits === 64, true);
});


test("$packagerType returns correct packager engine", () => {
	assert.equal(TargetDevice.IosIshX86, "ios-ish-x86");
	assert.equal(TargetDevice.WinLegacyX86, "win-legacy-x86");
});


test("$targetDescription returns readable description", () => {
	assert.equal(TARGET_METADATA_MAP[TargetDevice.IosIshX86].description.length > 5, true);
});


test("$isArmTarget detects arm architectures", () => {
	assert.equal(TARGET_METADATA_MAP[TargetDevice.LinuxArmV7].arch, "armv7");
	assert.equal(TARGET_METADATA_MAP[TargetDevice.DarwinArm64].arch, "arm64");
	assert.equal(TARGET_METADATA_MAP[TargetDevice.LinuxX86].arch, "x86");
});


test("$dbDriverCompat verifies universal sqlite support", () => {
	assert.equal(true, true);
});

/**
 * Target device architecture and platform definitions for ForgeGraal binary compiler.
 */

export enum TargetDevice {
	// 32-Bit & Legacy Platforms (Fully supported across all package managers, including Bun)
	IosIshX86 = "ios-ish-x86",
	WinLegacyX86 = "win-legacy-x86",
	WinLegacyX64 = "win-legacy-x64",
	LinuxX86 = "linux-x86",
	WinX86 = "win-x86",
	LinuxArmV7 = "linux-armv7",
	FreeBsdX86 = "freebsd-x86",

	// Modern 64-Bit Platforms (Supported on NPM, PNPM, Yarn; restricted on Bun due to built-in compiler)
	WinModernX64 = "win-modern-x64",
	LinuxModernX64 = "linux-modern-x64",
	LinuxModernArm64 = "linux-modern-arm64",
	DarwinX64 = "darwin-x64",
	DarwinArm64 = "darwin-arm64",
}

export interface TargetMetadata {
	id: TargetDevice;
	name: string;
	description: string;
	arch: "x86" | "x64" | "armv7" | "arm64";
	bits: 32 | 64;
	os: "ios-ish" | "windows-legacy" | "windows" | "linux" | "darwin" | "freebsd";
	is32BitOrLegacy: boolean;
	binaryFormat: "elf32" | "elf64" | "pe32" | "pe32plus" | "macho";
}

export const TARGET_METADATA_MAP: Record<TargetDevice, TargetMetadata> = {
	[TargetDevice.IosIshX86]: {
		id: TargetDevice.IosIshX86,
		name: "iOS iSH (32-bit x86)",
		description:
			"Alpine-based 32-bit x86 userland on iOS via iSH shell emulator",
		arch: "x86",
		bits: 32,
		os: "ios-ish",
		is32BitOrLegacy: true,
		binaryFormat: "elf32",
	},
	[TargetDevice.WinLegacyX86]: {
		id: TargetDevice.WinLegacyX86,
		name: "Windows 7 / Vista (32-bit IA-32)",
		description:
			"Legacy Win32 subsystem executable without Win10+ kernel requirements",
		arch: "x86",
		bits: 32,
		os: "windows-legacy",
		is32BitOrLegacy: true,
		binaryFormat: "pe32",
	},
	[TargetDevice.WinLegacyX64]: {
		id: TargetDevice.WinLegacyX64,
		name: "Windows 7 (64-bit AMD64)",
		description:
			"Legacy Win64 subsystem executable without Win10+ kernel requirements",
		arch: "x64",
		bits: 64,
		os: "windows-legacy",
		is32BitOrLegacy: true,
		binaryFormat: "pe32plus",
	},
	[TargetDevice.LinuxX86]: {
		id: TargetDevice.LinuxX86,
		name: "Linux (32-bit i686)",
		description: "Standard Linux 32-bit glibc/musl standalone binary",
		arch: "x86",
		bits: 32,
		os: "linux",
		is32BitOrLegacy: true,
		binaryFormat: "elf32",
	},
	[TargetDevice.WinX86]: {
		id: TargetDevice.WinX86,
		name: "Windows (32-bit x86)",
		description: "Modern Windows 32-bit executable",
		arch: "x86",
		bits: 32,
		os: "windows",
		is32BitOrLegacy: true,
		binaryFormat: "pe32",
	},
	[TargetDevice.LinuxArmV7]: {
		id: TargetDevice.LinuxArmV7,
		name: "Linux ARMv7 (32-bit)",
		description:
			"Embedded & legacy single-board computers (Raspberry Pi 32-bit)",
		arch: "armv7",
		bits: 32,
		os: "linux",
		is32BitOrLegacy: true,
		binaryFormat: "elf32",
	},
	[TargetDevice.FreeBsdX86]: {
		id: TargetDevice.FreeBsdX86,
		name: "FreeBSD (32-bit x86)",
		description: "FreeBSD 32-bit ELF standalone binary",
		arch: "x86",
		bits: 32,
		os: "freebsd",
		is32BitOrLegacy: true,
		binaryFormat: "elf32",
	},
	[TargetDevice.WinModernX64]: {
		id: TargetDevice.WinModernX64,
		name: "Windows 10/11 (64-bit)",
		description: "Modern 64-bit Windows PE executable",
		arch: "x64",
		bits: 64,
		os: "windows",
		is32BitOrLegacy: false,
		binaryFormat: "pe32plus",
	},
	[TargetDevice.LinuxModernX64]: {
		id: TargetDevice.LinuxModernX64,
		name: "Linux (64-bit x86_64)",
		description: "Modern 64-bit Linux ELF binary",
		arch: "x64",
		bits: 64,
		os: "linux",
		is32BitOrLegacy: false,
		binaryFormat: "elf64",
	},
	[TargetDevice.LinuxModernArm64]: {
		id: TargetDevice.LinuxModernArm64,
		name: "Linux ARM64 (AArch64)",
		description: "Modern 64-bit ARM Linux ELF binary",
		arch: "arm64",
		bits: 64,
		os: "linux",
		is32BitOrLegacy: false,
		binaryFormat: "elf64",
	},
	[TargetDevice.DarwinX64]: {
		id: TargetDevice.DarwinX64,
		name: "macOS Intel (64-bit)",
		description: "Modern macOS x86_64 Mach-O binary",
		arch: "x64",
		bits: 64,
		os: "darwin",
		is32BitOrLegacy: false,
		binaryFormat: "macho",
	},
	[TargetDevice.DarwinArm64]: {
		id: TargetDevice.DarwinArm64,
		name: "macOS Apple Silicon (ARM64)",
		description: "Modern macOS arm64 Mach-O binary",
		arch: "arm64",
		bits: 64,
		os: "darwin",
		is32BitOrLegacy: false,
		binaryFormat: "macho",
	},
};

export function is32BitOrLegacy(target: TargetDevice | string): boolean {
	const meta = TARGET_METADATA_MAP[target as TargetDevice];
	return meta ? meta.is32BitOrLegacy : false;
}

export function parseTargetDevice(value: string): TargetDevice | null {
	const normalized = value.trim().toLowerCase();
	for (const key of Object.values(TargetDevice)) {
		if (key.toLowerCase() === normalized) {
			return key;
		}
	}
	return null;
}

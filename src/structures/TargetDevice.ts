/**
 * Target device architecture and platform definitions for the ForgeGraal compiler.
 */

export enum TargetDevice {
	// 32-bit & legacy platforms (allowed for every package manager, including Bun)
	WinXpX86 = "win-xp-x86",
	IosIshX86 = "ios-ish-x86",
	WinLegacyX86 = "win-legacy-x86",
	WinLegacyX64 = "win-legacy-x64",
	LinuxX86 = "linux-x86",
	WinX86 = "win-x86",
	LinuxArmV7 = "linux-armv7",
	FreeBsdX86 = "freebsd-x86",

	// Modern 64-bit platforms (NPM, PNPM, Yarn only; Bun already ships `bun build --compile`)
	WinModernX64 = "win-modern-x64",
	LinuxModernX64 = "linux-modern-x64",
	LinuxModernArm64 = "linux-modern-arm64",
	DarwinX64 = "darwin-x64",
	DarwinArm64 = "darwin-arm64",
}

export type TargetArch = "x86" | "x64" | "armv7" | "arm64";
export type TargetOs = "ios-ish" | "windows-legacy" | "windows" | "linux" | "darwin" | "freebsd";
export type BinaryFormat = "elf32" | "elf64" | "pe32" | "pe32plus" | "macho";

export interface TargetMetadata {
	id: TargetDevice;
	name: string;
	description: string;
	arch: TargetArch;
	bits: 32 | 64;
	os: TargetOs;
	is32BitOrLegacy: boolean;
	binaryFormat: BinaryFormat;
	/** `process.platform` of a host that can execute this target natively. */
	nodePlatform: NodeJS.Platform;
	/** `process.arch` of a host that can execute this target natively. */
	nodeArch: "ia32" | "x64" | "arm" | "arm64";
	/**
	 * Key used by https://nodejs.org/dist/index.json `files` for an official runtime,
	 * or `null` when no official modern Node.js build exists (a runtime must be supplied).
	 */
	officialNodeFile: string | null;
	/** Hint shown when the user must supply a Node.js runtime themselves. */
	runtimeHint: string;
}

const UNOFFICIAL_WIN_HINT =
	"Official Node.js builds no longer run on Windows 7 / Vista. Supply a compatible runtime with --node-binary (for example a community Windows 7 build of Node.js >= 20.12).";
const XP_WIN_HINT =
	"Windows XP (NT 5.1/5.2) requires a backported runtime (e.g. One-Core-API patched Node or community XP builds). Supply with --node-binary.";

export const TARGET_METADATA_MAP: Readonly<Record<TargetDevice, Readonly<TargetMetadata>>> = {
	[TargetDevice.WinXpX86]: {
		id: TargetDevice.WinXpX86,
		name: "Windows XP / Server 2003 (32-bit x86)",
		description: "Win32 console executable for NT 5.1 / 5.2 compatible with Windows XP",
		arch: "x86",
		bits: 32,
		os: "windows-legacy",
		is32BitOrLegacy: true,
		binaryFormat: "pe32",
		nodePlatform: "win32",
		nodeArch: "ia32",
		officialNodeFile: null,
		runtimeHint: XP_WIN_HINT,
	},
	[TargetDevice.IosIshX86]: {
		id: TargetDevice.IosIshX86,
		name: "iOS iSH (32-bit x86)",
		description: "Alpine Linux (musl, i686) userland running inside the iSH emulator on iOS",
		arch: "x86",
		bits: 32,
		os: "ios-ish",
		is32BitOrLegacy: true,
		binaryFormat: "elf32",
		nodePlatform: "linux",
		nodeArch: "ia32",
		officialNodeFile: null,
		runtimeHint: "Inside iSH run `apk add nodejs`, or pass the Alpine x86 node binary with --node-binary.",
	},
	[TargetDevice.WinLegacyX86]: {
		id: TargetDevice.WinLegacyX86,
		name: "Windows 7 / Vista (32-bit x86)",
		description: "Win32 console executable for NT 6.0 / 6.1 without Windows 8+ API requirements",
		arch: "x86",
		bits: 32,
		os: "windows-legacy",
		is32BitOrLegacy: true,
		binaryFormat: "pe32",
		nodePlatform: "win32",
		nodeArch: "ia32",
		officialNodeFile: null,
		runtimeHint: UNOFFICIAL_WIN_HINT,
	},
	[TargetDevice.WinLegacyX64]: {
		id: TargetDevice.WinLegacyX64,
		name: "Windows 7 / Vista (64-bit x64)",
		description: "Win64 console executable for NT 6.0 / 6.1 without Windows 8+ API requirements",
		arch: "x64",
		bits: 64,
		os: "windows-legacy",
		is32BitOrLegacy: true,
		binaryFormat: "pe32plus",
		nodePlatform: "win32",
		nodeArch: "x64",
		officialNodeFile: null,
		runtimeHint: UNOFFICIAL_WIN_HINT,
	},
	[TargetDevice.LinuxX86]: {
		id: TargetDevice.LinuxX86,
		name: "Linux (32-bit i686)",
		description: "32-bit x86 Linux (glibc or musl)",
		arch: "x86",
		bits: 32,
		os: "linux",
		is32BitOrLegacy: true,
		binaryFormat: "elf32",
		nodePlatform: "linux",
		nodeArch: "ia32",
		officialNodeFile: null,
		runtimeHint: "No official 32-bit Linux Node.js exists; install it from your distribution or pass --node-binary.",
	},
	[TargetDevice.WinX86]: {
		id: TargetDevice.WinX86,
		name: "Windows 10/11 (32-bit x86)",
		description: "32-bit Windows console executable",
		arch: "x86",
		bits: 32,
		os: "windows",
		is32BitOrLegacy: true,
		binaryFormat: "pe32",
		nodePlatform: "win32",
		nodeArch: "ia32",
		officialNodeFile: "win-x86-exe",
		runtimeHint: "Official win-x86 builds exist up to Node.js 22.",
	},
	[TargetDevice.LinuxArmV7]: {
		id: TargetDevice.LinuxArmV7,
		name: "Linux ARMv7 (32-bit)",
		description: "32-bit ARM single-board computers (e.g. Raspberry Pi OS 32-bit)",
		arch: "armv7",
		bits: 32,
		os: "linux",
		is32BitOrLegacy: true,
		binaryFormat: "elf32",
		nodePlatform: "linux",
		nodeArch: "arm",
		officialNodeFile: "linux-armv7l",
		runtimeHint: "Official linux-armv7l builds are downloaded automatically.",
	},
	[TargetDevice.FreeBsdX86]: {
		id: TargetDevice.FreeBsdX86,
		name: "FreeBSD (32-bit x86)",
		description: "32-bit x86 FreeBSD",
		arch: "x86",
		bits: 32,
		os: "freebsd",
		is32BitOrLegacy: true,
		binaryFormat: "elf32",
		nodePlatform: "freebsd",
		nodeArch: "ia32",
		officialNodeFile: null,
		runtimeHint: "No official FreeBSD Node.js exists; install `pkg install node` or pass --node-binary.",
	},
	[TargetDevice.WinModernX64]: {
		id: TargetDevice.WinModernX64,
		name: "Windows 10/11 (64-bit x64)",
		description: "64-bit Windows console executable",
		arch: "x64",
		bits: 64,
		os: "windows",
		is32BitOrLegacy: false,
		binaryFormat: "pe32plus",
		nodePlatform: "win32",
		nodeArch: "x64",
		officialNodeFile: "win-x64-exe",
		runtimeHint: "Official win-x64 builds are downloaded automatically.",
	},
	[TargetDevice.LinuxModernX64]: {
		id: TargetDevice.LinuxModernX64,
		name: "Linux (64-bit x86_64)",
		description: "64-bit x86_64 Linux (glibc)",
		arch: "x64",
		bits: 64,
		os: "linux",
		is32BitOrLegacy: false,
		binaryFormat: "elf64",
		nodePlatform: "linux",
		nodeArch: "x64",
		officialNodeFile: "linux-x64",
		runtimeHint: "Official linux-x64 builds are downloaded automatically.",
	},
	[TargetDevice.LinuxModernArm64]: {
		id: TargetDevice.LinuxModernArm64,
		name: "Linux ARM64 (AArch64)",
		description: "64-bit ARM Linux (glibc)",
		arch: "arm64",
		bits: 64,
		os: "linux",
		is32BitOrLegacy: false,
		binaryFormat: "elf64",
		nodePlatform: "linux",
		nodeArch: "arm64",
		officialNodeFile: "linux-arm64",
		runtimeHint: "Official linux-arm64 builds are downloaded automatically.",
	},
	[TargetDevice.DarwinX64]: {
		id: TargetDevice.DarwinX64,
		name: "macOS Intel (64-bit)",
		description: "x86_64 Mach-O executable (requires code signing on macOS)",
		arch: "x64",
		bits: 64,
		os: "darwin",
		is32BitOrLegacy: false,
		binaryFormat: "macho",
		nodePlatform: "darwin",
		nodeArch: "x64",
		officialNodeFile: "osx-x64-tar",
		runtimeHint: "Official darwin-x64 builds are downloaded automatically.",
	},
	[TargetDevice.DarwinArm64]: {
		id: TargetDevice.DarwinArm64,
		name: "macOS Apple Silicon (ARM64)",
		description: "arm64 Mach-O executable (requires code signing on macOS)",
		arch: "arm64",
		bits: 64,
		os: "darwin",
		is32BitOrLegacy: false,
		binaryFormat: "macho",
		nodePlatform: "darwin",
		nodeArch: "arm64",
		officialNodeFile: "osx-arm64-tar",
		runtimeHint: "Official darwin-arm64 builds are downloaded automatically.",
	},
};

export const ALL_TARGETS: readonly TargetDevice[] = Object.values(TargetDevice);

/**
 * Normalizes user input (case / surrounding whitespace) into a known target, or `null`.
 */
export function parseTargetDevice(value: unknown): TargetDevice | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return (ALL_TARGETS as readonly string[]).includes(normalized) ? (normalized as TargetDevice) : null;
}

export function getTargetMetadata(value: unknown): TargetMetadata | null {
	const target = parseTargetDevice(value);
	return target ? TARGET_METADATA_MAP[target] : null;
}

export function is32BitOrLegacy(target: unknown): boolean {
	return getTargetMetadata(target)?.is32BitOrLegacy ?? false;
}

export function isWindowsTarget(target: unknown): boolean {
	const meta = getTargetMetadata(target);
	return meta !== null && meta.nodePlatform === "win32";
}

export function executableExtension(target: unknown): string {
	return isWindowsTarget(target) ? ".exe" : "";
}

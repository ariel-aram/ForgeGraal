"use strict";
/**
 * Target device architecture and platform definitions for the ForgeGraal compiler.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_TARGETS = exports.TARGET_METADATA_MAP = exports.TargetDevice = void 0;
exports.parseTargetDevice = parseTargetDevice;
exports.getTargetMetadata = getTargetMetadata;
exports.is32BitOrLegacy = is32BitOrLegacy;
exports.isWindowsTarget = isWindowsTarget;
exports.executableExtension = executableExtension;
var TargetDevice;
(function (TargetDevice) {
    // 32-bit & legacy platforms (allowed for every package manager, including Bun)
    TargetDevice["WinXpX86"] = "win-xp-x86";
    TargetDevice["IosIshX86"] = "ios-ish-x86";
    TargetDevice["WinLegacyX86"] = "win-legacy-x86";
    TargetDevice["WinLegacyX64"] = "win-legacy-x64";
    TargetDevice["LinuxX86"] = "linux-x86";
    TargetDevice["WinX86"] = "win-x86";
    TargetDevice["LinuxArmV7"] = "linux-armv7";
    TargetDevice["FreeBsdX86"] = "freebsd-x86";
    // Modern 64-bit platforms (NPM, PNPM, Yarn only; Bun already ships `bun build --compile`)
    TargetDevice["WinModernX64"] = "win-modern-x64";
    TargetDevice["LinuxModernX64"] = "linux-modern-x64";
    TargetDevice["LinuxModernArm64"] = "linux-modern-arm64";
    TargetDevice["DarwinX64"] = "darwin-x64";
    TargetDevice["DarwinArm64"] = "darwin-arm64";
})(TargetDevice || (exports.TargetDevice = TargetDevice = {}));
const UNOFFICIAL_WIN_HINT = "Official Node.js builds no longer run on Windows 7 / Vista. Supply a compatible runtime with --node-binary (for example a community Windows 7 build of Node.js >= 20.12).";
const XP_WIN_HINT = "Windows XP (NT 5.1/5.2) requires a backported runtime (e.g. One-Core-API patched Node or community XP builds). Supply with --node-binary.";
exports.TARGET_METADATA_MAP = {
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
exports.ALL_TARGETS = Object.values(TargetDevice);
/**
 * Normalizes user input (case / surrounding whitespace) into a known target, or `null`.
 */
function parseTargetDevice(value) {
    if (typeof value !== "string")
        return null;
    const normalized = value.trim().toLowerCase();
    return exports.ALL_TARGETS.includes(normalized)
        ? normalized
        : null;
}
function getTargetMetadata(value) {
    const target = parseTargetDevice(value);
    return target ? exports.TARGET_METADATA_MAP[target] : null;
}
function is32BitOrLegacy(target) {
    return getTargetMetadata(target)?.is32BitOrLegacy ?? false;
}
function isWindowsTarget(target) {
    const meta = getTargetMetadata(target);
    return meta !== null && meta.nodePlatform === "win32";
}
function executableExtension(target) {
    return isWindowsTarget(target) ? ".exe" : "";
}
//# sourceMappingURL=TargetDevice.js.map
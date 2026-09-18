/**
 * Target device architecture and platform definitions for the ForgeGraal compiler.
 */
export declare enum TargetDevice {
    WinXpX86 = "win-xp-x86",
    IosIshX86 = "ios-ish-x86",
    WinLegacyX86 = "win-legacy-x86",
    WinLegacyX64 = "win-legacy-x64",
    LinuxX86 = "linux-x86",
    WinX86 = "win-x86",
    LinuxArmV7 = "linux-armv7",
    FreeBsdX86 = "freebsd-x86",
    WinModernX64 = "win-modern-x64",
    LinuxModernX64 = "linux-modern-x64",
    LinuxModernArm64 = "linux-modern-arm64",
    DarwinX64 = "darwin-x64",
    DarwinArm64 = "darwin-arm64"
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
export declare const TARGET_METADATA_MAP: Readonly<Record<TargetDevice, Readonly<TargetMetadata>>>;
export declare const ALL_TARGETS: readonly TargetDevice[];
/**
 * Normalizes user input (case / surrounding whitespace) into a known target, or `null`.
 */
export declare function parseTargetDevice(value: unknown): TargetDevice | null;
export declare function getTargetMetadata(value: unknown): TargetMetadata | null;
export declare function is32BitOrLegacy(target: unknown): boolean;
export declare function isWindowsTarget(target: unknown): boolean;
export declare function executableExtension(target: unknown): string;
//# sourceMappingURL=TargetDevice.d.ts.map
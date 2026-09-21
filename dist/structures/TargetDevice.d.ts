/**
 * Target device architecture and platform definitions for the Graak compiler.
 */
export declare enum TargetDevice {
    WinXpX86 = "win-xp-x86",
    IosIshX86 = "ios-ish-x86",
    WinVistaX86 = "win-vista-x86",
    WinVistaX64 = "win-vista-x64",
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
     * Key used by https://nodejs.org/dist/index.json `files` for the *current* official
     * runtime, or `null` when no current official build targets this platform (a runtime
     * must be supplied, or see `pinnedLegacyNode`).
     */
    officialNodeFile: string | null;
    /**
     * A specific, old official Node.js release verified to still run on this target, used
     * when `officialNodeFile` is null. Distinct from `officialNodeFile` because it names one
     * exact version rather than "whatever the newest matching release is" — Node's own
     * platform floor moved on, so there is no "newest" to auto-select from any more.
     */
    pinnedLegacyNode: PinnedLegacyNode | null;
    /**
     * A package-manager command that installs Node.js on-device, run automatically by the
     * portable launcher when no runtime is bundled and none is found on PATH (e.g. iSH's own
     * `apk`, FreeBSD's own `pkg`). `null` when the target has no such on-device installer.
     */
    bootstrapInstall: BootstrapInstall | null;
    /** Hint shown when the user must supply a Node.js runtime themselves. */
    runtimeHint: string;
}
export interface PinnedLegacyNode {
    /** Exact version to fetch, not "newest available" — there is no newer compatible one. */
    version: string;
    /** nodejs.org/dist file key for this version, same convention as `officialNodeFile`. */
    fileKey: string;
    /** Printed as a build warning whenever this runtime is actually selected. */
    warning: string;
}
export interface BootstrapInstall {
    /** Command and args run on-device, e.g. `["apk", "add", "--no-cache", "nodejs"]`. */
    command: readonly string[];
    /** One-line description of what the command installs, shown before it runs. */
    description: string;
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
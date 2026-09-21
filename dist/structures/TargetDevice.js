"use strict";
/**
 * Target device architecture and platform definitions for the Graak compiler.
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
    TargetDevice["WinVistaX86"] = "win-vista-x86";
    TargetDevice["WinVistaX64"] = "win-vista-x64";
    TargetDevice["WinLegacyX86"] = "win-legacy-x86";
    TargetDevice["WinLegacyX64"] = "win-legacy-x64";
    TargetDevice["LinuxX86"] = "linux-x86";
    TargetDevice["WinX86"] = "win-x86";
    TargetDevice["LinuxArmV7"] = "linux-armv7";
    TargetDevice["FreeBsdX86"] = "freebsd-x86";
    // Modern 64-bit platforms. NPM, PNPM, Yarn and Bun projects can all be packaged for any of
    // these (see PolicyEnforcer.getAllowedTargets, and $canPackageOnBun for the separate,
    // advisory-only question of whether Bun's own `bun build --compile` could do the job itself).
    TargetDevice["WinModernX64"] = "win-modern-x64";
    TargetDevice["LinuxModernX64"] = "linux-modern-x64";
    TargetDevice["LinuxModernArm64"] = "linux-modern-arm64";
    TargetDevice["DarwinX64"] = "darwin-x64";
    TargetDevice["DarwinArm64"] = "darwin-arm64";
})(TargetDevice || (exports.TargetDevice = TargetDevice = {}));
const XP_WIN_HINT = "Windows XP (NT 5.1/5.2) requires a backported runtime (e.g. One-Core-API patched Node or community XP builds). Supply with --node-binary.";
/**
 * Node.js's own platform floor moved from "Windows 7/2008 R2" (Node <= 13) to "Windows
 * 8.1/2012 R2" (Node >= 14) — confirmed against BUILDING.md at both tags, which declares
 * Windows 7 Tier 1 identically at v12.22.12 and v13.14.0 (no documented distinction between
 * them). Community reports (real user hardware, not covered by Node's own CI matrix) describe
 * later 13.x/14.x builds crashing on genuine Windows 7 with missing ws2_32.dll entry points,
 * which BUILDING.md's Tier declaration does not catch since Node's CI runs on Server 2012 R2,
 * not real Windows 7. Pinned to v12.22.12, the version community guidance converges on as
 * actually launching there, rather than 13.14.0's higher but doc-unverified ceiling. Both are
 * still hosted with a valid SHASUMS256.txt on nodejs.org/dist and download/verify identically.
 *
 * That does not make current ForgeScript bots runnable on it either way. Verified directly: loading
 * @tryforge/forgescript on a real v13.14.0 raises `Unexpected token '.'` (optional chaining,
 * ES2020); with --harmony that parses, but @discordjs/util's compiled output then fails on
 * `??=` (nullish assignment, ES2021), which no V8 this old has under any flag. discord.js's
 * gateway/REST layer also depends on undici, which needs Node >= 18 at runtime (fetch, Web
 * Streams), independent of syntax. This is a ceiling in discord.js's own dependency chain,
 * not something a Node.js binary — official, unofficial, or hand-built — can be picked
 * around: no Node.js old enough to run on Windows 7 is new enough to parse it. v12.22.12 has
 * even less ES2020+ coverage than v13.14.0, so this loses nothing practical.
 *
 * This pin does NOT run on Vista at all — Node dropped Vista in v6.0.0, so this pin is
 * Windows 7-only. Vista gets its own, older pin below.
 */
const WIN7_PINNED_WARNING = "Using Node.js 12.22.12, the version community reports converge on as the last that actually launches " +
    "on real Windows 7 hardware (13.x/14.x are Tier 1 in Node's own docs, but that reflects Node's CI image " +
    "— Server 2012 R2 — not genuine Windows 7, and real-hardware reports describe later builds crashing on " +
    "missing ws2_32.dll entry points). This predates syntax current discord.js's own dependencies use " +
    "(@discordjs/util needs '??=', ES2021, which this runtime cannot parse under any flag) and undici's " +
    "runtime requirements (Node >= 18). A bot built on current discord.js will not start here.";
const WIN7_PINNED_NODE_X86 = {
    version: "12.22.12",
    fileKey: "win-x86-exe",
    warning: WIN7_PINNED_WARNING,
};
const WIN7_PINNED_NODE_X64 = {
    version: "12.22.12",
    fileKey: "win-x64-exe",
    warning: WIN7_PINNED_WARNING,
};
/**
 * Node.js dropped Windows Vista support in v6.0.0 (confirmed against the v6.0.0 release
 * notes); the last release still supporting Vista/XP-era Windows is v5.12.0, still hosted
 * with a valid SHASUMS256.txt. This is older than WIN7_PINNED_NODE above (12.22.12 won't even
 * launch on Vista, missing Windows APIs Node >= 6 requires), and far short of ES6: no
 * classes, no arrow functions under strict parsing in all cases, no destructuring in some
 * forms. A ForgeScript bot needs a build targeting this runtime specifically, not just a
 * modern one run through Babel, since installed dependencies (discord.js and its own deps)
 * are themselves far newer than this can parse.
 */
const VISTA_PINNED_WARNING = "Using Node.js 5.12.0, the last official release that still runs on Windows Vista (Node 6.0.0 dropped " +
    "Vista support entirely — versions between predate the Win32 APIs it requires and will not launch here " +
    "at all). This is pre-ES6: no classes, no let/const in some engines' strict paths, no async/await, no " +
    "template literals depended on by nearly every current npm package including discord.js and ForgeScript " +
    "itself. Only bots written specifically for this runtime, with no modern dependency in their chain, can " +
    "run here — a build against current discord.js will not start.";
const VISTA_PINNED_NODE_X86 = {
    version: "5.12.0",
    fileKey: "win-x86-exe",
    warning: VISTA_PINNED_WARNING,
};
const VISTA_PINNED_NODE_X64 = {
    version: "5.12.0",
    fileKey: "win-x64-exe",
    warning: VISTA_PINNED_WARNING,
};
const ISH_BOOTSTRAP = {
    command: ["apk", "add", "--no-cache", "nodejs"],
    description: "Alpine's own Node.js package",
};
const FREEBSD_BOOTSTRAP = {
    command: ["pkg", "install", "-y", "node"],
    description: "FreeBSD's own Node.js package",
};
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
        pinnedLegacyNode: null,
        bootstrapInstall: null,
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
        pinnedLegacyNode: null,
        bootstrapInstall: ISH_BOOTSTRAP,
        runtimeHint: "The executable installs Node.js on-device automatically on first run (`apk add --no-cache nodejs`) " +
            "if it is missing. Pass --node-binary to use a different build instead.",
    },
    [TargetDevice.WinVistaX86]: {
        id: TargetDevice.WinVistaX86,
        name: "Windows Vista (32-bit x86)",
        description: "Win32 console executable for NT 6.0 only — Node.js 6.0.0 dropped Vista, so this is a separate, older pin from Windows 7",
        arch: "x86",
        bits: 32,
        os: "windows-legacy",
        is32BitOrLegacy: true,
        binaryFormat: "pe32",
        nodePlatform: "win32",
        nodeArch: "ia32",
        officialNodeFile: null,
        pinnedLegacyNode: VISTA_PINNED_NODE_X86,
        bootstrapInstall: null,
        runtimeHint: "Node.js 5.12.0 (the last official release that runs on Vista at all) is downloaded and verified " +
            "automatically; see the build warning this produces — it is pre-ES6 and cannot run a bot built " +
            "against current discord.js or ForgeScript. Pass --node-binary for a different runtime instead.",
    },
    [TargetDevice.WinVistaX64]: {
        id: TargetDevice.WinVistaX64,
        name: "Windows Vista (64-bit x64)",
        description: "Win64 console executable for NT 6.0 only — Node.js 6.0.0 dropped Vista, so this is a separate, older pin from Windows 7",
        arch: "x64",
        bits: 64,
        os: "windows-legacy",
        is32BitOrLegacy: true,
        binaryFormat: "pe32plus",
        nodePlatform: "win32",
        nodeArch: "x64",
        officialNodeFile: null,
        pinnedLegacyNode: VISTA_PINNED_NODE_X64,
        bootstrapInstall: null,
        runtimeHint: "Node.js 5.12.0 (the last official release that runs on Vista at all) is downloaded and verified " +
            "automatically; see the build warning this produces — it is pre-ES6 and cannot run a bot built " +
            "against current discord.js or ForgeScript. Pass --node-binary for a different runtime instead.",
    },
    [TargetDevice.WinLegacyX86]: {
        id: TargetDevice.WinLegacyX86,
        name: "Windows 7 (32-bit x86)",
        description: "Win32 console executable for NT 6.1 without Windows 8+ API requirements",
        arch: "x86",
        bits: 32,
        os: "windows-legacy",
        is32BitOrLegacy: true,
        binaryFormat: "pe32",
        nodePlatform: "win32",
        nodeArch: "ia32",
        officialNodeFile: null,
        pinnedLegacyNode: WIN7_PINNED_NODE_X86,
        bootstrapInstall: null,
        runtimeHint: "Node.js 12.22.12 (community-reported as the version that actually launches on real Windows 7 " +
            "hardware) is downloaded and verified automatically; see the build warning this produces for why " +
            "current discord.js-based bots still won't run on it. Pass --node-binary for a newer runtime " +
            "instead. For Windows Vista use win-vista-x86 instead — this pin does not launch on Vista at all.",
    },
    [TargetDevice.WinLegacyX64]: {
        id: TargetDevice.WinLegacyX64,
        name: "Windows 7 (64-bit x64)",
        description: "Win64 console executable for NT 6.1 without Windows 8+ API requirements",
        arch: "x64",
        bits: 64,
        os: "windows-legacy",
        is32BitOrLegacy: true,
        binaryFormat: "pe32plus",
        nodePlatform: "win32",
        nodeArch: "x64",
        officialNodeFile: null,
        pinnedLegacyNode: WIN7_PINNED_NODE_X64,
        bootstrapInstall: null,
        runtimeHint: "Node.js 12.22.12 (community-reported as the version that actually launches on real Windows 7 " +
            "hardware) is downloaded and verified automatically; see the build warning this produces for why " +
            "current discord.js-based bots still won't run on it. Pass --node-binary for a newer runtime " +
            "instead. For Windows Vista use win-vista-x64 instead — this pin does not launch on Vista at all.",
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
        pinnedLegacyNode: null,
        bootstrapInstall: null,
        // Checked directly: unofficial-builds.nodejs.org's linux-x86 builds stop at v12.16.3
        // (~2020), already below ForgeScript's own floor (>=16.11.0) and further below
        // discord.js's (>=18). No auto-provisionable source is both real 32-bit x86 and new
        // enough to run the bot — this stays a manual target, not a UX gap to close.
        runtimeHint: "No Node.js runtime for 32-bit Linux is new enough to run current ForgeScript/discord.js bots " +
            "(the last community build, from unofficial-builds.nodejs.org, tops out at Node 12.16.3, below " +
            "ForgeScript's own >=16.11.0 floor). Install a distribution package if your distro ships one, or " +
            "pass --node-binary.",
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
        pinnedLegacyNode: null,
        bootstrapInstall: null,
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
        pinnedLegacyNode: null,
        bootstrapInstall: null,
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
        pinnedLegacyNode: null,
        bootstrapInstall: FREEBSD_BOOTSTRAP,
        runtimeHint: "The executable installs Node.js on-device automatically on first run (`pkg install -y node`) " +
            "if it is missing. Pass --node-binary to use a different build instead.",
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
        pinnedLegacyNode: null,
        bootstrapInstall: null,
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
        pinnedLegacyNode: null,
        bootstrapInstall: null,
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
        pinnedLegacyNode: null,
        bootstrapInstall: null,
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
        pinnedLegacyNode: null,
        bootstrapInstall: null,
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
        pinnedLegacyNode: null,
        bootstrapInstall: null,
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
    return exports.ALL_TARGETS.includes(normalized) ? normalized : null;
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
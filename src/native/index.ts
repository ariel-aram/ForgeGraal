import binaryArchitecture from "./binaryArchitecture.js";
import binaryFormat from "./binaryFormat.js";
import compileBinary from "./compileBinary.js";
import graalVersion from "./graalVersion.js";
import is32BitOrLegacy from "./is32BitOrLegacy.js";
import isIsh from "./isIsh.js";
import isLegacyWindows from "./isLegacyWindows.js";
import isTargetSupported from "./isTargetSupported.js";
import packageManager from "./packageManager.js";
import supportedTargets from "./supportedTargets.js";
import targetBits from "./targetBits.js";

export const nativeFunctions = [
	graalVersion,
	binaryFormat,
	isLegacyWindows,
	isIsh,
	targetBits,
	binaryArchitecture,
	compileBinary,
	supportedTargets,
	packageManager,
	isTargetSupported,
	is32BitOrLegacy,
];

export {
	binaryArchitecture,
	binaryFormat,
	compileBinary,
	graalVersion,
	is32BitOrLegacy as is32BitOrLegacyFn,
	isIsh,
	isLegacyWindows,
	isTargetSupported,
	packageManager,
	supportedTargets,
	targetBits,
};

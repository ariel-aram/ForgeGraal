export * from "./compiler";
export * from "./integrations";
export * from "./runtime/bunCompat";
export * from "./runtime/launcher";
export * from "./runtime/legacyPolyfills";
export * from "./runtime/nativeShim";
export * from "./structures";

export const VERSION: string = require("../package.json").version;

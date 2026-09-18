"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WASM_FALLBACKS_SOURCE = exports.UNSUBSTITUTABLE_NATIVE = exports.OPTIONAL_ACCELERATORS = exports.createNativeShimSource = void 0;
/**
 * @deprecated Renamed to `./nativeShim`.
 *
 * The original "universal WebAssembly layer" contained no WebAssembly: it answered every
 * failed native addon load with a stub. Several of those stubs silently broke the bot —
 * discarded SQLite writes, empty canvas images, unsalted SHA-256 in place of bcrypt, and
 * ChaCha20-Poly1305 standing in for XChaCha20-Poly1305 (a different algorithm). The shim now
 * substitutes only replacements that behave like the real addon, and reports the rest.
 */
var nativeShim_1 = require("./nativeShim");
Object.defineProperty(exports, "createNativeShimSource", { enumerable: true, get: function () { return nativeShim_1.createNativeShimSource; } });
Object.defineProperty(exports, "OPTIONAL_ACCELERATORS", { enumerable: true, get: function () { return nativeShim_1.OPTIONAL_ACCELERATORS; } });
Object.defineProperty(exports, "UNSUBSTITUTABLE_NATIVE", { enumerable: true, get: function () { return nativeShim_1.UNSUBSTITUTABLE_NATIVE; } });
Object.defineProperty(exports, "WASM_FALLBACKS_SOURCE", { enumerable: true, get: function () { return nativeShim_1.WASM_FALLBACKS_SOURCE; } });
//# sourceMappingURL=wasmPolyfills.js.map
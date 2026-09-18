/**
 * @deprecated Renamed to `./nativeShim`.
 *
 * The original "universal WebAssembly layer" contained no WebAssembly: it answered every
 * failed native addon load with a stub. Several of those stubs silently broke the bot —
 * discarded SQLite writes, empty canvas images, unsalted SHA-256 in place of bcrypt, and
 * ChaCha20-Poly1305 standing in for XChaCha20-Poly1305 (a different algorithm). The shim now
 * substitutes only replacements that behave like the real addon, and reports the rest.
 */
export { createNativeShimSource, type NativeShimConfig, OPTIONAL_ACCELERATORS, UNSUBSTITUTABLE_NATIVE, WASM_FALLBACKS_SOURCE, } from "./nativeShim";
//# sourceMappingURL=wasmPolyfills.d.ts.map
/**
 * Runtime polyfills injected into builds for targets pinned to an old Node.js.
 *
 * `LegacyTranspiler` rewrites bundled *syntax* down to what the target can parse. That is only
 * half the gap: current discord.js and its dependencies also call APIs that did not exist yet.
 * On the Windows 7 pin (Node.js 12.22.12) the missing surface was measured directly against the
 * real runtime rather than guessed, and is what this file fills in.
 *
 * Three rules shaped what is here, all of them learned by watching the real thing break:
 *
 * 1. **A wrong polyfill is worse than a missing one.** `structuredClone` was first written as a
 *    JSON round-trip. web-streams-polyfill probes for `structuredClone` to implement the spec's
 *    TransferArrayBuffer step, took that branch, and every byte-stream chunk came back detached:
 *    HTTP 200 responses with a zero-length body. Without the fake it would have used its own safe
 *    fallback. It is implemented over `v8.serialize` here, which really does clone binary data.
 * 2. **What cannot be done correctly must fail loudly.** `Intl.Segmenter` needs ICU segmentation
 *    tables; approximating it would mis-split emoji and combining marks while looking like it
 *    worked. Its constructor exists (ForgeScript builds one at module scope, so the library will
 *    not even load otherwise) but using it throws an explanation.
 * 3. **It must parse on the target.** This source is ES5: no `let`, arrow functions, template
 *    literals or classes, so the runtime reaches the polyfills instead of a SyntaxError.
 */
export interface LegacyPolyfillConfig {
    /** Target id, used in diagnostics. */
    target: string;
    /** esbuild target string for runtime-generated code, e.g. `node12`. */
    jsTarget: string;
    /** Archive-relative directory holding the bundled polyfill file and esbuild-wasm. */
    assetDir: string;
    /**
     * Install the `Function` constructor patch. Ahead-of-time transpiling cannot reach source
     * that is built at runtime, and ForgeScript's compiler does exactly that: it generates
     * `return ` + a template literal containing `??` and hands it to `new Function`. The syntax
     * only exists once the target compiles it, so the lowering has to happen there too.
     */
    runtimeCodegen: boolean;
}
/** Bundled polyfill implementations, and the globals each one provides. */
export declare const POLYFILL_PACKAGES: readonly ["web-streams-polyfill", "abort-controller", "event-target-shim", "formdata-node"];
export declare function createLegacyPolyfillSource(config: LegacyPolyfillConfig): string;
//# sourceMappingURL=legacyPolyfills.d.ts.map
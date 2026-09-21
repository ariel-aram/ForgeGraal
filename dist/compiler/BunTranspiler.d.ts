/**
 * Extensions Bun bots are commonly authored in that plain Node.js cannot `require()`
 * directly. Graak transpiles these with `bun build` when the project's package manager
 * is Bun, instead of asking the user to pre-build — Bun projects are frequently run straight
 * from `.ts` with no separate build step, unlike npm/pnpm/yarn projects.
 */
export declare const BUN_TRANSPILABLE_EXTENSIONS: Set<string>;
export interface BunTranspileResult {
    /** Path to the transpiled CommonJS entrypoint, written next to the original file. */
    entrypoint: string;
    /** Removes the transpiled file. Safe to call more than once. */
    cleanup: () => void;
}
export declare class BunTranspiler {
    static isAvailable(): boolean;
    /**
     * Transpiles a Bun-authored entrypoint into plain CommonJS with `bun build`. Local,
     * relative imports are bundled into the single output file; bare package imports
     * (`require("discord.js")`) are kept as `--packages=external` so Graak's own
     * dependency walk resolves them from the real, installed `node_modules` afterward rather
     * than from a bundler's copy — the same packages the project's lockfile pinned.
     *
     * The output is written next to the source file (not a temp directory), because
     * `ProjectCollector.findProjectRoot` walks up from the entrypoint's directory to find
     * `package.json`, and the file must be inside the project tree to be collected.
     */
    static transpile(entrypoint: string): BunTranspileResult;
}
//# sourceMappingURL=BunTranspiler.d.ts.map
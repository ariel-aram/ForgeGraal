import type { ArchiveEntry } from "./Archive";
export interface LegacyTranspileOptions {
    /**
     * esbuild target for the runtime that will run this build, e.g. `node12`. Derived from the
     * pinned runtime version rather than the target id, so it stays right if the pin moves.
     */
    jsTarget: string;
    onLog?: (message: string) => void;
}
export interface LegacyTranspileResult {
    entries: ArchiveEntry[];
    /** Files whose emitted form differed from the original and were replaced. */
    rewritten: number;
    /** Files that were ES modules and are now CommonJS. */
    esmConverted: number;
    /** Packages whose `"type": "module"` declaration was removed. */
    manifestsRewritten: number;
    /**
     * Files esbuild could not parse. These keep their original contents: packages do ship
     * unparseable files (editor backups under `.history/`, fixtures) that are never loaded, and
     * failing the whole build over one of them would be wrong. If such a file really is loaded,
     * the runtime reports its own syntax error, pointing at the actual file.
     */
    failures: string[];
}
export declare class LegacyTranspiler {
    /**
     * Maps every directory in the archive to the module format its nearest `package.json`
     * declares. Resolved from the archive's own entries rather than from disk, so it is correct
     * for generated, in-memory files too.
     *
     * This has to be resolved rather than assumed. Emitting CommonJS into a package that
     * declares `"type": "module"` rewrites its `import`/`export` into `require`/`exports`, and
     * Node then loads those files as ES modules and rejects them.
     */
    private static packageTypes;
    private static formatFor;
    /**
     * Rewrites every JavaScript entry for `jsTarget`, converting ES modules to CommonJS on the
     * way. The conversion is not optional: `require()` of an ES module only works on Node.js
     * 20.19+/22.12+, and ForgeScript itself `require()`s chalk, which is published as pure ESM.
     */
    static transpile(entries: readonly ArchiveEntry[], options: LegacyTranspileOptions): Promise<LegacyTranspileResult>;
    /**
     * A module that awaits at its top level becomes the body of an async function. Its imports become require() calls
     * (through esbuild's own interop, so default and namespace imports mean what they do in a converted module) and
     * its exports are assigned once it has finished. The program's entry point is the case that matters: it runs to
     * completion. A module that another one requires sees its exports only after its own awaits are done.
     */
    private static wrapTopLevelAwait;
    /**
     * What the native host needs: ES modules become CommonJS and TypeScript/JSX become JavaScript, and nothing else
     * changes. The host's engine parses current syntax directly, so unlike {@link transpile} no downlevelling happens
     * (`target: esnext`), and a file that is already plain CommonJS is left alone without being parsed at all.
     *
     * This is what makes ES-module-only packages (chalk 5, nanoid 5, node-fetch 3, ...) and `.mjs` or TypeScript
     * programs run: the host loads CommonJS. TypeScript and JSX files are renamed to `.js`; the module resolver maps
     * an import of `./x.ts` (or `./x.js` written for an `x.ts`) onto the renamed file.
     */
    static toCommonJs(entries: readonly ArchiveEntry[], options?: {
        onLog?: (message: string) => void;
        cacheDir?: string;
    }): Promise<{
        entries: ArchiveEntry[];
        renamed: Map<string, string>;
        converted: number;
        failures: string[];
    }>;
}
//# sourceMappingURL=LegacyTranspiler.d.ts.map
import { TargetDevice } from "../structures";
/**
 * What Graak knows about a Deno project without running Deno: where its configuration is, what
 * that configuration says, and which targets `deno compile` can build by itself (the rest is
 * what Graak is for, the same division of labour as with Bun).
 */
export declare const DENO_CONFIG_FILES: readonly ["deno.json", "deno.jsonc"];
/**
 * Targets `deno compile --target` accepts, keyed by the Graak target that runs the same executable.
 * Deno itself needs a 64-bit Linux, macOS or Windows 10+ machine, so it cannot make anything for
 * Windows XP, Vista or 7, 32-bit systems, ARMv7, FreeBSD or iSH: those are Graak's.
 */
export declare const DENO_COMPILE_TARGETS: Readonly<Partial<Record<TargetDevice, string>>>;
export interface DenoConfig {
    /** Absolute path of the deno.json(c) file. */
    path: string;
    /** Directory that holds it: the project root for import resolution. */
    dir: string;
    name?: string;
    version?: string;
    /** Import map entries (`"chalk": "npm:chalk@5"`, `"lib/": "./lib/"`). */
    imports: Record<string, string>;
    /** Import map scopes. */
    scopes: Record<string, Record<string, string>>;
    /** `"nodeModulesDir"`: "none" | "auto" | "manual" (or a legacy boolean). */
    nodeModulesDir?: string | boolean;
    /** `compilerOptions.jsx` and friends, passed on to the transpiler. */
    compilerOptions: Record<string, unknown>;
    tasks: Record<string, string>;
    /** Workspace member folders. */
    workspace: string[];
    raw: Record<string, unknown>;
}
/** Strips comments and trailing commas: deno.jsonc is JSON with both. String contents are left alone. */
export declare function parseJsonc(text: string): unknown;
export declare class DenoProject {
    /** The closest deno.json(c) at or above `start`, or null. */
    static findConfig(start: string): string | null;
    /** Whether `root` is a Deno project: it has a deno.json(c) or a deno.lock. */
    static isDenoProject(root: string): boolean;
    static readConfig(path: string): DenoConfig;
    /** Whether `deno compile` builds this target itself. */
    static canDenoCompile(target: TargetDevice): boolean;
    /** The `--target` value for `deno compile`, or null where only Graak can build the target. */
    static denoTarget(target: TargetDevice): string | null;
}
//# sourceMappingURL=DenoProject.d.ts.map
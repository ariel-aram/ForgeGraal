/**
 * Lets ForgeGraal build a Yarn Plug'n'Play project without reimplementing Yarn's own resolver.
 *
 * A PnP project has no `node_modules` at all: dependencies live as zip archives (in the project's
 * `.yarn/cache/` or, by default, a global cache outside the project entirely) that `.pnp.cjs`
 * resolves at require() time. `ProjectCollector` -- and pnpm's virtual-store walk right beside it
 * -- both assume a real directory tree to copy, so neither can see a PnP install as-is.
 *
 * Rather than parsing `.pnp.cjs` or the zip cache directly, this asks Yarn itself to produce a
 * normal `node_modules` tree from the exact same `yarn.lock`, by overriding `nodeLinker` for one
 * throwaway install: `YARN_NODE_LINKER=node-modules yarn install`. That install runs in a
 * temporary copy of the project, never the original, so the user's `.pnp.cjs`, lockfile and
 * `.yarnrc.yml` are never touched -- ForgeGraal is assisting Yarn's own tooling here, not
 * replacing it or second-guessing how it resolves packages.
 */
export interface MaterializedProject {
    /** Root of the temporary node_modules-linked copy. */
    root: string;
    /** The original entrypoint's path, re-based onto the temporary copy. */
    entrypoint: string;
    /** Removes the temporary copy. Safe to call more than once. */
    cleanup: () => void;
}
export declare class YarnPnpCompat {
    static isPnpProject(root: string): boolean;
    /**
     * Reads the pinned Yarn release out of `.yarnrc.yml`. A PnP project always has one -- it is
     * how `yarn` on PATH knows which actual Yarn build to run -- so this is more reliable than
     * hoping a compatible `yarn` is separately installed on the build machine.
     */
    private static resolveYarnPath;
    /**
     * Copies `root` to a temp directory and installs it there with the node-modules linker, so
     * the result is a project `ProjectCollector.collect()` already knows how to bundle unchanged.
     */
    static materialize(root: string, entrypoint: string, options?: {
        offline?: boolean;
        excludePaths?: readonly string[];
        onLog?: (message: string) => void;
    }): MaterializedProject;
}
//# sourceMappingURL=YarnPnpCompat.d.ts.map
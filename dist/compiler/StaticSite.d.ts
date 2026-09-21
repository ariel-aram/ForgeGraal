/**
 * Turns a folder of static files (a `vite build`, Create React App or `next export` output, a plain
 * HTML site) into something Graak can package like any other program: a generated web server plus
 * the files it serves.
 *
 * The server is plain JavaScript over `http`, `fs`, `path` and `zlib`, so the same source runs on the
 * native host and on Node.js. It serves the site the way a static host would: correct MIME types,
 * ETag and Last-Modified with 304 replies, byte ranges (video seeking), gzip for text, an index file for
 * directories, optional single-page-app fallback to `index.html`, and no way out of the site folder.
 */
export interface StaticSiteOptions {
    /** Answer unknown routes that look like pages with `index.html`, so client-side routing works. */
    spa?: boolean;
    /** TCP port. `PORT` in the environment and `--port` on the command line override it. Default 8080. */
    port?: number;
    /** Interface to listen on. Default all IPv4 interfaces. */
    host?: string;
    /** File served for a directory. Default `index.html`. */
    index?: string;
}
export interface MaterializedSite {
    /** A temporary project directory holding `package.json`, `server.js` and `site/`. */
    root: string;
    /** The generated server, to be compiled like any entrypoint. */
    entrypoint: string;
    /** Files served, for reporting. */
    cleanup: () => void;
}
export declare class StaticSite {
    /** A directory, or an `.html` file, is a site rather than a program. */
    static isSiteEntry(entrypoint: string): boolean;
    static siteDirectory(entrypoint: string): string;
    static materialize(entrypoint: string, options?: StaticSiteOptions): MaterializedSite;
}
//# sourceMappingURL=StaticSite.d.ts.map
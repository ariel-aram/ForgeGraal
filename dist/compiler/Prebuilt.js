"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Prebuilt = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_zlib_1 = require("node:zlib");
/** Bytes with CR removed, so a checkout with CRLF line endings (Windows, autocrlf) digests like an LF one. */
function lf(bytes) {
    return bytes.includes(13) ? Buffer.from(bytes.filter((b) => b !== 13)) : bytes;
}
class Prebuilt {
    /** Digest of named files, independent of line endings. Names are part of the digest, order is not. */
    static digest(files) {
        const hash = (0, node_crypto_1.createHash)("sha256");
        for (const [name, path] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
            hash.update(name).update(lf((0, node_fs_1.readFileSync)(path)));
        }
        return hash.digest("hex");
    }
    /** Every `.c/.h/.sh/.py` file under `dir`, named relative to it, for `digest()`. */
    static sourcesUnder(dir, prefix = "") {
        const found = [];
        for (const entry of (0, node_fs_1.readdirSync)(dir, { withFileTypes: true })) {
            const path = (0, node_path_1.join)(dir, entry.name);
            if (entry.isDirectory())
                found.push(...Prebuilt.sourcesUnder(path, `${prefix}${entry.name}/`));
            else if (/\.(c|h|sh|py)$/.test(entry.name))
                found.push([`${prefix}${entry.name}`, path]);
        }
        return found;
    }
    static manifest(repoRoot) {
        const path = (0, node_path_1.join)(repoRoot, "quickjs/prebuilt/hosts/manifest.json");
        if (!(0, node_fs_1.existsSync)(path))
            return null;
        try {
            return JSON.parse((0, node_fs_1.readFileSync)(path, "utf-8"));
        }
        catch {
            return null;
        }
    }
    /**
     * The prebuilt host for `buildTarget` as bytes, or null when there is none, it was built from other
     * sources than `sourceHash`, or it does not match its recorded checksum.
     */
    static host(repoRoot, buildTarget, sourceHash) {
        const manifest = Prebuilt.manifest(repoRoot);
        const entry = manifest?.hosts[buildTarget];
        if (!manifest || !entry || manifest.sourceHash !== sourceHash)
            return null;
        const file = (0, node_path_1.join)(repoRoot, "quickjs/prebuilt/hosts", entry.file);
        if (!(0, node_fs_1.existsSync)(file))
            return null;
        try {
            const bytes = (0, node_zlib_1.gunzipSync)((0, node_fs_1.readFileSync)(file));
            return (0, node_crypto_1.createHash)("sha256").update(bytes).digest("hex") === entry.sha256 ? bytes : null;
        }
        catch {
            return null;
        }
    }
}
exports.Prebuilt = Prebuilt;
//# sourceMappingURL=Prebuilt.js.map
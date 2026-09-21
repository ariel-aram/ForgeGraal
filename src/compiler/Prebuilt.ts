import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Prebuilt copies of what Graak would otherwise compile on the machine that runs a build: the
 * native hosts (quickjs-ng + mbedTLS + wasm3, minutes of C compiling and a cross-compiler download)
 * and the Windows 7 compatibility DLLs. Neither can be built at all where there is no POSIX shell and
 * no mingw-w64/musl toolchain, which is every ordinary Windows machine.
 *
 * They live in `quickjs/prebuilt/` and are trusted only while the sources they were built from are the
 * sources on disk, so a change to the C code can never silently ship an old binary: the manifest carries
 * the digest of those sources, and `test/prebuilt.test.ts` fails when it goes stale.
 */

export interface PrebuiltHost {
	/** Gzip file name inside `quickjs/prebuilt/hosts/`. */
	file: string;
	/** SHA-256 of the executable itself (not the gzip), checked after extraction. */
	sha256: string;
	size: number;
}

export interface PrebuiltManifest {
	/** `Prebuilt.digest()` of the host sources these were built from. */
	sourceHash: string;
	hosts: Record<string, PrebuiltHost>;
}

/** Bytes with CR removed, so a checkout with CRLF line endings (Windows, autocrlf) digests like an LF one. */
function lf(bytes: Buffer): Buffer {
	return bytes.includes(13) ? Buffer.from(bytes.filter((b) => b !== 13)) : bytes;
}

export class Prebuilt {
	/** Digest of named files, independent of line endings. Names are part of the digest, order is not. */
	public static digest(files: ReadonlyArray<readonly [name: string, path: string]>): string {
		const hash = createHash("sha256");
		for (const [name, path] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
			hash.update(name).update(lf(readFileSync(path)));
		}
		return hash.digest("hex");
	}

	/** Every `.c/.h/.sh/.py` file under `dir`, named relative to it, for `digest()`. */
	public static sourcesUnder(dir: string, prefix = ""): Array<[string, string]> {
		const found: Array<[string, string]> = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) found.push(...Prebuilt.sourcesUnder(path, `${prefix}${entry.name}/`));
			else if (/\.(c|h|sh|py)$/.test(entry.name)) found.push([`${prefix}${entry.name}`, path]);
		}
		return found;
	}

	public static manifest(repoRoot: string): PrebuiltManifest | null {
		const path = join(repoRoot, "quickjs/prebuilt/hosts/manifest.json");
		if (!existsSync(path)) return null;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as PrebuiltManifest;
		} catch {
			return null;
		}
	}

	/**
	 * The prebuilt host for `buildTarget` as bytes, or null when there is none, it was built from other
	 * sources than `sourceHash`, or it does not match its recorded checksum.
	 */
	public static host(repoRoot: string, buildTarget: string, sourceHash: string): Buffer | null {
		const manifest = Prebuilt.manifest(repoRoot);
		const entry = manifest?.hosts[buildTarget];
		if (!manifest || !entry || manifest.sourceHash !== sourceHash) return null;
		const file = join(repoRoot, "quickjs/prebuilt/hosts", entry.file);
		if (!existsSync(file)) return null;
		try {
			const bytes = gunzipSync(readFileSync(file));
			return createHash("sha256").update(bytes).digest("hex") === entry.sha256 ? bytes : null;
		} catch {
			return null;
		}
	}
}

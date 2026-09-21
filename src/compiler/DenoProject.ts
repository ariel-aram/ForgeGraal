import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TargetDevice } from "../structures";

/**
 * What Graak knows about a Deno project without running Deno: where its configuration is, what
 * that configuration says, and which targets `deno compile` can build by itself (the rest is
 * what Graak is for, the same division of labour as with Bun).
 */

export const DENO_CONFIG_FILES = ["deno.json", "deno.jsonc"] as const;

/**
 * Targets `deno compile --target` accepts, keyed by the Graak target that runs the same executable.
 * Deno itself needs a 64-bit Linux, macOS or Windows 10+ machine, so it cannot make anything for
 * Windows XP, Vista or 7, 32-bit systems, ARMv7, FreeBSD or iSH: those are Graak's.
 */
export const DENO_COMPILE_TARGETS: Readonly<Partial<Record<TargetDevice, string>>> = {
	[TargetDevice.LinuxModernX64]: "x86_64-unknown-linux-gnu",
	[TargetDevice.LinuxModernArm64]: "aarch64-unknown-linux-gnu",
	[TargetDevice.WinModernX64]: "x86_64-pc-windows-msvc",
	[TargetDevice.DarwinX64]: "x86_64-apple-darwin",
	[TargetDevice.DarwinArm64]: "aarch64-apple-darwin",
};

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
export function parseJsonc(text: string): unknown {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1").replace(/^﻿/, ""));
}

function stringRecord(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
	}
	return out;
}

export class DenoProject {
	/** The closest deno.json(c) at or above `start`, or null. */
	public static findConfig(start: string): string | null {
		let dir = start;
		for (;;) {
			for (const name of DENO_CONFIG_FILES) if (existsSync(join(dir, name))) return join(dir, name);
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	}

	/** Whether `root` is a Deno project: it has a deno.json(c) or a deno.lock. */
	public static isDenoProject(root: string): boolean {
		return existsSync(join(root, "deno.lock")) || DENO_CONFIG_FILES.some((name) => existsSync(join(root, name)));
	}

	public static readConfig(path: string): DenoConfig {
		const raw = parseJsonc(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const scopes: Record<string, Record<string, string>> = {};
		if (raw.scopes && typeof raw.scopes === "object") {
			for (const [scope, map] of Object.entries(raw.scopes)) scopes[scope] = stringRecord(map);
		}
		const workspace = Array.isArray(raw.workspace)
			? raw.workspace.filter((w): w is string => typeof w === "string")
			: Array.isArray((raw.workspace as { members?: unknown })?.members)
				? ((raw.workspace as { members: unknown[] }).members.filter((w) => typeof w === "string") as string[])
				: [];
		return {
			path,
			dir: dirname(path),
			name: typeof raw.name === "string" ? raw.name : undefined,
			version: typeof raw.version === "string" ? raw.version : undefined,
			imports: stringRecord(raw.imports),
			scopes,
			nodeModulesDir: raw.nodeModulesDir as string | boolean | undefined,
			compilerOptions:
				raw.compilerOptions && typeof raw.compilerOptions === "object"
					? (raw.compilerOptions as Record<string, unknown>)
					: {},
			tasks: stringRecord(raw.tasks),
			workspace,
			raw,
		};
	}

	/** Whether `deno compile` builds this target itself. */
	public static canDenoCompile(target: TargetDevice): boolean {
		return target in DENO_COMPILE_TARGETS;
	}

	/** The `--target` value for `deno compile`, or null where only Graak can build the target. */
	public static denoTarget(target: TargetDevice): string | null {
		return DENO_COMPILE_TARGETS[target] ?? null;
	}
}

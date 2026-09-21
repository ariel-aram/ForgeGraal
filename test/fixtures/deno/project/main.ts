import os from "node:os";
import { bold, stripAnsiCode } from "@std/fmt/colors";
import { basename, join } from "@std/path";
import double, { greet, type Shape } from "lib/util.ts";
import { z } from "zod";
import data from "./data.json" with { type: "json" };

const shape: Shape = { kind: "a" };
const schema = z.object({ n: z.number().int(), s: z.string().min(2) });
const parsed = schema.safeParse({ n: 3, s: "ab" });
const bad = schema.safeParse({ n: 1.5, s: "a" });

// Top-level await, dynamic import and reading a file that sits next to the program.
const { where, main } = await import("./lib/dynamic.ts");
const note = await Deno.readTextFile(new URL("./assets/note.txt", import.meta.url));

console.log(
	JSON.stringify({
		greet: greet("deno"),
		double: double(21),
		path: join("a", "b", "c.txt"),
		base: basename("/x/y/z.ts"),
		bold: stripAnsiCode(bold("plain")),
		zod: [parsed.success, bad.success, bad.success ? 0 : bad.error.issues.length],
		json: data,
		shape,
		where,
		dynamicMain: main,
		entryMain: import.meta.main,
		note: note.trim(),
		os: typeof os.platform(),
		args: Deno.args,
		file: import.meta.url.endsWith("/main.ts"),
	})
);

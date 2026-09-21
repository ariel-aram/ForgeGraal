// Deno file system API, printed as a transcript that must be identical under Deno and under Graak.
const out: string[] = [];
const say = (...a: unknown[]) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
const dir = await Deno.makeTempDir({ prefix: "graak-fs-" });
const p = (n: string) => `${dir}/${n}`;

await Deno.writeTextFile(p("a.txt"), "hello\nworld\n");
say("text", await Deno.readTextFile(p("a.txt")), Deno.readTextFileSync(p("a.txt")).length);
const bytes = await Deno.readFile(p("a.txt"));
say("bytes", bytes.constructor.name, bytes.length, bytes[0]);
await Deno.writeFile(p("b.bin"), new Uint8Array([1, 2, 3, 255]));
say("bin", Array.from(await Deno.readFile(p("b.bin"))));
await Deno.writeTextFile(p("a.txt"), "more\n", { append: true });
say("append", await Deno.readTextFile(p("a.txt")));
try {
	await Deno.writeTextFile(p("a.txt"), "x", { createNew: true });
} catch (e) {
	say("createNew", (e as Error).name, (e as { code: string }).code, e instanceof Deno.errors.AlreadyExists);
}
try {
	await Deno.writeTextFile(p("nope.txt"), "x", { create: false });
} catch (e) {
	say("create:false", (e as Error).name, e instanceof Deno.errors.NotFound);
}

const st = await Deno.stat(p("a.txt"));
say(
	"stat",
	st.isFile,
	st.isDirectory,
	st.isSymlink,
	st.size,
	st.mtime instanceof Date,
	typeof st.mode,
	st.mode! & 0o777
);
say("statdir", (await Deno.stat(dir)).isDirectory);
try {
	await Deno.stat(p("missing"));
} catch (e) {
	say(
		"stat missing",
		(e as Error).name,
		(e as { code: string }).code,
		e instanceof Deno.errors.NotFound,
		(e as Error).message.startsWith("No such file or directory (os error 2)")
	);
}

await Deno.mkdir(p("d/e/f"), { recursive: true });
try {
	await Deno.mkdir(p("d"));
} catch (e) {
	say("mkdir exists", (e as Error).name);
}
await Deno.writeTextFile(p("d/e/x.txt"), "x");
const names: string[] = [];
for await (const entry of Deno.readDir(p("d/e")))
	names.push(`${entry.name}:${entry.isFile ? "f" : entry.isDirectory ? "d" : "?"}`);
say("readDir", names.sort());
const sync: string[] = [];
for (const entry of Deno.readDirSync(p("d/e"))) sync.push(entry.name);
say("readDirSync", sync.sort());

await Deno.copyFile(p("a.txt"), p("copy.txt"));
await Deno.rename(p("copy.txt"), p("moved.txt"));
say("moved", (await Deno.readTextFile(p("moved.txt"))) === (await Deno.readTextFile(p("a.txt"))));
await Deno.symlink(p("a.txt"), p("link"));
say(
	"link",
	(await Deno.lstat(p("link"))).isSymlink,
	(await Deno.readLink(p("link"))) === p("a.txt"),
	(await Deno.stat(p("link"))).isFile
);
say("realPath", (await Deno.realPath(p("link"))) === (await Deno.realPath(p("a.txt"))));
await Deno.truncate(p("a.txt"), 4);
say("truncate", await Deno.readTextFile(p("a.txt")));
await Deno.chmod(p("a.txt"), 0o600);
say("chmod", (await Deno.stat(p("a.txt"))).mode! & 0o777);

// FsFile: open, read, seek, write, stat, close
const f = await Deno.open(p("rw.txt"), { read: true, write: true, create: true });
await f.write(new TextEncoder().encode("0123456789"));
await f.seek(2, Deno.SeekMode.Start);
const buf = new Uint8Array(4);
const n = await f.read(buf);
say("file read", n, new TextDecoder().decode(buf));
say("file seek", await f.seek(0, Deno.SeekMode.End), (await f.stat()).size);
f.close();
const g = Deno.openSync(p("rw.txt"));
const all = new Uint8Array(20);
say("readSync", g.readSync(all), g.readSync(all));
g.close();
try {
	g.close();
} catch (e) {
	say("double close", (e as Error).name);
}
const text = await new Response((await Deno.open(p("rw.txt"))).readable).text();
say("readable", text);

const tf = await Deno.makeTempFile({ dir, prefix: "t-", suffix: ".tmp" });
say("tempfile", tf.startsWith(`${dir}/t-`), tf.endsWith(".tmp"));

try {
	await Deno.remove(p("d"));
} catch (e) {
	say("remove nonempty", (e as Error).name === "Error" || (e as Error).name.length > 0);
}
await Deno.remove(p("d"), { recursive: true });
say(
	"removed",
	await Deno.stat(p("d")).then(
		() => true,
		() => false
	)
);
await Deno.remove(dir, { recursive: true });

for (const l of out) console.log(l);

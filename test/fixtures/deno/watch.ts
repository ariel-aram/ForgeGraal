// Deno.watchFs: a file created, changed and removed under a watched directory is reported with the right kinds.
const dir = await Deno.makeTempDir({ prefix: "graak-watch-" });
const watcher = Deno.watchFs(dir);
const kinds = new Set<string>();
const seen: string[] = [];
const reader = (async () => {
	for await (const event of watcher) {
		kinds.add(event.kind);
		for (const p of event.paths) seen.push(p.slice(dir.length + 1));
		if (kinds.has("create") && kinds.has("modify") && kinds.has("remove")) break;
	}
})();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(400);
await Deno.writeTextFile(`${dir}/a.txt`, "one");
await wait(600);
await Deno.writeTextFile(`${dir}/a.txt`, "one two three");
await wait(600);
await Deno.remove(`${dir}/a.txt`);
await Promise.race([reader, wait(5000)]);
watcher.close();
console.log(
	JSON.stringify({
		create: kinds.has("create"),
		modify: kinds.has("modify"),
		remove: kinds.has("remove"),
		names: [...new Set(seen)],
	})
);
await Deno.remove(dir, { recursive: true });

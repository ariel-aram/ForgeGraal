const out: string[] = [];
const say = (...a: unknown[]) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
Deno.env.set("GRAAK_DENO_A", "1");
say("env", Deno.env.get("GRAAK_DENO_A"), Deno.env.has("GRAAK_DENO_A"), Deno.env.get("GRAAK_DENO_MISSING"));
say("toObject", Deno.env.toObject().GRAAK_DENO_A);
Deno.env.delete("GRAAK_DENO_A");
say("deleted", Deno.env.has("GRAAK_DENO_A"));
say("args", Deno.args);
say(
	"types",
	typeof Deno.pid,
	typeof Deno.cwd(),
	typeof Deno.execPath(),
	typeof Deno.hostname(),
	typeof Deno.osRelease(),
	Array.isArray(Deno.loadavg())
);
say("build", Deno.build.os, Deno.build.arch, typeof Deno.build.target);
say("version", /^\d+\.\d+\.\d+/.test(Deno.version.deno), typeof Deno.version.v8, typeof Deno.version.typescript);
say(
	"meta",
	typeof import.meta.url,
	import.meta.main,
	import.meta.url.startsWith("file://"),
	import.meta.url.endsWith("env-process.ts")
);
say("dirname", import.meta.dirname === new URL(".", import.meta.url).pathname.replace(/\/$/, ""));
say("perm", (await Deno.permissions.query({ name: "read" })).state);
const before = Deno.cwd();
Deno.chdir("/");
say("chdir", Deno.cwd());
Deno.chdir(before);
say("mem", Object.keys(Deno.memoryUsage()).sort());
say("errors", Object.keys(Deno.errors).sort().slice(0, 6));
say("noColor", typeof Deno.noColor);
say("inspect", Deno.inspect({ a: 1, b: [1, 2] }).replace(/\s+/g, " "));
for (const l of out) console.log(l);
const code = Number(Deno.env.get("GRAAK_EXIT") ?? "0");
if (code) Deno.exit(code);

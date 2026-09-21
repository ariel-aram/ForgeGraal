// Deno KV: keys and their order, values, list selectors, atomic operations, expiry, queues and watch.
const out: string[] = [];
const say = (...a: unknown[]) =>
	out.push(
		a
			.map((x) =>
				typeof x === "string"
					? x
					: JSON.stringify(x, (_k, v) =>
							typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? `u8[${v.join(",")}]` : v
						)
			)
			.join(" ")
	);
const kv = await Deno.openKv(":memory:");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Order across key part types: bytes < string < bigint < number < boolean.
const mixed: Deno.KvKey[] = [
	[true],
	[false],
	[10n],
	[-5n],
	[2],
	[-1.5],
	[""],
	["a"],
	["b\u0000c"],
	[new Uint8Array([1, 2])],
	[new Uint8Array([])],
	["a", 1],
	["a", "b"],
];
for (const k of mixed) await kv.set(k, "v");
const order: Deno.KvKey[] = [];
for await (const e of kv.list({ start: [new Uint8Array([])], end: [true, 1] })) order.push(e.key);
say(
	"order",
	order.map((k) => k.map((p) => (p instanceof Uint8Array ? `u8[${p.join(",")}]` : typeof p === "bigint" ? `${p}n` : p)))
);
for (const k of mixed) await kv.delete(k);

const r1 = await kv.set(["users", 1], {
	name: "ada",
	born: new Date(0),
	tags: new Set(["a", "b"]),
	meta: new Map([["k", 1n]]),
	re: /x+/gi,
	nested: { a: [1, 2, { b: null }] },
	u: undefined,
	nan: NaN,
	neg0: -0,
});
say("set", r1.ok, /^[0-9a-f]{20}$/.test(r1.versionstamp));
const got = await kv.get<any>(["users", 1]);
say(
	"get",
	got.key,
	got.value.name,
	got.value.born instanceof Date,
	[...got.value.tags],
	[...got.value.meta],
	String(got.value.re),
	got.value.nested,
	got.value.u,
	got.value.nan,
	Object.is(got.value.neg0, -0),
	got.versionstamp === r1.versionstamp
);
const missing = await kv.get(["nope"]);
say("missing", missing.value, missing.versionstamp);
const cyc: any = { name: "loop" };
cyc.self = cyc;
await kv.set(["cyc"], cyc);
const back = (await kv.get<any>(["cyc"])).value;
say("cycle", back.name, back.self === back);
await kv.set(["bytes"], new Uint8Array([9, 8, 7]));
say("bytes", (await kv.get<Uint8Array>(["bytes"])).value);
try {
	await kv.set(["fn"], () => {});
} catch (e) {
	say("fn", (e as Error).name);
}

for (let i = 1; i <= 7; i++) await kv.set(["items", i], `item${i}`);
await kv.set(["items", "x"], "x");
const keys = async (selector: Deno.KvListSelector, options?: Deno.KvListOptions) => {
	const it = kv.list<string>(selector, options);
	const found: unknown[] = [];
	for await (const e of it) found.push(e.key[1]);
	return { found, cursor: typeof it.cursor };
};
say("prefix", await keys({ prefix: ["items"] }));
say("limit", (await keys({ prefix: ["items"] }, { limit: 3 })).found);
say("reverse", (await keys({ prefix: ["items"] }, { reverse: true, limit: 2 })).found);
say("range", (await keys({ start: ["items", 3], end: ["items", 6] })).found);
say("prefix+start", (await keys({ prefix: ["items"], start: ["items", 5] })).found);
say("batch", (await keys({ prefix: ["items"] }, { batchSize: 2 })).found);
const it = kv.list({ prefix: ["items"] }, { limit: 3 });
const first: unknown[] = [];
for await (const e of it) first.push(e.key[1]);
const next: unknown[] = [];
for await (const e of kv.list({ prefix: ["items"] }, { cursor: it.cursor, limit: 3 })) next.push(e.key[1]);
say("cursor", first, next);
say(
	"getMany",
	(
		await kv.getMany([
			["items", 1],
			["items", 99],
			["items", 2],
		])
	).map((e) => e.value)
);

// U64 and atomic operations
await kv.set(["counter"], new Deno.KvU64(5n));
await kv.atomic().sum(["counter"], 3n).commit();
await kv.atomic().min(["counter"], 4n).commit();
await kv.atomic().max(["counter"], 100n).commit();
say(
	"u64",
	(await kv.get<Deno.KvU64>(["counter"])).value?.value,
	(await kv.get<Deno.KvU64>(["counter"])).value instanceof Deno.KvU64
);
await kv.atomic().sum(["fresh"], 7n).commit();
say("fresh", (await kv.get<Deno.KvU64>(["fresh"])).value?.value);
try {
	await kv.atomic().sum(["items", 1], 1n).commit();
} catch (e) {
	say("sum non-u64", (e as Error).name);
}
const cur = await kv.get(["acct"]);
const c1 = await kv.atomic().check(cur).set(["acct"], 100).commit();
const c2 = await kv.atomic().check(cur).set(["acct"], 200).commit();
say("check", c1.ok, c2.ok, (await kv.get(["acct"])).value);
const multi = await kv.atomic().set(["m", 1], "a").set(["m", 2], "b").delete(["items", 1]).commit();
say("multi", multi.ok, (await kv.get(["m", 2])).value, (await kv.get(["items", 1])).value);
const v1 = (await kv.get(["m", 1])).versionstamp!;
await kv.set(["m", 3], "c");
say("versions grow", (await kv.get(["m", 3])).versionstamp! > v1);
const failed = await kv
	.atomic()
	.check({ key: ["absent"], versionstamp: "00000000000000010000" })
	.set(["never"], 1)
	.commit();
say("absent check", failed.ok, (await kv.get(["never"])).value);

// Queue
const received: unknown[] = [];
const listening = kv.listenQueue((m) => {
	received.push(m);
});
await kv.enqueue({ n: 1 });
await kv.enqueue("later", { delay: 80 });
await kv.atomic().enqueue("from atomic").commit();
await wait(400);
say("queue", received.map((m) => JSON.stringify(m)).sort());
let attempts = 0;
kv.listenQueue((m) => {
	if (m === "flaky") {
		attempts++;
		if (attempts < 3) throw new Error("again");
	}
});
await kv.enqueue("flaky", { backoffSchedule: [10, 10] });
await wait(300);
say("retry attempts", attempts);

// Watch
const seen: unknown[] = [];
const stream = kv.watch([
	["w", 1],
	["w", 2],
]);
const reader = stream.getReader();
const consume = (async () => {
	for (let i = 0; i < 3; i++) {
		const { value } = await reader.read();
		seen.push(value!.map((e) => e.value));
	}
})();
await wait(80);
await kv.set(["w", 1], "one");
await wait(300);
await kv.set(["w", 2], "two");
await Promise.race([consume, wait(3000)]);
await reader.cancel();
say("watch", seen);

kv.close();
try {
	await kv.get(["x"]);
} catch (e) {
	say("closed", (e as Error).name);
}
await Promise.race([listening, wait(200)]);
for (const l of out) console.log(l);
Deno.exit(0);

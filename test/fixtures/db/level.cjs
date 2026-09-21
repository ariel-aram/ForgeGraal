const { ClassicLevel } = require("classic-level");
(async () => {
  const dir = require("os").tmpdir() + "/graak-level-" + process.pid;
  const db = new ClassicLevel(dir, { valueEncoding: "json" });
  await db.open();
  await db.put("a", { n: 1 });
  await db.batch([{ type: "put", key: "b", value: { n: 2 } }, { type: "put", key: "c", value: { n: 3 } }]);
  console.log("get", await db.get("a"));
  const rows = [];
  for await (const [k, v] of db.iterator()) rows.push([k, v.n]);
  console.log("iter", JSON.stringify(rows));
  await db.del("b");
  console.log("after del", JSON.stringify(await db.keys().all()));
  await db.close();
  require("fs").rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.log("ERR", e.message); process.exit(1); });

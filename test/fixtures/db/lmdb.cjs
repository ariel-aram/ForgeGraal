const { open } = require("lmdb");
const dir = require("os").tmpdir() + "/graak-lmdb-" + process.pid;
const db = open({ path: dir, compression: false });
(async () => {
  await db.put("a", { n: 1 });
  console.log("get", JSON.stringify(db.get("a")));
  console.log("range", JSON.stringify([...db.getRange()].map((x) => x.key)));
  await db.close();
  require("fs").rmSync(dir, { recursive: true, force: true });
})();

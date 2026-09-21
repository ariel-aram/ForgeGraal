// SurrealDB embedded (the Rust engine as a Node-API addon) on its in-memory, RocksDB and SurrealKV storage engines.
(async () => {
  const { Surreal, Table } = await import("surrealdb");
  const { createNodeEngines } = await import("@surrealdb/node");
  const fs = require("fs");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "graak-surreal-"));
  for (const scheme of ["mem://", `rocksdb://${dir}/rocks`, `surrealkv://${dir}/skv`]) {
    const db = new Surreal({ engines: createNodeEngines() });
    const label = scheme.split(":")[0];
    try {
      await db.connect(scheme);
      await db.use({ namespace: "t", database: "t" });
      await db.create(new Table("thing")).content({ id: 1, label });
      await db.query("CREATE thing:two SET label = 'two', n = 2");
      await db.query("CREATE thing:three SET label = 'three', n = 3");
      const rows = await db.select(new Table("thing"));
      console.log(label, "select", JSON.stringify(rows.map((r) => r.label).sort()));
      const [count] = await db.query("SELECT count() FROM thing GROUP ALL").collect();
      console.log(label, "count", JSON.stringify(count));
      const [sum] = await db.query("SELECT math::sum(n) AS total FROM thing WHERE n > 1 GROUP ALL").collect();
      console.log(label, "sum", JSON.stringify(sum));
      await db.close();
    } catch (e) {
      console.log(label, "ERR", e && e.message);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
})();

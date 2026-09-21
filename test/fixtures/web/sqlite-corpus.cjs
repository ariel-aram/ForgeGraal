// node:sqlite: what a program can observe of the database. Must print exactly what Node.js prints.
const { DatabaseSync } = require("node:sqlite");
const out = [];
const say = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? `u8[${[...v]}]` : v)))).join(" "));

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, score REAL, photo BLOB, note TEXT);
CREATE TABLE tag (person INTEGER REFERENCES person(id), label TEXT);
CREATE INDEX tag_label ON tag(label);`);
const insert = db.prepare("INSERT INTO person (name, age, score, photo, note) VALUES (?, ?, ?, ?, ?)");
say("run", insert.run("Ada", 36, 9.5, new Uint8Array([1, 2, 3]), null), insert.run("Grace", 45, 8.25, null, "admiral"));
const insertNamed = db.prepare("INSERT INTO person (name, age) VALUES (:name, $age)");
say("named", insertNamed.run({ name: "Linus", age: 54 }), insertNamed.run({ ":name": "Margaret", $age: 33 }));
const all = db.prepare("SELECT * FROM person ORDER BY id");
say("all", all.all());
say("get", db.prepare("SELECT name, age FROM person WHERE id = ?").get(2), db.prepare("SELECT name FROM person WHERE id = ?").get(99));
say("proto", Object.getPrototypeOf(all.get()) === null, Object.keys(all.get()));
say("iterate", [...db.prepare("SELECT name FROM person WHERE age > ? ORDER BY name").iterate(40)]);
say("columns", db.prepare("SELECT id, name AS who FROM person").columns().map((c) => c.name));
say("types", db.prepare("SELECT 1 AS i, 1.5 AS r, 'x' AS t, x'0a0b' AS b, NULL AS n, 1 = 1 AS ok").get());
say("bind types", db.prepare("SELECT ? AS a, ? AS b, ? AS c, ? AS d").get(1, 2.5, "three", null));

const big = db.prepare("SELECT 9007199254740993 AS big, -9223372036854775807 AS small");
try { big.get(); } catch (e) { say("unsafe", e.name, e.code); }
big.setReadBigInts(true);
say("bigint", big.get());
const rowid = db.prepare("INSERT INTO tag VALUES (?, ?)");
rowid.setReadBigInts(true);
say("bigint run", rowid.run(1, "a"));

db.exec("BEGIN");
say("in transaction", db.isTransaction);
db.prepare("INSERT INTO tag VALUES (1, 'kept')").run();
db.exec("ROLLBACK");
say("rolled back", db.prepare("SELECT count(*) AS n FROM tag").get(), db.isTransaction);

try { db.prepare("INSERT INTO person (name) VALUES (NULL)").run(); } catch (e) { say("constraint", e.code, e.errcode, /NOT NULL/.test(e.message)); }
try { db.prepare("SELEC 1"); } catch (e) { say("syntax", e.code, e.errcode); }
try { db.prepare("INSERT INTO tag VALUES (999, 'orphan')").run(); } catch (e) { say("foreign key", e.code, /FOREIGN KEY/.test(e.message)); }
try { insert.run("a", 1); insert.run("only-one"); say("fewer params", "ok"); } catch (e) { say("fewer params", e.code); }
try { insertNamed.run({ nope: 1 }); } catch (e) { say("unknown param", e.code); }
try { db.exec(42); } catch (e) { say("exec type", e.code); }

say("expanded", db.prepare("SELECT ? + ?").expandedSQL === undefined ? "n/a" : db.prepare("SELECT ?1 + ?2").sourceSQL);
const stmt = db.prepare("SELECT 1");
say("source", stmt.sourceSQL);
say("open", db.isOpen);
db.close();
say("closed", db.isOpen);
try { db.exec("SELECT 1"); } catch (e) { say("after close", e.code); }
try { db.close(); } catch (e) { say("double close", e.code); }
const lazy = new DatabaseSync(":memory:", { open: false });
say("lazy", lazy.isOpen);
lazy.open();
say("opened", lazy.isOpen, lazy.prepare("SELECT 42 AS v").get());
lazy.close();

const path = require("path");
const fs = require("fs");
const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "graak-sqlite-"));
const file = path.join(dir, "data.db");
const disk = new DatabaseSync(file);
disk.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER) STRICT");
disk.prepare("INSERT INTO t VALUES (?, ?)").run("a", 1);
disk.close();
const again = new DatabaseSync(file);
say("persisted", again.prepare("SELECT * FROM t").all());
again.close();
const readonly = new DatabaseSync(file, { readOnly: true });
try { readonly.exec("INSERT INTO t VALUES ('b', 2)"); } catch (e) { say("readonly", e.code); }
readonly.close();
fs.rmSync(dir, { recursive: true, force: true });
for (const l of out) console.log(l);

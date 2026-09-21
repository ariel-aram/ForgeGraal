// fs.watch on a directory: what appears, changes and disappears is reported, with names.
const fs = require("fs");
const path = require("path");
const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "graak-watch-"));
const events = new Set();
const watcher = fs.watch(dir, (type, name) => events.add(`${type}:${name}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await wait(300);
  fs.writeFileSync(path.join(dir, "a.txt"), "one");
  await wait(600);
  fs.writeFileSync(path.join(dir, "a.txt"), "one two three");
  await wait(600);
  fs.rmSync(path.join(dir, "a.txt"));
  await wait(600);
  watcher.close();
  const types = [...events].map((e) => e.split(":")[0]);
  console.log(JSON.stringify({ rename: types.includes("rename"), change: types.includes("change"), names: [...new Set([...events].map((e) => e.split(":")[1]))] }));
  fs.rmSync(dir, { recursive: true, force: true });
})();

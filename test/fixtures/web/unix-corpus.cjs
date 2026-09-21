// net over a unix-domain socket, and its file.
const net = require("net");
const fs = require("fs");
const path = require("path");
const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "graak-unix-"));
const sock = path.join(dir, "s.sock");
const out = [];
const say = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
const server = net.createServer((conn) => {
  say("server connection", conn.remoteAddress === undefined || conn.remoteAddress === "");
  let text = "";
  conn.on("data", (d) => (text += d));
  conn.on("end", () => conn.end(`echo:${text}`));
});
server.listen(sock, () => {
  say("listening", server.address() === sock, fs.existsSync(sock));
  const c = net.connect(sock, () => {
    c.write("hello ");
    c.end("unix");
  });
  let got = "";
  c.on("data", (d) => (got += d));
  c.on("close", () => {
    say("client got", got);
    server.close(() => {
      say("closed", fs.existsSync(sock));
      net.connect(path.join(dir, "absent.sock")).on("error", (e) => {
        say("absent", e.code);
        fs.rmSync(dir, { recursive: true, force: true });
        for (const l of out) console.log(l);
      });
    });
  });
});

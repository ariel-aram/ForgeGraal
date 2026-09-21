// dgram: UDP datagrams between sockets in one process.
const dgram = require("dgram");
const out = [];
const say = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
const server = dgram.createSocket("udp4");
const client = dgram.createSocket("udp4");
const messages = [];
server.on("message", (msg, rinfo) => {
  messages.push([msg.toString(), rinfo.family, rinfo.size, rinfo.address]);
  if (msg.toString() === "ping") server.send("pong", rinfo.port, rinfo.address);
  if (messages.length === 3) finish();
});
server.on("listening", () => {
  const a = server.address();
  say("listening", a.address, a.family, typeof a.port);
  client.on("message", (msg) => {
    say("client got", msg.toString());
    client.send(Buffer.from("second"), server.address().port, "127.0.0.1", () => {
      client.send(Buffer.alloc(3000, 9), 0, 3000, server.address().port, "127.0.0.1");
    });
  });
  client.send("ping", a.port, "127.0.0.1", (err, bytes) => say("sent", err, bytes));
});
server.bind(0, "127.0.0.1");
let done = false;
function finish() {
  if (done) return;
  done = true;
  say("messages", messages.map((m) => (m[0].length > 10 ? [m[0].length, ...m.slice(1)] : m)));
  let closed = 0;
  const closer = () => {
    if (++closed < 2) return;
    try { server.send("x", 1, "127.0.0.1"); } catch (e) { say("after close", e.code); }
    for (const l of out) console.log(l);
  };
  server.close(closer);
  client.close(closer);
}
say("bad type", (() => { try { dgram.createSocket("udp9"); } catch (e) { return e.code; } })());

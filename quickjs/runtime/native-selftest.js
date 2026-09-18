import { crypto, zlib, createNetModules } from "./native-modules.js";

// Minimal EventEmitter so this runs without the full compat layer.
class EE {
  constructor() { this._e = {}; }
  on(n, f) { (this._e[n] ||= []).push(f); return this; }
  once(n, f) { const w = (...a) => { this.off(n, w); f(...a); }; return this.on(n, w); }
  off(n, f) { const l = this._e[n]; if (l) { const i = l.findIndex(x => x === f); if (i > -1) l.splice(i, 1); } return this; }
  emit(n, ...a) { for (const f of [...(this._e[n] || [])]) f(...a); return true; }
}
const { tls } = createNetModules(EE);

console.log("crypto.createHash sha256:", crypto.createHash("sha256").update("abc").digest("hex"));
console.log("expected                :", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
console.log("createHmac sha256       :", crypto.createHmac("sha256", "key").update("The quick brown fox jumps over the lazy dog").digest("hex"));
console.log("expected                :", "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
console.log("randomUUID              :", crypto.randomUUID());
console.log("timingSafeEqual         :", crypto.timingSafeEqual("abc", "abc"), crypto.timingSafeEqual("abc", "abd"));

const packed = zlib.deflateSync("ForgeGraal ".repeat(30));
console.log("zlib deflate/inflate    :", zlib.inflateSync(packed).length === 330, `(330 -> ${packed.length})`);

// Node-shaped TLS: exactly how discord.js would open a connection.
const socket = tls.connect({ host: "discord.com", port: 443 });
let body = "";
await new Promise((resolve, reject) => {
  socket.on("secureConnect", () => {
    socket.write("GET /api/v10/gateway HTTP/1.1\r\nHost: discord.com\r\nUser-Agent: ForgeGraal\r\nConnection: close\r\n\r\n");
  });
  socket.on("data", (chunk) => { body += String.fromCharCode(...chunk); });
  socket.on("end", resolve);
  socket.on("error", reject);
});
console.log("tls.connect status      :", body.split("\r\n")[0]);
console.log("tls.connect body        :", body.trim().split("\n").pop());

// Run through the compatibility layer, as a real program would be:
//   forgegraal-c quickjs/runtime/node-compat.js quickjs/runtime/native-selftest.js
const crypto = require("crypto");
const zlib = require("zlib");
const tls = require("tls");


console.log("crypto.createHash sha256:", crypto.createHash("sha256").update("abc").digest("hex"));
console.log("expected                :", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
console.log("createHmac sha256       :", crypto.createHmac("sha256", "key").update("The quick brown fox jumps over the lazy dog").digest("hex"));
console.log("expected                :", "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
console.log("randomUUID              :", crypto.randomUUID());
console.log("timingSafeEqual         :", crypto.timingSafeEqual(Buffer.from("abc"), Buffer.from("abc")), crypto.timingSafeEqual(Buffer.from("abc"), Buffer.from("abd")));

const packed = zlib.deflateSync("ForgeGraal ".repeat(30));
console.log("zlib deflate/inflate    :", zlib.inflateSync(packed).length === 330, `(330 -> ${packed.length})`);

// Node-shaped TLS: exactly how discord.js would open a connection.
const socket = tls.connect({ host: "discord.com", port: 443 });
let body = "";
(async () => {
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
})().catch((error) => {
  console.log("FAILED", error && error.stack);
  process.exit(1);
});

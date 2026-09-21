const zlib = require("zlib");
const data = Buffer.from("hello hello hello hello ".repeat(100));
const gz = zlib.gzipSync(data);
console.log(gz.slice(0, 4).toString("hex"), zlib.gunzipSync(gz).equals(data), zlib.unzipSync(gz).equals(data), zlib.unzipSync(zlib.deflateSync(data)).equals(data), zlib.inflateRawSync(zlib.deflateRawSync(data)).equals(data));
console.log(zlib.crc32("hello"), zlib.constants.Z_BEST_COMPRESSION);
try { zlib.gunzipSync(Buffer.from("not gzip data at all")); } catch (e) { console.log(e.code, e.errno); }
zlib.gzip(data, (err, buf) => { console.log("cb", err, zlib.gunzipSync(buf).length);
  const { pipeline, Readable, Writable } = require("stream"); const chunks = [];
  pipeline(Readable.from([data.slice(0, 1000), data.slice(1000)]), zlib.createGzip(), zlib.createGunzip(), new Writable({ write(c, e, cb) { chunks.push(c); cb(); } }), (err) => console.log("stream", err, Buffer.concat(chunks).equals(data)));
});

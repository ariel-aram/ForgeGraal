const { StringDecoder } = require("string_decoder");
const d = new StringDecoder("utf8"); const euro = Buffer.from("€😀");
const parts = []; for (let i = 0; i < euro.length; i++) parts.push(d.write(euro.subarray(i, i + 1))); parts.push(d.end());
console.log(JSON.stringify(parts.join("")));
const d2 = new StringDecoder("utf16le"); console.log(JSON.stringify([d2.write(Buffer.from([0x3d])), d2.write(Buffer.from([0xd8, 0x00])), d2.write(Buffer.from([0xde])), d2.end()].join("")));
const d3 = new StringDecoder("base64"); console.log(d3.write(Buffer.from("ab")) + "|" + d3.write(Buffer.from("c")) + "|" + d3.end());
function Legacy(enc) { StringDecoder.call(this, enc); } Legacy.prototype = Object.create(StringDecoder.prototype); console.log(new Legacy("hex").write(Buffer.from("hi")));
const d4 = new StringDecoder("utf8"); console.log(JSON.stringify([d4.write(Buffer.from([0xe2, 0x82])), d4.end()]));

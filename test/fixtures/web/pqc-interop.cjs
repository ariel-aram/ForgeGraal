/* Makes post-quantum keys, ciphertexts and signatures on the host and prints them as JSON, for Node.js to check (pqc test in webRuntime.test.ts). */
const crypto = require("crypto");

const message = Buffer.from("a message for Node.js to verify");
const made = { kem: [], sig: [] };
for (const name of ["ml-kem-512", "ml-kem-768", "ml-kem-1024"]) {
	const { publicKey, privateKey } = crypto.generateKeyPairSync(name);
	const { sharedKey, ciphertext } = crypto.encapsulate(publicKey);
	made.kem.push({
		name,
		privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
		sharedKey: sharedKey.toString("base64"),
		ciphertext: ciphertext.toString("base64"),
		seed: privateKey.export({ format: "raw-seed" }).toString("base64"),
		publicRaw: publicKey.export({ format: "raw-public" }).toString("base64"),
	});
}
const names = ["ml-dsa-44", "ml-dsa-65", "ml-dsa-87"];
for (const family of ["sha2", "shake"]) for (const size of ["128f", "192f", "256f"]) names.push(`slh-dsa-${family}-${size}`);
names.push("slh-dsa-sha2-128s");
for (const name of names) {
	const { publicKey, privateKey } = crypto.generateKeyPairSync(name);
	const context = Buffer.from("interop");
	made.sig.push({
		name,
		publicKey: publicKey.export({ type: "spki", format: "pem" }),
		privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
		jwk: publicKey.export({ format: "jwk" }),
		signature: crypto.sign(null, message, privateKey).toString("base64"),
		contextSignature: crypto.sign(null, message, { key: privateKey, context }).toString("base64"),
	});
}
console.log(JSON.stringify(made));

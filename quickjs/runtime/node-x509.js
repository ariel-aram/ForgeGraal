/*
 * X.509 certificates read in JavaScript, for the ones the host's C library refuses: Ed25519, Ed448 and DSA keys and
 * signatures. It returns the same shape as the host's own x509Info(), so X509Certificate does not care which parsed it.
 */

import { fromPem, oidText, readChildren, readTlv, unsignedBytes } from "./node-asn1.js";

const ATTRIBUTE_NAMES = {
	"2.5.4.3": "CN",
	"2.5.4.4": "SN",
	"2.5.4.5": "serialNumber",
	"2.5.4.6": "C",
	"2.5.4.7": "L",
	"2.5.4.8": "ST",
	"2.5.4.9": "street",
	"2.5.4.10": "O",
	"2.5.4.11": "OU",
	"2.5.4.12": "title",
	"2.5.4.17": "postalCode",
	"2.5.4.42": "GN",
	"2.5.4.43": "initials",
	"2.5.4.46": "dnQualifier",
	"1.2.840.113549.1.9.1": "emailAddress",
	"0.9.2342.19200300.100.1.25": "DC",
	"0.9.2342.19200300.100.1.1": "UID",
};
const SIGNATURE_HASH = {
	"1.2.840.113549.1.1.5": "sha1",
	"1.2.840.113549.1.1.11": "sha256",
	"1.2.840.113549.1.1.12": "sha384",
	"1.2.840.113549.1.1.13": "sha512",
	"1.2.840.10045.4.3.2": "sha256",
	"1.2.840.10045.4.3.3": "sha384",
	"1.2.840.10045.4.3.4": "sha512",
	"1.2.840.10040.4.3": "sha1",
	"2.16.840.1.101.3.4.3.2": "sha256",
	"2.16.840.1.101.3.4.3.3": "sha384",
	"2.16.840.1.101.3.4.3.4": "sha512",
};

export function parseCertificate(der, Buffer) {
	const text = (bytes, element) => {
		const raw = bytes.subarray(element.start, element.end);
		if (element.tag === 0x1e) {
			let out = "";
			for (let i = 0; i + 1 < raw.length; i += 2) out += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
			return out;
		}
		return Buffer.from(raw).toString(element.tag === 0x0c ? "utf8" : "latin1");
	};
	const time = (element) => {
		const s = text(der, element);
		let year;
		let rest;
		if (element.tag === 0x17) {
			const yy = Number(s.slice(0, 2));
			year = yy >= 50 ? 1900 + yy : 2000 + yy;
			rest = s.slice(2);
		} else {
			year = Number(s.slice(0, 4));
			rest = s.slice(4);
		}
		return `${String(year).padStart(4, "0")}-${rest.slice(0, 2)}-${rest.slice(2, 4)}T${rest.slice(4, 6)}:${rest.slice(6, 8)}:${rest.slice(8, 10)}Z`;
	};
	const name = (element) => {
		const pairs = [];
		for (const rdn of readChildren(der, element)) {
			for (const attribute of readChildren(der, rdn)) {
				const [oid, value] = readChildren(der, attribute);
				const dotted = oidText(der, oid);
				pairs.push([ATTRIBUTE_NAMES[dotted] ?? dotted, text(der, value)]);
			}
		}
		return pairs;
	};
	const top = readTlv(der, 0);
	const [tbs, sigAlg, sigValue] = readChildren(der, top);
	const fields = readChildren(der, tbs);
	let at = 0;
	let version = 1;
	if (fields[0].tag === 0xa0) {
		version = unsignedBytes(der, readChildren(der, fields[0])[0])[0] + 1;
		at = 1;
	}
	const serialBytes = der.subarray(fields[at].start, fields[at].end);
	const serial = Buffer.from(serialBytes).toString("hex").toUpperCase().replace(/^(00)+(?=..)/, "");
	const issuer = name(fields[at + 2]);
	const [notBefore, notAfter] = readChildren(der, fields[at + 3]);
	const subject = name(fields[at + 4]);
	const spkiElement = fields[at + 5];
	const spki = der.slice(spkiElement.pos, spkiElement.next);
	const [keyAlg, keyBits] = readChildren(der, spkiElement);
	const keyOid = oidText(der, readChildren(der, keyAlg)[0]);
	const info = {
		version,
		serial,
		subject,
		issuer,
		validFrom: time(notBefore),
		validTo: time(notAfter),
		raw: der.slice(top.pos, top.next),
		ca: false,
		signatureOid: oidText(der, readChildren(der, sigAlg)[0]),
		altNames: [],
		extKeyUsage: [],
		spki,
		tbs: der.slice(tbs.pos, tbs.next),
		signature: der.slice(sigValue.start + 1, sigValue.end),
	};
	const okp = { "1.3.101.112": "ed25519", "1.3.101.113": "ed448", "1.3.101.110": "x25519", "1.3.101.111": "x448" }[keyOid];
	if (okp) {
		info.type = okp;
		info.bits = okp.endsWith("448") ? 448 : 255;
		info.okpPublic = der.slice(keyBits.start + 1, keyBits.end);
	} else if (keyOid === "1.2.840.10040.4.1") {
		info.type = "dsa";
		const [p] = readChildren(der, readChildren(der, keyAlg)[1]);
		info.bits = (unsignedBytes(der, p).length - 1) * 8 + (8 - Math.clz32(unsignedBytes(der, p)[0]) + 24);
	} else {
		info.type = keyOid;
		info.bits = 0;
	}
	for (const field of fields.slice(at + 6)) {
		if (field.tag !== 0xa3) continue;
		for (const extension of readChildren(der, readChildren(der, field)[0])) {
			const parts = readChildren(der, extension);
			const oid = oidText(der, parts[0]);
			const value = parts[parts.length - 1];
			const body = readTlv(der, value.start);
			if (oid === "2.5.29.17") {
				for (const general of readChildren(der, body)) {
					const raw = der.subarray(general.start, general.end);
					const kind = general.tag & 0x1f;
					if (kind === 2) info.altNames.push(["DNS", Buffer.from(raw).toString("latin1")]);
					else if (kind === 1) info.altNames.push(["email", Buffer.from(raw).toString("latin1")]);
					else if (kind === 6) info.altNames.push(["URI", Buffer.from(raw).toString("latin1")]);
					else if (kind === 7) {
						if (raw.length === 4) info.altNames.push(["IP Address", Array.from(raw).join(".")]);
						else {
							const groups = [];
							for (let i = 0; i + 1 < raw.length; i += 2) groups.push(((raw[i] << 8) | raw[i + 1]).toString(16).toUpperCase());
							info.altNames.push(["IP Address", groups.join(":")]);
						}
					}
				}
			} else if (oid === "2.5.29.19") {
				const flag = readChildren(der, body)[0];
				info.ca = Boolean(flag && flag.tag === 1 && der[flag.start] !== 0);
			} else if (oid === "2.5.29.37") {
				for (const usage of readChildren(der, body)) info.extKeyUsage.push(oidText(der, usage));
			}
		}
	}
	return info;
}

/* Certificates as DER from a PEM string or bytes. */
export function certificateBytes(source, Buffer) {
	if (typeof source === "string" || /^\s*-----BEGIN /.test(Buffer.from(source).toString("latin1"))) {
		const found = fromPem(source, Buffer);
		if (!found) throw new Error("no certificate");
		return found.der;
	}
	return source;
}

export { SIGNATURE_HASH };

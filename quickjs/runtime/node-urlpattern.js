/*
 * The URLPattern of Node.js on top of url-pattern.js: the same results with the same key order.
 *
 * Node builds each component's `groups` from a C++ std::unordered_map, so the order of the named groups in an `exec`
 * result is the iteration order of libstdc++'s hash table (reverse of the pattern order for a few names, shuffled by
 * collisions after that). Programs that print or spread the groups see it, so it is reproduced: the hash is libstdc++'s
 * murmur variant, the table starts at 13 buckets and grows through its prime list, a new node goes to the front of the
 * list when its bucket is empty and behind the bucket's first node otherwise. The result object's own keys are
 * alphabetical, as Node's are.
 */

import { URLPattern } from "./url-pattern.js";

const MASK = (1n << 64n) - 1n;
const MUL = (0xc6a4a793n << 32n) + 0x5bd1e995n;
const shiftMix = (v) => v ^ (v >> 47n);
function hashBytes(bytes) {
	const seed = 0xc70f6907n;
	const len = bytes.length;
	let hash = (seed ^ ((BigInt(len) * MUL) & MASK)) & MASK;
	const load = (at, n) => {
		let v = 0n;
		for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
		return v;
	};
	const aligned = len & ~7;
	for (let at = 0; at < aligned; at += 8) {
		const data = (shiftMix((load(at, 8) * MUL) & MASK) * MUL) & MASK;
		hash = ((hash ^ data) * MUL) & MASK;
	}
	if (len & 7) hash = ((hash ^ load(aligned, len & 7)) * MUL) & MASK;
	hash = (shiftMix(hash) * MUL) & MASK;
	return shiftMix(hash);
}
const PRIMES = [
	2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 103, 109, 113, 127, 137, 139, 149, 157, 167, 179, 193, 199, 211, 227, 241, 257, 277, 293, 313, 337, 359, 383, 409, 439, 467, 503, 541, 577, 619, 661, 709, 761, 823, 887, 953, 1031, 1109, 1193, 1289, 1381, 1493, 1613, 1741, 1879, 2029, 2179, 2357, 2549, 2753, 2971, 3209, 3469, 3739, 4027, 4349, 4703, 5087, 5503, 5953, 6427, 6949, 7517, 8123, 8783, 9497, 10273, 11113, 12011, 12983, 14033, 15173, 16411, 17749, 19183, 20753, 22447, 24281, 26267, 28411, 30727, 33223, 35933, 38873, 42043, 45481, 49201, 53201, 57557, 62233, 67307, 72817, 78779, 85229, 92203, 99733, 107897, 116731, 126271, 136607, 147793, 159871, 172933, 187091, 202409, 218971, 236897, 256279, 277261, 299951, 324503, 351061, 379787, 410857, 444487, 480881, 520241, 562841, 608903, 658753, 712697, 771049, 834181, 902483, 976369,
];
const FAST_BUCKETS = [2, 2, 2, 3, 5, 5, 7, 7, 11, 11, 11, 11, 13, 13];
const nextBuckets = (n) => (n < FAST_BUCKETS.length ? FAST_BUCKETS[n] : (PRIMES.find((p) => p >= n) ?? n));

/* The keys in the order libstdc++'s unordered_map<std::string, ...> iterates them after inserting them in this order into
   a table sized for that many elements (which is how Node's C++ builds the groups: no rehash happens along the way). */
export function unorderedMapOrder(keys) {
	const encoder = new TextEncoder();
	const bucketCount = nextBuckets(keys.length);
	let head = null;
	const before = new Map(); // bucket -> the node before the bucket's first node (null: before the list's head)
	for (const key of keys) {
		const code = hashBytes(encoder.encode(key));
		const bucket = Number(code % BigInt(bucketCount));
		const node = { key, code, next: null };
		if (before.has(bucket)) {
			const prior = before.get(bucket);
			node.next = prior ? prior.next : head;
			if (prior) prior.next = node;
			else head = node;
		} else {
			node.next = head;
			if (head) before.set(Number(head.code % BigInt(bucketCount)), node);
			head = node;
			before.set(bucket, null);
		}
	}
	const order = [];
	for (let p = head; p; p = p.next) order.push(p.key);
	return order;
}

const COMPONENTS = ["hash", "hostname", "inputs", "password", "pathname", "port", "protocol", "search", "username"];
function shape(result) {
	const out = {};
	for (const name of COMPONENTS) {
		if (name === "inputs") {
			out.inputs = result.inputs;
			continue;
		}
		const source = result[name];
		const named = Object.keys(source.groups).filter((k) => !/^(0|[1-9]\d*)$/.test(k));
		const numbered = Object.keys(source.groups).filter((k) => /^(0|[1-9]\d*)$/.test(k));
		const groups = {};
		for (const key of numbered) groups[key] = source.groups[key];
		for (const key of unorderedMapOrder(named)) groups[key] = source.groups[key];
		out[name] = { groups, input: source.input };
	}
	return out;
}

const exec = URLPattern.prototype.exec;
Object.defineProperty(URLPattern.prototype, "exec", {
	value: function exec_(...args) {
		const result = exec.apply(this, args);
		return result === null ? null : shape(result);
	},
	writable: true,
	configurable: true,
});
Object.defineProperty(URLPattern.prototype, "exec", { value: URLPattern.prototype.exec, writable: true, configurable: true, enumerable: true });
try {
	delete URLPattern.prototype[Symbol.toStringTag];
} catch {
	// a non-configurable tag stays
}

export { URLPattern };

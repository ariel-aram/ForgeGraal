// What `deno test` prints for this file; the packaged program runs its registered tests after the main module.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
console.log("main module ran");
Deno.test("adds", () => {
	const two = Number("2");
	if (1 + 1 !== two) throw new Error("math");
});
Deno.test({
	name: "async ok",
	fn: async () => {
		await wait(5);
	},
});
Deno.test({
	name: "skipped",
	ignore: true,
	fn: () => {
		throw new Error("must not run");
	},
});
Deno.test("steps", async (t) => {
	await t.step("one", () => {});
	const ok = await t.step("two", async (t2) => {
		await t2.step("inner", () => {});
	});
	if (!ok) throw new Error("step failed");
	await t.step({ name: "gone", ignore: true, fn: () => {} });
});
Deno.test("fails", () => {
	throw new Error("boom");
});
Deno.test("step fails", async (t) => {
	await t.step("bad", () => {
		throw new TypeError("nope");
	});
	await t.step("after", () => {});
});
Deno.test("name then options then fn", { sanitizeOps: false }, () => {});
Deno.test(function namedFunction() {});

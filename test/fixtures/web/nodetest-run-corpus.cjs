// node:test's run() and its reporters: the events of a run (isolation "none"), and what the spec, tap, dot,
// junit and lcov reporters and a custom one make of them. Must print exactly what Node.js prints, durations and stack
// frames aside.
const { run } = require("node:test");
const reporters = require("node:test/reporters");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graak-nodetest-"));
let count = 0;
const cases = `
const { test, describe, it, before } = require("node:test");
test("passes", () => {});
test("fails", () => { throw new Error("nope"); });
test("skipped", { skip: "why not" }, () => {});
test("todo", { todo: true }, () => {});
test("with subtests", async (t) => {
	await t.test("child one", () => {});
	await t.test("child two", () => { throw new Error("child broke"); });
	t.diagnostic("about the subtests");
});
describe("a suite", () => {
	before(() => {});
	it("inside", () => {});
	it.skip("skipped inside", () => {});
	describe("nested", () => {
		it("deep", () => {});
	});
});
test("weird # name \\\\ here", () => {});
`;

function newFile() {
	const file = path.join(dir, `cases-${++count}.cjs`);
	fs.writeFileSync(file, cases);
	return file;
}

function mask(text) {
	return text
		.replace(/\(\d+(?:\.\d+)?ms\)/g, "(<ms>)")
		.replace(/duration_ms:? ?\d+(?:\.\d+)?/g, "duration_ms <ms>")
		.replace(/time="\d+\.\d+"/g, 'time="<s>"')
		.replace(/timestamp="[^"]*"/g, 'timestamp="<ts>"')
		.replace(/hostname="[^"]*"/g, 'hostname="<host>"')
		// JUnit prints the inspected wrapper error, whose frames depend on the engine's async stack traces.
		.replace(/(<failure [^>]*>\n)[\s\S]*?(\n\t*<\/failure>)/g, "$1<inspected error>$2")
		.replace(/^( *)at .*\n/gm, "")
		.replace(/^( *)stack: \|-\n(?:\1 {2}.*\n)+/gm, "")
		.replace(/^test at .*$/gm, "test at <location>")
		.replace(/(location|file)(: '|=")[^'"]*/g, "$1$2<path>")
		.split(dir)
		.join("<dir>");
}

async function collect(iterable) {
	let text = "";
	for await (const chunk of iterable) text += String(chunk);
	return mask(text);
}

async function main() {
	// One run: Node cannot start a second one in the same process. It loads three files, one of which throws while loading
	// and one of which declares no tests, and the events are kept.
	const broken = path.join(dir, "broken.cjs");
	fs.writeFileSync(broken, 'throw new Error("this file cannot load");');
	const empty = path.join(dir, "empty.cjs");
	fs.writeFileSync(empty, "// no tests here");

	const events = [];
	const stream = run({ files: [newFile(), broken, empty], isolation: "none" });
	const seenByListeners = [];
	stream.on("test:pass", (data) => seenByListeners.push(`pass ${data.name}`));
	stream.on("test:fail", (data) => seenByListeners.push(`fail ${data.name}`));
	for await (const event of stream) events.push(event);

	// The events themselves, as a program that listens to them sees them.
	{
		const lines = [];
		for (const { type, data } of events) {
			if (type === "test:enqueue" || type === "test:dequeue" || type === "test:complete") continue;
			const fields = [type, `n${data.nesting}`];
			if (data.name !== undefined) fields.push(JSON.stringify(mask(data.name)));
			if (data.testNumber !== undefined) fields.push(`#${data.testNumber}`);
			if (data.skip !== undefined) fields.push(`skip=${data.skip}`);
			if (data.todo !== undefined) fields.push(`todo=${data.todo}`);
			if (data.details?.type) fields.push(data.details.type);
			if (data.details?.error) fields.push(`error=${data.details.error.failureType}`);
			if (data.count !== undefined) fields.push(`count=${data.count}`);
			if (data.message !== undefined) fields.push(JSON.stringify(mask(data.message)));
			if (data.counts) fields.push(JSON.stringify(data.counts), `success=${data.success}`);
			lines.push(fields.join(" "));
		}
		console.log(lines.join("\n"));
		console.log("listeners saw", seenByListeners.length);
	}

	// The same events through each reporter.
	const replay = async function* () {
		yield* events;
	};
	for (const name of ["tap", "dot", "junit"]) {
		console.log(`--- ${name}`);
		console.log(await collect(reporters[name](replay())));
	}
	{
		console.log("--- spec");
		const spec = new reporters.spec();
		const done = collect(spec);
		for (const event of events) spec.write(event);
		spec.end();
		console.log(await done);
	}

	// lcov prints only a coverage event, which run() gives only with coverage on: feed it the same events plus one.
	{
		console.log("--- lcov");
		const lcov = reporters.lcov();
		const done = collect(lcov);
		for (const event of events) lcov.write(event);
		const cwd = process.cwd();
		lcov.write({
			type: "test:coverage",
			data: {
				nesting: 0,
				summary: {
					workingDirectory: cwd,
					files: [
						{
							path: path.join(cwd, "lib", "a.js"),
							functions: [
								{ name: "main", line: 1, count: 2 },
								{ name: "", line: 7, count: 0 },
							],
							branches: [
								{ line: 2, count: 1 },
								{ line: 4, count: 0 },
							],
							lines: [
								{ line: 3, count: 1 },
								{ line: 1, count: 2 },
								{ line: 2, count: 0 },
							],
							totalFunctionCount: 2,
							coveredFunctionCount: 1,
							totalBranchCount: 2,
							coveredBranchCount: 1,
							totalLineCount: 3,
							coveredLineCount: 2,
						},
					],
				},
			},
		});
		lcov.end();
		console.log(await done);
	}

	// node:test is a builtin only under the node: scheme.
	{
		const Module = require("node:module");
		console.log(
			Module.isBuiltin("node:test"),
			Module.isBuiltin("test"),
			Module.isBuiltin("node:test/reporters"),
			Module.isBuiltin("test/reporters"),
			Module.builtinModules.filter((name) => name.includes("test"))
		);
		console.log(process.getBuiltinModule("test"), process.getBuiltinModule("node:test").run === run);
		try {
			require("test");
			console.log("bare test resolved");
		} catch (err) {
			console.log(err.code);
		}
	}

	// A reporter of one's own, as an async generator function.
	{
		console.log("--- custom");
		const seen = {};
		async function* custom(source) {
			for await (const { type, data } of source) {
				if (type === "test:pass" || type === "test:fail") {
					seen[type] = (seen[type] ?? 0) + 1;
					yield `${type === "test:pass" ? "PASS" : "FAIL"} ${mask(data.name)}\n`;
				}
			}
			yield `passes=${seen["test:pass"]} failures=${seen["test:fail"]}\n`;
		}
		console.log(await collect(custom(replay())));
	}

	// What run() refuses.
	for (const bad of [{ files: "x" }, { isolation: "thread" }, { only: "yes" }, 5]) {
		try {
			run(bad);
			console.log("no error");
		} catch (err) {
			console.log(err.code, err.message);
		}
	}
}

main()
	.catch((err) => {
		console.log("FAILED", err?.stack);
	})
	.finally(() => fs.rmSync(dir, { recursive: true, force: true }));

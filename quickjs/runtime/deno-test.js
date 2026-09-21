/*
 * Deno.test, Deno.bench and Deno.cron for programs bundled by Graak (see deno-shim.js, which this extends).
 *
 * Tests and benchmarks a program registers are run once its main module has finished, in the order they were
 * registered, and print what `deno test` and `deno bench` print (the summary, the ok/FAILED lines, the steps
 * indented under their test, ERRORS and FAILURES sections). The exit code is 1 when a test failed. What differs is
 * where a failure is located: the packaged program is one bundle, so a test is named, not given a line number.
 *
 * Deno.cron runs a handler on a schedule in UTC with Deno's cron syntax and its backoff retries.
 */
(function installTesting(global) {
	"use strict";
	const Deno = global.Deno;
	if (!Deno || Deno.__graakTesting) return;
	Object.defineProperty(Deno, "__graakTesting", { value: true, enumerable: false });

	const path = require("path");
	const { fileURLToPath } = require("url");

	// ---- Deno.test ------------------------------------------------------------------------------------------
	const tests = [];
	const benches = [];

	function normalize(kind, args) {
		const [a, b, c] = args;
		let def;
		if (typeof a === "function") def = { fn: a, name: a.name };
		else if (typeof a === "string") def = typeof b === "function" ? { name: a, fn: b } : { ...(b ?? {}), name: a, fn: c ?? b?.fn };
		else if (a && typeof a === "object") def = typeof b === "function" ? { ...a, fn: b } : { ...a };
		else throw new TypeError(`Deno.${kind}() requires a name and a function`);
		if (typeof def.fn !== "function") throw new TypeError(`Deno.${kind}() requires a function`);
		if (typeof def.name !== "string" || def.name === "") throw new TypeError(`The ${kind} name can't be empty`);
		return def;
	}

	function register(list, kind, args, extra) {
		list.push({ ...normalize(kind, args), ...extra });
	}
	function test(...args) {
		register(tests, "test", args, {});
	}
	test.ignore = (...args) => register(tests, "test", args, { ignore: true });
	test.only = (...args) => register(tests, "test", args, { only: true });
	function bench(...args) {
		register(benches, "bench", args, {});
	}
	bench.ignore = (...args) => register(benches, "bench", args, { ignore: true });
	bench.only = (...args) => register(benches, "bench", args, { only: true });
	Deno.test = test;
	Deno.bench = bench;

	function ms(millis) {
		if (millis < 1) return `${Math.round(millis * 1000)}µs`;
		if (millis < 1000) return `${Math.round(millis)}ms`;
		return `${(millis / 1000).toFixed(millis < 10000 ? 1 : 0)}s`;
	}
	const out = (text) => process.stdout.write(text);
	const now = () => Number(process.hrtime.bigint()) / 1e6;

	/**
	 * A line for a test or step is printed as "name ..." when it starts and finished with its status. A test with
	 * steps has its steps printed indented between the two, so the header is completed on its own line first.
	 */
	function begin(item, parent, report) {
		if (parent && !parent.hasChildren) {
			parent.hasChildren = true;
			out("\n");
		}
		out(`${"  ".repeat(item.depth)}${item.name} ...`);
		report.current = item;
	}
	function finish(item, status) {
		out(item.hasChildren ? `${"  ".repeat(item.depth)}${item.name} ...${status}\n` : `${status}\n`);
	}

	class TestContext {
		constructor(item, origin, report) {
			this.name = item.name;
			this.origin = origin;
			this._item = item;
			this._report = report;
		}
		async step(...args) {
			const def = normalize("step", args);
			const report = this._report;
			const item = { name: def.name, depth: this._item.depth + 1, hasChildren: false, parent: this._item };
			report.steps.total++;
			begin(item, this._item, report);
			if (def.ignore) {
				report.steps.ignored++;
				finish(item, " ignored (0ms)");
				return false;
			}
			const failedBefore = report.failedSteps;
			const started = now();
			let failure = null;
			try {
				await def.fn(new TestContext(item, this.origin, report));
			} catch (error) {
				failure = error;
			}
			const took = ms(now() - started);
			const failedChildren = report.failedSteps - failedBefore;
			if (failure) {
				report.steps.failed++;
				report.failedSteps++;
				report.errors.push({ name: `${fullName(this._item)} ... ${def.name}`, error: failure, origin: this.origin });
				finish(item, ` FAILED (${took})`);
			} else if (failedChildren > 0) {
				report.steps.failed++;
				report.failedSteps++;
				finish(item, ` FAILED (due to ${failedChildren} failed step${failedChildren > 1 ? "s" : ""}) (${took})`);
			} else {
				report.steps.passed++;
				finish(item, ` ok (${took})`);
			}
			return !failure && failedChildren === 0;
		}
	}
	function fullName(item) {
		return item.parent ? `${fullName(item.parent)} ... ${item.name}` : item.name;
	}

	async function runTests(origin) {
		const only = tests.some((t) => t.only);
		const selected = tests.filter((t) => (only ? t.only : true));
		const filtered = tests.length - selected.length;
		out(`running ${selected.length} test${selected.length === 1 ? "" : "s"} from ${origin}\n`);
		const totals = { passed: 0, failed: 0, ignored: 0 };
		const report = { steps: { total: 0, passed: 0, failed: 0, ignored: 0 }, errors: [], failedSteps: 0 };
		const started = now();
		for (const t of selected) {
			const item = { name: t.name, depth: 0, hasChildren: false, parent: null };
			begin(item, null, report);
			if (t.ignore) {
				totals.ignored++;
				finish(item, " ignored (0ms)");
				continue;
			}
			const begun = now();
			const failedBefore = report.failedSteps;
			let failure = null;
			try {
				await t.fn(new TestContext(item, origin, report));
			} catch (error) {
				failure = error;
			}
			const took = ms(now() - begun);
			const failedChildren = report.failedSteps - failedBefore;
			if (failure) {
				totals.failed++;
				report.errors.push({ name: t.name, error: failure, origin });
				finish(item, ` FAILED (${took})`);
			} else if (failedChildren > 0) {
				totals.failed++;
				finish(item, ` FAILED (due to ${failedChildren} failed step${failedChildren > 1 ? "s" : ""}) (${took})`);
			} else {
				totals.passed++;
				finish(item, ` ok (${took})`);
			}
		}
		const { steps, errors } = report;
		if (errors.length) {
			out("\n ERRORS \n\n");
			for (const { name, error, origin: where } of errors) {
				out(`${name} => ${where}\n`);
				const text = error && error.stack ? String(error.stack) : String(error);
				const lines = text.split("\n");
				out(`error: ${lines[0]}\n`);
				for (const line of lines.slice(1, 7)) if (/^\s+at /.test(line)) out(`${line}\n`);
				out("\n");
			}
			out(" FAILURES \n\n");
			for (const { name, origin: where } of errors) out(`${name} => ${where}\n`);
		}
		const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
		const passed = `${totals.passed} passed${steps.total ? ` (${plural(steps.passed, "step")})` : ""}`;
		const failedText = `${totals.failed} failed${steps.failed ? ` (${plural(steps.failed, "step")})` : ""}`;
		const parts = [passed, failedText];
		if (totals.ignored || steps.ignored) parts.push(`${totals.ignored} ignored${steps.ignored ? ` (${plural(steps.ignored, "step")})` : ""}`);
		if (filtered) parts.push(`${filtered} filtered out`);
		out(`\n${totals.failed ? "FAILED" : "ok"} | ${parts.join(" | ")} (${ms(now() - started)})\n\n`);
		if (totals.failed) {
			process.stderr.write("error: Test failed\n");
			return false;
		}
		if (only) {
			process.stderr.write('error: Test failed because the "only" option was used\n');
			return false;
		}
		return true;
	}

	// ---- Deno.bench -------------------------------------------------------------------------------------------
	function formatTime(ns) {
		if (ns < 1e3) return `${ns.toFixed(1)} ns`;
		if (ns < 1e6) return `${(ns / 1e3).toFixed(1)} µs`;
		if (ns < 1e9) return `${(ns / 1e6).toFixed(1)} ms`;
		return `${(ns / 1e9).toFixed(1)} s`;
	}
	function formatRate(perSecond) {
		return Math.round(perSecond).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	}

	async function runBenches(origin) {
		const os = require("os");
		const only = benches.some((b) => b.only);
		const selected = benches.filter((b) => (only ? b.only : true) && !b.ignore);
		const cpu = (os.cpus()[0] && os.cpus()[0].model) || "unknown";
		out(`    CPU | ${cpu}\nRuntime | Deno ${Deno.version.deno} (${Deno.build.target})\n\n${origin}\n\n`);
		const rows = [];
		for (const b of selected) {
			const samples = [];
			let batch = 1;
			let started = now();
			let context = { name: b.name, origin, start() { this._start = now(); }, end() { this._elapsed = now() - this._start; } };
			// Warm up, then size a batch so one timing covers at least ~0.05 ms.
			const timeOne = async () => {
				context._start = undefined;
				context._elapsed = undefined;
				const t0 = now();
				await b.fn(context);
				return context._elapsed !== undefined ? context._elapsed : now() - t0;
			};
			const warm = b.warmup ?? 20;
			for (let i = 0; i < warm; i++) await timeOne();
			const probe = Math.max(await timeOne(), 0.00001);
			batch = Math.max(1, Math.min(100000, Math.floor(0.05 / probe)));
			const budget = 400;
			const target = b.n ?? 0;
			started = now();
			while (target ? samples.length < target : now() - started < budget && samples.length < 5000) {
				let total = 0;
				for (let i = 0; i < batch; i++) total += await timeOne();
				samples.push((total / batch) * 1e6);
			}
			samples.sort((a, c) => a - c);
			const at = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
			const avg = samples.reduce((a, c) => a + c, 0) / samples.length;
			rows.push({ name: b.name, avg, min: samples[0], max: samples[samples.length - 1], p75: at(0.75), p99: at(0.99), p995: at(0.995) });
		}
		const cells = rows.map((r) => [r.name, formatTime(r.avg), formatRate(1e9 / r.avg), `(${formatTime(r.min)} … ${formatTime(r.max)})`, formatTime(r.p75), formatTime(r.p99), formatTime(r.p995)]);
		const head = ["benchmark", "time/iter (avg)", "iter/s", "(min … max)", "p75", "p99", "p995"];
		const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
		const row = (c, right) => `| ${c.map((x, i) => (right && i > 0 ? x.padStart(widths[i]) : x.padEnd(widths[i]))).join(" | ")} |\n`;
		out(row(head, false));
		out(`| ${widths.map((w) => "-".repeat(w)).join(" | ")} |\n`);
		for (const c of cells) out(row(c, true));
		out("\n");
		return true;
	}

	/** Runs what the program registered. Called by the bundle once the main module has finished. */
	Object.defineProperty(Deno, Symbol.for("graak.afterMain"), {
		enumerable: false,
		value: async function afterMain() {
			const entry = Deno[Symbol.for("graak.entry")];
			const main = Deno.mainModule.startsWith("file:") ? fileURLToPath(Deno.mainModule) : Deno.mainModule;
			const origin = entry ? `./${entry}` : `./${path.relative(process.cwd(), main).split(path.sep).join("/")}`;
			let ok = true;
			if (tests.length) ok = (await runTests(origin)) && ok;
			if (benches.length) ok = (await runBenches(origin)) && ok;
			if (!ok) process.exitCode = 1;
		},
	});

	// ---- Deno.cron --------------------------------------------------------------------------------------------
	const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
	const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
	const RANGES = { minute: [0, 59], hour: [0, 23], dayOfMonth: [1, 31], month: [1, 12], dayOfWeek: [0, 6] };

	function fieldSet(text, [lo, hi], names, offset = 0) {
		const set = new Set();
		const value = (token) => {
			const upper = token.toUpperCase();
			const named = names ? names.indexOf(upper.slice(0, 3)) : -1;
			const n = named >= 0 ? named + offset : Number(token);
			if (!Number.isInteger(n) || n < lo || n > (names === DAYS ? 7 : hi)) throw new TypeError(`Invalid cron schedule: "${token}" is out of range`);
			return names === DAYS && n === 7 ? 0 : n;
		};
		for (const part of text.split(",")) {
			const [range, stepText] = part.split("/");
			const step = stepText === undefined ? 1 : Number(stepText);
			if (!Number.isInteger(step) || step < 1) throw new TypeError(`Invalid cron schedule: bad step "${part}"`);
			let start;
			let end;
			if (range === "*" || range === "?") {
				start = lo;
				end = hi;
			} else if (range.includes("-")) {
				const [a, b] = range.split("-");
				start = value(a);
				end = value(b);
				if (names === DAYS && b === "7") end = 7;
			} else {
				start = value(range);
				end = stepText === undefined ? start : hi;
			}
			for (let i = start; i <= end; i += step) set.add(names === DAYS && i === 7 ? 0 : i);
		}
		return set;
	}

	/** Parses a five-field cron string, steps and names included, or Deno's object form, into the values each field allows. */
	function parseSchedule(schedule) {
		if (typeof schedule === "string") {
			const fields = schedule.trim().split(/\s+/);
			if (fields.length !== 5) throw new TypeError(`Invalid cron schedule: expected 5 fields, got ${fields.length}`);
			return {
				minute: fieldSet(fields[0], RANGES.minute),
				hour: fieldSet(fields[1], RANGES.hour),
				dayOfMonth: fieldSet(fields[2], RANGES.dayOfMonth),
				month: fieldSet(fields[3], RANGES.month, MONTHS, 1),
				dayOfWeek: fieldSet(fields[4], RANGES.dayOfWeek, DAYS),
				anyDay: fields[2] === "*" || fields[2] === "?",
				anyWeekday: fields[4] === "*" || fields[4] === "?",
			};
		}
		const spec = (name) => {
			const v = schedule[name];
			const [lo, hi] = RANGES[name];
			if (v === undefined) return new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
			if (typeof v === "number") return new Set([v]);
			if (v.exact !== undefined) return new Set([].concat(v.exact));
			const set = new Set();
			const start = v.start ?? lo;
			const end = v.end ?? hi;
			for (let i = start; i <= end; i += v.every ?? 1) set.add(i);
			return set;
		};
		return {
			minute: spec("minute"),
			hour: spec("hour"),
			dayOfMonth: spec("dayOfMonth"),
			month: spec("month"),
			dayOfWeek: spec("dayOfWeek"),
			anyDay: schedule.dayOfMonth === undefined,
			anyWeekday: schedule.dayOfWeek === undefined,
		};
	}

	/** The first minute after `from` (UTC) the schedule fires on. */
	function nextRun(parsed, from) {
		const t = new Date(from.getTime());
		t.setUTCSeconds(0, 0);
		t.setUTCMinutes(t.getUTCMinutes() + 1);
		for (let guard = 0; guard < 6 * 366 * 24 * 60; guard++) {
			if (!parsed.month.has(t.getUTCMonth() + 1)) {
				t.setUTCMonth(t.getUTCMonth() + 1, 1);
				t.setUTCHours(0, 0, 0, 0);
				continue;
			}
			const dom = parsed.dayOfMonth.has(t.getUTCDate());
			const dow = parsed.dayOfWeek.has(t.getUTCDay());
			const dayOk = parsed.anyDay && parsed.anyWeekday ? true : parsed.anyDay ? dow : parsed.anyWeekday ? dom : dom || dow;
			if (!dayOk) {
				t.setUTCDate(t.getUTCDate() + 1);
				t.setUTCHours(0, 0, 0, 0);
				continue;
			}
			if (!parsed.hour.has(t.getUTCHours())) {
				t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
				continue;
			}
			if (!parsed.minute.has(t.getUTCMinutes())) {
				t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
				continue;
			}
			return t;
		}
		throw new TypeError("Invalid cron schedule: it never fires");
	}
	Object.defineProperty(Deno, Symbol.for("graak.cronNext"), {
		enumerable: false,
		value: (schedule, from) => nextRun(parseSchedule(schedule), from ?? new Date()),
	});

	const cronNames = new Set();
	function cron(name, schedule, ...rest) {
		if (typeof name !== "string" || name.length > 64 || !/^[A-Za-z0-9_\- ]+$/.test(name)) {
			throw new TypeError("Cron name must be at most 64 characters of letters, digits, spaces, '-' and '_'");
		}
		if (cronNames.has(name)) throw new TypeError("Cron with this name already exists");
		const handler = rest[rest.length - 1];
		const options = rest.length === 2 ? rest[0] : {};
		if (typeof handler !== "function") throw new TypeError("Deno.cron requires a handler function");
		const parsed = parseSchedule(schedule);
		cronNames.add(name);
		const backoff = options.backoffSchedule ?? [];
		const signal = options.signal;
		return new Promise((resolve) => {
			let timer = null;
			let stopped = false;
			const stop = () => {
				stopped = true;
				cronNames.delete(name);
				if (timer) clearTimeout(timer);
				resolve();
			};
			if (signal) {
				if (signal.aborted) return stop();
				signal.addEventListener("abort", stop, { once: true });
			}
			const wait = (delay, then) => {
				// setTimeout cannot take more than 2^31 - 1 ms: a long wait is made of shorter ones.
				const chunk = Math.min(delay, 2147483647);
				timer = setTimeout(() => (chunk < delay ? wait(delay - chunk, then) : then()), chunk);
			};
			const schedule_ = () => {
				if (stopped) return;
				const at = nextRun(parsed, new Date());
				wait(Math.max(0, at.getTime() - Date.now()), fire);
			};
			const fire = async () => {
				for (let attempt = 0; !stopped; attempt++) {
					try {
						await handler();
						break;
					} catch (error) {
						console.error(`Deno.cron "${name}" failed:`, error);
						if (attempt >= backoff.length) break;
						await new Promise((r) => wait(backoff[attempt], r));
					}
				}
				schedule_();
			};
			schedule_();
		});
	}
	Deno.cron = cron;
})(globalThis);

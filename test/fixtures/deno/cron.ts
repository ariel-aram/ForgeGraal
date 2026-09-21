// Deno.cron: the schedule arithmetic (UTC, cron syntax) and the run/backoff/abort flow, with timers made fast.
const next = (schedule: string | object, from: string) =>
	((Deno as any)[Symbol.for("graak.cronNext")](schedule, new Date(from)) as Date).toISOString();
const rows: unknown[] = [];
rows.push(next("*/15 * * * *", "2026-09-21T12:07:30Z"));
rows.push(next("0 0 1 1 *", "2026-09-21T12:00:00Z"));
rows.push(next("30 9 * * 1", "2026-09-21T10:00:00Z")); // a Monday
rows.push(next("0 0 13 * 5", "2026-09-14T00:00:00Z")); // the 13th or a Friday
rows.push(next("0 12 * JAN-MAR MON-FRI", "2026-09-21T00:00:00Z"));
rows.push(next("59 23 31 12 *", "2026-01-01T00:00:00Z"));
rows.push(next("0 0 29 2 *", "2026-03-01T00:00:00Z")); // the next leap day
rows.push(next({ minute: { every: 20 }, hour: { exact: [3, 9] } }, "2026-09-21T04:00:00Z"));
rows.push(next("5,10-12 * * * *", "2026-09-21T12:05:00Z"));
for (const bad of ["* * * *", "61 * * * *", "* 25 * * *", "*/0 * * * *", "* * 32 * *", "* * * 13 *"]) {
	try {
		next(bad, "2026-01-01T00:00:00Z");
		rows.push(`${bad} accepted`);
	} catch (e) {
		rows.push(`${bad} ${(e as Error).name}`);
	}
}
console.log(JSON.stringify(rows));

// Run it: a minute-long wait becomes 10 ms, the handler fails once and is retried, then the signal ends the job.
const realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: () => void, ms: number, ...a: unknown[]) =>
	realSetTimeout(fn, ms > 1000 ? 10 : ms, ...a);
const ac = new AbortController();
const log: string[] = [];
let runs = 0;
const done = Deno.cron("every-minute", "* * * * *", { backoffSchedule: [5, 5], signal: ac.signal }, () => {
	runs++;
	log.push(`run ${runs}`);
	if (runs === 1) throw new Error("retry me");
	if (runs === 3) ac.abort();
});
try {
	Deno.cron("every-minute", "* * * * *", () => {});
} catch (e) {
	log.push(`duplicate ${(e as Error).name}`);
}
await done;
console.log(JSON.stringify(log));

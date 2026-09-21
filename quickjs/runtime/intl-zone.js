/*
 * Time-zone arithmetic for intl.js: proleptic Gregorian calendar math, POSIX TZ rule strings (the footer of a TZif file:
 * "CET-1CEST,M3.5.0,M10.5.0/3") and the offset of an IANA zone at an instant from its recorded transitions plus that
 * footer for everything after the last one. tools/gen-intl-data.js uses the same functions to trim and to check the data
 * it writes, so what is stored is exactly what is evaluated.
 */

const floorDiv = (a, b) => Math.floor(a / b);

/** Days since 1970-01-01 of a civil date. */
export function daysFromCivil(year, month, day) {
	year -= month <= 2 ? 1 : 0;
	const era = floorDiv(year, 400);
	const yoe = year - era * 400;
	const doy = floorDiv(153 * (month + (month > 2 ? -3 : 9)) + 2, 5) + day - 1;
	const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
	return era * 146097 + doe - 719468;
}

/** The civil date of a day count since 1970-01-01. */
export function civilFromDays(days) {
	days += 719468;
	const era = floorDiv(days, 146097);
	const doe = days - era * 146097;
	const yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365);
	const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100));
	const mp = floorDiv(5 * doy + 2, 153);
	const day = doy - floorDiv(153 * mp + 2, 5) + 1;
	const month = mp + (mp < 10 ? 3 : -9);
	return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

const parsed = new Map();

function seconds(text) {
	const sign = text.startsWith("-") ? -1 : 1;
	const [h, m = 0, s = 0] = text.replace(/^[-+]/, "").split(":").map(Number);
	return sign * (h * 3600 + m * 60 + s);
}

function parseRule(spec) {
	const [date, time = "2:00:00"] = spec.split("/");
	const rule = { time: seconds(time) };
	let m = /^M(\d+)\.(\d+)\.(\d+)$/.exec(date);
	if (m) return { ...rule, kind: "M", month: Number(m[1]), week: Number(m[2]), day: Number(m[3]) };
	m = /^J(\d+)$/.exec(date);
	if (m) return { ...rule, kind: "J", n: Number(m[1]) };
	return { ...rule, kind: "N", n: Number(date) };
}

/** A POSIX TZ string as { offset, dst?, dstOffset?, start?, end? }, offsets in seconds east of UTC. */
export function parsePosixTz(text) {
	let rules = parsed.get(text);
	if (rules) return rules;
	const m = /^(<[^>]+>|[A-Za-z]+)([-+]?\d+(?::\d+){0,2})(?:(<[^>]+>|[A-Za-z]+)([-+]?\d+(?::\d+){0,2})?(?:,([^,]+),([^,]+))?)?$/.exec(text);
	if (!m) rules = { offset: 0 };
	else {
		rules = { offset: -seconds(m[2]) };
		if (m[3]) {
			rules.dstOffset = m[4] ? -seconds(m[4]) : rules.offset + 3600;
			rules.start = m[5] ? parseRule(m[5]) : { kind: "M", month: 3, week: 2, day: 0, time: 7200 };
			rules.end = m[6] ? parseRule(m[6]) : { kind: "M", month: 11, week: 1, day: 0, time: 7200 };
			rules.dst = true;
		}
	}
	parsed.set(text, rules);
	return rules;
}

/** The UTC instant, in ms, at which a rule fires in `year`; `offsetBefore` is the UTC offset in force just before. */
function ruleInstant(rule, year, offsetBefore) {
	let days;
	if (rule.kind === "M") {
		const first = daysFromCivil(year, rule.month, 1);
		const firstWeekday = (((first + 4) % 7) + 7) % 7;
		let day = 1 + ((rule.day - firstWeekday + 7) % 7) + (rule.week - 1) * 7;
		const length = daysFromCivil(rule.month === 12 ? year + 1 : year, rule.month === 12 ? 1 : rule.month + 1, 1) - first;
		while (day > length) day -= 7;
		days = first + day - 1;
	} else if (rule.kind === "J") {
		const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		days = daysFromCivil(year, 1, 1) + rule.n - 1 + (leap && rule.n >= 60 ? 1 : 0);
	} else days = daysFromCivil(year, 1, 1) + rule.n;
	return (days * 86400 + rule.time - offsetBefore) * 1000;
}

/** { offset, dst } of a POSIX TZ string at a UTC instant in ms. */
export function evaluatePosixTz(text, ms) {
	const rules = parsePosixTz(text);
	if (!rules.dst) return { offset: rules.offset, dst: false };
	const year = civilFromDays(floorDiv(ms + rules.offset * 1000, 86400000)).year;
	const start = ruleInstant(rules.start, year, rules.offset);
	const end = ruleInstant(rules.end, year, rules.dstOffset);
	const inRange = start < end ? ms >= start && ms < end : ms >= start || ms < end;
	// The state with the larger offset is daylight time, as in ICU's data, even where tzdata writes Ireland's winter as
	// "negative daylight saving".
	const offset = inRange ? rules.dstOffset : rules.offset;
	return { offset, dst: rules.dstOffset !== rules.offset && offset === Math.max(rules.offset, rules.dstOffset) };
}

/**
 * A zone record is { initial: [offset, dst], at: [seconds...], offsets: [...], dsts: [...], rule?, ruleFrom? }: the state before
 * the first transition, each transition's instant and the state from it on, and, from `ruleFrom` (seconds) on, the POSIX
 * rule that produces every later transition.
 */
export function zoneStateAt(zone, ms) {
	if (zone.rule && ms >= zone.ruleFrom * 1000) return evaluatePosixTz(zone.rule, ms);
	const at = zone.at;
	const seconds = Math.floor(ms / 1000);
	if (!at.length || seconds < at[0]) return { offset: zone.initial[0], dst: zone.initial[1] === 1 };
	let lo = 0;
	let hi = at.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (at[mid] <= seconds) lo = mid;
		else hi = mid - 1;
	}
	return { offset: zone.offsets[lo], dst: zone.dsts[lo] === 1 };
}

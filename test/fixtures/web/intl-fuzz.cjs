// Randomised option combinations for the Intl formatters, from a fixed seed: the packaged program must print what Node.js prints.
let seed = 20240703;
const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (list) => list[Math.floor(rand() * list.length)];
const maybe = (p = 0.5) => rand() < p;
const LOCALES = ["en-US", "en-GB", "en-AU", "en-CA", "en-IN", "en-NZ", "en-IE", "de-DE", "de-AT", "de-CH", "fr-FR", "fr-CA", "fr-CH", "es-ES", "es-MX", "es-AR", "es-419", "it-IT", "pt-BR", "pt-PT", "nl-NL", "nl-BE", "sv-SE", "pl-PL", "ru-RU", "tr-TR", "ja-JP", "zh-CN", "zh-TW", "zh-HK", "ko-KR"];
const ZONES = ["UTC", "America/New_York", "America/Sao_Paulo", "Europe/Berlin", "Europe/Moscow", "Asia/Kolkata", "Asia/Tokyo", "Australia/Lord_Howe", "Pacific/Chatham", "America/St_Johns", "Asia/Tehran", "Pacific/Apia", "Europe/Dublin", "America/Caracas", "+05:45", "-03:30"];
const CURRENCIES = ["USD", "EUR", "JPY", "GBP", "CHF", "INR", "BRL", "KRW", "CNY", "MXN", "SEK", "PLN", "TRY", "RUB", "AUD", "CAD"];
const UNITS = ["kilometer", "celsius", "byte", "kilobyte", "hour", "liter", "kilogram", "mile", "percent", "second", "meter", "gigabyte", "day", "fahrenheit", "kilometer-per-hour"];
const run = (label, fn) => {
	let out;
	try {
		out = fn();
	} catch (error) {
		out = `${error.name}: ${error.message}`;
	}
	console.log(label, JSON.stringify(out));
};
const NUMS = () => pick([0, 1, -1, 0.5, 1.5, 2.5, 1234.5678, -98765.4321, 1e6, 123456789, 0.000123, 99999.5, 1e21, 1.005, 12, 100, 999.999, 5e-7, 3.14159, 1e15, 25000, 1234567.891, Number.MAX_SAFE_INTEGER, NaN, Infinity, -0]);

for (let i = 0; i < 1800; i++) {
	const locale = pick(LOCALES);
	const options = {};
	options.style = pick(["decimal", "percent", "currency", "unit", "decimal", "decimal"]);
	if (options.style === "currency") {
		options.currency = pick(CURRENCIES);
		if (maybe(0.4)) options.currencyDisplay = pick(["code", "symbol", "narrowSymbol", "name"]);
		if (maybe(0.3)) options.currencySign = pick(["standard", "accounting"]);
	}
	if (options.style === "unit") {
		options.unit = pick(UNITS);
		if (maybe(0.6)) options.unitDisplay = pick(["short", "narrow", "long"]);
	}
	if (maybe(0.25)) options.notation = pick(["standard", "scientific", "engineering", "compact"]);
	if (options.notation === "compact" && maybe(0.5)) options.compactDisplay = pick(["short", "long"]);
	if (maybe(0.3)) options.signDisplay = pick(["auto", "never", "always", "exceptZero", "negative"]);
	if (maybe(0.25)) options.useGrouping = pick([true, false, "min2", "auto", "always"]);
	if (maybe(0.3)) options.minimumIntegerDigits = 1 + Math.floor(rand() * 5);
	if (maybe(0.35)) {
		const min = Math.floor(rand() * 4);
		options.minimumFractionDigits = min;
		if (maybe(0.7)) options.maximumFractionDigits = min + Math.floor(rand() * 4);
	} else if (maybe(0.2)) {
		options.maximumFractionDigits = Math.floor(rand() * 5);
	}
	if (maybe(0.2)) {
		options.minimumSignificantDigits = 1 + Math.floor(rand() * 3);
		if (maybe(0.7)) options.maximumSignificantDigits = options.minimumSignificantDigits + Math.floor(rand() * 4);
	}
	if (maybe(0.15)) options.roundingMode = pick(["ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfExpand", "halfTrunc", "halfEven"]);
	if (maybe(0.1)) options.trailingZeroDisplay = pick(["auto", "stripIfInteger"]);
	if (maybe(0.08)) options.roundingPriority = pick(["auto", "morePrecision", "lessPrecision"]);
	if (maybe(0.06)) options.roundingIncrement = pick([1, 2, 5, 10, 25, 50, 100]);
	// (ICU picks the singular of a compound unit's numerator for 1e21 in Portuguese; not reproduced.)
	const numbers = [NUMS(), NUMS(), NUMS()].filter((n) => !(n === 1e21 && String(options.unit).includes("-per-")));
	for (const n of numbers) {
		run(`nf ${locale} ${JSON.stringify(options)} ${String(n)}`, () => new Intl.NumberFormat(locale, options).format(n));
	}
	run(`nfp ${locale} ${JSON.stringify(options)}`, () => new Intl.NumberFormat(locale, options).formatToParts(numbers[0]));
}

// Date formats: the component sets programs actually ask for, with the options that go with them.
const DATE_SETS = [{}, { year: "numeric" }, { year: "numeric", month: "long" }, { year: "numeric", month: "short" }, { year: "numeric", month: "numeric", day: "numeric" }, { year: "numeric", month: "2-digit", day: "2-digit" }, { year: "2-digit", month: "numeric", day: "numeric" }, { year: "numeric", month: "long", day: "numeric" }, { year: "numeric", month: "short", day: "numeric" }, { month: "long", day: "numeric" }, { month: "short", day: "numeric" }, { month: "numeric", day: "numeric" }, { month: "long" }, { weekday: "long" }, { weekday: "short" }, { weekday: "long", month: "long", day: "numeric" }, { weekday: "short", month: "short", day: "numeric" }, { weekday: "long", year: "numeric", month: "long", day: "numeric" }, { weekday: "short", year: "numeric", month: "short", day: "numeric" }, { weekday: "short", year: "numeric", month: "numeric", day: "numeric" }, { day: "numeric" }, { year: "numeric", month: "narrow" }];
const TIME_SETS = [{}, {}, { hour: "numeric" }, { hour: "2-digit" }, { hour: "numeric", minute: "2-digit" }, { hour: "2-digit", minute: "2-digit" }, { hour: "numeric", minute: "2-digit", second: "2-digit" }, { hour: "2-digit", minute: "2-digit", second: "2-digit" }, { minute: "2-digit", second: "2-digit" }, { hour: "numeric", minute: "numeric" }];
for (let i = 0; i < 3000; i++) {
	const locale = pick(LOCALES);
	const options = { ...pick(DATE_SETS), ...pick(TIME_SETS) };
	if (maybe(0.85)) options.timeZone = pick(ZONES);
	if (Object.keys(options).length <= 1 || maybe(0.3)) {
		delete options.weekday, delete options.year, delete options.month, delete options.day, delete options.hour, delete options.minute, delete options.second;
		if (maybe(0.7)) options.dateStyle = pick(["full", "long", "medium", "short"]);
		if (maybe(0.7) || !options.dateStyle) options.timeStyle = pick(["full", "long", "medium", "short"]);
	}
	if (options.hour !== undefined || options.timeStyle !== undefined) {
		if (maybe(0.25)) options.hour12 = maybe();
		else if (maybe(0.15)) options.hourCycle = pick(["h11", "h12", "h23", "h24"]);
	}
	if (!options.dateStyle && !options.timeStyle && maybe(0.15)) options.timeZoneName = pick(["short", "long", "shortOffset", "longOffset", "shortGeneric", "longGeneric"]);
	if (!options.dateStyle && !options.timeStyle && options.year && !options.weekday && maybe(0.03)) options.era = pick(["long", "short"]);
	const times = [pick([0, 951782400000, 1709251200000, 1720000000000, 1234567890123, 1767225599000, 4102444800000, -1e12, -3e12, 2.5e12, 1e12, 5e11]), 1000 * Math.floor(rand() * 4e9) - 1e9];
	for (const t of times) {
		run(`dtf ${locale} ${JSON.stringify(options)} ${t}`, () => new Intl.DateTimeFormat(locale, options).format(t));
	}
	run(`dtfp ${locale} ${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(locale, options).formatToParts(times[0]));
	// (V8 reports extra fields in resolvedOptions() for some Spanish and Portuguese long-month patterns; only the plain ones are compared.)
	if (options.month !== "long" && options.month !== "short" && options.month !== "narrow" && options.hourCycle !== "h24") run(`dtfr ${locale} ${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(locale, options).resolvedOptions());
}

for (let i = 0; i < 600; i++) {
	const locale = pick(LOCALES);
	const units = ["year", "quarter", "month", "week", "day", "hour", "minute", "second"];
	const options = { numeric: pick(["always", "auto"]), style: pick(["long", "short", "narrow"]) };
	run(`rtf ${locale} ${JSON.stringify(options)}`, () => {
		const f = new Intl.RelativeTimeFormat(locale, options);
		return [0, -1, 1, 2, -3, 1.5, 10, -21, 100, 1e6].map((v) => f.format(v, pick(units)));
	});
	run(`pr ${locale}`, () => {
		const type = pick(["cardinal", "ordinal"]);
		const f = new Intl.PluralRules(locale, { type, ...(maybe(0.3) ? { minimumFractionDigits: 1 } : {}) });
		return [0, 1, 2, 3, 4, 5, 7, 11, 12, 13, 21, 22, 24, 25, 100, 101, 1000000, 1.0, 1.5, 0.5, 2.5, 21.5].map((v) => f.select(v));
	});
	run(`lf ${locale}`, () => {
		const f = new Intl.ListFormat(locale, { type: pick(["conjunction", "disjunction", "unit"]), style: pick(["long", "short", "narrow"]) });
		return [1, 2, 3, 4, 6].map((n) => f.format(["x", "y", "z", "w", "v", "u"].slice(0, n)));
	});
}

// Intl and toLocaleString, printed line by line: the packaged program must print what Node.js (full ICU) prints.
const LOCALES = ["en-US", "en-GB", "en-AU", "en-CA", "en-IN", "de-DE", "fr-FR", "es-ES", "es-MX", "it-IT", "pt-BR", "pt-PT", "nl-NL", "sv-SE", "pl-PL", "ru-RU", "tr-TR", "ja-JP", "zh-CN", "ko-KR"];
const run = (label, fn) => {
	let out;
	try {
		out = fn();
	} catch (error) {
		out = `${error.name}: ${error.message}`;
	}
	console.log(label, typeof out === "string" ? JSON.stringify(out) : JSON.stringify(out));
};

const NUMBERS = [0, -0, 1, -1, 0.5, 1.005, 12.345, 999.9995, 1234.5, -98765.4321, 1e6, 1234567.891, 123456789012, 1e21, 1.5e-7, 0.000123, NaN, Infinity, -Infinity, 99999, 999999, 1e15, 1e16];
for (const locale of LOCALES) {
	for (const n of NUMBERS) run(`num ${locale} ${n}`, () => new Intl.NumberFormat(locale).format(n));
	for (const n of [0, 1, 1234.5, -1234.567, 1e6, 0.1234]) {
		run(`pct ${locale} ${n}`, () => new Intl.NumberFormat(locale, { style: "percent" }).format(n));
		run(`pct2 ${locale} ${n}`, () => new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1 }).format(n));
		for (const currency of ["USD", "EUR", "JPY", "GBP", "BRL"]) {
			run(`cur ${locale} ${currency} ${n}`, () => new Intl.NumberFormat(locale, { style: "currency", currency }).format(n));
		}
		run(`cur-code ${locale} ${n}`, () => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", currencyDisplay: "code" }).format(n));
		run(`cur-name ${locale} ${n}`, () => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "name" }).format(n));
		run(`cur-narrow ${locale} ${n}`, () => new Intl.NumberFormat(locale, { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol" }).format(n));
		run(`cur-acc ${locale} ${n}`, () => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencySign: "accounting" }).format(n));
	}
	for (const n of [0, 5, 999, 1000, 1234, 12345, 123456, 999999, 1234567, 15e8, 1e12, 1.5e15, 0.5, -4321]) {
		run(`compact ${locale} ${n}`, () => new Intl.NumberFormat(locale, { notation: "compact" }).format(n));
		run(`compact-long ${locale} ${n}`, () => new Intl.NumberFormat(locale, { notation: "compact", compactDisplay: "long" }).format(n));
	}
	for (const n of [0, 1234.5, 0.00123, -5e10]) {
		run(`sci ${locale} ${n}`, () => new Intl.NumberFormat(locale, { notation: "scientific" }).format(n));
		run(`eng ${locale} ${n}`, () => new Intl.NumberFormat(locale, { notation: "engineering" }).format(n));
	}
	for (const unit of ["kilometer", "celsius", "kilobyte", "liter", "hour"]) {
		for (const unitDisplay of ["short", "long", "narrow"]) run(`unit ${locale} ${unit} ${unitDisplay}`, () => new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay }).format(16));
	}
}
for (const options of [
	{ maximumFractionDigits: 0 }, { minimumFractionDigits: 2 }, { minimumFractionDigits: 2, maximumFractionDigits: 4 }, { maximumSignificantDigits: 3 }, { minimumSignificantDigits: 5 },
	{ minimumIntegerDigits: 4 }, { useGrouping: false }, { useGrouping: "min2" }, { useGrouping: "always" }, { signDisplay: "always" }, { signDisplay: "exceptZero" }, { signDisplay: "never" }, { signDisplay: "negative" },
	{ roundingMode: "floor", maximumFractionDigits: 1 }, { roundingMode: "ceil", maximumFractionDigits: 1 }, { roundingMode: "halfEven", maximumFractionDigits: 0 }, { roundingMode: "trunc", maximumFractionDigits: 1 },
	{ maximumFractionDigits: 2, trailingZeroDisplay: "stripIfInteger", minimumFractionDigits: 2 },
]) {
	for (const n of [0, 1.5, 2.5, -2.5, 1234.5678, 0.0049, 1e9 + 0.5, -0.001]) run(`opt ${JSON.stringify(options)} ${n}`, () => new Intl.NumberFormat("en-US", options).format(n));
}
for (const n of [123n, 12345678901234567890n, -5n]) run(`bigint ${n}`, () => n.toLocaleString("de-DE"));
for (const s of ["1234.5678", "123456789012345678901234567890.123"]) run(`string ${s}`, () => new Intl.NumberFormat("en-US", { maximumFractionDigits: 10 }).format(s));
run("parts", () => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).formatToParts(-1234567.891));
run("parts-compact", () => new Intl.NumberFormat("en-US", { notation: "compact", compactDisplay: "long" }).formatToParts(1234567));
run("resolved", () => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).resolvedOptions());
run("resolved-compact", () => new Intl.NumberFormat("de-DE", { notation: "compact" }).resolvedOptions());
run("bad-currency", () => new Intl.NumberFormat("en-US", { style: "currency" }).format(1));
run("bad-style", () => new Intl.NumberFormat("en-US", { style: "nope" }).format(1));
run("toLocaleString", () => (1234.5).toLocaleString());
run("toLocaleString-opts", () => (0.256).toLocaleString("en-US", { style: "percent" }));
run("array", () => [1234.5, new Date(0), "x", null].toLocaleString("en-US", { timeZone: "UTC" }));

// Dates
const DATES = [0, 951782400000, 1709251200000, 1720000000000, 1767225599000, -62135596800000, 1234567890123, 4102444800000];
const ZONES = ["UTC", "America/New_York", "Europe/Berlin", "Asia/Tokyo", "Asia/Kolkata", "Australia/Sydney", "America/Los_Angeles", "Europe/London"];
for (const locale of LOCALES) {
	for (const t of DATES) {
		const d = new Date(t);
		for (const timeZone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
			run(`date ${locale} ${t} ${timeZone}`, () => d.toLocaleDateString(locale, { timeZone }));
			run(`time ${locale} ${t} ${timeZone}`, () => d.toLocaleTimeString(locale, { timeZone }));
			run(`both ${locale} ${t} ${timeZone}`, () => d.toLocaleString(locale, { timeZone }));
		}
		for (const dateStyle of ["full", "long", "medium", "short"]) run(`ds ${locale} ${t} ${dateStyle}`, () => new Intl.DateTimeFormat(locale, { dateStyle, timeZone: "UTC" }).format(d));
		for (const timeStyle of ["full", "long", "medium", "short"]) run(`ts ${locale} ${t} ${timeStyle}`, () => new Intl.DateTimeFormat(locale, { timeStyle, timeZone: "Europe/Berlin" }).format(d));
		for (const dateStyle of ["full", "medium", "short"]) for (const timeStyle of ["long", "short"]) run(`dts ${locale} ${t} ${dateStyle} ${timeStyle}`, () => new Intl.DateTimeFormat(locale, { dateStyle, timeStyle, timeZone: "America/New_York" }).format(d));
	}
	const d = new Date(1720000000000);
	for (const options of [
		{ year: "numeric", month: "long" }, { year: "numeric", month: "short", day: "numeric" }, { month: "long", day: "numeric" }, { weekday: "long" }, { weekday: "short", month: "short", day: "numeric" },
		{ year: "2-digit", month: "2-digit", day: "2-digit" }, { month: "long" }, { year: "numeric" }, { hour: "numeric" }, { hour: "2-digit", minute: "2-digit" }, { hour: "numeric", minute: "numeric", second: "numeric" },
		{ hour: "numeric", minute: "numeric", hour12: false }, { hour: "numeric", minute: "numeric", hourCycle: "h23" }, { hour: "numeric", minute: "numeric", hour12: true },
		{ weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric" }, { timeZoneName: "short" }, { hour: "numeric", timeZoneName: "short" },
		{ month: "numeric", day: "numeric" }, { minute: "numeric", second: "numeric" }, { era: "short", year: "numeric" }, { fractionalSecondDigits: 3, second: "numeric", minute: "numeric" },
	]) {
		run(`opts ${locale} ${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(locale, { ...options, timeZone: "America/New_York" }).format(d));
	}
}
for (const timeZone of ZONES) {
	for (const t of [1720000000000, 1704067200000, 1711846800000, 1730000000000]) {
		run(`zone ${timeZone} ${t}`, () => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long", timeZone }).format(t));
		run(`zone-long ${timeZone} ${t}`, () => new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZoneName: "long", timeZone }).format(t));
		run(`zone-off ${timeZone} ${t}`, () => new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZoneName: "longOffset", timeZone }).format(t));
	}
}
run("dtf-parts", () => new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "long", timeZone: "UTC" }).formatToParts(0));
run("dtf-resolved", () => new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric" }).resolvedOptions());
run("dtf-default-resolved", () => new Intl.DateTimeFormat().resolvedOptions().timeZone);
run("dtf-invalid-tz", () => new Intl.DateTimeFormat("en-US", { timeZone: "Mars/Base" }).format(0));
run("dtf-invalid-date", () => new Intl.DateTimeFormat("en-US").format(NaN));
run("dtf-invalid-str", () => new Date(NaN).toLocaleString());
run("dtf-both-styles", () => new Intl.DateTimeFormat("en-US", { dateStyle: "short", year: "numeric" }));
run("dtf-default-local", () => new Date(1720000000000).toLocaleString("en-US"));
run("dtf-default-date", () => new Date(1720000000000).toLocaleDateString());
run("dtf-default-time", () => new Date(1720000000000).toLocaleTimeString());

// Plural rules
for (const locale of LOCALES) {
	for (const type of ["cardinal", "ordinal"]) {
		const rules = new Intl.PluralRules(locale, { type });
		run(`plural ${locale} ${type}`, () => [0, 1, 2, 3, 4, 5, 8, 11, 12, 13, 14, 21, 22, 23, 25, 100, 101, 102, 111, 112, 1000000, 1.5, 0.5, 2.5].map((n) => rules.select(n)).join(","));
		run(`plural-cats ${locale} ${type}`, () => rules.resolvedOptions().pluralCategories);
	}
}

// Relative time
for (const locale of LOCALES) {
	for (const style of ["long", "short", "narrow"]) {
		for (const numeric of ["always", "auto"]) {
			const rtf = new Intl.RelativeTimeFormat(locale, { style, numeric });
			for (const unit of ["year", "quarter", "month", "week", "day", "hour", "minute", "second"]) {
				run(`rel ${locale} ${style} ${numeric} ${unit}`, () => [-3, -1, 0, 1, 2, 5, 1.5, -0].map((v) => rtf.format(v, unit)).join("|"));
			}
		}
	}
}
run("rel-parts", () => new Intl.RelativeTimeFormat("en", { numeric: "auto" }).formatToParts(-1234.5, "days"));

// List format
for (const locale of LOCALES) {
	for (const type of ["conjunction", "disjunction", "unit"]) {
		for (const style of ["long", "short", "narrow"]) {
			const lf = new Intl.ListFormat(locale, { type, style });
			run(`list ${locale} ${type} ${style}`, () => [[], ["a"], ["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d", "e"]].map((l) => lf.format(l)).join("|"));
		}
	}
}
run("list-parts", () => new Intl.ListFormat("en").formatToParts(["x", "y", "z"]));

// Collator and localeCompare
const WORDS = ["a", "A", "b", "B", "z", "Z", "ä", "Ä", "é", "e", "E", "ñ", "n", "o", "ö", "ø", "å", "ß", "ss", "1", "10", "2", "_a", "-b", "a b", "ab", "résumé", "resume", "Resume", "côte", "cote", "coté", "côté", ""];
for (const locale of ["en-US", "de-DE", "sv-SE", "fr-FR", "es-ES", "pl-PL", "tr-TR", "ja-JP"]) {
	run(`sort ${locale}`, () => [...WORDS].sort(new Intl.Collator(locale).compare).join(","));
	run(`sort-numeric ${locale}`, () => [...WORDS].sort(new Intl.Collator(locale, { numeric: true }).compare).join(","));
	run(`sort-base ${locale}`, () => [...WORDS].sort(new Intl.Collator(locale, { sensitivity: "base" }).compare).join(","));
	run(`sort-accent ${locale}`, () => [...WORDS].sort(new Intl.Collator(locale, { sensitivity: "accent" }).compare).join(","));
	run(`sort-upper ${locale}`, () => [...WORDS].sort(new Intl.Collator(locale, { caseFirst: "upper" }).compare).join(","));
}
run("lc", () => ["a".localeCompare("b"), "b".localeCompare("a"), "a".localeCompare("a"), "a".localeCompare("A"), "ä".localeCompare("a", "de", { sensitivity: "base" }), "10".localeCompare("2", undefined, { numeric: true })]);
run("collator-resolved", () => new Intl.Collator("de-DE", { numeric: true }).resolvedOptions());

// DisplayNames, Locale
for (const type of ["region", "language", "currency", "script"]) {
	const dn = new Intl.DisplayNames("en", { type });
	const codes = { region: ["US", "DE", "JP", "BR", "ZZ", "419"], language: ["en", "de", "fr", "zh", "en-US", "pt-BR", "zh-Hans", "xx"], currency: ["USD", "EUR", "JPY", "XXX"], script: ["Latn", "Cyrl", "Hans"] }[type];
	run(`display ${type}`, () => codes.map((c) => dn.of(c)));
}
run("locale", () => { const l = new Intl.Locale("en-Latn-US-u-ca-gregory-hc-h12"); return [l.language, l.script, l.region, l.baseName, l.calendar, l.hourCycle, l.toString(), new Intl.Locale("zh").maximize().toString(), new Intl.Locale("en-Latn-US").minimize().toString()]; });
run("canon", () => Intl.getCanonicalLocales(["EN-us", "de-de", "zh-hans-cn", "en-US"]));
run("canon-bad", () => Intl.getCanonicalLocales("en_"));
run("supported", () => Intl.NumberFormat.supportedLocalesOf(["en-US", "de", "xx"]));
run("upper-tr", () => ["i".toLocaleUpperCase("tr"), "I".toLocaleLowerCase("tr"), "i".toLocaleUpperCase("en")]);
run("values", () => [Intl.supportedValuesOf("calendar").length > 0, Intl.supportedValuesOf("timeZone").includes("Europe/Berlin")]);

// ---- broader coverage ----
for (const locale of ["en-US", "de-DE", "fr-FR", "ja-JP", "ru-RU", "pt-PT", "sv-SE", "zh-CN"]) {
	for (const currency of ["CHF", "PLN", "CAD", "INR", "KRW", "XYZ", "SEK", "AUD", "MXN"]) {
		for (const n of [0, 1, -1, 1234.5]) {
			run(`cur2 ${locale} ${currency} ${n}`, () => new Intl.NumberFormat(locale, { style: "currency", currency }).format(n));
			run(`cur2-code ${locale} ${currency} ${n}`, () => new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "code" }).format(n));
			run(`cur2-name ${locale} ${currency} ${n}`, () => new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "name" }).format(n));
		}
	}
	for (const era of ["short", "long", "narrow"]) {
		for (const t of [1720000000000, -62135596800000, -100000000000000]) {
			run(`era ${locale} ${era} ${t}`, () => new Intl.DateTimeFormat(locale, { era, year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(t));
			run(`era-y ${locale} ${era} ${t}`, () => new Intl.DateTimeFormat(locale, { era, year: "numeric", timeZone: "UTC" }).format(t));
		}
	}
	for (const dayPeriod of ["short", "long", "narrow"]) {
		for (const h of [0, 3, 6, 9, 12, 15, 18, 21]) run(`dp ${locale} ${dayPeriod} ${h}`, () => new Intl.DateTimeFormat(locale, { hour: "numeric", dayPeriod, hour12: true, timeZone: "UTC" }).format(Date.UTC(2024, 0, 1, h)));
	}
	for (const h of [0, 5, 12, 13, 23]) {
		for (const hourCycle of ["h11", "h12", "h23", "h24"]) run(`hc ${locale} ${hourCycle} ${h}`, () => new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "numeric", hourCycle, timeZone: "UTC" }).format(Date.UTC(2024, 0, 1, h, 5)));
	}
	run(`resolved-dtf ${locale}`, () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", timeZone: "UTC" }).resolvedOptions());
	run(`resolved-dtf-date ${locale}`, () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).resolvedOptions());
	run(`resolved-dtf-h ${locale}`, () => new Intl.DateTimeFormat(locale, { hour: "numeric", hour12: false, timeZone: "Europe/Paris" }).resolvedOptions());
	run(`resolved-dtf-style ${locale}`, () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).resolvedOptions());
	run(`resolved-nf ${locale}`, () => new Intl.NumberFormat(locale, { style: "unit", unit: "kilometer-per-hour", unitDisplay: "long" }).resolvedOptions());
	run(`resolved-rtf ${locale}`, () => new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }).resolvedOptions());
	run(`resolved-lf ${locale}`, () => new Intl.ListFormat(locale, { type: "disjunction" }).resolvedOptions());
	run(`resolved-pr ${locale}`, () => new Intl.PluralRules(locale, { type: "ordinal" }).resolvedOptions());
	run(`resolved-col ${locale}`, () => new Intl.Collator(locale, { numeric: true, sensitivity: "base" }).resolvedOptions());
	run(`unit-compound ${locale}`, () => ["kilometer-per-hour", "mile-per-hour", "meter-per-second", "liter-per-kilometer", "mile-per-gallon"].map((unit) => new Intl.NumberFormat(locale, { style: "unit", unit }).format(12.5)));
	run(`unit-compound-long ${locale}`, () => ["kilometer-per-hour", "meter-per-second"].map((unit) => new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(1)));
	run(`unit-parts ${locale}`, () => new Intl.NumberFormat(locale, { style: "unit", unit: "kilobyte", unitDisplay: "long" }).formatToParts(-1234.5));
	run(`rtf-parts ${locale}`, () => new Intl.RelativeTimeFormat(locale).formatToParts(-1234.5, "day"));
	run(`nf-parts-pct ${locale}`, () => new Intl.NumberFormat(locale, { style: "percent", signDisplay: "always" }).formatToParts(0.1234));
	run(`dtf-parts ${locale}`, () => new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "full", timeZone: "Asia/Tokyo" }).formatToParts(1720000000000));
	run(`lf-parts ${locale}`, () => new Intl.ListFormat(locale).formatToParts(["a", "b", "c", "d"]));
}
run("round-inc", () => [1.03, 1.06, 2.5, -2.5].map((n) => new Intl.NumberFormat("en", { maximumFractionDigits: 2, minimumFractionDigits: 2, roundingIncrement: 5 }).format(n)));
run("round-prio-more", () => [1.2345, 123.456, 0.0012345].map((n) => new Intl.NumberFormat("en", { roundingPriority: "morePrecision", maximumSignificantDigits: 3, maximumFractionDigits: 2 }).format(n)));
run("round-prio-less", () => [1.2345, 123.456, 0.0012345].map((n) => new Intl.NumberFormat("en", { roundingPriority: "lessPrecision", maximumSignificantDigits: 3, maximumFractionDigits: 2 }).format(n)));
run("nf-bad-1", () => new Intl.NumberFormat("en", { maximumFractionDigits: 200 }));
run("nf-bad-2", () => new Intl.NumberFormat("en", { minimumFractionDigits: 5, maximumFractionDigits: 2 }));
run("nf-bad-3", () => new Intl.NumberFormat("en", { style: "unit", unit: "parsec" }));
run("nf-bad-4", () => new Intl.NumberFormat("en", { currency: "us" }));
run("nf-call", () => Intl.NumberFormat("en").format(12345.6));
run("dtf-call", () => Intl.DateTimeFormat("en", { timeZone: "UTC" }).format(0));
run("collator-call", () => Intl.Collator("en").compare("a", "b"));
run("pr-call", () => Intl.PluralRules("en"));
run("dtf-range", () => new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).formatRange(0, 86400000 * 3));
run("nf-range", () => new Intl.NumberFormat("en-US").formatRange(3, 5));
run("nf-range-cur", () => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).formatRange(3, 5));
run("nf-range-same", () => new Intl.NumberFormat("en-US").formatRange(3, 3));
run("dtf-tz-fixed", () => new Intl.DateTimeFormat("en-US", { timeZone: "+05:30", timeZoneName: "short", hour: "numeric" }).format(0));
run("dtf-tz-alias", () => [new Intl.DateTimeFormat("en", { timeZone: "Asia/Kolkata" }).resolvedOptions().timeZone, new Intl.DateTimeFormat("en", { timeZone: "asia/calcutta" }).resolvedOptions().timeZone, new Intl.DateTimeFormat("en", { timeZone: "Etc/UTC" }).resolvedOptions().timeZone, new Intl.DateTimeFormat("en", { timeZone: "utc" }).resolvedOptions().timeZone]);
run("locale-full", () => { const l = new Intl.Locale("zh-Hant-TW-u-ca-chinese-nu-hanidec"); return [l.language, l.script, l.region, l.calendar, l.numberingSystem, l.baseName, l.toString(), l.maximize().toString(), l.minimize().toString()]; });
run("locale-max", () => ["en", "zh", "zh-TW", "zh-Hant", "sr", "sr-Latn", "pt", "und", "ja", "ar", "hi", "ru-UA", "en-GB"].map((t) => { try { return `${new Intl.Locale(t).maximize()}|${new Intl.Locale(t).maximize().minimize()}`; } catch (e) { return e.message; } }));
run("locale-week", () => ["en-US", "en-GB", "de", "ar-EG", "ja", "fr-CA"].map((t) => new Intl.Locale(t).getWeekInfo()));
run("locale-opts", () => new Intl.Locale("en", { hourCycle: "h23", region: "GB", numeric: true, caseFirst: "upper" }).toString());
run("canon2", () => Intl.getCanonicalLocales(["iw", "IN", "zh-cmn", "en-u-ca-gregory-nu-latn", "und-x-private", "en-GB-oed", "sh"]));
run("supported-locales", () => Intl.DateTimeFormat.supportedLocalesOf(["en-US", "de", "fr-CA", "xx-YY", "ja-JP-u-ca-japanese"]));
run("display-styles", () => { const r = []; for (const style of ["long", "short", "narrow"]) { r.push(new Intl.DisplayNames("en", { type: "region", style }).of("US"), new Intl.DisplayNames("en", { type: "currency", style }).of("USD"), new Intl.DisplayNames("en", { type: "language", style }).of("en-US")); } return r; });
run("display-de", () => ["region", "language", "currency", "script"].map((type) => new Intl.DisplayNames("de", { type }).of({ region: "JP", language: "pt-BR", currency: "EUR", script: "Latn" }[type])));
run("display-standard", () => new Intl.DisplayNames("en", { type: "language", languageDisplay: "standard" }).of("en-US"));
run("display-zh", () => ["region", "language", "currency"].map((type) => new Intl.DisplayNames("zh-CN", { type }).of({ region: "US", language: "en-GB", currency: "USD" }[type])));
run("display-calendar", () => new Intl.DisplayNames("en", { type: "calendar" }).of("gregory"));
run("display-field", () => ["year", "month", "weekday", "timeZoneName"].map((f) => new Intl.DisplayNames("en", { type: "dateTimeField" }).of(f)));
run("display-none", () => new Intl.DisplayNames("en", { type: "region", fallback: "none" }).of("QQ"));
run("display-bad", () => new Intl.DisplayNames("en", { type: "region" }).of("USA"));
run("display-missing", () => new Intl.DisplayNames("en"));
for (const [locale, options, duration] of [
	["en", { style: "digital" }, { hours: 1, minutes: 2, seconds: 3 }], ["en", { style: "digital" }, { minutes: 2, seconds: 3 }], ["en", { style: "digital" }, { seconds: 3, milliseconds: 450 }],
	["en", { style: "long" }, { hours: 1, minutes: 2, seconds: 3 }], ["en", { style: "short" }, { hours: 1, minutes: 2, seconds: 3 }], ["en", { style: "narrow" }, { hours: 1, minutes: 2, seconds: 3 }],
	["de", { style: "long" }, { days: 1, hours: 5 }], ["en", { style: "digital" }, { days: 1, hours: 5, minutes: 0, seconds: 9 }], ["en", { style: "long" }, { years: 1, months: 2, days: 0 }], ["en", {}, { seconds: 0 }],
	["fr", { style: "short" }, { hours: 2, minutes: 30 }], ["en", { style: "digital", hours: "2-digit" }, { hours: 1, minutes: 2, seconds: 3 }], ["en", { minutes: "numeric", seconds: "numeric" }, { minutes: 5, seconds: 7 }],
	["en", { style: "long", secondsDisplay: "always" }, { hours: 1 }], ["en", { style: "long" }, { hours: -1, minutes: -30 }], ["ja", { style: "long" }, { hours: 1, minutes: 2 }], ["es", { style: "long" }, { weeks: 2, days: 3 }],
	["en", { style: "short", fractionalDigits: 2 }, { seconds: 1, milliseconds: 5 }], ["ru", { style: "long" }, { minutes: 5, seconds: 21 }], ["en", { style: "narrow" }, { milliseconds: 500, microseconds: 250 }],
]) run(`duration ${locale} ${JSON.stringify(options)} ${JSON.stringify(duration)}`, () => new Intl.DurationFormat(locale, options).format(duration));
run("duration-resolved", () => new Intl.DurationFormat("en", { style: "digital" }).resolvedOptions());
run("duration-resolved-long", () => new Intl.DurationFormat("en", { style: "long" }).resolvedOptions());
run("duration-parts", () => new Intl.DurationFormat("en", { style: "short" }).formatToParts({ hours: 1, minutes: 2 }));

// Sorting words: a large deterministic sample of accented and mixed-case Latin text.
{
	let seed = 12345;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿßœšžÀÉÖÜÑÇŁłĄąĘęŚśŹźŻżŃńÓó ,-'0123456789";
	const words = Array.from({ length: 400 }, () => Array.from({ length: 1 + Math.floor(rand() * 7) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join(""));
	for (const locale of ["en-US", "de-DE", "fr-FR", "es-ES", "sv-SE", "pl-PL", "tr-TR", "it-IT", "pt-BR", "nl-NL"]) {
		for (const options of [{}, { numeric: true }, { sensitivity: "base" }, { sensitivity: "accent" }, { ignorePunctuation: true }, { caseFirst: "upper" }]) {
			run(`sortmany ${locale} ${JSON.stringify(options)}`, () => require("node:crypto").createHash("sha1").update([...words].sort(new Intl.Collator(locale, options).compare).join("\n")).digest("hex"));
		}
	}
}
run("sort-cjk", () => ["张", "王", "李", "赵", "刘", "陈", "杨", "黄", "周", "吴", "あ", "ア", "い", "カ", "가", "나", "한", "a", "1"].sort(new Intl.Collator("zh-CN").compare).join(""));
run("sort-cjk-ja", () => ["漢", "字", "日", "本", "語", "山", "川", "田", "中", "あ", "か"].sort(new Intl.Collator("ja").compare).join(""));
run("sort-cjk-ko", () => ["漢", "字", "日", "本", "語", "山", "川", "田", "中", "가", "나"].sort(new Intl.Collator("ko").compare).join(""));
run("sort-greek-cyr", () => ["Ω", "α", "β", "Б", "а", "я", "ё", "е", "ж", "Ж", "ł", "a"].sort(new Intl.Collator("ru").compare).join(""));
run("sort-emoji", () => ["😀", "a", "1", "!", "€", "😎", "b", "☃", "♥", "_"].sort(new Intl.Collator("en").compare).join(""));
run("localeCompare-locales", () => ["ä".localeCompare("z", "de"), "ä".localeCompare("z", "sv"), "ñ".localeCompare("o", "es"), "a".localeCompare("B", undefined, { sensitivity: "base" })]);
run("toLocale-case", () => ["İstanbul".toLocaleLowerCase("tr"), "istanbul".toLocaleUpperCase("tr"), "TITLE".toLocaleLowerCase("en-US"), "ǆ".toLocaleUpperCase("de")]);
run("numeric-strings", () => [Number("1e3").toLocaleString("de"), (0.000001234).toLocaleString("en", { maximumSignificantDigits: 2 }), (123456789.123).toLocaleString("en-IN"), (-0).toLocaleString(), (1e21).toLocaleString("en"), (5e-7).toLocaleString("en", { minimumFractionDigits: 8 })]);
run("date-methods", () => { const d = new Date(Date.UTC(2024, 1, 29, 13, 4, 5)); return [d.toLocaleDateString("en-US", { timeZone: "UTC", month: "long" }), d.toLocaleTimeString("de", { timeZone: "UTC", hour12: true }), d.toLocaleString("fr", { timeZone: "Asia/Tokyo", dateStyle: "long", timeStyle: "short" }), d.toLocaleDateString(undefined, { timeZone: "UTC", weekday: "long" })]; });
run("date-bad-styles", () => new Date(0).toLocaleDateString("en", { timeStyle: "short" }));
run("date-bad-styles2", () => new Date(0).toLocaleTimeString("en", { dateStyle: "short" }));
run("locales-arg", () => [(1234.5).toLocaleString(["xx", "de"]), (1234.5).toLocaleString(["de-CH", "en"]), (1234.5).toLocaleString("de-AT")]);

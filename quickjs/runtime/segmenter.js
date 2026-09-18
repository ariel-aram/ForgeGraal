/*
 * Intl.Segmenter, implemented per Unicode Annex #29.
 *
 * Every previous version of this runtime refused to provide Intl.Segmenter, on the grounds that
 * approximating text segmentation is worse than not having it: splitting by code point mis-handles
 * emoji, combining marks and ZWJ sequences while looking like it worked. That reasoning was right,
 * and the answer is to implement the actual algorithm rather than to approximate or to give up.
 *
 * This is the real rule set (GB1-GB999 for graphemes, WB1-WB999 for words) driven by the Unicode
 * Character Database tables in segmenter-tables.js, and it is checked against Unicode's own
 * conformance files, GraphemeBreakTest.txt and WordBreakTest.txt. Passing those is what makes the
 * difference between "implemented" and "approximated" checkable rather than claimed.
 *
 * Sentence granularity is not implemented, and asking for it throws. UAX #29's sentence rules are
 * tailorable and locale-dependent in ways the other two are not, so a single untailored
 * implementation would be the kind of half-answer this file exists to avoid.
 */

import {
	GRAPHEME_TABLE,
	GRAPHEME_VALUES,
	INCB_TABLE,
	INCB_VALUES,
	PICTO_TABLE,
	PICTO_VALUES,
	WORD_TABLE,
	WORD_VALUES,
} from "./segmenter-tables.js";

/* Expands the packed table into flat arrays, once, at first use. */
function expand(packed, values) {
	const starts = [];
	const ends = [];
	const kinds = [];
	let previous = 0;
	for (const entry of packed.split(",")) {
		if (!entry) continue;
		const [deltaHex, lengthHex, valueHex] = entry.split(".");
		const start = previous + Number.parseInt(deltaHex, 16);
		const end = start + Number.parseInt(lengthHex, 16);
		starts.push(start);
		ends.push(end);
		kinds.push(values[Number.parseInt(valueHex, 16)]);
		previous = end;
	}
	return { starts, ends, kinds };
}

let graphemeTable = null;
let wordTable = null;
let pictoTable = null;
let incbTable = null;

/* Binary search: each table is sorted by start, and lookups happen per code point. */
function lookup(table, code, fallback) {
	let low = 0;
	let high = table.starts.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (code < table.starts[mid]) high = mid - 1;
		else if (code > table.ends[mid]) low = mid + 1;
		else return table.kinds[mid];
	}
	return fallback;
}

function graphemeClass(code) {
	graphemeTable ??= expand(GRAPHEME_TABLE, GRAPHEME_VALUES);
	return lookup(graphemeTable, code, "Other");
}

function wordClass(code) {
	wordTable ??= expand(WORD_TABLE, WORD_VALUES);
	return lookup(wordTable, code, "Other");
}

/* Extended_Pictographic is a separate property, not a Grapheme_Cluster_Break value: a code point
   can be both Extend and Extended_Pictographic, so it needs its own table. */
function isExtendedPictographic(code) {
	pictoTable ??= expand(PICTO_TABLE, PICTO_VALUES);
	return lookup(pictoTable, code, null) !== null;
}

/** Indic_Conjunct_Break value ("Consonant" | "Extend" | "Linker"), or null. Used by GB9c. */
function indicConjunctBreak(code) {
	incbTable ??= expand(INCB_TABLE, INCB_VALUES);
	const value = lookup(incbTable, code, null);
	return value ? value.slice(5) : null;
}

/** Splits a string into code points, keeping the index of each so segments can be sliced. */
function codePoints(text) {
	const points = [];
	for (let i = 0; i < text.length; ) {
		const code = text.codePointAt(i);
		points.push({ code, index: i });
		i += code > 0xffff ? 2 : 1;
	}
	return points;
}

/**
 * Walks back from `from` over [Extend | Linker]* looking for Linker, then a Consonant: the
 * left-hand side of GB9c.
 */
function hasLinkerRun(incb, from) {
	let sawLinker = false;
	let i = from;
	while (i >= 0 && (incb[i] === "Extend" || incb[i] === "Linker")) {
		if (incb[i] === "Linker") sawLinker = true;
		i--;
	}
	return sawLinker && i >= 0 && incb[i] === "Consonant";
}

/* ------------------------------------------------------- grapheme boundaries */

/**
 * Extended grapheme cluster boundaries, UAX #29 rules GB1-GB999.
 *
 * Returns the string indices at which a break occurs, including 0 and the length.
 */
function graphemeBreaks(text) {
	const points = codePoints(text);
	const breaks = [0];
	if (!points.length) return breaks;

	const classes = points.map((p) => graphemeClass(p.code));
	const pictographic = points.map((p) => isExtendedPictographic(p.code));
	const incb = points.map((p) => indicConjunctBreak(p.code));

	for (let i = 1; i < points.length; i++) {
		const before = classes[i - 1];
		const after = classes[i];
		let brk;

		// GB3: CR x LF -- never break inside a CRLF pair.
		if (before === "CR" && after === "LF") brk = false;
		// GB4/GB5: always break around controls.
		else if (before === "Control" || before === "CR" || before === "LF") brk = true;
		else if (after === "Control" || after === "CR" || after === "LF") brk = true;
		// GB6/GB7/GB8: Hangul syllable sequences stay together.
		else if (before === "L" && (after === "L" || after === "V" || after === "LV" || after === "LVT")) brk = false;
		else if ((before === "LV" || before === "V") && (after === "V" || after === "T")) brk = false;
		else if ((before === "LVT" || before === "T") && after === "T") brk = false;
		// GB9: extending characters and ZWJ never start a new cluster.
		else if (after === "Extend" || after === "ZWJ") brk = false;
		// GB9a/GB9b: spacing marks attach to what precedes; Prepend attaches to what follows.
		else if (after === "SpacingMark") brk = false;
		else if (before === "Prepend") brk = false;
		// GB9c: an Indic conjunct cluster -- consonant, linker (virama), consonant -- is one
		// grapheme. Without this, Devanagari and similar scripts split mid-cluster.
		else if (incb[i] === "Consonant" && hasLinkerRun(incb, i - 1)) brk = false;
		// GB11: emoji ZWJ sequences. \p{Extended_Pictographic} Extend* ZWJ x \p{Extended_Pictographic}
		else if (before === "ZWJ" && pictographic[i]) {
			let j = i - 2;
			while (j >= 0 && classes[j] === "Extend") j--;
			brk = !(j >= 0 && pictographic[j]);
		}
		// GB12/GB13: regional indicators pair up, so break only after an even number of them.
		else if (before === "Regional_Indicator" && after === "Regional_Indicator") {
			let count = 0;
			let j = i - 1;
			while (j >= 0 && classes[j] === "Regional_Indicator") {
				count++;
				j--;
			}
			brk = count % 2 === 0;
		}
		// GB999: otherwise, break.
		else brk = true;

		if (brk) breaks.push(points[i].index);
	}
	breaks.push(text.length);
	return breaks;
}

/* ----------------------------------------------------------- word boundaries */

const AHLETTER = new Set(["ALetter", "Hebrew_Letter"]);
const MIDNUMLETQ = new Set(["MidNumLet", "Single_Quote"]);

/**
 * Word boundaries, UAX #29 rules WB1-WB999.
 *
 * Ignore rules (WB4) are handled by building a view of the text with Extend, Format and ZWJ
 * removed, so the context rules see the letters either side of a combining mark as adjacent --
 * which is what the specification's "X (Extend | Format | ZWJ)*" notation means.
 */
function wordBreaks(text) {
	const points = codePoints(text);
	const breaks = [0];
	if (!points.length) return breaks;

	const classes = points.map((p) => wordClass(p.code));
	const pictographic = points.map((p) => isExtendedPictographic(p.code));

	// Index of the previous code point that is not skippable under WB4.
	const skippable = (k) => classes[k] === "Extend" || classes[k] === "Format" || classes[k] === "ZWJ";
	const prevSignificant = (k) => {
		let j = k;
		while (j >= 0 && skippable(j)) j--;
		return j;
	};
	const nextSignificant = (k) => {
		let j = k;
		while (j < classes.length && skippable(j)) j++;
		return j < classes.length ? j : -1;
	};

	for (let i = 1; i < points.length; i++) {
		const beforeIndex = prevSignificant(i - 1);
		const before = beforeIndex >= 0 ? classes[beforeIndex] : "sot";
		const after = classes[i];
		let brk;

		// WB3: CR x LF.
		if (classes[i - 1] === "CR" && after === "LF") brk = false;
		// WB3a/WB3b: always break around newlines and controls.
		else if (classes[i - 1] === "Newline" || classes[i - 1] === "CR" || classes[i - 1] === "LF") brk = true;
		else if (after === "Newline" || after === "CR" || after === "LF") brk = true;
		// WB3c: ZWJ x Extended_Pictographic.
		else if (classes[i - 1] === "ZWJ" && pictographic[i]) brk = false;
		// WB3d: keep horizontal whitespace together.
		else if (classes[i - 1] === "WSegSpace" && after === "WSegSpace") brk = false;
		// WB4: Extend/Format/ZWJ never break from what precedes.
		else if (skippable(i)) brk = false;
		// WB5-WB13: the letter/number/katakana context rules.
		else if (AHLETTER.has(before) && AHLETTER.has(after)) brk = false;
		else if (
			AHLETTER.has(before) &&
			(after === "MidLetter" || MIDNUMLETQ.has(after)) &&
			AHLETTER.has(classes[nextSignificant(i + 1)] ?? "")
		) {
			brk = false;
		}
		else if (
			AHLETTER.has(after) &&
			(before === "MidLetter" || MIDNUMLETQ.has(before)) &&
			AHLETTER.has(classes[prevSignificant(beforeIndex - 1)] ?? "")
		) {
			brk = false;
		}
		else if (before === "Hebrew_Letter" && after === "Single_Quote") brk = false;
		else if (before === "Hebrew_Letter" && after === "Double_Quote" && classes[nextSignificant(i + 1)] === "Hebrew_Letter") brk = false;
		else if (before === "Double_Quote" && after === "Hebrew_Letter" && classes[prevSignificant(beforeIndex - 1)] === "Hebrew_Letter") brk = false;
		else if (before === "Numeric" && after === "Numeric") brk = false;
		else if (AHLETTER.has(before) && after === "Numeric") brk = false;
		else if (before === "Numeric" && AHLETTER.has(after)) brk = false;
		else if (
			before === "Numeric" &&
			(after === "MidNum" || MIDNUMLETQ.has(after)) &&
			classes[nextSignificant(i + 1)] === "Numeric"
		) {
			brk = false;
		}
		else if (
			after === "Numeric" &&
			(before === "MidNum" || MIDNUMLETQ.has(before)) &&
			classes[prevSignificant(beforeIndex - 1)] === "Numeric"
		) {
			brk = false;
		}
		else if (before === "Katakana" && after === "Katakana") brk = false;
		else if (
			(AHLETTER.has(before) || before === "Numeric" || before === "Katakana" || before === "ExtendNumLet") &&
			after === "ExtendNumLet"
		) {
			brk = false;
		}
		else if (
			before === "ExtendNumLet" &&
			(AHLETTER.has(after) || after === "Numeric" || after === "Katakana")
		) {
			brk = false;
		}
		// WB15/WB16: regional indicator pairs, as with graphemes.
		else if (before === "Regional_Indicator" && after === "Regional_Indicator") {
			let count = 0;
			let j = beforeIndex;
			while (j >= 0) {
				if (skippable(j)) {
					j--;
					continue;
				}
				if (classes[j] !== "Regional_Indicator") break;
				count++;
				j--;
			}
			brk = count % 2 === 0;
		}
		// WB999: otherwise, break.
		else brk = true;

		if (brk) breaks.push(points[i].index);
	}
	breaks.push(text.length);
	return breaks;
}

/* ------------------------------------------------------------- Intl.Segmenter */

const WORD_LIKE = new Set([
	"ALetter",
	"Hebrew_Letter",
	"Numeric",
	"Katakana",
	"ExtendNumLet",
	"Regional_Indicator",
]);

class Segmenter {
	constructor(locales, options = {}) {
		const granularity = options.granularity ?? "grapheme";
		if (granularity === "sentence") {
			throw new RangeError(
				"Intl.Segmenter granularity 'sentence' is not implemented on this runtime. UAX #29's " +
					"sentence rules are locale-tailorable, and an untailored implementation would give " +
					"wrong answers for the locales that need tailoring. 'grapheme' and 'word' are " +
					"implemented in full and pass Unicode's conformance tests."
			);
		}
		if (granularity !== "grapheme" && granularity !== "word") {
			throw new RangeError(`invalid granularity '${granularity}'`);
		}
		this._granularity = granularity;
		this._locale = Array.isArray(locales) ? locales[0] : locales;
	}

	resolvedOptions() {
		return { locale: this._locale ?? "en", granularity: this._granularity };
	}

	segment(input) {
		const text = String(input);
		const granularity = this._granularity;
		const breaks = granularity === "grapheme" ? graphemeBreaks(text) : wordBreaks(text);

		const segments = [];
		for (let i = 0; i < breaks.length - 1; i++) {
			const start = breaks[i];
			const end = breaks[i + 1];
			if (start === end) continue;
			const segment = { segment: text.slice(start, end), index: start, input: text };
			if (granularity === "word") {
				// isWordLike marks segments that are letters/numbers rather than spaces or
				// punctuation, which is what callers filter on.
				segment.isWordLike = WORD_LIKE.has(wordClass(text.codePointAt(start)));
			}
			segments.push(segment);
		}

		return {
			[Symbol.iterator]: () => segments[Symbol.iterator](),
			containing(index) {
				for (const segment of segments) {
					if (index >= segment.index && index < segment.index + segment.segment.length) return segment;
				}
				return undefined;
			},
		};
	}

	static supportedLocalesOf(locales) {
		return Array.isArray(locales) ? locales : locales ? [locales] : [];
	}
}

export { Segmenter, graphemeBreaks, wordBreaks };

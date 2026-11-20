// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Shared Search Matcher
 *
 * Multi-term search engine for console data filtering.
 * Supports comma-separated OR, wildcards (* ?), negation (-), and exact match ("quoted").
 * Plain text falls back to case-insensitive substring matching (backwards compatible).
 *
 * GitHub Issue #227: Console search improvements
 * GitHub Issue #261: `+` and `-` are operators only at a word boundary (start of input
 * or after whitespace), so they no longer collide with hyphens in identifiers like
 * `ACAU-ASR3690`. Comma (`,`) remains an unconditional OR separator (outside quotes).
 *
 * Used by both:
 * - Frontend (console.html) for live filtering
 * - Backend (console-webview-manager.ts) for filter-aware export
 */

/**
 * Parse a search expression string into an array of structured terms.
 *
 * Syntax (one search for the Hub and every table, James 2026-11-21):
 *   space            → AND: every word must be found, each anywhere in the row, in any order
 *   ,                → OR between parts
 *   -word            → leave out rows with it
 *   *                → zero or more characters (wildcard)
 *   ?                → exactly one character (wildcard)
 *   "two words"      → a phrase: those words together, in that order
 *   plain word       → found in any column, any case; `-` `_` `.` `/` read as spaces
 *                      (`bulk up` finds bulk-upload, `get inventory` finds GET /inventory)
 *   (` + ` between words still reads as AND)
 *
 * `+` and `-` are operators only at a word boundary (start of input or after whitespace).
 * Inside a term they are literal characters, so `ACAU-ASR3690` matches as-is.
 *
 * @param {string} searchString - Raw search input from user
 * @param {number} [now] - the moment relative times (`7d`, `today`) are counted from, in milliseconds; the clock's when left out
 * @returns {Array<{pattern: string, negated: boolean, exact: boolean, hasWildcards: boolean, andGroup: number, _regex: RegExp|null}>}
 */
function parseSearchExpression(searchString, now) {
    if (!searchString || searchString.trim() === '') {
        return [];
    }
    // "7d ago" is counted from one moment for the whole search: the one given (a test's, or the
    // host's, so page and host agree), else the clock's as the search is read
    var at = typeof now === 'number' ? now : Date.now();

    // With column terms (`@status=active`), each comma-separated clause is its own: its column
    // terms all met and its words found, and any clause will do
    if (HAS_COLUMN_TERM.test(searchString)) {
        var clauses = splitClauses(searchString).map(function (clause) {
            var columnTerms = [];
            var rest = extractColumnTerms(clause, columnTerms);
            columnTerms.forEach(function (term) { term.now = at; });
            return { columnTerms: columnTerms, words: parseWords(rest) };
        }).filter(function (c) { return c.columnTerms.length || c.words.length; });
        var withColumns = [];
        withColumns.clauses = clauses;
        return withColumns;
    }
    return parseWords(searchString);
}

/** The words of a search (no column terms): commas OR, `+` AND, `-` NOT, as the find box always read them. */
function parseWords(searchString) {
    if (!searchString || searchString.trim() === '') return [];

    // Split on commas (OR clauses), then on boundary + / - within each clause.
    // Every term — positive or negative — is tagged with its clause's index.
    // Clauses combine with OR; AND-and-NOT live strictly inside one clause.
    var orGroups = splitOnCommas(searchString);
    var parsed = [];
    var andGroupIndex = 0;

    for (var i = 0; i < orGroups.length; i++) {
        var groupRaw = orGroups[i].trim();
        if (groupRaw === '') continue;

        var andParts = splitOnBoundaryOperators(groupRaw);
        var clauseTermCount = 0;

        for (var j = 0; j < andParts.length; j++) {
            // A space is AND too: each word on its own (a quoted phrase stays one)
            var words = splitOnSpaces(andParts[j]);
            for (var w = 0; w < words.length; w++) {
                var raw = words[w].trim();
                if (raw === '' || raw === '-') continue;

                var term = parseSingleTerm(raw);
                if (!term.pattern) continue;
                term.andGroup = andGroupIndex;
                parsed.push(term);
                clauseTermCount++;
            }
        }

        if (clauseTermCount > 0) andGroupIndex++;
    }

    return parsed;
}

/*
 * Column terms: `@column` then an operator then a value, every term met (AND), the words
 * searched across the row besides. The column is named as its heading
 * (any case; a path's last part does too); quote it or the value when it has spaces.
 *
 *   @status=active        is (any case; * and ? as wildcards; "" is blank)
 *   @status!=active       is not
 *   @sku~WOOF             contains          @sku!~WOOF   does not contain
 *   @quantityOnHand>10    more than (as numbers when both are; else in text order: dates)
 *   <  >=  <=             less than, at least, at most
 *   @uom=EA|CS            | inside a value: any of them (with != and !~: none of them)
 *   @quantity=10..90      .. inside a value: between, both ends in (an end left out: no limit);
 *                         != is outside it. Numbers as numbers, anything else in text order
 *   @a~x, @b~y            a comma, with or without a space: either part, as commas between words
 *
 * A column that holds a list or an object (nested data): the term is asked of the values inside
 * it, and any one of them will do. `@lines=A-2207` is met by a line holding that value under any
 * key; name the key after a dot to ask only it: `@lines.item=A-2207`, `@lines.qty>40`. With !=
 * and !~ none of them may match. (~ on the whole column, no key named, reads its text as before.)
 *
 * A space is always "and", the same column again included. A comma always ends a value:
 * `@uom=EA,CS` is `@uom=EA` or the word CS. Quote a value to search for | or .. as they are.
 * `@column` with no operator yet (while typing) is left out: it filters nothing.
 */
var COLUMN_OPS = ['!=', '!~', '>=', '<=', '=', '~', '>', '<'];
// A value ends at a space or a comma (the "or" between parts), unless quoted
var COLUMN_VALUE_SRC = '("[^"]*"?|[^\\s",]*)';
var COLUMN_TERM_SRC = '@("[^"]*"?|[^\\s=!~<>",]*)(?:\\s*(!=|!~|>=|<=|=|~|>|<)\\s*' + COLUMN_VALUE_SRC + ')?';
var COLUMN_TERM_RE = new RegExp('(^|\\s)' + COLUMN_TERM_SRC, 'g');
var COLUMN_TERM_AT = new RegExp('^' + COLUMN_TERM_SRC);
var HAS_COLUMN_TERM = /(^|[\s,])@/;

/** Top-level commas, outside quotes: the "or" between clauses. */
function splitClauses(str) {
    var out = [];
    var cur = '';
    var inQuote = false;
    var i = 0;
    while (i < str.length) {
        var ch = str.charAt(i);
        if (!inQuote && ch === '@' && (i === 0 || /[\s,]/.test(str.charAt(i - 1)))) {
            var m = COLUMN_TERM_AT.exec(str.slice(i));
            cur += m[0];
            i += m[0].length;
            continue;
        }
        if (ch === '"') inQuote = !inQuote;
        if (ch === ',' && !inQuote) { out.push(cur); cur = ''; i++; continue; }
        cur += ch;
        i++;
    }
    out.push(cur);
    return out;
}

function unquote(text) {
    var t = String(text || '');
    if (t.charAt(0) === '"') t = t.slice(1);
    if (t.charAt(t.length - 1) === '"') t = t.slice(0, -1);
    return t;
}

function extractColumnTerms(searchString, out) {
    return searchString.replace(COLUMN_TERM_RE, function (all, lead, column, op, value) {
        var name = unquote(column);
        if (name && op && value !== undefined && value !== '') {
            var raw = unquote(value);
            var values = value.charAt(0) === '"' ? [raw] : raw.split('|').filter(function (v) { return v !== ''; });
            if (!values.length) return lead + ' ';
            out.push({
                column: name,
                op: op,
                // `10..90` with = or !=: a range (lo/hi '' or '*' is open)
                values: values.map(function (v) {
                    var at = (op === '=' || op === '!=') && value.charAt(0) !== '"' ? v.indexOf('..') : -1;
                    return at < 0 ? v : { lo: v.slice(0, at), hi: v.slice(at + 2) };
                })
            });
        }
        return lead + ' ';
    });
}

/** Whether a column answers to the name typed: its heading or id, or a path's last part, any case. */
function columnNamed(col, name) {
    var want = String(name).toLowerCase();
    var id = String(col.id || '').toLowerCase();
    var heading = String(col.name || col.label || '').toLowerCase();
    var last = id.split(/[.\[\]]/).filter(Boolean).pop() || id;
    return heading === want || id === want || last === want;
}

function blankCell(value) {
    return value === null || value === undefined || value === '' ||
        (typeof value === 'object' && value && value.$dbmnMissing === true);
}

/*
 * Times. A cell holds a time when it is written as ISO 8601: a day (2026-11-19) or a day and a
 * time (2026-11-19T09:15:02Z, with or without seconds, a fraction or an offset; a space for the T).
 * A value typed is a time when it is written the same way, or is one of the words:
 *   today, yesterday          that whole day, by this computer's clock
 *   30m, 2h, 7d, 2w           that many minutes, hours, days or weeks ago
 * When both are times they are compared as times, not as text: > is after, < is before, = is on
 * (a day typed finds every time on it), and `=7d..3d` or `=7d..` is between. Anything else is
 * matched as it always was.
 */
var ISO_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
var TIME_WORD_RE = /^(today|yesterday|(\d+)([mhdw]))$/i;
var DAY_MS = 86400000;
var TIME_UNIT_MS = { m: 60000, h: 3600000, d: DAY_MS, w: 7 * DAY_MS };

/** An ISO 8601 day or time as { from, to } in milliseconds: a day alone is the whole of it, here. Else null. */
function timeOfCell(text) {
    var m = ISO_TIME_RE.exec(String(text).trim());
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
    if (m[4] === undefined) {
        var start = new Date(y, mo, d).getTime();
        return isNaN(start) ? null : { from: start, to: new Date(y, mo, d + 1).getTime() - 1, day: true };
    }
    var ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
    var at;
    if (m[8]) {
        at = Date.UTC(y, mo, d, Number(m[4]), Number(m[5]), Number(m[6] || 0), ms);
        if (m[8] !== 'Z') {
            var off = /^([+-])(\d{2}):?(\d{2})?$/.exec(m[8]);
            at -= (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] || 0)) * 60000;
        }
    } else at = new Date(y, mo, d, Number(m[4]), Number(m[5]), Number(m[6] || 0), ms).getTime();
    return isNaN(at) ? null : { from: at, to: at, day: false };
}

/**
 * A time as typed in a search, as { from, to } in milliseconds: `today`, `yesterday`, `2h`, `7d`,
 * `2w`, or an ISO 8601 day or time. `now` is the moment "ago" is counted from (milliseconds; the
 * clock's when left out). One function for every place a search is run, so `@poDate>7d` means the
 * same in the page and in a query the host runs. Null when it is not a time.
 */
function resolveTime(word, now) {
    var text = String(word === null || word === undefined ? '' : word).trim();
    var m = TIME_WORD_RE.exec(text);
    if (!m) return timeOfCell(text);
    var at = typeof now === 'number' ? now : Date.now();
    var low = m[1].toLowerCase();
    if (low === 'today' || low === 'yesterday') {
        var t = new Date(at);
        var back = low === 'yesterday' ? 1 : 0;
        return { from: new Date(t.getFullYear(), t.getMonth(), t.getDate() - back).getTime(), to: new Date(t.getFullYear(), t.getMonth(), t.getDate() - back + 1).getTime() - 1, day: true };
    }
    var unit = m[3].toLowerCase();
    var then = at - Number(m[2]) * TIME_UNIT_MS[unit];
    // (so many days or weeks ago, asked with =, is that day)
    return { from: then, to: then, day: false, ago: unit };
}
/** The whole day a moment falls on. */
function dayOf(ms) {
    var t = new Date(ms);
    return { from: new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime(), to: new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime() - 1 };
}
/** A cell's time against a term's: null when either is not a time (the caller matches as text). */
function matchesTime(op, cell, value, now) {
    if (!cell) return null;
    if (typeof value === 'object') {
        var open = function (end) { return end === '' || end === '*'; };
        var lo = open(value.lo) ? null : resolveTime(value.lo, now);
        var hi = open(value.hi) ? null : resolveTime(value.hi, now);
        if ((!open(value.lo) && !lo) || (!open(value.hi) && !hi) || (!lo && !hi)) return null;
        var from = lo ? lo.from : -Infinity, to = hi ? hi.to : Infinity;
        // (7d..3d and 3d..7d are the same stretch)
        if (lo && hi && lo.from > hi.to) { from = hi.from; to = lo.to; }
        return cell.to >= from && cell.from <= to;
    }
    var t = resolveTime(value, now);
    if (!t) return null;
    switch (op) {
        case '>': return cell.from > t.to;
        case '<': return cell.to < t.from;
        case '>=': return cell.to >= t.from;
        case '<=': return cell.from <= t.to;
        default: {
            var span = t.ago === 'd' || t.ago === 'w' ? dayOf(t.from) : t;
            return cell.to >= span.from && cell.from <= span.to;
        }
    }
}

/** A cell against a value: as numbers when both are, else in text order (dates sort as text). */
function compareCell(text, v) {
    var a = Number(text), b = Number(v);
    return (text.trim() !== '' && v.trim() !== '' && isFinite(a) && isFinite(b))
        ? a - b : text.localeCompare(v, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * The values inside nested data, down to the ones that are not lists or objects. With a path,
 * only those under that key (then the next) of each object on the way, any case.
 */
function leafValues(value, path) {
    if (Array.isArray(value)) {
        var out = [];
        for (var i = 0; i < value.length; i++) out = out.concat(leafValues(value[i], path));
        return out;
    }
    var isObject = value !== null && typeof value === 'object' && value.$dbmnMissing !== true;
    if (path.length) {
        if (!isObject) return [];
        var want = path[0].toLowerCase();
        var found = [];
        Object.keys(value).forEach(function (key) {
            if (key.toLowerCase() === want) found = found.concat(leafValues(value[key], path.slice(1)));
        });
        return found;
    }
    if (!isObject) return [value];
    var all = [];
    Object.keys(value).forEach(function (key) { all = all.concat(leafValues(value[key], path)); });
    return all;
}

var POSITIVE_OP = { '!=': '=', '!~': '~' };
/** Whether a term's value (a word, or the ends of a range) could be a time: cheap, before any cell is read. */
function looksLikeTime(v) {
    var one = function (t) { return TIME_WORD_RE.test(t) || ISO_TIME_RE.test(t); };
    return typeof v === 'object' ? one(String(v.lo).trim()) || one(String(v.hi).trim()) : one(String(v).trim());
}

function matchesColumnTerm(term, value, path) {
    // Nested data: the term is asked of each value inside (any one will do; with != and !~, none may).
    // ~ on the whole column, no key named, still reads the column's text, as it always has
    var nested = value !== null && typeof value === 'object' && value.$dbmnMissing !== true;
    if ((path && path.length) || (nested && term.op !== '~' && term.op !== '!~')) {
        var leaves = leafValues(value, path || []);
        var positive = POSITIVE_OP[term.op];
        if (positive) {
            return !leaves.some(function (leaf) { return matchesColumnTerm({ op: positive, values: term.values, now: term.now }, leaf); });
        }
        // (nothing there at all is blank: `=""` finds it)
        if (!leaves.length) return term.op === '=' && term.values.some(function (v) { return v === '' || v === '""'; });
        return leaves.some(function (leaf) { return matchesColumnTerm(term, leaf); });
    }
    var blank = blankCell(value);
    var text = blank ? '' : stringifyCell(value);
    var lower = text.toLowerCase();
    var open = function (end) { return end === '' || end === '*'; };
    // A time in the cell, when the term asks for one: compared as times (worked out only then)
    var cellTime;
    var asTime = function (op, v) {
        if (blank || typeof value === 'object' || !looksLikeTime(v)) return null;
        if (cellTime === undefined) cellTime = timeOfCell(text);
        return matchesTime(op, cellTime, v, term.now);
    };
    var is = function (v) {
        var timed = asTime('=', v);
        if (timed !== null) return timed;
        if (typeof v === 'object') {
            return !blank && (open(v.lo) || compareCell(text, v.lo) >= 0) && (open(v.hi) || compareCell(text, v.hi) <= 0);
        }
        if (v === '""') return blank;
        if (/[*?]/.test(v)) return wildcardToRegex(v).test(text);
        return lower === v.toLowerCase();
    };
    var has = function (v) { return lower.indexOf(v.toLowerCase()) !== -1; };
    switch (term.op) {
        case '=': return term.values.some(is);
        case '!=': return !term.values.some(is);
        case '~': return term.values.some(has);
        case '!~': return !term.values.some(has);
        default: {
            if (blank) return false;
            return term.values.some(function (v) {
                var timed = asTime(term.op, v);
                if (timed !== null) return timed;
                var c = compareCell(text, v);
                return term.op === '>' ? c > 0 : term.op === '<' ? c < 0 : term.op === '>=' ? c >= 0 : c <= 0;
            });
        }
    }
}

/**
 * The columns a term names, and the path inside them when it names a key of nested data:
 * `lines.item` is the column `lines` and the key `item` when no column answers to the whole of it.
 */
function columnsNamed(columns, name) {
    var pick = function (want) { return columns.filter(function (c) { return c.type !== 'group' && columnNamed(c, want); }); };
    var whole = pick(name);
    if (whole.length || name.indexOf('.') < 0) return { columns: whole, path: [] };
    var parts = name.split('.');
    // The longest start that is a column: what is left is the way in
    for (var k = parts.length - 1; k >= 1; k--) {
        var found = pick(parts.slice(0, k).join('.'));
        if (found.length) return { columns: found, path: parts.slice(k).filter(Boolean) };
    }
    return { columns: [], path: [] };
}

/** Every column term met (a space is "and"), each by a column it names (a name no column has matches nothing). */
function matchesColumnTerms(columnTerms, row, columns, extractNestedValue) {
    for (var t = 0; t < columnTerms.length; t++) {
        var term = columnTerms[t];
        var named = columnsNamed(columns, term.column);
        var met = false;
        for (var c = 0; c < named.columns.length && !met; c++) {
            met = matchesColumnTerm(term, extractNestedValue(row, named.columns[c].id), named.path);
        }
        if (!met) return false;
    }
    return true;
}

/**
 * Parse a single raw term string into a structured term object.
 * @param {string} raw - Trimmed term string
 * @returns {{pattern: string, negated: boolean, exact: boolean, hasWildcards: boolean, andGroup: number, _regex: RegExp|null}}
 */
function parseSingleTerm(raw) {
    var negated = false;
    var exact = false;
    var pattern = raw;

    // Check for negation prefix. Trim any whitespace between the `-` and the term
    // so `door - 1a6` (space on both sides) behaves the same as `door -1a6`.
    if (pattern.charAt(0) === '-' && pattern.length > 1) {
        var afterDash = pattern.substring(1).replace(/^\s+/, '');
        if (afterDash.length > 0) {
            negated = true;
            pattern = afterDash;
        }
    }

    // Check for exact match (quoted)
    if (pattern.length >= 2 && pattern.charAt(0) === '"' && pattern.charAt(pattern.length - 1) === '"') {
        exact = true;
        pattern = pattern.substring(1, pattern.length - 1);
    }

    var hasWildcards = !exact && (pattern.indexOf('*') !== -1 || pattern.indexOf('?') !== -1);

    var compiledRegex = null;
    if (hasWildcards) {
        compiledRegex = wildcardToRegex(pattern);
    }

    return {
        pattern: pattern,
        negated: negated,
        exact: exact,
        hasWildcards: hasWildcards,
        andGroup: 0,
        _regex: compiledRegex
    };
}

/**
 * Split a string on commas, but not commas inside double quotes.
 * @param {string} str
 * @returns {string[]}
 */
function splitOnCommas(str) {
    var parts = [];
    var current = '';
    var inQuotes = false;

    for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        if (ch === '"') {
            inQuotes = !inQuotes;
            current += ch;
        } else if (ch === ',' && !inQuotes) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts;
}

/**
 * Split a string on boundary `+` and `-` operators. An operator is "at boundary" when
 * it's the first character of `str` or directly preceded by whitespace. Inside quotes,
 * characters are always literal. `+` is consumed as a separator; `-` stays attached to
 * the following token so `parseSingleTerm` recognises it as a negation prefix.
 *
 * @param {string} str
 * @returns {string[]}
 */
function splitOnBoundaryOperators(str) {
    var parts = [];
    var current = '';
    var inQuotes = false;

    for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        var atBoundary = i === 0 || /\s/.test(str.charAt(i - 1));

        if (ch === '"') {
            inQuotes = !inQuotes;
            current += ch;
        } else if (!inQuotes && ch === '+' && atBoundary) {
            parts.push(current);
            current = '';
        } else if (!inQuotes && ch === '-' && atBoundary) {
            parts.push(current);
            current = '-';
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts;
}

/**
 * Split a string on whitespace, outside double quotes: `get "bulk upload" -paused` →
 * `get`, `"bulk upload"`, `-paused`. (A `-` with a space after it stays with the next word.)
 * @param {string} str
 * @returns {string[]}
 */
function splitOnSpaces(str) {
    var parts = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        if (ch === '"') { inQuotes = !inQuotes; current += ch; continue; }
        if (!inQuotes && /\s/.test(ch)) {
            if (current === '-') continue;   // (`- word`: the dash is the next word's)
            if (current) parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current) parts.push(current);
    return parts;
}

/**
 * A plain word, or a value, as searching reads it: lower case, `-` `_` `.` `/` and spaces as one
 * space, trimmed. So `bulk up` finds `bulk-upload`, and `/inventory` finds `GET /inventory`.
 * @param {string} text
 * @returns {string}
 */
function normWords(text) {
    return String(text == null ? '' : text).toLowerCase().replace(/[\s\-_./]+/g, ' ').trim();
}

/**
 * Convert a wildcard pattern to an anchored, case-insensitive RegExp.
 * All regex special chars are escaped except * and ? which map to .* and . respectively.
 * @param {string} pattern
 * @returns {RegExp}
 */
function wildcardToRegex(pattern) {
    var escaped = '';
    for (var i = 0; i < pattern.length; i++) {
        var ch = pattern.charAt(i);
        if (ch === '*') {
            escaped += '.*';
        } else if (ch === '?') {
            escaped += '.';
        } else if (/[\\^$.|+()[\]{}]/.test(ch)) {
            escaped += '\\' + ch;
        } else {
            escaped += ch;
        }
    }
    return new RegExp('^' + escaped + '$', 'i');
}

/**
 * Issue #270c: stringify a cell value for search matching. Object/array cells
 * (e.g. selected expand-cell arrays, nested payloads) must be deep-stringified
 * so their inner content is searchable — the old `String(value)` collapsed them
 * to `[object Object]`, so text that plainly existed in the response never
 * matched. Falls back to `String()` on cyclic/unserialisable values.
 *
 * @param {*} value - Raw cell value
 * @returns {string}
 */
function stringifyCell(value) {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch (e) {
            return String(value);
        }
    }
    return String(value);
}

/**
 * Test whether a single parsed term matches a cell string value.
 *
 * @param {{pattern: string, negated: boolean, exact: boolean, hasWildcards: boolean, _regex: RegExp|null}} term
 * @param {string} cellString - The string value of a cell
 * @returns {boolean} true if the term's pattern matches (ignoring negation — caller handles that)
 */
function matchesValue(term, cellString) {
    if (term.hasWildcards && term._regex) {
        return term._regex.test(cellString);
    }
    // A word, or a quoted phrase (its words together, in order): read the same way in both
    var want = normWords(term.pattern);
    if (!want) return cellString.toLowerCase().indexOf(term.pattern.toLowerCase()) !== -1;
    return normWords(cellString).indexOf(want) !== -1;
}

/**
 * Test whether any column in a row matches the parsed search terms.
 *
 * Single rule: every comma is OR, every clause is independent.
 *   - A clause fires when ALL its positives match AND NONE of its negatives match.
 *   - The row is included if any clause fires.
 *   - A pure-negative clause (e.g. `-error`) is treated as "no positives to satisfy",
 *     so it fires whenever none of its negatives are in the row.
 *
 * To exclude something across every OR alternative, repeat it in each clause:
 * `foo -err,bar -err` rather than `foo,bar -err` (which would mean "foo OR (bar AND NOT err)").
 *
 * @param {Array} parsedTerms - Output of parseSearchExpression()
 * @param {object} row - A data row object
 * @param {Array} columns - Column definitions with .id and .type properties
 * @param {function} extractNestedValue - Function(row, columnId) → value
 * @returns {boolean} true if the row should be included
 */
function matchesRow(parsedTerms, row, columns, extractNestedValue) {
    if (parsedTerms && parsedTerms.clauses) {
        if (!parsedTerms.clauses.length) return true;
        return parsedTerms.clauses.some(function (clause) {
            return matchesColumnTerms(clause.columnTerms, row, columns, extractNestedValue) &&
                matchesWords(clause.words, row, columns, extractNestedValue);
        });
    }
    return matchesWords(parsedTerms, row, columns, extractNestedValue);
}

function matchesWords(parsedTerms, row, columns, extractNestedValue) {
    if (!parsedTerms || parsedTerms.length === 0) {
        return true;
    }

    var groups = {}; // { groupIndex: { positives: [], negatives: [] } }

    for (var i = 0; i < parsedTerms.length; i++) {
        var term = parsedTerms[i];
        var idx = term.andGroup;
        if (!groups[idx]) groups[idx] = { positives: [], negatives: [] };
        if (term.negated) {
            groups[idx].negatives.push(term);
        } else {
            groups[idx].positives.push(term);
        }
    }

    function rowMatchesTerm(t) {
        for (var c = 0; c < columns.length; c++) {
            if (columns[c].type === 'group') continue;
            var cellValue = stringifyCell(extractNestedValue(row, columns[c].id));
            if (matchesValue(t, cellValue)) return true;
        }
        return false;
    }

    var groupKeys = Object.keys(groups);
    if (groupKeys.length === 0) return true;

    for (var gi = 0; gi < groupKeys.length; gi++) {
        var group = groups[groupKeys[gi]];

        var positivesAllMatch = true;
        for (var pp = 0; pp < group.positives.length; pp++) {
            if (!rowMatchesTerm(group.positives[pp])) {
                positivesAllMatch = false;
                break;
            }
        }
        if (!positivesAllMatch) continue;

        var anyNegMatches = false;
        for (var nn = 0; nn < group.negatives.length; nn++) {
            if (rowMatchesTerm(group.negatives[nn])) {
                anyNegMatches = true;
                break;
            }
        }
        if (!anyNegMatches) return true;
    }

    return false;
}

/**
 * Tokenize a search string into display segments for syntax highlighting.
 *
 * Returns a flat array of `{ text, kind }` segments that, concatenated, reproduce
 * the original input verbatim. Uses the same word-boundary rule as
 * `parseSearchExpression`, so what the user sees coloured is what the parser will use.
 *
 * Kinds:
 *   'op-and'    `+` operator at a word boundary
 *   'op-not'    `-` operator at a word boundary (followed by something)
 *   'op-or'     `,` separator
 *   'quoted'    "..." quoted segment (including the quotes)
 *   'wildcard'  `*` or `?`
 *   'term-1'    plain term in an even-indexed OR group (0, 2, 4, ...)
 *   'term-2'    plain term in an odd-indexed OR group (alternates so adjacent OR groups separate visually)
 *
 * Characters in `term-N` segments include any literal `+`/`-`/whitespace that did
 * not qualify as an operator.
 *
 * A column term is 'col-name', 'col-op', 'col-value'; with `headings` given (the table's column
 * names), a name that is none of them is 'col-unknown'.
 *
 * @param {string} searchString
 * @param {string[]} [headings]
 * @returns {Array<{text: string, kind: string}>}
 */
var DISPLAY_TERM_AT = new RegExp('^@("[^"]*"?|[^\\s=!~<>",]*)(\\s*)(!=|!~|>=|<=|=|~|>|<)?(\\s*)' + COLUMN_VALUE_SRC + '?');
function tokenizeForDisplay(searchString, headings) {
    if (!searchString) return [];
    // With the table's columns given: a name that is none of them (nor a key inside one) is
    // 'col-unknown', shown in red. Not while it is still being typed: a start of a column's
    // name, with no operator yet, is on its way to being one
    var known = (headings || []).filter(function (h) { return h; }).map(function (h) { return String(h).toLowerCase(); });
    var nameKind = function (raw, hasOp) {
        if (!headings) return 'col-name';
        var name = unquote(raw).toLowerCase();
        if (!name) return 'col-name';
        var is = known.some(function (h) { return h === name || name.indexOf(h + '.') === 0; });
        if (is) return 'col-name';
        if (!hasOp && known.some(function (h) { return h.indexOf(name) !== -1; })) return 'col-name';
        return 'col-unknown';
    };

    var segments = [];
    var i = 0;
    var len = searchString.length;
    var orGroupIndex = 0;
    var atGroupStart = true;
    var prevChar = '';

    function termKind() {
        return (orGroupIndex % 2 === 0) ? 'term-1' : 'term-2';
    }

    // `orGroup: -1` flags a segment that visually sits BETWEEN groups (the comma
    // separator) so the renderer can skip the chip background on it.
    function push(text, kind, betweenGroups) {
        segments.push({
            text: text,
            kind: kind,
            orGroup: betweenGroups ? -1 : orGroupIndex
        });
    }

    while (i < len) {
        var ch = searchString.charAt(i);

        // A column term at a word boundary: @column, its operator, its value
        if (ch === '@' && (i === 0 || /[\s,]/.test(searchString.charAt(i - 1)))) {
            var m = DISPLAY_TERM_AT.exec(searchString.slice(i));
            push('@' + m[1], nameKind(m[1], !!m[3]), false);
            if (m[3]) {
                push(m[2] + m[3] + m[4], 'col-op', false);
                if (m[5]) push(m[5], 'col-value', false);
            } else if (m[2]) {
                push(m[2], termKind(), false);
            }
            i += m[0].length - (m[3] ? 0 : (m[4] || '').length + (m[5] || '').length);
            prevChar = searchString.charAt(i - 1);
            atGroupStart = false;
            continue;
        }

        // Whitespace — preserve, attribute to current term-kind so spacing stays themed
        if (/\s/.test(ch)) {
            push(ch, termKind(), false);
            prevChar = ch;
            i++;
            continue;
        }

        // Comma — always OR separator (outside quotes; we're not in a quote here)
        if (ch === ',') {
            push(',', 'op-or', true);
            orGroupIndex++;
            atGroupStart = true;
            prevChar = ',';
            i++;
            continue;
        }

        var atBoundary = atGroupStart || /\s/.test(prevChar);

        if (ch === '+' && atBoundary) {
            push('+', 'op-and', false);
            atGroupStart = false;
            prevChar = '+';
            i++;
            continue;
        }

        if (ch === '-' && atBoundary) {
            // Treat as NOT if a real term follows — skip any whitespace between
            // the dash and the next character (so `foo - bar` lights up too).
            var lookahead = i + 1;
            while (lookahead < len && /\s/.test(searchString.charAt(lookahead))) lookahead++;
            var nextChar = (lookahead < len) ? searchString.charAt(lookahead) : '';
            if (nextChar !== '' && nextChar !== ',') {
                push('-', 'op-not', false);
                atGroupStart = false;
                prevChar = '-';
                i++;
                continue;
            }
            // Lone `-` (or trailing `-` followed only by whitespace) falls through and becomes literal
        }

        if (ch === '"') {
            var quoted = '"';
            i++;
            while (i < len) {
                quoted += searchString.charAt(i);
                if (searchString.charAt(i) === '"') {
                    i++;
                    break;
                }
                i++;
            }
            push(quoted, 'quoted', false);
            atGroupStart = false;
            prevChar = '"';
            continue;
        }

        if (ch === '*' || ch === '?') {
            push(ch, 'wildcard', false);
            atGroupStart = false;
            prevChar = ch;
            i++;
            continue;
        }

        // Plain term — accumulate until a special char (whitespace/comma/quote/wildcard)
        // `+` and `-` are accumulated as literals since by this point they're not at a boundary
        // (the boundary checks above already consumed any operator-mode + / -).
        var text = '';
        while (i < len) {
            var c = searchString.charAt(i);
            if (/\s/.test(c) || c === ',' || c === '"' || c === '*' || c === '?') break;
            text += c;
            prevChar = c;
            i++;
        }
        if (text) {
            push(text, termKind(), false);
            atGroupStart = false;
        }
    }

    return segments;
}

/**
 * GitHub Issue #261: paint the find box's highlight mirror (the coloured copy of what is typed,
 * behind the transparent input). Shared by the Console and Compare (#298).
 */
function renderHighlight(mirrorEl, value, headings) {
    if (!mirrorEl) return;
    var segments = tokenizeForDisplay(value, headings);
    if (segments.length === 0) {
        mirrorEl.textContent = '';
        return;
    }
    mirrorEl.innerHTML = segments.map(function(seg) {
        var escaped = seg.text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        var groupCls = seg.orGroup >= 0 ? ' search-tok-grp-' + (seg.orGroup % 2) : '';
        return '<span class="search-tok search-tok-' + seg.kind + groupCls + '">' + escaped + '</span>';
    }).join('');
}

/*
 * Suggestions for `@`: typing `@` lists the columns (by heading, those holding what is typed
 * first); a column picked or typed in full lists the operators. Pure: the box asks with what is
 * typed up to the caret and the column headings.
 */
/**
 * The keys found inside nested data (lists and objects), under a path of keys: what `@column.`
 * can be followed by. First seen first, from the values given (a sample of a column's cells).
 */
function nestedKeys(values, path) {
    var seen = {};
    var out = [];
    var walk = function (value, rest) {
        if (out.length >= 50) return;
        if (Array.isArray(value)) { for (var i = 0; i < value.length; i++) walk(value[i], rest); return; }
        if (value === null || typeof value !== 'object' || value.$dbmnMissing === true) return;
        Object.keys(value).forEach(function (key) {
            if (rest.length) { if (key.toLowerCase() === rest[0].toLowerCase()) walk(value[key], rest.slice(1)); return; }
            var low = key.toLowerCase();
            if (!seen[low] && !/[\s=!~<>",.@]/.test(key)) { seen[low] = true; out.push(key); }
        });
    };
    (values || []).forEach(function (value) { walk(value, path || []); });
    return out;
}

/** The keys inside the column a heading names, from the first rows: for a find box's `keys`. */
function nestedKeysFor(rows, columns, heading, path, extract) {
    var named = (columns || []).filter(function (c) { return c.type !== 'group' && columnNamed(c, heading); });
    if (!named.length) return [];
    var values = [];
    (rows || []).slice(0, 200).forEach(function (row) {
        named.forEach(function (c) { values.push(extract ? extract(row, c.id) : row[c.id]); });
    });
    return nestedKeys(values, path);
}

/**
 * What kind of values these are, for the suggestions: 'yesno' (true and false), 'number', 'date'
 * (ISO 8601 text), 'nested' (lists and objects), 'text', or '' when there is nothing to go by.
 */
function typeOfValues(values) {
    var seen = 0, kinds = { yesno: 0, number: 0, date: 0, nested: 0 };
    for (var i = 0; i < (values || []).length && seen < 200; i++) {
        var v = values[i];
        if (blankCell(v)) continue;
        seen++;
        if (typeof v === 'boolean') kinds.yesno++;
        else if (typeof v === 'number') kinds.number++;
        else if (typeof v === 'object') kinds.nested++;
        else if (typeof v === 'string' && ISO_TIME_RE.test(v.trim())) kinds.date++;
    }
    if (!seen) return '';
    if (kinds.nested) return 'nested';
    if (kinds.yesno === seen) return 'yesno';
    if (kinds.number === seen) return 'number';
    if (kinds.date === seen) return 'date';
    return 'text';
}
var TYPE_WORDS = { text: 'text', number: 'number', yesno: 'yes/no', date: 'date', nested: 'nested' };
/** The operators that fit a kind of column, in the order offered, each with its words. */
var TYPE_OPS = {
    text: [['=', 'is (a|b either)'], ['!=', 'is not'], ['~', 'contains'], ['!~', "doesn't contain"]],
    number: [['>', 'more than'], ['<', 'less than'], ['=', 'is, or between (10..90)'], ['>=', 'at least'], ['<=', 'at most'], ['!=', 'is not']],
    yesno: [['=', 'is'], ['!=', 'is not']],
    date: [['>', 'after'], ['<', 'before'], ['=', 'on, or between'], ['>=', 'on or after'], ['<=', 'on or before']],
    nested: [['=', 'any value inside is'], ['~', 'contains'], ['!=', 'no value inside is'], ['!~', "doesn't contain"]]
};
/** What a date column is offered after an operator. */
var DATE_VALUES = {
    '>': [['today', 'after today'], ['yesterday', 'after yesterday'], ['7d', 'in the last 7 days'], ['30d', 'in the last 30 days'], ['2h', 'in the last 2 hours']],
    '<': [['today', 'before today'], ['7d', 'more than 7 days ago'], ['30d', 'more than 30 days ago']],
    '=': [['today', 'today'], ['yesterday', 'yesterday'], ['7d..', 'the last 7 days'], ['30d..', 'the last 30 days'], ['30d..7d', 'between 30 and 7 days ago']]
};
DATE_VALUES['>='] = [['today', 'today or later'], ['yesterday', 'yesterday or later'], ['7d', 'in the last 7 days'], ['30d', 'in the last 30 days']];
DATE_VALUES['<='] = [['today', 'today or earlier'], ['yesterday', 'yesterday or earlier'], ['7d', '7 days ago or earlier']];

var OP_WORDS = { '=': 'is (a|b either, 1..9 between)', '!=': 'is not', '~': 'contains', '!~': "doesn't contain", '>': 'more than', '<': 'less than', '>=': 'at least', '<=': 'at most' };
function columnSuggestions(typed, headings, keysOf, typesOf) {
    var text = String(typed || '');
    var names = (headings || []).filter(function (h) { return h; });
    var quote = function (h) { return /\s/.test(h) ? '"' + h + '"' : h; };
    var keys = function (heading, path) { return (keysOf && keysOf(heading, path)) || []; };
    // The kind of a column (or of a key inside it), when the box knows: '' leaves everything as it was
    var typeOf = function (heading, path) { return (typesOf && typesOf(heading, path || [])) || ''; };
    var named = function (name) {
        var low = String(name).toLowerCase();
        var whole = names.filter(function (h) { return h.toLowerCase() === low; })[0];
        if (whole) return { heading: whole, path: [] };
        var start = names.filter(function (h) { return low.indexOf(h.toLowerCase() + '.') === 0; }).sort(function (a, b) { return b.length - a.length; })[0];
        return start ? { heading: start, path: name.slice(start.length + 1).split('.').filter(Boolean) } : null;
    };
    // `@column>` with a value begun: what a yes/no or a date column can be asked
    var valued = typesOf ? /(^|[\s,])@("[^"]+"|[^\s=!~<>",]+)(!=|!~|>=|<=|=|~|>|<)([^\s",|]*)$/.exec(text) : null;
    if (valued) {
        var col = named(unquote(valued[2]));
        var kind = col ? typeOf(col.heading, col.path) : '';
        var begun = valued[4].toLowerCase();
        var from = text.length - valued[4].length;
        var offer = kind === 'yesno' ? [['true', ''], ['false', '']] : kind === 'date' ? (DATE_VALUES[valued[3]] || []) : [];
        return offer
            .filter(function (o) { return o[0].indexOf(begun) === 0 && o[0] !== begun; })
            .map(function (o) { return { text: o[0], label: o[1], start: from, end: text.length }; });
    }
    var at = /(^|[\s,])@("[^"]*|[^\s=!~<>",]*)$/.exec(text);
    if (at) {
        var start = at.index + at[1].length;
        var typedName = unquote(at[2]);
        var partial = typedName.toLowerCase();
        // `@column.`: the keys inside that column's nested data (then the keys inside those)
        var inside = nestedSuggestions(typedName, names, keys, start, text, typeOf);
        if (inside) return inside;
        var exact = names.filter(function (h) { return h.toLowerCase() === partial; });
        // Typed in full: on to the operators (and a dot, when it holds nested data)
        if (exact.length && at[2].length) return opSuggestions(text, text.length, keys(exact[0], []).length > 0, typeOf(exact[0], []));
        return names
            .map(function (h) { return { h: h, pos: h.toLowerCase().indexOf(partial) }; })
            .filter(function (x) { return x.pos !== -1; })
            .sort(function (a, b) { return (a.pos === 0 ? 0 : 1) - (b.pos === 0 ? 0 : 1) || a.h.localeCompare(b.h); })
            .slice(0, 10)
            .map(function (x) { return { text: '@' + quote(x.h), label: TYPE_WORDS[typeOf(x.h, [])] || (keys(x.h, []).length ? 'column, nested' : 'column'), start: start, end: text.length }; });
    }
    // `@column ` picked: the operators
    var picked = /(^|[\s,])@("[^"]+"|[^\s=!~<>",]+)$/.exec(text);
    if (picked) { var whole = named(unquote(picked[2])); return opSuggestions(text, text.length, false, whole ? typeOf(whole.heading, whole.path) : ''); }
    return [];
}

/** After `@column.` (and `@column.key.`): the keys there, those holding what is typed first; a key typed in full, the operators. */
function nestedSuggestions(typedName, names, keys, start, text, typeOf) {
    typeOf = typeOf || function () { return ''; };
    if (typedName.indexOf('.') < 0) return null;
    var low = typedName.toLowerCase();
    // The longest heading the text starts with, a dot after it
    var heading = names.filter(function (h) { return !/\s/.test(h) && low.indexOf(h.toLowerCase() + '.') === 0; })
        .sort(function (a, b) { return b.length - a.length; })[0];
    if (!heading) return null;
    var parts = typedName.slice(heading.length + 1).split('.');
    var last = parts.pop();
    var path = parts;
    var found = keys(heading, path);
    if (!found.length) return null;
    var lead = '@' + heading + '.' + (path.length ? path.join('.') + '.' : '');
    var whole = found.filter(function (k) { return k.toLowerCase() === last.toLowerCase(); });
    if (whole.length && last.length) return opSuggestions(text, text.length, keys(heading, path.concat([whole[0]])).length > 0, typeOf(heading, path.concat([whole[0]])));
    return found
        .map(function (k) { return { k: k, pos: k.toLowerCase().indexOf(last.toLowerCase()) }; })
        .filter(function (x) { return x.pos !== -1; })
        .sort(function (a, b) { return (a.pos === 0 ? 0 : 1) - (b.pos === 0 ? 0 : 1); })
        .slice(0, 12)
        .map(function (x) { return { text: lead + x.k, label: TYPE_WORDS[typeOf(heading, path.concat([x.k]))] || (keys(heading, path.concat([x.k])).length ? 'key, nested' : 'key'), start: start, end: text.length }; });
}
function opSuggestions(text, end, nested, type) {
    // A column whose kind is known: the operators that fit it, with words that fit it
    if (type && TYPE_OPS[type]) {
        var fitted = TYPE_OPS[type].map(function (o) { return { text: o[0], label: o[1], start: end, end: end, op: true }; });
        return nested || type === 'nested' ? [{ text: '.', label: 'a key inside it', start: end, end: end, op: true }].concat(fitted) : fitted;
    }
    var ops = COLUMN_OPS.slice().sort(function (a, b) {
        return ['=', '!=', '~', '!~', '>', '<', '>=', '<='].indexOf(a) - ['=', '!=', '~', '!~', '>', '<', '>=', '<='].indexOf(b);
    }).map(function (op) { return { text: op, label: OP_WORDS[op], start: end, end: end, op: true }; });
    // Nested data: a dot goes on to the keys inside it
    return nested ? [{ text: '.', label: 'a key inside it', start: end, end: end, op: true }].concat(ops) : ops;
}

/**
 * A search in words, to show under its box: "Reading this as: poDate (date) after 12 Nov 2026 and
 * any column contains kettle". It answers "is this really read as a date?" without a type on
 * show anywhere else. Plain text; '' when the box asks nothing of a column.
 *   typesOf(heading, path): the kind of a column, as for the suggestions; headings: the columns there are
 */
function describeSearch(text, headings, typesOf, now) {
    var terms = [];
    var rest = extractColumnTerms(String(text || ''), terms);
    if (!terms.length) return '';
    var names = (headings || []).filter(function (h) { return h; });
    var day = function (ms) { return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
    var moment = function (t) {
        if (t.day || t.ago === 'd' || t.ago === 'w') return day(t.from);
        return day(t.from) + ' ' + new Date(t.from).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    };
    var says = terms.map(function (term) {
        var low = term.column.toLowerCase();
        var heading = names.filter(function (h) { return h.toLowerCase() === low; })[0] ||
            names.filter(function (h) { return low.indexOf(h.toLowerCase() + '.') === 0; }).sort(function (a, b) { return b.length - a.length; })[0];
        if (!heading) return 'no column called ' + term.column;
        var path = term.column.length > heading.length ? term.column.slice(heading.length + 1).split('.').filter(Boolean) : [];
        var type = (typesOf && typesOf(heading, path)) || '';
        var word = ((TYPE_OPS[type] || []).filter(function (o) { return o[0] === term.op; })[0] || [term.op, OP_WORDS[term.op] || term.op])[1].split(/[,(]/)[0].trim();
        var value = term.values.map(function (v) {
            if (typeof v === 'object') {
                var lo = v.lo === '' || v.lo === '*' ? null : v.lo, hi = v.hi === '' || v.hi === '*' ? null : v.hi;
                var a = lo !== null && type === 'date' ? resolveTime(lo, now) : null, b = hi !== null && type === 'date' ? resolveTime(hi, now) : null;
                if (type === 'date' && (a || lo === null) && (b || hi === null)) {
                    if (a && b && a.from > b.to) { var swap = a; a = b; b = swap; }
                    return 'from ' + (a ? moment(a) : 'any time') + ' to ' + (b ? moment(b) : 'now');
                }
                return 'from ' + (lo === null ? 'anything' : lo) + ' to ' + (hi === null ? 'anything' : hi);
            }
            if (type === 'date') { var t = resolveTime(v, now); return t ? moment(t) : v + ' (not a date)'; }
            if (type === 'yesno') return /^(true|false)$/i.test(v) ? (v.toLowerCase() === 'true' ? 'yes' : 'no') : v + ' (not true or false)';
            if (type === 'number' && v !== '""' && !isFinite(Number(v))) return v + ' (not a number)';
            return v;
        }).join(' or ');
        var ranged = term.values.some(function (v) { return typeof v === 'object'; });
        return term.column + (type ? ' (' + TYPE_WORDS[type] + ')' : '') + ' ' + (ranged ? (term.op === '!=' ? 'is not' : 'is') : word) + ' ' + value;
    });
    // The words: each found anywhere in the row (a phrase as one), or left out
    var parsedWords = parseWords(rest.replace(/,/g, ' '));
    var shown = function (t) { return t.exact ? '"' + t.pattern + '"' : t.pattern; };
    var found = parsedWords.filter(function (t) { return !t.negated; }).map(shown);
    var without = parsedWords.filter(function (t) { return t.negated; }).map(shown);
    if (found.length) says.push('the row holds ' + found.join(' and '));
    if (without.length) says.push('not ' + without.join(' or '));
    return 'Reading this as: ' + says.join(' and ');
}

/**
 * The suggestion list under a find box (the Console's, Compare's): `@` lists the columns, then
 * the operators. Arrow keys move, Enter or Tab picks, Esc closes. Picking writes into the box and
 * fires its input event, so the page searches and colours as if it were typed.
 *
 *   SearchMatcher.attachColumnSuggest({ input, headings: () => ['sku', 'status', …],
 *       keys: (heading, path) => ['key', 'value', …],       optional: the keys inside a column's nested
 *                                                           data, listed after `@column.` (nestedKeysFor)
 *       types: (heading, path) => 'date' })                 optional: the kind of a column or a key inside it
 *                                                           ('text', 'number', 'yesno', 'date', 'nested';
 *                                                           typeOfValues works it out from values). With it
 *                                                           the list says each column's kind, offers the
 *                                                           operators that fit, and after one, true or false
 *                                                           for a yes/no column and today, 7d… for a date
 */
function attachColumnSuggest(opts) {
    var input = opts && opts.input;
    if (!input || typeof document === 'undefined') return;
    var holder = input.parentElement;
    var list = document.createElement('div');
    list.className = 'column-suggest';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    holder.appendChild(list);
    var shown = [];
    var active = 0;
    function close() { list.hidden = true; shown = []; }
    function render() {
        var caret = input.selectionEnd == null ? input.value.length : input.selectionEnd;
        shown = caret === input.value.length ? columnSuggestions(input.value, opts.headings ? opts.headings() : [], opts.keys, opts.types) : [];
        if (!shown.length) { close(); return; }
        if (active >= shown.length) active = 0;
        list.innerHTML = shown.map(function (s, i) {
            var esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
            return '<div class="column-suggest-option' + (i === active ? ' is-active' : '') + '" role="option" data-index="' + i + '">' +
                '<span class="column-suggest-text">' + esc(s.text) + '</span>' +
                (s.label ? '<span class="column-suggest-label">' + esc(s.label) + '</span>' : '') + '</div>';
        }).join('');
        list.hidden = false;
    }
    function pick(i) {
        var s = shown[i];
        if (!s) return;
        input.value = input.value.slice(0, s.start) + s.text + input.value.slice(s.end);
        var end = s.start + s.text.length;
        input.setSelectionRange(end, end);
        active = 0;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        render();
    }
    input.addEventListener('input', function () { render(); });
    input.addEventListener('focus', function () { render(); });
    // Ahead of the page's own keys (Enter, Esc), while the list is open
    input.addEventListener('keydown', function (e) {
        if (list.hidden) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopImmediatePropagation();
            active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
            render();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            e.stopImmediatePropagation();
            pick(active);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
        }
    }, true);
    list.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var opt = e.target && e.target.closest ? e.target.closest('.column-suggest-option') : null;
        if (opt) pick(Number(opt.getAttribute('data-index')));
    });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
}

/**
 * Keep the coloured copy level with the box: a long search scrolls the box sideways, and the
 * copy behind it must scroll with it, or the caret sits between the wrong letters.
 */
function followScroll(input, mirror) {
    if (!input || !mirror) return;
    var sync = function () { mirror.scrollLeft = input.scrollLeft; };
    ['input', 'scroll', 'keyup', 'keydown', 'click', 'select', 'focus'].forEach(function (ev) {
        input.addEventListener(ev, function () { sync(); requestAnimationFrame(sync); });
    });
}

// Export for use in both browser and Node.js environments
if (typeof module !== 'undefined' && module.exports) {
    // Node.js/CommonJS
    module.exports = { parseSearchExpression, matchesValue, matchesRow, tokenizeForDisplay, renderHighlight, columnSuggestions, nestedKeys, nestedKeysFor, COLUMN_OPS, resolveTime, timeOfCell, typeOfValues, describeSearch };
} else {
    // Browser/Global
    window.SearchMatcher = { parseSearchExpression, matchesValue, matchesRow, tokenizeForDisplay, renderHighlight, columnSuggestions, nestedKeys, nestedKeysFor, attachColumnSuggest, followScroll, COLUMN_OPS, resolveTime, timeOfCell, typeOfValues, describeSearch };
}

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
 * Syntax:
 *   ,                → OR between terms
 *   space + space    → AND between terms
 *   space - term     → exclude matching rows (also `-term` at start)
 *   *                → zero or more characters (wildcard)
 *   ?                → exactly one character (wildcard)
 *   "quoted"         → exact literal match (no substring)
 *   plain text       → case-insensitive substring
 *
 * `+` and `-` are operators only at a word boundary (start of input or after whitespace).
 * Inside a term they are literal characters, so `ACAU-ASR3690` matches as-is.
 *
 * @param {string} searchString - Raw search input from user
 * @returns {Array<{pattern: string, negated: boolean, exact: boolean, hasWildcards: boolean, andGroup: number, _regex: RegExp|null}>}
 */
function parseSearchExpression(searchString) {
    if (!searchString || searchString.trim() === '') {
        return [];
    }

    // With column terms (`@status=active`), each comma-separated clause is its own: its column
    // terms all met and its words found, and any clause will do
    if (HAS_COLUMN_TERM.test(searchString)) {
        var clauses = splitClauses(searchString).map(function (clause) {
            var columnTerms = [];
            var rest = extractColumnTerms(clause, columnTerms);
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
            var raw = andParts[j].trim();
            if (raw === '') continue;

            var term = parseSingleTerm(raw);
            term.andGroup = andGroupIndex;
            parsed.push(term);
            clauseTermCount++;
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

/** A cell against a value: as numbers when both are, else in text order (dates sort as text). */
function compareCell(text, v) {
    var a = Number(text), b = Number(v);
    return (text.trim() !== '' && v.trim() !== '' && isFinite(a) && isFinite(b))
        ? a - b : text.localeCompare(v, undefined, { numeric: true, sensitivity: 'base' });
}

function matchesColumnTerm(term, value) {
    var blank = blankCell(value);
    var text = blank ? '' : stringifyCell(value);
    var lower = text.toLowerCase();
    var open = function (end) { return end === '' || end === '*'; };
    var is = function (v) {
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
                var c = compareCell(text, v);
                return term.op === '>' ? c > 0 : term.op === '<' ? c < 0 : term.op === '>=' ? c >= 0 : c <= 0;
            });
        }
    }
}

/** Every column term met (a space is "and"), each by a column it names (a name no column has matches nothing). */
function matchesColumnTerms(columnTerms, row, columns, extractNestedValue) {
    for (var t = 0; t < columnTerms.length; t++) {
        var term = columnTerms[t];
        var named = columns.filter(function (c) { return c.type !== 'group' && columnNamed(c, term.column); });
        var met = false;
        for (var c = 0; c < named.length && !met; c++) {
            met = matchesColumnTerm(term, extractNestedValue(row, named[c].id));
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
    if (term.exact) {
        // Case-insensitive exact match (full cell value)
        return cellString.toLowerCase() === term.pattern.toLowerCase();
    }

    if (term.hasWildcards && term._regex) {
        return term._regex.test(cellString);
    }

    // Plain substring match (case-insensitive) — backwards compatible
    return cellString.toLowerCase().indexOf(term.pattern.toLowerCase()) !== -1;
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
 * @param {string} searchString
 * @returns {Array<{text: string, kind: string}>}
 */
var DISPLAY_TERM_AT = new RegExp('^@("[^"]*"?|[^\\s=!~<>",]*)(\\s*)(!=|!~|>=|<=|=|~|>|<)?(\\s*)' + COLUMN_VALUE_SRC + '?');
function tokenizeForDisplay(searchString) {
    if (!searchString) return [];

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
            push('@' + m[1], 'col-name', false);
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
function renderHighlight(mirrorEl, value) {
    if (!mirrorEl) return;
    var segments = tokenizeForDisplay(value);
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
var OP_WORDS = { '=': 'is (a|b either, 1..9 between)', '!=': 'is not', '~': 'contains', '!~': "doesn't contain", '>': 'more than', '<': 'less than', '>=': 'at least', '<=': 'at most' };
function columnSuggestions(typed, headings) {
    var text = String(typed || '');
    var names = (headings || []).filter(function (h) { return h; });
    var quote = function (h) { return /\s/.test(h) ? '"' + h + '"' : h; };
    var at = /(^|[\s,])@("[^"]*|[^\s=!~<>",]*)$/.exec(text);
    if (at) {
        var start = at.index + at[1].length;
        var partial = unquote(at[2]).toLowerCase();
        var exact = names.filter(function (h) { return h.toLowerCase() === partial; });
        // Typed in full: on to the operators
        if (exact.length && at[2].length) return opSuggestions(text, text.length);
        return names
            .map(function (h) { return { h: h, pos: h.toLowerCase().indexOf(partial) }; })
            .filter(function (x) { return x.pos !== -1; })
            .sort(function (a, b) { return (a.pos === 0 ? 0 : 1) - (b.pos === 0 ? 0 : 1) || a.h.localeCompare(b.h); })
            .slice(0, 10)
            .map(function (x) { return { text: '@' + quote(x.h), label: 'column', start: start, end: text.length }; });
    }
    // `@column ` picked: the operators
    var named = /(^|[\s,])@("[^"]+"|[^\s=!~<>",]+)$/.exec(text);
    if (named) return opSuggestions(text, text.length);
    return [];
}
function opSuggestions(text, end) {
    return COLUMN_OPS.slice().sort(function (a, b) {
        return ['=', '!=', '~', '!~', '>', '<', '>=', '<='].indexOf(a) - ['=', '!=', '~', '!~', '>', '<', '>=', '<='].indexOf(b);
    }).map(function (op) { return { text: op, label: OP_WORDS[op], start: end, end: end, op: true }; });
}

/**
 * The suggestion list under a find box (the Console's, Compare's): `@` lists the columns, then
 * the operators. Arrow keys move, Enter or Tab picks, Esc closes. Picking writes into the box and
 * fires its input event, so the page searches and colours as if it were typed.
 *
 *   SearchMatcher.attachColumnSuggest({ input, headings: () => ['sku', 'status', …] })
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
        shown = caret === input.value.length ? columnSuggestions(input.value, opts.headings ? opts.headings() : []) : [];
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
    module.exports = { parseSearchExpression, matchesValue, matchesRow, tokenizeForDisplay, renderHighlight, columnSuggestions, COLUMN_OPS };
} else {
    // Browser/Global
    window.SearchMatcher = { parseSearchExpression, matchesValue, matchesRow, tokenizeForDisplay, renderHighlight, columnSuggestions, attachColumnSuggest, followScroll, COLUMN_OPS };
}

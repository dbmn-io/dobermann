// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for search-matcher.js
 * GitHub Issue #227: Console search improvements
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';

const { parseSearchExpression, matchesValue, matchesRow, tokenizeForDisplay, columnSuggestions, nestedKeys, nestedKeysFor } = require('../../../webviews/shared/search-matcher.js');

// Helper to extract a flat value from a row by key
function extractValue(row: Record<string, unknown>, key: string): unknown {
    return row[key];
}

// =============================================================
// parseSearchExpression
// =============================================================

describe('parseSearchExpression', () => {
    it('returns empty array for empty/null input', () => {
        expect(parseSearchExpression('')).to.deep.equal([]);
        expect(parseSearchExpression(null)).to.deep.equal([]);
        expect(parseSearchExpression(undefined)).to.deep.equal([]);
        expect(parseSearchExpression('   ')).to.deep.equal([]);
    });

    it('parses a single plain term', () => {
        const result = parseSearchExpression('hello');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('hello');
        expect(result[0].negated).to.equal(false);
        expect(result[0].exact).to.equal(false);
        expect(result[0].hasWildcards).to.equal(false);
        expect(result[0]._regex).to.be.null;
    });

    it('parses comma-separated terms', () => {
        const result = parseSearchExpression('abc,def,ghi');
        expect(result).to.have.length(3);
        expect(result[0].pattern).to.equal('abc');
        expect(result[1].pattern).to.equal('def');
        expect(result[2].pattern).to.equal('ghi');
    });

    it('trims whitespace around terms', () => {
        const result = parseSearchExpression(' abc , def ');
        expect(result).to.have.length(2);
        expect(result[0].pattern).to.equal('abc');
        expect(result[1].pattern).to.equal('def');
    });

    it('skips empty terms from consecutive commas', () => {
        const result = parseSearchExpression('abc,,def');
        expect(result).to.have.length(2);
        expect(result[0].pattern).to.equal('abc');
        expect(result[1].pattern).to.equal('def');
    });

    it('parses negated term', () => {
        const result = parseSearchExpression('-error');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('error');
        expect(result[0].negated).to.equal(true);
    });

    it('parses quoted exact match', () => {
        const result = parseSearchExpression('"New York"');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('New York');
        expect(result[0].exact).to.equal(true);
        expect(result[0].hasWildcards).to.equal(false);
    });

    it('parses negated quoted term', () => {
        const result = parseSearchExpression('-"bad value"');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('bad value');
        expect(result[0].negated).to.equal(true);
        expect(result[0].exact).to.equal(true);
    });

    it('parses wildcard terms', () => {
        const result = parseSearchExpression('abc*');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('abc*');
        expect(result[0].hasWildcards).to.equal(true);
        expect(result[0]._regex).to.be.instanceOf(RegExp);
    });

    it('parses ? wildcard', () => {
        const result = parseSearchExpression('a?c');
        expect(result).to.have.length(1);
        expect(result[0].hasWildcards).to.equal(true);
        expect(result[0]._regex).to.be.instanceOf(RegExp);
    });

    it('does not treat wildcards inside quotes as wildcards', () => {
        const result = parseSearchExpression('"abc*"');
        expect(result).to.have.length(1);
        expect(result[0].exact).to.equal(true);
        expect(result[0].hasWildcards).to.equal(false);
        expect(result[0]._regex).to.be.null;
    });

    it('parses combined expression', () => {
        const result = parseSearchExpression('"exact",-exclude,wild*');
        expect(result).to.have.length(3);
        expect(result[0].exact).to.equal(true);
        expect(result[0].pattern).to.equal('exact');
        expect(result[1].negated).to.equal(true);
        expect(result[1].pattern).to.equal('exclude');
        expect(result[2].hasWildcards).to.equal(true);
        expect(result[2].pattern).to.equal('wild*');
    });

    it('preserves commas inside quotes', () => {
        const result = parseSearchExpression('"New York, NY",other');
        expect(result).to.have.length(2);
        expect(result[0].pattern).to.equal('New York, NY');
        expect(result[1].pattern).to.equal('other');
    });

    it('a lone dash is a word still being typed: nothing to find yet (as in the Hub)', () => {
        expect(parseSearchExpression('-')).to.have.length(0);
    });

    it('parses negated wildcard', () => {
        const result = parseSearchExpression('-err*');
        expect(result).to.have.length(1);
        expect(result[0].negated).to.equal(true);
        expect(result[0].hasWildcards).to.equal(true);
        expect(result[0].pattern).to.equal('err*');
    });

    it('parses + AND terms in same andGroup', () => {
        const result = parseSearchExpression('abc + def');
        expect(result).to.have.length(2);
        expect(result[0].pattern).to.equal('abc');
        expect(result[1].pattern).to.equal('def');
        expect(result[0].andGroup).to.equal(result[1].andGroup);
    });

    it('assigns different andGroups across commas', () => {
        const result = parseSearchExpression('abc + def,ghi');
        expect(result).to.have.length(3);
        expect(result[0].andGroup).to.equal(result[1].andGroup); // abc + def same group
        expect(result[2].andGroup).to.not.equal(result[0].andGroup); // ghi different group
    });

    it('negative term is tagged with its clause\'s andGroup (issue #261)', () => {
        // Every term in a clause shares the clause's andGroup — no more global -1.
        const result = parseSearchExpression('-error + active');
        expect(result).to.have.length(2);
        const positive = result.find((t: { negated: boolean }) => !t.negated);
        const negative = result.find((t: { negated: boolean }) => t.negated);
        expect(positive.andGroup).to.equal(negative.andGroup);
        expect(negative.andGroup).to.equal(0);
    });

    it('single pure-negative clause sits in andGroup 0', () => {
        const result = parseSearchExpression('-error');
        expect(result).to.have.length(1);
        expect(result[0].negated).to.equal(true);
        expect(result[0].andGroup).to.equal(0);
    });

    it('comma-separated pure-negative clauses each get their own andGroup', () => {
        const result = parseSearchExpression('-error,-pending');
        expect(result).to.have.length(2);
        expect(result[0].pattern).to.equal('error');
        expect(result[0].andGroup).to.equal(0);
        expect(result[1].pattern).to.equal('pending');
        expect(result[1].andGroup).to.equal(1);
    });

    it('preserves + inside quotes', () => {
        const result = parseSearchExpression('"a+b"');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('a+b');
        expect(result[0].exact).to.equal(true);
    });

    // GitHub Issue #261: word-boundary rule for + and -
    it('treats mid-word - as literal (hyphen in ID)', () => {
        const result = parseSearchExpression('ACAU-ASR3690-"07"');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('ACAU-ASR3690-"07"');
        expect(result[0].negated).to.equal(false);
        expect(result[0].exact).to.equal(false);
    });

    it('treats space-prefixed - as exclude after a hyphenated ID', () => {
        const result = parseSearchExpression('ACAU-ASR3690 -"07"');
        expect(result).to.have.length(2);
        expect(result[0].pattern).to.equal('ACAU-ASR3690');
        expect(result[0].negated).to.equal(false);
        expect(result[1].pattern).to.equal('07');
        expect(result[1].negated).to.equal(true);
        expect(result[1].exact).to.equal(true);
    });

    it('treats space-bounded + as AND after a hyphenated ID', () => {
        const result = parseSearchExpression('ACAU-ASR3690 + "07"');
        expect(result).to.have.length(2);
        expect(result[0].pattern).to.equal('ACAU-ASR3690');
        expect(result[1].pattern).to.equal('07');
        expect(result[1].exact).to.equal(true);
        expect(result[0].andGroup).to.equal(result[1].andGroup);
    });

    it('treats mid-word + as literal (no space)', () => {
        const result = parseSearchExpression('foo+bar');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('foo+bar');
    });

    it('treats mid-word + and - as literal in compound IDs', () => {
        const result = parseSearchExpression('ACAU+ASR3690+07');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('ACAU+ASR3690+07');
    });

    it('multiple hyphens inside a term remain literal', () => {
        const result = parseSearchExpression('a-b-c');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('a-b-c');
        expect(result[0].negated).to.equal(false);
    });

    it('space-prefixed - on a plain term', () => {
        const result = parseSearchExpression('foo -bar');
        expect(result).to.have.length(2);
        expect(result[0].pattern).to.equal('foo');
        expect(result[0].negated).to.equal(false);
        expect(result[1].pattern).to.equal('bar');
        expect(result[1].negated).to.equal(true);
    });

    it('handles a space between - and the term (`door - 1a6`)', () => {
        const result = parseSearchExpression('door - 1a6');
        expect(result).to.have.length(2);
        expect(result[0].pattern).to.equal('door');
        expect(result[0].negated).to.equal(false);
        expect(result[1].pattern).to.equal('1a6');
        expect(result[1].negated).to.equal(true);
    });

    it('a trailing - with nothing after it is a word still being typed', () => {
        const result = parseSearchExpression('foo - ');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('foo');
    });
});

// =============================================================
// matchesValue
// =============================================================

describe('matchesValue', () => {
    it('plain substring match is case-insensitive', () => {
        const term = parseSearchExpression('hello')[0];
        expect(matchesValue(term, 'Hello World')).to.equal(true);
        expect(matchesValue(term, 'HELLO')).to.equal(true);
        expect(matchesValue(term, 'goodbye')).to.equal(false);
    });

    it('* wildcard matches zero or more characters', () => {
        const term = parseSearchExpression('abc*')[0];
        expect(matchesValue(term, 'abc')).to.equal(true);
        expect(matchesValue(term, 'abcdef')).to.equal(true);
        expect(matchesValue(term, 'abc123')).to.equal(true);
        expect(matchesValue(term, 'xabc')).to.equal(false);
    });

    it('? wildcard matches exactly one character', () => {
        const term = parseSearchExpression('a?c')[0];
        expect(matchesValue(term, 'abc')).to.equal(true);
        expect(matchesValue(term, 'a1c')).to.equal(true);
        expect(matchesValue(term, 'ac')).to.equal(false);
        expect(matchesValue(term, 'abbc')).to.equal(false);
    });

    it('quotes are a phrase: the words together, in that order, anywhere in the value (2026-11-21: one search)', () => {
        const term = parseSearchExpression('"New York"')[0];
        expect(matchesValue(term, 'New York')).to.equal(true);
        expect(matchesValue(term, 'new york')).to.equal(true);
        expect(matchesValue(term, 'New York City')).to.equal(true);
        expect(matchesValue(term, 'I love New York')).to.equal(true);
        expect(matchesValue(term, 'York New')).to.equal(false);
    });

    it('wildcard is anchored (full value match)', () => {
        const term = parseSearchExpression('*abc*')[0];
        expect(matchesValue(term, 'xabcx')).to.equal(true);
        expect(matchesValue(term, 'abc')).to.equal(true);
    });

    it('regex special characters are escaped in wildcards', () => {
        const term = parseSearchExpression('test(1)*')[0];
        expect(matchesValue(term, 'test(1)abc')).to.equal(true);
        expect(matchesValue(term, 'test1abc')).to.equal(false);
    });

    it('* alone matches everything', () => {
        const term = parseSearchExpression('*')[0];
        expect(matchesValue(term, '')).to.equal(true);
        expect(matchesValue(term, 'anything')).to.equal(true);
    });

    it('? alone matches exactly one character', () => {
        const term = parseSearchExpression('?')[0];
        expect(matchesValue(term, 'a')).to.equal(true);
        expect(matchesValue(term, '')).to.equal(false);
        expect(matchesValue(term, 'ab')).to.equal(false);
    });

    it('exact match with special chars', () => {
        const term = parseSearchExpression('"(test)"')[0];
        expect(matchesValue(term, '(test)')).to.equal(true);
        expect(matchesValue(term, 'test')).to.equal(false);
    });
});

// =============================================================
// matchesRow
// =============================================================

describe('matchesRow', () => {
    const columns = [
        { id: 'name', type: 'string' },
        { id: 'city', type: 'string' },
        { id: 'status', type: 'string' }
    ];

    const rows = [
        { name: 'Alice', city: 'New York', status: 'active' },
        { name: 'Bob', city: 'Los Angeles', status: 'error' },
        { name: 'Charlie', city: 'Chicago', status: 'active' },
        { name: 'abc123', city: 'Dallas', status: 'pending' },
        { name: 'abc124', city: 'Houston', status: 'error' }
    ];

    it('returns true for all rows when terms are empty', () => {
        expect(matchesRow([], rows[0], columns, extractValue)).to.equal(true);
        expect(matchesRow(null, rows[0], columns, extractValue)).to.equal(true);
    });

    it('OR logic: comma-separated terms match any', () => {
        const terms = parseSearchExpression('abc123,abc124');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(2);
        expect(matched[0].name).to.equal('abc123');
        expect(matched[1].name).to.equal('abc124');
    });

    it('negation excludes matching rows', () => {
        const terms = parseSearchExpression('-error');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(3);
        expect(matched.every((r: Record<string, string>) => r.status !== 'error')).to.equal(true);
    });

    it('mixed positive and negative in ONE clause AND-s them', () => {
        // Single clause `abc* -error`: must match abc* AND not contain error.
        const terms = parseSearchExpression('abc* -error');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(1);
        expect(matched[0].name).to.equal('abc123');
    });

    it('comma-separated clauses are independent (issue #261)', () => {
        // `abc*,-error` is OR of two clauses, not "match abc* and exclude error".
        // Clause 1 matches abc*-named rows; clause 2 matches rows whose cells don't contain "error".
        const terms = parseSearchExpression('abc*,-error');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        // Alice (no error) + Charlie (no error) + abc123 (matches abc*) + abc124 (matches abc*)
        expect(matched.map((r: Record<string, string>) => r.name)).to.deep.equal(['Alice', 'Charlie', 'abc123', 'abc124']);
    });

    it('comma-separated pure-negative clauses behave as OR of "not X" (issue #261)', () => {
        // `-error,-pending` = (NOT error) OR (NOT pending) — almost every row.
        // To exclude BOTH use `-error -pending` (single clause, two negatives).
        const terms = parseSearchExpression('-error,-pending');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        // No row has both error AND pending in any cell, so every row matches at least one clause.
        expect(matched).to.have.length(5);
    });

    it('single-clause AND of negatives excludes both (issue #261)', () => {
        const terms = parseSearchExpression('-error -pending');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(2);
        expect(matched.map((r: Record<string, string>) => r.name)).to.deep.equal(['Alice', 'Charlie']);
    });

    it('wildcard search across columns', () => {
        const terms = parseSearchExpression('*angeles*');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(1);
        expect(matched[0].name).to.equal('Bob');
    });

    it('exact match only matches full cell value', () => {
        const terms = parseSearchExpression('"active"');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(2);
    });

    it('plain text is backwards compatible substring match', () => {
        const terms = parseSearchExpression('ali');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(1);
        expect(matched[0].name).to.equal('Alice');
    });

    it('skips group columns', () => {
        const columnsWithGroup = [
            { id: 'name', type: 'string' },
            { id: 'details', type: 'group' },
            { id: 'city', type: 'string' }
        ];
        const terms = parseSearchExpression('Alice');
        expect(matchesRow(terms, rows[0], columnsWithGroup, extractValue)).to.equal(true);
    });

    it('handles regex special chars in plain search', () => {
        const testRows = [{ value: 'test(1)' }, { value: 'test2' }];
        const testCols = [{ id: 'value', type: 'string' }];
        const terms = parseSearchExpression('test(1)');
        const matched = testRows.filter((r: Record<string, unknown>) => matchesRow(terms, r, testCols, extractValue));
        expect(matched).to.have.length(1);
        expect(matched[0].value).to.equal('test(1)');
    });

    it('AND logic: + requires both terms present in row', () => {
        // "active + New York" should match Alice (status=active, city=New York)
        const terms = parseSearchExpression('active + New York');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(1);
        expect(matched[0].name).to.equal('Alice');
    });

    it('AND + OR combined: (abc+Dallas),(Bob)', () => {
        // abc + Dallas matches abc123 (name has abc, city=Dallas)
        // Bob matches Bob
        const terms = parseSearchExpression('abc + Dallas,Bob');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(2);
        expect(matched[0].name).to.equal('Bob');
        expect(matched[1].name).to.equal('abc123');
    });

    it('AND rejects rows missing one term', () => {
        // active + Dallas — no row has both active AND Dallas
        const terms = parseSearchExpression('active + Dallas');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(0);
    });

    it('AND with negation in a single clause excludes within that clause', () => {
        // `active + Chicago -Charlie` (single clause): match if (active AND Chicago AND NOT Charlie).
        // Charlie is the only row with active+Chicago, and the -Charlie kills it.
        const terms = parseSearchExpression('active + Chicago -Charlie');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(0);
    });

    it('AND with wildcards', () => {
        // abc* + pending — abc123 has name starting with abc AND status=pending
        const terms = parseSearchExpression('abc* + pending');
        const matched = rows.filter((r: Record<string, unknown>) => matchesRow(terms, r, columns, extractValue));
        expect(matched).to.have.length(1);
        expect(matched[0].name).to.equal('abc123');
    });

    // GitHub Issue #261: hyphen-in-ID + exclude
    it('hyphenated ID with space-prefixed exclude', () => {
        const idRows = [
            { id: 'ACAU-ASR3690', code: '07' },
            { id: 'ACAU-ASR3690', code: '99' },
            { id: 'OTHER-ID', code: '07' }
        ];
        const idCols = [{ id: 'id', type: 'string' }, { id: 'code', type: 'string' }];
        const terms = parseSearchExpression('ACAU-ASR3690 -"07"');
        const matched = idRows.filter((r: Record<string, unknown>) => matchesRow(terms, r, idCols, extractValue));
        expect(matched).to.have.length(1);
        expect(matched[0].code).to.equal('99');
    });

    // GitHub Issue #261 (follow-up): negative in a mixed clause is scoped to
    // that clause, so adding another OR clause can bring rows back even if
    // the first clause's `-foo` would have killed them.
    it('scoped negative — `WOOF -Rub +da,Rub` includes Rub-matching rows via the second clause', () => {
        const dogRows = [
            { sku: 'SKU-WOOF-da-001', desc: 'Anti-Mailman' },      // WOOF + da, no Rub → clause 1
            { sku: 'SKU-WOOF-da-002', desc: 'Self-Cleaning' },     // WOOF + da, no Rub → clause 1
            { sku: 'SKU-WOOF-da-003', desc: 'Rubber Toy' },        // WOOF + da BUT has Rub → killed in clause 1, saved by clause 2
            { sku: 'SKU-NORM-001',    desc: 'Rubber widget' },     // has Rub, no WOOF → clause 2 only
            { sku: 'SKU-NORM-002',    desc: 'Plain widget' }       // matches nothing
        ];
        const dogCols = [{ id: 'sku', type: 'string' }, { id: 'desc', type: 'string' }];
        const terms = parseSearchExpression('WOOF -Rub +da,Rub');
        const matched = dogRows.filter((r: Record<string, unknown>) => matchesRow(terms, r, dogCols, extractValue));
        expect(matched).to.have.length(4);
        expect(matched.map((r: Record<string, string>) => r.sku)).to.deep.equal([
            'SKU-WOOF-da-001', 'SKU-WOOF-da-002', 'SKU-WOOF-da-003', 'SKU-NORM-001'
        ]);
    });
});

// =============================================================
// Issue #270c — deep-stringify object/array cells for search
// =============================================================

describe('matchesRow — nested object/array cells (issue #270c)', () => {
    const cols = [
        { id: 'itemId', type: 'string' },
        { id: 'taxes', type: 'array' },
        { id: 'meta', type: 'object' }
    ];

    it('matches content inside an array cell (was [object Object] before)', () => {
        const row = { itemId: 'SKU-1', taxes: [{ code: 'VAT', rate: 0.2 }], meta: {} };
        const terms = parseSearchExpression('VAT');
        expect(matchesRow(terms, row, cols, extractValue)).to.equal(true);
    });

    it('matches deeply nested content inside an object cell', () => {
        const row = {
            itemId: 'SKU-2',
            taxes: [],
            meta: { source: { file: 'response-847.json' } }
        };
        const terms = parseSearchExpression('response-847');
        expect(matchesRow(terms, row, cols, extractValue)).to.equal(true);
    });

    it('does not match a string that is absent from the serialised object', () => {
        const row = { itemId: 'SKU-3', taxes: [{ code: 'VAT' }], meta: {} };
        const terms = parseSearchExpression('GST');
        expect(matchesRow(terms, row, cols, extractValue)).to.equal(false);
    });

    it('never produces the literal "[object Object]" as a match target', () => {
        const row = { itemId: 'SKU-4', taxes: [{ code: 'VAT' }], meta: { a: 1 } };
        const terms = parseSearchExpression('object Object');
        expect(matchesRow(terms, row, cols, extractValue)).to.equal(false);
    });
});

// =============================================================
// tokenizeForDisplay
// =============================================================

describe('tokenizeForDisplay', () => {
    it('returns empty array for empty input', () => {
        expect(tokenizeForDisplay('')).to.deep.equal([]);
        expect(tokenizeForDisplay(null)).to.deep.equal([]);
        expect(tokenizeForDisplay(undefined)).to.deep.equal([]);
    });

    it('plain text is one term-1 segment in group 0', () => {
        const segs = tokenizeForDisplay('hello');
        expect(segs).to.deep.equal([{ text: 'hello', kind: 'term-1', orGroup: 0 }]);
    });

    it('comma is op-or, sits between groups (orGroup -1), and groups increment', () => {
        const segs = tokenizeForDisplay('foo,bar');
        expect(segs).to.deep.equal([
            { text: 'foo', kind: 'term-1', orGroup: 0 },
            { text: ',', kind: 'op-or', orGroup: -1 },
            { text: 'bar', kind: 'term-2', orGroup: 1 }
        ]);
    });

    it('three OR groups: term-1 / term-2 / term-1, comma separators between', () => {
        const segs = tokenizeForDisplay('a,b,c');
        expect(segs.map((s: { kind: string; orGroup: number }) => ({ kind: s.kind, orGroup: s.orGroup }))).to.deep.equal([
            { kind: 'term-1', orGroup: 0 },
            { kind: 'op-or', orGroup: -1 },
            { kind: 'term-2', orGroup: 1 },
            { kind: 'op-or', orGroup: -1 },
            { kind: 'term-1', orGroup: 2 }
        ]);
    });

    function shape(segs: { text: string; kind: string }[]) {
        return segs.map(s => ({ text: s.text, kind: s.kind }));
    }

    it('space + space lights up + as op-and', () => {
        const segs = tokenizeForDisplay('foo + bar');
        const kinds = segs.map((s: { kind: string }) => s.kind);
        expect(kinds).to.deep.equal(['term-1', 'term-1', 'op-and', 'term-1', 'term-1']);
        // both 'foo' and 'bar' are term-1 (same OR group)
    });

    it('space - lights up - as op-not', () => {
        const segs = tokenizeForDisplay('foo -bar');
        expect(shape(segs)).to.deep.equal([
            { text: 'foo', kind: 'term-1' },
            { text: ' ', kind: 'term-1' },
            { text: '-', kind: 'op-not' },
            { text: 'bar', kind: 'term-1' }
        ]);
    });

    it('mid-word - does NOT light up (hyphen in ID)', () => {
        const segs = tokenizeForDisplay('ACAU-ASR3690-"07"');
        // The whole `ACAU-ASR3690-` is one literal term, then the quoted "07"
        const kinds = segs.map((s: { kind: string }) => s.kind);
        expect(kinds).to.not.include('op-not');
        // Should be one term-1 followed by a quoted segment
        expect(shape(segs)).to.deep.equal([
            { text: 'ACAU-ASR3690-', kind: 'term-1' },
            { text: '"07"', kind: 'quoted' }
        ]);
    });

    it('boundary + after a hyphenated ID', () => {
        const segs = tokenizeForDisplay('ACAU-ASR3690 + "07"');
        expect(shape(segs)).to.deep.equal([
            { text: 'ACAU-ASR3690', kind: 'term-1' },
            { text: ' ', kind: 'term-1' },
            { text: '+', kind: 'op-and' },
            { text: ' ', kind: 'term-1' },
            { text: '"07"', kind: 'quoted' }
        ]);
    });

    it('mid-word + is literal (no space)', () => {
        const segs = tokenizeForDisplay('foo+bar');
        expect(shape(segs)).to.deep.equal([{ text: 'foo+bar', kind: 'term-1' }]);
    });

    it('quoted segment includes surrounding quotes', () => {
        const segs = tokenizeForDisplay('"New York"');
        expect(shape(segs)).to.deep.equal([{ text: '"New York"', kind: 'quoted' }]);
    });

    it('wildcards are highlighted separately', () => {
        const segs = tokenizeForDisplay('*foo?');
        expect(shape(segs)).to.deep.equal([
            { text: '*', kind: 'wildcard' },
            { text: 'foo', kind: 'term-1' },
            { text: '?', kind: 'wildcard' }
        ]);
    });

    it('leading - on plain term is op-not', () => {
        const segs = tokenizeForDisplay('-error');
        expect(shape(segs)).to.deep.equal([
            { text: '-', kind: 'op-not' },
            { text: 'error', kind: 'term-1' }
        ]);
    });

    it('lone - is literal, not op-not', () => {
        const segs = tokenizeForDisplay('-');
        expect(shape(segs)).to.deep.equal([{ text: '-', kind: 'term-1' }]);
    });

    it('boundary - lights up even when followed by whitespace (`door - 1a6`)', () => {
        const segs = tokenizeForDisplay('door - 1a6');
        expect(shape(segs)).to.deep.equal([
            { text: 'door', kind: 'term-1' },
            { text: ' ', kind: 'term-1' },
            { text: '-', kind: 'op-not' },
            { text: ' ', kind: 'term-1' },
            { text: '1a6', kind: 'term-1' }
        ]);
    });

    it('trailing dash with only whitespace after stays literal', () => {
        const segs = tokenizeForDisplay('foo - ');
        // The `-` is not followed by a real term so it stays in a term span
        const kinds = segs.map((s: { kind: string }) => s.kind);
        expect(kinds).to.not.include('op-not');
    });

    it('reconstruction round-trips the original input', () => {
        const inputs = [
            'foo',
            'foo, bar, baz',
            'ACAU-ASR3690 -"07"',
            '"New York" + active',
            '-error,*.json',
            'foo+bar - baz',
            '@status=active woof',
            '@uom=EA,CS @uom=EA|CS @q=1..9 @"lot number"~ "A 1" x',
            '@stat',
            '@d~all, @d~Belly x,y'
        ];
        for (const inp of inputs) {
            const reconstructed = tokenizeForDisplay(inp).map((s: { text: string }) => s.text).join('');
            expect(reconstructed).to.equal(inp);
        }
    });
});

describe('Search: @column terms', () => {
    const cols = [{ id: 'sku', name: 'sku' }, { id: 'item.status', name: 'status' }, { id: 'qty', name: 'quantityOnHand' }, { id: 'uom', name: 'uom' }, { id: 'lot', name: 'lot number' }];
    const rows = [
        { sku: 'SKU-WOOF-1', 'item.status': 'active', qty: 5, uom: 'EA', lot: 'A 1' },
        { sku: 'SKU-MEOW-2', 'item.status': 'reserved', qty: 20, uom: 'CS', lot: '' },
        { sku: 'SKU-WOOF-3', 'item.status': 'Active', qty: 50, uom: 'CS', lot: null },
    ];
    const find = (q: string) => rows.filter(r => matchesRow(parseSearchExpression(q), r, cols, (row: Record<string, unknown>, id: string) => row[id])).map(r => r.sku);

    it('= is, != is not, any case, by heading or a path\'s last part', () => {
        expect(find('@status=active')).to.deep.equal(['SKU-WOOF-1', 'SKU-WOOF-3']);
        expect(find('@STATUS!=active')).to.deep.equal(['SKU-MEOW-2']);
        expect(find('@item.status=reserved')).to.deep.equal(['SKU-MEOW-2']);
    });
    it('~ contains, !~ does not', () => {
        expect(find('@sku~woof')).to.deep.equal(['SKU-WOOF-1', 'SKU-WOOF-3']);
        expect(find('@sku!~woof')).to.deep.equal(['SKU-MEOW-2']);
    });
    it('> < >= <= as numbers when both are', () => {
        expect(find('@quantityOnHand>10')).to.deep.equal(['SKU-MEOW-2', 'SKU-WOOF-3']);
        expect(find('@quantityOnHand<=20')).to.deep.equal(['SKU-WOOF-1', 'SKU-MEOW-2']);
    });
    it('a space is always "and", the same column again too; words still search the row', () => {
        expect(find('@uom=CS @status=active')).to.deep.equal(['SKU-WOOF-3']);
        expect(find('@uom=EA @uom=CS')).to.deep.equal([]);
        expect(find('@quantityOnHand>10 @quantityOnHand<30')).to.deep.equal(['SKU-MEOW-2']);
        expect(find('@status!=active @status!=reserved')).to.deep.equal([]);
        expect(find('@status=active 3')).to.deep.equal(['SKU-WOOF-3']);
    });
    it('quotes for spaces, "" for blank, * and ? as wildcards', () => {
        expect(find('@"lot number"="A 1"')).to.deep.equal(['SKU-WOOF-1']);
        expect(find('@"lot number"=""')).to.deep.equal(['SKU-MEOW-2', 'SKU-WOOF-3']);
        expect(find('@sku=SKU-*-3')).to.deep.equal(['SKU-WOOF-3']);
    });
    it('a column no row has matches nothing; @column still being typed filters nothing', () => {
        expect(find('@colour=red')).to.deep.equal([]);
        expect(find('@stat')).to.have.length(3);
        expect(find('@status=')).to.have.length(3);
    });
    it('| is any of; with != and !~ none of them', () => {
        expect(find('@uom=EA|CS @status=active')).to.deep.equal(['SKU-WOOF-1', 'SKU-WOOF-3']);
        expect(find('@status=reserved|ACTIVE')).to.have.length(3);
        expect(find('@sku~WOOF-1|MEOW')).to.deep.equal(['SKU-WOOF-1', 'SKU-MEOW-2']);
        expect(find('@status!=reserved|active')).to.deep.equal([]);
        expect(find('@sku!~WOOF-1|MEOW')).to.deep.equal(['SKU-WOOF-3']);
        expect(find('@uom="EA|CS"')).to.deep.equal([]);   // quoted: the text itself
    });
    it('.. is between, both ends in; an end left out is no limit; != is outside it', () => {
        expect(find('@quantityOnHand=5..20')).to.deep.equal(['SKU-WOOF-1', 'SKU-MEOW-2']);
        expect(find('@quantityOnHand=6..20')).to.deep.equal(['SKU-MEOW-2']);
        expect(find('@quantityOnHand=20..')).to.deep.equal(['SKU-MEOW-2', 'SKU-WOOF-3']);
        expect(find('@quantityOnHand=*..5')).to.deep.equal(['SKU-WOOF-1']);
        expect(find('@quantityOnHand!=5..20')).to.deep.equal(['SKU-WOOF-3']);
        expect(find('@quantityOnHand=1..5|50..60')).to.deep.equal(['SKU-WOOF-1', 'SKU-WOOF-3']);
        expect(find('@sku=SKU-M..SKU-N')).to.deep.equal(['SKU-MEOW-2']);   // text order
        expect(find('@"lot number"=A..Z')).to.deep.equal(['SKU-WOOF-1']);   // blanks are never in a range
    });
    it('a comma is always "or" between parts, space or not; it ends a value unless quoted', () => {
        expect(find('@sku~WOOF-1, @sku~MEOW')).to.deep.equal(['SKU-WOOF-1', 'SKU-MEOW-2']);
        expect(find('@sku~WOOF-1,@sku~MEOW')).to.deep.equal(['SKU-WOOF-1', 'SKU-MEOW-2']);
        expect(find('@uom=EA,MEOW')).to.deep.equal(find('@uom=EA, MEOW'));
        expect(find('@uom=EA,MEOW')).to.deep.equal(['SKU-WOOF-1', 'SKU-MEOW-2']);
        expect(find('@uom="EA,CS"')).to.deep.equal([]);
        expect(find('@uom=CS @status=active, @quantityOnHand<10')).to.deep.equal(['SKU-WOOF-1', 'SKU-WOOF-3']);
    });
    it('suggests the columns after @, then the operators', () => {
        expect(columnSuggestions('x @st', ['sku', 'status', 'lot number']).map((s: { text: string }) => s.text)).to.deep.equal(['@status']);
        expect(columnSuggestions('@lot', ['lot number'])[0].text).to.equal('@"lot number"');
        expect(columnSuggestions('@status', ['status']).map((s: { text: string }) => s.text)).to.include.members(['=', '!=', '~', '>']);
        expect(columnSuggestions('status', ['status'])).to.deep.equal([]);
    });
});

// Nested data in a column: a term is asked of the values inside it, and a key can be named after a dot
describe('Search: @column terms on nested data', () => {
    const cols = [{ id: 'order', type: 'string' }, { id: 'data.itemCode', name: 'itemCode', type: 'array' }, { id: 'meta', type: 'object' }];
    const rows = [
        { order: 'SO-1', 'data.itemCode': [{ key: 'A-2207', value: 'Olive oil', qty: 24 }, { key: 'C-7001', value: 'Paper cups', qty: 10 }], meta: { carrier: { name: 'DHL' } } },
        { order: 'SO-2', 'data.itemCode': [{ key: 'B-0418', value: 'Espresso beans', qty: 60 }], meta: { carrier: { name: 'UPS' } } },
        { order: 'SO-3', 'data.itemCode': [], meta: {} }
    ];
    const value = (row: Record<string, unknown>, id: string) => row[id];
    const found = (search: string) => rows.filter(row => matchesRow(parseSearchExpression(search), row, cols, value)).map(row => row.order);

    it('= on the whole column is met by any value inside it (it never matched before)', () => {
        expect(found('@itemCode=A-2207')).to.deep.equal(['SO-1']);
        expect(found('@itemCode="olive oil"')).to.deep.equal(['SO-1']);
        expect(found('@itemCode=olive')).to.deep.equal([]);            // is, not contains
    });

    it('a key named after a dot asks only that key', () => {
        expect(found('@itemCode.key=A-2207')).to.deep.equal(['SO-1']);
        expect(found('@itemCode.value=A-2207')).to.deep.equal([]);
        expect(found('@itemCode.value~beans')).to.deep.equal(['SO-2']);
        expect(found('@ITEMCODE.KEY=b-0418')).to.deep.equal(['SO-2']);  // any case, as columns are
        expect(found('@data.itemCode.key=C-7001')).to.deep.equal(['SO-1']);   // the column by its whole id
        expect(found('@meta.carrier.name=DHL')).to.deep.equal(['SO-1']);      // keys within keys
    });

    it('more than, less than and between work on a key, as numbers', () => {
        expect(found('@itemCode.qty>40')).to.deep.equal(['SO-2']);
        expect(found('@itemCode.qty=5..15')).to.deep.equal(['SO-1']);
        expect(found('@itemCode.qty<=10')).to.deep.equal(['SO-1']);
    });

    it('!= and !~ are met only when no value inside matches', () => {
        expect(found('@itemCode.key!=A-2207')).to.deep.equal(['SO-2', 'SO-3']);
        expect(found('@itemCode.value!~cups')).to.deep.equal(['SO-2', 'SO-3']);
    });

    it('nothing inside is blank; a key no item has matches nothing', () => {
        expect(found('@itemCode=""')).to.deep.equal(['SO-3']);
        expect(found('@itemCode.nope=A-2207')).to.deep.equal([]);
        expect(found('@nope.key=A-2207')).to.deep.equal([]);
    });

    it('~ on the whole column still reads its text, and plain columns are as they were', () => {
        expect(found('@itemCode~olive')).to.deep.equal(['SO-1']);
        expect(found('@order=SO-2')).to.deep.equal(['SO-2']);
        expect(found('@itemCode.key=A-2207, @order=SO-3')).to.deep.equal(['SO-1', 'SO-3']);
    });
});

// Letters meet a name at the start of a word, never inside one (James, 2026-11-22: "@bl" listed quantityAvailable)
describe('Search: suggestions match at the start of a word', () => {
    const headings = ['quantityAvailable', 'quantityOnHand', 'BL.quantityOnHand', 'C1.quantityOnHand', 'sku', 'lot number', 'order_no'];
    const texts = (typed: string) => columnSuggestions(typed, headings).map((s: { text: string }) => s.text);

    it('never inside a word: "bl" is not in "Available"', () => {
        expect(texts('@bl')).to.deep.equal(['@BL.quantityOnHand']);
        expect(texts('@avail')).to.deep.equal(['@quantityAvailable']);
    });

    it('a word of a camelCase name, after a dot, an underscore or a space; typed on across words', () => {
        expect(texts('@hand')).to.deep.equal(['@BL.quantityOnHand', '@C1.quantityOnHand', '@quantityOnHand']);
        expect(texts('@onhand')).to.deep.equal(['@BL.quantityOnHand', '@C1.quantityOnHand', '@quantityOnHand']);
        expect(texts('@num')).to.deep.equal(['@"lot number"']);
        expect(texts('@no')).to.deep.equal(['@order_no']);                      // (not the "On" of quantityOnHand: "no" starts no word there)
        expect(texts('@bl.qua')).to.deep.equal(['@BL.quantityOnHand']);
        expect(texts('@bl.')).to.deep.equal(['@BL.quantityOnHand']);
    });

    it('names that start with it first', () => {
        expect(texts('@qua')).to.deep.equal(['@quantityAvailable', '@quantityOnHand', '@BL.quantityOnHand', '@C1.quantityOnHand']);
    });
});

// `@column.` lists the keys inside a column's nested data, then the operators
describe('Search: suggestions inside nested data', () => {
    const cells = [[{ key: 'A-2207', value: 'Olive oil', dims: { weight: 1, 'box size': 3 } }], [{ key: 'B-0418', qty: 6 }], 'plain', null];
    const keysOf = (heading: string, path: string[]) => (heading === 'itemCode' ? nestedKeys(cells, path) : []);
    const texts = (typed: string) => columnSuggestions(typed, ['order', 'itemCode'], keysOf).map((s: { text: string }) => s.text);

    it('finds the keys of the objects in a list, first seen first, and under a path', () => {
        expect(nestedKeys(cells, [])).to.deep.equal(['key', 'value', 'dims', 'qty']);
        expect(nestedKeys(cells, ['dims'])).to.deep.equal(['weight']);          // a key with a space cannot be typed: left out
        expect(nestedKeys(cells, ['nope'])).to.deep.equal([]);
        const rows = [{ 'data.itemCode': cells[0] }, { 'data.itemCode': cells[1] }];
        expect(nestedKeysFor(rows, [{ id: 'data.itemCode', name: 'itemCode', type: 'array' }], 'ITEMCODE', [], (r: Record<string, unknown>, id: string) => r[id])).to.deep.equal(['key', 'value', 'dims', 'qty']);
    });

    it('a nested column says so, and typed in full offers a dot before the operators', () => {
        const all = columnSuggestions('@', ['order', 'itemCode'], keysOf);
        expect(all.map((s: { text: string; label: string }) => `${s.text} ${s.label}`)).to.deep.equal(['@itemCode column, nested', '@order column']);
        expect(texts('@itemCode')[0]).to.equal('.');
        expect(texts('@itemCode')).to.include('=');
        expect(texts('@order')[0]).to.equal('=');                                // a plain column: no dot
    });

    it('after the dot it lists the keys, narrows as you type, then the operators', () => {
        expect(texts('@itemCode.')).to.deep.equal(['@itemCode.key', '@itemCode.value', '@itemCode.dims', '@itemCode.qty']);
        expect(texts('@itemCode.v')).to.deep.equal(['@itemCode.value']);
        expect(texts('status @ITEMCODE.K')).to.deep.equal(['@itemCode.key']);
        expect(texts('@itemCode.key')[0]).to.equal('=');
        expect(texts('@itemCode.dims')[0]).to.equal('.');                        // keys within keys
        expect(texts('@itemCode.dims.')).to.deep.equal(['@itemCode.dims.weight']);
        expect(texts('@order.')).to.deep.equal([]);                              // nothing nested in it
    });

    it('with no keys given, suggestions are as they were', () => {
        expect(columnSuggestions('@sta', ['status']).map((s: { text: string; label: string }) => `${s.text} ${s.label}`)).to.deep.equal(['@status column']);
    });
});

// =============================================================
// Times, and what kind of column a search is asked of
// =============================================================

describe('Search: times (today, 7d, ISO 8601) are compared as times', () => {
    const { resolveTime, timeOfCell } = require('../../../webviews/shared/search-matcher.js');
    // 3 pm on 19 Nov 2026, by this computer's clock
    const NOW = new Date(2026, 10, 19, 15, 0, 0).getTime();
    const columns = [{ id: 'placed', name: 'placed' }, { id: 'at', name: 'at' }, { id: 'code', name: 'code' }, { id: 'lines', name: 'lines' }];
    const rows = [
        { n: 1, placed: '2026-11-19', at: '2026-11-19T14:30:00', code: '7d', lines: [{ shipped: '2026-11-18' }] },
        { n: 2, placed: '2026-11-18', at: '2026-11-19T09:00:00', code: 'today', lines: [{ shipped: '2026-11-01' }] },
        { n: 3, placed: '2026-11-10', at: '2026-11-01 08:00:00.120', code: 'x', lines: [] },
        { n: 4, placed: '2026-10-01', at: '2026-10-01T00:00:00Z', code: 'y', lines: [{ shipped: '2026-09-30' }, { shipped: '2026-11-19' }] }
    ];
    const found = (search: string): number[] => {
        const terms = parseSearchExpression(search, NOW);
        return rows.filter(row => matchesRow(terms, row, columns, extractValue)).map(row => row.n);
    };

    it('today and yesterday are whole days; > is after, >= includes', () => {
        expect(found('@placed=today')).to.deep.equal([1]);
        expect(found('@placed=yesterday')).to.deep.equal([2]);
        expect(found('@placed>yesterday')).to.deep.equal([1]);
        expect(found('@placed>=yesterday')).to.deep.equal([1, 2]);
        expect(found('@placed<today')).to.deep.equal([2, 3, 4]);
    });

    it('so many days, weeks, hours or minutes ago; a range with .. is between, either way round', () => {
        expect(found('@placed>7d')).to.deep.equal([1, 2]);
        expect(found('@placed<7d')).to.deep.equal([3, 4]);
        expect(found('@placed>2w')).to.deep.equal([1, 2, 3]);
        expect(found('@placed=30d..7d')).to.deep.equal([3]);
        expect(found('@placed=7d..30d')).to.deep.equal([3]);
        expect(found('@placed=7d..')).to.deep.equal([1, 2]);
        expect(found('@placed!=7d..')).to.deep.equal([3, 4]);
        expect(found('@at>2h')).to.deep.equal([1]);
        expect(found('@at>45m')).to.deep.equal([1]);
        expect(found('@at>20m')).to.deep.equal([]);
        expect(found('@placed=9d')).to.deep.equal([3]);   // nine days ago, asked with =, is that day
    });

    it('a day typed finds every time on it, and after it is after the day ends', () => {
        expect(found('@at=today')).to.deep.equal([1, 2]);
        expect(found('@at=2026-11-01')).to.deep.equal([3]);
        expect(found('@at>2026-11-01')).to.deep.equal([1, 2]);
        expect(found('@at>=2026-11-01')).to.deep.equal([1, 2, 3]);
        expect(found('@placed=2026-11-18|2026-11-10')).to.deep.equal([2, 3]);
        expect(found('@placed=2026-11-10..2026-11-18')).to.deep.equal([2, 3]);
    });

    it('a value that only looks like a time is still text against a cell that is not a time', () => {
        expect(found('@code=7d')).to.deep.equal([1]);
        expect(found('@code=today')).to.deep.equal([2]);
    });

    it('inside nested data too: any one will do, and none with !=', () => {
        expect(found('@lines.shipped>7d')).to.deep.equal([1, 4]);
        expect(found('@lines.shipped=today')).to.deep.equal([4]);
        expect(found('@lines.shipped!=today')).to.deep.equal([1, 2, 3]);
    });

    it('resolveTime and timeOfCell: one meaning for the page and the host', () => {
        const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime();
        expect(resolveTime('today', NOW)).to.include({ from: day(2026, 10, 19), to: day(2026, 10, 20) - 1 });
        expect(resolveTime('yesterday', NOW)).to.include({ from: day(2026, 10, 18), to: day(2026, 10, 19) - 1 });
        expect(resolveTime('2h', NOW)).to.include({ from: NOW - 7200000, to: NOW - 7200000 });
        expect(resolveTime('7d', NOW)).to.include({ from: NOW - 7 * 86400000 });
        expect(resolveTime('2w', NOW)).to.include({ from: NOW - 14 * 86400000 });
        // A day alone, and a time with no zone, are this computer's; Z or an offset is exact
        expect(timeOfCell('2026-11-19')).to.include({ from: day(2026, 10, 19), to: day(2026, 10, 20) - 1 });
        expect(timeOfCell('2026-11-19T09:15:02').from).to.equal(new Date(2026, 10, 19, 9, 15, 2).getTime());
        expect(timeOfCell('2026-11-19 09:15').from).to.equal(new Date(2026, 10, 19, 9, 15, 0).getTime());
        expect(timeOfCell('2026-11-19T09:15:02Z').from).to.equal(Date.UTC(2026, 10, 19, 9, 15, 2));
        expect(timeOfCell('2026-11-19T09:15:02.5+10:00').from).to.equal(Date.UTC(2026, 10, 18, 23, 15, 2, 500));
        for (const not of ['19/11/2026', '2026', 'soon', '7', '3..7', '']) {
            expect(timeOfCell(not), not).to.equal(null);
            expect(resolveTime(not, NOW), not).to.equal(null);
        }
    });

    it('numbers are untouched: a bare 3..7 is still numbers', () => {
        const qty = [{ id: 'qty', name: 'qty' }];
        const terms = parseSearchExpression('@qty=3..7', NOW);
        expect([{ qty: 2 }, { qty: 5 }, { qty: 9 }].filter(row => matchesRow(terms, row, qty, extractValue)).map(row => row.qty)).to.deep.equal([5]);
    });
});

describe('Search: suggestions that know what a column is', () => {
    const { typeOfValues, describeSearch } = require('../../../webviews/shared/search-matcher.js');
    const NOW = new Date(2026, 10, 19, 15, 0, 0).getTime();
    const headings = ['poNumber', 'poDate', 'urgent', 'qty', 'lines'];
    const kinds: Record<string, string> = { poNumber: 'text', poDate: 'date', urgent: 'yesno', qty: 'number', lines: 'nested', 'lines.qty': 'number' };
    const types = (heading: string, path: string[]) => kinds[[heading].concat(path || []).join('.')] || '';
    const keys = (heading: string, path: string[]) => (heading === 'lines' && !path.length ? ['item', 'qty'] : []);
    const list = (typed: string) => columnSuggestions(typed, headings, keys, types).map((s: { text: string; label: string }) => `${s.text} ${s.label}`.trim());

    it('the kind of each column is told from its values', () => {
        expect(typeOfValues([true, false, null])).to.equal('yesno');
        expect(typeOfValues([1, 2.5, ''])).to.equal('number');
        expect(typeOfValues(['2026-11-19', '2026-11-19T09:15:02Z'])).to.equal('date');
        expect(typeOfValues(['2026-11-19', 'soon'])).to.equal('text');
        expect(typeOfValues(['12', '13'])).to.equal('text');   // text that looks like numbers is still text
        expect(typeOfValues([[{ a: 1 }], null])).to.equal('nested');
        expect(typeOfValues([null, ''])).to.equal('');
    });

    it('the @ list says what each column is', () => {
        expect(list('@')).to.have.members(['@lines nested', '@poDate date', '@poNumber text', '@qty number', '@urgent yes/no']);
        expect(list('@lines.')).to.deep.equal(['@lines.item key', '@lines.qty number']);
    });

    it('a column typed in full is offered the operators that fit it', () => {
        expect(list('@poDate')).to.deep.equal(['> after', '< before', '= on, or between', '>= on or after', '<= on or before']);
        expect(list('@urgent')).to.deep.equal(['= is', '!= is not']);
        expect(list('@qty')[0]).to.equal('> more than');
        expect(list('@poNumber')).to.deep.equal(['= is (a|b either)', '!= is not', '~ contains', "!~ doesn't contain"]);
        expect(list('@lines')[0]).to.equal('. a key inside it');
        expect(list('@lines.qty')[0]).to.equal('> more than');
    });

    it('after an operator: true or false for yes/no, and the usual times for a date', () => {
        expect(list('@urgent=')).to.deep.equal(['true', 'false']);
        expect(list('@urgent=f')).to.deep.equal(['false']);
        expect(list('@urgent=false')).to.deep.equal([]);
        expect(list('@poDate>').map((s: string) => s.split(' ')[0])).to.deep.equal(['today', 'yesterday', '7d', '30d', '2h']);
        expect(list('@poDate=').map((s: string) => s.split(' ')[0])).to.deep.equal(['today', 'yesterday', '7d..', '30d..', '30d..7d']);
        expect(list('@poDate=3')).to.deep.equal(['30d.. the last 30 days', '30d..7d between 30 and 7 days ago']);
        expect(list('@qty>')).to.deep.equal([]);
        expect(list('@poNumber=')).to.deep.equal([]);
    });

    it('with no types given, nothing changes', () => {
        expect(columnSuggestions('@poDate', headings).map((s: { text: string }) => s.text)).to.deep.equal(['=', '!=', '~', '!~', '>', '<', '>=', '<=']);
        expect(columnSuggestions('@poDate>', headings)).to.deep.equal([]);
    });

    it('the search in words says how it is being read', () => {
        const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        expect(describeSearch('@poDate>7d', headings, types, NOW)).to.equal(`Reading this as: poDate (date) after ${date(NOW - 7 * 86400000)}`);
        expect(describeSearch('@urgent=true kettle', headings, types, NOW)).to.equal('Reading this as: urgent (yes/no) is yes and the row holds kettle');
        expect(describeSearch('@qty=10..90', headings, types, NOW)).to.equal('Reading this as: qty (number) is from 10 to 90');
        expect(describeSearch('@poDate=30d..7d', headings, types, NOW)).to.equal(`Reading this as: poDate (date) is from ${date(NOW - 30 * 86400000)} to ${date(NOW - 7 * 86400000)}`);
        expect(describeSearch('@poDate>soon', headings, types, NOW)).to.equal('Reading this as: poDate (date) after soon (not a date)');
        expect(describeSearch('@qty>lots', headings, types, NOW)).to.equal('Reading this as: qty (number) more than lots (not a number)');
        expect(describeSearch('@lines.qty>40', headings, types, NOW)).to.equal('Reading this as: lines.qty (number) more than 40');
        expect(describeSearch('@nothere=1', headings, types, NOW)).to.equal('Reading this as: no column called nothere');
        // Nothing asked of a column, or still being typed: nothing to say
        expect(describeSearch('kettle', headings, types, NOW)).to.equal('');
        expect(describeSearch('@poDate>', headings, types, NOW)).to.equal('');
    });
});

describe('Search: a column the table does not have shows as unknown', () => {
    const headings = ['order_no', 'customer', 'lines'];
    const kinds = (text: string) => tokenizeForDisplay(text, headings).filter((t: { kind: string }) => t.kind.startsWith('col-')).map((t: { text: string; kind: string }) => `${t.text}:${t.kind}`);

    it('a name that is no column is col-unknown; a column, or a key inside one, is col-name', () => {
        expect(kinds('@nothere=1')).to.deep.equal(['@nothere:col-unknown', '=:col-op', '1:col-value']);
        expect(kinds('@customer=x')[0]).to.equal('@customer:col-name');
        expect(kinds('@CUSTOMER=x')[0]).to.equal('@CUSTOMER:col-name');
        expect(kinds('@lines.qty>4')[0]).to.equal('@lines.qty:col-name');
        expect(kinds('@liness.qty>4')[0]).to.equal('@liness.qty:col-unknown');
    });

    it('not while a column name is still being typed', () => {
        expect(kinds('@cust')).to.deep.equal(['@cust:col-name']);
        expect(kinds('@')).to.deep.equal(['@:col-name']);
        // ...but a start no column has, or a part-name with an operator after it, is unknown
        expect(kinds('@zz')).to.deep.equal(['@zz:col-unknown']);
        expect(kinds('@cust=x')[0]).to.equal('@cust:col-unknown');
    });

    it('with no column names given, every name is col-name as before', () => {
        expect(tokenizeForDisplay('@nothere=1')[0].kind).to.equal('col-name');
    });
});


// =============================================================
// One search for the Hub and every table (James, 2026-11-21)
// =============================================================

describe('one search: plain words', () => {
    const cols = [{ id: 'request' }, { id: 'endpoint' }];
    const get = (row: Record<string, string>, id: string) => row[id];
    const row = { request: 'GET /inventory', endpoint: 'Playground — List Inventory' };
    const finds = (q: string, r: Record<string, string> = row) => matchesRow(parseSearchExpression(q), r, cols, get);

    it('a space is AND: each word anywhere in the row, in any order', () => {
        expect(finds('get inventory')).to.equal(true);
        expect(finds('inventory get')).to.equal(true);
        expect(finds('get playground')).to.equal(true);   // (in two different columns)
        expect(finds('get orders')).to.equal(false);
    });
    it('-word leaves a row out; comma is OR; ` + ` still reads as AND', () => {
        expect(finds('get -playground')).to.equal(false);
        expect(finds('post, inventory')).to.equal(true);
        expect(finds('get + inventory')).to.equal(true);
    });
    it('`-` `_` `.` `/` read as spaces: bulk up finds bulk-upload; an id with hyphens or underscores is still one word', () => {
        expect(finds('bulk up', { request: 'POST /bulk-upload', endpoint: '' })).to.equal(true);
        expect(finds('ACAU-ASR3690', { request: 'x ACAU-ASR3690', endpoint: '' })).to.equal(true);
        expect(finds('batch_1732', { request: 'batch_1732_7', endpoint: '' })).to.equal(true);
        expect(finds('batch_1732', { request: 'batch 99 1732', endpoint: '' })).to.equal(false);
    });
    it('a quoted phrase stays one, in order', () => {
        expect(finds('"list inventory"')).to.equal(true);
        expect(finds('"inventory list"')).to.equal(false);
    });
    it('column terms keep their whole values (hyphens, quotes), with words beside them', () => {
        const logs = [{ id: 'source' }, { id: 'run' }, { id: 'level' }, { id: 'text' }];
        const line = { source: 'sign-in', run: '7c1e40aa-5d1f-4c55', level: 'warn', text: 'token sent' };
        const at = (r: Record<string, string>, id: string) => r[id];
        expect(matchesRow(parseSearchExpression('@source=sign-in'), line, logs, at)).to.equal(true);
        expect(matchesRow(parseSearchExpression('@run=7c1e40aa-5d1f-4c55'), line, logs, at)).to.equal(true);
        expect(matchesRow(parseSearchExpression('@level=war'), line, logs, at)).to.equal(false);
        expect(matchesRow(parseSearchExpression('@level=error|warn -sent'), line, logs, at)).to.equal(false);
        expect(matchesRow(parseSearchExpression('@level=error|warn token'), line, logs, at)).to.equal(true);
    });
});

describe('SearchMatcher: a column searched but not shown is told apart (James, 2026-11-21)', () => {
    const { describeSearch } = require('../../../webviews/shared/search-matcher.js');
    const headings = ['order_no', 'status', 'customer', 'body'];
    const hidden = ['customer', 'body'];

    it('in the box: col-hidden, apart from a shown column and from no column at all', () => {
        const kinds = (text: string) => tokenizeForDisplay(text, headings, hidden).map((s: { text: string; kind: string }) => `${s.text}:${s.kind}`);
        expect(kinds('@customer=Kettle')[0]).to.equal('@customer:col-hidden');
        expect(kinds('@status=open')[0]).to.equal('@status:col-name');
        expect(kinds('@nothere=1')[0]).to.equal('@nothere:col-unknown');
        expect(kinds('@body.sku~X')[0]).to.equal('@body.sku:col-hidden');
    });

    it('in the @ list: shown columns first, then those not shown, marked', () => {
        const list = columnSuggestions('@', headings, undefined, undefined, hidden);
        expect(list.map((s: { text: string }) => s.text)).to.deep.equal(['@@', '@order_no', '@status', '@body', '@customer']);
        expect(list.map((s: { label: string }) => s.label)).to.deep.equal(['a word in every column, shown or not', 'column', 'column', 'column · not shown', 'column · not shown']);
        expect(list.filter((s: { hidden?: boolean }) => s.hidden).length).to.equal(3);
        expect(columnSuggestions('@', headings).map((s: { text: string }) => s.text)).to.deep.equal(['@body', '@customer', '@order_no', '@status'], 'none given: as before');
    });

    it('on the line under the box: "(not shown)"', () => {
        expect(describeSearch('@customer=Kettle', headings, undefined, undefined, hidden)).to.contain('customer (not shown) is Kettle');
        expect(describeSearch('@status=open', headings, undefined, undefined, hidden)).to.contain('status is open');
    });
});

describe('SearchMatcher: a plain word looks in the columns shown; @@word in every column (James, 2026-11-21)', () => {
    const { describeSearch } = require('../../../webviews/shared/search-matcher.js');
    const columns = [{ id: 'method', name: 'method' }, { id: 'path', name: 'path' }, { id: 'body', name: 'body', hidden: true }];
    const row = { method: 'GET', path: '/inventory', body: '{"note":"very urgent"}' };
    const at = (r: Record<string, string>, id: string) => r[id];
    const finds = (text: string) => matchesRow(parseSearchExpression(text), row, columns, at);

    it('a plain word skips a column marked hidden; @@ reaches it; a shown column is found either way', () => {
        expect(finds('urgent')).to.equal(false);
        expect(finds('@@urgent')).to.equal(true);
        expect(finds('get @@urgent')).to.equal(true);
        expect(finds('@@get')).to.equal(true);
        expect(finds('get -@@urgent')).to.equal(false);
        expect(finds('get -urgent')).to.equal(true, 'not urgent in what is shown');
        expect(finds('@@"very urgent"')).to.equal(true, 'a phrase, everywhere');
        expect(finds('"very urgent"')).to.equal(false);
        expect(finds('@body~urgent')).to.equal(true, '@name reaches a hidden column');
        expect(finds('nothing, @@urgent')).to.equal(true, 'comma or');
    });

    it('@@ is not a column term, and alone it filters nothing', () => {
        expect(finds('@@')).to.equal(true);
        expect(finds('get @@')).to.equal(true);
        expect(finds('@@urgent @method=GET')).to.equal(true);
        expect(finds('@@urgent @method=POST')).to.equal(false);
    });

    it('coloured as one piece; said under the box; offered first after @ when a column is not shown', () => {
        const kinds = tokenizeForDisplay('get -@@urgent', ['method', 'path', 'body'], ['body']).map((s: { text: string; kind: string }) => `${s.text}:${s.kind}`);
        expect(kinds).to.include('@@urgent:deep');
        expect(describeSearch('@@urgent', ['method', 'body'], undefined, undefined, ['body'])).to.equal('Reading this as: the row holds urgent (in any column, shown or not)');
        expect(describeSearch('urgent', ['method', 'body'])).to.equal('');
        const list = columnSuggestions('@', ['method', 'body'], undefined, undefined, ['body']);
        expect(list[0].text).to.equal('@@');
        expect(columnSuggestions('@', ['method', 'body']).map((s: { text: string }) => s.text)).to.not.include('@@', 'nothing hidden: not offered');
        expect(columnSuggestions('@@', ['method', 'body'], undefined, undefined, ['body'])).to.deep.equal([]);
    });
});

// =============================================================
// planSearch: each term tested once per distinct value (Query's engine), the same answers as matchesRow
// =============================================================

describe('planSearch', () => {
    const { planSearch } = require('../../../webviews/shared/search-matcher.js');
    const cols = [{ id: 'm', name: 'method' }, { id: 'q', name: 'qty' }, { id: 'b', name: 'body', hidden: true }, { id: 'g', name: 'grp', type: 'group' }];
    const rows = [
        { m: 'GET', q: 5, b: 'urgent', g: 'x' }, { m: 'POST', q: 42, b: 'draft', g: 'x' }, { m: 'GET', q: null, b: '', g: 'x' },
        { m: 'get-all', q: '007', b: null, g: 'x' }, { m: '', q: 0, b: 'urgent draft', g: 'x' }
    ];
    const read = (row: Record<string, unknown>, id: string) => row[id];
    /** The engine's way: each term's test run once per distinct value, its answer kept. */
    const cached = (text: string) => {
        const plan = planSearch(parseSearchExpression(text), cols);
        const asked: string[][] = plan.terms.map(() => []);
        const kept = plan.terms.map(() => new Map<unknown, boolean>());
        const found = rows.map(row => plan.rowMatches((i: number) => plan.terms[i].columns.some((id: string) => {
            const v = (row as Record<string, unknown>)[id];
            if (!kept[i].has(v)) { kept[i].set(v, plan.terms[i].test(v)); asked[i].push(String(v)); }
            return kept[i].get(v);
        })));
        return { plan, found, asked };
    };

    it('gives matchesRow\'s answers, row by row, for words, -, @@, commas, @column and typed terms', () => {
        ['get', '-get', 'get -post', '@@urgent', '-@@draft', 'get, post', '@qty>4', '@qty>4 -@@draft', '@method=get|post @qty<10', '@nope=1', '@nope=1, get', '', 'urgent', '"get all"', 'g?t*', 'null', '@qty=""']
            .forEach(text => {
                const terms = parseSearchExpression(text);
                expect(cached(text).found, text).to.deep.equal(rows.map(row => matchesRow(terms, row, cols, read)));
            });
    });

    it('says which columns each term looks at: a word the shown ones, @@ every one, @column the ones it names (a group never)', () => {
        const { plan } = cached('get -@@urgent @qty>1 @nope=1');
        expect(plan.terms.map((t: { kind: string; columns: string[] }) => `${t.kind}:${t.columns.join('')}`)).to.deep.equal(['column:q', 'column:', 'word:mq', 'word:mqb']);
    });

    it('tests a value once per term, however many rows hold it', () => {
        const { asked } = cached('@method=get');
        expect(asked[0]).to.deep.equal(['GET', 'POST', 'get-all', '']);
    });

    it('asks only what the answer still needs', () => {
        const plan = planSearch(parseSearchExpression('get post, put'), cols);
        const asked: number[] = [];
        plan.rowMatches((i: number) => { asked.push(i); return false; });
        expect(asked).to.deep.equal([0, 2], 'get missed: post not asked; then put');
        expect(planSearch(parseSearchExpression(''), cols).rowMatches(() => false)).to.equal(true);
    });
});

describe('SearchMatcher: a column\'s values offered after @column= (the Hub\'s tags, Systems, environments)', () => {
    const headings = ['name', 'tag', 'system'];
    const values = (h: string) => (h === 'tag' ? [{ value: 'inventory', count: 12 }, { value: 'puppy school', count: 3 }, { value: 'items', count: 7 }] : []);
    const texts = (typed: string) => columnSuggestions(typed, headings, undefined, undefined, [], values).map((s: { text: string }) => s.text);

    it('after @tag=, every value, the most used first; typed, those holding it, starting ones first', () => {
        expect(texts('@tag=')).to.deep.equal(['inventory', 'items', '"puppy school"']);
        expect(texts('@tag=i')).to.deep.equal(['inventory', 'items']);
        expect(texts('@tag=sch')).to.deep.equal(['"puppy school"']);
        expect(texts('@tag=it')).to.deep.equal(['items']);
        expect(columnSuggestions('@tag=', headings, undefined, undefined, [], values)[0].label).to.equal('12');
    });

    it('after a |, the next value, not one already picked; a column with no values offers nothing', () => {
        expect(texts('@tag=inventory|')).to.deep.equal(['items', '"puppy school"']);
        expect(texts('@system=')).to.deep.equal([]);
    });
});

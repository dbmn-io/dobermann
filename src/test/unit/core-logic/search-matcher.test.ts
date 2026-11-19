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

    it('handles a lone dash as a plain term (not negation)', () => {
        const result = parseSearchExpression('-');
        expect(result).to.have.length(1);
        expect(result[0].pattern).to.equal('-');
        expect(result[0].negated).to.equal(false);
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

    it('treats trailing - with only whitespace after as literal', () => {
        const result = parseSearchExpression('foo - ');
        expect(result).to.have.length(2);
        expect(result[0].pattern).to.equal('foo');
        expect(result[1].pattern).to.equal('-');
        expect(result[1].negated).to.equal(false);
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

    it('exact match requires full cell value', () => {
        const term = parseSearchExpression('"New York"')[0];
        expect(matchesValue(term, 'New York')).to.equal(true);
        expect(matchesValue(term, 'new york')).to.equal(true);
        expect(matchesValue(term, 'New York City')).to.equal(false);
        expect(matchesValue(term, 'I love New York')).to.equal(false);
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

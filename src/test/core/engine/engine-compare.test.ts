// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The engine's compare step against the old Compare (compare-across.ts) on the same data: the same
 * rows in the same order, each row's records and kind. Then its own columns (relation, missing,
 * differs), notCompared, and the statistics on a case small enough to count by hand.
 *   npm run test:core
 */
import * as assert from 'assert';
import { compareAcross } from '../../../services/compare/compare-across';
import { QueryEngine } from '../../../services/engine/engine';
import type { CompareStats, Expr, Value } from '../../../services/engine/engine-types';

/** A small seeded random, so a failure can be run again. */
function random(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * An input of `n` rows: keys from a small range (so they repeat, and some are missing), values that
 * sometimes differ, a number now and then where text was. The Baseline's keys are each once and never
 * blank: there the old Compare's rule and James's agree (engine-compare.ts), so the old one is the reference.
 */
function input(seed: number, n: number, place: number): Value[][] {
    const r = random(seed);
    const rows: Value[][] = [];
    for (let i = 0; i < n; i++) {
        const key = place === 0 ? `K${i * 3}` : `K${Math.floor(r() * n * 2.2)}`;
        const part = r() < 0.5 ? 'A' : 'B';
        const qty = r() < 0.15 ? Math.floor(r() * 5) : 7;
        const status = r() < 0.05 ? 1 : r() < 0.1 ? 'HOLD' : 'OK';
        rows.push([key, part, qty, status, `p${place}r${i}`]);
    }
    return rows;
}

const COLUMNS = ['key', 'part', 'qty', 'status', 'id'];
const col = (name: string, of: string): Expr => ({ column: name, of });

describe('The engine, compare: James\'s rule for repeats and blanks, the old Compare\'s for the rest', () => {
    for (const [places, keyParts, seed] of [[2, 1, 1], [3, 1, 2], [4, 1, 3], [4, 2, 4], [3, 2, 5]] as const) {
        it(`${places} inputs, a key of ${keyParts}: the same rows, records and kinds as compare-across.ts`, async () => {
            const names = Array.from({ length: places }, (_, p) => `run${p}`);
            const data = names.map((_, p) => input(seed * 10 + p, 300, p));
            const keys = keyParts === 1 ? ['key'] : ['key', 'part'];
            const compared = ['qty', 'status', ...(keyParts === 1 ? ['part'] : [])];
            // The old Compare
            const sides = data.map(rows => rows.map(row => Object.fromEntries(COLUMNS.map((c, i) => [c, row[i]]))));
            const old = await compareAcross(sides, { keyColumns: keys, compareColumns: compared }, 0);
            // The engine
            const e = new QueryEngine();
            names.forEach((n, p) => e.load(n, { columns: COLUMNS, rows: data[p] }));
            const out = await e.run({ steps: [{
                compare: names,
                on: names.map(n => keys.map(k => col(k, n))),
                columns: compared.map(c => ({ name: c, values: names.map(n => col(c, n)) }))
            }] });
            assert.ok('result' in out, JSON.stringify(out));
            assert.strictEqual(out.total, old.length);
            const got = e.read(out.result, 0, out.total);
            const id = names.map(n => got.columns.indexOf(`${n}.id`));
            const status = got.columns.indexOf('status');
            const kind = { changed: 'diff', missing: 'missing', notInBaseline: 'notInBaseline', duplicate: 'duplicate', same: 'same' } as const;
            assert.strictEqual(old.counts.duplicate, 0);
            const wrong: string[] = [];
            for (let row = 0; row < old.length; row++) {
                const want = old.rowNumbers(row).map((list, p) => (list.length ? `p${p}r${list[0]}` : null));
                const has = id.map(i => got.rows[row][i]);
                if (JSON.stringify(want) !== JSON.stringify(has)) wrong.push(`row ${row}: records ${JSON.stringify(has)}, old ${JSON.stringify(want)}`);
                if (got.rows[row][status] !== kind[old.kindOf(row)]) wrong.push(`row ${row}: ${got.rows[row][status]}, old ${old.kindOf(row)}`);
                if (old.kindOf(row) === 'changed') {
                    const diffs = new Set(old.row(row).diffs.flat());
                    compared.forEach(c => {
                        const d = got.rows[row][got.columns.indexOf(`differs:${c}`)];
                        if (d !== (diffs.has(c) ? 1 : 0)) wrong.push(`row ${row}: differs:${c} ${d}`);
                    });
                }
            }
            assert.deepStrictEqual(wrong.slice(0, 5), [], `${wrong.length} rows differ from the old Compare`);
            const stats = e.stats(out.result, 'step 1') as CompareStats;
            assert.deepStrictEqual(stats.status, { same: old.counts.same, diff: old.counts.changed, missing: old.counts.missing, notInBaseline: old.counts.notInBaseline });
        });
    }

    it('its columns: relation, missing:<input>, differs:<column>; notCompared keeps the rows but leaves the input out', async () => {
        const e = new QueryEngine();
        e.load('BL', { columns: ['k', 'v'], rows: [['a', 1], ['b', 2], ['c', 3], ['d', 4]] });
        e.load('C1', { columns: ['k', 'v'], rows: [['a', 1], ['b', 9], ['b', 2], ['e', 5]] });
        e.load('C2', { columns: ['k', 'v'], rows: [['a', 1], ['b', 2], ['d', 8]] });
        const query = (notCompared?: string[]) => ({ steps: [{
            compare: ['BL', 'C1', 'C2'],
            on: [[col('k', 'BL')], [col('k', 'C1')], [col('k', 'C2')]],
            columns: [{ name: 'v', values: [col('v', 'BL'), col('v', 'C1'), col('v', 'C2')] }],
            ...(notCompared ? { notCompared } : {})
        }] });
        const out = await e.run(query());
        assert.ok('result' in out);
        const got = e.read(out.result, 0, 99);
        assert.deepStrictEqual(got.columns, ['BL.k', 'BL.v', 'C1.k', 'C1.v', 'C2.k', 'C2.v', 'status', 'relation', 'missing:BL', 'missing:C1', 'missing:C2', 'differs:v']);
        const tail = got.rows.map(r => r.slice(6));
        assert.deepStrictEqual(tail, [
            ['same', 'oneToOne', 0, 0, 0, 0],
            ['diff', 'oneToMany', 0, 0, 0, 1],     // b: C1 holds it twice, its first record differs
            ['same', 'oneToMany', 0, 0, 0, 0],     // b again: C1's second record, the same as BL's
            ['missing', 'onlyBase', 0, 1, 1, 0],
            ['diff', 'onlyBase', 0, 1, 0, 1],
            ['notInBaseline', 'onlyOther', 1, 0, 1, 0]
        ]);
        // C2 left out: d is no longer different, c and d not missing from it
        const hidden = await e.run(query(['C2']));
        assert.ok('result' in hidden);
        assert.deepStrictEqual(e.read(hidden.result, 0, 99).rows.map(r => [r[6], r[7]]), [
            ['same', 'oneToOne'], ['diff', 'oneToMany'], ['same', 'oneToMany'], ['missing', 'onlyBase'], ['missing', 'onlyBase'], ['notInBaseline', 'onlyOther']
        ]);
        assert.deepStrictEqual(e.check({ steps: [{ compare: ['BL', 'C1'], on: [[col('k', 'BL')], [col('k', 'C1')]], columns: [], notCompared: ['BL'] }] }).map(p => p.message), ['The Baseline is always compared.']);
    });

    it('its statistics, per input: against the Baseline and against the whole compare', async () => {
        const e = new QueryEngine();
        e.load('BL', { columns: ['k'], rows: [['a'], ['b'], ['c'], ['c']] });
        e.load('C1', { columns: ['k'], rows: [['a'], ['b'], ['b'], ['x']] });
        e.load('C2', { columns: ['k'], rows: [['a'], ['x'], ['y']] });
        const out = await e.run({ steps: [{ as: 'cmp', compare: ['BL', 'C1', 'C2'], on: [[col('k', 'BL')], [col('k', 'C1')], [col('k', 'C2')]], columns: [] }] });
        assert.ok('result' in out);
        const stats = e.stats(out.result, 'cmp') as CompareStats;
        assert.deepStrictEqual(stats.perInput, [
            { name: 'BL', rows: 4, againstBaseline: { matched: 4, oneToOne: 2, repeatedKeys: 1, repeatedRecords: 2, only: 0 }, againstAll: { matched: 2, repeatedKeys: 1, repeatedRecords: 2, onlyHere: 2 } },
            { name: 'C1', rows: 4, againstBaseline: { matched: 3, oneToOne: 1, repeatedKeys: 1, repeatedRecords: 2, only: 1 }, againstAll: { matched: 4, repeatedKeys: 1, repeatedRecords: 2, onlyHere: 0 } },
            { name: 'C2', rows: 3, againstBaseline: { matched: 1, oneToOne: 1, repeatedKeys: 0, repeatedRecords: 0, only: 2 }, againstAll: { matched: 2, repeatedKeys: 0, repeatedRecords: 0, onlyHere: 1 } }
        ]);
        // a, b, b, c, c (BL repeats it: a row each, compared), x, y
        assert.strictEqual(stats.rows, 7);
        assert.deepStrictEqual(stats.status, { same: 1, diff: 0, missing: 4, notInBaseline: 2 });
    });

    it('the Baseline\'s repeats are compared like any input\'s; a blank key is a row of its own', async () => {
        const e = new QueryEngine();
        e.load('BL', { columns: ['k', 'v'], rows: [['a', 1], ['a', 2], ['a', 3], [null, 9], ['b', 5]] });
        e.load('C1', { columns: ['k', 'v'], rows: [['a', 1], [null, 9], ['b', 5], ['b', 6]] });
        const out = await e.run({ steps: [{ compare: ['BL', 'C1'], on: [[col('k', 'BL')], [col('k', 'C1')]], columns: [{ name: 'v', values: [col('v', 'BL'), col('v', 'C1')] }] }] });
        assert.ok('result' in out);
        assert.deepStrictEqual(e.read(out.result, 0, 99).rows, [
            ['a', 1, 'a', 1, 'same', 'oneToMany', 0, 0, 0],
            ['a', 2, 'a', 1, 'diff', 'oneToMany', 0, 0, 1],
            ['a', 3, 'a', 1, 'diff', 'oneToMany', 0, 0, 1],
            [null, 9, null, null, 'missing', 'onlyBase', 0, 1, 0],
            ['b', 5, 'b', 5, 'same', 'oneToMany', 0, 0, 0],
            ['b', 5, 'b', 6, 'diff', 'oneToMany', 0, 0, 1],
            [null, null, null, 9, 'notInBaseline', 'onlyOther', 1, 0, 0]
        ]);
    });
});

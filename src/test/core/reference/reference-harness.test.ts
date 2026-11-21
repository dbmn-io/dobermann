// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The reference harness checks itself before it judges an engine: the generator gives the same
 * tables for a seed, its presets hold what they say, and SQLite's answers are what a join
 * means (counted by hand here on small tables). When the engine exists, its own test file runs
 * the same presets through it and compares with `expectedJoin` using `differences`.
 */
import * as assert from 'assert';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import { SQL_WASM_PATH } from '../fixtures/temp-storage';
import { makePair, PRESETS, type Table } from './generator';
import { canonical, differences, expectedJoin, type JoinKind } from './sqlite-reference';

describe('Query reference harness', () => {
    let SQL: SqlJsStatic;
    before(async () => { SQL = await initSqlJs({ locateFile: () => SQL_WASM_PATH }); });

    it('makes the same tables from the same seed, and other tables from another', () => {
        const a = makePair({ seed: 7, rows: 50, ...PRESETS.everything });
        const b = makePair({ seed: 7, rows: 50, ...PRESETS.everything });
        const c = makePair({ seed: 8, rows: 50, ...PRESETS.everything });
        assert.deepStrictEqual(a, b);
        assert.notDeepStrictEqual(a.left.rows, c.left.rows);
    });

    it('holds what each preset says: repeats, blanks, mixed types, a two-column key, noisy keys', () => {
        const keyOf = (t: Table, n: number) => t.rows.map(r => JSON.stringify(r.slice(0, n)));
        const repeated = makePair({ seed: 1, rows: 200, ...PRESETS.repeated });
        assert.ok(new Set(keyOf(repeated.left, 1)).size < repeated.left.rows.length, 'left keys repeat');
        const blanks = makePair({ seed: 1, rows: 200, ...PRESETS.blanks });
        const keys = blanks.left.rows.map(r => r[0]);
        assert.ok(keys.includes(null) && keys.includes(''), 'null and empty keys');
        const mixed = makePair({ seed: 1, rows: 200, ...PRESETS.mixed });
        const types = new Set<string>(mixed.left.rows.map(r => r[mixed.left.columns.indexOf('mixed')]).map(v => (typeof v === 'string' && /^\d+$/.test(v) ? 'numeric text' : typeof v)));
        for (const t of ['number', 'numeric text', 'boolean', 'string']) assert.ok(types.has(t), `mixed holds ${t}`);
        const two = makePair({ seed: 1, rows: 20, ...PRESETS.twoColumnKey });
        assert.deepStrictEqual(two.leftKey, ['code', 'site']);
        const noisy = makePair({ seed: 1, rows: 100, ...PRESETS.noisyKeys });
        assert.ok(noisy.right.rows.some(r => /^\s|\s$|^k|K00/.test(String(r[0]))), 'some right keys written differently');
    });

    it('SQLite joins small tables as a join means: inner, left, right and outer, with repeats', () => {
        const L: Table = { name: 'L', columns: ['code', 'v'], rows: [['A', 1], ['A', 2], ['B', 3], [null, 4]] };
        const R: Table = { name: 'R', columns: ['itemCode', 'w'], rows: [['A', 'x'], ['C', 'y'], [null, 'z']] };
        const on = [{ left: 'code', right: 'itemCode' }];
        const count = (kind: JoinKind) => expectedJoin(SQL, L, R, { kind, on }).length;
        // A matches twice (two L rows × one R row); NULL never matches NULL
        assert.strictEqual(count('inner'), 2);
        assert.strictEqual(count('left'), 2 + 2);          // + B, + NULL
        assert.strictEqual(count('right'), 2 + 2);         // + C, + NULL
        assert.strictEqual(count('outer'), 2 + 2 + 2);     // + B, NULL left; + C, NULL right
    });

    it('a key function makes noisy keys match, which they do not without it', () => {
        const pair = makePair({ seed: 3, rows: 100, ...PRESETS.noisyKeys });
        const plain = expectedJoin(SQL, pair.left, pair.right, { kind: 'inner', on: [{ left: 'code', right: 'itemCode' }] });
        const fixed = expectedJoin(SQL, pair.left, pair.right, { kind: 'inner', on: [{ left: 'code', right: 'itemCode', rightFns: ['trim', 'upper'] }] });
        assert.ok(fixed.length > plain.length, `TRIM + UPPER finds more (${fixed.length} vs ${plain.length})`);
    });

    it('reports where two answers differ, as rows missing and rows extra', () => {
        const expected = [['A', 1], ['A', 1], ['B', 2]];
        assert.deepStrictEqual(differences(expected, [['B', 2], ['A', 1], ['A', 1]]), { missing: [], extra: [] });
        const d = differences(expected, [['A', 1], ['B', '2']]);
        assert.strictEqual(d.missing.length, 2);   // one A row, and B as a number
        assert.strictEqual(d.extra.length, 1);     // B as text
        assert.notDeepStrictEqual(canonical([[7]]), canonical([['7']]));
    });

    it('runs every preset through every kind of join without error (the matrix an engine will face)', () => {
        for (const [name, preset] of Object.entries(PRESETS)) {
            const pair = makePair({ seed: 11, rows: 300, ...preset });
            const on = pair.leftKey.map((l, i) => ({ left: l, right: pair.rightKey[i] }));
            for (const kind of ['inner', 'left', 'right', 'outer'] as JoinKind[]) {
                const rows = expectedJoin(SQL, pair.left, pair.right, { kind, on });
                assert.ok(Array.isArray(rows), `${name} ${kind}`);
            }
        }
    });
});

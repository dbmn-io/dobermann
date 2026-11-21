// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The compare's rule for repeated keys and blank keys as James decided it (2026-11-21, relayed by
 * the manager: "If we have a one-to-many relationship, the one should be compared to the many each
 * time, even if the key repeats… it's going with three"). Counted by hand here, not taken from the
 * engine or the old Compare, which differ from it in exactly these two points.
 *
 * - A key's rows: the most rows any input has for it. An input with the key once shows that record
 *   on each row and is compared each time, the Baseline included. Inputs with several are paired in
 *   order of appearance; one with fewer than the most shows its last again. An input with none is
 *   missing. No "duplicate, not compared": every row is compared.
 * - A blank (null) key never matches: each blank-key record is a row of its own (James: "ok."), with
 *   the status No key, counted apart from the rest (James, 2026-11-21: "3. d. ok"). Empty text is a key.
 * Everything else is still the old Compare's rule (engine-vs-old-compare.test.ts).
 */
import * as assert from 'assert';
import { QueryEngine } from '../../../services/engine/engine';
import type { CompareStats, Expr, Value } from '../../../services/engine/engine-types';

const col = (name: string, of: string): Expr => ({ column: name, of });

/** Each input as [key, v, id] rows; the compare's rows as [each input's record id or null, status, differs:v]. */
async function compare(inputs: Record<string, [Value, Value, string][]>, counts?: (s: CompareStats['status']) => void): Promise<Value[][]> {
    const names = Object.keys(inputs);
    const e = new QueryEngine();
    for (const n of names) e.load(n, { columns: ['k', 'v', 'id'], rows: inputs[n] });
    const out = await e.run({ steps: [{
        compare: names,
        on: names.map(n => [col('k', n)]),
        columns: [{ name: 'v', values: names.map(n => col('v', n)) }],
    }] });
    assert.ok('result' in out, JSON.stringify(out));
    const got = e.read(out.result, 0, out.total);
    const at = [...names.map(n => got.columns.indexOf(`${n}.id`)), got.columns.indexOf('status'), got.columns.indexOf('differs:v')];
    counts?.((e.stats(out.result, 'step 1') as CompareStats).status);
    return got.rows.map(r => at.map(i => r[i]));
}

describe('Compare: repeated and blank keys, James\'s rule (reference, hand-counted)', () => {
    it('Baseline once, C1 three times: three rows, the Baseline compared with each', async () => {
        assert.deepStrictEqual(await compare({
            BL: [['a', 1, 'b0']],
            C1: [['a', 1, 'c0'], ['a', 2, 'c1'], ['a', 1, 'c2']],
        }), [
            ['b0', 'c0', 'same', 0],
            ['b0', 'c1', 'diff', 1],
            ['b0', 'c2', 'same', 0],
        ]);
    });

    it('Baseline three times, C1 once: three rows, C1 compared with each of the Baseline\'s', async () => {
        assert.deepStrictEqual(await compare({
            BL: [['a', 1, 'b0'], ['a', 2, 'b1'], ['a', 1, 'b2']],
            C1: [['a', 1, 'c0']],
        }), [
            ['b0', 'c0', 'same', 0],
            ['b1', 'c0', 'diff', 1],
            ['b2', 'c0', 'same', 0],
        ]);
    });

    it('BL 2, C1 2, C2 3, C3 none: three rows; the shorter ones show their last again; C3 missing', async () => {
        assert.deepStrictEqual(await compare({
            BL: [['z', 9, 'bz'], ['a', 1, 'b0'], ['a', 2, 'b1']],
            C1: [['z', 9, 'cz'], ['a', 1, 'c0'], ['a', 2, 'c1']],
            C2: [['z', 9, 'dz'], ['a', 1, 'd0'], ['a', 2, 'd1'], ['a', 3, 'd2']],
            C3: [['z', 9, 'ez']],
        }), [
            ['bz', 'cz', 'dz', 'ez', 'same', 0],
            ['b0', 'c0', 'd0', null, 'missing', 0],
            ['b1', 'c1', 'd1', null, 'missing', 0],
            ['b1', 'c1', 'd2', null, 'diff', 1],      // BL and C1 show their last again; C2's third differs from it
        ]);
    });

    it('repeats in a different order in each run: paired in order of appearance, so they differ', async () => {
        assert.deepStrictEqual(await compare({
            BL: [['a', 'x1', 'b0'], ['a', 'x2', 'b1']],
            C1: [['a', 'x2', 'c0'], ['a', 'x1', 'c1']],
        }), [
            ['b0', 'c0', 'diff', 1],
            ['b1', 'c1', 'diff', 1],
        ]);
    });

    it('blank keys (James, 2026-11-21: "ok.", then "3. d. ok"): never match; each blank-key record is a row of its own, No key', async () => {
        let status: CompareStats['status'] | undefined;
        assert.deepStrictEqual(await compare({
            BL: [[null, 1, 'bn'], ['a', 1, 'b0']],
            C1: [[null, 1, 'cn'], ['a', 1, 'c0']],
            C2: [['a', 1, 'd0'], [null, 1, 'dn']],
        }, s => { status = s; }), [
            ['bn', null, null, 'noKey', 0],            // the Baseline's blank: in its own order, nobody else's
            ['b0', 'c0', 'd0', 'same', 0],
            [null, 'cn', null, 'noKey', 0],            // then the keys the Baseline lacks, in input order
            [null, null, 'dn', 'noKey', 0],
        ]);
        assert.deepStrictEqual(status, { same: 1, diff: 0, missing: 0, notInBaseline: 0, noKey: 3 });
    });

    it('empty text is a key, not blank: it matches like any other', async () => {
        assert.deepStrictEqual(await compare({
            BL: [['', 1, 'be']],
            C1: [['', 2, 'ce']],
        }), [['be', 'ce', 'diff', 1]]);
    });

    it('James, 2026-11-21 ("loose is good. do it."): a number key and value equal the same characters as text', async () => {
        let status: CompareStats['status'] | undefined;
        assert.deepStrictEqual(await compare({
            BL: [[42, 5, 'b42'], [7, 12.5, 'b7'], [8, 3, 'b8']],
            C1: [['42', '5', 'c42'], ['007', 12.5, 'c007'], ['8', '3.0', 'c8']],
        }, s => { status = s; }), [
            ['b42', 'c42', 'same', 0],                 // 42 = "42", 5 = "5"
            ['b7', null, 'missing', 0],                // 7 is not "007"
            ['b8', 'c8', 'diff', 1],                   // 3 is not "3.0"
            [null, 'c007', 'notInBaseline', 0],
        ]);
        assert.deepStrictEqual(status, { same: 1, diff: 1, missing: 1, notInBaseline: 1, noKey: 0 });
    });
});

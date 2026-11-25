// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A calculated column as steps (James, 2026-11-25, "Steps only"), run by the engine: each step its function's engine
 * call on the value so far; a step may name another column; a function may repeat; Subtract from and Divide into put
 * the value second, so a − (b + c) and a ÷ (b + c) can be built; a calc may start from another, and a loop is refused.
 *   npm run test:core
 */
import * as assert from 'assert';
import { QueryEngine } from '../../../services/engine/engine';
import { localEngineHost } from '../../../services/engine/engine-host';
import type { Expr } from '../../../services/engine/engine-types';
import { loadViewInto, refExpr } from '../../../services/query/query-new-engine';
import { CALC_ID, calcExprs, type StepsCalc } from '../../../services/query/calc-steps';

const ROWS = [
    { a: 20, b: 3, c: 2, s: ' ab-1 ', t: 'x', d: 'line one\r\nline two\nthree' },
    { a: 7, b: null, c: 1, s: '', t: 'HOLD', d: 'plain' }
];

async function run(calcs: StepsCalc[]): Promise<unknown[][]> {
    const engine = new QueryEngine();
    await loadViewInto(localEngineHost(engine), 'vA', Object.keys(ROWS[0]), ROWS);
    const exprs = calcExprs(calcs, (id): Expr => ({ column: id, of: 'vA' }));
    const out = await engine.run({ steps: [{ as: 'rows', select: 'vA', columns: calcs.map(c => ({ name: c.name, value: exprs.get(c.name)! })) }], result: 'rows' });
    assert.ok('result' in out, JSON.stringify(out));
    return engine.read(out.result, 0, 10).rows;
}
const one = async (start: StepsCalc['start'], steps: StepsCalc['steps']) => (await run([{ name: 'r', start, steps }])).map(r => r[0]);

describe('Query: a calculated column as steps, on the engine', () => {
    it('the text steps: Trim, Upper, Replace, First and Last characters, Drop leading zeros, Remove line breaks', async () => {
        assert.deepStrictEqual(await one({ col: 's' }, [{ fn: 'trim' }, { fn: 'upper' }, { fn: 'replace', from: '-', to: '' }]), ['AB1', '']);
        assert.deepStrictEqual(await one({ col: 's' }, [{ fn: 'trim' }, { fn: 'first', n: 2 }]), ['ab', '']);
        assert.deepStrictEqual(await one({ col: 's' }, [{ fn: 'trim' }, { fn: 'last', n: 1 }]), ['1', '']);
        assert.deepStrictEqual(await one({ value: '0042' }, [{ fn: 'ltrimZeros' }]), ['42', '42']);
        assert.deepStrictEqual(await one({ col: 'd' }, [{ fn: 'breaks' }]), ['line one line two three', 'plain']);
    });

    it('a function more than once: Replace twice, Trim → Upper → Trim', async () => {
        assert.deepStrictEqual(await one({ col: 's' }, [{ fn: 'replace', from: 'a', to: 'z' }, { fn: 'replace', from: '-', to: '_' }]), [' zb_1 ', '']);
        assert.deepStrictEqual(await one({ col: 's' }, [{ fn: 'trim' }, { fn: 'upper' }, { fn: 'trim' }]), ['AB-1', '']);
    });

    it('arithmetic with another column or a value: Plus, Minus, Times, Divide, Round, Percent change', async () => {
        assert.deepStrictEqual(await one({ col: 'a' }, [{ fn: 'minus', col: 'b' }]), [17, null]);
        assert.deepStrictEqual(await one({ col: 'a' }, [{ fn: 'times', value: 1.1 }, { fn: 'round', places: 1 }]), [22, 7.7]);
        assert.deepStrictEqual(await one({ col: 'a' }, [{ fn: 'divide', col: 'c' }]), [10, 7]);
        assert.deepStrictEqual(await one({ col: 'a' }, [{ fn: 'pct', col: 'c' }]), [900, 600]);
        assert.deepStrictEqual(await one({ col: 'a' }, [{ fn: 'plus', value: 5 }]), [25, 12]);
    });

    it('Subtract from and Divide into: a − (b + c) and a ÷ (b + c), as steps', async () => {
        // b, plus c, subtracted from a: 20 − (3 + 2) = 15; a blank b leaves it blank, as a sum with a blank is
        assert.deepStrictEqual(await one({ col: 'b' }, [{ fn: 'plus', col: 'c' }, { fn: 'subfrom', col: 'a' }]), [15, null]);
        assert.deepStrictEqual(await one({ col: 'b' }, [{ fn: 'plus', col: 'c' }, { fn: 'divinto', col: 'a' }]), [4, null]);
    });

    it('If blank, If it is, Join text with another column', async () => {
        assert.deepStrictEqual(await one({ col: 'b' }, [{ fn: 'ifblank', use: '0' }]), [3, '0']);
        assert.deepStrictEqual(await one({ col: 't' }, [{ fn: 'ifis', is: 'HOLD', then: 'On hold', else: '' }]), ['x', 'On hold']);
        assert.deepStrictEqual(await one({ col: 't' }, [{ fn: 'ifis', is: 'HOLD', then: 'On hold', else: 'Free' }]), ['Free', 'On hold']);
        assert.deepStrictEqual(await one({ col: 't' }, [{ fn: 'jointext', between: ' · ', col: 'a' }]), ['x · 20', 'HOLD · 7']);
    });

    it('a calc that starts from another, and one that uses another in a step', async () => {
        const rows = await run([
            { name: 'total', start: { col: 'b' }, steps: [{ fn: 'plus', col: 'c' }] },
            { name: 'left', start: { col: CALC_ID('total') }, steps: [{ fn: 'subfrom', col: 'a' }] },
            { name: 'share', start: { col: 'a' }, steps: [{ fn: 'divide', col: CALC_ID('total') }] }
        ]);
        assert.deepStrictEqual(rows, [[5, 15, 4], [null, null, null]]);
    });

    it('a key or a cell whose step names another column: that column of the same view', async () => {
        const engine = new QueryEngine();
        await loadViewInto(localEngineHost(engine), 'vA', Object.keys(ROWS[0]), ROWS);
        const value = refExpr({ view: 'vA', column: 't', fns: [{ fn: 'jointext', between: '-', col: 'a' }, { fn: 'upper' }] });
        const out = await engine.run({ steps: [{ as: 'rows', select: 'vA', columns: [{ name: 'k', value }] }], result: 'rows' });
        assert.ok('result' in out);
        assert.deepStrictEqual(engine.read(out.result, 0, 10).rows.map(r => r[0]), ['X-20', 'HOLD-7']);
    });

    it('a loop is refused, naming it', () => {
        assert.throws(() => calcExprs([
            { name: 'one', start: { col: CALC_ID('two') }, steps: [] },
            { name: 'two', start: { col: 'a' }, steps: [{ fn: 'plus', col: CALC_ID('one') }] }
        ], id => ({ column: id, of: 'vA' })), /can't use itself: one → two → one/);
    });
});

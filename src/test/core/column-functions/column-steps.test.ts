// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The steps Map and calculated columns add (James, 2026-11-25: one list of functions, steps in
 * sequence): each worked out in memory by the engine's own functions (applyColumnFns), and built for
 * Query's engine from the same call (columnFnCall, fnExpr), so a step gives the same value in Map and
 * in Query.
 *   npm run test:core
 */
import * as assert from 'assert';
import { applyColumnFns, callExpr, columnFnCall, columnsIn, COLUMN_FUNCTIONS, type ColumnFn } from '../../../services/column-functions/column-functions';
import { fnExpr } from '../../../services/query/query-new-engine';

/** The other columns of the row, by id. */
const ROW: Record<string, unknown> = { qty: '52', reserved: 120, damaged: '8', onHand: 1428, base: 100, name: 'Acme', blank: null };
const col = (id: string): unknown => ROW[id];
const run = (value: unknown, fns: ColumnFn[]): unknown => applyColumnFns(value, fns, col);

describe('Column steps (Map and calculated columns)', () => {
    it('Remove line breaks: each \\r\\n, \\n or \\r is a space; a blank stays blank', () => {
        assert.strictEqual(run('a\r\nb\nc\rd', [{ fn: 'breaks' }]), 'a b c d');
        assert.strictEqual(run(null, [{ fn: 'breaks' }]), null);
    });

    it('If blank: a blank or empty value takes the value given; anything else stays', () => {
        const f: ColumnFn[] = [{ fn: 'ifblank', use: 'N/A' }];
        assert.strictEqual(run('', f), 'N/A');
        assert.strictEqual(run(null, f), 'N/A');
        assert.strictEqual(run('EA', f), 'EA');
    });

    it('If it is: the value asked about becomes Then; another becomes Otherwise, or stays when Otherwise is empty', () => {
        assert.strictEqual(run('HOLD', [{ fn: 'ifis', is: 'HOLD', then: 'ON HOLD', else: '' }]), 'ON HOLD');
        assert.strictEqual(run('OPEN', [{ fn: 'ifis', is: 'HOLD', then: 'ON HOLD', else: '' }]), 'OPEN');
        assert.strictEqual(run('OPEN', [{ fn: 'ifis', is: 'HOLD', then: 'ON HOLD', else: 'OTHER' }]), 'OTHER');
    });

    it('arithmetic with a value or another column of the row', () => {
        assert.strictEqual(run('10', [{ fn: 'plus', value: 5 }]), 15);
        assert.strictEqual(run('54', [{ fn: 'minus', col: 'qty' }]), 2);
        assert.strictEqual(run('10', [{ fn: 'times', value: 2 }]), 20);
        assert.strictEqual(run('10', [{ fn: 'divide', value: 4 }]), 2.5);
        assert.strictEqual(run('30', [{ fn: 'subfrom', value: 100 }]), 70);
        assert.strictEqual(run('4', [{ fn: 'divinto', value: 100 }]), 25);
        assert.strictEqual(run(110, [{ fn: 'pct', col: 'base' }]), 10);
    });

    it('arithmetic on what is not a number, a blank, or by 0 gives a blank', () => {
        assert.strictEqual(run('abc', [{ fn: 'plus', value: 5 }]), null);
        assert.strictEqual(run('10', [{ fn: 'minus', col: 'blank' }]), null);
        assert.strictEqual(run('10', [{ fn: 'divide', value: 0 }]), null);
    });

    it('Round to so many places', () => {
        assert.strictEqual(run('11.15625', [{ fn: 'round', places: 1 }]), 11.2);
        assert.strictEqual(run('11.5', [{ fn: 'round', places: 0 }]), 12);
    });

    it('Join text: the value, the text between, then the other column (a blank adds nothing)', () => {
        assert.strictEqual(run('Kibble', [{ fn: 'jointext', between: ' · ', col: 'name' }]), 'Kibble · Acme');
        assert.strictEqual(run('Kibble', [{ fn: 'jointext', between: ' · ', col: 'blank' }]), 'Kibble · ');
    });

    it('steps in sequence, a function twice, and the mock\'s divide by a total (Reserved + Damaged, Divide into quantityOnHand)', () => {
        assert.strictEqual(run('SKU-WOOF-001', [{ fn: 'replace', from: 'WOOF', to: 'DOG' }, { fn: 'replace', from: '-', to: '' }]), 'SKUDOG001');
        assert.strictEqual(run(120, [{ fn: 'plus', col: 'damaged' }, { fn: 'divinto', col: 'onHand' }, { fn: 'round', places: 1 }]), 11.2);
        assert.strictEqual(run('  ea ', [{ fn: 'trim' }, { fn: 'upper' }, { fn: 'ifis', is: 'EA', then: 'EACH', else: '' }]), 'EACH');
    });

    it('a step that names a column, with no columns given, reads it as blank in memory', () => {
        assert.strictEqual(applyColumnFns('54', [{ fn: 'minus', col: 'qty' }]), null);
    });

    it('Query\'s engine: the same call, the old functions exactly as before, another column through the resolver', () => {
        const x = { column: 'sku', of: 'v1' };
        assert.deepStrictEqual(fnExpr(x, { fn: 'trim' }), { fn: 'TRIM', args: [x] });
        assert.deepStrictEqual(fnExpr(x, { fn: 'first', n: 3 }), { fn: 'SUBSTR', args: [x, { value: 1 }, { value: 3 }] });
        assert.deepStrictEqual(fnExpr(x, { fn: 'translate', table: 't1', from: 'code', to: 'name' }),
            { fn: 'TRANSLATE', args: [x, { value: '__lookup_t1' }, { value: 'code' }, { value: 'name' }] });
        assert.deepStrictEqual(fnExpr(x, { fn: 'minus', col: 'qty' }, id => ({ column: id, of: 'v1' })), { fn: '-', args: [x, { column: 'qty', of: 'v1' }] });
        assert.throws(() => fnExpr(x, { fn: 'minus', col: 'qty' }), /names another column/);
        assert.deepStrictEqual(callExpr(columnFnCall({ fn: 'plus', value: 5 }), x, () => ({ value: null }), () => ({ value: null })), { fn: '+', args: [x, { value: 5 }] });
    });

    it('the list the window shows has every step, and the columns the steps read are listed', () => {
        const ids = COLUMN_FUNCTIONS.map(f => f.id);
        for (const id of ['lower', 'breaks', 'ifblank', 'ifis', 'plus', 'minus', 'times', 'divide', 'subfrom', 'divinto', 'pct', 'round', 'jointext']) assert.ok(ids.includes(id as never), id);
        assert.deepStrictEqual(columnsIn([{ fn: 'trim' }, { fn: 'minus', col: 'qty' }, { fn: 'plus', value: 1 }, { fn: 'jointext', between: '', col: 'name' }]), ['qty', 'name']);
    });
});

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
import { applyColumnStep, type ReadDateAs, type ReadNumberAs } from '../../../services/column-functions/column-functions';
import { convertValueBySourceFormat } from '../../../utils/source-format-converter';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DateRead = require('../../../webviews/shared/date-read.js') as { readDate(text: unknown, format: string): string | null };

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

    /* ---------- Read number and Read date: today's Transform options as steps (Run Batch's Map) ---------- */

    it('Read number sends what the Transform option sent, for each option (the same converter)', () => {
        const values: Record<ReadNumberAs, string[]> = {
            standard: ['1,428', '42', '-7.5', '0.10'],
            cobol: ['+000000099.9900', '-000000001.0000', '+000000000.0000'],
            currency: ['$1,234.56', '(12.50)', '€99'],
            scientific: ['1.5E3', '2e-2', '-4.2E1']
        };
        (Object.keys(values) as ReadNumberAs[]).forEach(as => values[as].forEach(v => {
            const before = convertValueBySourceFormat(v, as, 'number');
            const now = applyColumnFns(v, [{ fn: 'readnum', as }]);
            assert.strictEqual(String(now), before, `${as} ${v}`);
        }));
    });

    it('Read date sends what the Transform option sent, for each order (the same reader), as YYYY-MM-DD', () => {
        const values: Record<ReadDateAs, string[]> = {
            'dd-mm-yyyy': ['05/01/2026', '28/02/2026', '1.3.2026'],
            'mm-dd-yyyy': ['01/05/2026', '02/28/2026'],
            'yyyy-mm-dd': ['2026/01/05', '2026.2.28'],
            iso_8601: ['2026-01-05', '2026-01-05T08:00:00Z'],
            unix_timestamp: ['1767571200', '1767571200000'],
            excel_serial: ['45663', '46027']
        };
        (Object.keys(values) as ReadDateAs[]).forEach(as => values[as].forEach(v => {
            const before = DateRead.readDate(v, as);
            assert.ok(before, `${as} ${v} reads`);
            assert.strictEqual(applyColumnFns(v, [{ fn: 'readdate', as }]), before, `${as} ${v}`);
        }));
        // a day already YYYY-MM-DD is that day in every order (reading twice changes nothing)
        assert.strictEqual(applyColumnFns('2026-01-05', [{ fn: 'readdate', as: 'mm-dd-yyyy' }]), '2026-01-05');
    });

    it('a value a Read step can\'t read stops the chain and says why; a blank stays blank', () => {
        assert.deepStrictEqual(applyColumnStep('31/02/2026', { fn: 'readdate', as: 'dd-mm-yyyy' }), { failed: '31/02/2026 is not a date written DD/MM/YYYY' });
        assert.deepStrictEqual(applyColumnStep('abc', { fn: 'readnum', as: 'cobol' }), { failed: 'abc is not COBOL' });
        assert.strictEqual(applyColumnFns('31/02/2026', [{ fn: 'readdate', as: 'dd-mm-yyyy' }, { fn: 'upper' }]), null);
        assert.deepStrictEqual(applyColumnStep(null, { fn: 'readdate', as: 'dd-mm-yyyy' }), { value: null });
        assert.deepStrictEqual(applyColumnStep('', { fn: 'readnum', as: 'standard' }), { value: '' });
    });

    it('Read number and Read date are Map\'s only: Query\'s engine refuses them, plainly', () => {
        assert.throws(() => fnExpr({ column: 'x' }, { fn: 'readdate', as: 'dd-mm-yyyy' }), /Map only/);
    });
});

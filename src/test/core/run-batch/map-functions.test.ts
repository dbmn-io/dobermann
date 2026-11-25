// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch's Map: a column's steps on its first rows (map-functions.ts), as the Functions window and the Sample's
 * In and Out show them: worked out on the host with the one definition of each step.
 *   npm run test:core
 */
import * as assert from 'assert';
import { knownSteps, mapSample, mapTranslate } from '../../../screens/run-batch/map-functions';

const HEADERS = ['sku', 'uom', 'qty', 'reserved', 'delivery'];
const ROWS = [
    ['SKU-WOOF-001', ' ea ', '1,428', '120', '05/01/2026'],
    ['SKU-WOOF-002', 'CS', '40', '8', '31/02/2026'],
    ['SKU-WOOF-003', 'pk', '', '0', '2026-03-01']
];

describe('Map: a column\'s steps on its first rows', () => {
    it('each row: its value as it came, after each step, and what is sent', () => {
        const rows = mapSample([{ fn: 'trim' }, { fn: 'upper' }, { fn: 'ifis', is: 'EA', then: 'EACH', else: '' }], 'uom', HEADERS, ROWS);
        assert.deepStrictEqual(rows[0], { before: ' ea ', steps: ['ea', 'EA', 'EACH'], after: 'EACH' });
        assert.deepStrictEqual(rows[1], { before: 'CS', steps: ['CS', 'CS', 'CS'], after: 'CS' });
    });

    it('a step that names another column reads that column of the same row', () => {
        const rows = mapSample([{ fn: 'readnum', as: 'standard' }, { fn: 'minus', col: 'reserved' }], 'qty', HEADERS, ROWS);
        // (an empty quantity minus a number: blank, as the engine gives it everywhere)
        assert.deepStrictEqual(rows.map(r => r.after), [1308, 32, null]);
    });

    it('a value a Read step can\'t read: where and why, and no value sent', () => {
        const rows = mapSample([{ fn: 'readdate', as: 'dd-mm-yyyy' }], 'delivery', HEADERS, ROWS);
        assert.deepStrictEqual(rows[0], { before: '05/01/2026', steps: ['2026-01-05'], after: '2026-01-05' });
        assert.deepStrictEqual(rows[1], { before: '31/02/2026', steps: [], failedAt: 0, failed: '31/02/2026 is not a date written DD/MM/YYYY' });
        assert.strictEqual(rows[2].after, '2026-03-01');
    });

    it('no steps: the value as it came; a column the file hasn\'t: blank', () => {
        assert.deepStrictEqual(mapSample([], 'sku', HEADERS, ROWS)[0], { before: 'SKU-WOOF-001', steps: [], after: 'SKU-WOOF-001' });
        assert.strictEqual(mapSample([], 'gone', HEADERS, ROWS)[0].before, null);
    });

    it('only steps Map offers are taken from the page', () => {
        assert.deepStrictEqual(knownSteps([{ fn: 'trim' }, { fn: 'nope' }, null, 'x', { fn: 'readdate', as: 'dd-mm-yyyy' }]), [{ fn: 'trim' }, { fn: 'readdate', as: 'dd-mm-yyyy' }]);
        assert.deepStrictEqual(knownSteps('trim'), []);
    });

    it('Next to Validate: every row of each column with steps through its steps, once (the translated input)', () => {
        const out = mapTranslate({
            variables: [
                { variable: 'uom', column: 'uom', fns: [{ fn: 'trim' }, { fn: 'upper' }] },
                { variable: 'onHand', column: 'qty', fns: [{ fn: 'readnum', as: 'standard' }, { fn: 'minus', col: 'reserved' }] },
                { variable: 'delivery', column: 'delivery', fns: [{ fn: 'readdate', as: 'dd-mm-yyyy' }] }
            ],
            columns: { uom: [' ea ', 'CS', 'pk'], qty: ['1,428', '40', ''], reserved: ['120', '8', '0'], delivery: ['05/01/2026', '31/02/2026', ''] }
        });
        assert.deepStrictEqual(out.values.uom, ['EA', 'CS', 'PK']);
        assert.deepStrictEqual(out.values.onHand, [1308, 32, null]);
        // (a value a step can't read is kept as it came, for Validate to stop; counted)
        assert.deepStrictEqual(out.values.delivery, ['2026-01-05', '31/02/2026', '']);
        assert.deepStrictEqual(out.unread, { uom: 0, onHand: 0, delivery: 1 });
    });

    it('a step this build doesn\'t offer is never run, and a missing column gives nothing to translate', () => {
        const out = mapTranslate({ variables: [{ variable: 'a', column: 'a', fns: [{ fn: 'nope' }, { fn: 'upper' }] }, { variable: 'b', column: 'gone', fns: [{ fn: 'upper' }] }], columns: { a: ['x'] } });
        assert.deepStrictEqual(out.values, { a: ['X'], b: [] });
    });
});

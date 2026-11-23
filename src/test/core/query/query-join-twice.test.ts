// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A join key translated with a lookup table that holds the value twice (James, 2026-11-23, the mock's step 6: "yes ok"):
 * the key is left as it was, so the row may not match; how many rows is counted for the line above Results, "In the
 * lookup table twice, so left as they were: N rows in <column>", as Results' own columns are.
 *   npm run test:core
 */
import * as assert from 'assert';
import { QueryEngine } from '../../../services/engine/engine';
import { localEngineHost } from '../../../services/engine/engine-host';
import { joinKeysTwice, loadLookupInto, loadViewInto } from '../../../services/query/query-new-engine';
import type { QuerySpec } from '../../../services/query/query-types';

describe('Query: a join key\'s Translate meeting a value its lookup table holds twice', () => {
    async function setUp() {
        const engine = new QueryEngine();
        const host = localEngineHost(engine);
        // Old codes to new: A1 is in the table twice, B2 once, C3 not at all
        await loadLookupInto(host, { id: 'lkp-map', columns: [{ id: 'c1' }, { id: 'c2' }], rows: [{ c1: 'A1', c2: 'P1' }, { c1: 'A1', c2: 'P9' }, { c1: 'B2', c2: 'P2' }] });
        await loadViewInto(host, 'vS', ['sku', 'qty'], [{ sku: 'A1', qty: 1 }, { sku: 'B2', qty: 2 }, { sku: 'A1', qty: 3 }, { sku: 'C3', qty: 4 }]);
        await loadViewInto(host, 'vP', ['sku', 'name'], [{ sku: 'P1', name: 'one' }, { sku: 'P2', name: 'two' }]);
        return host;
    }
    const spec = (translated: boolean): QuerySpec => ({
        views: [{ id: 'vS', name: 'Stock', columns: ['sku', 'qty'] }, { id: 'vP', name: 'Products', columns: ['sku', 'name'] }],
        joins: [{ view: 'vP', kind: 'left', on: [{
            left: { parts: [{ view: 'vS', column: 'sku', ...(translated ? { fns: [{ fn: 'translate' as const, table: 'lkp-map', from: 'c1', to: 'c2' }] } : {}) }] },
            right: { parts: [{ view: 'vP', column: 'sku' }] }
        }] }],
        select: []
    });

    it('counted by the key\'s column: the two Stock rows whose A1 is in the table twice', async () => {
        assert.deepStrictEqual(await joinKeysTwice(await setUp(), spec(true)), [{ view: 'vS', name: 'sku', rows: 2 }]);
    });

    it('nothing when the key isn\'t translated', async () => {
        assert.deepStrictEqual(await joinKeysTwice(await setUp(), spec(false)), []);
    });
});

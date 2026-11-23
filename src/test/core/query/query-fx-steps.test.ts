// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Functions dialog as a chain of steps (James, 2026-11-23, mock v6): its sample gives each value before, after each
 * step in turn, and after the last, so the dialog can show the values flowing through the chain.
 *   npm run test:core
 */
import * as assert from 'assert';
import { QueryEngine } from '../../../services/engine/engine';
import { localEngineHost } from '../../../services/engine/engine-host';
import { fnSampleQueries, loadViewInto } from '../../../services/query/query-new-engine';
import type { ColumnFn } from '../../../services/column-functions/column-functions';

describe('Query: the Functions dialog\'s sample, step by step', () => {
    async function sample(fns: ColumnFn[], steps: boolean) {
        const engine = new QueryEngine();
        await loadViewInto(localEngineHost(engine), 'vA', ['code'], [{ code: ' ab-1 ' }, { code: 'cd-2' }]);
        const out = await engine.run(fnSampleQueries('vA', 'code', fns, '', steps).few);
        assert.ok('result' in out);
        return engine.read(out.result, 0, 10).rows;
    }
    const chain: ColumnFn[] = [{ fn: 'trim' }, { fn: 'upper' }, { fn: 'replace', from: '-', to: '' }];

    it('with steps: the value, then after each step; the last is after them all', async () => {
        assert.deepStrictEqual(await sample(chain, true), [[' ab-1 ', 'ab-1', 'AB-1', 'AB1'], ['cd-2', 'cd-2', 'CD-2', 'CD2']]);
    });

    it('without steps: the value and after them all, as before', async () => {
        assert.deepStrictEqual(await sample(chain, false), [[' ab-1 ', 'AB1'], ['cd-2', 'CD2']]);
    });
});

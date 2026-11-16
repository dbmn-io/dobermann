// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { buildChainOptions } from '../../../../screens/console/console-chain-handler';
import { MAX_SUGGESTIONS } from '../../../../services/chain/chain-target-ranker';

// GitHub Issue #247: what the Console's Chain dialog gets — every endpoint mapped, suggestions
// only where every required variable has a column, the first row for the preview.
const ep = (id: string, body: object, extra: Record<string, unknown> = {}) =>
    ({ id, name: id, method: 'POST', path: '/' + id, body: JSON.stringify(body), ...extra }) as any;
const rows = (names: string[], first: Record<string, unknown>) => ({
    columns: names.map(n => ({ id: 'col_' + n, name: n })) as any,
    data: [Object.fromEntries(Object.entries(first).map(([k, v]) => ['col_' + k, v])), {}]
});

describe('Chain dialog options (#247)', () => {
    it('suggests fully covered endpoints; maps every variable the way Run Batch would; A8/ENV left out', () => {
        const options = buildChainOptions({
            token: 't1',
            rows: rows(['location.gln', 'gtin', 'Qty'], { 'location.gln': '0614', gtin: ['1', '2'], Qty: 12 }),
            endpoints: [
                ep('replenish', { b: '{{location_gln}}', g: '{{gtin}}', s: '{{sku:string|opt}}', n: '{{A8:sequence}}', e: '{{ENV:tenant}}' }),
                ep('lines', { g: '{{gtin}}', q: '{{orderedQty}}', r: '{{reason}}' }),
                ep('src', { x: '{{gtin}}' })
            ],
            source: { id: 'src', path: '/inventory' },
            viewName: 'Open lines',
            searchTerm: 'status:OPEN'
        });
        expect(options.rowCount).to.equal(2);
        expect(options.columns).to.deep.equal(['location.gln', 'gtin', 'Qty']);
        expect(options.firstRow).to.deep.equal({ 'location.gln': '0614', gtin: '1, 2', Qty: '12' });
        expect(options.suggestedIds).to.deep.equal(['replenish']);
        expect(options.candidates.map(c => c.endpointId)).to.deep.equal(['replenish', 'lines']);

        const replenish = options.candidates[0];
        expect(replenish.variables).to.deep.equal([
            { name: 'location_gln', optional: false, column: 'location.gln', how: 'loose' },
            { name: 'gtin', optional: false, column: 'gtin', how: 'exact' },
            { name: 'sku', optional: true, column: null, how: null }
        ]);

        // A partial guess (orderedQty ← Qty) is shown, but is not confident: still missing.
        const lines = options.candidates[1];
        expect(lines.variables.find(v => v.name === 'orderedQty')).to.include({ column: 'Qty', how: 'partial' });
        expect(lines.missingRequired).to.deep.equal(['orderedQty', 'reason']);
        expect(lines.fullyCovered).to.equal(false);
    });

    it('a mapping the endpoint remembered (#307) comes first and counts as confident', () => {
        const options = buildChainOptions({
            token: 't', rows: rows(['Buyer GLN'], { 'Buyer GLN': 'x' }),
            endpoints: [ep('po', { b: '{{buyer}}' }, { dataLoadingConfig: { columnMappings: { buyer: 'Buyer GLN' } } })],
            source: {}
        });
        expect(options.candidates[0].variables[0]).to.include({ column: 'Buyer GLN', how: 'remembered' });
        expect(options.suggestedIds).to.deep.equal(['po']);
    });

    it(`at most ${MAX_SUGGESTIONS} suggestions; every endpoint is still searchable`, () => {
        const many = Array.from({ length: 12 }, (_, i) => ep('e' + String(i).padStart(2, '0'), { g: '{{gtin}}' }));
        const options = buildChainOptions({ token: 't', rows: rows(['gtin'], { gtin: '1' }), endpoints: many, source: {} });
        expect(options.suggestedIds).to.have.length(MAX_SUGGESTIONS);
        expect(options.candidates).to.have.length(12);
    });
});

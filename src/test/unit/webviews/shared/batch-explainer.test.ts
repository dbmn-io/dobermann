// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { planBatch } from '../../../../data-loading/batch-plan';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const BX = require('../../../../webviews/shared/batch-explainer');

// Run Batch Step 4 ⓘ (#308): every shape explains itself; nothing from the template is trusted.
const map = (h: string[]) => h.map(x => ({ variable: x, column: x, dataType: 'string' }));

describe('BatchExplainer', () => {
    it('grouped (Lesson 5): rows → requests, the header variables marked, a table of groups', async () => {
        const plan = await planBatch({
            endpoint: { method: 'POST', path: '/purchase-orders', body: JSON.stringify({ buyerGln: '{{location.gln:string}}', supplierGln: '{{supplier:string}}', lines: [{ gtin: '{{gtin}}' }] }) },
            headers: ['location.gln', 'supplier', 'gtin'], rows: [['0614', 'A', '1'], ['0614', 'B', '2'], ['0614', 'A', '3']], mappings: map(['location.gln', 'supplier', 'gtin']), reps: 1000
        });
        const html = BX.render(plan);
        expect(html).to.include('Grouped by the header');
        // The same stat cards as the Console's Settings tab (tables.css .table-stats / .stat-item).
        expect(html).to.include('<span class="stat-label">Rows</span><span>3</span>');
        expect(html).to.include('<span class="stat-label">API requests</span><span>2</span>');
        expect(html).to.include('<mark class="bx-var role-request" title="Starts a new request">{{location.gln:string}}</mark>');
        expect(html).to.include('<mark class="bx-var role-item" title="Once per row">{{gtin}}</mark>');
        expect(html).to.include('<th>location.gln</th><th>supplier</th>');
    });

    it('a sort Run Batch had to do is explained beside the grouping, not in a toast', async () => {
        const plan = await planBatch({
            endpoint: { method: 'POST', path: '/po', body: JSON.stringify({ s: '{{supplier}}', lines: [{ g: '{{gtin}}' }] }) },
            headers: ['supplier', 'gtin'], rows: [['B', '1'], ['A', '2']], mappings: map(['supplier', 'gtin']), reps: 1000
        });
        expect(BX.render(plan, { sortedBy: ['location.gln', 'supplier'] }))
            .to.include("sorted them by <code>location.gln</code> → <code>supplier</code> to keep each request's rows together");
        expect(BX.render(plan)).to.not.include('sorted them by');
    });

    it('URL shapes show the URLs readably, and say what the [ … ] joiner does', async () => {
        const plan = await planBatch({
            endpoint: { method: 'GET', path: '/items', body: '', queryParams: { query: 'id={{item}}[ or ]' } },
            headers: ['item'], rows: [['A'], ['B']], mappings: map(['item']), reps: 1,
            queryParamRepetition: { enabled: true, paramKey: 'query', pattern: 'id={{item}}', separator: ' or ', maxUrlLength: 2048 }
        });
        const html = BX.render(plan);
        expect(html).to.include('/items?query=id=A or id=B');
        expect(html).to.include('joined with <code>or</code>');
        expect(html).to.include('One value per row, joined into the URL');
    });

    it('escapes everything that came from the template or the data', async () => {
        const plan = await planBatch({
            endpoint: { method: 'POST', path: '/x', body: JSON.stringify({ note: '<img src=x onerror=alert(1)>', v: '{{v}}' }) },
            headers: ['v'], rows: [['<b>row</b>']], mappings: map(['v']), reps: 1
        });
        const html = BX.render(plan);
        expect(html).to.not.include('<img');
        expect(html).to.include('&lt;img src=x onerror=alert(1)&gt;');
    });
});

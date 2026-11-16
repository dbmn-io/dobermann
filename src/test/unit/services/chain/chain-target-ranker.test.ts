// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { rankChainTargets, resourceStem, describeCandidate, isSuggested } from '../../../../services/chain/chain-target-ranker';
import { endpointInputVariables } from '../../../../services/chain/endpoint-input-variables';

// GitHub Issue #247: which endpoints can a Console View's rows feed?
const ep = (id: string, method: string, path: string, body?: object | string, extra: Record<string, unknown> = {}) =>
    ({ id, name: id, method, path, body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), headers: {}, ...extra }) as any;

describe('Chain — endpoint input variables (#247)', () => {
    it('reads body, path, header and query variables; skips A8 and ENV; knows |opt and |null', () => {
        const vars = endpointInputVariables(ep('a', 'POST', '/orders/{{orderId}}', {
            gln: '{{location.gln:string}}', qty: '{{qty:number}}', sku: '{{supplierSku:string|opt}}',
            note: '{{note:string|null}}', seq: '{{A8:sequence}}', env: '{{ENV:tenant}}'
        }, { headers: { Facility: '{{facility}}' }, queryParams: { size: '{{size:number|opt}}' } }));
        const byName = Object.fromEntries(vars.map(v => [v.name, v.optional]));
        expect(byName).to.deep.equal({
            'location.gln': false, qty: false, supplierSku: true, note: true,
            orderId: false, facility: false, size: true
        });
    });

    it('a URL-only variable ({{pk}}) is an input variable; an endpoint with none has nothing to map', () => {
        expect(endpointInputVariables(ep('a', 'DELETE', '/orders/{{pk}}'))).to.deep.equal([{ name: 'pk', optional: false }]);
        expect(endpointInputVariables(ep('b', 'GET', '/orders', '', { queryParams: { size: '50' } }))).to.deep.equal([]);
    });

    it('a variable required anywhere is required', () => {
        const vars = endpointInputVariables(ep('a', 'POST', '/x/{{id}}', { id: '{{id:string|opt}}' }));
        expect(vars).to.deep.equal([{ name: 'id', optional: false }]);
    });
});

describe('Chain — ranking targets (#247)', () => {
    const source = { id: 'src', method: 'GET', path: '/lmcore/api/lmcore/employeeStatus' };
    const columns = ['employeeId', 'location.gln', 'status'];
    const endpoints = [
        ep('src', 'GET', '/lmcore/api/lmcore/employeeStatus'),
        ep('save', 'POST', '/lmcore/api/lmcore/employeeStatus/save', { id: '{{employeeId}}' }),
        ep('full', 'POST', '/other', { e: '{{EmployeeID}}', g: '{{location_gln}}', s: '{{status}}' }),
        ep('partial', 'PUT', '/partial', { e: '{{employeeId}}', r: '{{reason}}', x: '{{extra:string|opt}}' }),
        ep('none', 'GET', '/unrelated', { z: '{{zebra}}' })
    ];

    it('leaves out the source endpoint', () => {
        expect(rankChainTargets(columns, endpoints, source).map(c => c.endpointId)).to.not.include('src');
    });

    it('fully covered first (case and punctuation ignored), then by matches, then same resource', () => {
        const ranked = rankChainTargets(columns, endpoints, source);
        expect(ranked.map(c => c.endpointId)).to.deep.equal(['full', 'save', 'partial', 'none']);
        const full = ranked[0];
        expect(full.fullyCovered).to.equal(true);
        expect(full.matched).to.deep.equal(['EmployeeID', 'location_gln', 'status']);
        const save = ranked[1];
        expect(save.sameResource).to.equal(true);
        expect(save.fullyCovered).to.equal(true);
    });

    it('an optional variable does not count as missing', () => {
        const partial = rankChainTargets(columns, endpoints, source).find(c => c.endpointId === 'partial')!;
        expect(partial.missingRequired).to.deep.equal(['reason']);
        expect(partial.fullyCovered).to.equal(false);
        expect(describeCandidate(partial)).to.equal('1 of 3 variables match · missing reason');
    });

    it('suggests only endpoints where every required variable has a column (review 2026-10-04)', () => {
        const ranked = rankChainTargets(columns, endpoints, source);
        expect(ranked.filter(isSuggested).map(c => c.endpointId)).to.deep.equal(['full', 'save']);
    });

    it('resource stem drops trailing verbs, ids and variables', () => {
        expect(resourceStem('/lmcore/api/lmcore/employeeStatus/save')).to.equal('lmcore/api/lmcore/employeestatus');
        expect(resourceStem('/orders/{{orderId}}')).to.equal('orders');
        expect(resourceStem('https://host.example/orders/123?x=1')).to.equal('orders');
        expect(resourceStem('/orders/saveAll')).to.equal('orders');
    });
});

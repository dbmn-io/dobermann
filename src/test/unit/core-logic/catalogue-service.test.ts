// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { APIEndpointConfig } from '../../../apiConfigManager';
import { SystemConfig } from '../../../data-loading/system-schema';
import {
    applyView,
    defaultView,
    filterEndpoints,
    CatalogueViewSpec,
    GroupBy
} from '../../../services/catalogue/catalogue.service';
import { HttpMethod } from '../../../services/tree/endpoint-tree-builder';

function makeEndpoint(
    id: string,
    path: string,
    method: HttpMethod = 'GET',
    systemId?: string,
    name?: string
): APIEndpointConfig {
    return {
        id,
        name: name ?? id,
        path,
        method,
        systemId,
        headers: {},
        queryParams: {}
    } as APIEndpointConfig;
}

function makeSystem(id: string, name: string, treeTrimPrefix?: string): SystemConfig {
    return {
        id,
        name,
        treeTrimPrefix,
        createdAt: 1
    } as SystemConfig;
}

const view = (groupBy: GroupBy, overrides: Partial<CatalogueViewSpec['filters']> = {}): CatalogueViewSpec => ({
    groupBy,
    filters: overrides
});

describe('catalogue-service — applyView (group by system)', () => {
    it('produces one group per System, sorted alphabetically by label', () => {
        const endpoints = [
            makeEndpoint('a', '/x', 'GET', 'sysB'),
            makeEndpoint('b', '/y', 'POST', 'sysA'),
            makeEndpoint('c', '/z', 'GET', 'sysA')
        ];
        const systems = [makeSystem('sysA', 'aaa'), makeSystem('sysB', 'bbb')];

        const out = applyView(endpoints, systems, view('system'));

        expect(out.groups.map(g => g.label)).to.deep.equal(['aaa', 'bbb']);
        expect(out.groups[0].count).to.equal(2);
        expect(out.groups[1].count).to.equal(1);
        expect(out.totalCount).to.equal(3);
    });

    it('places orphan (no systemId) endpoints under the "Unassigned" group', () => {
        const endpoints = [
            makeEndpoint('a', '/x', 'GET'),
            makeEndpoint('b', '/y', 'POST', 'sysA')
        ];
        const out = applyView(endpoints, [makeSystem('sysA', 'acmewms')], view('system'));

        const labels = out.groups.map(g => g.label).sort();
        expect(labels).to.deep.equal(['Unassigned', 'acmewms']);
    });

    it('sorts endpoints within a system group by path then method', () => {
        const endpoints = [
            makeEndpoint('a', '/zeta', 'GET', 'sys1'),
            makeEndpoint('b', '/alpha', 'POST', 'sys1'),
            makeEndpoint('c', '/alpha', 'GET', 'sys1')
        ];
        const out = applyView(endpoints, [makeSystem('sys1', 's')], view('system'));
        const ids = out.groups[0].endpoints.map(e => e.id);
        expect(ids).to.deep.equal(['c', 'b', 'a']);
    });
});

describe('catalogue-service — applyView (group by method)', () => {
    it('produces a group per HTTP method in canonical order', () => {
        const endpoints = [
            makeEndpoint('a', '/x', 'DELETE', 's'),
            makeEndpoint('b', '/y', 'GET', 's'),
            makeEndpoint('c', '/z', 'POST', 's'),
            makeEndpoint('d', '/w', 'POST', 's')
        ];
        const out = applyView(endpoints, [makeSystem('s', 'sys')], view('method'));

        expect(out.groups.map(g => g.label)).to.deep.equal(['GET', 'POST', 'DELETE']);
        expect(out.groups.find(g => g.label === 'POST')!.count).to.equal(2);
    });

    it('omits method groups with zero endpoints after filtering', () => {
        const endpoints = [makeEndpoint('a', '/x', 'GET', 's')];
        const out = applyView(endpoints, [makeSystem('s', 'sys')], view('method'));

        expect(out.groups.map(g => g.label)).to.deep.equal(['GET']);
    });
});

describe('catalogue-service — applyView (group by url)', () => {
    it('renders the URL tree directly with no System wrapper layer', () => {
        const endpoints = [
            makeEndpoint('a', '/api/foo', 'GET', 's'),
            makeEndpoint('b', '/api/foo', 'POST', 's')
        ];
        const out = applyView(endpoints, [makeSystem('s', 'sys')], view('url'));

        // No System wrapper — the compacted "api/foo" node is at the top level.
        expect(out.groups).to.have.length(1);
        expect(out.groups[0].label).to.equal('api/foo');
        expect(out.groups[0].endpoints.map(e => e.id).sort()).to.deep.equal(['a', 'b']);
    });

    it('applies the System trim prefix when constructing URL segments', () => {
        const sys = makeSystem('s', 'sys', '/dcinventory/api/dcinventory/');
        const endpoints = [
            makeEndpoint('a', '/dcinventory/api/dcinventory/inventory/widget', 'GET', 's'),
            makeEndpoint('b', '/dcinventory/api/dcinventory/inventory/lookup', 'GET', 's')
        ];
        const out = applyView(endpoints, [sys], view('url'));

        // Top-level group is now "inventory" directly (no System wrapper).
        const inventory = out.groups.find(c => c.label === 'inventory');
        expect(inventory, 'inventory group exists').to.exist;
        expect(inventory!.children.map(c => c.label).sort()).to.deep.equal(['lookup', 'widget']);
    });

    it('merges endpoints across Systems when their trimmed paths overlap', () => {
        // Two Systems both expose /orders; with each System's trim applied
        // they collapse into one top-level "orders" group.
        const sysA = makeSystem('sysA', 'aaa', '/api/v1/');
        const sysB = makeSystem('sysB', 'bbb', '/services/');
        const endpoints = [
            makeEndpoint('a', '/api/v1/orders', 'GET', 'sysA'),
            makeEndpoint('b', '/services/orders', 'POST', 'sysB')
        ];
        const out = applyView(endpoints, [sysA, sysB], view('url'));

        expect(out.groups).to.have.length(1);
        expect(out.groups[0].label).to.equal('orders');
        expect(out.groups[0].endpoints.map(e => e.id).sort()).to.deep.equal(['a', 'b']);
    });

    it('keeps cross-System endpoints under separate top groups when trimmed paths differ', () => {
        const endpoints = [
            makeEndpoint('a', '/x/y', 'GET', 'sysA'),
            makeEndpoint('b', '/p/q', 'GET', 'sysB')
        ];
        const systems = [makeSystem('sysA', 'aaa'), makeSystem('sysB', 'bbb')];
        const out = applyView(endpoints, systems, view('url'));

        // No System wrapper — the URL trees from each System sit at top level.
        const labels = out.groups.map(g => g.label).sort();
        expect(labels).to.deep.equal(['p/q', 'x/y']);
    });
});

describe('catalogue-service — applyView (group by none)', () => {
    it('returns one flat group containing every endpoint', () => {
        const endpoints = [
            makeEndpoint('a', '/x', 'GET', 's'),
            makeEndpoint('b', '/y', 'POST', 's')
        ];
        const out = applyView(endpoints, [makeSystem('s', 'sys')], view('none'));

        expect(out.groups).to.have.length(1);
        expect(out.groups[0].count).to.equal(2);
        expect(out.groups[0].endpoints.map(e => e.id).sort()).to.deep.equal(['a', 'b']);
    });
});

describe('catalogue-service — filterEndpoints', () => {
    const systems = [makeSystem('sysA', 'aaa'), makeSystem('sysB', 'bbb')];
    const endpoints = [
        makeEndpoint('a', '/orders/create', 'POST', 'sysA', 'Create Order'),
        makeEndpoint('b', '/orders/cancel', 'DELETE', 'sysA', 'Cancel Order'),
        makeEndpoint('c', '/users/list', 'GET', 'sysB', 'List Users')
    ];

    it('filters by systemIds', () => {
        const out = filterEndpoints(endpoints, { systemIds: ['sysA'] });
        expect(out.map(e => e.id).sort()).to.deep.equal(['a', 'b']);
    });

    it('filters by methods (multi-select)', () => {
        const out = filterEndpoints(endpoints, { methods: ['POST', 'DELETE'] });
        expect(out.map(e => e.id).sort()).to.deep.equal(['a', 'b']);
    });

    it('AND-combines filters (system ∩ method)', () => {
        const out = filterEndpoints(endpoints, { systemIds: ['sysA'], methods: ['POST'] });
        expect(out.map(e => e.id)).to.deep.equal(['a']);
    });

    it('search matches case-insensitively against name', () => {
        const out = filterEndpoints(endpoints, { search: 'CANCEL' });
        expect(out.map(e => e.id)).to.deep.equal(['b']);
    });

    it('search matches case-insensitively against path', () => {
        const out = filterEndpoints(endpoints, { search: '/users' });
        expect(out.map(e => e.id)).to.deep.equal(['c']);
    });

    it('search matches against description', () => {
        const ep = { ...makeEndpoint('d', '/x', 'GET'), description: 'returns rate cards for the customer' };
        const out = filterEndpoints([ep], { search: 'rate cards' });
        expect(out.map(e => e.id)).to.deep.equal(['d']);
    });

    it('search matches against body template content', () => {
        const ep = { ...makeEndpoint('e', '/x', 'POST'), body: '{ "orderId": "{{rowId}}", "weight": 100 }' };
        const out = filterEndpoints([ep], { search: 'orderId' });
        expect(out.map(e => e.id)).to.deep.equal(['e']);
    });

    it('search matches against header keys', () => {
        const ep = { ...makeEndpoint('f', '/x', 'GET'), headers: { 'X-Custom-Tenant': { value: 'acme', enabled: true } } } as any;
        const out = filterEndpoints([ep], { search: 'tenant' });
        expect(out.map(e => e.id)).to.deep.equal(['f']);
    });

    it('search matches against header values', () => {
        const ep = { ...makeEndpoint('g', '/x', 'GET'), headers: { 'Authorization': { value: 'Bearer {{token}}', enabled: true } } } as any;
        const out = filterEndpoints([ep], { search: 'bearer' });
        expect(out.map(e => e.id)).to.deep.equal(['g']);
    });

    it('search matches against query parameters', () => {
        const ep = { ...makeEndpoint('h', '/x', 'GET'), queryParams: { 'filter': { value: 'archived=false', enabled: true } } } as any;
        const out = filterEndpoints([ep], { search: 'archived' });
        expect(out.map(e => e.id)).to.deep.equal(['h']);
    });

    it('search matches against tags', () => {
        const ep = { ...makeEndpoint('i', '/x', 'GET'), tags: ['smoke-test', 'p0'] };
        const out = filterEndpoints([ep], { search: 'smoke' });
        expect(out.map(e => e.id)).to.deep.equal(['i']);
    });

    it('AND-combines search with other filters', () => {
        const out = filterEndpoints(endpoints, { systemIds: ['sysA'], search: 'order' });
        expect(out.map(e => e.id).sort()).to.deep.equal(['a', 'b']);
    });

    it('empty filters return everything', () => {
        const out = filterEndpoints(endpoints, {});
        expect(out).to.have.length(3);
    });

    it('treats endpoints without systemId as belonging to the "unknown" system key', () => {
        const orphan = makeEndpoint('z', '/x', 'GET');
        const out = filterEndpoints([orphan, ...endpoints], { systemIds: ['__unknown__'] });
        expect(out.map(e => e.id)).to.deep.equal(['z']);
    });
});

describe('catalogue-service — edge cases', () => {
    it('empty endpoint list returns empty groups for every groupBy', () => {
        const systems = [makeSystem('s', 'sys')];
        for (const g of ['url', 'method', 'system'] as GroupBy[]) {
            const out = applyView([], systems, view(g));
            expect(out.groups, `groupBy=${g}`).to.deep.equal([]);
            expect(out.totalCount).to.equal(0);
        }
        // 'none' always yields one (possibly empty) flat group
        const flat = applyView([], systems, view('none'));
        expect(flat.groups).to.have.length(1);
        expect(flat.groups[0].count).to.equal(0);
    });

    it('view spec round-trips through the result for downstream inspection', () => {
        const spec = view('method', { methods: ['POST'] });
        const out = applyView([], [], spec);
        expect(out.view).to.deep.equal(spec);
    });
});

describe('catalogue-service — defaultView', () => {
    it('with an active System: filter to it, group by URL', () => {
        const spec = defaultView('sysA');
        expect(spec.groupBy).to.equal('url');
        expect(spec.filters.systemIds).to.deep.equal(['sysA']);
    });

    it('without an active System: no filter, group by System', () => {
        const spec = defaultView(undefined);
        expect(spec.groupBy).to.equal('system');
        expect(spec.filters.systemIds).to.be.undefined;
    });
});

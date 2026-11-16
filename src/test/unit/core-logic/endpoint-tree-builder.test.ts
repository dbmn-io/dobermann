// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { APIEndpointConfig } from '../../../apiConfigManager';
import {
    buildCompactUrlTree,
    buildUrlTree,
    collectEndpointsInSubtree,
    compactSingleChildChains,
    UrlTreeNode,
    HttpMethod
} from '../../../services/tree/endpoint-tree-builder';

function makeEndpoint(id: string, path: string, method: HttpMethod = 'GET'): APIEndpointConfig {
    return {
        id,
        name: id,
        path,
        method,
        headers: {},
        queryParams: {}
    } as APIEndpointConfig;
}

function dumpTree(node: UrlTreeNode, indent = 0): string {
    const pad = '  '.repeat(indent);
    const methods = [...node.methods.entries()]
        .map(([m, eps]) => `${m}[${eps.map(e => e.id).join(',')}]`)
        .join(' ');
    const head = `${pad}${node.segment || '<root>'}${methods ? ' ' + methods : ''}`;
    const kids = [...node.children.values()].map(c => dumpTree(c, indent + 1)).join('\n');
    return kids ? `${head}\n${kids}` : head;
}

describe('endpoint-tree-builder — buildUrlTree (no compaction)', () => {
    it('builds a single chain for one endpoint', () => {
        const tree = buildUrlTree([makeEndpoint('e1', '/api/foo')]);
        expect(tree.children.size).to.equal(1);
        const api = tree.children.get('api')!;
        expect(api).to.exist;
        expect(api.children.size).to.equal(1);
        const foo = api.children.get('foo')!;
        expect(foo.methods.get('GET')!.map(e => e.id)).to.deep.equal(['e1']);
    });

    it('merges variants of the same URL+Method onto one leaf', () => {
        const tree = buildUrlTree([
            makeEndpoint('v1', '/api/foo', 'POST'),
            makeEndpoint('v2', '/api/foo', 'POST')
        ]);
        const foo = tree.children.get('api')!.children.get('foo')!;
        expect(foo.methods.get('POST')!.map(e => e.id).sort()).to.deep.equal(['v1', 'v2']);
    });

    it('places different methods of the same path as separate method leaves', () => {
        const tree = buildUrlTree([
            makeEndpoint('g', '/api/foo', 'GET'),
            makeEndpoint('p', '/api/foo', 'POST')
        ]);
        const foo = tree.children.get('api')!.children.get('foo')!;
        expect([...foo.methods.keys()].sort()).to.deep.equal(['GET', 'POST']);
    });

    it('applies trimPrefix before splitting segments', () => {
        const tree = buildUrlTree(
            [makeEndpoint('e', '/dcinventory/api/dcinventory/inventory/widget')],
            { trimPrefix: '/dcinventory/api/dcinventory/' }
        );
        // After trim the visible path is /inventory/widget — two visible segments.
        expect(tree.children.size).to.equal(1);
        expect(tree.children.get('inventory')!.children.get('widget')).to.exist;
    });

    it('attaches a root-level endpoint as a method leaf on the root', () => {
        // After trim, the path collapses to "/" — endpoint must still be reachable.
        const tree = buildUrlTree(
            [makeEndpoint('root', '/api/foo')],
            { trimPrefix: '/api/foo' }
        );
        expect(tree.methods.get('GET')!.map(e => e.id)).to.deep.equal(['root']);
        expect(tree.children.size).to.equal(0);
    });

    it('joins overflow segments into the final visible node when path exceeds maxDepth', () => {
        const tree = buildUrlTree(
            [makeEndpoint('deep', '/a/b/c/d/e/f')],
            { maxDepth: 3 }
        );
        // Visible: a → b → c/d/e/f (last node absorbs the rest)
        const a = tree.children.get('a')!;
        const b = a.children.get('b')!;
        const tail = [...b.children.keys()];
        expect(tail).to.deep.equal(['c/d/e/f']);
        expect(b.children.get('c/d/e/f')!.methods.get('GET')!.map(e => e.id)).to.deep.equal(['deep']);
    });
});

describe('endpoint-tree-builder — compactSingleChildChains', () => {
    it('compacts a chain of single-child nodes into a slash-joined label', () => {
        const tree = compactSingleChildChains(
            buildUrlTree([makeEndpoint('e', '/dcinventory/api/dcinventory/inventory/widget')])
        );
        // After compaction the root has exactly one child labelled
        // "dcinventory/api/dcinventory/inventory/widget" with a GET method leaf on it.
        expect(tree.children.size).to.equal(1);
        const [only] = [...tree.children.values()];
        expect(only.segment).to.equal('dcinventory/api/dcinventory/inventory/widget');
        expect(only.methods.get('GET')!.map(e => e.id)).to.deep.equal(['e']);
    });

    it('does not compact past a branch point', () => {
        const tree = buildCompactUrlTree([
            makeEndpoint('e1', '/api/orders/create'),
            makeEndpoint('e2', '/api/orders/cancel')
        ]);
        // api/orders is the branch point; create and cancel are siblings beneath it.
        expect(tree.children.size).to.equal(1);
        const branch = [...tree.children.values()][0];
        expect(branch.segment).to.equal('api/orders');
        expect([...branch.children.keys()].sort()).to.deep.equal(['cancel', 'create']);
    });

    it('does not compact a node that carries both methods and a child (user\'s example)', () => {
        // /api/foo  POST            ← root URL has its own method leaf
        // /api/foo/Bulk POST        ← AND a sub-path
        const tree = buildCompactUrlTree([
            makeEndpoint('root', '/api/foo', 'POST'),
            makeEndpoint('bulk', '/api/foo/Bulk', 'POST')
        ]);
        const foo = [...tree.children.values()][0];
        expect(foo.segment).to.equal('api/foo');
        expect(foo.methods.get('POST')!.map(e => e.id)).to.deep.equal(['root']);
        expect([...foo.children.keys()]).to.deep.equal(['Bulk']);
        expect(foo.children.get('Bulk')!.methods.get('POST')!.map(e => e.id)).to.deep.equal(['bulk']);
    });

    it('renders the user\'s absoluteAdjustInventory example correctly', () => {
        const tree = buildCompactUrlTree(
            [
                makeEndpoint('root', '/dcinventory/api/dcinventory/inventory/absoluteAdjustInventory', 'POST'),
                makeEndpoint('bulk', '/dcinventory/api/dcinventory/inventory/absoluteAdjustInventory/Bulk', 'POST'),
                makeEndpoint('save', '/dcinventory/api/dcinventory/inventory/absoluteAdjustInventory/save', 'POST'),
                makeEndpoint('lookup', '/dcinventory/api/dcinventory/inventory/lookup', 'GET')
            ],
            { trimPrefix: '/dcinventory/api/dcinventory/' }
        );

        // After trim, paths reduce to /inventory/absoluteAdjustInventory[/Bulk|/save] and /inventory/lookup.
        // Compaction yields: inventory → { absoluteAdjustInventory (POST, with Bulk/POST, save/POST children), lookup/GET }.
        expect(tree.children.size).to.equal(1);
        const inventory = [...tree.children.values()][0];
        expect(inventory.segment).to.equal('inventory');
        expect([...inventory.children.keys()].sort()).to.deep.equal(['absoluteAdjustInventory', 'lookup']);

        const abs = inventory.children.get('absoluteAdjustInventory')!;
        expect(abs.methods.get('POST')!.map(e => e.id)).to.deep.equal(['root']);
        expect([...abs.children.keys()].sort()).to.deep.equal(['Bulk', 'save']);
        // Bulk/save each have a single POST leaf; they don't get extra compaction since they're already leaves.
        expect(abs.children.get('Bulk')!.methods.get('POST')!.map(e => e.id)).to.deep.equal(['bulk']);
        expect(abs.children.get('save')!.methods.get('POST')!.map(e => e.id)).to.deep.equal(['save']);

        const lookup = inventory.children.get('lookup')!;
        expect(lookup.methods.get('GET')!.map(e => e.id)).to.deep.equal(['lookup']);
        // For diagnostic clarity if the layout changes:
        // console.log(dumpTree(tree));
        dumpTree; // silence unused
    });
});

describe('endpoint-tree-builder — collectEndpointsInSubtree', () => {
    it('returns the endpoints attached at this node only when there are no children', () => {
        const tree = buildCompactUrlTree([
            makeEndpoint('e1', '/api/orders', 'POST'),
            makeEndpoint('e2', '/api/orders', 'POST')
        ]);
        const ordersNode = [...tree.children.values()][0];
        const ids = collectEndpointsInSubtree(ordersNode).map(e => e.id).sort();
        expect(ids).to.deep.equal(['e1', 'e2']);
    });

    it('walks deep subtrees and returns every endpoint reachable', () => {
        const tree = buildCompactUrlTree([
            makeEndpoint('root', '/api/orders', 'POST'),
            makeEndpoint('create', '/api/orders/create', 'POST'),
            makeEndpoint('cancel', '/api/orders/cancel', 'DELETE'),
            makeEndpoint('detail', '/api/orders/detail', 'GET'),
            makeEndpoint('unrelated', '/api/users', 'GET')
        ]);
        // After compaction the top-level child is "api"; its children are "orders" and "users".
        const apiNode = [...tree.children.values()].find(c => c.segment === 'api')!;
        const ordersNode = apiNode.children.get('orders')!;

        const ids = collectEndpointsInSubtree(ordersNode).map(e => e.id).sort();
        expect(ids).to.deep.equal(['cancel', 'create', 'detail', 'root']);
        // `unrelated` is under a sibling — must not leak.
        expect(ids).to.not.include('unrelated');
    });

    it('returns an empty array for a node with no methods and no children', () => {
        const empty: UrlTreeNode = {
            segment: '',
            fullPath: '',
            children: new Map(),
            methods: new Map()
        };
        expect(collectEndpointsInSubtree(empty)).to.deep.equal([]);
    });

    it('includes variants (multiple endpoints sharing the same URL+Method)', () => {
        const tree = buildCompactUrlTree([
            makeEndpoint('v1', '/api/orders', 'POST'),
            makeEndpoint('v2', '/api/orders', 'POST'),
            makeEndpoint('v3', '/api/orders', 'POST')
        ]);
        const ordersNode = [...tree.children.values()][0];
        const ids = collectEndpointsInSubtree(ordersNode).map(e => e.id).sort();
        expect(ids).to.deep.equal(['v1', 'v2', 'v3']);
    });
});

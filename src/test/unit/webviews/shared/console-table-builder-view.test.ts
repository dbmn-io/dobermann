// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createConsoleTableBuilder } = require('../../../../webviews/shared/console-table-builder');

// GitHub Issue #229: view-driven extraction tests for extractRowsForView +
// extractRelativeValue. Mirrors the four worked examples in the Phase 1A plan.

interface ViewCol {
    id: string;
    source: 'current' | 'ancestor' | 'nested';
    groupType?: 'object' | 'array';
    display?: 'grouped' | 'flattened';
    children?: ViewCol[];
}
interface ConsoleView {
    name: string;
    rowBasis: string;
    columns: ViewCol[];
}

describe('console-table-builder — extractRowsForView (Issue #229)', () => {
    let builder: ReturnType<typeof createConsoleTableBuilder>;

    beforeEach(() => {
        builder = createConsoleTableBuilder();
    });

    describe('extractRelativeValue', () => {
        it('reads a path directly when rowBasis is "root"', () => {
            const obj = { a: { b: 42 } };
            expect(builder.extractRelativeValue(obj, 'a.b', 'root')).to.equal(42);
        });

        it('strips the rowBasis prefix from an absolute id', () => {
            const row = { itemId: 'SKU-1', nested: { x: 1 } };
            expect(builder.extractRelativeValue(row, 'data.lines.itemId', 'data.lines')).to.equal('SKU-1');
            expect(builder.extractRelativeValue(row, 'data.lines.nested.x', 'data.lines')).to.equal(1);
        });

        it('returns undefined for missing paths', () => {
            const row = { a: 1 };
            expect(builder.extractRelativeValue(row, 'a.b.c', 'root')).to.equal(undefined);
            expect(builder.extractRelativeValue(row, 'missing', 'root')).to.equal(undefined);
        });

        it('returns the row itself when absId equals rowBasis', () => {
            const row = { foo: 'bar' };
            expect(builder.extractRelativeValue(row, 'data.lines', 'data.lines')).to.deep.equal(row);
        });

        it('handles null/undefined row inputs', () => {
            expect(builder.extractRelativeValue(null, 'x', 'root')).to.equal(undefined);
            expect(builder.extractRelativeValue(undefined, 'x', 'root')).to.equal(undefined);
        });
    });

    describe('Example 1 — root rowBasis, flat columns', () => {
        it('emits one row per response with each column populated', () => {
            const responses = [{
                requestId: 'r-001',
                status: 'ok',
                customer: { id: 'C-1', name: 'Acme' },
                total: 1250.0
            }];
            const view: ConsoleView = {
                name: 'Root',
                rowBasis: 'root',
                columns: [
                    { id: 'requestId', source: 'current' },
                    { id: 'status', source: 'current' },
                    { id: 'customer.name', source: 'current' },
                    { id: 'total', source: 'current' }
                ]
            };
            const rows = builder.extractRowsForView(responses, view);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0]).to.deep.equal({
                requestId: 'r-001',
                status: 'ok',
                'customer.name': 'Acme',
                total: 1250.0
            });
        });
    });

    describe('Example 2 — nested rowBasis with ancestor columns', () => {
        const response = {
            requestId: 'r-002',
            data: {
                purchaseOrders: {
                    poNumber: 'PO-9',
                    supplier: 'Globex',
                    lines: [
                        { itemId: 'SKU-1', quantity: 3, unitPrice: 10.0 },
                        { itemId: 'SKU-2', quantity: 1, unitPrice: 50.0 }
                    ]
                }
            }
        };
        const view: ConsoleView = {
            name: 'PO Lines',
            rowBasis: 'data.purchaseOrders.lines',
            columns: [
                { id: 'data.purchaseOrders.poNumber', source: 'ancestor' },
                { id: 'data.purchaseOrders.supplier', source: 'ancestor' },
                { id: 'data.purchaseOrders.lines.itemId', source: 'current' },
                { id: 'data.purchaseOrders.lines.quantity', source: 'current' },
                { id: 'data.purchaseOrders.lines.unitPrice', source: 'current' }
            ]
        };

        it('produces one row per line with ancestor columns repeated', () => {
            const rows = builder.extractRowsForView([response], view);
            expect(rows).to.have.lengthOf(2);
            expect(rows[0]).to.deep.equal({
                'data.purchaseOrders.poNumber': 'PO-9',
                'data.purchaseOrders.supplier': 'Globex',
                'data.purchaseOrders.lines.itemId': 'SKU-1',
                'data.purchaseOrders.lines.quantity': 3,
                'data.purchaseOrders.lines.unitPrice': 10.0
            });
            expect(rows[1]).to.deep.equal({
                'data.purchaseOrders.poNumber': 'PO-9',
                'data.purchaseOrders.supplier': 'Globex',
                'data.purchaseOrders.lines.itemId': 'SKU-2',
                'data.purchaseOrders.lines.quantity': 1,
                'data.purchaseOrders.lines.unitPrice': 50.0
            });
        });

        it('keeps ancestor values independent across responses', () => {
            const second = {
                requestId: 'r-002b',
                data: {
                    purchaseOrders: {
                        poNumber: 'PO-10',
                        supplier: 'Initech',
                        lines: [{ itemId: 'SKU-3', quantity: 2, unitPrice: 7.5 }]
                    }
                }
            };
            const rows = builder.extractRowsForView([response, second], view);
            expect(rows).to.have.lengthOf(3);
            expect(rows[2]['data.purchaseOrders.poNumber']).to.equal('PO-10');
            expect(rows[2]['data.purchaseOrders.supplier']).to.equal('Initech');
        });
    });

    describe('Example 3 — nested array column stores raw payload', () => {
        const response = {
            data: {
                purchaseOrders: {
                    lines: [
                        {
                            itemId: 'SKU-1',
                            taxes: [
                                { code: 'VAT', rate: 0.2 },
                                { code: 'ENV', rate: 0.01 }
                            ]
                        },
                        { itemId: 'SKU-2', taxes: [{ code: 'VAT', rate: 0.2 }] }
                    ]
                }
            }
        };
        const view: ConsoleView = {
            name: 'PO Lines + Taxes',
            rowBasis: 'data.purchaseOrders.lines',
            columns: [
                { id: 'data.purchaseOrders.lines.itemId', source: 'current' },
                {
                    id: 'data.purchaseOrders.lines.taxes',
                    source: 'nested',
                    groupType: 'array',
                    display: 'grouped',
                    children: [
                        { id: 'data.purchaseOrders.lines.taxes.code', source: 'current' },
                        { id: 'data.purchaseOrders.lines.taxes.rate', source: 'current' }
                    ]
                }
            ]
        };

        it('keeps the nested array as a raw payload on the row', () => {
            const rows = builder.extractRowsForView([response], view);
            expect(rows).to.have.lengthOf(2);
            expect(rows[0]['data.purchaseOrders.lines.taxes']).to.be.an('array').with.lengthOf(2);
            expect(rows[1]['data.purchaseOrders.lines.taxes']).to.be.an('array').with.lengthOf(1);
        });

        it('flattenNestedForExport produces cartesian product', () => {
            const rows = builder.extractRowsForView([response], view);
            const flat = builder.flattenNestedForExport(rows, view);
            expect(flat).to.have.lengthOf(3);
            // Row 0: SKU-1 + VAT
            expect(flat[0]['data.purchaseOrders.lines.itemId']).to.equal('SKU-1');
            expect(flat[0]['data.purchaseOrders.lines.taxes.code']).to.equal('VAT');
            // Row 1: SKU-1 + ENV
            expect(flat[1]['data.purchaseOrders.lines.itemId']).to.equal('SKU-1');
            expect(flat[1]['data.purchaseOrders.lines.taxes.code']).to.equal('ENV');
            // Row 2: SKU-2 + VAT
            expect(flat[2]['data.purchaseOrders.lines.itemId']).to.equal('SKU-2');
            expect(flat[2]['data.purchaseOrders.lines.taxes.code']).to.equal('VAT');
            // Raw array payload is removed from flattened rows
            expect(flat[0]).to.not.have.property('data.purchaseOrders.lines.taxes');
        });

        it('flattenNestedForExport preserves parent rows when nested array is empty', () => {
            const empty = {
                data: {
                    purchaseOrders: {
                        lines: [{ itemId: 'SKU-3', taxes: [] }]
                    }
                }
            };
            const rows = builder.extractRowsForView([empty], view);
            const flat = builder.flattenNestedForExport(rows, view);
            expect(flat).to.have.lengthOf(1);
            expect(flat[0]['data.purchaseOrders.lines.itemId']).to.equal('SKU-3');
            expect(flat[0]['data.purchaseOrders.lines.taxes.code']).to.equal(undefined);
        });
    });

    describe('Example 4 — nested object wrapper populates child leaves', () => {
        it('recurses object-wrapper children so each leaf is at flat[childId]', () => {
            const response = {
                requestId: 'r-004',
                customer: { id: 'C-7', name: 'Initech', tier: 'gold' },
                total: 99.5
            };
            const view: ConsoleView = {
                name: 'Requests',
                rowBasis: 'root',
                columns: [
                    { id: 'requestId', source: 'current' },
                    {
                        id: 'customer',
                        source: 'nested',
                        groupType: 'object',
                        display: 'grouped',
                        children: [
                            { id: 'customer.id', source: 'current' },
                            { id: 'customer.name', source: 'current' },
                            { id: 'customer.tier', source: 'current' }
                        ]
                    },
                    { id: 'total', source: 'current' }
                ]
            };
            const rows = builder.extractRowsForView([response], view);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0].requestId).to.equal('r-004');
            // Phase 1B.5: object wrappers below rowBasis recurse into their
            // children so the renderer can read each leaf via flat key lookup.
            expect(rows[0]['customer.id']).to.equal('C-7');
            expect(rows[0]['customer.name']).to.equal('Initech');
            expect(rows[0]['customer.tier']).to.equal('gold');
            expect(rows[0].total).to.equal(99.5);
        });
    });

    describe('column headers — leaf names, paths where leaves collide', () => {
        // Lesson 4's view: location.name and product.supplier.name both end in "name". Copied
        // with leaf headers the table had two "name" columns and the lesson's verifier could
        // not find location.name (2026-09-23).
        const view: ConsoleView = {
            name: 'LowStock', rowBasis: 'data',
            columns: [
                { id: 'data.sku', source: 'current' },
                { id: 'data.location', source: 'nested', groupType: 'object', children: [
                    { id: 'data.location.name', source: 'current' },
                    { id: 'data.location.city', source: 'current' }
                ] },
                { id: 'data.product', source: 'nested', groupType: 'object', children: [
                    { id: 'data.product.category', source: 'current' },
                    { id: 'data.product.supplier', source: 'nested', groupType: 'object', children: [
                        { id: 'data.product.supplier.name', source: 'current' }
                    ] }
                ] }
            ]
        };

        it('heads a nested column by its leaf when that leaf is unique', () => {
            const names = builder.viewToLegacyColumnShape(view).map((c: { id: string; name: string }) => [c.id, c.name]);
            expect(names).to.deep.include(['data.location.city', 'city']);
            expect(names).to.deep.include(['data.product.category', 'category']);
            expect(names).to.deep.include(['data.sku', 'sku']);
        });

        it('heads colliding leaves by their path relative to the row basis', () => {
            const names = builder.viewToLegacyColumnShape(view).map((c: { id: string; name: string }) => [c.id, c.name]);
            expect(names).to.deep.include(['data.location.name', 'location.name']);
            expect(names).to.deep.include(['data.product.supplier.name', 'product.supplier.name']);
        });

        it('uses the whole id when the row basis is root', () => {
            const cols = builder.disambiguateColumnNames([{ id: 'a.name', name: 'name' }, { id: 'b.name', name: 'name' }, { id: 'x', name: 'x' }], 'root');
            expect(cols.map((c: { name: string }) => c.name)).to.deep.equal(['a.name', 'b.name', 'x']);
        });
    });

    describe('edge cases', () => {
        it('returns empty rows when responses are empty', () => {
            const view: ConsoleView = { name: 'Empty', rowBasis: 'root', columns: [] };
            expect(builder.extractRowsForView([], view)).to.deep.equal([]);
        });

        it('skips null responses', () => {
            const view: ConsoleView = {
                name: 'Root',
                rowBasis: 'root',
                columns: [{ id: 'id', source: 'current' }]
            };
            const rows = builder.extractRowsForView([null as any, { id: 'x' }], view);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0].id).to.equal('x');
        });

        it('produces zero rows for a response missing the rowBasis target', () => {
            const view: ConsoleView = {
                name: 'Lines',
                rowBasis: 'data.missing.lines',
                columns: [{ id: 'data.missing.lines.x', source: 'current' }]
            };
            const rows = builder.extractRowsForView([{ data: {} }], view);
            expect(rows).to.deep.equal([]);
        });

        it('handles a single-object (non-array) rowBasis target as one row', () => {
            const view: ConsoleView = {
                name: 'Customer',
                rowBasis: 'customer',
                columns: [{ id: 'customer.id', source: 'current' }]
            };
            const rows = builder.extractRowsForView([{ customer: { id: 'C-9' } }], view);
            expect(rows).to.deep.equal([{ 'customer.id': 'C-9' }]);
        });
    });

    // Issue #250: counts responses whose rowBasis path yields zero rows. Used
    // by the console footer warning chip so the user can tell missing data
    // apart from a failed API call.
    describe('countResponsesWithNoRows', () => {
        it('returns 0 for root rowBasis (every response yields a row)', () => {
            const responses = [{ a: 1 }, { a: 2 }, null, { a: 3 }];
            expect(builder.countResponsesWithNoRows(responses, 'root')).to.equal(0);
            expect(builder.countResponsesWithNoRows(responses, '')).to.equal(0);
            expect(builder.countResponsesWithNoRows(responses, undefined)).to.equal(0);
        });

        it('counts responses missing the rowBasis path', () => {
            const responses = [
                { data: { lines: [{ id: 1 }] } },
                { data: {} },                       // missing path
                { data: { lines: [] } },            // empty array
                { other: 'shape' },                 // missing path
                { data: { lines: [{ id: 2 }, { id: 3 }] } }
            ];
            expect(builder.countResponsesWithNoRows(responses, 'data.lines')).to.equal(3);
        });

        it('skips null/undefined responses', () => {
            const responses = [null, undefined, { data: { lines: [{ id: 1 }] } }];
            expect(builder.countResponsesWithNoRows(responses, 'data.lines')).to.equal(0);
        });

        it('returns 0 for a non-array input', () => {
            expect(builder.countResponsesWithNoRows(null as any, 'data.lines')).to.equal(0);
        });
    });

    describe('edge cases (continued)', () => {
        it('handles arrays of varying length across responses', () => {
            const responses = [
                { lines: [{ id: 1 }, { id: 2 }] },
                { lines: [{ id: 3 }] },
                { lines: [] }
            ];
            const view: ConsoleView = {
                name: 'Lines',
                rowBasis: 'lines',
                columns: [{ id: 'lines.id', source: 'current' }]
            };
            const rows = builder.extractRowsForView(responses, view);
            expect(rows.map((r: any) => r['lines.id'])).to.deep.equal([1, 2, 3]);
        });

        it('ancestor column is undefined when the absolute path is missing', () => {
            const view: ConsoleView = {
                name: 'Missing ancestor',
                rowBasis: 'lines',
                columns: [
                    { id: 'topLevel.missing', source: 'ancestor' },
                    { id: 'lines.id', source: 'current' }
                ]
            };
            const rows = builder.extractRowsForView([{ lines: [{ id: 1 }] }], view);
            expect(rows[0]['topLevel.missing']).to.equal(null);
            expect(rows[0]['lines.id']).to.equal(1);
        });
    });

    // Issue #229 Phase 1B.7: renderTable's path construction for expand-cells
    // depends on column ids being absolute (already dot-paths from response
    // root). If this invariant breaks, the `+ New View` visibility check
    // compares paths like `data.data.data` against saved `rowBasis: data.data`
    // and never matches — button stays visible forever.
    describe('absolute column id invariant (Phase 1B.7)', () => {
        it('flat row keys are absolute dot-paths regardless of rowBasis', () => {
            const response = {
                data: {
                    purchaseOrders: {
                        poNumber: 'PO-9',
                        lines: [
                            { itemId: 'SKU-1', quantity: 3 },
                            { itemId: 'SKU-2', quantity: 1 }
                        ]
                    }
                }
            };
            const view: ConsoleView = {
                name: 'PO Lines',
                rowBasis: 'data.purchaseOrders.lines',
                columns: [
                    { id: 'data.purchaseOrders.poNumber', source: 'ancestor' },
                    { id: 'data.purchaseOrders.lines.itemId', source: 'current' },
                    { id: 'data.purchaseOrders.lines.quantity', source: 'current' }
                ]
            };
            const rows = builder.extractRowsForView([response], view);
            expect(rows).to.have.lengthOf(2);
            for (const row of rows) {
                const keys = Object.keys(row);
                // Every key must be an absolute path (contains dots OR is a top-level scalar)
                expect(keys).to.include('data.purchaseOrders.poNumber');
                expect(keys).to.include('data.purchaseOrders.lines.itemId');
                expect(keys).to.include('data.purchaseOrders.lines.quantity');
                // No relative keys leaked in
                expect(keys).to.not.include('itemId');
                expect(keys).to.not.include('quantity');
                expect(keys).to.not.include('poNumber');
            }
        });

        it('populates ancestors from sibling-branch wrappers (user repro: metadata.sourceFile)', () => {
            // Repro of the user's ViewTest view: rowBasis=data.data, with
            // top-level `status` (ancestor) and a nested `metadata` wrapper
            // containing `metadata.sourceFile` (ancestor). After the adapter
            // collapses sibling wrappers to flat leaves, extractRowsForView
            // must still populate their values via collectAncestors.
            const response = {
                data: {
                    data: [
                        { gln: '0012345000015', name: 'Goodest Boy' },
                        { gln: '5012345000022', name: 'Tail Waggers' }
                    ]
                },
                status: 'ok',
                metadata: {
                    executionId: 'exec_1',
                    sourceFile: '/path/to/response.json'
                }
            };
            const view: ConsoleView = {
                name: 'ViewTest',
                rowBasis: 'data.data',
                columns: [
                    {
                        id: 'data',
                        source: 'nested',
                        groupType: 'object',
                        children: [
                            {
                                id: 'data.data',
                                source: 'nested',
                                groupType: 'array',
                                children: [
                                    { id: 'data.data.gln', source: 'current' },
                                    { id: 'data.data.name', source: 'current' }
                                ]
                            }
                        ]
                    },
                    { id: 'status', source: 'ancestor' },
                    {
                        id: 'metadata',
                        source: 'nested',
                        groupType: 'object',
                        children: [
                            { id: 'metadata.sourceFile', source: 'ancestor' }
                        ]
                    }
                ]
            };
            const rows = builder.extractRowsForView([response], view);
            expect(rows).to.have.lengthOf(2);
            for (const row of rows) {
                // Current leaves — populated from the rowObj (each data.data item)
                expect(row['data.data.gln']).to.be.a('string');
                expect(row['data.data.name']).to.be.a('string');
                // Top-level ancestor — populated from the response root
                expect(row['status']).to.equal('ok');
                // Sibling-wrapper descendant ancestor — must also be populated
                expect(row['metadata.sourceFile']).to.equal('/path/to/response.json');
            }
        });

        it('nested-array payload key is absolute even when rowBasis is not root', () => {
            const response = {
                data: {
                    lines: [
                        {
                            itemId: 'SKU-1',
                            taxes: [{ code: 'VAT' }, { code: 'ENV' }]
                        }
                    ]
                }
            };
            const view: ConsoleView = {
                name: 'PO Lines with Taxes',
                rowBasis: 'data.lines',
                columns: [
                    { id: 'data.lines.itemId', source: 'current' },
                    {
                        id: 'data.lines.taxes',
                        source: 'nested',
                        groupType: 'array',
                        children: [{ id: 'data.lines.taxes.code', source: 'current' }]
                    }
                ]
            };
            const rows = builder.extractRowsForView([response], view);
            expect(rows).to.have.lengthOf(1);
            // The expand-cell payload key is absolute, NOT rowBasis-prefixed.
            // This is what renderTable passes to renderExpandableArray as the
            // pathContext — the `+ New View` visibility check compares
            // pathContext to each saved view's rowBasis.
            expect(Object.keys(rows[0])).to.include('data.lines.taxes');
            expect(rows[0]['data.lines.taxes']).to.be.an('array');
        });

        // Phase 1B.14: real-world System-style response — sibling-branch
        // object ancestor (`data.Extended.AlreadyManifested`) + deep current
        // leaf inside the row (`data.OlpnDetail.EntityLabels.…PickTicketNo`).
        // Even when the persisted view tags those wrappers as `groupType:'array'`
        // (legacy ensureStructuralWrapper bug), populateRow's path-aware
        // safety guard must still recurse children correctly.
        it('renders sibling-branch object ancestors + deep current leaves through misclassified array wrappers', () => {
            const response = {
                data: [
                    {
                        ShipmentId: 'SHIP-A',
                        Extended: { AlreadyManifested: 'SENT' },
                        OlpnDetail: [
                            {
                                ItemId: 'ITM-A1',
                                EntityLabels: {
                                    InheritedLabels: {
                                        OrderLine: {
                                            Extended: { PickTicketNo: '422657' }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                ]
            };
            const view: ConsoleView = {
                name: 'Complex',
                rowBasis: 'data.OlpnDetail',
                columns: [
                    {
                        id: 'data',
                        source: 'nested',
                        groupType: 'array',
                        children: [
                            { id: 'data.ShipmentId', source: 'ancestor' },
                            // Sibling-branch object ancestor — but legacy
                            // classifier mis-tagged as 'array'. Children must
                            // still resolve via parentChain.
                            {
                                id: 'data.Extended',
                                source: 'nested',
                                groupType: 'array',
                                children: [
                                    { id: 'data.Extended.AlreadyManifested', source: 'ancestor' }
                                ]
                            },
                            {
                                id: 'data.OlpnDetail',
                                source: 'nested',
                                groupType: 'array',
                                children: [
                                    { id: 'data.OlpnDetail.ItemId', source: 'current' },
                                    // Deep current leaf — every wrapper on the
                                    // way down is mis-tagged as 'array' but
                                    // safety guard recurses children.
                                    {
                                        id: 'data.OlpnDetail.EntityLabels',
                                        source: 'nested',
                                        groupType: 'array',
                                        children: [{
                                            id: 'data.OlpnDetail.EntityLabels.InheritedLabels',
                                            source: 'nested',
                                            groupType: 'array',
                                            children: [{
                                                id: 'data.OlpnDetail.EntityLabels.InheritedLabels.OrderLine',
                                                source: 'nested',
                                                groupType: 'array',
                                                children: [{
                                                    id: 'data.OlpnDetail.EntityLabels.InheritedLabels.OrderLine.Extended',
                                                    source: 'nested',
                                                    groupType: 'array',
                                                    children: [
                                                        { id: 'data.OlpnDetail.EntityLabels.InheritedLabels.OrderLine.Extended.PickTicketNo', source: 'current' }
                                                    ]
                                                }]
                                            }]
                                        }]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            };
            const rows = builder.extractRowsForView([response], view);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0]['data.ShipmentId']).to.equal('SHIP-A');
            expect(rows[0]['data.Extended.AlreadyManifested']).to.equal('SENT');
            expect(rows[0]['data.OlpnDetail.ItemId']).to.equal('ITM-A1');
            expect(rows[0]['data.OlpnDetail.EntityLabels.InheritedLabels.OrderLine.Extended.PickTicketNo']).to.equal('422657');
        });

        // Phase 1B.16: rowBasis === 'root' with a top-level array wrapper
        // (e.g. body / data) selected — the wrapper must render as an
        // expand-cell, with the row carrying the array of projected items.
        it('produces expand-cell payload for top-level array when rowBasis is root', () => {
            const response = {
                success: true,
                data: [
                    { ShipmentId: 'SHIP-A', Messages: ['m1', 'm2'] },
                    { ShipmentId: 'SHIP-B', Messages: [] }
                ]
            };
            const view: ConsoleView = {
                name: 'Root view',
                rowBasis: 'root',
                columns: [
                    { id: 'success', source: 'current' },
                    {
                        id: 'data',
                        source: 'nested',
                        groupType: 'array',
                        children: [
                            { id: 'data.ShipmentId', source: 'current' },
                            { id: 'data.Messages',   source: 'current' }
                        ]
                    }
                ]
            };
            const rows = builder.extractRowsForView([response], view);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0].success).to.equal(true);
            expect(rows[0]['data']).to.be.an('array').with.lengthOf(2);
            const items = rows[0]['data'] as Array<Record<string, unknown>>;
            expect(items[0].ShipmentId).to.equal('SHIP-A');
            expect(items[1].ShipmentId).to.equal('SHIP-B');
        });

        // Phase 1B.13b: flattenNestedForExport must NOT touch nested-array
        // columns that are at or above rowBasis. extractRowsForView already
        // iterated them; flattening them again would clobber ancestor values.
        it('flattenNestedForExport leaves rows untouched when only top-level array is at-or-above rowBasis', () => {
            const response = {
                success: true,
                data: [
                    {
                        ShipmentId: 'SHIP-A',
                        LpnType: 'OLPN',
                        OlpnDetail: [
                            { ItemId: 'ITM-A1', PackedQuantity: 1 }
                        ]
                    }
                ]
            };
            const view: ConsoleView = {
                name: 'oLPN Detail (wrapped)',
                rowBasis: 'data.OlpnDetail',
                columns: [
                    {
                        id: 'data',
                        source: 'nested',
                        groupType: 'array',
                        children: [
                            { id: 'data.ShipmentId', source: 'ancestor' },
                            { id: 'data.LpnType',    source: 'ancestor' },
                            {
                                id: 'data.OlpnDetail',
                                source: 'nested',
                                groupType: 'array',
                                children: [
                                    { id: 'data.OlpnDetail.ItemId',         source: 'current' },
                                    { id: 'data.OlpnDetail.PackedQuantity', source: 'current' }
                                ]
                            }
                        ]
                    }
                ]
            };
            const raw = builder.extractRowsForView([response], view);
            const flat = builder.flattenNestedForExport(raw, view);
            expect(flat).to.have.lengthOf(1);
            // Both ancestors AND the OlpnDetail children must survive flatten.
            expect(flat[0]).to.deep.include({
                'data.ShipmentId':            'SHIP-A',
                'data.LpnType':               'OLPN',
                'data.OlpnDetail.ItemId':     'ITM-A1',
                'data.OlpnDetail.PackedQuantity': 1
            });
        });

        // Phase 1B.13: when rowBasis is at the second level of nesting and an
        // ancestor leaf lives outside the deepest array (e.g. ShipmentId on a
        // shipment that contains the OlpnDetail row-basis array), per-row
        // ancestor reads must resolve to the SPECIFIC parent — not the full
        // array of all parents.
        it('per-row ancestor resolves through the parentChain (cross-array)', () => {
            const response = {
                success: true,
                data: [
                    {
                        ShipmentId: 'SHIP-A',
                        OlpnDetail: [
                            { ItemId: 'ITM-A1', OlpnId: 'OLPN-A1' },
                            { ItemId: 'ITM-A2', OlpnId: 'OLPN-A2' }
                        ]
                    },
                    {
                        ShipmentId: 'SHIP-B',
                        OlpnDetail: [
                            { ItemId: 'ITM-B1', OlpnId: 'OLPN-B1' }
                        ]
                    }
                ]
            };
            const view: ConsoleView = {
                name: 'oLPN Detail',
                rowBasis: 'data.OlpnDetail',
                columns: [
                    { id: 'data.ShipmentId',         source: 'ancestor' },
                    { id: 'data.OlpnDetail.OlpnId',  source: 'current'  },
                    { id: 'data.OlpnDetail.ItemId',  source: 'current'  }
                ]
            };
            const rows = builder.extractRowsForView([response], view);
            expect(rows).to.have.lengthOf(3);
            expect(rows[0]).to.deep.include({
                'data.ShipmentId':       'SHIP-A',
                'data.OlpnDetail.OlpnId':'OLPN-A1',
                'data.OlpnDetail.ItemId':'ITM-A1'
            });
            expect(rows[1]).to.deep.include({
                'data.ShipmentId':       'SHIP-A',
                'data.OlpnDetail.OlpnId':'OLPN-A2',
                'data.OlpnDetail.ItemId':'ITM-A2'
            });
            expect(rows[2]).to.deep.include({
                'data.ShipmentId':       'SHIP-B',
                'data.OlpnDetail.OlpnId':'OLPN-B1',
                'data.OlpnDetail.ItemId':'ITM-B1'
            });
        });
    });

    // Phase 1B.15: adapter sample-aware. When wrappers inside the row are
    // mis-tagged 'array' (legacy ensureStructuralWrapper bug for paths that
    // cross arrays), the column adapter must fall back to recursing children
    // — and collapse single-child wrappers — so deep current leaves surface
    // as columns instead of being hidden behind an empty expand-cell header.
    describe('viewToLegacyColumnShape — sample-aware misclassification + single-child collapse', () => {
        it('collapses a deep single-child chain of mis-tagged array wrappers down to the leaf', () => {
            const sample = {
                data: [
                    {
                        OlpnDetail: [
                            {
                                EntityLabels: {
                                    InheritedLabels: {
                                        OrderLine: { Extended: { PickTicketNo: '422657' } }
                                    }
                                }
                            }
                        ]
                    }
                ]
            };
            const view: ConsoleView = {
                name: 'Deep',
                rowBasis: 'data.OlpnDetail',
                columns: [
                    {
                        id: 'data',
                        source: 'nested',
                        groupType: 'array',
                        children: [
                            {
                                id: 'data.OlpnDetail',
                                source: 'nested',
                                groupType: 'array',
                                children: [
                                    {
                                        id: 'data.OlpnDetail.EntityLabels',
                                        source: 'nested',
                                        groupType: 'array',  // misclassified
                                        children: [{
                                            id: 'data.OlpnDetail.EntityLabels.InheritedLabels',
                                            source: 'nested',
                                            groupType: 'array',
                                            children: [{
                                                id: 'data.OlpnDetail.EntityLabels.InheritedLabels.OrderLine',
                                                source: 'nested',
                                                groupType: 'array',
                                                children: [{
                                                    id: 'data.OlpnDetail.EntityLabels.InheritedLabels.OrderLine.Extended',
                                                    source: 'nested',
                                                    groupType: 'array',
                                                    children: [{
                                                        id: 'data.OlpnDetail.EntityLabels.InheritedLabels.OrderLine.Extended.PickTicketNo',
                                                        source: 'current'
                                                    }]
                                                }]
                                            }]
                                        }]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            };
            const cols: Array<Record<string, unknown>> = builder.viewToLegacyColumnShape(view, sample);
            // Deep wrapper chain collapsed — the leaf surfaces as a single
            // column at the top level. No 'EntityLabels' / 'OrderLine' /
            // 'Extended' group headers should appear.
            const ids = cols.map(c => c.id as string);
            expect(ids).to.include('data.OlpnDetail.EntityLabels.InheritedLabels.OrderLine.Extended.PickTicketNo');
            const groupHeaders = cols.filter(c => c.type === 'group');
            // No nested-only group headers should remain in the chain.
            for (const g of groupHeaders) {
                expect(g.id).to.not.match(/EntityLabels|InheritedLabels|OrderLine\b|Extended$/);
            }
        });

        it('preserves a genuine expand-cell array (sample says array)', () => {
            const sample = {
                data: { lines: [{ taxes: [{ amount: 1.5 }] }] }
            };
            const view: ConsoleView = {
                name: 'Lines + Taxes',
                rowBasis: 'data.lines',
                columns: [
                    {
                        id: 'data',
                        source: 'nested',
                        groupType: 'object',
                        children: [
                            {
                                id: 'data.lines',
                                source: 'nested',
                                groupType: 'array',
                                children: [
                                    {
                                        id: 'data.lines.taxes',
                                        source: 'nested',
                                        groupType: 'array',
                                        children: [{ id: 'data.lines.taxes.amount', source: 'current' }]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            };
            const cols: Array<Record<string, unknown>> = builder.viewToLegacyColumnShape(view, sample);
            const taxes = cols.find(c => c.id === 'data.lines.taxes');
            expect(taxes, 'genuine array wrapper survives as expand-cell').to.exist;
            expect(taxes!.type).to.equal('array');
        });
    });

    // Phase 1B.8 — same-name envelope wrapper elision. The RawResponse envelope
    // wraps the HTTP body in a `data` field; if the API itself returns
    // `{ data: [...] }`, the stored shape becomes `envelope.data.data = [...]`.
    // Users see that double-wrapper in three UI surfaces; viewToLegacyColumnShape
    // collapses it so the console renders a single column/group, NOT a group
    // wrapping a group.
    describe('viewToLegacyColumnShape — same-name envelope elision', () => {
        it('elides an object wrapper whose only child is a same-name array', () => {
            const view: ConsoleView = {
                name: 'Root',
                rowBasis: 'root',
                columns: [
                    {
                        id: 'data',
                        source: 'nested',
                        groupType: 'object',
                        children: [
                            {
                                id: 'data.data',
                                source: 'nested',
                                groupType: 'array',
                                children: [
                                    { id: 'data.data.gln', source: 'current' },
                                    { id: 'data.data.name', source: 'current' }
                                ]
                            }
                        ]
                    }
                ]
            };
            const cols = builder.viewToLegacyColumnShape(view);
            // The outer `data` object group is elided; the inner `data` array
            // surfaces as a single expand-cell leaf at top level.
            expect(cols).to.have.lengthOf(1);
            expect(cols[0].id).to.equal('data.data');
            expect(cols[0].type).to.equal('array');
            expect(cols[0].parent).to.equal(null);
        });

        it('object wrapper with mixed children collapses, surfacing leaves + array at top level', () => {
            // Phase 1B.15: The non-array `data` wrapper is no longer emitted
            // as a group header band. Its children (the `created` leaf and
            // the `data.data` expand-cell array) emerge flat at top level —
            // matches CSV shape and avoids deep multi-level header bands.
            const view: ConsoleView = {
                name: 'Root',
                rowBasis: 'root',
                columns: [
                    {
                        id: 'data',
                        source: 'nested',
                        groupType: 'object',
                        children: [
                            { id: 'data.created', source: 'current' },
                            {
                                id: 'data.data',
                                source: 'nested',
                                groupType: 'array',
                                children: [{ id: 'data.data.gln', source: 'current' }]
                            }
                        ]
                    }
                ]
            };
            const cols: Array<Record<string, unknown>> = builder.viewToLegacyColumnShape(view);
            // No `data` group emitted any more.
            expect(cols.find((c: Record<string, unknown>) => c.id === 'data' && c.type === 'group'),
                'outer data wrapper collapsed, no group header').to.equal(undefined);
            const leaf = cols.find((c: Record<string, unknown>) => c.id === 'data.created');
            expect(leaf, 'sibling leaf surfaces flat').to.exist;
            expect(leaf!.parent).to.equal(null);
            const arr = cols.find((c: Record<string, unknown>) => c.id === 'data.data');
            expect(arr, 'array expand-cell surfaces flat').to.exist;
            expect(arr!.type).to.equal('array');
            expect(arr!.parent).to.equal(null);
        });
    });

    // Issue #270a: when a response has no data at rowBasis, emit a placeholder
    // row so selected ancestor columns still show (detail cells blank), instead
    // of silently dropping the whole response.
    describe('Issue #270a — placeholder rows for empty rowBasis', () => {
        const ancestorView: ConsoleView = {
            name: 'Lines with header',
            rowBasis: 'data.lines',
            columns: [
                { id: 'data.header.id', source: 'ancestor' },
                { id: 'data.lines.itemId', source: 'current' }
            ]
        };

        it('emits a placeholder when the rowBasis path is missing entirely', () => {
            const response = { data: { header: { id: 'H1' } } }; // no lines
            const rows = builder.extractRowsForView([response], ancestorView);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0]['data.header.id']).to.equal('H1');
            expect(rows[0]['data.lines.itemId']).to.equal(undefined);
            expect(rows[0].__placeholder).to.equal(true);
        });

        it('emits a placeholder when the rowBasis array is empty', () => {
            const response = { data: { header: { id: 'H2' }, lines: [] } };
            const rows = builder.extractRowsForView([response], ancestorView);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0]['data.header.id']).to.equal('H2');
            expect(rows[0]['data.lines.itemId']).to.equal(undefined);
        });

        it('does NOT emit a placeholder when the view has no ancestor column', () => {
            const detailOnly: ConsoleView = {
                name: 'Detail only',
                rowBasis: 'data.lines',
                columns: [{ id: 'data.lines.itemId', source: 'current' }]
            };
            const rows = builder.extractRowsForView([{ data: { lines: [] } }], detailOnly);
            expect(rows).to.deep.equal([]);
        });

        it('mixes populated rows and placeholders across responses', () => {
            const populated = { data: { header: { id: 'H3' }, lines: [{ itemId: 'SKU-1' }] } };
            const empty = { data: { header: { id: 'H4' }, lines: [] } };
            const rows = builder.extractRowsForView([populated, empty], ancestorView);
            expect(rows).to.have.lengthOf(2);
            expect(rows[0]).to.deep.include({ 'data.header.id': 'H3', 'data.lines.itemId': 'SKU-1' });
            expect(rows[0].__placeholder).to.equal(undefined);
            expect(rows[1]['data.header.id']).to.equal('H4');
            expect(rows[1]['data.lines.itemId']).to.equal(undefined);
            expect(rows[1].__placeholder).to.equal(true);
        });

        it('forks one placeholder per surviving branch when an intermediate array is populated', () => {
            // rowBasis crosses data.shipments[] → details[]. Both shipments have
            // empty details, so the response yields no rows — but each shipment's
            // ancestor ShipmentId must survive on its own placeholder.
            const response = {
                data: {
                    shipments: [
                        { ShipmentId: 'S1', details: [] },
                        { ShipmentId: 'S2', details: [] }
                    ]
                }
            };
            const view: ConsoleView = {
                name: 'Shipment details',
                rowBasis: 'data.shipments.details',
                columns: [
                    { id: 'data.shipments.ShipmentId', source: 'ancestor' },
                    { id: 'data.shipments.details.sku', source: 'current' }
                ]
            };
            const rows = builder.extractRowsForView([response], view);
            expect(rows).to.have.lengthOf(2);
            expect(rows.map((r: any) => r['data.shipments.ShipmentId'])).to.deep.equal(['S1', 'S2']);
            expect(rows[0]['data.shipments.details.sku']).to.equal(undefined);
            expect(rows[1]['data.shipments.details.sku']).to.equal(undefined);
        });

        it('leaves root rowBasis untouched (every response yields a row already)', () => {
            const view: ConsoleView = {
                name: 'Root',
                rowBasis: 'root',
                columns: [{ id: 'status', source: 'current' }]
            };
            const rows = builder.extractRowsForView([{ status: 'ok' }], view);
            expect(rows).to.deep.equal([{ status: 'ok' }]);
        });
    });

    // Issue #270b: merge schema-picker trees across responses so fields that
    // only appear in some transactions (e.g. detail rows) become selectable.
    describe('Issue #270b — mergeSchemaTrees / collectNodeIds', () => {
        it('unions top-level leaves from two responses', () => {
            const a = [{ id: 'x', key: 'x', kind: 'leaf', valueType: 'string' }];
            const b = [{ id: 'y', key: 'y', kind: 'leaf', valueType: 'number' }];
            const merged = builder.mergeSchemaTrees(a, b);
            expect(merged.map((n: any) => n.id)).to.have.members(['x', 'y']);
        });

        it('merges children of a group seen in both responses', () => {
            const a = [{ id: 'data', key: 'data', kind: 'object', children: [
                { id: 'data.a', key: 'a', kind: 'leaf', valueType: 'string' }
            ] }];
            const b = [{ id: 'data', key: 'data', kind: 'object', children: [
                { id: 'data.b', key: 'b', kind: 'leaf', valueType: 'string' }
            ] }];
            const merged = builder.mergeSchemaTrees(a, b);
            expect(merged).to.have.lengthOf(1);
            expect(merged[0].children.map((n: any) => n.id)).to.have.members(['data.a', 'data.b']);
        });

        it('upgrades a leaf to a group when a later response has the richer form', () => {
            // First response had no detail rows: `lines` came back null → leaf.
            const a = [{ id: 'lines', key: 'lines', kind: 'leaf', valueType: 'null' }];
            const b = [{ id: 'lines', key: 'lines', kind: 'array', children: [
                { id: 'lines.sku', key: 'sku', kind: 'leaf', valueType: 'string' }
            ] }];
            const merged = builder.mergeSchemaTrees(a, b);
            expect(merged[0].kind).to.equal('array');
            expect(merged[0].children.map((n: any) => n.id)).to.deep.equal(['lines.sku']);
        });

        it('prefers the array form over object for the same field', () => {
            const a = [{ id: 'g', key: 'g', kind: 'object', children: [] }];
            const b = [{ id: 'g', key: 'g', kind: 'array', children: [] }];
            expect(builder.mergeSchemaTrees(a, b)[0].kind).to.equal('array');
        });

        it('collectNodeIds gathers leaves and groups recursively', () => {
            const nodes = [{ id: 'data', key: 'data', kind: 'array', children: [
                { id: 'data.sku', key: 'sku', kind: 'leaf', valueType: 'string' },
                { id: 'data.tax', key: 'tax', kind: 'object', children: [
                    { id: 'data.tax.rate', key: 'rate', kind: 'leaf', valueType: 'number' }
                ] }
            ] }];
            const ids = builder.collectNodeIds(nodes);
            expect([...ids]).to.have.members(['data', 'data.sku', 'data.tax', 'data.tax.rate']);
        });
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #288 — plain {{A8:sequence}} follows one rule everywhere:
 * one number per object scope. Every occurrence in the request root shares a
 * number; every occurrence in one array element shares a number; each new
 * scope takes the next number. Checked through the real generator paths,
 * not just the parser.
 */

import { expect } from 'chai';
import { JsonGenerator } from '../../../data-loading/json-generator';

const ENDPOINT_ID = 'ep-1';

function makeEndpointManager(startAt = 21) {
    const state = { sequenceCounter: startAt, arraySequenceCounters: {} as Record<string, number> };
    return {
        state,
        getEndpoint: async () => ({
            id: ENDPOINT_ID,
            sequenceCounter: state.sequenceCounter,
            arraySequenceCounters: { ...state.arraySequenceCounters }
        }),
        getNextSequence: async () => ++state.sequenceCounter,
        getNextArraySequence: async (_id: string, path: string) => {
            state.arraySequenceCounters[path] = (state.arraySequenceCounters[path] || 0) + 1;
            return state.arraySequenceCounters[path];
        }
    };
}

const num = (value: unknown) => Number(String(value).replace(/\D/g, ''));

describe('A8:sequence scope through the generator (#288)', () => {
    it('1-level: root shares one number, each line shares its own', async () => {
        const manager = makeEndpointManager(21);
        const generator = new JsonGenerator(manager as never);

        const template = JSON.stringify({
            dest: '{{dest}}',
            OriginalOrderId: '{{A8:sequence}}',
            Extended: { GPCMessageID: 'DBMN-000009{{A8:sequence}}' },
            OriginalOrderLine: [{
                item: '{{item}}',
                Extended: { PickTicketLineNo: '{{A8:sequence}}' },
                ReferenceOrderLine: '{{A8:sequence}}'
            }]
        });

        const result = await generator.generateBatchJsonFiles('dest,item\nNYC,A1\nNYC,A2', {
            template,
            headers: ['dest', 'item'],
            mappings: [
                { variable: 'dest', column: 'dest', dataType: 'string' },
                { variable: 'item', column: 'item', dataType: 'string' }
            ],
            repeatableArrays: [{ arrayPath: 'OriginalOrderLine', enabled: true, maxRepetitions: 100 }],
            endpointId: ENDPOINT_ID
        } as never);

        expect(result.success, result.error).to.equal(true);
        const order = result.files[0].content;
        const lines = order.OriginalOrderLine;
        const seen = {
            root: [num(order.OriginalOrderId), num(order.Extended.GPCMessageID.replace('DBMN-000009', ''))],
            line1: [num(lines[0].Extended.PickTicketLineNo), num(lines[0].ReferenceOrderLine)],
            line2: [num(lines[1].Extended.PickTicketLineNo), num(lines[1].ReferenceOrderLine)]
        };

        expect(seen.root[0], JSON.stringify(seen)).to.equal(seen.root[1]);
        expect(seen.line1[0], JSON.stringify(seen)).to.equal(seen.line1[1]);
        expect(seen.line2[0], JSON.stringify(seen)).to.equal(seen.line2[1]);
        expect(new Set([seen.root[0], seen.line1[0], seen.line2[0]]).size, JSON.stringify(seen)).to.equal(3);
    });

    it('2-level: each order shares its own number, each item shares its own', async () => {
        const manager = makeEndpointManager(21);
        const generator = new JsonGenerator(manager as never);

        const template = JSON.stringify({
            orders: [{
                po: '{{PO}}',
                orderSeq: '{{A8:sequence}}',
                orderSeqAgain: '{{A8:sequence}}',
                items: [{
                    item: '{{Item}}',
                    lineSeq: '{{A8:sequence}}',
                    lineSeqAgain: '{{A8:sequence}}'
                }]
            }]
        });

        const result = await generator.generateBatchJsonFiles('PO,Item\n100,A1\n100,A2\n200,B1', {
            template,
            headers: ['PO', 'Item'],
            mappings: [
                { variable: 'PO', column: 'PO', dataType: 'string' },
                { variable: 'Item', column: 'Item', dataType: 'string' }
            ],
            repeatableArrays: [{ arrayPath: 'orders', enabled: true, maxRepetitions: 100 }],
            endpointId: ENDPOINT_ID
        } as never);

        expect(result.success, result.error).to.equal(true);
        const orders = result.files[0].content.orders;
        const seen = orders.map((o: any) => ({
            order: [o.orderSeq, o.orderSeqAgain],
            items: o.items.map((i: any) => [i.lineSeq, i.lineSeqAgain])
        }));
        const detail = JSON.stringify(seen);

        for (const o of seen) {
            expect(o.order[0], detail).to.equal(o.order[1]);
            for (const pair of o.items) {
                expect(pair[0], detail).to.equal(pair[1]);
            }
        }
        expect(seen[0].order[0], detail).to.not.equal(seen[1].order[0]);
        expect(seen[0].items[0][0], detail).to.not.equal(seen[0].items[1][0]);
    });

    it('consolidated repetition: each item shares its own number and uses the saved counter', async () => {
        const manager = makeEndpointManager(21);
        const generator = new JsonGenerator(manager as never);

        const template = JSON.stringify({
            items: [{ sku: '{{SKU}}', a: '{{A8:sequence}}', b: '{{A8:sequence}}' }]
        });

        const result = await (generator as any).generateConsolidatedJson(['A1', 'A2'], {
            template,
            headers: ['SKU'],
            mappings: [{ variable: 'SKU', column: 'SKU', dataType: 'string' }],
            repeatableArrays: [{ arrayPath: 'items', enabled: true, maxRepetitions: 100 }],
            endpointId: ENDPOINT_ID,
            sequenceStartValue: 1001,
            isBatchExecution: true
        });

        expect(result.success, result.error).to.equal(true);
        const json = typeof result.jsonData === 'string' ? JSON.parse(result.jsonData) : result.jsonData;
        const pairs = json.items.map((i: any) => [i.a, i.b]);
        const detail = JSON.stringify({ pairs, counter: manager.state.sequenceCounter });

        expect(pairs[0][0], detail).to.equal(pairs[0][1]);
        expect(pairs[1][0], detail).to.equal(pairs[1][1]);
        expect(pairs[0][0], detail).to.not.equal(pairs[1][0]);
        expect(manager.state.sequenceCounter, `saved counter never advanced: ${detail}`).to.be.greaterThan(21);
    });

    it('3-level: shipments, packages and items each share their own number and use the saved counter', async () => {
        const manager = makeEndpointManager(21);
        const generator = new JsonGenerator(manager as never);

        const template = JSON.stringify({
            shipments: [{
                shipmentId: '{{ShipmentID}}',
                shipSeq: '{{A8:sequence}}',
                shipSeqAgain: '{{A8:sequence}}',
                packages: [{
                    packageId: '{{PackageID}}',
                    pkgSeq: '{{A8:sequence}}',
                    pkgSeqAgain: '{{A8:sequence}}',
                    items: [{
                        sku: '{{SKU}}',
                        itemSeq: '{{A8:sequence}}',
                        itemSeqAgain: '{{A8:sequence}}'
                    }]
                }]
            }]
        });

        const csv = [
            'ShipmentID,PackageID,SKU',
            'SH1,PKG-A1,S1',
            'SH1,PKG-A1,S2',
            'SH1,PKG-A2,S3',
            'SH2,PKG-B1,S4'
        ].join('\n');

        const result = await generator.generateBatchJsonFiles(csv, {
            template,
            headers: ['ShipmentID', 'PackageID', 'SKU'],
            mappings: [
                { variable: 'ShipmentID', column: 'ShipmentID', dataType: 'string' },
                { variable: 'PackageID', column: 'PackageID', dataType: 'string' },
                { variable: 'SKU', column: 'SKU', dataType: 'string' }
            ],
            repeatableArrays: [],
            endpointId: ENDPOINT_ID
        } as never);

        expect(result.success, result.error).to.equal(true);
        const shipments = result.files[0].content.shipments;
        const scopes: number[] = [];
        const detail = JSON.stringify(shipments.map((s: any) => ({
            ship: [s.shipSeq, s.shipSeqAgain],
            packages: s.packages.map((p: any) => ({
                pkg: [p.pkgSeq, p.pkgSeqAgain],
                items: p.items.map((i: any) => [i.itemSeq, i.itemSeqAgain])
            }))
        })));

        for (const s of shipments) {
            expect(s.shipSeq, detail).to.equal(s.shipSeqAgain);
            scopes.push(s.shipSeq);
            for (const p of s.packages) {
                expect(p.pkgSeq, detail).to.equal(p.pkgSeqAgain);
                scopes.push(p.pkgSeq);
                for (const i of p.items) {
                    expect(i.itemSeq, detail).to.equal(i.itemSeqAgain);
                    scopes.push(i.itemSeq);
                }
            }
        }

        // 2 shipments + 3 packages + 4 items = 9 scopes, 9 different numbers
        expect(new Set(scopes).size, detail).to.equal(9);
        expect(manager.state.sequenceCounter, `saved counter never advanced: ${detail}`).to.be.greaterThan(21);
    });
});

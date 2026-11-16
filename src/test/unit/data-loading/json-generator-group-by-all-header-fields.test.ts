// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Grouping rule for nested (header + lines) templates.
 *
 * WAS: a new request started when the FIRST header variable changed — template order,
 * nothing else. Rows that agreed on that one column were folded into one request even when
 * another header field differed, and the request silently took the first row's values:
 * a PO delivered to two sites became one order for the first site; a template with
 * `buyerName` above `supplierName` put every supplier's lines on one order. No error.
 *
 * NOW (decided 2026-09-17): a new request starts when ANY header variable changes. The
 * header of a request is a fact about every line in it, so rows whose headers differ are
 * different requests. Template order no longer changes the answer.
 *
 * Deliberate details:
 *  - values are compared trimmed — "Acme " and "Acme" are the same header; case is kept,
 *    so "ACME" is a different one, visibly, rather than being filed under "Acme";
 *  - generated (A8) and environment (ENV) variables are not part of the key;
 *  - rows do not have to arrive sorted: equal headers are gathered wherever they sit;
 *  - requests come out sorted by their header columns (GitHub Issue #147's auto-sort, now on
 *    every header column), which keeps each request's rows contiguous for the Input tab.
 */
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { JsonGenerator } from '../../../data-loading/json-generator';

async function run(template: string, csvLines: string[], arrayPath: string): Promise<any[]> {
    const headers = csvLines[0].split(',');
    const result = await new JsonGenerator().generateBatchJsonFiles(csvLines.join('\n'), {
        template, headers,
        mappings: headers.map(h => ({ variable: h, column: h, dataType: 'string' })),
        repeatableArrays: [{ arrayPath, enabled: true, maxRepetitions: 1000 }],
        environmentVariables: { org: 'ORG-1' }
    } as any);
    expect(result.success, result.error).to.equal(true);
    return result.files.map(f => f.content);
}

const skus = (req: any, key = 'lines') => req[key].map((l: any) => l.sku);

describe('JsonGenerator — a new request for ANY header field that changes', () => {
    it('same PO number, two delivery sites → two orders, not one order for the first site', async () => {
        const out = await run(
            '{ "poNumber": "{{poNumber}}", "shipTo": "{{shipTo}}", "lines": [ { "sku": "{{sku}}" } ] }',
            ['poNumber,shipTo,sku', 'PO-1,Atlanta,SKU-A', 'PO-1,Atlanta,SKU-B', 'PO-1,Boston,SKU-C'],
            'lines');
        expect(out).to.have.lengthOf(2);
        expect(out[0]).to.include({ poNumber: 'PO-1', shipTo: 'Atlanta' });
        expect(skus(out[0])).to.deep.equal(['SKU-A', 'SKU-B']);
        expect(out[1]).to.include({ poNumber: 'PO-1', shipTo: 'Boston' });
        expect(skus(out[1])).to.deep.equal(['SKU-C']);
    });

    it('template order no longer matters: buyerName above supplierName still gives one order per supplier', async () => {
        const out = await run(
            '{ "buyerName": "{{buyerName}}", "supplierName": "{{supplierName}}", "lines": [ { "sku": "{{sku}}" } ] }',
            ['buyerName,supplierName,sku', 'Golden DC,Wagmore,SKU-A', 'Golden DC,Boop,SKU-B', 'Golden DC,Wagmore,SKU-C', 'Golden DC,K9,SKU-D'],
            'lines');
        expect(out).to.have.lengthOf(3);
        const bySupplier = Object.fromEntries(out.map(o => [o.supplierName, skus(o)]));
        expect(bySupplier).to.deep.equal({ Wagmore: ['SKU-A', 'SKU-C'], Boop: ['SKU-B'], K9: ['SKU-D'] });
    });

    it('gathers equal headers that are not next to each other; requests come out sorted by header', async () => {
        const out = await run(
            '{ "po": "{{po}}", "site": "{{site}}", "lines": [ { "sku": "{{sku}}" } ] }',
            ['po,site,sku', 'PO-2,X,S1', 'PO-1,X,S2', 'PO-2,X,S3', 'PO-1,Y,S4', 'PO-1,X,S5'],
            'lines');
        expect(out.map(o => `${o.po}/${o.site}:${skus(o).join('+')}`))
            .to.deep.equal(['PO-1/X:S2+S5', 'PO-1/Y:S4', 'PO-2/X:S1+S3']);
    });

    it('rows whose headers all agree still make ONE request — nothing changes for consistent data', async () => {
        const out = await run(
            '{ "po": "{{po}}", "site": "{{site}}", "status": "{{status}}", "lines": [ { "sku": "{{sku}}" } ] }',
            ['po,site,status,sku', 'PO-1,X,open,S1', 'PO-1,X,open,S2', 'PO-2,Y,open,S3'],
            'lines');
        expect(out.map(o => skus(o))).to.deep.equal([['S1', 'S2'], ['S3']]);
    });

    it('compares trimmed values but keeps case: "Acme " joins "Acme", "ACME" does not', async () => {
        const out = await run(
            '{ "po": "{{po}}", "supplier": "{{supplier}}", "lines": [ { "sku": "{{sku}}" } ] }',
            ['po,supplier,sku', 'PO-7,Acme,S1', 'PO-7,Acme ,S2', 'PO-7,ACME,S3'],
            'lines');
        expect(out.map(o => `${o.supplier}:${skus(o).join('+')}`)).to.deep.equal(['Acme:S1+S2', 'ACME:S3']);
    });

    it('a blank optional header field is a different header from a filled one', async () => {
        const out = await run(
            '{ "po": "{{po}}", "note": "{{note:string|opt}}", "lines": [ { "sku": "{{sku}}" } ] }',
            ['po,note,sku', 'PO-1,rush,S1', 'PO-1,,S2', 'PO-1,rush,S3'],
            'lines');
        expect(out).to.have.lengthOf(2);
        const rush = out.find(o => o.note === 'rush');
        const plain = out.find(o => !('note' in o));
        expect(skus(rush)).to.deep.equal(['S1', 'S3']);
        expect(skus(plain)).to.deep.equal(['S2']);
    });

    it('generated and environment values are not part of the header key', async () => {
        const out = await run(
            '{ "id": "PO-{{A8:sequence}}", "org": "{{ENV:org}}", "supplier": "{{supplier}}", "lines": [ { "n": "{{A8:sequence:local}}", "sku": "{{sku}}" } ] }',
            ['supplier,sku', 'Wagmore,S1', 'Wagmore,S2', 'Boop,S3'],
            'lines');
        expect(out).to.have.lengthOf(2);
        const wagmore = out.find(o => o.supplier === 'Wagmore');
        const boop = out.find(o => o.supplier === 'Boop');
        expect(wagmore.org).to.equal('ORG-1');
        expect(wagmore.lines.map((l: any) => l.n)).to.deep.equal([1, 2]);
        expect(boop.lines.map((l: any) => l.n)).to.deep.equal([1]);
        expect(wagmore.id).to.not.equal(boop.id);
    });

    it('a header variable mapped to a differently named column groups on that column', async () => {
        const csv = ['location.name,product.supplier.name,sku', 'Golden DC,Wagmore,S1', 'Golden DC,Boop,S2', 'Golden DC,Wagmore,S3'];
        const headers = csv[0].split(',');
        const result = await new JsonGenerator().generateBatchJsonFiles(csv.join('\n'), {
            template: '{ "buyerName": "{{buyerName}}", "supplierName": "{{supplierName}}", "lines": [ { "sku": "{{sku}}" } ] }',
            headers,
            mappings: [
                { variable: 'buyerName', column: 'location.name', dataType: 'string' },
                { variable: 'supplierName', column: 'product.supplier.name', dataType: 'string' },
                { variable: 'sku', column: 'sku', dataType: 'string' }
            ],
            repeatableArrays: [{ arrayPath: 'lines', enabled: true, maxRepetitions: 1000 }],
            environmentVariables: {}
        } as any);
        expect(result.success, result.error).to.equal(true);
        expect(result.files.map(f => `${f.content.supplierName}:${skus(f.content).join('+')}`))
            .to.deep.equal(['Boop:S2', 'Wagmore:S1+S3']);
    });
});

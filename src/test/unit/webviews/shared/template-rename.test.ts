// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require('../../../../webviews/shared/template-rename');

// Run Batch "Update Endpoint Template" (#307): rename template variables to their columns.
const LESSON_BODY = `{
  "poNumber": "PO-REPLEN-{{A8:sequence}}",
  "buyerGln": "{{buyerGln:string}}", //5012345000039
  "supplierGln": "{{supplierGln:string}}", //4012345000054
  "lines": [
    {
      "gtin": "{{gtin:string}}", //00012345600081
      "lineNumber": "{{A8:sequence:local}}",
      "orderedQty": "{{orderedQty:number}}", //404
      "supplierSku": "{{supplierSku:string|opt}}" //KP-0004
    }
  ]
}`;

describe('TemplateRename', () => {
    it('makes a column name into a variable name', () => {
        expect(T.variableNameForColumn('location.gln')).to.equal('location.gln');
        expect(T.variableNameForColumn('product.supplier.gln')).to.equal('product.supplier.gln');
        expect(T.variableNameForColumn('reorderQty')).to.equal('reorderQty');
        expect(T.variableNameForColumn('Unit Price ($)')).to.equal('Unit_Price');
        expect(T.variableNameForColumn('2nd line')).to.equal('_2nd_line');
        expect(T.variableNameForColumn('...')).to.equal(null);
    });

    it('offers a rename only where the mapped column has a different name', () => {
        expect(T.renamesForMappings([
            { name: 'buyerGln', mappedTo: 'location.gln' },
            { name: 'orderedQty', mappedTo: 'reorderQty' },
            { name: 'gtin', mappedTo: 'gtin' },
            { name: 'supplierSku', mappedTo: null },
            { name: 'A8:sequence', mappedTo: 'x' }
        ])).to.deep.equal({ buyerGln: 'location.gln', orderedQty: 'reorderQty' });
    });

    it('never gives two variables one name', () => {
        expect(T.renamesForMappings([
            { name: 'buyerGln', mappedTo: 'gln' },
            { name: 'supplierGln', mappedTo: 'gln' }
        ])).to.deep.equal({ buyerGln: 'gln' });
        expect(T.renamesForMappings([
            { name: 'a', mappedTo: 'b' },
            { name: 'b', mappedTo: 'c' }
        ]), 'a new name another variable already has').to.deep.equal({ b: 'c' });
    });

    it('renames explicit variables, keeping type, modifiers and comments; A8 is untouched', () => {
        const out = T.renameVariablesInText(LESSON_BODY, { buyerGln: 'location.gln', orderedQty: 'reorderQty', supplierSku: 'product.supplierSku' });
        expect(out).to.include('"buyerGln": "{{location.gln:string}}", //5012345000039');
        expect(out).to.include('"orderedQty": "{{reorderQty:number}}", //404');
        expect(out).to.include('"supplierSku": "{{product.supplierSku:string|opt}}" //KP-0004');
        expect(out).to.include('{{A8:sequence}}');
        expect(out).to.include('{{A8:sequence:local}}');
        expect(out).to.include('"supplierGln": "{{supplierGln:string}}"');
    });

    it('renames shorthand variables, which take their name from the key', () => {
        expect(T.renameVariablesInText('{ "qty": "{{:number}}", "sku": "{{}}", "x": {{:number}} }', { qty: 'reorderQty', sku: 'item', x: 'y' }))
            .to.equal('{ "qty": "{{reorderQty:number}}", "sku": "{{item}}", "x": {{y:number}} }');
    });

    it('renames a whole endpoint, and moves its remembered mapping to the new names', () => {
        const out = T.renameInEndpoint({
            body: '{"b":"{{buyerGln}}"}', bodyWithComments: '{"b":"{{buyerGln}}" //x\n}', path: '/orders/{{buyerGln}}',
            queryParams: { site: '{{buyerGln}}' }, headers: { 'X-Site': { value: '{{buyerGln}}', enabled: true } },
            dataLoadingConfig: { jsonTemplate: '{"b":"{{buyerGln}}"}', columnMappings: { buyerGln: 'location.gln', gtin: 'gtin' } }
        }, { buyerGln: 'location.gln' });
        expect(out.body).to.equal('{"b":"{{location.gln}}"}');
        expect(out.bodyWithComments).to.equal('{"b":"{{location.gln}}" //x\n}');
        expect(out.path).to.equal('/orders/{{location.gln}}');
        expect(out.queryParams.site).to.equal('{{location.gln}}');
        expect(out.headers['X-Site']).to.deep.equal({ value: '{{location.gln}}', enabled: true });
        expect(out.dataLoadingConfig.jsonTemplate).to.equal('{"b":"{{location.gln}}"}');
        expect(out.dataLoadingConfig.columnMappings).to.deep.equal({ 'location.gln': 'location.gln', gtin: 'gtin' });
    });

    it('loose names ignore case and punctuation', () => {
        expect(T.looseName('location.gln')).to.equal(T.looseName('Location.GLN'));
        expect(T.looseName('product_supplier_gln')).to.equal(T.looseName('product.supplier.gln'));
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { TemplateParser } from '../../../data-loading/template-parser';
import { JsonGenerator } from '../../../data-loading/json-generator';

/**
 * A variable may be named after a dotted source column: `{{location.gln}}`, the column the
 * Console's Copy heads `location.gln`. Run Batch's "Update Endpoint Template" (#307/#308)
 * renames variables to exactly their column, so these names must work end to end.
 */
const TEMPLATE = JSON.stringify({
    buyerGln: '{{location.gln:string}}',
    supplierGln: '{{product.supplier.gln:string}}',
    poNumber: 'PO-{{A8:sequence}}',
    lines: [{ gtin: '{{gtin:string}}', orderedQty: '{{product.reorderQty:number}}', supplierSku: '{{product.supplierSku:string|opt}}' }]
});

describe('Dotted variable names', () => {
    it('TemplateParser.extractVariables keeps them', () => {
        const names = new TemplateParser().extractVariables(TEMPLATE).map(v => v.name);
        expect(names).to.include.members(['location.gln', 'product.supplier.gln', 'gtin', 'product.reorderQty', 'product.supplierSku']);
    });

    it('a name still cannot start with a digit or a dot', () => {
        const parser = new TemplateParser();
        expect(parser.isValidVariableName('location.gln')).to.equal(true);
        expect(parser.isValidVariableName('1st.column')).to.equal(false);
        expect(parser.isValidVariableName('.gln')).to.equal(false);
    });

    it('an unmapped optional dotted variable is left out, not sent as literal text', async () => {
        const headers = ['location.gln', 'product.supplier.gln', 'gtin', 'product.reorderQty'];
        const result = await new JsonGenerator().generateBatchJsonFiles(
            headers.join(',') + '\n0614141000012,4012345000030,00012345600081,100',
            { template: TEMPLATE, headers, mappings: headers.map(h => ({ variable: h, column: h, dataType: 'string' })),
              repeatableArrays: [{ arrayPath: 'lines', enabled: true, maxRepetitions: 1000 }], environmentVariables: {} });
        expect(result.success, result.error).to.equal(true);
        const order = result.files[0].content;
        expect(order.buyerGln).to.equal('0614141000012');
        expect(order.lines[0]).to.deep.equal({ gtin: '00012345600081', orderedQty: 100 });
    });
});

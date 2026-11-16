// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { bodyContainerPath, extractBatchTemplateVariables } from '../../../../webviews/run-batch/batch-template-variables';

// Map & Transform groups rows by where each variable is used. Batch used to send no
// location at all, so every row said "Used in: Body", URL and header variables included.

describe('Run Batch template variables — locations', () => {
    it('reduces a body path to the object or array holding the value', () => {
        expect(bodyContainerPath('buyerGln')).to.equal('');
        expect(bodyContainerPath('order.shipTo.gln')).to.equal('order.shipTo');
        expect(bodyContainerPath('lines[0].sku')).to.equal('lines[]');
        expect(bodyContainerPath('lines[3].flags[1]')).to.equal('lines[].flags[]');
        expect(bodyContainerPath('[0].sku')).to.equal('[]');
    });

    it('tags each variable with its sources and body container', () => {
        const variables = extractBatchTemplateVariables({
            path: '/orders/{{orderId}}',
            queryParams: { page: { value: '{{page:number}}', enabled: true } },
            headers: { 'X-Tenant': '{{tenant}}', Authorization: 'Bearer {{ENV:token}}' },
            body: `{
                "buyerGln": "{{buyerGln}}",
                "lines": [ { "sku": "{{sku}}", "qty": {{qty:number}} } ],
                "ref": "{{orderId}}",
                "made": "{{A8:datetime}}"
            }`
        });
        const byName = Object.fromEntries(variables.map(v => [v.name, v]));

        expect(variables.map(v => v.name)).to.deep.equal(['buyerGln', 'sku', 'qty', 'orderId', 'page', 'tenant']);
        expect(byName.buyerGln).to.include({ bodyPath: '' });
        expect(byName.sku).to.include({ bodyPath: 'lines[]' });
        expect(byName.qty).to.include({ bodyPath: 'lines[]', dataType: 'number' });
        expect(byName.orderId.sources).to.deep.equal(['body', 'url']);
        expect(byName.page.sources).to.deep.equal(['query_param:page']);
        expect(byName.page.dataType).to.equal('number');
        expect(byName.tenant.sources).to.deep.equal(['header:X-Tenant']);
        expect(byName.tenant.bodyPath).to.equal(undefined);
    });
});

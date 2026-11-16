// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Sort columns follow the grouping rule — against the REAL CSVSortingService.
 *
 * (csv-sorting.service.test.ts exercises a hand-copied CSVSortingTestHelper rather than the
 * service, so it cannot see changes to the shipping code. These tests import the service.)
 *
 * A new request — or a new element of an outer array — starts when ANY input variable at
 * that level changes (JsonGenerator.groupingColumnsFor). The Run Batch flow sorts the file
 * with the columns returned here before it groups, so they have to be the same columns:
 * every variable at each non-leaf level, outermost level first, in template order.
 */
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { CSVSortingService } from '../../../../services/csv-sorting/csv-sorting.service';

describe('CSVSortingService — sort columns follow the grouping rule', () => {
    const service = new CSVSortingService();

    it('sorts on EVERY header variable, not just the first', () => {
        const template = `{
            "poNumber": "PO-{{A8:sequence}}",
            "org": "{{ENV:org}}",
            "buyerName": "{{buyerName}}",
            "supplierName": "{{supplierName:string}}",
            "shipTo": { "site": "{{site}}" },
            "lines": [ { "sku": "{{sku}}", "qty": "{{qty:number}}" } ]
        }`;

        const result = service.analyzeNestedArrayRequirements(template, ['buyerName', 'supplierName', 'site', 'sku', 'qty']);

        expect(result.requiresSorting).to.equal(true);
        // Generated (A8) and environment (ENV) values are not data; the lines never sort.
        expect(result.sortColumns).to.deep.equal(['buyerName', 'supplierName', 'site']);
    });

    it('sorts on every variable of each non-leaf array level, outermost first', () => {
        const template = `{
            "company": "{{company}}",
            "shipments": [ {
                "shipmentId": "{{shipmentId}}",
                "carrier": "{{carrier}}",
                "items": [ { "sku": "{{sku}}" } ]
            } ]
        }`;

        const result = service.analyzeNestedArrayRequirements(template, ['company', 'shipmentId', 'carrier', 'sku']);

        expect(result.sortColumns).to.deep.equal(['company', 'shipmentId', 'carrier']);
    });

    it('returns the mapped CSV column for each variable, without duplicates', () => {
        const template = `{
            "buyerName": "{{buyerName}}",
            "supplierName": "{{supplierName}}",
            "lines": [ { "sku": "{{sku}}" } ]
        }`;

        const result = service.analyzeNestedArrayRequirements(
            template,
            ['buyerName', 'supplierName', 'sku'],
            { buyerName: 'location.name', supplierName: 'product.supplier.name', sku: 'sku' }
        );

        expect(result.sortColumns).to.deep.equal(['location.name', 'product.supplier.name']);
    });

    it('a single-header template sorts exactly as it always did', () => {
        const template = `{ "orderId": "{{ORDER_ID}}", "items": [ { "sku": "{{SKU}}" } ] }`;

        const result = service.analyzeNestedArrayRequirements(template, ['ORDER_ID', 'SKU']);

        expect(result.sortColumns).to.deep.equal(['ORDER_ID']);
    });
});

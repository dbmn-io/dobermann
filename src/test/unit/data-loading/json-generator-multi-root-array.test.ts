// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Regression tests for GitHub Issue #279:
 * Nested array not detected when a template has MULTIPLE root-level arrays
 * and the FIRST one is all-static (no {{variables}}).
 *
 * Real-world example: "Create ASN 01" template has two root arrays —
 * AsnRequestedService (all static) appears before AsnLine (the array that
 * actually varies per CSV row). Previously analyzeNestedArrays only inspected
 * the first root array, found no per-item variables, and bailed out — so the
 * whole template fell back to one-file-per-row generation and batch rows were
 * never grouped by AsnId.
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { JsonGenerator } from '../../../data-loading/json-generator';

describe('JsonGenerator - Multiple root arrays (GitHub Issue #279)', () => {
    let jsonGenerator: JsonGenerator;

    // Trimmed-down version of the real "Create ASN 01" template that preserves
    // every quirk from the issue: a static array first, a variable-bearing array
    // second, a nested Extended object, and an empty {{}} shorthand variable.
    const asnTemplate = JSON.stringify({
        PreDeterminedLpnCount: 20,
        AsnId: '{{AsnId}}',
        VendorId: '{{VendorId}}',
        Extended: {
            Host: 'ACAU',
            CartonASN: false
        },
        AsnRequestedService: [
            {
                ServiceUomId: 'ASN',
                Sequence: 1,
                ProvidedServiceId: 'GPC_Initial_InboundTracking'
            }
        ],
        AsnLine: [
            {
                PurchaseOrderId: '{{POId}}',
                Extended: {
                    ReceiverLineNo: '00000{{POLineId}}'
                },
                AsnLineId: '00000{{POLineId}}',
                ItemId: '{{SKU}}',
                ShippedQuantity: '{{}}'
            }
        ]
    });

    beforeEach(() => {
        jsonGenerator = new JsonGenerator();
    });

    it('should detect the variable-bearing root array as the grouping array', () => {
        const analysis = (jsonGenerator as any).analyzeNestedArrays(asnTemplate);

        expect(analysis.hasNestedArrays, 'expected nested/grouping detection').to.be.true;
        expect(analysis.nestingLevel).to.equal(1);
        // AsnLine is the array that varies per row — NOT the static AsnRequestedService
        expect(analysis.outerArray).to.equal('AsnLine');
        expect(analysis.innerArray).to.equal('AsnLine');
        expect(analysis.outerVariables).to.include.members(['AsnId', 'VendorId']);
    });

    it('should group rows with the same AsnId into a single transaction, one file per ASN', async () => {
        // Two ASNs: ASN-1 has two lines, ASN-2 has one line
        const csvData =
            'AsnId,VendorId,POId,POLineId,SKU,ShippedQuantity\n' +
            'ASN-1,V100,PO-1,1,SKU-A,10\n' +
            'ASN-1,V100,PO-1,2,SKU-B,20\n' +
            'ASN-2,V200,PO-2,1,SKU-C,30';

        const options = {
            template: asnTemplate,
            headers: ['AsnId', 'VendorId', 'POId', 'POLineId', 'SKU', 'ShippedQuantity'],
            mappings: [
                { variable: 'AsnId', column: 'AsnId', dataType: 'string' },
                { variable: 'VendorId', column: 'VendorId', dataType: 'string' },
                { variable: 'POId', column: 'POId', dataType: 'string' },
                { variable: 'POLineId', column: 'POLineId', dataType: 'string' },
                { variable: 'SKU', column: 'SKU', dataType: 'string' },
                { variable: 'ShippedQuantity', column: 'ShippedQuantity', dataType: 'string' }
            ],
            repeatableArrays: [{ arrayPath: 'AsnLine', enabled: true, maxRepetitions: 100 }]
        };

        const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

        expect(result.success, result.error).to.be.true;
        // 2 unique ASNs → 2 files (NOT 3 files, one per row)
        expect(result.files).to.have.lengthOf(2);

        // Files are auto-sorted by AsnId: ASN-1 then ASN-2
        const asn1 = result.files[0].content;
        expect(asn1.AsnId).to.equal('ASN-1');
        expect(asn1.VendorId).to.equal('V100');
        expect(asn1.AsnLine).to.have.lengthOf(2);
        expect(asn1.AsnLine[0].ItemId).to.equal('SKU-A');
        expect(asn1.AsnLine[1].ItemId).to.equal('SKU-B');
        // Empty {{}} shorthand resolves from the ShippedQuantity column
        expect(asn1.AsnLine[0].ShippedQuantity).to.equal('10');
        // Static array preserved untouched
        expect(asn1.AsnRequestedService).to.have.lengthOf(1);
        expect(asn1.AsnRequestedService[0].ServiceUomId).to.equal('ASN');

        const asn2 = result.files[1].content;
        expect(asn2.AsnId).to.equal('ASN-2');
        expect(asn2.AsnLine).to.have.lengthOf(1);
        expect(asn2.AsnLine[0].ItemId).to.equal('SKU-C');
    });
});

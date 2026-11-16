// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * "Unsorted data detected. Sorted by: …" is ONLY for grouping — e.g. two purchase orders in
 * one file whose rows are not together. A template with nothing to group by must never ask
 * for a sort, never re-order the learner's file, and never show that warning.
 *
 * Reported 2026-09-18 from Puppy School Lesson 2: the flat bulk-upload template
 * `[ { … } ]` produced "Sorted by: gtin → sku → description → locationGln → locationName →
 * quantityOnHand → uom → status". A root array has no parent level: its fields are the rows
 * themselves, not a header to group under. Before 38e5aae the same template wrongly asked
 * for a sort by its FIRST field ("Sorted by: gtin"); 38e5aae widened that to every field.
 *
 * Against the REAL CSVSortingService and the REAL JsonGenerator.
 */
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { CSVSortingService } from '../../../../services/csv-sorting/csv-sorting.service';
import { JsonGenerator } from '../../../../data-loading/json-generator';
import { ROOT_ARRAY_PATH } from '../../../../data-loading/template-parser';

const LESSON_2_TEMPLATE = `[
  {
    "gtin": "{{gtin}}",
    "sku": "{{sku}}",
    "description": "{{description}}",
    "locationGln": "{{locationGln}}",
    "locationName": "{{locationName}}",
    "quantityOnHand": "{{quantityOnHand:number}}",
    "uom": "{{uom}}",
    "status": "{{status}}"
  }
]`;
const LESSON_2_COLUMNS = ['gtin', 'sku', 'description', 'locationGln', 'locationName', 'quantityOnHand', 'uom', 'status'];

describe('CSVSortingService — a template with nothing to group by never asks for a sort', () => {
    const service = new CSVSortingService();

    it('Puppy School Lesson 2: a flat root array `[ { … } ]` needs no sorting', () => {
        const result = service.analyzeNestedArrayRequirements(LESSON_2_TEMPLATE, LESSON_2_COLUMNS);
        expect(result.sortColumns).to.deep.equal([]);
        expect(result.requiresSorting).to.equal(false);
    });

    it('a flat object needs no sorting', () => {
        const result = service.analyzeNestedArrayRequirements('{ "gtin": "{{gtin}}", "sku": "{{sku}}" }', ['gtin', 'sku']);
        expect(result.requiresSorting).to.equal(false);
    });

    it('a root array of flat objects with a nested OBJECT (not array) still needs no sorting', () => {
        const result = service.analyzeNestedArrayRequirements(
            '[ { "sku": "{{sku}}", "location": { "gln": "{{gln}}" } } ]', ['sku', 'gln']);
        expect(result.requiresSorting).to.equal(false);
    });

    it('what it IS for — two orders in one file: a header above a lines array sorts by the header', () => {
        const result = service.analyzeNestedArrayRequirements(
            '{ "poNumber": "{{poNumber}}", "lines": [ { "sku": "{{sku}}" } ] }', ['poNumber', 'sku']);
        expect(result.requiresSorting).to.equal(true);
        expect(result.sortColumns).to.deep.equal(['poNumber']);
    });

    it('a root array whose elements hold a nested array groups by the element fields', () => {
        const result = service.analyzeNestedArrayRequirements(
            '[ { "poNumber": "{{poNumber}}", "lines": [ { "sku": "{{sku}}" } ] } ]', ['poNumber', 'sku']);
        expect(result.requiresSorting).to.equal(true);
        expect(result.sortColumns).to.deep.equal(['poNumber']);
    });
});

describe('JsonGenerator — a flat root array keeps the file order and packs rows by Reps', () => {
    it('7 rows at Reps 3 → 3 requests of 3, 3 and 1, in file order, however the values repeat', async () => {
        const rows = [
            'B,SKU-2,x,L1,Loc,5,EA,active',
            'A,SKU-1,x,L1,Loc,5,EA,active',
            'B,SKU-2,x,L1,Loc,5,EA,active',     // an exact repeat of row 1: still its own record
            'C,SKU-3,x,L1,Loc,5,EA,active',
            'A,SKU-4,x,L1,Loc,5,EA,active',
            'D,SKU-5,x,L1,Loc,5,EA,active',
            'A,SKU-6,x,L1,Loc,5,EA,active'
        ];
        const result = await new JsonGenerator().generateBatchJsonFiles([LESSON_2_COLUMNS.join(','), ...rows].join('\n'), {
            template: LESSON_2_TEMPLATE,
            headers: LESSON_2_COLUMNS,
            mappings: LESSON_2_COLUMNS.map(h => ({ variable: h, column: h, dataType: 'string' })),
            repeatableArrays: [{ arrayPath: ROOT_ARRAY_PATH, enabled: true, maxRepetitions: 3 }],
            environmentVariables: {}
        } as never);

        expect(result.success, result.error).to.equal(true);
        const requests = result.files.map(f => f.content as Array<{ gtin: string; sku: string }>);
        expect(requests.map(r => r.length)).to.deep.equal([3, 3, 1]);
        expect(requests.flat().map(r => r.sku)).to.deep.equal(['SKU-2', 'SKU-1', 'SKU-2', 'SKU-3', 'SKU-4', 'SKU-5', 'SKU-6']);
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RowPaste = require('../../../../webviews/shared/row-paste');

// GitHub Issue #302: paste a spreadsheet row (header + one data row) into the
// Run API values modal and have every matching field filled.

const FIELDS = ['gtin', 'sku', 'description', 'locationGln', 'locationName', 'quantityOnHand', 'uom', 'status'];

const CSV_ROW =
    'gtin,sku,description,locationGln,locationName,quantityOnHand,uom,status\n' +
    '00012345600012,SKU-PUPPY-001,Premium Belly Rub Machine,0614141000012,Golden Retriever Distribution Center,12,EA,active\n';

describe('row-paste — spreadsheet row → form values (Issue #302)', () => {
    describe('detectDelimiter', () => {
        it('prefers tab (Excel copies TSV)', () => {
            expect(RowPaste.detectDelimiter('a\tb,c')).to.equal('\t');
        });
        it('picks comma over semicolon by count', () => {
            expect(RowPaste.detectDelimiter('a,b,c;d')).to.equal(',');
            expect(RowPaste.detectDelimiter('a;b;c,d')).to.equal(';');
        });
        it('ignores delimiters inside quotes', () => {
            expect(RowPaste.detectDelimiter('"a,b,c";d;e')).to.equal(';');
        });
        it('returns null for a plain value', () => {
            expect(RowPaste.detectDelimiter('hello world')).to.equal(null);
            expect(RowPaste.detectDelimiter('')).to.equal(null);
        });
    });

    describe('splitLine', () => {
        it('splits and trims cells', () => {
            expect(RowPaste.splitLine(' a , b ,c', ',')).to.deep.equal(['a', 'b', 'c']);
        });
        it('honours quoted cells with embedded delimiters and "" escapes', () => {
            expect(RowPaste.splitLine('"Chew Toy, Large","He said ""hi""",3', ','))
                .to.deep.equal(['Chew Toy, Large', 'He said "hi"', '3']);
        });
        it('keeps empty cells', () => {
            expect(RowPaste.splitLine('a,,c', ',')).to.deep.equal(['a', '', 'c']);
        });
    });

    describe('normaliseKey', () => {
        it('ignores case, underscores, dashes, dots and spaces', () => {
            const k = RowPaste.normaliseKey('locationGln');
            expect(RowPaste.normaliseKey('location_gln')).to.equal(k);
            expect(RowPaste.normaliseKey('Location GLN')).to.equal(k);
            expect(RowPaste.normaliseKey('location-gln')).to.equal(k);
            expect(RowPaste.normaliseKey('location.gln')).to.equal(k);
        });
    });

    describe('parseRowPaste', () => {
        it('reads header + first data row from CSV', () => {
            const p = RowPaste.parseRowPaste(CSV_ROW);
            expect(p.mode).to.equal('header');
            expect(p.delimiter).to.equal(',');
            expect(p.headers).to.deep.equal(FIELDS);
            expect(p.values[0]).to.equal('00012345600012');
            expect(p.values[5]).to.equal('12');
            expect(p.rowCount).to.equal(1);
        });
        it('reads TSV as copied from Excel, with CRLF line endings', () => {
            const p = RowPaste.parseRowPaste('gtin\tsku\r\n0001\tSKU-1\r\n');
            expect(p.mode).to.equal('header');
            expect(p.delimiter).to.equal('\t');
            expect(p.headers).to.deep.equal(['gtin', 'sku']);
            expect(p.values).to.deep.equal(['0001', 'SKU-1']);
        });
        it('uses only the first data row when several are pasted', () => {
            const p = RowPaste.parseRowPaste('a,b\n1,2\n3,4\n5,6');
            expect(p.values).to.deep.equal(['1', '2']);
            expect(p.rowCount).to.equal(3);
        });
        it('treats a single delimited line as positional values', () => {
            const p = RowPaste.parseRowPaste('1,2,3');
            expect(p.mode).to.equal('positional');
            expect(p.headers).to.equal(null);
            expect(p.values).to.deep.equal(['1', '2', '3']);
        });
        it('returns null for a plain value or empty text', () => {
            expect(RowPaste.parseRowPaste('SKU-PUPPY-001')).to.equal(null);
            expect(RowPaste.parseRowPaste('')).to.equal(null);
            expect(RowPaste.parseRowPaste('\n\n')).to.equal(null);
            expect(RowPaste.parseRowPaste(undefined)).to.equal(null);
        });
        it('ignores blank trailing lines', () => {
            const p = RowPaste.parseRowPaste('a,b\n1,2\n\n\n');
            expect(p.rowCount).to.equal(1);
        });
    });

    describe('matchFields / fillFromPaste', () => {
        it('fills every field when headers match exactly', () => {
            const r = RowPaste.fillFromPaste(CSV_ROW, FIELDS);
            expect(r.filled).to.deep.equal({
                gtin: '00012345600012',
                sku: 'SKU-PUPPY-001',
                description: 'Premium Belly Rub Machine',
                locationGln: '0614141000012',
                locationName: 'Golden Retriever Distribution Center',
                quantityOnHand: '12',
                uom: 'EA',
                status: 'active'
            });
            expect(r.unmatchedColumns).to.deep.equal([]);
            expect(r.unfilledFields).to.deep.equal([]);
        });
        it('matches columns to fields regardless of case and separators', () => {
            const r = RowPaste.fillFromPaste('Location_GLN,Quantity On Hand\n0614,12', ['locationGln', 'quantityOnHand']);
            expect(r.filled).to.deep.equal({ locationGln: '0614', quantityOnHand: '12' });
        });
        it('reports columns with no field and fields with no column', () => {
            const r = RowPaste.fillFromPaste('gtin,extra,sku\n1,x,S', ['gtin', 'sku', 'uom']);
            expect(r.filled).to.deep.equal({ gtin: '1', sku: 'S' });
            expect(r.unmatchedColumns).to.deep.equal(['extra']);
            expect(r.unfilledFields).to.deep.equal(['uom']);
        });
        it('does not intercept when no column matches any field', () => {
            expect(RowPaste.fillFromPaste('foo,bar\n1,2', FIELDS)).to.equal(null);
        });
        it('fills positionally when a single row has exactly as many cells as fields', () => {
            const r = RowPaste.fillFromPaste('1,2,3', ['a', 'b', 'c']);
            expect(r.filled).to.deep.equal({ a: '1', b: '2', c: '3' });
        });
        it('does not intercept a single row whose cell count differs from the field count', () => {
            expect(RowPaste.fillFromPaste('1,2', ['a', 'b', 'c'])).to.equal(null);
            expect(RowPaste.fillFromPaste('1,2,3,4', ['a', 'b', 'c'])).to.equal(null);
        });
        it('does not intercept a single-cell value even when it contains a comma inside quotes', () => {
            expect(RowPaste.fillFromPaste('"Chew Toy, Large"', ['description'])).to.equal(null);
        });
        it('fills a missing trailing value with an empty string', () => {
            const r = RowPaste.fillFromPaste('gtin,sku,uom\n1,S', ['gtin', 'sku', 'uom']);
            expect(r.filled).to.deep.equal({ gtin: '1', sku: 'S', uom: '' });
        });
        it('returns null for empty field lists or unparsable text', () => {
            expect(RowPaste.fillFromPaste(CSV_ROW, [])).to.equal(null);
            expect(RowPaste.fillFromPaste('just text', FIELDS)).to.equal(null);
        });
    });
});

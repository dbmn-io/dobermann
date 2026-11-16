// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: Compare's Excel export, as sheets. The values go out as each system holds them,
 * the Details are the rows the screen shows, and Excel's row limit spills onto more sheets.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { compareAcross } from '../../../services/compare/compare-across';
import { CompareRowData } from '../../../services/compare/compare-engine';
import { buildCompareSheets, compareFileName } from '../../../services/compare/compare-export';
import { CompareLens, LensFilter } from '../../../services/compare/compare-lens';
import { ConsoleExportService } from '../../../services/console/export.service';

const columns = ['itemCode', 'gtin', 'height', 'status'].map(id => ({ id, name: id, type: 'string' }));
const labels = { a: 'Test', b: 'Production' };
const names = ['Test · 10 Nov 2026 07:04', 'Production · 9 Nov 2026 16:20'];

describe('Compare export', () => {
    const rowsA: CompareRowData[] = [
        { itemCode: 'ITM-1', gtin: '0093', height: 400, status: 'Active' },
        { itemCode: 'ITM-2', gtin: '0094', height: 400, status: 'Active' },
        { itemCode: 'ITM-3', gtin: '0095', height: 400, status: 'Active' },
    ];
    const rowsB: CompareRowData[] = [
        { itemCode: 'ITM-1', gtin: '93', height: 410, status: 'Active' },     // gtin lost its zeros; height changed
        { itemCode: 'ITM-2', gtin: '0094', height: 400, status: 'Active' },   // the same
        { itemCode: 'ITM-4', gtin: '0096', height: 400, status: 'Active' },   // only in Production
    ];
    const spec = { keyColumns: ['itemCode'], compareColumns: ['gtin', 'height', 'status'] };

    async function sheets(filter: LensFilter, options: { rowsPerSheet?: number; hidden?: string[]; order?: string[] } = {}) {
        const lens = new CompareLens(await compareAcross([rowsA, rowsB], spec, 0), { visible: [0, 1], hiddenColumns: options.hidden });
        return buildCompareSheets({
            lens, columns, indices: lens.indicesOf(filter), names, order: options.order,
            endpoint: 'GET Item Master', view: 'Dimensions', filter, search: '', rowsPerSheet: options.rowsPerSheet,
        });
    }

    it('summarises the compare: which result is which, and each kind counted', async () => {
        const [summary] = await sheets({ same: false, diff: true, missing: [0, 1] });
        const value = (item: string) => summary.data.find(r => r.item === item)?.value;
        expect(summary.sheetName).to.equal('Summary');
        expect(value('BL')).to.equal('Test · 10 Nov 2026 07:04 (Baseline)');
        expect(value('C1')).to.equal('Production · 9 Nov 2026 16:20');
        expect(value('Rows match on')).to.equal('itemCode');
        expect(value('Same')).to.equal(1);
        expect(value('DIFF')).to.equal(1);
        expect(value('Missing BL')).to.equal(1);
        expect(value('Missing C1')).to.equal(1);
        expect(value('Rows that differ: gtin')).to.equal(1);
        expect(value('Status filter')).to.equal('DIFF, Missing BL, Missing C1');
    });

    it('lists the rows shown, a column per result headed by its letter, values as each system holds them', async () => {
        const [, details] = await sheets({ same: false, diff: true, missing: [] });
        expect(details.columns.map(c => c.name)).to.deep.equal([
            'Status', 'itemCode', 'gtin · BL', 'gtin · C1', 'height · BL', 'height · C1', 'status · BL', 'status · C1', 'Differs in',
        ]);
        expect(details.data).to.have.length(1);
        const row = details.data[0];
        expect(row.status).to.equal('DIFF C1');
        // Text keeps its leading zeros; a number stays a number
        expect(row.c0_0).to.equal('0093');
        expect(row.c0_1).to.equal('93');
        expect(row.c1_0).to.equal(400);
        expect(row.c1_1).to.equal(410);
        expect(row.differs).to.equal('gtin (C1), height (C1)');
    });

    it('follows the screen: hidden columns left out, the rest in its order', async () => {
        const [summary, details] = await sheets({ same: false, diff: true, missing: [] }, { hidden: ['gtin'], order: ['status', 'height', 'gtin'] });
        expect(details.columns.map(c => c.name)).to.deep.equal(['Status', 'itemCode', 'status · BL', 'status · C1', 'height · BL', 'height · C1', 'Differs in']);
        expect(details.data[0].differs).to.equal('height (C1)');
        expect(summary.data.find(r => r.item === 'Columns compared')?.value).to.equal('status, height');
    });

    it('a column shown, not compared: its values side by side in the screen\'s order, never in Differs in', async () => {
        const lens = new CompareLens(await compareAcross([rowsA, rowsB], { keyColumns: ['itemCode'], compareColumns: ['gtin', 'height'] }, 0), { visible: [0, 1] });
        const filter: LensFilter = { same: true, diff: true, missing: [] };
        const [summary, details] = buildCompareSheets({
            lens, columns, indices: lens.indicesOf(filter), names, order: ['status', 'gtin', 'height'], shown: ['status'],
            endpoint: 'GET Item Master', view: 'Dimensions', filter, search: '',
        });
        expect(details.columns.map(c => c.name)).to.deep.equal([
            'Status', 'itemCode', 'status · BL', 'status · C1', 'gtin · BL', 'gtin · C1', 'height · BL', 'height · C1', 'Differs in',
        ]);
        const value = (item: string) => summary.data.find(r => r.item === item)?.value;
        expect(value('Columns compared')).to.equal('gtin, height');
        expect(value('Rows that differ: status')).to.equal(undefined);
        expect(details.data[0].c0_0).to.equal('Active');
        expect(details.data[0].differs).to.equal('gtin (C1), height (C1)');
    });

    it('a missing record: its Status names the result without it', async () => {
        const [, details] = await sheets({ same: false, diff: false, missing: [0, 1] });
        expect(details.data.map(r => [r.k0, r.status])).to.deep.equal([['ITM-3', 'Missing C1'], ['ITM-4', 'Missing BL']]);
        const [, onlyC1] = await sheets({ same: false, diff: false, missing: [1] });
        expect(onlyC1.data.map(r => r.k0)).to.deep.equal(['ITM-3']);
    });

    it('runs on into more Details sheets past the rows a sheet holds', async () => {
        const all = await sheets({ same: true, diff: true, missing: [0, 1] }, { rowsPerSheet: 2 });
        expect(all.map(s => s.sheetName)).to.deep.equal(['Summary', 'Details', 'Details 2']);
        expect(all[1].data).to.have.length(2);
        expect(all[2].data).to.have.length(2);
    });

    it('writes a workbook whose text cells keep their leading zeros', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-export-'));
        try {
            const target = path.join(dir, compareFileName('GET Item Master', labels));
            await new ConsoleExportService().exportToExcelMultiSheet(await sheets({ same: false, diff: true, missing: [] }), { includeHeaders: true, targetUri: target });
            const book = XLSX.read(fs.readFileSync(target));
            expect(book.SheetNames).to.deep.equal(['Summary', 'Details']);
            const details = book.Sheets.Details;
            expect(details.C2.t).to.equal('s');
            expect(details.C2.v).to.equal('0093');
            expect(details.E2.t).to.equal('n');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('names the file after the endpoint and the two sides, safe on every system', () => {
        expect(compareFileName('GET /items', { a: 'Test', b: 'Prod: EU' })).to.equal('Compare GET -items - Test vs Prod- EU.xlsx');
    });
});

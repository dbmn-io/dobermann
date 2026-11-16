// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for ExcelTableDetector
 * GitHub Issue #207: Table detection, filter detection, A1 check, validateSheet
 *
 * Creates test xlsx buffers using XLSX write path (which supports !tables),
 * then verifies the detector can parse them back via ZIP.
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import * as XLSX from 'xlsx';
import * as JSZip from 'jszip';
import { ExcelTableDetector, ExcelTableInfo, SheetValidationResult } from '../../../../services/format-converter/excel-table-detector';
import { FormatConverterService } from '../../../../services/format-converter/format-converter.service';

describe('ExcelTableDetector', function () {
    this.timeout(10000);

    let detector: ExcelTableDetector;

    beforeEach(function () {
        detector = new ExcelTableDetector();
    });

    // =====================================================================
    // Helper: build an xlsx Buffer with optional named tables via jszip
    // =====================================================================

    /**
     * Build a minimal xlsx buffer from scratch using jszip.
     * This lets us control table definitions precisely.
     */
    async function buildXlsx(options: {
        sheets: Array<{
            name: string;
            data: string[][];
            tables?: Array<{ name: string; displayName: string; ref: string; autoFilter?: boolean }>;
        }>;
    }): Promise<Buffer> {
        const zip = new JSZip();

        // [Content_Types].xml
        let contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
        contentTypes += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
        contentTypes += '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';
        contentTypes += '<Default Extension="xml" ContentType="application/xml"/>';
        contentTypes += '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';

        // Track all table files for content types
        let tableCounter = 0;

        for (let i = 0; i < options.sheets.length; i++) {
            contentTypes += `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
            const sheet = options.sheets[i];
            if (sheet.tables) {
                for (const _t of sheet.tables) {
                    tableCounter++;
                    contentTypes += `<Override PartName="/xl/tables/table${tableCounter}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`;
                }
            }
        }
        contentTypes += '</Types>';
        zip.file('[Content_Types].xml', contentTypes);

        // _rels/.rels
        let rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
        rootRels += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
        rootRels += '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>';
        rootRels += '</Relationships>';
        zip.file('_rels/.rels', rootRels);

        // xl/workbook.xml
        let workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
        workbookXml += '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
        workbookXml += '<sheets>';
        for (let i = 0; i < options.sheets.length; i++) {
            workbookXml += `<sheet name="${options.sheets[i].name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`;
        }
        workbookXml += '</sheets></workbook>';
        zip.file('xl/workbook.xml', workbookXml);

        // xl/_rels/workbook.xml.rels
        let wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
        wbRels += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
        for (let i = 0; i < options.sheets.length; i++) {
            wbRels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`;
        }
        wbRels += '</Relationships>';
        zip.file('xl/_rels/workbook.xml.rels', wbRels);

        // Reset table counter for actual file creation
        tableCounter = 0;

        // Build each sheet
        for (let i = 0; i < options.sheets.length; i++) {
            const sheet = options.sheets[i];

            // Build sheet XML
            let sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
            sheetXml += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';

            // Compute range
            const maxRow = sheet.data.length;
            const maxCol = sheet.data.reduce((max, row) => Math.max(max, row.length), 0);
            const endCol = XLSX.utils.encode_col(maxCol - 1);
            const ref = `A1:${endCol}${maxRow}`;

            sheetXml += `<dimension ref="${ref}"/>`;
            sheetXml += '<sheetData>';
            for (let r = 0; r < sheet.data.length; r++) {
                sheetXml += `<row r="${r + 1}">`;
                for (let c = 0; c < sheet.data[r].length; c++) {
                    const cellRef = XLSX.utils.encode_cell({ r, c });
                    const val = sheet.data[r][c];
                    sheetXml += `<c r="${cellRef}" t="inlineStr"><is><t>${val}</t></is></c>`;
                }
                sheetXml += '</row>';
            }
            sheetXml += '</sheetData>';

            // Table parts
            if (sheet.tables && sheet.tables.length > 0) {
                sheetXml += '<tableParts count="' + sheet.tables.length + '">';
                for (let t = 0; t < sheet.tables.length; t++) {
                    sheetXml += `<tablePart r:id="rId${t + 1}"/>`;
                }
                sheetXml += '</tableParts>';
            }

            sheetXml += '</worksheet>';
            zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml);

            // Sheet rels (for table relationships)
            if (sheet.tables && sheet.tables.length > 0) {
                let sheetRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
                sheetRels += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
                for (let t = 0; t < sheet.tables.length; t++) {
                    tableCounter++;
                    sheetRels += `<Relationship Id="rId${t + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${tableCounter}.xml"/>`;
                }
                sheetRels += '</Relationships>';
                zip.file(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, sheetRels);
            }

            // Table XML files
            if (sheet.tables) {
                // Reset local counter for table file numbering - use running total
                let localTableIdx = tableCounter - sheet.tables.length;
                for (const table of sheet.tables) {
                    localTableIdx++;
                    let tableXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
                    tableXml += `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${localTableIdx}" name="${table.name}" displayName="${table.displayName}" ref="${table.ref}">`;
                    if (table.autoFilter) {
                        tableXml += `<autoFilter ref="${table.ref}"/>`;
                    }
                    // Minimal columns
                    const tableRange = XLSX.utils.decode_range(table.ref);
                    tableXml += '<tableColumns count="' + (tableRange.e.c - tableRange.s.c + 1) + '">';
                    for (let c = tableRange.s.c; c <= tableRange.e.c; c++) {
                        tableXml += `<tableColumn id="${c + 1}" name="Column${c + 1}"/>`;
                    }
                    tableXml += '</tableColumns>';
                    tableXml += '</table>';
                    zip.file(`xl/tables/table${localTableIdx}.xml`, tableXml);
                }
            }
        }

        const arrayBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        return arrayBuffer;
    }

    /**
     * Build a simple xlsx buffer using XLSX library (no named tables).
     */
    function buildSimpleXlsx(data: string[][], sheetName: string = 'Sheet1'): Buffer {
        const worksheet = XLSX.utils.aoa_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
        return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    }

    // =====================================================================
    // detectTables
    // =====================================================================

    describe('detectTables', function () {

        it('should detect 0 tables on a plain sheet', async function () {
            const buffer = buildSimpleXlsx([['Name', 'Age'], ['Alice', '30']]);
            const tables = await detector.detectTables(buffer);
            // May have empty map or map with 0-length arrays
            const sheet0Tables = tables.get(0) || [];
            expect(sheet0Tables).to.have.lengthOf(0);
        });

        it('should detect 1 table correctly', async function () {
            const buffer = await buildXlsx({
                sheets: [{
                    name: 'Data',
                    data: [['Name', 'Age', 'City'], ['Alice', '30', 'NYC'], ['Bob', '25', 'LA']],
                    tables: [{ name: 'Employees', displayName: 'Employees', ref: 'A1:C3' }]
                }]
            });

            const tables = await detector.detectTables(buffer);
            const sheet0Tables = tables.get(0) || [];
            expect(sheet0Tables).to.have.lengthOf(1);
            expect(sheet0Tables[0].name).to.equal('Employees');
            expect(sheet0Tables[0].displayName).to.equal('Employees');
            expect(sheet0Tables[0].range).to.equal('A1:C3');
            expect(sheet0Tables[0].sheetIndex).to.equal(0);
            expect(sheet0Tables[0].sheetName).to.equal('Data');
        });

        it('should detect 2 tables on the same sheet', async function () {
            const buffer = await buildXlsx({
                sheets: [{
                    name: 'Mixed',
                    data: [['A', 'B'], ['1', '2'], ['3', '4'], ['X', 'Y'], ['5', '6']],
                    tables: [
                        { name: 'Table1', displayName: 'Table1', ref: 'A1:B3' },
                        { name: 'Table2', displayName: 'Table2', ref: 'A4:B5' }
                    ]
                }]
            });

            const tables = await detector.detectTables(buffer);
            const sheet0Tables = tables.get(0) || [];
            expect(sheet0Tables).to.have.lengthOf(2);
            expect(sheet0Tables[0].name).to.equal('Table1');
            expect(sheet0Tables[1].name).to.equal('Table2');
        });

        it('should map tables to correct sheets in multi-sheet workbook', async function () {
            const buffer = await buildXlsx({
                sheets: [
                    {
                        name: 'Sheet1',
                        data: [['A'], ['1']],
                        // No tables on Sheet1
                    },
                    {
                        name: 'Sheet2',
                        data: [['X', 'Y'], ['10', '20']],
                        tables: [{ name: 'DataTable', displayName: 'DataTable', ref: 'A1:B2' }]
                    }
                ]
            });

            const tables = await detector.detectTables(buffer);
            const sheet0Tables = tables.get(0) || [];
            const sheet1Tables = tables.get(1) || [];
            expect(sheet0Tables).to.have.lengthOf(0);
            expect(sheet1Tables).to.have.lengthOf(1);
            expect(sheet1Tables[0].name).to.equal('DataTable');
            expect(sheet1Tables[0].sheetIndex).to.equal(1);
            expect(sheet1Tables[0].sheetName).to.equal('Sheet2');
        });

        it('should detect autoFilter on table', async function () {
            const buffer = await buildXlsx({
                sheets: [{
                    name: 'Filtered',
                    data: [['Col1', 'Col2'], ['A', 'B']],
                    tables: [{ name: 'FilteredTable', displayName: 'FilteredTable', ref: 'A1:B2', autoFilter: true }]
                }]
            });

            const tables = await detector.detectTables(buffer);
            const sheet0Tables = tables.get(0) || [];
            expect(sheet0Tables).to.have.lengthOf(1);
            expect(sheet0Tables[0].hasAutoFilter).to.be.true;
        });

        it('should return empty map for non-ZIP (OLE) buffer', async function () {
            // OLE magic number
            const oleBuffer = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00]);
            const tables = await detector.detectTables(oleBuffer);
            expect(tables.size).to.equal(0);
        });
    });

    // =====================================================================
    // detectFilters
    // =====================================================================

    describe('detectFilters', function () {

        it('should detect autofilter when present', function () {
            const ws: XLSX.WorkSheet = { '!ref': 'A1:B2' };
            (ws as Record<string, unknown>)['!autofilter'] = { ref: 'A1:B2' };
            const result = detector.detectFilters(ws);
            expect(result.hasAutoFilter).to.be.true;
            expect(result.autoFilterRange).to.equal('A1:B2');
        });

        it('should report no autofilter when absent', function () {
            const ws: XLSX.WorkSheet = { '!ref': 'A1:B2' };
            const result = detector.detectFilters(ws);
            expect(result.hasAutoFilter).to.be.false;
            expect(result.autoFilterRange).to.be.null;
        });

        it('should count hidden rows', function () {
            const ws: XLSX.WorkSheet = { '!ref': 'A1:A5' };
            (ws as Record<string, unknown>)['!rows'] = [
                {},               // row 0: visible
                { hidden: true }, // row 1: hidden
                {},               // row 2: visible
                { hidden: true }, // row 3: hidden
                {}                // row 4: visible
            ];
            const result = detector.detectFilters(ws);
            expect(result.hasHiddenRows).to.be.true;
            expect(result.hiddenRowCount).to.equal(2);
        });

        it('should report no hidden rows when none are hidden', function () {
            const ws: XLSX.WorkSheet = { '!ref': 'A1:A3' };
            (ws as Record<string, unknown>)['!rows'] = [{}, {}, {}];
            const result = detector.detectFilters(ws);
            expect(result.hasHiddenRows).to.be.false;
            expect(result.hiddenRowCount).to.equal(0);
        });
    });

    // =====================================================================
    // dataStartsAtA1
    // =====================================================================

    describe('dataStartsAtA1', function () {

        it('should return true for data starting at A1', function () {
            const ws: XLSX.WorkSheet = { '!ref': 'A1:C10' };
            expect(detector.dataStartsAtA1(ws)).to.be.true;
        });

        it('should return false for data starting at B3', function () {
            const ws: XLSX.WorkSheet = { '!ref': 'B3:D10' };
            expect(detector.dataStartsAtA1(ws)).to.be.false;
        });

        it('should return false for data starting at A2', function () {
            const ws: XLSX.WorkSheet = { '!ref': 'A2:C10' };
            expect(detector.dataStartsAtA1(ws)).to.be.false;
        });

        it('should return false when !ref is missing', function () {
            const ws: XLSX.WorkSheet = {};
            expect(detector.dataStartsAtA1(ws)).to.be.false;
        });
    });

    // =====================================================================
    // validateSheet
    // =====================================================================

    describe('validateSheet', function () {

        it('should be valid with 0 tables and data at A1 (backward compat)', function () {
            const ws: XLSX.WorkSheet = { '!ref': 'A1:C10' };
            const result = detector.validateSheet([], ws);
            expect(result.validationStatus).to.equal('valid');
            expect(result.validationMessage).to.be.null;
            expect(result.effectiveDataRange).to.equal('A1:C10');
            expect(result.tableCount).to.equal(0);
        });

        it('should error with 0 tables and data not at A1', function () {
            const ws: XLSX.WorkSheet = { '!ref': 'B3:D10' };
            const result = detector.validateSheet([], ws);
            expect(result.validationStatus).to.equal('error');
            expect(result.validationMessage).to.contain('No table found');
            expect(result.effectiveDataRange).to.be.null;
        });

        it('should be valid with 1 table and use table range', function () {
            const table: ExcelTableInfo = {
                name: 'MyTable',
                displayName: 'MyTable',
                range: 'B2:E20',
                sheetIndex: 0,
                sheetName: 'Sheet1',
                hasAutoFilter: false
            };
            const ws: XLSX.WorkSheet = { '!ref': 'A1:F25' };
            const result = detector.validateSheet([table], ws);
            expect(result.validationStatus).to.equal('valid');
            expect(result.validationMessage).to.be.null;
            expect(result.effectiveDataRange).to.equal('B2:E20');
            expect(result.tableCount).to.equal(1);
        });

        it('should error with 2+ tables', function () {
            const tables: ExcelTableInfo[] = [
                { name: 'T1', displayName: 'T1', range: 'A1:B5', sheetIndex: 0, sheetName: 'S', hasAutoFilter: false },
                { name: 'T2', displayName: 'T2', range: 'D1:E5', sheetIndex: 0, sheetName: 'S', hasAutoFilter: false }
            ];
            const ws: XLSX.WorkSheet = { '!ref': 'A1:E10' };
            const result = detector.validateSheet(tables, ws);
            expect(result.validationStatus).to.equal('error');
            expect(result.validationMessage).to.contain('Multiple tables');
        });

        it('should merge table-level autoFilter into filter result', function () {
            const table: ExcelTableInfo = {
                name: 'FilteredTable',
                displayName: 'FilteredTable',
                range: 'A1:C100',
                sheetIndex: 0,
                sheetName: 'Sheet1',
                hasAutoFilter: true
            };
            // Worksheet has NO sheet-level !autofilter — only the table has it
            const ws: XLSX.WorkSheet = { '!ref': 'A1:C100' };
            (ws as Record<string, unknown>)['!rows'] = [
                {}, { hidden: true }, { hidden: true }, {}
            ];

            const result = detector.validateSheet([table], ws);
            expect(result.filter.hasAutoFilter).to.be.true;
            expect(result.filter.autoFilterRange).to.equal('A1:C100');
            expect(result.filter.hasHiddenRows).to.be.true;
            expect(result.filter.hiddenRowCount).to.equal(2);
        });

        it('should not override sheet-level autoFilter with table autoFilter', function () {
            const table: ExcelTableInfo = {
                name: 'Table1',
                displayName: 'Table1',
                range: 'B2:D10',
                sheetIndex: 0,
                sheetName: 'Sheet1',
                hasAutoFilter: true
            };
            // Worksheet has its own sheet-level autofilter with different range
            const ws: XLSX.WorkSheet = { '!ref': 'A1:E20' };
            (ws as Record<string, unknown>)['!autofilter'] = { ref: 'A1:E20' };

            const result = detector.validateSheet([table], ws);
            // Sheet-level takes precedence — should NOT be overridden
            expect(result.filter.hasAutoFilter).to.be.true;
            expect(result.filter.autoFilterRange).to.equal('A1:E20');
        });

        it('should include filter info in result', function () {
            const ws: XLSX.WorkSheet = { '!ref': 'A1:C10' };
            (ws as Record<string, unknown>)['!autofilter'] = { ref: 'A1:C10' };
            (ws as Record<string, unknown>)['!rows'] = [
                {}, { hidden: true }, {}, { hidden: true }, {}
            ];
            const result = detector.validateSheet([], ws);
            expect(result.filter.hasAutoFilter).to.be.true;
            expect(result.filter.hasHiddenRows).to.be.true;
            expect(result.filter.hiddenRowCount).to.equal(2);
        });
    });

    // =====================================================================
    // Integration: FormatConverterService.getExcelSheets() end-to-end
    // =====================================================================

    describe('getExcelSheets integration', function () {

        it('should detect autofilter and hidden rows from a real xlsx buffer', async function () {
            // Build xlsx with autofilter + hidden row
            const ws = XLSX.utils.aoa_to_sheet([
                ['Name', 'Age'],
                ['Alice', '30'],
                ['Bob', '25'],
                ['Carol', '35']
            ]);
            ws['!autofilter'] = { ref: 'A1:B4' };
            ws['!rows'] = [{}, { hidden: true }, {}, {}];

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Filtered');
            const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

            // Run through the service (which uses cellStyles: true)
            const service = new FormatConverterService();
            const sheets = await service.getExcelSheets(buf);

            expect(sheets).to.have.lengthOf(1);
            expect(sheets[0].filter).to.not.be.undefined;
            expect(sheets[0].filter!.hasAutoFilter).to.be.true;
            expect(sheets[0].filter!.hasHiddenRows).to.be.true;
            expect(sheets[0].filter!.hiddenRowCount).to.equal(1);
        });

        it('should detect table-level autoFilter with hidden rows end-to-end', async function () {
            // Build xlsx with a table that has autoFilter + hidden rows in the sheet
            const buf = await buildXlsx({
                sheets: [{
                    name: 'TableFiltered',
                    data: [
                        ['Name', 'Status'],
                        ['Alice', 'Active'],
                        ['Bob', 'Inactive'],
                        ['Carol', 'Active'],
                        ['Dave', 'Inactive']
                    ],
                    tables: [{ name: 'StatusTable', displayName: 'StatusTable', ref: 'A1:B5', autoFilter: true }]
                }]
            });

            // Read with SheetJS (simulating what FormatConverterService does)
            const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true });
            const ws = wb.Sheets[wb.SheetNames[0]];

            // SheetJS won't have !autofilter (it's table-level), but let's verify
            const sheetAutofilter = (ws as Record<string, unknown>)['!autofilter'];
            expect(sheetAutofilter).to.be.undefined;

            // Detect tables via ZIP
            const detector2 = new ExcelTableDetector();
            const tableMap = await detector2.detectTables(buf);
            const tables = tableMap.get(0) || [];
            expect(tables).to.have.lengthOf(1);
            expect(tables[0].hasAutoFilter).to.be.true;

            // Simulate hidden rows (SheetJS won't auto-hide from table filter)
            (ws as Record<string, unknown>)['!rows'] = [
                {},               // header
                {},               // Alice - visible
                { hidden: true }, // Bob - hidden
                {},               // Carol - visible
                { hidden: true }  // Dave - hidden
            ];

            // validateSheet should merge the table autoFilter
            const result = detector2.validateSheet(tables, ws);
            expect(result.filter.hasAutoFilter).to.be.true;
            expect(result.filter.autoFilterRange).to.equal('A1:B5');
            expect(result.filter.hasHiddenRows).to.be.true;
            expect(result.filter.hiddenRowCount).to.equal(2);
        });

        it('should report no filter on a plain xlsx', async function () {
            const ws = XLSX.utils.aoa_to_sheet([['A', 'B'], ['1', '2']]);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Plain');
            const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

            const service = new FormatConverterService();
            const sheets = await service.getExcelSheets(buf);

            expect(sheets[0].filter!.hasAutoFilter).to.be.false;
            expect(sheets[0].filter!.hasHiddenRows).to.be.false;
            expect(sheets[0].filter!.hiddenRowCount).to.equal(0);
        });
    });
});

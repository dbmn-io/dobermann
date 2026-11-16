// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Excel Table & Filter Detector
 * GitHub Issue #207: Detects named tables and active filters in Excel files
 *
 * Uses jszip to parse xlsx ZIP structure for table definitions,
 * since SheetJS v0.18.5 does not parse tables on read.
 * Filter detection uses SheetJS worksheet properties (!autofilter, !rows).
 */

import * as JSZip from 'jszip';
import * as XLSX from 'xlsx';

// =========================================================================
// Types
// =========================================================================

export interface ExcelTableInfo {
    name: string;
    displayName: string;
    range: string;
    sheetIndex: number;
    sheetName: string;
    hasAutoFilter: boolean;
}

export interface ExcelFilterInfo {
    hasAutoFilter: boolean;
    hasHiddenRows: boolean;
    hiddenRowCount: number;
    autoFilterRange: string | null;
}

export interface SheetValidationResult {
    tables: ExcelTableInfo[];
    tableCount: number;
    filter: ExcelFilterInfo;
    dataStartsAtA1: boolean;
    validationStatus: 'valid' | 'error';
    validationMessage: string | null;
    effectiveDataRange: string | null;
}

// =========================================================================
// ExcelTableDetector
// =========================================================================

export class ExcelTableDetector {

    /**
     * Detect named tables in an xlsx file by parsing the ZIP structure.
     * Returns a Map of sheetIndex → ExcelTableInfo[].
     *
     * For .xls (OLE) files, returns an empty map (no ZIP to parse).
     */
    async detectTables(fileData: Uint8Array): Promise<Map<number, ExcelTableInfo[]>> {
        const result = new Map<number, ExcelTableInfo[]>();

        // Check for ZIP signature (xlsx). OLE (.xls) files can't have named tables via ZIP.
        if (fileData.length < 4 || fileData[0] !== 0x50 || fileData[1] !== 0x4B) {
            return result;
        }

        let zip: JSZip;
        try {
            zip = await JSZip.loadAsync(fileData);
        } catch {
            return result;
        }

        // 1. Parse workbook.xml for sheet names and rIds
        const sheetRIds = await this.parseWorkbookSheets(zip);
        if (sheetRIds.length === 0) return result;

        // 2. Parse workbook.xml.rels for rId → sheet file path mapping
        const rIdToFile = await this.parseWorkbookRels(zip);

        // 3. Build sheetIndex → sheetFile mapping
        const sheetFiles: Array<{ index: number; name: string; file: string }> = [];
        for (const sheet of sheetRIds) {
            const file = rIdToFile.get(sheet.rId);
            if (file) {
                sheetFiles.push({ index: sheet.index, name: sheet.name, file });
            }
        }

        // 4. For each sheet, find table relationships
        for (const sheet of sheetFiles) {
            const tables = await this.detectTablesForSheet(zip, sheet.file, sheet.index, sheet.name);
            if (tables.length > 0) {
                result.set(sheet.index, tables);
            }
        }

        return result;
    }

    /**
     * Detect filter state from a SheetJS worksheet.
     */
    detectFilters(worksheet: XLSX.WorkSheet): ExcelFilterInfo {
        const autofilter = (worksheet as Record<string, unknown>)['!autofilter'] as { ref?: string } | undefined;
        const hasAutoFilter = !!autofilter;
        const autoFilterRange = autofilter?.ref || null;

        let hiddenRowCount = 0;
        const rows = (worksheet as Record<string, unknown>)['!rows'] as Array<{ hidden?: boolean }> | undefined;
        if (rows) {
            for (const row of rows) {
                if (row && row.hidden) {
                    hiddenRowCount++;
                }
            }
        }

        return {
            hasAutoFilter,
            hasHiddenRows: hiddenRowCount > 0,
            hiddenRowCount,
            autoFilterRange
        };
    }

    /**
     * Check whether the worksheet data starts at cell A1.
     */
    dataStartsAtA1(worksheet: XLSX.WorkSheet): boolean {
        const ref = worksheet['!ref'];
        if (!ref) return false;

        const range = XLSX.utils.decode_range(ref);
        return range.s.r === 0 && range.s.c === 0;
    }

    /**
     * Validate a sheet combining table count, A1 check, and filter detection.
     */
    validateSheet(
        tables: ExcelTableInfo[],
        worksheet: XLSX.WorkSheet
    ): SheetValidationResult {
        const tableCount = tables.length;
        const filter = this.detectFilters(worksheet);

        // Merge table-level autoFilter: SheetJS only reads sheet-level !autofilter,
        // but Excel tables define autoFilter in their own XML (xl/tables/tableN.xml).
        // Our ZIP parser captures this as hasAutoFilter on ExcelTableInfo.
        if (!filter.hasAutoFilter) {
            const tableWithFilter = tables.find(t => t.hasAutoFilter);
            if (tableWithFilter) {
                filter.hasAutoFilter = true;
                filter.autoFilterRange = tableWithFilter.range;
            }
        }

        const startsAtA1 = this.dataStartsAtA1(worksheet);

        let validationStatus: 'valid' | 'error' = 'valid';
        let validationMessage: string | null = null;
        let effectiveDataRange: string | null = null;

        if (tableCount === 0) {
            if (startsAtA1) {
                // Backward compatible — use full sheet range
                effectiveDataRange = worksheet['!ref'] || null;
            } else {
                validationStatus = 'error';
                validationMessage = 'No table found. Define a named table in Excel, or ensure data starts at cell A1.';
            }
        } else if (tableCount === 1) {
            effectiveDataRange = tables[0].range;
        } else {
            validationStatus = 'error';
            validationMessage = `Multiple tables found (${tableCount}). Only 1 table per sheet is supported. Remove extra tables in Excel.`;
        }

        return {
            tables,
            tableCount,
            filter,
            dataStartsAtA1: startsAtA1,
            validationStatus,
            validationMessage,
            effectiveDataRange
        };
    }

    // =====================================================================
    // Private helpers — ZIP XML parsing
    // =====================================================================

    /**
     * Parse xl/workbook.xml for sheet entries: name, sheetId, rId.
     */
    private async parseWorkbookSheets(zip: JSZip): Promise<Array<{ name: string; rId: string; index: number }>> {
        const sheets: Array<{ name: string; rId: string; index: number }> = [];
        const workbookFile = zip.file('xl/workbook.xml');
        if (!workbookFile) return sheets;

        const xml = await workbookFile.async('text');
        // Match <sheet name="..." ... r:id="rId..." />
        const sheetRegex = /<sheet\s[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"[^>]*?\/?>/gi;
        let match: RegExpExecArray | null;
        let index = 0;
        while ((match = sheetRegex.exec(xml)) !== null) {
            sheets.push({ name: match[1], rId: match[2], index: index++ });
        }
        return sheets;
    }

    /**
     * Parse xl/_rels/workbook.xml.rels for rId → target file mapping.
     */
    private async parseWorkbookRels(zip: JSZip): Promise<Map<string, string>> {
        const rIdMap = new Map<string, string>();
        const relsFile = zip.file('xl/_rels/workbook.xml.rels');
        if (!relsFile) return rIdMap;

        const xml = await relsFile.async('text');
        // Match <Relationship Id="rIdN" ... Target="worksheets/sheet1.xml" />
        const relRegex = /<Relationship\s[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"[^>]*?\/?>/gi;
        let match: RegExpExecArray | null;
        while ((match = relRegex.exec(xml)) !== null) {
            rIdMap.set(match[1], match[2]);
        }
        return rIdMap;
    }

    /**
     * Detect tables linked to a specific sheet file.
     */
    private async detectTablesForSheet(
        zip: JSZip,
        sheetFile: string,
        sheetIndex: number,
        sheetName: string
    ): Promise<ExcelTableInfo[]> {
        const tables: ExcelTableInfo[] = [];

        // Sheet rels file: e.g. xl/worksheets/_rels/sheet1.xml.rels
        const sheetFileName = sheetFile.split('/').pop() || '';
        const relsPath = `xl/worksheets/_rels/${sheetFileName}.rels`;
        const relsFile = zip.file(relsPath);
        if (!relsFile) return tables;

        const relsXml = await relsFile.async('text');

        // Find table relationships
        const tableRelRegex = /<Relationship\s[^>]*?Target="([^"]*table[^"]*\.xml)"[^>]*?\/?>/gi;
        let relMatch: RegExpExecArray | null;
        const tablePaths: string[] = [];

        while ((relMatch = tableRelRegex.exec(relsXml)) !== null) {
            let target = relMatch[1];
            // Resolve relative path: ../tables/table1.xml → xl/tables/table1.xml
            if (target.startsWith('../')) {
                target = 'xl/' + target.substring(3);
            } else if (!target.startsWith('xl/')) {
                target = 'xl/worksheets/' + target;
            }
            tablePaths.push(target);
        }

        // Parse each table XML
        for (const tablePath of tablePaths) {
            const tableFile = zip.file(tablePath);
            if (!tableFile) continue;

            const tableXml = await tableFile.async('text');
            const tableInfo = this.parseTableXml(tableXml, sheetIndex, sheetName);
            if (tableInfo) {
                tables.push(tableInfo);
            }
        }

        return tables;
    }

    /**
     * Parse a table XML file (xl/tables/tableN.xml) for table metadata.
     */
    private parseTableXml(xml: string, sheetIndex: number, sheetName: string): ExcelTableInfo | null {
        // <table ... name="Table1" displayName="Table1" ref="A1:C10" ...>
        const nameMatch = xml.match(/\bname="([^"]*)"/i);
        const displayNameMatch = xml.match(/\bdisplayName="([^"]*)"/i);
        const refMatch = xml.match(/\bref="([^"]*)"/i);

        if (!refMatch) return null;

        // Check for <autoFilter ref="..." /> inside the table
        const hasAutoFilter = /<autoFilter\b/i.test(xml);

        return {
            name: nameMatch ? nameMatch[1] : 'Table',
            displayName: displayNameMatch ? displayNameMatch[1] : nameMatch?.[1] || 'Table',
            range: refMatch[1],
            sheetIndex,
            sheetName,
            hasAutoFilter
        };
    }
}

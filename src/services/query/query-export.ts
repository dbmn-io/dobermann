// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's export as a workbook's bytes, made where the rows are (the engine's worker in the web app):
 * the same cells ConsoleExportService.exportArraysToExcel writes (every value as text, a blank empty;
 * widths, a filter on the headings, compressed), without the page holding a row.
 */
import * as XLSX from 'xlsx';
import type { QueryEngine } from '../engine/engine';
import type { ResultId } from '../engine/engine-types';

export interface WorkbookSheet { sheetName: string; header: string[]; rows: unknown[][] }

/** A value as Query's export writes it: blank as nothing, anything else as its text (an object as JSON). */
function cell(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The workbook's bytes for these sheets. */
export function queryWorkbook(sheets: WorkbookSheet[]): Uint8Array {
    const book = XLSX.utils.book_new();
    for (const sheet of sheets) {
        const ws = XLSX.utils.aoa_to_sheet([sheet.header, ...sheet.rows.map(row => row.map(cell))], { dense: true } as XLSX.AOA2SheetOpts);
        ws['!cols'] = sheet.header.map(name => ({ wch: Math.max(name.length, 15) }));
        if (sheet.rows.length && ws['!ref']) ws['!autofilter'] = { ref: ws['!ref'] };
        XLSX.utils.book_append_sheet(book, ws, sheet.sheetName);
    }
    return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer);
}

/**
 * Results' export from a result kept in the engine: its first `count` columns, every row (read where it
 * is), as the 'Results' sheet; `about` as the 'Query' sheet.
 */
export function resultWorkbook(engine: QueryEngine, result: ResultId, count: number, header: string[], about: [string, string][]): Uint8Array {
    const total = engine.read(result, 0, 0).total;
    const rows: unknown[][] = [];
    for (let from = 0; from < total; from += 50_000) {
        for (const row of engine.read(result, from, 50_000).rows) rows.push(row.slice(0, count));
    }
    return queryWorkbook([{ sheetName: 'Results', header, rows }, { sheetName: 'Query', header: ['', ''], rows: about }]);
}

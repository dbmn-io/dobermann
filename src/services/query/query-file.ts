// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A file as views of a Query: a CSV (or TSV, or text with a delimiter) is one, and an Excel
 * workbook one per sheet, the first row of each the column names.
 *
 * Values are kept as the file has them, as everywhere in Query: a CSV's are all text ("00123"
 * keeps its zeros), a workbook's keep the type the cell has. A blank is NULL. To join text to a
 * number, the Join step's ƒ has As text and As a number.
 */
import * as XLSX from 'xlsx';
import { parseCSVContent } from '../../utils/csv-mismatch';
import type { QueryRowData } from './query-types';

export interface QueryFileRows {
    columns: string[];
    rows: QueryRowData[];
}

/** One table of a file: a workbook's sheet by its name, or a CSV (no sheet name). */
export interface QueryFileSheet extends QueryFileRows {
    sheet: string;
}

/** What a file holds, by its name's ending: a workbook's first sheet, or the CSV. `text` for CSV-like files, `base64` for a workbook. */
export function readFileRows(name: string, content: { text?: string; base64?: string }): QueryFileRows {
    const first = readFileSheets(name, content)[0];
    if (!first) throw new Error(`${name} has no columns: its first row should name them.`);
    return { columns: first.columns, rows: first.rows };
}

/**
 * Every table a file holds: each sheet of a workbook that has a first row of names (a blank
 * sheet is passed over), or the one a CSV is.
 */
export function readFileSheets(name: string, content: { text?: string; base64?: string }): QueryFileSheet[] {
    const excel = /\.(xlsx|xls)$/i.test(name);
    if (!excel) {
        const parsed = parseCSVContent(String(content.text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
        if (!parsed.headers.length) throw new Error(`${name} has no columns: its first row should name them.`);
        return [{ sheet: '', ...tableRows([parsed.headers, ...parsed.rows]) }];
    }
    if (!content.base64) throw new Error(`${name} could not be read.`);
    // (cells as values only, each sheet as rows: a quarter of the memory and half the time of SheetJS's default on a large workbook)
    const book = XLSX.read(workbookBytes(content.base64), { type: 'array', ...VALUES_ONLY });
    const sheets = book.SheetNames
        .map(sheet => ({ sheet, table: XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheet], { header: 1, raw: true, defval: null }) }))
        .filter(s => (s.table[0] ?? []).some(v => v !== null && v !== undefined && v !== ''))
        .map(s => ({ sheet: s.sheet, ...tableRows(s.table) }));
    if (!sheets.length) throw new Error(`${name} has no columns: a sheet's first row should name them.`);
    return sheets;
}

/** SheetJS reading values only, each sheet as rows (no formatted text, no HTML): the same rows, far less work. */
const VALUES_ONLY = { dense: true, cellText: false, cellHTML: false } as const;

/** A workbook's bytes from the base64 the page sends (SheetJS's own base64 decoding is half its time on a large workbook). */
export function workbookBytes(base64: string): Uint8Array {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
}

/** Is this file a workbook (read a sheet at a time), not a CSV? */
export function isWorkbook(name: string): boolean {
    return /\.(xlsx|xls)$/i.test(name);
}

/**
 * A workbook's sheets for the picker, from each sheet's first rows only (about a second for a large
 * workbook, not the whole of it): its name, its columns, and how many rows it has below them. A
 * sheet with no first row of names is passed over, as readFileSheets passes it over.
 */
export function workbookSheets(bytes: Uint8Array): { sheet: string; columns: number; rows: number }[] {
    const book = XLSX.read(bytes, { type: 'array', ...VALUES_ONLY, sheetRows: 2 });
    return book.SheetNames.flatMap(sheet => {
        const ws = book.Sheets[sheet];
        const head = (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null })[0] ?? []);
        if (!head.some(v => v !== null && v !== undefined && v !== '')) return [];
        const full = ws['!fullref'] ?? ws['!ref'];
        const range = full ? XLSX.utils.decode_range(full) : undefined;
        return [{ sheet, columns: columnNames(head).length, rows: range ? Math.max(0, range.e.r - range.s.r) : 0 }];
    });
}

/** One sheet of a workbook, read on its own (workbookSheets first, then each sheet picked). */
export function readWorkbookSheet(bytes: Uint8Array, sheet: string): QueryFileSheet {
    const book = XLSX.read(bytes, { type: 'array', ...VALUES_ONLY, sheets: sheet });
    const table = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheet], { header: 1, raw: true, defval: null });
    return { sheet, ...tableRows(table) };
}

function tableRows(table: unknown[][]): QueryFileRows {
    const columns = columnNames(table[0] ?? []);
    const rows = table.slice(1)
        .filter(line => line.some(v => v !== null && v !== undefined && v !== ''))
        .map(line => {
            const row: QueryRowData = {};
            columns.forEach((column, i) => {
                const value = line[i];
                row[column] = value === undefined || value === '' ? null : value instanceof Date ? value.toISOString() : value;
            });
            return row;
        });
    return { columns, rows };
}

/** The first row as column names: a blank one is "Column 3", a name used twice gains a number. */
function columnNames(head: unknown[]): string[] {
    const taken = new Set<string>();
    return head.map((cell, i) => {
        const base = String(cell ?? '').trim() || `Column ${i + 1}`;
        let name = base;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}_${n}`;
        taken.add(name.toLowerCase());
        return name;
    });
}

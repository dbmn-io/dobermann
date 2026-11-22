// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's export as a workbook's bytes, made where the rows are (the engine's worker in the web app):
 * a number as a number, true/false as such, every other value as its text ("0093" stays text), a blank empty
 * (2026-11-22, as old Compare's file: #14); widths, a filter on the headings, compressed; past Excel's rows a sheet,
 * the rows run on into "Results 2", "Results 3"… (#28). Without the page holding a row.
 */
import * as XLSX from 'xlsx';
import type { QueryEngine } from '../engine/engine';
import type { ResultId, Value } from '../engine/engine-types';
import { statusOfRow, type StatusLayout } from './query-new-engine';
import type { RowStatus } from './query-status';

export interface WorkbookSheet { sheetName: string; header: string[]; rows: unknown[][] }

/** A value as Query's export writes it: blank as nothing, a number or true/false as it is, anything else as its text (an object as JSON). */
function cell(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'boolean') return value;
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Excel's rows a sheet, its heading row taken. */
export const SHEET_ROWS = 1_048_575;

/** A sheet's rows split where Excel stops: "Results", "Results 2"… each with the headings. */
export function splitSheet(sheet: WorkbookSheet, most = SHEET_ROWS): WorkbookSheet[] {
    if (sheet.rows.length <= most) return [sheet];
    const out: WorkbookSheet[] = [];
    for (let from = 0, n = 1; from < sheet.rows.length; from += most, n++) {
        out.push({ sheetName: n === 1 ? sheet.sheetName : `${sheet.sheetName} ${n}`, header: sheet.header, rows: sheet.rows.slice(from, from + most) });
    }
    return out;
}

/** The workbook's bytes for these sheets. */
export function queryWorkbook(sheets: WorkbookSheet[]): Uint8Array {
    const book = XLSX.utils.book_new();
    for (const sheet of sheets.flatMap(s => splitSheet(s))) {
        const ws = XLSX.utils.aoa_to_sheet([sheet.header, ...sheet.rows.map(row => row.map(cell))], { dense: true } as XLSX.AOA2SheetOpts);
        ws['!cols'] = sheet.header.map(name => ({ wch: Math.max(name.length, 15) }));
        if (sheet.rows.length && ws['!ref']) ws['!autofilter'] = { ref: ws['!ref'] };
        XLSX.utils.book_append_sheet(book, ws, sheet.sheetName);
    }
    return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer);
}

/** A row's status in words, as the old Compare's file had it: "DIFF C1 C2 · Missing C3", "No key (BL)" or "Same". */
export function statusWords(status: RowStatus): string {
    if (status.noKey) return `No key (${status.noKey})`;
    const parts: string[] = [];
    if (status.diff.length) parts.push(`DIFF ${status.diff.join(' ')}`);
    if (status.missing.length) parts.push(`Missing ${status.missing.join(' ')}`);
    return parts.length ? parts.join(' · ') : 'Same';
}

/**
 * Results' export from a result kept in the engine: the columns Results shows (`keep`, by place: a hidden
 * result's left out), every row (read where it is), as the 'Results' sheet; `about` as the 'Query' sheet.
 * A compare's (`status`, its layout): each row's Status first and the compared columns it differs in
 * last, as the old Compare's file had them.
 */
export function resultWorkbook(engine: QueryEngine, result: ResultId, keep: number[], header: string[], about: [string, string][], status?: StatusLayout): Uint8Array {
    const first = engine.read(result, 0, 0);
    const at = new Map(first.columns.map((c, i) => [c, i]));
    const rows: unknown[][] = [];
    for (let from = 0; from < first.total; from += 50_000) {
        for (const row of engine.read(result, from, 50_000).rows) {
            const shown = keep.map(c => row[c]);
            if (!status) { rows.push(shown); continue; }
            const st = statusOfRow((name: string): Value => row[at.get(name) ?? -1] ?? null, status);
            rows.push([statusWords(st), ...shown, st.groups.join(', ')]);
        }
    }
    const head = status ? ['Status', ...header, 'Differs in'] : header;
    return queryWorkbook([{ sheetName: 'Results', header: head, rows }, { sheetName: 'Query', header: ['', ''], rows: about }]);
}

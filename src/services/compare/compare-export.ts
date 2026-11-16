// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Compare's Excel export (#298): a Summary sheet, then the rows the screen shows (its Status
 * filter, find, sort, the results and columns shown), always side by side: one column per
 * result under each compared column, headed "quantityOnHand · BL". Written by the Console's
 * multi-sheet Excel export.
 *
 * Values go out as each system holds them: a JSON string stays text (its leading zeros too), a
 * number stays a number. Value columns are typed 'object', which the export service passes
 * through as they are (only an object or array becomes its JSON); 'string' would turn a number
 * into text, and 'number' would parse "0093" into 93.
 *
 * No row cap of our own: Excel's is 1,048,576 rows a sheet, so the rows run on into
 * "Details 2", "Details 3" and so on.
 */
import type { CompareColumn } from './compare-side';
import { filterText, placeLetter, statusText, CompareLens, LensFilter } from './compare-lens';
import type { SheetDefinition } from '../console/export.service';
import type { ColumnDefinition, TableRow } from '../../types/console-messages';

/** Data rows per sheet: Excel's row limit, less the header row. */
export const EXCEL_MAX_DATA_ROWS = 1_048_575;

export interface CompareExportInput {
    lens: CompareLens;
    /** The View's columns, for their names. */
    columns: CompareColumn[];
    /** The rows to export, in the screen's order (filtered and sorted). */
    indices: number[];
    /** Each result's name, by place ("Staging 840 · 10 Nov 2026 07:04"). */
    names: string[];
    /** The compared and shown-only columns in the screen's order; absent: the compare's. Hidden ones are left out either way. */
    order?: string[];
    /** Columns shown beside the compared ones, never compared (not removed on Results). */
    shown?: string[];
    endpoint: string;
    view: string;
    /** The Status filter and the find text, as the screen had them. */
    filter: LensFilter;
    search: string;
    /** Data rows per Details sheet (tests use a small one). */
    rowsPerSheet?: number;
}

const column = (id: string, name: string): ColumnDefinition => ({ id, name, type: 'string', sortable: false, filterable: false });
/** A column of values exactly as the systems hold them. */
const asIs = (id: string, name: string): ColumnDefinition => ({ ...column(id, name), type: 'object' });

export function buildCompareSheets(input: CompareExportInput): SheetDefinition[] {
    const { lens } = input;
    const result = lens.result;
    const name = (id: string) => input.columns.find(c => c.id === id)?.name ?? id;
    const keys = result.spec.keyColumns;
    const compared = input.order ? input.order.filter(c => lens.columns.includes(c)) : lens.columns;
    const shownOnly = input.shown ?? [];
    // The columns in the screen's order: compared and shown-only together
    const listed = [...compared, ...shownOnly];
    const columnsOut = input.order ? [...input.order.filter(c => listed.includes(c)), ...listed.filter(c => !input.order!.includes(c))] : listed;
    const relaxed = (result.spec.relaxedColumns ?? []).filter(c => compared.includes(c));
    const places = lens.visible;
    const hiddenPlaces = Array.from({ length: result.places }, (_, p) => p).filter(p => !places.includes(p));

    const summary: TableRow[] = [];
    const line = (item: string, value: unknown) => summary.push({ item, value });
    line('Endpoint', input.endpoint);
    line('View', input.view);
    places.forEach(p => line(placeLetter(p), p === 0 ? `${input.names[p]} (Baseline)` : input.names[p]));
    if (hiddenPlaces.length) line('Results not shown', hiddenPlaces.map(p => `${placeLetter(p)} ${input.names[p]}`).join(', '));
    line('Rows match on', keys.map(name).join(' + '));
    line('Columns compared', compared.map(name).join(', '));
    if (relaxed.length) line('Relaxed columns', relaxed.map(name).join(', '));
    places.forEach(p => line(`Rows in ${placeLetter(p)}`, result.rowCounts[p]));
    line('Same', lens.counts.same);
    line('DIFF', lens.counts.diff);
    places.forEach(p => line(`Missing ${placeLetter(p)}`, lens.missingBy[p]));
    line('Status filter', filterText(input.filter, name));
    if (input.search.trim()) line('Find', input.search.trim());
    line('Rows in Details', input.indices.length);
    compared.forEach(c => line(`Rows that differ: ${name(c)}`, lens.columnDiffCounts[c] ?? 0));

    // Details: Status, the key, each compared column's value in each result, and what differs
    const detailColumns: ColumnDefinition[] = [column('status', 'Status')];
    keys.forEach((k, i) => detailColumns.push(asIs(`k${i}`, name(k))));
    columnsOut.forEach((c, i) => places.forEach(p => detailColumns.push(asIs(`c${i}_${p}`, `${name(c)} · ${placeLetter(p)}`))));
    detailColumns.push(column('differs', 'Differs in'));

    const at = new Map(lens.columns.map((c, i) => [c, i]));
    const details: TableRow[] = [];
    for (const index of input.indices) {
        const status = lens.status(index);
        const records = places.map(p => result.record(index, p));
        const src = records.find(Boolean) ?? {};
        const row: TableRow = { status: statusText(status) };
        keys.forEach((k, i) => { row[`k${i}`] = src[k] ?? null; });
        columnsOut.forEach((c, i) => places.forEach((p, v) => { row[`c${i}_${p}`] = records[v] ? records[v]![c] ?? null : null; }));
        const groups = status.diff.length ? lens.groups(index) : [];
        row.differs = status.diff.flatMap(p => compared.filter(c => {
            const g = groups[at.get(c)!];
            // BL the odd one out: where BL is unlike the others; otherwise where the result is unlike BL
            const against = p === 0 ? g.find((x, q) => q !== 0 && x >= 0) : g[0];
            return g[p] >= 0 && against !== undefined && against >= 0 && g[p] !== against;
        }).map(c => `${name(c)} (${placeLetter(p)})`)).join(', ');
        details.push(row);
    }
    return toSheets(summary, details, detailColumns, input.rowsPerSheet);
}

/** The Summary sheet, then the Details, running on into "Details 2" past a sheet's rows. */
function toSheets(summary: TableRow[], details: TableRow[], detailColumns: ColumnDefinition[], rowsPerSheet?: number): SheetDefinition[] {
    const sheets: SheetDefinition[] = [{ sheetName: 'Summary', data: summary, columns: [column('item', 'Item'), asIs('value', 'Value')] }];
    const per = rowsPerSheet ?? EXCEL_MAX_DATA_ROWS;
    for (let start = 0, n = 1; start < details.length; start += per, n++) {
        sheets.push({ sheetName: n === 1 ? 'Details' : `Details ${n}`, data: details.slice(start, start + per), columns: detailColumns });
    }
    return sheets;
}

/** A file name from the endpoint and the results, safe on every system. */
export function compareFileName(endpoint: string, labels: { a: string; b: string } | string[]): string {
    const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
    const sides = Array.isArray(labels) ? labels.join(' vs ') : `${labels.a} vs ${labels.b}`;
    return `${clean(`Compare ${endpoint} - ${sides}`).slice(0, 150)}.xlsx`;
}

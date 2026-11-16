// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Which rows go on each sheet of a Console Excel export.
 *
 * The Excel export writes three sheets — Input, Success, Errors — from the host's own
 * re-extraction of the response files (nothing tabular crosses the webview bridge). The
 * webview describes what it is showing on the CURRENT tab: its visible columns, its row
 * basis, its in-memory view and the search box. Those apply to that tab's sheet only; the
 * other two sheets are exported whole, as they always were.
 *
 * Pure, so the decision is testable without a webview or VS Code. The Excel branch used to
 * inline this and forgot two of the five arguments (the search term and the view), so a
 * filtered Completed tab reading "991 of 74,979 rows" exported all 74,979 while CSV and
 * Copy, which took the same message, exported 991.
 */
export type ConsoleTab = 'input' | 'success' | 'errors';

/** What the webview sends with `console.export_data` (see exportCurrentTab in console.html). */
export interface ExportRequestPayload {
    tab?: ConsoleTab | string;
    visibleColumnIds?: string[] | null;
    currentPath?: string;
    searchTerm?: string;
    view?: unknown;
    /** Issue #304: Input tab Result filter (all | completed | error | running | not_processed). */
    inputStatusFilter?: string;
}

/** The arguments for one ConsoleWebviewManager.extractTabData() call, in its order. */
export interface SheetExtraction {
    sheetName: 'Input' | 'Success' | 'Errors';
    tab: ConsoleTab;
    visibleColumnIds: string[] | null;
    overridePath: string | undefined;
    searchTerm: string | undefined;
    view: unknown;
    /** Issue #304: the Input sheet follows the Input tab's Result filter. */
    inputStatusFilter: string | undefined;
}

const SHEETS: ReadonlyArray<{ sheetName: SheetExtraction['sheetName']; tab: ConsoleTab }> = [
    { sheetName: 'Input', tab: 'input' },
    { sheetName: 'Success', tab: 'success' },
    { sheetName: 'Errors', tab: 'errors' }
];

export function excelSheetExtractions(payload: ExportRequestPayload): SheetExtraction[] {
    return SHEETS.map(({ sheetName, tab }) => {
        // Input is the raw CSV: never column-filtered, never searched — but
        // exported from the Input tab it keeps that tab's Result filter
        // (Issue #304: "Error" → Excel is the list of rows to send back).
        const current = tab !== 'input' && payload.tab === tab;
        const inputStatusFilter = tab === 'input' && payload.tab === 'input' && payload.inputStatusFilter
            && payload.inputStatusFilter !== 'all' ? payload.inputStatusFilter : undefined;
        return {
            sheetName,
            tab,
            visibleColumnIds: current && payload.visibleColumnIds ? payload.visibleColumnIds : null,
            overridePath: current && payload.currentPath ? payload.currentPath : undefined,
            searchTerm: current && payload.searchTerm && payload.searchTerm.trim() !== '' ? payload.searchTerm : undefined,
            view: current ? payload.view : undefined,
            inputStatusFilter
        };
    });
}

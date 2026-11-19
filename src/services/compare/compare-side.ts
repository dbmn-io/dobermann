// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: one side of a Compare — a saved result shaped by a Console View.
 *
 * Uses the Console's own table builder (the code the Console grid and its exports use), so
 * a side holds exactly the rows and columns the Console shows for that View. Only completed
 * responses count; error responses are left out (agreed for the first version).
 */
import * as consoleTableBuilderScript from '../../webviews/shared/console-table-builder.js';
import { sharedScript } from '../../utils/shared-script';
import type { CompareRowData } from './compare-engine';

const { createConsoleTableBuilder } = sharedScript<typeof consoleTableBuilderScript>(consoleTableBuilderScript, 'ConsoleTableBuilder');

/** A Console View, as saved on the endpoint (ConsoleViewSchema). */
export interface CompareView {
    name: string;
    rowBasis: string;
    columns: unknown[];
}

/** A column as the Console grid heads it: `id` is the path, `name` the header. */
export interface CompareColumn {
    id: string;
    name: string;
    /** 'array' for an expand cell (a list inside the row); its value compares by content. */
    type: string;
}

export interface CompareSide {
    columns: CompareColumn[];
    rows: CompareRowData[];
    /** Responses read, and how many of them were completed. */
    responseCount: number;
    completedCount: number;
}

interface TableBuilder {
    classifyResponses(responses: unknown[]): { success: unknown[]; errors: unknown[] };
    extractRowsForView(responses: unknown[], view: unknown): CompareRowData[];
    viewToLegacyColumnShape(view: unknown, sampleResponse?: unknown): Array<{ id: string; name: string; type: string }>;
}

let shared: TableBuilder | undefined;
function tableBuilder(): TableBuilder {
    shared ??= createConsoleTableBuilder() as unknown as TableBuilder;
    return shared;
}

/** The paths of the columns a View shows. */
export function viewColumnIds(view: CompareView): string[] {
    return tableBuilder().viewToLegacyColumnShape(view).map(c => c.id);
}

/** The View's rows and columns for one saved result's responses. */
export function buildCompareSide(responses: unknown[], view: CompareView): CompareSide {
    const builder = tableBuilder();
    const { success } = builder.classifyResponses(responses);
    const rows = builder.extractRowsForView(success, view);
    const columns = builder
        .viewToLegacyColumnShape(view, success[0])
        .map(c => ({ id: c.id, name: c.name, type: c.type }));
    return { columns, rows, responseCount: responses.length, completedCount: success.length };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch's Map: a column's functions (steps) on its first rows, for the Functions window and the Sample's
 * In and Out (James, 2026-11-25: "I want to see the output… Only on this screen"). Worked out here, on the host,
 * with the one definition of each step (column-functions.ts), so Map shows what is sent: the page holds no copy
 * of the rules. A step that names another column reads that column of the same row.
 */
import { applyColumnStep, asColumnValue, MAP_FUNCTIONS, type ColumnFn, type ColumnValue } from '../../services/column-functions/column-functions';

const OFFERED = new Set<string>(MAP_FUNCTIONS.map(f => f.id));

/**
 * What is sent for a value: every cell is trimmed on its way out (James, 2026-11-25: "trimming stays"; the send path's
 * csvCells trims each cell), so a column's Out, and what Validate holds, is its value after the steps, trimmed the same
 * way: Map's Out is what is sent, with or without a Trim spaces step (which trims spaces only, as SQLite does).
 */
export function asSent(value: ColumnValue): ColumnValue {
    return typeof value === 'string' ? value.trim() : value;
}

/** One row's value through the steps: as it came, after each step, and where a step couldn't read it. */
export interface MapSampleRow {
    before: ColumnValue;
    steps: ColumnValue[];
    after?: ColumnValue;
    failedAt?: number;
    failed?: string;
}

/** The column's value on each row through the steps (`rows` are the file's first rows, under `headers`). */
export function mapSample(fns: ColumnFn[], column: string, headers: string[], rows: unknown[][]): MapSampleRow[] {
    const at = headers.indexOf(column);
    return rows.map(row => {
        const col = (id: string): unknown => { const i = headers.indexOf(id); return i < 0 ? null : row[i]; };
        const before = asColumnValue(at < 0 ? null : row[at]);
        const steps: ColumnValue[] = [];
        let now = before;
        for (let i = 0; i < fns.length; i++) {
            const r = applyColumnStep(now, fns[i], col);
            if ('failed' in r) return { before, steps, failedAt: i, failed: r.failed };
            now = r.value;
            steps.push(now);
        }
        return { before, steps, after: asSent(now) };
    });
}

/** The steps as the page sends them, kept only when each is a step this build knows (a page never sends anything else). */
export function knownSteps(fns: unknown): ColumnFn[] {
    if (!Array.isArray(fns)) return [];
    return fns.filter((f): f is ColumnFn => !!f && typeof f === 'object' && OFFERED.has(String((f as { fn?: unknown }).fn)));
}

/** What Next to Validate asks: each variable's column and steps, and the file's columns they read (values by column name). */
export interface MapTranslateAsk {
    variables: { variable: string; column: string; fns: unknown }[];
    columns: Record<string, unknown[]>;
}
/** Each variable's values after its steps (what is stored and sent), and how many rows a step couldn't read. */
export interface MapTranslated {
    values: Record<string, unknown[]>;
    unread: Record<string, number>;
}

/**
 * The translated input (James, 2026-11-25: "we translate BEFORE we generate our Input file… Then the execution does not
 * need to do anything"): every row of each column with steps, through its steps, once, at Next to Validate. A value a
 * step can't read is kept as it came (Validate stops it, as for a value its type can't read); a blank stays blank.
 */
export function mapTranslate(ask: MapTranslateAsk): MapTranslated {
    const values: Record<string, unknown[]> = {};
    const unread: Record<string, number> = {};
    const columns = ask.columns || {};
    for (const v of ask.variables || []) {
        const fns = knownSteps(v.fns);
        const own = Array.isArray(columns[v.column]) ? columns[v.column] : [];
        let bad = 0;
        values[v.variable] = own.map((raw, row) => {
            const col = (id: string): unknown => (Array.isArray(columns[id]) ? columns[id][row] : null);
            let now = asColumnValue(raw);
            for (const f of fns) {
                const r = applyColumnStep(now, f, col);
                if ('failed' in r) { bad += 1; return raw; }
                now = r.value;
            }
            return asSent(now);
        });
        unread[v.variable] = bad;
    }
    return { values, unread };
}

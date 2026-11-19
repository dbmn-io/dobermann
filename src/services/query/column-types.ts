// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What kind of values a result's columns hold, going by a sample of its rows: a search box can
 * then offer what fits (yes or no: is, is not; a date: after, before, between), and a heading
 * sorts numbers as numbers. A kind never changes a value: values are shown as they arrived.
 *
 * A date is one written the ISO 8601 way only (2026-11-19, 2026-11-19T09:15:02Z, with or without
 * an offset): day and month forms like 11/12/2026 cannot be told apart, so they stay text.
 */
export type ColumnType = 'text' | 'number' | 'yesno' | 'date';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function kindOf(value: unknown): ColumnType {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'yesno';
    if (typeof value === 'string') {
        if (value === 'true' || value === 'false') return 'yesno';
        if (ISO_DATE.test(value)) return 'date';
    }
    return 'text';
}

/** Up to `max` of the rows, spread evenly from the first to the last. */
export function spread<T>(rows: T[], max: number): T[] {
    if (rows.length <= max) return rows;
    const step = rows.length / max;
    return Array.from({ length: max }, (_, i) => rows[Math.floor(i * step)]);
}

/** How many rows a column's kind is read from. */
export const TYPE_SAMPLE = 1000;

/**
 * A kind for each of `count` columns, from rows given as arrays in column order. A column is a
 * kind only when every value it has is that kind; blanks say nothing, and a column of blanks is text.
 */
export function columnTypes(rows: unknown[][], count: number): ColumnType[] {
    const types: ColumnType[] = [];
    for (let i = 0; i < count; i++) {
        let type: ColumnType | undefined;
        for (const row of rows) {
            const value = row[i];
            if (value === null || value === undefined || value === '') continue;
            const kind = kindOf(value);
            if (type === undefined) type = kind;
            else if (type !== kind) { type = 'text'; break; }
            if (type === 'text') break;
        }
        types.push(type ?? 'text');
    }
    return types;
}

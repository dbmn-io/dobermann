// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * One rule for looking a value up in a lookup table, for every place that does: Query's Translate values (the engine
 * holds to it: lookup-value tests), its dialog, and Run Batch's lookups (the Validate grid loads this file). The host
 * reads it through lookup-tables.ts, which re-exports it.
 *
 *  - The rows whose `from` column holds `value` exactly, as text: no trimming, letter case counts.
 *  - None: `{ kind: 'missing' }`.
 *  - One or more: `{ kind: 'found', value }`, the `to` column's value of the FIRST of them, top to bottom as the table
 *    keeps its rows; `rows` says how many matched when more than one did (the manager for James, 2026-11-23: "just pick
 *    one and move on", "if we're looking up, we pick the first one"). `to` left out: the value itself (is it in the column).
 *  - A column is named by its id, or by its name in any letter case.
 *
 * Pure: no page, no host. window.LookupValue in a page; module.exports for the host and the tests.
 */
(function () {
    'use strict';
    /** A table's column by id, or by name in any letter case. */
    function lookupColumn(table, ref) {
        const want = String(ref == null ? '' : ref);
        const columns = (table && table.columns) || [];
        return columns.find(c => c.id === want) || columns.find(c => String(c.name || '').toLowerCase() === want.toLowerCase());
    }
    /** `value` looked up: `{ kind: 'found', value, rows? }` or `{ kind: 'missing' }`. */
    function lookupValue(table, from, value, to) {
        const fromColumn = lookupColumn(table, from);
        const toColumn = to === undefined ? fromColumn : lookupColumn(table, to);
        if (!fromColumn || !toColumn) return { kind: 'missing' };
        const text = String(value == null ? '' : value);
        let first = null;
        let rows = 0;
        for (const row of (table && table.rows) || []) {
            const held = row[fromColumn.id];
            if ((held == null ? '' : held) !== text) continue;
            if (!first) first = row;
            rows++;
        }
        if (!first) return { kind: 'missing' };
        const got = first[toColumn.id];
        return Object.assign({ kind: 'found', value: got == null ? '' : got }, rows > 1 ? { rows } : {});
    }
    const api = { lookupColumn, lookupValue };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.LookupValue = api;
})();

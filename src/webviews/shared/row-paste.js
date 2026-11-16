// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Row Paste (GitHub Issue #302)
 *
 * Turns a spreadsheet / CSV row on the clipboard into values for a form.
 * The user copies a header row plus one data row out of Excel or a CSV and
 * pastes it into any field of the Run API values modal; every field whose
 * name matches a column is filled in one go.
 *
 * Rules (see the issue for the user-facing statement of them):
 *   - Two or more lines: line 1 is the header row, line 2 the values. Any
 *     further rows are ignored — only the first data row is used.
 *   - One line with a delimiter and exactly as many cells as fields: fill
 *     positionally (no header). Anything else is "not a row" and the caller
 *     should let the paste through untouched.
 *   - Columns match fields case-insensitively, ignoring `_`, `-`, `.` and
 *     spaces, so `location_gln`, `Location GLN` and `locationGln` all agree.
 *   - Delimiter is detected from the first line: tab wins (Excel copies
 *     TSV), then whichever of `,` / `;` occurs more often outside quotes.
 *   - Double-quoted cells are honoured, with `""` as an escaped quote.
 *
 * Pure functions only — NO DOM, NO VS Code API — so it is unit-testable and
 * runs in both the webview (window.RowPaste) and Node (module.exports).
 *
 * Used by:
 * - shared/dbmn-modal.js — `rowPaste: true` modals (Run API values form)
 */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.RowPaste = api;
    }
}(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    /**
     * Pick the delimiter for a line. Tab beats everything (Excel → TSV);
     * otherwise the more frequent of comma / semicolon outside quotes.
     * @param {string} line
     * @returns {string|null} '\t' | ',' | ';' | null when no delimiter found
     */
    function detectDelimiter(line) {
        if (typeof line !== 'string' || line.length === 0) return null;
        if (line.indexOf('\t') !== -1) return '\t';
        let commas = 0;
        let semis = 0;
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
            } else if (!inQuotes) {
                if (ch === ',') commas++;
                else if (ch === ';') semis++;
            }
        }
        if (commas === 0 && semis === 0) return null;
        return semis > commas ? ';' : ',';
    }

    /**
     * Split one line into cells, honouring double-quoted cells and `""`
     * escapes. Cells are trimmed of surrounding whitespace.
     * @param {string} line
     * @param {string} delimiter
     * @returns {string[]}
     */
    function splitLine(line, delimiter) {
        const cells = [];
        let cell = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (line[i + 1] === '"') { cell += '"'; i++; }
                    else inQuotes = false;
                } else {
                    cell += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === delimiter) {
                cells.push(cell.trim());
                cell = '';
            } else {
                cell += ch;
            }
        }
        cells.push(cell.trim());
        return cells;
    }

    /**
     * Canonical form for column ↔ field matching: lowercase, letters and
     * digits only.
     * @param {string} name
     * @returns {string}
     */
    function normaliseKey(name) {
        return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    /**
     * Parse clipboard text into a header/values pair.
     * @param {string} text
     * @returns {{ mode: 'header'|'positional', headers: string[]|null, values: string[], delimiter: string, rowCount: number }|null}
     *   null when the text is not a delimited row at all (single value, empty).
     */
    function parseRowPaste(text) {
        if (typeof text !== 'string') return null;
        const lines = text.replace(/\r\n?/g, '\n').split('\n')
            .map(l => l.replace(/\s+$/, ''))
            .filter(l => l.length > 0);
        if (lines.length === 0) return null;

        const delimiter = detectDelimiter(lines[0]);
        if (!delimiter) return null;

        if (lines.length >= 2) {
            return {
                mode: 'header',
                headers: splitLine(lines[0], delimiter),
                values: splitLine(lines[1], delimiter),
                delimiter,
                rowCount: lines.length - 1
            };
        }
        return {
            mode: 'positional',
            headers: null,
            values: splitLine(lines[0], delimiter),
            delimiter,
            rowCount: 1
        };
    }

    /**
     * Map a parsed row onto a list of field ids.
     * @param {ReturnType<typeof parseRowPaste>} parsed
     * @param {string[]} fieldIds  ids of the form's fields, in display order
     * @returns {{ filled: Record<string,string>, unmatchedColumns: string[], unfilledFields: string[] }|null}
     *   null means "do not intercept the paste" — nothing matched, or a
     *   positional row whose cell count doesn't equal the field count.
     */
    function matchFields(parsed, fieldIds) {
        if (!parsed || !Array.isArray(fieldIds) || fieldIds.length === 0) return null;
        const filled = {};

        if (parsed.mode === 'positional') {
            if (parsed.values.length < 2 || parsed.values.length !== fieldIds.length) return null;
            fieldIds.forEach((id, i) => { filled[id] = parsed.values[i]; });
            return { filled, unmatchedColumns: [], unfilledFields: [] };
        }

        const byKey = {};
        fieldIds.forEach(id => { byKey[normaliseKey(id)] = id; });
        const unmatchedColumns = [];
        parsed.headers.forEach((header, i) => {
            const id = byKey[normaliseKey(header)];
            if (id === undefined || header === '') {
                if (header !== '') unmatchedColumns.push(header);
                return;
            }
            // First column wins if a header repeats.
            if (!(id in filled)) filled[id] = parsed.values[i] == null ? '' : parsed.values[i];
        });
        if (Object.keys(filled).length === 0) return null;
        const unfilledFields = fieldIds.filter(id => !(id in filled));
        return { filled, unmatchedColumns, unfilledFields };
    }

    /**
     * One-call convenience: clipboard text + field ids → fill result or null.
     * @param {string} text
     * @param {string[]} fieldIds
     */
    function fillFromPaste(text, fieldIds) {
        return matchFields(parseRowPaste(text), fieldIds);
    }

    return { detectDelimiter, splitLine, normaliseKey, parseRowPaste, matchFields, fillFromPaste };
}));

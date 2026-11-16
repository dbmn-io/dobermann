// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Line Block
 *
 * Ctrl+D in the endpoint body deletes the line the cursor is on. When that line
 * OPENS an object or array (`"buyer": {`, `"lines": [`), deleting just the one
 * line leaves the JSON broken, so Ctrl+D takes the whole block instead: the
 * opening line down to its matching close. If the block was the last member of
 * its parent (its closing line has no comma), the comma on the member before it
 * is removed too, so the body stays valid.
 *
 * Structure is read per line with strings, `{{template}}` variables and `//`
 * comments masked, so braces inside them never count.
 *
 * Pure functions only — NO DOM, NO VS Code API — so it is unit-testable and
 * runs in both the webview (window.LineBlock) and Node (module.exports).
 *
 * Used by:
 * - endpoint/endpoint.js — deleteCurrentLine (Ctrl+D and the Delete button)
 */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.LineBlock = api;
    }
}(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    /**
     * The line with string contents and `{{…}}` replaced by `x` and any `//`
     * comment cut off. Columns up to the cut are unchanged.
     * @param {string} line
     * @returns {string}
     */
    function mask(line) {
        let out = '';
        let inString = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inString) {
                if (ch === '\\') { out += 'xx'; i++; continue; }
                if (ch === '"') { inString = false; out += ch; continue; }
                out += 'x';
                continue;
            }
            if (ch === '"') { inString = true; out += ch; continue; }
            if (ch === '/' && line[i + 1] === '/') break;
            if (ch === '{' && line[i + 1] === '{') {
                const close = line.indexOf('}}', i + 2);
                const end = close === -1 ? line.length : close + 2;
                out += 'x'.repeat(end - i);
                i = end - 1;
                continue;
            }
            out += ch;
        }
        return out;
    }

    function depthChange(masked) {
        let d = 0;
        for (const ch of masked) {
            if (ch === '{' || ch === '[') d++;
            else if (ch === '}' || ch === ']') d--;
        }
        return d;
    }

    /**
     * The block opened by line `lineNumber`, or null when that line opens nothing
     * (the caller then deletes the single line as before).
     * @param {string[]} lines
     * @param {number} lineNumber 1-based
     * @returns {{ startLine: number, endLine: number, commaAt: { line: number, column: number } | null } | null}
     *          1-based lines; commaAt is the 1-based column of a comma to remove.
     */
    function findBlock(lines, lineNumber) {
        const start = lineNumber - 1;
        const opener = mask(lines[start] ?? '').trimEnd();
        const last = opener[opener.length - 1];
        if (last !== '{' && last !== '[') return null;

        let depth = depthChange(opener);
        if (depth <= 0) return null;
        let end = -1;
        for (let i = start + 1; i < lines.length; i++) {
            depth += depthChange(mask(lines[i]));
            if (depth <= 0) { end = i; break; }
        }
        if (end === -1) return null;

        let commaAt = null;
        if (!mask(lines[end]).trimEnd().endsWith(',')) {
            for (let p = start - 1; p >= 0; p--) {
                const m = mask(lines[p]).trimEnd();
                if (m.trim() === '') continue;
                if (m.endsWith(',')) commaAt = { line: p + 1, column: m.length };
                break;
            }
        }
        return { startLine: start + 1, endLine: end + 1, commaAt };
    }

    return { mask, findBlock };
}));

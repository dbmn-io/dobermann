// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Template Rename
 *
 * Run Batch → Map & Transform → "Update Endpoint Template": rename the template's variables
 * to the source columns they were mapped to, so the next file with those columns maps itself
 * (`{{buyerGln}}` mapped to `location.gln` becomes `{{location.gln}}`).
 *
 * Variable names allow letters, digits, spaces, `-`, `_` and `.` (TemplateParser
 * .isValidVariableName), so a column name is kept as it is; anything else (`Unit Price ($)`)
 * becomes `_`. Name matching in Map & Transform ignores punctuation either way.
 *
 * Pure functions only — NO DOM, NO VS Code API — so it is unit-testable and runs in both the
 * webview (window.TemplateRename) and the extension (module.exports).
 *
 * Used by:
 * - shared/data-transformer.js — which renames to offer, and when (Step 2)
 * - run-batch/run-batch-webview.ts — applies them to the endpoint after the batch has run
 */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.TemplateRename = api;
    }
}(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    const isSystem = (name) => /^(A8|ENV)(:|$)/i.test(String(name || '').trim());

    /**
     * A valid variable name for a column, or null when nothing usable is left.
     * @param {string} column
     * @returns {string|null}
     */
    function variableNameForColumn(column) {
        let name = String(column || '').trim()
            .replace(/[^A-Za-z0-9_.-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^[_.]+|[_.]+$/g, '');
        if (!name) return null;
        if (/^[0-9]/.test(name)) name = '_' + name;   // a variable name cannot start with a digit
        return name;
    }

    /**
     * The renames a mapping implies: each variable mapped to a column with a different name.
     * Skipped: system variables (A8, ENV), a new name another variable already has, and a
     * second variable mapped to the same column (both cannot take one name).
     * @param {Array<{name: string, mappedTo?: string|null}>} variables
     * @returns {Object<string, string>} old name → new name
     */
    function renamesForMappings(variables) {
        const list = (variables || []).filter(v => v && v.name && !isSystem(v.name));
        const taken = new Set(list.map(v => v.name));
        const renames = {};
        for (const v of list) {
            if (!v.mappedTo) continue;
            const next = variableNameForColumn(v.mappedTo);
            if (!next || next === v.name || taken.has(next)) continue;
            renames[v.name] = next;
            taken.add(next);
        }
        return renames;
    }

    /**
     * Rename variables in template text: `{{old}}`, `{{old:type|mods}}`, and the shorthand
     * `"old": "{{}}"` / `"old": "{{:type}}"`, whose name is its key. A8 and ENV are untouched.
     * @param {string} text
     * @param {Object<string, string>} renames
     * @returns {string}
     */
    function renameVariablesInText(text, renames) {
        if (typeof text !== 'string' || !renames || Object.keys(renames).length === 0) return text;
        const has = (name) => Object.prototype.hasOwnProperty.call(renames, name);
        // Shorthand first: the key names the variable.
        let out = text.replace(/"([^"\\]+)"(\s*:\s*"?)\{\{(\s*)((?::[^{}]*)?)\}\}/g,
            (match, key, sep, space, rest) => (has(key) ? `"${key}"${sep}{{${renames[key]}${rest}}}` : match));
        // Explicit names: `{{name` followed by `:`, `|` or `}}`.
        out = out.replace(/\{\{(\s*)([^{}:|]+?)(\s*)(?=[:|]|\}\})/g,
            (match, lead, name, trail) => (has(name) ? `{{${renames[name]}` : match));
        return out;
    }

    /** Every string in a value — plain, array or object — renamed. */
    function renameDeep(value, renames) {
        if (typeof value === 'string') return renameVariablesInText(value, renames);
        if (Array.isArray(value)) return value.map(v => renameDeep(v, renames));
        if (value && typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) out[k] = renameDeep(v, renames);
            return out;
        }
        return value;
    }

    /**
     * The endpoint with its variables renamed wherever they can appear — body (both copies),
     * path, query parameters, headers, the Run Batch template — and its remembered mapping
     * (dataLoadingConfig.columnMappings) moved to the new names.
     * @param {Object} endpoint
     * @param {Object<string, string>} renames
     * @returns {Object}
     */
    function renameInEndpoint(endpoint, renames) {
        if (!endpoint || !renames || Object.keys(renames).length === 0) return endpoint;
        const next = { ...endpoint };
        for (const key of ['body', 'bodyWithComments', 'path']) {
            if (typeof next[key] === 'string') next[key] = renameVariablesInText(next[key], renames);
        }
        if (next.queryParams) next.queryParams = renameDeep(next.queryParams, renames);
        if (next.headers) next.headers = renameDeep(next.headers, renames);
        if (next.dataLoadingConfig) {
            const dlc = { ...next.dataLoadingConfig };
            if (typeof dlc.jsonTemplate === 'string') dlc.jsonTemplate = renameVariablesInText(dlc.jsonTemplate, renames);
            if (dlc.columnMappings) {
                const mappings = { ...dlc.columnMappings };
                for (const [from, to] of Object.entries(renames)) {
                    if (Object.prototype.hasOwnProperty.call(mappings, from)) {
                        mappings[to] = mappings[from];
                        delete mappings[from];
                    }
                }
                dlc.columnMappings = mappings;
            }
            next.dataLoadingConfig = dlc;
        }
        return next;
    }

    /** Name matching that ignores case and punctuation: `location_gln` matches `location.gln`. */
    function looseName(name) {
        return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    return { variableNameForColumn, renamesForMappings, renameVariablesInText, renameInEndpoint, looseName };
}));

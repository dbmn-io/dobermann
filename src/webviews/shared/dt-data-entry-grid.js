// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Transformer Module: Grid Data Entry
 * GitHub Issue #195: Extracted from data-transformer.js
 *
 * Run Batch's Validate step: the rows to run, in the design system's table (dbmn-table.js):
 * - Template variable extraction and parsing
 * - The grid's rows (csvState.gridDataModel), adding and deleting them
 * - Tab's copying a level at a time, Ctrl+D
 * - Paste (Excel/spreadsheet, CSV, pipes)
 * - Undo
 * - The checks (modifiers, required cells) and the errors filter
 * - Date/time input formatting
 */
(function () {
    'use strict';

    // Module-level references (set via init)
    let csvState = null;
    let getVscode = null;

    // =========================================================================
    // GitHub Issue #129: Grid Data Entry Functions
    // =========================================================================

    /**
     * GitHub Issue #175: Parse modifiers from a modifier string
     * Lightweight JavaScript implementation for webview use
     *
     * @param {string} modifierString - The modifier portion (e.g., "3-50|upper|opt")
     * @param {string} dataType - The data type of the variable
     * @returns {Object} Parsed modifiers with constraints and flags
     */
    function parseModifiersForGrid(modifierString, dataType) {
        const result = {
            raw: modifierString,
            isOptional: false,      // opt modifier - field can be empty
            isNullable: false,      // null modifier - pass null if empty
            minLength: null,        // String: minimum length
            maxLength: null,        // String: maximum length
            exactLength: null,      // String: exact length required
            minValue: null,         // Number: minimum value (>= or >)
            maxValue: null,         // Number: maximum value (<= or <)
            minExclusive: false,    // Number: > instead of >=
            maxExclusive: false,    // Number: < instead of <=
            isInteger: false,       // Number: must be integer
            roundTo: null,          // Number: round to N decimals
            toUpper: false,         // String: convert to uppercase
            toLower: false,         // String: convert to lowercase
            dateMath: null,         // Date: date math expression (e.g., "+2d")
            ifBlank: null,          // ifblank:'text' - what a blank becomes (so a blank is fine)
            problem: null,          // the template written so it can't be used (an unquoted ifblank): every row says it
            lookups: [],            // the list / lookup types' table: { table, from, to? } (from '' = its one column)
            hints: []               // Human-readable hints for display
        };

        if (!modifierString || modifierString.trim() === '') {
            return result;
        }

        const parts = modifierString.split('|').map(s => s.trim()).filter(s => s.length > 0);

        // `list` and `lookup` types (James, 2026-11-23): the first part is the table and its columns
        // ({{uom:list|uom:wms}}, {{uom:list|uom}}, {{uom:lookup|uom:tms>wms}}); the rest are modifiers
        // (the host reads a JSON body's {{uom:lookup|uom:tms>wms}} as a string with `lookup:uom:tms>wms` first: the same)
        var kind = dataType === 'list' || dataType === 'lookup' ? dataType : null;
        var tagged = !kind && parts.length ? /^(list|lookup):(.*)$/i.exec(parts[0]) : null;
        if (tagged) { kind = tagged[1].toLowerCase(); parts[0] = tagged[2]; }
        if (kind && parts.length) {
            var spec = parts.shift().split(':');
            var cols = spec.slice(1).join(':').split('>');
            var lu = { kind: kind, table: (spec[0] || '').trim(), from: (cols[0] || '').trim(), to: kind === 'lookup' && cols.length > 1 ? (cols[1] || '').trim() : undefined };
            result.lookups.push(lu);
            result.listKind = kind;
            // Said as what it is (James, 2026-11-23: "is this a list or a lookup we're doing here?")
            result.hints.push(lu.to !== undefined ? 'a lookup in ' + lu.table + ': ' + lu.from + ' → ' + lu.to : 'a list from ' + lu.table + (lu.from ? "'s " + lu.from : ''));
        }

        for (const part of parts) {
            const partLower = part.toLowerCase();

            // Empty value behavior - NOT validation rules (don't add to hints)
            if (partLower === 'opt') {
                result.isOptional = true;
                // Don't add 'optional' to hints - it shows as ○ indicator instead
                continue;
            }
            if (partLower.indexOf('ifblank:') === 0) {
                // The text in single quotes, and only in them (as modifier-parser.ts): else every row says how to write it
                var text = part.slice(8).trim();
                var quoted = /^'(.*)'$/.exec(text);
                if (quoted) {
                    result.ifBlank = quoted[1];
                    result.hints.push("a blank becomes '" + result.ifBlank + "'");
                } else {
                    var bare = text.replace(/^["'](.*)["']$/, '$1').replace(/^["']|["']$/g, '');
                    result.problem = bare ? "Put the text in quotes: ifblank:'" + bare + "'" : "ifblank needs the text a blank becomes, in quotes: ifblank:'none'";
                }
                continue;
            }
            if (partLower === 'null') {
                result.isNullable = true;
                // Don't add 'nullable' to hints - it shows as ○ indicator instead
                continue;
            }


            // String modifiers
            if (dataType === 'string') {
                // upper/lower/notrim are TRANSFORMS - don't add to hints (not validation)
                if (partLower === 'upper') {
                    result.toUpper = true;
                    continue;
                }
                if (partLower === 'lower') {
                    result.toLower = true;
                    continue;
                }
                if (partLower === 'notrim') {
                    // Transform, not validation (but spaces then aren't blank: ifblank leaves them)
                    result.noTrim = true;
                    continue;
                }

                // Exact length: just a number (e.g., "10")
                const exactMatch = part.match(/^(\d+)$/);
                if (exactMatch) {
                    result.exactLength = parseInt(exactMatch[1], 10);
                    result.minLength = result.exactLength;
                    result.maxLength = result.exactLength;
                    result.hints.push(`exactly ${result.exactLength} chars`);
                    continue;
                }

                // Length range: n-m (e.g., "3-50")
                const rangeMatch = part.match(/^(\d+)-(\d+)$/);
                if (rangeMatch) {
                    result.minLength = parseInt(rangeMatch[1], 10);
                    result.maxLength = parseInt(rangeMatch[2], 10);
                    result.hints.push(`${result.minLength}-${result.maxLength} chars`);
                    continue;
                }

                // Min length: n- (e.g., "3-")
                const minMatch = part.match(/^(\d+)-$/);
                if (minMatch) {
                    result.minLength = parseInt(minMatch[1], 10);
                    result.hints.push(`min ${result.minLength} chars`);
                    continue;
                }

                // Max length: -n (e.g., "-50")
                const maxMatch = part.match(/^-(\d+)$/);
                if (maxMatch) {
                    result.maxLength = parseInt(maxMatch[1], 10);
                    result.hints.push(`max ${result.maxLength} chars`);
                    continue;
                }
            }

            // Number modifiers
            if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
                if (partLower === 'int') {
                    result.isInteger = true;
                    result.hints.push('integer');
                    continue;
                }
                // floor, ceil, rnd are TRANSFORMS not validations - don't add to hints
                if (partLower === 'floor' || partLower === 'ceil') {
                    continue;
                }

                // Round: rnd(n) - TRANSFORM not validation, don't restrict input
                const roundMatch = part.match(/^rnd\((\d+)\)$/i);
                if (roundMatch) {
                    result.roundTo = parseInt(roundMatch[1], 10);
                    // Don't add to hints - transforms don't affect what user can enter
                    continue;
                }

                // Greater than or equal: >=n
                const geMatch = part.match(/^>=(-?\d+\.?\d*)$/);
                if (geMatch) {
                    result.minValue = parseFloat(geMatch[1]);
                    result.minExclusive = false;
                    result.hints.push(`≥${result.minValue}`);
                    continue;
                }

                // Greater than: >n
                const gtMatch = part.match(/^>(-?\d+\.?\d*)$/);
                if (gtMatch) {
                    result.minValue = parseFloat(gtMatch[1]);
                    result.minExclusive = true;
                    result.hints.push(`>${result.minValue}`);
                    continue;
                }

                // Less than or equal: <=n
                const leMatch = part.match(/^<=(-?\d+\.?\d*)$/);
                if (leMatch) {
                    result.maxValue = parseFloat(leMatch[1]);
                    result.maxExclusive = false;
                    result.hints.push(`≤${result.maxValue}`);
                    continue;
                }

                // Less than: <n
                const ltMatch = part.match(/^<(-?\d+\.?\d*)$/);
                if (ltMatch) {
                    result.maxValue = parseFloat(ltMatch[1]);
                    result.maxExclusive = true;
                    result.hints.push(`<${result.maxValue}`);
                    continue;
                }
            }

            // Date math modifiers (for date/datetime types)
            // Supports: d=days, w=weeks, M=months, y=years, h=hours, m=minutes
            // Note: case-sensitive to distinguish M (months) from m (minutes)
            if (dataType === 'date' || dataType === 'datetime') {
                const dateMathMatch = part.match(/^([+-]\d+)([dwMyhm])$/);
                if (dateMathMatch) {
                    result.dateMath = part;
                    const amount = dateMathMatch[1];
                    const unit = dateMathMatch[2];
                    const unitNames = {
                        'd': 'days',
                        'w': 'weeks',
                        'M': 'months',
                        'y': 'years',
                        'h': 'hours',
                        'm': 'minutes'
                    };
                    result.hints.push(`${amount} ${unitNames[unit] || unit}`);
                    continue;
                }
            }
        }

        return result;
    }

    /**
     * GitHub Issue #175: Parse template variable content to extract type, format, and modifiers
     * Handles syntax: {{VAR:type:format|modifier1|modifier2}}
     *
     * @param {string} content - Content inside {{ }} (e.g., "Name:string|3-50|upper")
     * @returns {Object} Parsed result with dataType, formatModifier, and modifierString
     */
    function parseTemplateVariableContent(content) {
        // Find pipe position (start of modifiers)
        const pipeIndex = content.indexOf('|');
        const modifierString = pipeIndex !== -1 ? content.substring(pipeIndex + 1) : '';
        const beforePipe = pipeIndex !== -1 ? content.substring(0, pipeIndex) : content;

        // Split the before-pipe portion by colons
        const parts = beforePipe.split(':');
        const varName = parts[0] ? parts[0].trim() : '';
        let dataType = 'string';
        let formatModifier = '';

        if (parts.length === 2) {
            // {{VAR:type}} or {{VAR:type|modifiers}}
            dataType = parts[1].trim().toLowerCase();
        } else if (parts.length >= 3) {
            // {{VAR:type:format}} or {{VAR:type:format|modifiers}}
            dataType = parts[1].trim().toLowerCase();
            formatModifier = parts.slice(2).join(':').trim(); // Join in case format has colons
        }

        return {
            varName,
            dataType,
            formatModifier,
            modifierString
        };
    }

    /**
     * Extract template variables from endpoint configuration
     * Parses body, URL path, headers, and query params for {{VARIABLE}} patterns
     * Also handles inferred variables like {{}} where name comes from JSON key
     * Variables are returned in order of appearance in the template
     */
    function extractTemplateVariablesFromEndpoint(endpoint) {
        if (!endpoint) return [];

        const variables = new Map(); // Use Map to dedupe by name and maintain order

        // GitHub Issue #129, #137: Extract ALL variables from body in DOCUMENT ORDER
        // Single pass approach to maintain the exact order variables appear in the template
        // This is critical for grouping functionality
        const extractAllFromBody = (jsonStr) => {
            if (!jsonStr || typeof jsonStr !== 'string') return;

            // Helper: Find the JSON key that precedes this position
            // Used for inferring variable names from {{}} or {{:type}}
            const findPrecedingJsonKey = (str, position) => {
                // Look backwards from position to find "key": pattern
                const before = str.substring(0, position);
                // Match the last "key": before this position, allowing for whitespace and the opening quote
                const keyMatch = before.match(/"([^"]+)"\s*:\s*"?[^"]*$/);
                return keyMatch ? keyMatch[1] : null;
            };

            // SINGLE PASS: Find ALL {{...}} patterns in document order
            const varRegex = /\{\{([^}]*)\}\}/g;
            let match;

            while ((match = varRegex.exec(jsonStr)) !== null) {
                const content = match[1].trim();
                const position = match.index;

                // Skip A8 special variables EARLY (before splitting on :)
                // e.g., {{A8:SEQUENCE}} - content is "A8:SEQUENCE"
                if (content.toUpperCase().startsWith('A8:')) continue;

                // GitHub Issue #165: Skip ENV variables - they come from environment, not user input
                // e.g., {{ENV:myVar}} - content is "ENV:myVar"
                if (content.toUpperCase().startsWith('ENV:')) continue;

                let varName, dataType, modifierString = '';

                if (!content || content.startsWith(':')) {
                    // Inferred: {{}} or {{:type}} or {{:type|modifiers}} - need to find key name
                    const keyName = findPrecedingJsonKey(jsonStr, position);
                    if (!keyName) continue; // Can't infer without a key

                    varName = keyName;
                    if (content.startsWith(':')) {
                        // GitHub Issue #175: Parse type and modifiers
                        const parsed = parseTemplateVariableContent(keyName + content);
                        dataType = parsed.dataType;
                        modifierString = parsed.modifierString;
                    } else {
                        dataType = 'string';
                    }
                } else {
                    // Explicit: {{VAR}} or {{VAR:type}} or {{VAR:type|modifiers}}
                    // GitHub Issue #175: Parse type and modifiers
                    const parsed = parseTemplateVariableContent(content);
                    varName = parsed.varName;
                    dataType = parsed.dataType;
                    modifierString = parsed.modifierString;
                }

                // GitHub Issue #175: Parse modifiers
                const modifiers = parseModifiersForGrid(modifierString, dataType);

                // Add to map (maintains insertion order, dedupes by name)
                if (varName && !variables.has(varName)) {
                    variables.set(varName, {
                        name: varName,
                        dataType: dataType,
                        source: 'body',
                        modifierString: modifierString,
                        modifiers: modifiers
                    });
                }
            }
        };

        // Helper to extract from non-JSON strings (URL path, headers, etc.)
        const extractFrom = (str, source) => {
            if (!str || typeof str !== 'string') return;
            const variableRegex = /\{\{([^}]+)\}\}/g;
            let match;
            while ((match = variableRegex.exec(str)) !== null) {
                const content = match[1].trim();
                if (!content) continue;

                // Skip A8 special variables EARLY (before splitting on :)
                if (content.toUpperCase().startsWith('A8:')) continue;

                // GitHub Issue #165: Skip ENV variables - they come from environment
                if (content.toUpperCase().startsWith('ENV:')) continue;

                // GitHub Issue #175: Parse type and modifiers
                const parsed = parseTemplateVariableContent(content);
                const modifiers = parseModifiersForGrid(parsed.modifierString, parsed.dataType);

                if (parsed.varName && !variables.has(parsed.varName)) {
                    variables.set(parsed.varName, {
                        name: parsed.varName,
                        dataType: parsed.dataType,
                        source: source,
                        modifierString: parsed.modifierString,
                        modifiers: modifiers
                    });
                }
            }
        };

        // Extract from body first (main source, maintains order)
        if (endpoint.body) {
            extractAllFromBody(endpoint.body);
        }

        // Extract from URL path
        if (endpoint.path) {
            extractFrom(endpoint.path, 'path');
        }

        // Extract from headers
        if (endpoint.headers) {
            Object.values(endpoint.headers).forEach(value => {
                if (typeof value === 'string') {
                    extractFrom(value, 'header');
                } else if (value && typeof value.value === 'string') {
                    extractFrom(value.value, 'header');
                }
            });
        }

        // Extract from query params
        if (endpoint.queryParams) {
            Object.values(endpoint.queryParams).forEach(value => {
                if (typeof value === 'string') {
                    extractFrom(value, 'queryParam');
                } else if (value && typeof value.value === 'string') {
                    extractFrom(value.value, 'queryParam');
                }
            });
        }

        return Array.from(variables.values());
    }

    /**
     * Analyze JSON template to determine nesting levels for variables
     * Returns: { l1Fields: [colIndex], l2Fields: [colIndex], l3Fields: [colIndex], l4Fields: [colIndex] }
     * where colIndex refers to the column index in the grid (0-based, excluding row number column)
     * GitHub Issue #146: Added L4 support for 4-level nested templates
     */
    function analyzeGridNestingLevels(endpoint, variables) {
        if (!endpoint || !endpoint.body || variables.length === 0) {
            return null;
        }

        try {
            const body = endpoint.body;
            const parsed = JSON.parse(body);

            // Find all arrays and their nesting depth
            const arrayPaths = [];

            const findArrays = (obj, path = '', depth = 0) => {
                if (Array.isArray(obj)) {
                    arrayPaths.push({ path, depth, content: obj[0] });
                    if (obj.length > 0 && typeof obj[0] === 'object') {
                        findArrays(obj[0], path + '[]', depth + 1);
                    }
                } else if (obj && typeof obj === 'object') {
                    Object.entries(obj).forEach(([key, value]) => {
                        const newPath = path ? `${path}.${key}` : key;
                        findArrays(value, newPath, depth);
                    });
                }
            };

            findArrays(parsed);

            // No arrays = no nesting
            if (arrayPaths.length === 0) {
                return null;
            }

            // Map variables to their nesting level based on where they appear
            const variableLevels = new Map();

            // Helper to find variables at a given level
            // GitHub Issue #146: Support empty placeholders {{}} and shorthand {{:type}}
            const findVarsAtLevel = (obj, level) => {
                const vars = [];
                const varRegex = /\{\{([^}]*)\}\}/g;  // Allow empty content
                const str = JSON.stringify(obj);
                let match;
                while ((match = varRegex.exec(str)) !== null) {
                    const content = match[1].trim();
                    if (!content.toUpperCase().startsWith('A8:') && !content.toUpperCase().startsWith('ENV:')) {
                        // Extract variable name (handle shorthand syntax)
                        let varName;
                        if (!content || content.startsWith(':')) {
                            // For empty {{}} or {{:type}}, we can't infer here without key context
                            // These are handled in the level-specific processing below
                            continue;
                        } else {
                            varName = content.split(':')[0].trim();
                        }
                        if (varName && !variableLevels.has(varName)) {
                            variableLevels.set(varName, level);
                            vars.push(varName);
                        }
                    }
                }
                return vars;
            };

            // Level 1 (L1): Root level variables (outside all arrays)
            // Extract root keys that are not arrays
            // GitHub Issue #146: Support empty {{}} and shorthand {{:type}} placeholders
            Object.entries(parsed).forEach(([key, value]) => {
                if (!Array.isArray(value) && typeof value === 'string') {
                    const match = value.match(/\{\{([^}]*)\}\}/);  // Allow empty content
                    if (match) {
                        const content = match[1].trim();
                        if (!content.toUpperCase().startsWith('A8:') && !content.toUpperCase().startsWith('ENV:')) {
                            // Infer name from key for empty {{}} or {{:type}} patterns
                            const varName = (!content || content.startsWith(':')) ? key : content.split(':')[0].trim();
                            if (varName && !variableLevels.has(varName)) {
                                variableLevels.set(varName, 1);
                            }
                        }
                    }
                }
            });

            // Level 2 (L2): Variables inside the first array level
            // GitHub Issue #146: Support empty {{}} and shorthand {{:type}} placeholders
            if (arrayPaths.length >= 1 && arrayPaths[0].content) {
                const firstArrayContent = arrayPaths[0].content;
                if (typeof firstArrayContent === 'object') {
                    Object.entries(firstArrayContent).forEach(([key, value]) => {
                        if (!Array.isArray(value) && typeof value === 'string') {
                            const match = value.match(/\{\{([^}]*)\}\}/);  // Allow empty content
                            if (match) {
                                const content = match[1].trim();
                                if (!content.toUpperCase().startsWith('A8:') && !content.toUpperCase().startsWith('ENV:')) {
                                    // Infer name from key for empty {{}} or {{:type}} patterns
                                    const varName = (!content || content.startsWith(':')) ? key : content.split(':')[0].trim();
                                    if (varName && !variableLevels.has(varName)) {
                                        variableLevels.set(varName, 2);
                                    }
                                }
                            }
                        }
                    });
                }
            }

            // Level 3 (L3): Variables inside nested arrays (2nd level arrays, depth 1)
            // GitHub Issue #146: Support empty {{}} and shorthand {{:type}} placeholders
            const nestedArrayPath = arrayPaths.find(a => a.depth === 1);
            if (nestedArrayPath && nestedArrayPath.content) {
                if (typeof nestedArrayPath.content === 'object') {
                    Object.entries(nestedArrayPath.content).forEach(([key, value]) => {
                        if (typeof value === 'string') {
                            const match = value.match(/\{\{([^}]*)\}\}/);  // Allow empty content
                            if (match) {
                                const content = match[1].trim();
                                if (!content.toUpperCase().startsWith('A8:') && !content.toUpperCase().startsWith('ENV:')) {
                                    // Infer name from key for empty {{}} or {{:type}} patterns
                                    const varName = (!content || content.startsWith(':')) ? key : content.split(':')[0].trim();
                                    if (varName && !variableLevels.has(varName)) {
                                        variableLevels.set(varName, 3);
                                    }
                                }
                            }
                        }
                    });
                }
            }

            // Level 4 (L4): Variables inside 3rd level arrays (depth 2)
            // GitHub Issue #146: Support 4-level nested templates
            const deepNestedArrayPath = arrayPaths.find(a => a.depth === 2);
            if (deepNestedArrayPath && deepNestedArrayPath.content) {
                if (typeof deepNestedArrayPath.content === 'object') {
                    Object.entries(deepNestedArrayPath.content).forEach(([key, value]) => {
                        if (typeof value === 'string') {
                            const match = value.match(/\{\{([^}]*)\}\}/);  // Allow empty content
                            if (match) {
                                const content = match[1].trim();
                                if (!content.toUpperCase().startsWith('A8:') && !content.toUpperCase().startsWith('ENV:')) {
                                    // Infer name from key for empty {{}} or {{:type}} patterns
                                    const varName = (!content || content.startsWith(':')) ? key : content.split(':')[0].trim();
                                    if (varName && !variableLevels.has(varName)) {
                                        variableLevels.set(varName, 4);
                                    }
                                }
                            }
                        }
                    });
                }
            }

            // Build field index arrays for each level
            const l1Fields = [];
            const l2Fields = [];
            const l3Fields = [];
            const l4Fields = [];

            variables.forEach((v, index) => {
                const level = variableLevels.get(v.name);
                if (level === 1) l1Fields.push(index);
                else if (level === 2) l2Fields.push(index);
                else if (level === 3) l3Fields.push(index);
                else if (level === 4) l4Fields.push(index);
            });

            // GitHub Issue #146: Return nesting info if we have variables at ANY level
            // This allows templates with all variables inside arrays (no root-level vars)
            if (l1Fields.length === 0 && l2Fields.length === 0 && l3Fields.length === 0 && l4Fields.length === 0) {
                return null;
            }

            return { l1Fields, l2Fields, l3Fields, l4Fields };
        } catch (e) {
            console.warn('[Grid] Failed to analyze nesting levels:', e);
            return null;
        }
    }

    // =========================================================================
    // Validate's grid: the rows to run, in the design system's table (<dbmn-table editable>)
    // =========================================================================
    //
    // The rows are csvState.gridDataModel: an array of strings per row, a value per template
    // variable in the variables' order. The table shows them (all of them, or only the rows to
    // fix) and edits them in place: a column's id is its variable's place ("0", "1", …), so a
    // row's value for a column is row[id]. Everything else here works on the rows, never on the
    // drawing: the checks, the rows to fix, undo, paste, adding and deleting rows.

    const ROW_NUMBER = '#';        // the row number column's id
    let rowPlaces = new Map();     // a row (its array) → its place in gridDataModel

    /** The table, once its script has made it one (a test page may load the grid without it). */
    function gridTable() {
        const table = document.getElementById('validateGrid');
        return table && typeof table.write === 'function' ? table : null;
    }
    function gridVariables() { return csvState.gridTemplateVariables || []; }
    function isBooleanVar(v) { return !!v && (v.dataType === 'boolean' || v.dataType === 'bool'); }
    function isNumberVar(v) { return !!v && (v.dataType === 'number' || v.dataType === 'integer' || v.dataType === 'int'); }
    function isOptionalVar(v) { return !!(v && v.modifiers && (v.modifiers.isOptional || v.modifiers.isNullable || v.modifiers.ifBlank !== null && v.modifiers.ifBlank !== undefined)); }
    function modelRows() {
        if (!Array.isArray(csvState.gridDataModel)) csvState.gridDataModel = [];
        return csvState.gridDataModel;
    }
    function blankRow() { return new Array(gridVariables().length).fill(''); }
    function placeRows() {
        rowPlaces = new Map();
        modelRows().forEach((row, i) => rowPlaces.set(row, i));
    }
    function placeOf(row) {
        const at = rowPlaces.get(row);
        return at === undefined ? modelRows().indexOf(row) : at;
    }
    /** A value as its column keeps it: upper or lower case when the template says so. */
    function caseFor(v, value) {
        const mods = (v && v.modifiers) || {};
        if (mods.toUpper) return value.toUpperCase();
        if (mods.toLower) return value.toLowerCase();
        return value;
    }
    /** After the table has done what it is doing (a key it handed over, an edit it is writing). */
    function later(fn) { Promise.resolve().then(fn); }

    /**
     * Validate's grid: a column per template variable (A8 and ENV variables are worked out, not
     * typed), the row number first. Starts with one empty row to type into.
     * GitHub Issue #129 (the first grid), on the shared table since 2026-11-20.
     */
    function initializeDataEntryGrid(endpoint) {
        // `lu`: the lookup tables asked for again as Validate opens (an edit made since counts)
        try { const vs = getVscode && getVscode(); if (vs) vs.postMessage({ type: 'requestTemplateLookups' }); } catch { /* none */ }
        const container = document.getElementById('csvGridEntry');
        if (!container) {
            console.warn('[Grid] Container #csvGridEntry not found - modal may not be open yet');
            return;
        }

        // GitHub Issue #137, #165: A8 and ENV variables are calculated or come from the environment
        const variables = extractTemplateVariablesFromEndpoint(endpoint).filter(v => {
            const name = (v.name || '').toUpperCase();
            return !name.startsWith('A8:') && !name.startsWith('ENV:');
        });
        csvState.gridTemplateVariables = variables;
        // Which variables sit at which level of the body's arrays: Tab copies a level at a time
        csvState.gridNestingInfo = analyzeGridNestingLevels(endpoint, variables);

        if (variables.length === 0) {
            container.innerHTML = '<p class="grid-no-variables">No template variables found in endpoint configuration. Add variables like {{ITEM_ID}} to the request body.</p>';
            return;
        }

        container.innerHTML = '';
        const table = document.createElement('dbmn-table');
        table.id = 'validateGrid';
        table.className = 'validate-grid';
        table.setAttribute('editable', '');
        table.setAttribute('locked', '');
        table.setAttribute('label', 'Rows to run');
        container.appendChild(table);
        table.columns = gridColumns(variables);
        table.emptyText = () => 'No rows. Add one below.';
        table.onCellKey = handleGridKey;
        table.addEventListener('dbmn-table-edit', handleGridEdit);
        table.addEventListener('dbmn-table-paste', event => {
            event.preventDefault();
            const held = table.held;
            if (held) pasteIntoGrid(event.detail.text, placeOf(held.row), held.id === ROW_NUMBER ? 0 : Number(held.id));
        });
        // Leaving the grid: the rows to fix are shown again in full (see scheduleGridIssueRefresh)
        table.addEventListener('focusout', event => {
            if (!table.contains(event.relatedTarget)) scheduleGridIssueRefresh();
        });
        // Ctrl+Z is the grid's history (row deletes and pastes too), not the table's own
        table.addEventListener('dbmn-table-undo', event => {
            event.preventDefault();
            if (!event.detail.redo) undoGridChange();
        });

        const addRowBtn = document.createElement('button');
        addRowBtn.type = 'button';
        addRowBtn.className = 'grid-add-row-btn';
        addRowBtn.textContent = '+ Add Row';
        addRowBtn.addEventListener('click', () => addGridRow());
        container.appendChild(addRowBtn);

        // Ctrl+Z with nothing in the grid held (a delete just took the row it was on)
        if (!csvState.gridUndoWired) {
            document.addEventListener('keydown', handleGridUndo);
            csvState.gridUndoWired = true;
        }

        csvState.gridUndoStack = [];
        csvState.gridDataModel = [blankRow()];
        csvState.gridRowsLoaded = false;   // (typed: every row stays in view; see setIssueRows)
        csvState.gridValidationErrors = new Map();
        csvState.gridBlankCells = null;
        csvState.gridErrorRows = null;
        csvState.gridErrorFilterActive = false;
        csvState.gridInitialized = true;
        csvState.dataEntryGrid = { table };
        showGridRows();
        updateDataSourceFromGrid();

        // GitHub Issue #163: Initialize tab indicators
        if (window.CSVHandler && window.CSVHandler.updateTabDataIndicators) {
            window.CSVHandler.updateTabDataIndicators();
        }
    }

    /** The table's columns: the row number (a bin on hover deletes the row), then a column per variable. */
    function gridColumns(variables) {
        const number = {
            id: ROW_NUMBER, name: '#', pinned: true, sortable: false, removable: false, editable: false,
            className: 'grid-row-num',
            render: (value, row) => rowNumberCell(row)
        };
        return [number].concat(variables.map((v, col) => {
            const mods = v.modifiers || {};
            const column = {
                id: String(col),
                name: v.name,
                // GitHub Issue #175: the rules on its heading's hover (dotted underline), ○ when optional
                head: th => {
                    if (mods.hints && mods.hints.length) {
                        th.classList.add('grid-header-has-validation');
                        th.title = `${v.name}: ${mods.hints.join(', ')}`;
                    }
                    // list / lookup: its valid values on the heading's hover (James, 2026-11-23: "a dotted
                    // underline in the heading. And it would show a list of valid values")
                    if (mods.lookups && mods.lookups.length) {
                        const valid = validValues(mods.lookups[0]);
                        th.classList.add('grid-header-has-validation');
                        const lu = mods.lookups[0];
                        // (the table's own names when it's there: UOM, TMS → WMS; else as the template wrote them)
                        const t = lookupTables.filter(x => String(x.name).trim().toLowerCase() === String(lu.table).trim().toLowerCase())[0];
                        const col = ref => { const c = t && ref && window.LookupValue ? window.LookupValue.lookupColumn(t, ref) : null; return c ? c.name : ref; };
                        const tableName = t ? t.name : lu.table;
                        const what = (lu.kind || (lu.to !== undefined ? 'lookup' : 'list')) === 'lookup'
                            ? `a lookup in ${tableName}: ${col(lu.from)} → ${col(lu.to)}` : `a list from ${tableName}${lu.from ? `'s ${col(lu.from)}` : ''}`;
                        th.title = `${v.name}: ${what}. One of ${valid.slice(0, 30).join(', ')}${valid.length > 30 ? `… and ${valid.length - 30} more` : ''}${valid.length ? '' : '(no values yet)'}\nClick a cell to pick one; typing filters them`;
                    }
                    if (isOptionalVar(v)) {
                        const opt = document.createElement('span');
                        opt.className = 'grid-header-optional-indicator';
                        opt.textContent = '○';
                        opt.title = 'optional';
                        const name = th.querySelector('.column-name');
                        if (name) name.after(opt); else th.append(opt);
                    }
                },
                cell: (td, value, row) => markCell(td, col, row)
            };
            if (mods.lookups && mods.lookups.length) {
                // The values it may take, offered in the cell's box and filtered as it's typed
                column.editor = { options: () => validValues(mods.lookups[0]) };
            } else if (isBooleanVar(v)) {
                column.editor = { type: 'checkbox' };
                column.render = (value, row) => checkboxFor(row, col);
            } else if (v.dataType === 'date') {
                column.editor = { type: 'date', value: formatValueForDateInput };
            } else if (v.dataType === 'datetime' || v.dataType === 'timestamp') {
                column.editor = { type: 'datetime-local', step: 1, value: formatValueForDatetimeInput };
            } else if (v.dataType === 'time') {
                column.editor = { type: 'time', step: 1, value: formatValueForTimeInput };
            }
            return column;
        }));
    }

    function rowNumberCell(row) {
        const place = placeOf(row);
        const wrap = document.createElement('span');
        wrap.className = 'row-num-cell';
        const num = document.createElement('span');
        num.className = 'row-num';
        num.textContent = String(place + 1);
        const bin = document.createElement('button');
        bin.type = 'button';
        bin.className = 'row-delete-btn icon';
        bin.title = 'Delete row (Ctrl+Z to undo)';
        bin.setAttribute('aria-label', `Delete row ${place + 1}`);
        if (window.Icons && window.Icons.setIcon) window.Icons.setIcon(bin, 'trash-2');
        // On the press, not the click: a cell open for typing closes on the press and the rows are
        // drawn again, so the click would land on a bin no longer there
        bin.addEventListener('mousedown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            const table = gridTable();
            if (table && table._editing) table._editing.finish(true, null, true);
            deleteGridRow(placeOf(row));
        });
        // (the keyboard's Enter or Space on the bin)
        bin.addEventListener('click', event => {
            event.stopPropagation();
            if (event.detail === 0) deleteGridRow(placeOf(row));
        });
        wrap.append(num, bin);
        return wrap;
    }

    /** A yes/no cell: a tick box, drawn only (a click on the cell, Space or Enter turns it over: the table's). */
    function checkboxFor(row, col) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'grid-checkbox';
        box.checked = /^(true|yes|y|1)$/i.test(String(row[col] || '').trim());
        box.tabIndex = -1;
        box.setAttribute('aria-label', `${gridVariables()[col].name}, row ${placeOf(row) + 1}`);
        return box;
    }

    /** A cell's marks: optional, a rule it breaks or a required value it lacks (amber, the reason on hover). */
    function markCell(td, col, row) {
        const v = gridVariables()[col];
        td.classList.add('grid-cell');
        td.dataset.col = String(col);
        if (v) td.dataset.type = v.dataType;
        if (isOptionalVar(v)) td.classList.add('grid-cell-optional');
        if (isBooleanVar(v)) td.classList.add('grid-cell-boolean');
        const place = placeOf(row);
        const errors = csvState.gridValidationErrors && csvState.gridValidationErrors.get(place);
        const error = errors && errors.find(e => e.col === col);
        if (error) {
            td.classList.add('grid-cell-error');
            td.title = `${v.name} ${error.error}`;
        }
        const notes = !error && csvState.gridCellNotes && csvState.gridCellNotes.get(place);
        const note = notes && notes.find(n => n.col === col);
        if (note) {
            td.classList.add('grid-cell-note');
            td.title = `${v.name}: ${note.note}`;
        }
        const blanks = csvState.gridBlankCells && csvState.gridBlankCells.get(place);
        if (blanks && blanks.some(b => b.col === col)) {
            td.classList.add('grid-cell-blank-warning');
            td.title = `${v.name} is required`;
        }
    }

    /** The rows in the table: all of them, or only the rows to fix while the errors filter is on. */
    function showGridRows() {
        placeRows();
        const table = document.getElementById('validateGrid');
        if (!table) return;
        const rows = modelRows();
        let shown = rows;
        if (csvState.gridErrorFilterActive && csvState.gridErrorRows) {
            shown = Array.from(csvState.gridErrorRows).filter(i => i < rows.length).sort((a, b) => a - b).map(i => rows[i]);
        }
        table.rows = shown;
    }

    /** Hold a cell (and bring it into view) by its row's place and its column. */
    function selectGridCell(place, col) {
        const table = gridTable();
        const row = modelRows()[place];
        if (!table || !row) return;
        const at = table.shown.indexOf(row);
        if (at >= 0) table.select(at, String(col));
    }

    /**
     * Add an empty row at the end and hold its first cell. Shows every row first when only the
     * rows to fix are shown, or the new row would not be there. Returns the new row's place.
     */
    function addGridRow(options) {
        const skipFocus = options && options.skipFocus;
        if (!csvState.gridTemplateVariables) return -1;
        const rows = modelRows();
        rows.push(blankRow());
        if (csvState.gridErrorFilterActive) {
            csvState.gridErrorFilterTouched = true;
            setErrorFilter(false);
        } else {
            showGridRows();
        }
        updateGridRowCount(rows.length, rows.length);
        if (!skipFocus) selectGridCell(rows.length - 1, 0);
        updateDataSourceFromGrid();
        return rows.length - 1;
    }

    /**
     * Delete one row from this run (never from the file or the run the rows came from). Ctrl+Z
     * puts it back. Every row is checked again afterwards, so the filter, the hint and the step
     * bar follow.
     */
    function deleteGridRow(place) {
        const rows = modelRows();
        if (typeof place !== 'number' || place < 0 || place >= rows.length) return;
        const removed = rows.splice(place, 1)[0];
        pushUndo({ type: 'delete', index: place, values: removed.slice() });
        afterGridChange();
    }

    /**
     * What the table is about to write (typing, Delete, the tick box, Ctrl+D, Tab's copies): each
     * value in its column's case, numbers typed with only digits, a point and a minus (as the
     * grid always took them), and one step of Ctrl+Z for the lot.
     */
    function handleGridEdit(event) {
        const kind = event.detail.kind;
        if (kind === 'undo' || kind === 'redo') return;   // (never the table's own: Ctrl+Z is ours)
        const vars = gridVariables();
        const cells = [];
        event.detail.changes.forEach(change => {
            const v = vars[Number(change.id)];
            let value = change.value === null || change.value === undefined ? '' : String(change.value);
            if (kind === 'edit' && isNumberVar(v)) value = value.replace(/[^0-9.-]/g, '');
            change.value = caseFor(v, value);
            const place = placeOf(change.row);
            if (place >= 0) cells.push({ row: place, col: Number(change.id), before: change.old === null || change.old === undefined ? '' : String(change.old) });
        });
        if (cells.length) pushUndo({ type: 'cells', cells });
        later(updateDataSourceFromGrid);
    }

    /**
     * The grid's own keys, seen before the table's (held: { index, id, row, editing? }):
     *   Tab on the last cell of the last row   adds a row; with a body of arrays, each Tab after that
     *                                          copies the row above's values a level at a time (#146)
     *   Ctrl+D                                 the value from the cell above, then on to the next cell
     * Any other key ends Tab's copying. Returns true when it took the key.
     */
    function handleGridKey(event, held) {
        if (!held || !held.row) return false;
        const key = event.key;
        if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return false;
        const rows = modelRows();
        const place = placeOf(held.row);
        const col = held.id === ROW_NUMBER ? -1 : Number(held.id);
        const lastCol = gridVariables().length - 1;
        const mod = event.ctrlKey || event.metaKey;

        if (key === 'Tab' && !event.shiftKey && !mod && !event.altKey) {
            const info = csvState.gridNestingInfo;
            const copying = csvState.progressiveCopyState;
            if (col === lastCol && place === rows.length - 1) {
                later(() => {
                    const added = addGridRow({ skipFocus: true });
                    selectGridCell(added, 0);
                    if (hasNestingLevels(info)) {
                        csvState.progressiveCopyState = { active: true, currentLevel: 0, newRowIndex: added };
                        showProgressiveHint(0, info);
                    }
                });
                return true;
            }
            if (copying && copying.active && isInProgressiveCopyPosition(place, col, info)) {
                later(() => {
                    const to = progressiveCopyNextLevel(place, info);
                    if (to !== null) selectGridCell(place, to);
                });
                return true;
            }
            cancelProgressiveCopy();
            return false;
        }
        if (mod && (key === 'd' || key === 'D')) {
            cancelProgressiveCopy();
            later(() => copyFromCellAbove(place, col));
            return true;
        }
        if (!mod) cancelProgressiveCopy();
        return false;
    }

    function hasNestingLevels(info) {
        return !!info && [info.l1Fields, info.l2Fields, info.l3Fields, info.l4Fields].some(l => l && l.length > 0);
    }
    function nestingLevels(info) {
        return [info.l1Fields, info.l2Fields, info.l3Fields, info.l4Fields].map(l => l || []);
    }

    /**
     * Whether the held cell is where Tab's copying expects it: the new row, on its first cell
     * before anything is copied, then on the first field of the level the next Tab copies.
     */
    function isInProgressiveCopyPosition(place, col, info) {
        const state = csvState.progressiveCopyState;
        if (!state || !state.active || !info || place !== state.newRowIndex) return false;
        if (state.currentLevel === 0) return col === 0;
        const level = nestingLevels(info)[state.currentLevel];
        return !!level && level.length > 0 && col === level[0];
    }

    /**
     * One Tab of the copying (GitHub Issue #146): the next level that has fields is copied from
     * the row above; the hint then names the level after it, and the cell to hold is that
     * level's first field. With no level after it, the copying is done (null).
     */
    function progressiveCopyNextLevel(place, info) {
        const state = csvState.progressiveCopyState;
        if (!state || !state.active || !info || place < 1) { cancelProgressiveCopy(); return null; }
        const levels = nestingLevels(info);
        let copy = state.currentLevel;
        while (copy < levels.length && levels[copy].length === 0) copy++;
        if (copy >= levels.length) { cancelProgressiveCopy(); return null; }
        copyFieldsFromPreviousRow(place, levels[copy]);
        let next = copy + 1;
        while (next < levels.length && levels[next].length === 0) next++;
        if (next >= levels.length) { cancelProgressiveCopy(); return null; }
        state.currentLevel = next;
        showProgressiveHint(next, info);
        return levels[next][0];
    }

    /** The row above's values in these columns, as one edit (one Ctrl+Z). */
    function copyFieldsFromPreviousRow(place, cols) {
        const rows = modelRows();
        const table = gridTable();
        if (!table || place < 1 || !rows[place]) return;
        table.write(cols.map(col => ({ row: rows[place], id: String(col), value: rows[place - 1][col] || '' })), 'edit');
    }

    /** Ctrl+D: the value from the cell above, then on to the next cell, as Tab does. */
    function copyFromCellAbove(place, col) {
        const rows = modelRows();
        if (place < 1 || col < 0) return;
        copyFieldsFromPreviousRow(place, [col]);
        if (col < gridVariables().length - 1) selectGridCell(place, col + 1);
        else if (place < rows.length - 1) selectGridCell(place + 1, 0);
    }


    /**
     * Show progressive copy hint to guide user
     */
    function showProgressiveHint(level, nestingInfo) {
        // Remove any existing hint
        hideProgressiveHint();

        // GitHub Issue #146: Show actual field names instead of L1/L2/L3
        // Get field names from the template variables
        const getFieldNames = (fieldIndices) => {
            if (!fieldIndices || !csvState.gridTemplateVariables) return '';
            const names = fieldIndices
                .map(idx => csvState.gridTemplateVariables[idx]?.name)
                .filter(Boolean);
            if (names.length === 0) return '';
            if (names.length === 1) return names[0];
            if (names.length === 2) return `${names[0]} and ${names[1]}`;
            // 3+ fields: "a, b and c"
            return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
        };

        // Determine which fields will be copied next
        let fieldNames = '';
        if (level === 0) {
            // Initial hint - which level copies first?
            if (nestingInfo.l1Fields?.length > 0) {
                fieldNames = getFieldNames(nestingInfo.l1Fields);
            } else if (nestingInfo.l2Fields?.length > 0) {
                fieldNames = getFieldNames(nestingInfo.l2Fields);
            } else if (nestingInfo.l3Fields?.length > 0) {
                fieldNames = getFieldNames(nestingInfo.l3Fields);
            } else if (nestingInfo.l4Fields?.length > 0) {
                fieldNames = getFieldNames(nestingInfo.l4Fields);
            }
        } else if (level === 1 && nestingInfo.l2Fields?.length > 0) {
            fieldNames = getFieldNames(nestingInfo.l2Fields);
        } else if (level === 2 && nestingInfo.l3Fields?.length > 0) {
            fieldNames = getFieldNames(nestingInfo.l3Fields);
        } else if (level === 3 && nestingInfo.l4Fields?.length > 0) {
            fieldNames = getFieldNames(nestingInfo.l4Fields);
        }

        if (!fieldNames) {
            return;
        }

        const hint = document.createElement('div');
        hint.id = 'progressiveCopyHint';
        hint.className = 'progressive-copy-hint';
        hint.textContent = `Tab to copy ${fieldNames} from row above`;

        // Click to dismiss
        hint.onclick = () => hideProgressiveHint();
        hint.title = 'Click to dismiss';

        // Insert after the Add Row button so it appears inline next to it
        const addRowBtn = document.querySelector('.grid-add-row-btn');
        if (addRowBtn && addRowBtn.parentNode) {
            addRowBtn.parentNode.insertBefore(hint, addRowBtn.nextSibling);
        } else {
            // Fallback: append to grid container
            const gridContainer = document.getElementById('csvGridEntry');
            if (gridContainer) {
                gridContainer.parentNode.appendChild(hint);
            }
        }
    }

    /**
     * Hide the progressive copy hint
     */
    function hideProgressiveHint() {
        const hint = document.getElementById('progressiveCopyHint');
        if (hint) hint.remove();
    }

    /** Tab's copying stops (a key that is not its next Tab). */
    function cancelProgressiveCopy() {
        const state = csvState.progressiveCopyState;
        if (state && !state.active && document.getElementById('progressiveCopyHint') === null) return;
        csvState.progressiveCopyState = { active: false, currentLevel: 0, newRowIndex: -1 };
        hideProgressiveHint();
    }

    /**
     * GitHub Issue #135, #163: Redirect data to paste area when columns don't match grid
     * This is NOT an error - the CSV may have extra columns, which is fine.
     * The paste area + mapping step will handle column selection.
     */
    function handleGridPasteColumnMismatch(pastedText, detectedCols, expectedCols, isTabSeparated) {
        if (isTabSeparated === undefined) isTabSeparated = false;
        // GitHub Issue #163: Convert non-CSV delimited data to CSV format before pasting
        // GitHub Issue #178: Also handle pipe-delimited data
        let csvContent = pastedText;
        // Cross-module call: detectDelimiter is in the orchestrator
        const detectedDelimiter = window.CSVHandler.detectDelimiter ? window.CSVHandler.detectDelimiter(pastedText) : ',';
        if (isTabSeparated || detectedDelimiter !== ',') {
            const delimiter = isTabSeparated ? '\t' : detectedDelimiter;
            // Cross-module call: parseDelimitedContent is in the orchestrator
            const parsed = window.CSVHandler.parseDelimitedContent ? window.CSVHandler.parseDelimitedContent(pastedText, delimiter) : { headers: [], rows: [] };
            const csvLines = [parsed.headers.join(',')];
            parsed.rows.forEach(row => {
                // Quote fields that contain commas, quotes, or newlines
                const quotedFields = row.map(field => {
                    if (field.includes(',') || field.includes('"') || field.includes('\n')) {
                        return '"' + field.replace(/"/g, '""') + '"';
                    }
                    return field;
                });
                csvLines.push(quotedFields.join(','));
            });
            csvContent = csvLines.join('\n');
            console.log('[handleGridPasteColumnMismatch] Converted ' + delimiter + '-delimited to CSV');
        }

        // Put data in the paste area AS-IS (don't prepend expected headers)
        // The data already has its own headers
        const pasteArea = document.getElementById('csvPasteArea');
        if (pasteArea) {
            pasteArea.value = csvContent;

            // GitHub Issue #202: Navigate back to Step 1, Paste tab so user can review data
            // Don't call handlePasteAreaChange — that auto-advances to Step 2.
            // Let the user see the pasted data first and click "Read Data" when ready.
            if (window.CSVHandler && window.CSVHandler.showCSVStep) {
                window.CSVHandler.showCSVStep(1);
            }
            if (window.CSVHandler && window.CSVHandler.switchTab) {
                window.CSVHandler.switchTab('paste');
            }

            // Update paste tab data indicator and Read Data button state
            if (window.CSVHandler && window.CSVHandler.updatePasteTabData) {
                window.CSVHandler.updatePasteTabData(true, csvContent);
            }
            if (window.CSVHandler && window.CSVHandler.updateReadButtonState) {
                window.CSVHandler.updateReadButtonState();
            }

            // Flash the paste area to draw attention
            pasteArea.classList.add('paste-area-highlight');
            setTimeout(() => pasteArea.classList.remove('paste-area-highlight'), 2000);

            // Show notification
            setTimeout(() => {
                const infoMessage = `Template has ${expectedCols} columns but you pasted ${detectedCols}. ` +
                    `Review your data, then click Read Data to map columns in Step 2.`;
                if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                    window.CSVHandler.showModalNotification('info', infoMessage, { blocking: false });
                }
            }, 100);
        }
    }

    /**
     * GitHub Issue #162: whether pasted lines hold a date, date-time or time that cannot be read
     * (an Excel serial date): those go to the paste area, where Map sets the source format.
     */
    function checkForUnparseableDateTimeValues(lines, startCol, isTabSeparated) {
        const vars = gridVariables();
        for (const line of lines) {
            const cols = isTabSeparated || line.includes('\t') ? line.split('\t')
                : (window.CSVHandler && window.CSVHandler.parseCSVLine ? window.CSVHandler.parseCSVLine(line) : line.split(','));
            for (let c = 0; c < cols.length; c++) {
                const v = vars[startCol + c];
                const value = cols[c] ? cols[c].trim() : '';
                if (!v || !value || value === '-') continue;
                if (v.dataType === 'date' && formatValueForDateInput(value) === null) return true;
                if ((v.dataType === 'datetime' || v.dataType === 'timestamp') && formatValueForDatetimeInput(value) === null) return true;
                if (v.dataType === 'time' && formatValueForTimeInput(value) === null) return true;
            }
        }
        return false;
    }

    /**
     * GitHub Issue #162: Redirect paste to text area when date/datetime/time values can't be parsed
     * Shows a non-blocking warning so user can proceed with source format selection in Step 2
     */
    function handleGridPasteDateTimeIssue(pastedText) {
        // GitHub Issue #163: Convert tab-delimited data to CSV format
        let csvContent = pastedText;
        if (pastedText.includes('\t')) {
            // Cross-module call: parseDelimitedContent is in the orchestrator
            const parsed = window.CSVHandler.parseDelimitedContent ? window.CSVHandler.parseDelimitedContent(pastedText, '\t') : { headers: [], rows: [] };
            const csvLines = [parsed.headers.join(',')];
            parsed.rows.forEach(row => {
                const quotedFields = row.map(field => {
                    if (field.includes(',') || field.includes('"') || field.includes('\n')) {
                        return '"' + field.replace(/"/g, '""') + '"';
                    }
                    return field;
                });
                csvLines.push(quotedFields.join(','));
            });
            csvContent = csvLines.join('\n');
            console.log('[handleGridPasteDateTimeIssue] Converted tab-delimited to CSV');
        }

        // Put data in the paste area AS-IS (don't prepend headers)
        const pasteArea = document.getElementById('csvPasteArea');
        if (pasteArea) {
            pasteArea.value = csvContent;

            // GitHub Issue #202: Navigate back to Step 1, Paste tab so user can review data
            // Don't call handlePasteAreaChange — that auto-advances to Step 2.
            if (window.CSVHandler && window.CSVHandler.showCSVStep) {
                window.CSVHandler.showCSVStep(1);
            }
            if (window.CSVHandler && window.CSVHandler.switchTab) {
                window.CSVHandler.switchTab('paste');
            }

            // Update paste tab data indicator and Read Data button state
            if (window.CSVHandler && window.CSVHandler.updatePasteTabData) {
                window.CSVHandler.updatePasteTabData(true, csvContent);
            }
            if (window.CSVHandler && window.CSVHandler.updateReadButtonState) {
                window.CSVHandler.updateReadButtonState();
            }

            // Flash the paste area to draw attention
            pasteArea.classList.add('paste-area-highlight');
            setTimeout(() => pasteArea.classList.remove('paste-area-highlight'), 2000);

            // Show warning AFTER other operations (delayed to survive any clearing)
            setTimeout(() => {
                if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                    window.CSVHandler.showModalNotification(
                        'warning',
                        'Data moved to Paste Text tab - contains values needing format conversion (e.g., Excel serial dates). Review your data, then click Read Data.',
                        { blocking: false, persistent: true }
                    );
                }
            }, 200);
        }
    }

    /**
     * GitHub Issue #162: Format value for HTML5 date input (expects YYYY-MM-DD)
     * Handles various input formats: YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY, etc.
     * Returns null if value cannot be parsed (distinguishes from empty input)
     */
    function formatValueForDateInput(value) {
        if (!value || value.trim() === '' || value === '-') return '';

        const trimmed = value.trim();

        // If already in YYYY-MM-DD format, return as-is
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            return trimmed;
        }

        // GitHub Issue #162: Detect pure numbers (likely Excel serial dates or other numeric formats)
        // These can't be handled by HTML5 date inputs - return null to signal redirect to paste area
        if (/^\d+$/.test(trimmed)) {
            console.log('[formatValueForDateInput] Detected numeric value, likely Excel serial date:', trimmed);
            return null; // Signal that this needs special handling
        }

        // Try to parse as date
        try {
            // Handle common formats
            let dateObj;

            // MM/DD/YYYY or M/D/YYYY
            const usFormat = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (usFormat) {
                dateObj = new Date(parseInt(usFormat[3]), parseInt(usFormat[1]) - 1, parseInt(usFormat[2]));
            }
            // DD-MM-YYYY or D-M-YYYY
            else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(trimmed)) {
                const parts = trimmed.split('-');
                dateObj = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
            }
            // ISO datetime (extract date part)
            else if (trimmed.includes('T')) {
                dateObj = new Date(trimmed);
            }
            // Generic Date.parse
            else {
                dateObj = new Date(trimmed);
            }

            if (dateObj && !isNaN(dateObj.getTime())) {
                const year = dateObj.getFullYear();
                const month = String(dateObj.getMonth() + 1).padStart(2, '0');
                const day = String(dateObj.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            }
        } catch (e) {
            console.warn('[formatValueForDateInput] Failed to parse date:', value, e);
        }

        return null; // Return null if can't parse (different from empty string)
    }

    /**
     * GitHub Issue #162: Format value for HTML5 datetime-local input (expects YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss)
     * Returns null if value cannot be parsed (distinguishes from empty input)
     */
    function formatValueForDatetimeInput(value) {
        if (!value || value.trim() === '' || value === '-') return '';

        const trimmed = value.trim();

        // If already in correct format, return as-is
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
            return trimmed;
        }

        // Detect pure numbers (likely Excel serial dates or other numeric formats)
        if (/^\d+$/.test(trimmed)) {
            console.log('[formatValueForDatetimeInput] Detected numeric value, likely Excel serial date:', trimmed);
            return null; // Signal that this needs special handling
        }

        try {
            // Handle space-separated datetime (e.g., "2024-01-04 14:30:00")
            let parseValue = trimmed;
            if (trimmed.includes(' ') && !trimmed.includes('T')) {
                parseValue = trimmed.replace(' ', 'T');
            }

            const dateObj = new Date(parseValue);

            if (dateObj && !isNaN(dateObj.getTime())) {
                const year = dateObj.getFullYear();
                const month = String(dateObj.getMonth() + 1).padStart(2, '0');
                const day = String(dateObj.getDate()).padStart(2, '0');
                const hours = String(dateObj.getHours()).padStart(2, '0');
                const minutes = String(dateObj.getMinutes()).padStart(2, '0');
                const seconds = String(dateObj.getSeconds()).padStart(2, '0');
                return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
            }
        } catch (e) {
            console.warn('[formatValueForDatetimeInput] Failed to parse datetime:', value, e);
        }

        return null; // Return null if can't parse (different from empty string)
    }

    /**
     * GitHub Issue #162: Format value for HTML5 time input (expects HH:mm or HH:mm:ss)
     * Returns null if value cannot be parsed (distinguishes from empty input)
     */
    function formatValueForTimeInput(value) {
        if (!value || value.trim() === '' || value === '-') return '';

        const trimmed = value.trim();

        // If already in HH:mm or HH:mm:ss format, return as-is
        if (/^\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
            return trimmed;
        }

        // Detect pure numbers (not a valid time format)
        if (/^\d+$/.test(trimmed)) {
            console.log('[formatValueForTimeInput] Detected numeric value, not a valid time:', trimmed);
            return null; // Signal that this needs special handling
        }

        try {
            // Extract time from datetime
            if (trimmed.includes('T')) {
                const timePart = trimmed.split('T')[1];
                if (timePart) {
                    // Remove timezone suffix if present
                    const cleanTime = timePart.replace(/[Z+-].*$/, '');
                    // Remove milliseconds if present
                    const timeWithoutMs = cleanTime.split('.')[0];
                    if (/^\d{2}:\d{2}(:\d{2})?$/.test(timeWithoutMs)) {
                        return timeWithoutMs;
                    }
                }
            }

            // Try parsing as date object to extract time
            const dateObj = new Date(`1970-01-01T${trimmed}`);
            if (dateObj && !isNaN(dateObj.getTime())) {
                const hours = String(dateObj.getHours()).padStart(2, '0');
                const minutes = String(dateObj.getMinutes()).padStart(2, '0');
                const seconds = String(dateObj.getSeconds()).padStart(2, '0');
                return `${hours}:${minutes}:${seconds}`;
            }
        } catch (e) {
            console.warn('[formatValueForTimeInput] Failed to parse time:', value, e);
        }

        return null; // Return null if can't parse (different from empty string)
    }

    /**
     * A paste on a held cell (Excel, a CSV, pipes): from that cell across and down, adding rows
     * as needed (GitHub Issues #135, #163, #178, #252). More columns than fit from the cell, or
     * a date that cannot be read, goes to the paste area instead while the grid is empty (Map
     * then matches the columns), and is refused with a note once it holds data. One Ctrl+Z
     * puts the whole paste back.
     */
    function pasteIntoGrid(text, startRow, startCol) {
        if (!text) return;
        const vars = gridVariables();
        const lines = text.trim().split(/\r?\n/);
        const isTabSeparated = lines.some(line => line.includes('\t'));
        const isPipeSeparated = !isTabSeparated && lines.some(line => line.includes('|'));
        const split = line => {
            if (line.includes('\t')) return line.split('\t');
            if (isPipeSeparated) return line.split('|').map(f => f.trim());
            return window.CSVHandler && window.CSVHandler.parseCSVLine ? window.CSVHandler.parseCSVLine(line) : line.split(',');
        };
        const note = message => {
            if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                window.CSVHandler.showModalNotification('warning', message, { blocking: false });
            }
        };

        // Issue #252: only more columns than fit from the cell is a different shape of data
        const expectedColCount = vars.length - startCol;
        const firstRowCols = isTabSeparated ? lines[0].split('\t') : split(lines[0]);
        if (firstRowCols.length > expectedColCount) {
            if (hasGridData()) {
                note(`Pasted data has ${firstRowCols.length} columns but only ${expectedColCount} fit from the selected cell. Fix the data and try again.`);
                return;
            }
            handleGridPasteColumnMismatch(text, firstRowCols.length, expectedColCount, isTabSeparated);
            return;
        }
        if (checkForUnparseableDateTimeValues(lines, startCol, isTabSeparated)) {
            if (hasGridData()) {
                note('Pasted data contains date/time values that cannot be parsed. Fix the values and try again.');
                return;
            }
            handleGridPasteDateTimeIssue(text);
            return;
        }

        saveGridStateForUndo();
        const rows = modelRows();
        lines.forEach((line, offset) => {
            const place = startRow + offset;
            while (place >= rows.length) rows.push(blankRow());
            split(line).forEach((value, c) => {
                const col = startCol + c;
                // GitHub Issue #135: values as given; Map's formats are not applied to a paste
                if (col < vars.length) rows[place][col] = caseFor(vars[col], String(value).trim());
            });
        });
        afterGridChange();
    }

    // =========================================================================
    // Grid undo (Ctrl+Z): every edit, delete and paste, in order — back to the data as loaded
    // =========================================================================
    //
    // Entries, newest last in csvState.gridUndoStack:
    //   { type: 'cells', cells: [{ row, col, before }] }   an edit (one or many cells, as written)
    //   { type: 'delete', index, values }                  a deleted row and where it was
    //   { type: 'snapshot', data }                         every row before a paste
    // Rows are places in gridDataModel; undoing in reverse order keeps them right. A new load
    // clears the history (populateGridFromMappedData).

    const UNDO_LIMIT = 1000;

    function pushUndo(entry) {
        if (!csvState.gridUndoStack) csvState.gridUndoStack = [];
        if (csvState.gridUndoStack.length >= UNDO_LIMIT) csvState.gridUndoStack.shift();
        csvState.gridUndoStack.push(entry);
    }

    /** Before a paste: every row, so one Ctrl+Z puts them back. */
    function saveGridStateForUndo() {
        pushUndo({ type: 'snapshot', data: modelRows().map(r => r.slice()) });
    }

    /** Ctrl+Z: the last change (an edit, a delete or a paste) is undone. Every row is checked again. */
    function undoGridChange() {
        const entry = csvState.gridUndoStack && csvState.gridUndoStack.pop();
        if (!entry) return false;
        const rows = modelRows();
        if (entry.type === 'cells') {
            entry.cells.slice().reverse().forEach(c => { if (rows[c.row]) rows[c.row][c.col] = c.before; });
        } else if (entry.type === 'delete') {
            rows.splice(entry.index, 0, entry.values.slice());
        } else if (entry.type === 'snapshot') {
            csvState.gridDataModel = entry.data.map(r => r.slice());
        }
        afterGridChange();
        return true;
    }

    /** Rows added, taken away or put back: the row numbers, the checks, the filter and the hint follow. */
    function afterGridChange() {
        placeRows();
        const total = modelRows().length;
        updateGridRowCount(total, total);
        refreshGridIssues({ keepRows: gridHasFocus() });
        updateDataSourceFromGrid();
    }

    /** Ctrl+Z with nothing in the grid holding the keys (the table's own Ctrl+Z comes as dbmn-table-undo). */
    function handleGridUndo(event) {
        if (event.defaultPrevented) return;
        if (!(event.ctrlKey || event.metaKey) || event.shiftKey || String(event.key).toLowerCase() !== 'z') return;
        if (csvState.modalStep !== 3 || document.querySelector('.dbmn-modal-backdrop, .dbmn-modal-overlay')) return;
        const active = document.activeElement;
        if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;   // a field's own undo
        if (!(csvState.gridUndoStack && csvState.gridUndoStack.length)) return;
        event.preventDefault();
        undoGridChange();
    }

    /** An edit landed: the checks follow once typing stops, and Next and the tabs know there is data. */
    function updateDataSourceFromGrid() {
        if (!csvState.gridInitialized) return;
        scheduleGridIssueRefresh();
        if (hasGridData() && !csvState.currentFile) {
            csvState.sourceType = 'grid';
            csvState.sourceFileName = null;
        }
        if (window.CSVHandler && window.CSVHandler.updateCSVNavigationButtons) {
            window.CSVHandler.updateCSVNavigationButtons();
        }
    }

    /** Every row, as arrays of strings in the variables' order (a copy). */
    function getVanillaGridData() {
        return modelRows().map(row => row.slice());
    }

    /** The rows as CSV, the variables' names as its header; rows left completely empty are left out. */
    function getGridDataAsCSV() {
        if (!csvState.gridInitialized || !csvState.gridTemplateVariables) return null;
        const headers = csvState.gridTemplateVariables.map(v => v.name);
        const nonEmptyRows = modelRows().filter(row => row.some(cell => cell !== '' && cell !== null));
        if (nonEmptyRows.length === 0) return null;
        const csvLines = [headers.join(',')];
        nonEmptyRows.forEach(row => csvLines.push(row.map(csvCell).join(',')));
        return csvLines.join('\n');
    }
    function csvCell(cell) {
        const text = cell || '';
        return text.includes(',') || text.includes('"') || text.includes('\n') ? `"${text.replace(/"/g, '""')}"` : text;
    }

    /** Whether any cell holds anything. */
    function hasGridData() {
        if (!csvState.gridInitialized) return false;
        return modelRows().some(row => row.some(cell => cell !== '' && cell !== null));
    }

    /**
     * Rows with nothing in them go before Next (GitHub Issue #154: an empty row is not an error).
     * A yes/no column left unticked counts as empty.
     */
    function removeEmptyGridRows() {
        const vars = gridVariables();
        const rows = modelRows();
        const kept = rows.filter(row => row.some((cell, col) => {
            if (isBooleanVar(vars[col])) return /^(true|yes|y|1)$/i.test(String(cell || '').trim());
            return cell && String(cell).trim() !== '';
        }));
        if (kept.length === rows.length) return;
        csvState.gridDataModel = kept;
        afterGridChange();
    }

    /**
     * GitHub Issue #175: every row against its columns' rules (length, number, whole number,
     * minimum, maximum). The broken cells are kept by row (csvState.gridValidationErrors) and
     * drawn amber, the reason on hover.
     */
    function validateGridData() {
        const errors = [];
        csvState.gridValidationErrors = new Map();
        modelRows().forEach((row, i) => {
            const rowErrors = validateDataModelRow(row, i);
            if (rowErrors.length > 0) {
                csvState.gridValidationErrors.set(i, rowErrors);
                errors.push(...rowErrors);
            }
        });
        const count = errors.length;
        return { valid: count === 0, errors, message: count === 0 ? '' : `${count} validation error${count !== 1 ? 's' : ''} found` };
    }

    /**
     * Required cells left empty (GitHub Issue #175: an optional or nullable column may be empty;
     * a yes/no is never empty).
     */
    function validateGridForBlankCells() {
        const vars = gridVariables();
        const blankCells = [];
        modelRows().forEach((row, rowIndex) => {
            vars.forEach((v, col) => {
                if (!v || isOptionalVar(v) || isBooleanVar(v)) return;
                const value = row[col] || '';
                if (!value || String(value).trim() === '') blankCells.push({ row: rowIndex, col, cell: null });
            });
        });
        const count = blankCells.length;
        return { valid: count === 0, blankCells, message: count === 0 ? '' : describeBlankCells(blankCells) };
    }

    /**
     * "6 empty fields in 3 rows: product.supplier.gln (3), reorderQty (3)" — which required
     * columns are empty, so the user knows what to fix (optional ones are never counted).
     */
    function describeBlankCells(blankCells) {
        const vars = gridVariables();
        const perColumn = new Map();
        const rows = new Set();
        blankCells.forEach(c => {
            rows.add(c.row);
            const name = (vars[c.col] && vars[c.col].name) || `column ${c.col + 1}`;
            perColumn.set(name, (perColumn.get(name) || 0) + 1);
        });
        const names = Array.from(perColumn, ([name, n]) => `${name} (${n})`);
        const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? `, +${names.length - 3} more` : '');
        const fields = `${blankCells.length} empty field${blankCells.length === 1 ? '' : 's'}`;
        const inRows = `${rows.size} row${rows.size === 1 ? '' : 's'}`;
        return `${fields} in ${inRows}: ${shown}`;
    }

    /** The empty required cells, by row, for the drawing (csvState.gridBlankCells). */
    function highlightBlankCells(blankCells) {
        csvState.gridBlankCells = new Map();
        blankCells.forEach(item => {
            if (!csvState.gridBlankCells.has(item.row)) csvState.gridBlankCells.set(item.row, []);
            csvState.gridBlankCells.get(item.row).push({ col: item.col });
        });
    }

    /**
     * Clear file selection and restore dropzone to original state
     * GitHub Issue #202: File upload is in Step 1, grid is in Step 3
     */
    function clearFileAndShowGrid() {
        // Reset file state
        csvState.currentFile = null;
        csvState.sourceType = null;
        csvState.sourceFileName = null;
        csvState.rawCSVContent = null;
        csvState.fileDetailsShown = false;
        csvState.fileFormat = null;
        csvState.formatMetadata = null;

        // Reset file tab data tracking
        if (csvState.tabData && csvState.tabData.file) {
            csvState.tabData.file.hasData = false;
            csvState.tabData.file.fileName = null;
        }

        // Reset file input
        const fileInput = document.getElementById('csvModalFileInput');
        if (fileInput) fileInput.value = '';

        // GitHub Issue #202: Restore dropzone to original upload UI
        if (window.DTDataIngestion && window.DTDataIngestion.showUploadUI) {
            window.DTDataIngestion.showUploadUI();
        }

        // Update tab indicators and navigation
        if (window.CSVHandler && window.CSVHandler.updateTabDataIndicators) {
            window.CSVHandler.updateTabDataIndicators();
        }
        if (window.CSVHandler && window.CSVHandler.updateCSVNavigationButtons) {
            window.CSVHandler.updateCSVNavigationButtons();
        }
    }

    // =========================================================================
    // Grid load progress — uses Next button as progress indicator
    // =========================================================================

    function showGridLoadProgress(total) {
        const btn = document.getElementById('csvNextBtn');
        if (!btn) return;
        btn.disabled = true;
        btn.dataset.loadingProgress = 'true';
        btn.textContent = 'Loading';
        updateGridLoadProgress(0, total);
    }

    function updateGridLoadProgress(loaded, total, text) {
        const btn = document.getElementById('csvNextBtn');
        if (!btn || btn.dataset.loadingProgress !== 'true') return;
        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
        btn.style.background = `linear-gradient(90deg, var(--vscode-button-background) ${pct}%, var(--vscode-input-background) ${pct}%)`;
        if (text) btn.textContent = text;
    }

    function hideGridLoadProgress() {
        const btn = document.getElementById('csvNextBtn');
        if (!btn) return;
        btn.style.background = '';
        btn.textContent = 'Next';
        btn.disabled = false;
        delete btn.dataset.loadingProgress;
    }

    /**
     * The rows Map made, as the grid's rows: grid column → the file's column it was mapped to,
     * each value trimmed and in its column's case. `from`/`to` take a slice (the batched load).
     */
    function gridColumnSources(headers, templateVariables) {
        return gridVariables().map(gridVar => {
            const tv = templateVariables.find(v => v.name === gridVar.name);
            return tv && tv.mappedTo ? headers.indexOf(tv.mappedTo) : -1;
        });
    }
    function gridRowFrom(row, sources) {
        const vars = gridVariables();
        const out = new Array(vars.length).fill('');
        sources.forEach((source, col) => {
            if (source < 0 || !Array.isArray(row)) return;
            const raw = String(row[source] || '').trim();
            if (raw) out[col] = caseFor(vars[col], raw);
        });
        return out;
    }

    /** A new load's rows: a new history, no marks until they are checked, the table shows them. */
    function startGridRows(rows) {
        csvState.gridUndoStack = [];
        csvState.gridDataModel = rows;
        csvState.gridRowsLoaded = true;
        csvState.gridValidationErrors = new Map();
        csvState.gridBlankCells = null;
        csvState.gridLoadErrors = [];
        cancelProgressiveCopy();
        showGridRows();
        updateGridRowCount(rows.length, rows.length);
    }

    /**
     * GitHub Issue #202/#223: the rows Map made become the grid's rows, then every row is
     * checked in the background (the Next button shows how far).
     */
    function populateGridFromMappedData(parsedData, templateVariables) {
        if (!parsedData || !templateVariables || templateVariables.length === 0) {
            console.warn('[populateGridFromMappedData] Missing parsedData or templateVariables');
            return;
        }
        if (!csvState.gridInitialized && csvState.endpointConfig) initializeDataEntryGrid(csvState.endpointConfig);
        if (!csvState.gridInitialized || !csvState.gridTemplateVariables) {
            console.warn('[populateGridFromMappedData] Grid not initialized');
            return;
        }
        const sources = gridColumnSources(parsedData.headers || csvState.currentHeaders || [], templateVariables);
        startGridRows((parsedData.rows || []).map(row => gridRowFrom(row, sources)));
        validateDataModelInBackground();
    }

    /**
     * GitHub Issue #223: Validate a data model row without DOM
     * Same validation logic as validateGridRow but operates on plain arrays
     */
    /**
     * The lookup tables a template's `lu` reads, as the screen gives them (setLookupTables), and one
     * value through one `lu`: the rule and the words of template-lookups.ts applyLookup (the run's),
     * so Validate says what the run would: exact text, a table and its columns by name any case.
     */
    var lookupTables = [];
    function setLookupTables(tables) {
        lookupTables = Array.isArray(tables) ? tables : [];
        // (the headings' valid values, and the rows checked again against them)
        const table = csvState && csvState.dataEntryGrid && csvState.dataEntryGrid.table;
        if (table && table.redrawHeads) table.redrawHeads();
        if (csvState && csvState.gridDataModel && csvState.gridDataModel.length) refreshGridIssues({ keepRows: true });
    }
    /** A list or lookup's valid values: its From column's (or its table's one column's), each once. */
    function validValues(lu) {
        const table = lookupTables.filter(function (t) { return String(t.name).trim().toLowerCase() === String(lu.table).trim().toLowerCase(); })[0];
        if (!table) return [];
        const from = lu.from ? window.LookupValue.lookupColumn(table, lu.from) : (table.columns.length === 1 ? table.columns[0] : null);
        if (!from) return [];
        const seen = new Set();
        (table.rows || []).forEach(function (r) { const v = r[from.id] == null ? '' : String(r[from.id]); if (v) seen.add(v); });
        return Array.from(seen);
    }
    function lookupInTables(lu, value) {
        // Said as what it is: "uom is a lookup in UOM: DZ isn't in its TMS column" (James, 2026-11-23: "is this a list
        // or a lookup we're doing here?"); the cell's hover and the summary put the variable's name in front
        var kind = (lu.kind || (lu.to !== undefined ? 'lookup' : 'list')) === 'lookup' ? 'is a lookup in ' : 'is a list from ';
        var table = lookupTables.filter(function (t) { return String(t.name).trim().toLowerCase() === String(lu.table).trim().toLowerCase(); })[0];
        if (!table) return { error: kind + lu.table + ": there's no lookup table called " + lu.table };
        var say = kind + table.name + ': ';
        // (`list|uom`: a table of one column; with more, said, never guessed)
        if (!lu.from && table.columns.length !== 1) return { error: say + 'it has more than one column: say which, e.g. ' + lu.table + ':' + String((table.columns[0] || { name: 'column' }).name).toLowerCase() };
        var rule = window.LookupValue;   // shared/lookup-value.js: the rule the run itself uses
        var from = lu.from ? rule.lookupColumn(table, lu.from) : table.columns[0];
        if (!from) return { error: say + 'it has no column called ' + lu.from };
        var to = lu.to === undefined ? null : rule.lookupColumn(table, lu.to);
        if (lu.to !== undefined && !to) return { error: say + 'it has no column called ' + lu.to };
        if (!value) return { error: say + 'needs a value from its ' + from.name + ' column' };
        var answer = rule.lookupValue(table, from.id, value, to ? to.id : undefined);
        if (answer.kind === 'missing') return { error: say + value + " isn't in its " + from.name + ' column' };
        if (!to) return { value: value };   // (list: in the list is in the list, however often)
        if (answer.value === '') return { error: say + value + "'s " + to.name + ' is blank' };
        // In the From column more than once: the first row's, said, not to fix (the manager for James, 2026-11-23:
        // "if we're looking up, we pick the first one")
        if (answer.rows > 1) return { value: answer.value, note: value + ' · in ' + from.name + ' ' + (answer.rows === 2 ? 'twice' : answer.rows + ' times') + ', first row used (' + answer.value + ')' };
        return { value: answer.value };
    }

    function validateDataModelRow(rowData, rowIndex) {
        var rowErrors = [];
        if (!csvState.gridTemplateVariables) return rowErrors;
        // Notes on cells (not to fix): a lookup's value found more than once, the first row used
        if (!csvState.gridCellNotes) csvState.gridCellNotes = new Map();
        csvState.gridCellNotes.delete(rowIndex);

        csvState.gridTemplateVariables.forEach(function (variable, colIndex) {
            if (!variable || !variable.modifiers) return;

            var mods = variable.modifiers;
            var dataType = variable.dataType;
            var value = rowData[colIndex] || '';
            if (mods.problem) {
                rowErrors.push({ row: rowIndex, col: colIndex, variable: variable.name, value: value, error: '— ' + mods.problem });
                return;
            }

            // ifblank: a blank is what it becomes (checked from there on, as the run fills it)
            if ((!value || (!mods.noTrim && value.trim() === '')) && mods.ifBlank !== null && mods.ifBlank !== undefined) value = mods.ifBlank;
            // Skip optional/nullable fields when empty
            if ((mods.isOptional || mods.isNullable) && (!value || value.trim() === '')) return;
            // Skip empty required fields (handled by blank cell validation)
            if (!value || value.trim() === '') return;

            value = value.trim();

            // Lookups (lu), in the order written, after upper/lower as the run does: the first that fails
            if (mods.lookups && mods.lookups.length) {
                var looked = mods.toUpper ? value.toUpperCase() : mods.toLower ? value.toLowerCase() : value;
                for (var li = 0; li < mods.lookups.length; li++) {
                    var luAnswer = lookupInTables(mods.lookups[li], looked);
                    if (luAnswer.error) {
                        rowErrors.push({ row: rowIndex, col: colIndex, variable: variable.name, value: value, error: luAnswer.error });
                        return;
                    }
                    if (luAnswer.note) {
                        var notes = csvState.gridCellNotes.get(rowIndex) || [];
                        notes.push({ col: colIndex, note: luAnswer.note });
                        csvState.gridCellNotes.set(rowIndex, notes);
                    }
                    looked = luAnswer.value;
                }
            }

            // String validations
            if (dataType === 'string') {
                var len = value.length;
                if (mods.exactLength !== null && len !== mods.exactLength) {
                    rowErrors.push({ row: rowIndex, col: colIndex, variable: variable.name, value: value, error: 'must be exactly ' + mods.exactLength + ' characters (got ' + len + ')' });
                    return;
                }
                if (mods.minLength !== null && len < mods.minLength) {
                    rowErrors.push({ row: rowIndex, col: colIndex, variable: variable.name, value: value, error: 'minimum ' + mods.minLength + ' characters required (got ' + len + ')' });
                    return;
                }
                if (mods.maxLength !== null && len > mods.maxLength) {
                    rowErrors.push({ row: rowIndex, col: colIndex, variable: variable.name, value: value, error: 'maximum ' + mods.maxLength + ' characters allowed (got ' + len + ')' });
                    return;
                }
            }

            // Number validations
            if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
                var num = parseFloat(value);
                if (isNaN(num)) {
                    rowErrors.push({ row: rowIndex, col: colIndex, variable: variable.name, value: value, error: 'must be a valid number' });
                    return;
                }
                if (mods.isInteger && !Number.isInteger(num)) {
                    rowErrors.push({ row: rowIndex, col: colIndex, variable: variable.name, value: value, error: 'must be an integer (no decimals)' });
                    return;
                }
                if (mods.minValue !== null) {
                    var passes = mods.minExclusive ? num > mods.minValue : num >= mods.minValue;
                    if (!passes) {
                        rowErrors.push({ row: rowIndex, col: colIndex, variable: variable.name, value: value, error: 'must be ' + (mods.minExclusive ? '>' : '\u2265') + ' ' + mods.minValue });
                        return;
                    }
                }
                if (mods.maxValue !== null) {
                    var passes2 = mods.maxExclusive ? num < mods.maxValue : num <= mods.maxValue;
                    if (!passes2) {
                        rowErrors.push({ row: rowIndex, col: colIndex, variable: variable.name, value: value, error: 'must be ' + (mods.maxExclusive ? '<' : '\u2264') + ' ' + mods.maxValue });
                        return;
                    }
                }
            }
        });

        return rowErrors;
    }

    /**
     * GitHub Issue #223: every row's rules, checked a slice at a time (the page stays usable on
     * a big file), the Next button showing how far; then the empty required cells, once.
     */
    function validateDataModelInBackground() {
        const rows = modelRows();
        if (rows.length === 0) {
            finalizeVirtualGridPopulate();
            return;
        }
        const BATCH_SIZE = 5000;
        const total = rows.length;
        csvState.gridValidationErrors = new Map();
        let offset = 0;
        showGridLoadProgress(total);
        function processBatch() {
            const end = Math.min(offset + BATCH_SIZE, total);
            for (let i = offset; i < end; i++) {
                const errors = validateDataModelRow(rows[i], i);
                if (errors.length > 0) csvState.gridValidationErrors.set(i, errors);
            }
            offset = end;
            updateGridLoadProgress(offset, total);
            if (offset < total) requestAnimationFrame(processBatch);
            else finalizeVirtualGridPopulate();
        }
        requestAnimationFrame(processBatch);
    }

    /** The load's checks are done: the rules found are kept, the empty cells added, drawn once. */
    function finalizeVirtualGridPopulate() {
        hideGridLoadProgress();
        csvState.gridLoadErrors = null;
        refreshGridIssues({ reuseRuleErrors: true });
        updateDataSourceFromGrid();
    }

    /** The line under the grid while rows load; then what it shows. */
    function updateGridRowCount(loaded, total) {
        const hint = document.querySelector('#csvDataValidationStep .grid-hint');
        if (!hint) return;
        if (loaded < total) hint.textContent = `Loading rows... ${loaded} of ${total}`;
        else updateGridHint();
    }

    /** The line under the grid: what it is showing, and how many rows need fixing. */
    function updateGridHint() {
        const hint = document.querySelector('#csvDataValidationStep .grid-hint');
        if (!hint) return;
        const total = modelRows().length;
        const bad = csvState.gridErrorRows ? csvState.gridErrorRows.size : 0;
        const rows = n => `${n.toLocaleString()} row${n === 1 ? '' : 's'}`;
        if (bad === 0) {
            hint.textContent = `${rows(total)}. Edit any cell, or delete a row from its number.`;
        } else if (csvState.gridErrorFilterActive) {
            hint.textContent = `Showing the ${rows(bad)} that ${bad === 1 ? 'needs' : 'need'} fixing, of ${total.toLocaleString()}. Fix the highlighted cells, or delete a row from its number.`;
        } else {
            hint.textContent = `${rows(total)}, ${bad.toLocaleString()} to fix (highlighted).`;
        }
    }

    // =========================================================================
    // Validate: one check of every row (GitHub Issue #247 follow-up)
    // =========================================================================

    /**
     * Check EVERY row — required cells left empty, and each column's rules (type, >=0, …) —
     * and make the grid show the result: cell highlights, the rows to fix (the errors filter, on
     * unless the user chose Show All), the hint line and the step bar. Runs on load, after a
     * delete, a paste or an undo, shortly after an edit, and when Next is pressed (which then
     * stops or goes on from what this returns). Nothing goes to the footer.
     *
     * Returns { valid, rowCount, lines } — lines name each column's problem for the
     * "Can't continue yet" modal.
     */
    function refreshGridIssues(options) {
        clearTimeout(issueRefreshTimer);
        if (!csvState.gridTemplateVariables) return { valid: true, rowCount: 0, lines: [] };

        const blank = validateGridForBlankCells();
        let ruleErrors;
        if (options && options.reuseRuleErrors && csvState.gridValidationErrors) {
            ruleErrors = [];
            csvState.gridValidationErrors.forEach(list => { ruleErrors.push(...list); });
        } else {
            ruleErrors = validateGridData().errors;
        }
        highlightBlankCells(blank.blankCells);

        const rows = new Set();
        blank.blankCells.forEach(c => rows.add(c.row));
        ruleErrors.forEach(e => rows.add(e.row));
        if (options && options.keepRows) keepIssueRows(rows);
        else setIssueRows(rows);   // (draws the rows, with their marks)
        updateGridHint();

        return { valid: rows.size === 0, rowCount: rows.size, lines: describeIssues(blank.blankCells, ruleErrors) };
    }

    let issueRefreshTimer = null;

    /**
     * After an edit: wait until typing stops, then check every row again. While the grid holds
     * the keys the marks and counts follow but the rows shown stay (a row typed or fixed does not
     * vanish under the cursor, and the cell open for typing stays open); leaving the grid checks
     * again in full.
     */
    function scheduleGridIssueRefresh() {
        if (csvState.modalStep !== 3) return;
        const next = document.getElementById('csvNextBtn');
        if (next && next.dataset.loadingProgress === 'true') return;   // the load ends with a full check
        clearTimeout(issueRefreshTimer);
        issueRefreshTimer = setTimeout(() => refreshGridIssues({ keepRows: gridHasFocus() }), 600);
    }

    /**
     * The rows to fix, counted and marked, while the grid holds the keys: the rows shown stay
     * (less any deleted, plus any that now need fixing); with nothing left to fix, every row shows.
     */
    function keepIssueRows(rows) {
        if (rows.size === 0) {
            hideErrorFilter();
            return;
        }
        csvState.gridErrorRows = rows;
        const btn = document.getElementById('gridErrorFilterBtn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = csvState.gridErrorFilterActive ? 'Show All' : `Filter Errors (${rows.size})`;
        }
        placeRows();
        const table = document.getElementById('validateGrid');
        if (table) {
            const model = modelRows();
            let shown = model;
            if (csvState.gridErrorFilterActive) {
                const before = new Set(table.rows);
                shown = model.filter((row, i) => before.has(row) || rows.has(i));
            }
            table.rows = shown;   // drawn again, marks and all
        }
        refreshStepper();
    }

    /** Whether the grid holds the keys (a cell held, being typed in, or its bin pressed). */
    function gridHasFocus() {
        const table = document.getElementById('validateGrid');
        return !!table && table.contains(document.activeElement);
    }

    /**
     * The rows to fix become the errors filter's rows. Rows loaded (a file, a paste, a run) open
     * on the rows to fix, unless the user chose Show All; rows typed in stay in view, every one
     * (a row being typed, or the one before it, never disappears), with Filter Errors a click away.
     */
    function setIssueRows(rows) {
        if (rows.size === 0) {
            hideErrorFilter();
            return;
        }
        csvState.gridErrorRows = rows;
        const btn = document.getElementById('gridErrorFilterBtn');
        if (btn) btn.disabled = false;
        setErrorFilter(csvState.gridErrorFilterTouched ? !!csvState.gridErrorFilterActive : !!csvState.gridRowsLoaded);
        refreshStepper();
    }

    function refreshStepper() {
        setTimeout(function () { if (window.BatchStepper) window.BatchStepper.refresh(); }, 0);
    }

    /**
     * One line per column and problem, for the modal:
     * "product.supplier.gln — empty in 3 rows", "quantityOnHand — must be ≥ 0 in 1 row".
     */
    function describeIssues(blankCells, ruleErrors) {
        const vars = csvState.gridTemplateVariables || [];
        const groups = new Map();
        const add = (key, label, row) => {
            if (!groups.has(key)) groups.set(key, { label, rows: new Set() });
            groups.get(key).rows.add(row);
        };
        blankCells.forEach(c => {
            const name = (vars[c.col] && vars[c.col].name) || `column ${c.col + 1}`;
            add(`blank|${name}`, `${name} — empty`, c.row);
        });
        ruleErrors.forEach(e => {
            const name = e.variable || (vars[e.col] && vars[e.col].name) || `column ${e.col + 1}`;
            add(`rule|${name}|${e.error}`, `${name} — ${e.error}`, e.row);
        });
        return Array.from(groups.values()).map(g => `${g.label} in ${g.rows.size.toLocaleString()} row${g.rows.size === 1 ? '' : 's'}`);
    }

    // =========================================================================
    // The errors filter (the footer's Filter Errors / Show All)
    // =========================================================================

    /** Filter on or off, and the button to match ("Show All" while on); the table shows the rows. */
    function setErrorFilter(on) {
        const btn = document.getElementById('gridErrorFilterBtn');
        csvState.gridErrorFilterActive = !!on;
        showGridRows();
        if (btn) btn.textContent = on ? 'Show All' : `Filter Errors (${csvState.gridErrorRows ? csvState.gridErrorRows.size : 0})`;
    }

    /** The footer button: only the rows to fix, or every row. */
    function toggleErrorFilter() {
        const btn = document.getElementById('gridErrorFilterBtn');
        if (!btn) return;
        csvState.gridErrorFilterTouched = true;
        setErrorFilter(!csvState.gridErrorFilterActive);
        updateGridHint();
    }

    /** Nothing to fix: the button rests and every row shows. */
    function hideErrorFilter() {
        refreshStepper();
        const btn = document.getElementById('gridErrorFilterBtn');
        if (btn) {
            btn.textContent = 'Filter Errors';
            btn.disabled = true;
        }
        csvState.gridErrorRows = null;
        csvState.gridErrorFilterActive = false;
        showGridRows();
    }

    /** Leaving Validate while its rows are still being checked (nothing is drawn a slice at a time any more). */
    function cancelChunkedRender() {
        if (csvState.gridRenderAbortController) {
            csvState.gridRenderAbortController.abort();
            csvState.gridRenderAbortController = null;
            hideGridLoadProgress();
            csvState.gridLoadErrors = null;
        }
    }

    // =========================================================================
    // GitHub Issue #223: Step Transition Progress + Batched Functions
    // =========================================================================

    /**
     * Show stacked progress bars in a step's content area during step transitions.
     * Reuses the same HTML structure and CSS classes as dt-data-ingestion.js file loading progress.
     * @param {string} containerId - DOM id of the step content container
     * @param {Array<{id: string, label: string}>} stages - Stage definitions
     * @returns {{ update: Function, complete: Function, cancel: Function }}
     */
    function showStepTransitionProgress(containerId, stages) {
        var container = document.getElementById(containerId);
        if (!container) return null;

        // Save original content for restoration
        var originalContent = container.innerHTML;

        // Inject stacked progress bars (same pattern as showProgressInDropzone)
        container.innerHTML =
            '<div class="csv-file-processing">' +
            '<div class="csv-processing-stages">' +
            stages.map(function (stage) {
                return '<div class="csv-stage-item" id="stage-' + stage.id + '">' +
                    '<div class="csv-stage-header">' +
                    '<span class="csv-stage-label">' + stage.label + '</span>' +
                    '<span class="csv-stage-status pending" id="status-' + stage.id + '">Pending</span>' +
                    '</div>' +
                    '<div class="csv-stage-progress-wrapper">' +
                    '<div class="csv-stage-progress-bar" data-stage-id="' + stage.id + '">' +
                    '<div class="csv-stage-progress-fill" id="progress-' + stage.id + '" style="width: 0%"></div>' +
                    '</div>' +
                    '<span class="csv-stage-percentage" id="percent-' + stage.id + '"></span>' +
                    '</div>' +
                    '</div>';
            }).join('') +
            '</div>' +
            '</div>';

        function updateStage(stageId, percentage, label) {
            var statusEl = document.getElementById('status-' + stageId);
            var progressEl = document.getElementById('progress-' + stageId);
            var percentEl = document.getElementById('percent-' + stageId);
            var stageEl = document.getElementById('stage-' + stageId);
            if (!statusEl || !progressEl || !percentEl || !stageEl) return;

            stageEl.classList.remove('stage-active', 'stage-complete');
            if (percentage === 0) {
                statusEl.textContent = 'Pending';
                statusEl.className = 'csv-stage-status pending';
                percentEl.textContent = '';
                percentEl.className = 'csv-stage-percentage';
            } else if (percentage > 0 && percentage < 100) {
                statusEl.textContent = label || 'In Progress';
                statusEl.className = 'csv-stage-status in-progress';
                percentEl.textContent = percentage + '%';
                percentEl.className = 'csv-stage-percentage';
                progressEl.style.width = percentage + '%';
                stageEl.classList.add('stage-active');
            } else if (percentage >= 100) {
                statusEl.textContent = label || 'Complete';
                statusEl.className = 'csv-stage-status complete';
                percentEl.textContent = '';
                percentEl.className = 'csv-stage-percentage complete';
                progressEl.style.width = '100%';
                stageEl.classList.add('stage-complete');
            }
        }

        function restore() {
            if (container) {
                container.innerHTML = originalContent;
            }
        }

        return {
            update: updateStage,
            complete: restore,
            cancel: restore
        };
    }

    /**
     * Batched version of applySourceFormatToRows — processes 5000 rows per rAF.
     * Called from dt-type-coercion.js during Step 2→3 transition.
     * @param {string[]} headers
     * @param {string[][]} rows
     * @param {Array} templateVars
     * @param {Function} onProgress - (processed, total)
     * @param {Function} onComplete - (convertedRows)
     */
    function applySourceFormatToRowsBatched(headers, rows, templateVars, onProgress, onComplete) {
        // Delegate to DTTypeCoercion for the actual conversion logic
        if (window.DTTypeCoercion && window.DTTypeCoercion.applySourceFormatToRowsBatched) {
            window.DTTypeCoercion.applySourceFormatToRowsBatched(headers, rows, templateVars, onProgress, onComplete);
        } else {
            // Fallback: apply synchronously
            if (window.DTTypeCoercion && window.DTTypeCoercion.applySourceFormatToRows) {
                var result = window.DTTypeCoercion.applySourceFormatToRows(headers, rows, templateVars);
                if (onProgress) onProgress(rows.length, rows.length);
                if (onComplete) onComplete(result);
            } else {
                if (onComplete) onComplete(rows);
            }
        }
    }

    /**
     * populateGridFromMappedData a slice at a time (5,000 rows a frame), telling how far: the
     * Map → Validate step's progress bars (dt-type-coercion.js).
     * @param {Object} parsedData - { headers, rows }
     * @param {Array} templateVariables
     * @param {Function} onProgress - (processed, total)
     * @param {Function} onComplete - ()
     */
    function populateGridFromMappedDataBatched(parsedData, templateVariables, onProgress, onComplete) {
        if (!parsedData || !templateVariables || templateVariables.length === 0) {
            if (onComplete) onComplete();
            return;
        }
        if (!csvState.gridInitialized && csvState.endpointConfig) initializeDataEntryGrid(csvState.endpointConfig);
        if (!csvState.gridInitialized || !csvState.gridTemplateVariables) {
            if (onComplete) onComplete();
            return;
        }
        const sources = gridColumnSources(parsedData.headers || csvState.currentHeaders || [], templateVariables);
        const rows = parsedData.rows || [];
        const gridData = [];
        const BATCH_SIZE = 5000;
        let offset = 0;
        function processBatch() {
            const end = Math.min(offset + BATCH_SIZE, rows.length);
            for (let r = offset; r < end; r++) gridData.push(gridRowFrom(rows[r], sources));
            offset = end;
            if (onProgress) onProgress(offset, rows.length);
            if (offset < rows.length) {
                requestAnimationFrame(processBatch);
            } else {
                startGridRows(gridData);
                if (onComplete) onComplete();
            }
        }
        requestAnimationFrame(processBatch);
    }

    /**
     * validateDataModelInBackground, telling how far (the step's progress bars, not the Next button).
     * @param {Function} onProgress - (processed, total)
     * @param {Function} onComplete - ()
     */
    function validateDataModelInBackgroundBatched(onProgress, onComplete) {
        const rows = modelRows();
        if (rows.length === 0) {
            finalizeVirtualGridPopulate();
            if (onComplete) onComplete();
            return;
        }
        const BATCH_SIZE = 5000;
        const total = rows.length;
        csvState.gridValidationErrors = new Map();
        csvState.gridLoadErrors = [];
        let offset = 0;
        function processBatch() {
            const end = Math.min(offset + BATCH_SIZE, total);
            for (let i = offset; i < end; i++) {
                const errors = validateDataModelRow(rows[i], i);
                if (errors.length > 0) csvState.gridValidationErrors.set(i, errors);
            }
            offset = end;
            if (onProgress) onProgress(offset, total);
            if (offset < total) {
                requestAnimationFrame(processBatch);
            } else {
                finalizeVirtualGridPopulate();
                if (onComplete) onComplete();
            }
        }
        requestAnimationFrame(processBatch);
    }

    /**
     * getGridDataAsCSV 5,000 rows a frame, telling how far (Validate → Review).
     * @param {Function} onProgress - (processed, total)
     * @param {Function} onComplete - (csvString | null)
     */
    function getGridDataAsCSVBatched(onProgress, onComplete) {
        if (!csvState.gridInitialized || !csvState.gridTemplateVariables) {
            if (onComplete) onComplete(null);
            return;
        }
        const data = modelRows();
        const csvLines = [csvState.gridTemplateVariables.map(v => v.name).join(',')];
        const BATCH_SIZE = 5000;
        const total = data.length;
        let offset = 0;
        let hasData = false;
        function processBatch() {
            const end = Math.min(offset + BATCH_SIZE, total);
            for (let r = offset; r < end; r++) {
                const row = data[r];
                if (!row.some(cell => cell !== '' && cell !== null)) continue;
                hasData = true;
                csvLines.push(row.map(csvCell).join(','));
            }
            offset = end;
            if (onProgress) onProgress(offset, total);
            if (offset < total) requestAnimationFrame(processBatch);
            else if (onComplete) onComplete(hasData ? csvLines.join('\n') : null);
        }
        if (total === 0) { if (onProgress) onProgress(1, 1); if (onComplete) onComplete(null); return; }
        requestAnimationFrame(processBatch);
    }

    // Public API - exposed on window namespace
    window.DTDataEntryGrid = {
        // Init function to receive shared state
        init: function (sharedState, vscodeFn) {
            csvState = sharedState;
            getVscode = vscodeFn;
        },

        // The lookup tables a template's lu reads (the screen gives them; Validate checks against them)
        setLookupTables,

        // Template variable extraction
        parseModifiersForGrid,
        parseTemplateVariableContent,
        extractTemplateVariablesFromEndpoint,
        analyzeGridNestingLevels,

        // The grid and its rows
        initializeDataEntryGrid,
        addGridRow,
        deleteGridRow,
        populateGridFromMappedData,
        getVanillaGridData,
        getGridDataAsCSV,
        hasGridData,
        removeEmptyGridRows,
        updateDataSourceFromGrid,
        pasteIntoGrid,

        // Tab's copying and Ctrl+D
        isInProgressiveCopyPosition,
        progressiveCopyNextLevel,
        copyFieldsFromPreviousRow,
        copyFromCellAbove,
        showProgressiveHint,
        hideProgressiveHint,
        cancelProgressiveCopy,

        // Paste that goes elsewhere
        handleGridPasteColumnMismatch,
        handleGridPasteDateTimeIssue,
        checkForUnparseableDateTimeValues,

        // Date/time formatting for inputs
        formatValueForDateInput,
        formatValueForDatetimeInput,
        formatValueForTimeInput,

        // Undo
        saveGridStateForUndo,
        undoGridChange,
        handleGridUndo,

        // Checks
        validateGridData,
        validateGridForBlankCells,
        validateDataModelRow,
        validateDataModelInBackground,
        refreshGridIssues,

        // The errors filter
        toggleErrorFilter,
        hideErrorFilter,

        // Leaving Validate mid-load
        cancelChunkedRender,

        // GitHub Issue #223: Step transition progress + batched functions
        showStepTransitionProgress,
        populateGridFromMappedDataBatched,
        validateDataModelInBackgroundBatched,
        getGridDataAsCSVBatched,
        showGridLoadProgress,
        updateGridLoadProgress,
        hideGridLoadProgress,

        // The file chosen on Source
        clearFileAndShowGrid
    };
})();

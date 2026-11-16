// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Transformer Module: Grid Data Entry
 * GitHub Issue #195: Extracted from data-transformer.js
 *
 * Contains all grid data entry functionality:
 * - Template variable extraction and parsing
 * - Grid initialization and row management
 * - Keyboard navigation and progressive copy
 * - Cell paste handling (Excel/spreadsheet)
 * - Undo/redo support
 * - Grid validation (modifiers, blank cells)
 * - Drag/drop file handling on grid
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
            hints: []               // Human-readable hints for display
        };

        if (!modifierString || modifierString.trim() === '') {
            return result;
        }

        const parts = modifierString.split('|').map(s => s.trim()).filter(s => s.length > 0);

        for (const part of parts) {
            const partLower = part.toLowerCase();

            // Empty value behavior - NOT validation rules (don't add to hints)
            if (partLower === 'opt') {
                result.isOptional = true;
                // Don't add 'optional' to hints - it shows as ○ indicator instead
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
                    // Transform, not validation
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

    /**
     * Initialize the data entry grid with columns from template variables
     * GitHub Issue #129: Vanilla JS grid implementation (replaces jspreadsheet)
     */
    function initializeDataEntryGrid(endpoint) {
        const container = document.getElementById('csvGridEntry');
        if (!container) {
            console.warn('[Grid] Container #csvGridEntry not found - modal may not be open yet');
            return;
        }

        // Extract template variables from endpoint
        const allVariables = extractTemplateVariablesFromEndpoint(endpoint);

        // GitHub Issue #137: Filter out A8 system variables - they are calculated, not user input
        // GitHub Issue #165: Filter out ENV variables - they come from environment, not user input
        const variables = allVariables.filter(v => {
            const name = v.name || '';
            if (name.toUpperCase().startsWith('A8:')) return false;
            if (name.toUpperCase().startsWith('ENV:')) return false;
            return true;
        });

        // Store for later use (filtered list)
        csvState.gridTemplateVariables = variables;

        // Analyze nesting levels for progressive Tab copy feature
        csvState.gridNestingInfo = analyzeGridNestingLevels(endpoint, variables);

        // If no user variables found, show message
        if (variables.length === 0) {
            container.innerHTML = '<p class="grid-no-variables">No template variables found in endpoint configuration. Add variables like {{ITEM_ID}} to the request body.</p>';
            return;
        }

        // Clear container and build vanilla grid
        container.innerHTML = '';

        // Create table structure
        const table = document.createElement('table');
        table.className = 'vanilla-grid';
        table.id = 'vanillaGridTable';

        // Create header row
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        // Row number header
        const rowNumHeader = document.createElement('th');
        rowNumHeader.className = 'row-num-header';
        rowNumHeader.textContent = '#';
        headerRow.appendChild(rowNumHeader);

        // Column headers from template variables
        // GitHub Issue #175: Show validation rules with dotted underline, optional with ○
        variables.forEach(v => {
            const th = document.createElement('th');
            th.dataset.type = v.dataType;

            // Check for modifiers
            const hasValidation = v.modifiers && v.modifiers.hints && v.modifiers.hints.length > 0;
            const isOptional = v.modifiers && (v.modifiers.isOptional || v.modifiers.isNullable);

            // Create header content with name
            // If has validation, add dotted underline class and tooltip
            const nameSpan = document.createElement('span');
            nameSpan.className = 'grid-header-name';
            nameSpan.textContent = v.name;
            if (hasValidation) {
                nameSpan.classList.add('grid-header-has-validation');
                nameSpan.title = v.modifiers.hints.join(', ');
            }
            th.appendChild(nameSpan);

            // Add optional indicator: hollow circle ○
            if (isOptional) {
                const optSpan = document.createElement('span');
                optSpan.className = 'grid-header-optional-indicator';
                optSpan.textContent = '\u25CB';
                optSpan.title = 'optional';
                th.appendChild(optSpan);
            }

            headerRow.appendChild(th);
        });

        // Actions header
        const actionsHeader = document.createElement('th');
        actionsHeader.className = 'actions-header';
        actionsHeader.textContent = '';
        headerRow.appendChild(actionsHeader);

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Create body
        const tbody = document.createElement('tbody');
        tbody.id = 'vanillaGridBody';
        table.appendChild(tbody);

        container.appendChild(table);

        // Add initial row
        addGridRow();

        // Add "Add Row" button
        const addRowBtn = document.createElement('button');
        addRowBtn.className = 'grid-add-row-btn';
        addRowBtn.innerHTML = '+ Add Row';
        addRowBtn.onclick = () => addGridRow();
        container.appendChild(addRowBtn);

        // Ctrl+Z (undoGridChange): on the document, so it works with nothing focused; edits are
        // recorded as cells gain and lose focus
        if (!csvState.gridUndoWired) {
            document.addEventListener('keydown', handleGridUndo);
            csvState.gridUndoWired = true;
        }
        tbody.addEventListener('focusin', beginCellEdit);
        tbody.addEventListener('focusout', endCellEdit);

        // Clear undo stack when grid is initialized
        csvState.gridUndoStack = [];

        // Mark grid as initialized
        csvState.gridInitialized = true;
        csvState.dataEntryGrid = { table, tbody }; // Store references

        // GitHub Issue #163: Initialize tab indicators
        // Cross-module call: updateTabDataIndicators is in the orchestrator
        if (window.CSVHandler && window.CSVHandler.updateTabDataIndicators) {
            window.CSVHandler.updateTabDataIndicators();
        }
    }

    /**
     * Add a new row to the vanilla grid
     */
    function addGridRow(options) {
        const skipFocus = options && options.skipFocus;

        // GitHub Issue #223: When virtual scroll is active, add to data model and re-render
        if (csvState.virtualScrollActive && csvState.gridDataModel) {
            var colCount = csvState.gridTemplateVariables ? csvState.gridTemplateVariables.length : 0;
            var newRow = new Array(colCount).fill('');
            csvState.gridDataModel.push(newRow);
            updateGridRowCount(csvState.gridDataModel.length, csvState.gridDataModel.length);

            // Scroll to bottom to show the new row
            var container = document.querySelector('.csv-grid-entry');
            if (container) {
                container.scrollTop = csvState.gridDataModel.length * VS_ROW_HEIGHT;
            }
            refreshVirtualRows();
            updateDataSourceFromGrid();
            return;
        }

        const tbody = document.getElementById('vanillaGridBody');
        if (!tbody || !csvState.gridTemplateVariables) return;

        const row = document.createElement('tr');
        const rowIndex = tbody.children.length + 1;

        // Row number cell (hover or Tab shows the delete bin)
        row.appendChild(makeRowNumCell(rowIndex, () => deleteGridRow(row)));

        // Editable cells for each column
        // GitHub Issue #175: Apply modifier constraints to inputs
        csvState.gridTemplateVariables.forEach((v, colIndex) => {
            const td = document.createElement('td');
            td.className = 'grid-cell';
            td.dataset.col = colIndex;
            td.dataset.type = v.dataType;

            // GitHub Issue #175: Get modifiers for this variable
            const mods = v.modifiers || {};

            // Mark optional/nullable cells
            if (mods.isOptional || mods.isNullable) {
                td.classList.add('grid-cell-optional');
            }

            // GitHub Issue #129: Type-specific inputs
            if (v.dataType === 'boolean' || v.dataType === 'bool') {
                // Boolean: render checkbox
                td.className = 'grid-cell grid-cell-boolean';
                if (mods.isOptional || mods.isNullable) {
                    td.classList.add('grid-cell-optional');
                }
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'grid-checkbox';
                checkbox.addEventListener('change', () => {
                    cancelProgressiveCopy(); // Cancel progressive copy on checkbox change
                    updateDataSourceFromGrid();
                });
                checkbox.addEventListener('keydown', handleGridCellKeydown);
                td.appendChild(checkbox);
            } else if (v.dataType === 'number' || v.dataType === 'integer' || v.dataType === 'int') {
                // Number: use input with validation
                td.className = 'grid-cell grid-cell-number';
                if (mods.isOptional || mods.isNullable) {
                    td.classList.add('grid-cell-optional');
                }
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'grid-number-input';
                input.inputMode = 'decimal'; // Allow decimals by default

                // GitHub Issue #175: Store constraints as data attributes for validation
                if (mods.minValue !== null) {
                    input.dataset.minValue = mods.minValue;
                    input.dataset.minExclusive = mods.minExclusive;
                }
                if (mods.maxValue !== null) {
                    input.dataset.maxValue = mods.maxValue;
                    input.dataset.maxExclusive = mods.maxExclusive;
                }
                if (mods.isInteger) {
                    input.dataset.isInteger = 'true';
                }

                input.addEventListener('input', (e) => {
                    // Allow numbers, decimal point, and minus sign
                    // Note: rnd(n) is a TRANSFORM not validation - allow any decimals
                    e.target.value = e.target.value.replace(/[^0-9.-]/g, '');
                    cancelProgressiveCopy();
                    updateDataSourceFromGrid();
                });
                input.addEventListener('keydown', handleGridCellKeydown);
                input.addEventListener('paste', handleGridCellPaste);
                td.appendChild(input);
            } else if (v.dataType === 'date') {
                // GitHub Issue #162: Date: HTML5 date input
                td.className = 'grid-cell grid-cell-date';
                if (mods.isOptional || mods.isNullable) {
                    td.classList.add('grid-cell-optional');
                }
                const input = document.createElement('input');
                input.type = 'date';
                input.className = 'grid-date-input';
                input.addEventListener('change', () => {
                    cancelProgressiveCopy();
                    updateDataSourceFromGrid();
                });
                input.addEventListener('keydown', handleGridCellKeydown);
                input.addEventListener('paste', handleGridCellPaste);
                td.appendChild(input);
            } else if (v.dataType === 'datetime' || v.dataType === 'timestamp') {
                // GitHub Issue #162: DateTime: HTML5 datetime-local input
                td.className = 'grid-cell grid-cell-datetime';
                if (mods.isOptional || mods.isNullable) {
                    td.classList.add('grid-cell-optional');
                }
                const input = document.createElement('input');
                input.type = 'datetime-local';
                input.className = 'grid-datetime-input';
                input.step = '1'; // Allow seconds
                input.addEventListener('change', () => {
                    cancelProgressiveCopy();
                    updateDataSourceFromGrid();
                });
                input.addEventListener('keydown', handleGridCellKeydown);
                input.addEventListener('paste', handleGridCellPaste);
                td.appendChild(input);
            } else if (v.dataType === 'time') {
                // GitHub Issue #162: Time: HTML5 time input
                td.className = 'grid-cell grid-cell-time';
                if (mods.isOptional || mods.isNullable) {
                    td.classList.add('grid-cell-optional');
                }
                const input = document.createElement('input');
                input.type = 'time';
                input.className = 'grid-time-input';
                input.step = '1'; // Allow seconds
                input.addEventListener('change', () => {
                    cancelProgressiveCopy();
                    updateDataSourceFromGrid();
                });
                input.addEventListener('keydown', handleGridCellKeydown);
                input.addEventListener('paste', handleGridCellPaste);
                td.appendChild(input);
            } else {
                // String/default: contenteditable cell
                td.contentEditable = 'true';

                // GitHub Issue #175: Apply string constraints
                if (mods.minLength !== null || mods.maxLength !== null) {
                    // Store constraints as data attributes for validation
                    if (mods.minLength !== null) {
                        td.dataset.minLength = mods.minLength;
                    }
                    if (mods.maxLength !== null) {
                        td.dataset.maxLength = mods.maxLength;
                    }
                    if (mods.exactLength !== null) {
                        td.dataset.exactLength = mods.exactLength;
                    }
                }

                // Store transform flags
                if (mods.toUpper) {
                    td.dataset.toUpper = 'true';
                }
                if (mods.toLower) {
                    td.dataset.toLower = 'true';
                }

                td.addEventListener('keydown', handleGridCellKeydown);
                td.addEventListener('paste', handleGridCellPaste);
                td.addEventListener('input', (e) => {
                    cancelProgressiveCopy(); // Cancel progressive copy on typing

                    // GitHub Issue #175: Apply case transforms on input
                    if (mods.toUpper && td.textContent) {
                        const sel = window.getSelection();
                        const range = sel.getRangeAt(0);
                        const offset = range.startOffset;
                        td.textContent = td.textContent.toUpperCase();
                        // Restore cursor position
                        try {
                            const newRange = document.createRange();
                            newRange.setStart(td.firstChild || td, Math.min(offset, td.textContent.length));
                            newRange.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(newRange);
                        } catch (e) { /* ignore cursor restore errors */ }
                    } else if (mods.toLower && td.textContent) {
                        const sel = window.getSelection();
                        const range = sel.getRangeAt(0);
                        const offset = range.startOffset;
                        td.textContent = td.textContent.toLowerCase();
                        // Restore cursor position
                        try {
                            const newRange = document.createRange();
                            newRange.setStart(td.firstChild || td, Math.min(offset, td.textContent.length));
                            newRange.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(newRange);
                        } catch (e) { /* ignore cursor restore errors */ }
                    }

                    updateDataSourceFromGrid();
                });
            }

            row.appendChild(td);
        });

        // Delete row button
        const actionsCell = document.createElement('td');
        actionsCell.className = 'actions-cell';
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'grid-delete-row-btn';
        deleteBtn.innerHTML = '\u00D7';
        deleteBtn.title = 'Delete row';
        deleteBtn.onclick = () => {
            row.remove();
            renumberGridRows();
            updateDataSourceFromGrid();
        };
        actionsCell.appendChild(deleteBtn);
        row.appendChild(actionsCell);

        tbody.appendChild(row);

        // Focus first cell of new row (skip during bulk population to prevent scroll-to-bottom)
        if (!skipFocus) {
            const firstCell = row.querySelector('.grid-cell');
            if (firstCell) firstCell.focus();
        }

        updateDataSourceFromGrid();
    }

    /**
     * Handle keyboard navigation in grid cells
     * Supports text cells (contenteditable), checkbox inputs, and number inputs
     * Enhanced with progressive Tab copy for nested data entry
     */
    function handleGridCellKeydown(event) {
        let cell = event.target;

        // If target is an input inside a grid-cell, get the parent cell
        if (!cell.classList.contains('grid-cell')) {
            cell = cell.closest('.grid-cell');
            if (!cell) return;
        }

        const row = cell.parentElement;
        const tbody = row.parentElement;
        const cells = Array.from(row.querySelectorAll('.grid-cell'));
        const rows = Array.from(tbody.children);
        const cellIndex = cells.indexOf(cell);
        const rowIndex = rows.indexOf(row);

        // Helper to focus a cell - handles inputs inside cells
        const focusCellAt = (targetCell) => {
            if (!targetCell) return;
            const input = targetCell.querySelector('input');
            if (input) {
                input.focus();
            } else {
                targetCell.focus();
            }
        };

        switch (event.key) {
            case 'Tab':
                event.preventDefault();
                if (event.shiftKey) {
                    // Shift+Tab: Move to previous cell, cancel progressive copy
                    cancelProgressiveCopy();
                    if (cellIndex > 0) {
                        focusCellAt(cells[cellIndex - 1]);
                    } else if (rowIndex > 0) {
                        const prevRow = rows[rowIndex - 1];
                        const prevCells = Array.from(prevRow.querySelectorAll('.grid-cell'));
                        focusCellAt(prevCells[prevCells.length - 1]);
                    }
                } else {
                    // Tab: Progressive copy logic
                    const isLastCell = cellIndex === cells.length - 1;
                    const isLastRow = rowIndex === rows.length - 1;
                    const isProgressiveActive = csvState.progressiveCopyState?.active;
                    const nestingInfo = csvState.gridNestingInfo;
                    const hasNesting = nestingInfo && (
                        (nestingInfo.l1Fields?.length > 0) ||
                        (nestingInfo.l2Fields?.length > 0) ||
                        (nestingInfo.l3Fields?.length > 0) ||
                        (nestingInfo.l4Fields?.length > 0)
                    );

                    if (isLastCell && isLastRow) {
                        // Tab from last cell of last row - add new row
                        addGridRow();
                        const newRowIndex = rows.length; // After addGridRow, this is the new row index

                        // Start progressive copy only if we have nesting info
                        if (hasNesting) {
                            csvState.progressiveCopyState = {
                                active: true,
                                currentLevel: 0,
                                newRowIndex: newRowIndex
                            };
                            showProgressiveHint(0, nestingInfo);
                        }
                    } else if (isProgressiveActive && isInProgressiveCopyPosition(rowIndex, cellIndex, nestingInfo)) {
                        // Continue progressive copy - copy values from previous row
                        // GitHub Issue #146: Focus is returned and applied here to ensure it happens
                        // after all DOM updates in progressiveCopyNextLevel are complete
                        const focusTarget = progressiveCopyNextLevel(tbody, rowIndex, nestingInfo);
                        if (focusTarget) {
                            focusCellAt(focusTarget);
                        }
                    } else {
                        // Normal Tab - move to next cell
                        cancelProgressiveCopy();
                        if (cellIndex < cells.length - 1) {
                            focusCellAt(cells[cellIndex + 1]);
                        } else if (rowIndex < rows.length - 1) {
                            const nextRow = rows[rowIndex + 1];
                            focusCellAt(nextRow.querySelector('.grid-cell'));
                        } else {
                            addGridRow();
                        }
                    }
                }
                break;

            case 'Enter':
                event.preventDefault();
                cancelProgressiveCopy();
                if (event.shiftKey) {
                    // Move up
                    if (rowIndex > 0) {
                        const prevRow = rows[rowIndex - 1];
                        const prevCells = Array.from(prevRow.querySelectorAll('.grid-cell'));
                        focusCellAt(prevCells[cellIndex]);
                    }
                } else {
                    // Move down or add row
                    if (rowIndex < rows.length - 1) {
                        const nextRow = rows[rowIndex + 1];
                        const nextCells = Array.from(nextRow.querySelectorAll('.grid-cell'));
                        focusCellAt(nextCells[cellIndex]);
                    } else {
                        addGridRow();
                    }
                }
                break;

            case 'ArrowUp':
                cancelProgressiveCopy();
                if (rowIndex > 0) {
                    const prevRow = rows[rowIndex - 1];
                    const prevCells = Array.from(prevRow.querySelectorAll('.grid-cell'));
                    focusCellAt(prevCells[cellIndex]);
                }
                break;

            case 'ArrowDown':
                cancelProgressiveCopy();
                if (rowIndex < rows.length - 1) {
                    const nextRow = rows[rowIndex + 1];
                    const nextCells = Array.from(nextRow.querySelectorAll('.grid-cell'));
                    focusCellAt(nextCells[cellIndex]);
                }
                break;

            case 'd':
            case 'D':
                // Ctrl+D: Copy value from cell above
                if (event.ctrlKey) {
                    event.preventDefault();
                    cancelProgressiveCopy();
                    copyFromCellAbove(tbody, rowIndex, cellIndex, rows, focusCellAt);
                }
                break;

            case 'Escape':
                // Clear current cell
                cancelProgressiveCopy();
                clearGridCell(cell);
                break;
        }
    }

    /**
     * Check if cursor is in the expected position for progressive copy continuation
     */
    function isInProgressiveCopyPosition(rowIndex, cellIndex, nestingInfo) {
        const state = csvState.progressiveCopyState;
        if (!state?.active || !nestingInfo) {
            return false;
        }

        // Must be in the newly added row
        if (rowIndex !== state.newRowIndex) {
            return false;
        }

        // Check position based on current level
        // GitHub Issue #146: Handle L2-first templates where level jumps 0→2
        if (state.currentLevel === 0) {
            // After adding row, should be at first cell (cell 0)
            return cellIndex === 0;
        } else if (state.currentLevel === 1 && nestingInfo.l2Fields?.length > 0) {
            // After copying L1, should be at first L2 field
            return cellIndex === nestingInfo.l2Fields[0];
        } else if (state.currentLevel === 2 && nestingInfo.l3Fields?.length > 0) {
            // After copying L2, should be at first L3 field
            return cellIndex === nestingInfo.l3Fields[0];
        } else if (state.currentLevel === 3 && nestingInfo.l4Fields?.length > 0) {
            // After copying L3, should be at first L4 field
            return cellIndex === nestingInfo.l4Fields[0];
        }

        return false;
    }

    /**
     * Execute progressive copy for the next nesting level
     * GitHub Issue #146: Handle templates without L1 variables (all vars in arrays)
     *
     * Flow:
     * - Level 0→1: Copy L1 (if any), then either:
     *   - If L1 was copied: return L2 cell for focus
     *   - If no L1: immediately copy L2, return L3 cell for focus
     * - Level 1→2: Copy L2, return L3 cell for focus
     * - Level 2→3: Copy L3, return null (stay on current cell)
     *
     * @returns {HTMLElement|null} The cell to focus, or null to stay on current cell
     */
    function progressiveCopyNextLevel(tbody, rowIndex, nestingInfo) {
        const state = csvState.progressiveCopyState;
        if (!state?.active || !nestingInfo) return null;

        const prevRowIndex = rowIndex - 1;
        if (prevRowIndex < 0) {
            cancelProgressiveCopy();
            return null;
        }

        const rows = Array.from(tbody.children);
        const currentRow = rows[rowIndex];
        const prevRow = rows[prevRowIndex];
        const cells = Array.from(currentRow.querySelectorAll('.grid-cell'));

        state.currentLevel++;

        // Level 1: Copy L1 fields (if any)
        if (state.currentLevel === 1) {
            const hasL1 = nestingInfo.l1Fields?.length > 0;
            const hasL2 = nestingInfo.l2Fields?.length > 0;
            const hasL3 = nestingInfo.l3Fields?.length > 0;
            const hasL4 = nestingInfo.l4Fields?.length > 0;

            if (hasL1) {
                // Copy L1 values from previous row
                copyFieldsFromPreviousRow(currentRow, prevRow, nestingInfo.l1Fields);

                // Return first L2 field for focus
                if (hasL2) {
                    showProgressiveHint(1, nestingInfo);
                    return cells[nestingInfo.l2Fields[0]];
                } else if (hasL3) {
                    // No L2, skip to L3
                    showProgressiveHint(2, nestingInfo);
                    state.currentLevel = 2;
                    return cells[nestingInfo.l3Fields[0]];
                } else if (hasL4) {
                    // No L2 or L3, skip to L4
                    showProgressiveHint(3, nestingInfo);
                    state.currentLevel = 3;
                    return cells[nestingInfo.l4Fields[0]];
                } else {
                    // Only L1, done
                    cancelProgressiveCopy();
                    updateDataSourceFromGrid();
                    return null;
                }
            } else if (hasL2) {
                // NO L1 - immediately copy L2 in one Tab press
                copyFieldsFromPreviousRow(currentRow, prevRow, nestingInfo.l2Fields);
                state.currentLevel = 2;  // Skip to level 2

                if (hasL3) {
                    showProgressiveHint(2, nestingInfo);
                    return cells[nestingInfo.l3Fields[0]];
                } else if (hasL4) {
                    // No L3, skip to L4
                    showProgressiveHint(3, nestingInfo);
                    state.currentLevel = 3;
                    return cells[nestingInfo.l4Fields[0]];
                } else {
                    // Only L2, done
                    cancelProgressiveCopy();
                    updateDataSourceFromGrid();
                    return null;
                }
            } else if (hasL3) {
                // Only L3 - copy it directly
                copyFieldsFromPreviousRow(currentRow, prevRow, nestingInfo.l3Fields);
                cancelProgressiveCopy();
                updateDataSourceFromGrid();
                return null;
            } else {
                cancelProgressiveCopy();
                return null;
            }
        } else if (state.currentLevel === 2) {
            // Level 2: Copy L2 fields and move to L3
            if (nestingInfo.l2Fields?.length > 0) {
                copyFieldsFromPreviousRow(currentRow, prevRow, nestingInfo.l2Fields);
            }

            // Return first L3 field for focus (or skip to L4 if no L3)
            if (nestingInfo.l3Fields?.length > 0) {
                showProgressiveHint(2, nestingInfo);
                return cells[nestingInfo.l3Fields[0]];
            } else if (nestingInfo.l4Fields?.length > 0) {
                // No L3, skip to L4
                state.currentLevel = 3;
                showProgressiveHint(3, nestingInfo);
                return cells[nestingInfo.l4Fields[0]];
            } else {
                // No L3 or L4, progressive copy done
                cancelProgressiveCopy();
                updateDataSourceFromGrid();
                return null;
            }
        } else if (state.currentLevel === 3) {
            // Level 3: Copy L3 fields and move to L4
            if (nestingInfo.l3Fields?.length > 0) {
                copyFieldsFromPreviousRow(currentRow, prevRow, nestingInfo.l3Fields);
            }

            // Return first L4 field for focus (or done if no L4)
            if (nestingInfo.l4Fields?.length > 0) {
                showProgressiveHint(3, nestingInfo);
                return cells[nestingInfo.l4Fields[0]];
            } else {
                // No L4, progressive copy done
                cancelProgressiveCopy();
                updateDataSourceFromGrid();
                return null;
            }
        } else if (state.currentLevel === 4) {
            // Level 4: Copy L4 fields (final level)
            if (nestingInfo.l4Fields?.length > 0) {
                copyFieldsFromPreviousRow(currentRow, prevRow, nestingInfo.l4Fields);
            }
            // All levels copied, stay focused on current field
            cancelProgressiveCopy();
            updateDataSourceFromGrid();
            return null;
        } else {
            // No more levels
            cancelProgressiveCopy();
            return null;
        }
    }

    /**
     * Copy field values from previous row to current row
     */
    function copyFieldsFromPreviousRow(currentRow, prevRow, fieldIndices) {
        const currentCells = Array.from(currentRow.querySelectorAll('.grid-cell'));
        const prevCells = Array.from(prevRow.querySelectorAll('.grid-cell'));

        fieldIndices.forEach(colIndex => {
            if (colIndex >= currentCells.length || colIndex >= prevCells.length) return;

            const prevCell = prevCells[colIndex];
            const currentCell = currentCells[colIndex];
            const dataType = prevCell.dataset.type;

            // Handle different cell types
            if (dataType === 'boolean' || dataType === 'bool') {
                const prevCheckbox = prevCell.querySelector('.grid-checkbox');
                const currCheckbox = currentCell.querySelector('.grid-checkbox');
                if (prevCheckbox && currCheckbox) {
                    currCheckbox.checked = prevCheckbox.checked;
                }
            } else if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
                const prevInput = prevCell.querySelector('.grid-number-input');
                const currInput = currentCell.querySelector('.grid-number-input');
                if (prevInput && currInput) {
                    currInput.value = prevInput.value;
                }
            } else {
                // String/text - contenteditable
                currentCell.textContent = prevCell.textContent;
            }
        });
    }

    /**
     * Copy value from cell above (Ctrl+D)
     * GitHub Issue #146: After copying, move to next cell like Tab
     */
    function copyFromCellAbove(tbody, rowIndex, cellIndex, rows, focusCellAt) {
        if (rowIndex <= 0) return; // No row above

        const currentRow = rows[rowIndex];
        const prevRow = rows[rowIndex - 1];
        const currentCells = Array.from(currentRow.querySelectorAll('.grid-cell'));
        const prevCells = Array.from(prevRow.querySelectorAll('.grid-cell'));

        if (cellIndex >= currentCells.length || cellIndex >= prevCells.length) return;

        const prevCell = prevCells[cellIndex];
        const currentCell = currentCells[cellIndex];
        const dataType = prevCell.dataset.type;

        // Copy based on type
        if (dataType === 'boolean' || dataType === 'bool') {
            const prevCheckbox = prevCell.querySelector('.grid-checkbox');
            const currCheckbox = currentCell.querySelector('.grid-checkbox');
            if (prevCheckbox && currCheckbox) {
                currCheckbox.checked = prevCheckbox.checked;
            }
        } else if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
            const prevInput = prevCell.querySelector('.grid-number-input');
            const currInput = currentCell.querySelector('.grid-number-input');
            if (prevInput && currInput) {
                currInput.value = prevInput.value;
            }
        } else {
            currentCell.textContent = prevCell.textContent;
        }

        updateDataSourceFromGrid();

        // Move to next cell after copying (like Tab behavior)
        if (cellIndex < currentCells.length - 1) {
            // Move to next cell in same row
            focusCellAt(currentCells[cellIndex + 1]);
        } else if (rowIndex < rows.length - 1) {
            // Move to first cell of next row
            const nextRow = rows[rowIndex + 1];
            focusCellAt(nextRow.querySelector('.grid-cell'));
        }
        // If last cell of last row, stay where we are (user can Tab to add new row)
    }

    /**
     * Clear the content of a grid cell (Escape key)
     */
    function clearGridCell(cell) {
        const dataType = cell.dataset.type;

        if (dataType === 'boolean' || dataType === 'bool') {
            const checkbox = cell.querySelector('.grid-checkbox');
            if (checkbox) checkbox.checked = false;
        } else if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
            const input = cell.querySelector('.grid-number-input');
            if (input) input.value = '';
        } else {
            cell.textContent = '';
        }

        updateDataSourceFromGrid();
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

    /**
     * Cancel progressive copy mode
     */
    function cancelProgressiveCopy() {
        csvState.progressiveCopyState = {
            active: false,
            currentLevel: 0,
            newRowIndex: -1
        };
        hideProgressiveHint();
    }

    /**
     * Handle input events to cancel progressive copy when user types
     */
    function handleGridCellInput() {
        cancelProgressiveCopy();
        updateDataSourceFromGrid();
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
     * GitHub Issue #162: Check if pasted data contains unparseable date/datetime/time values
     * These are values that can't be converted to HTML5 input formats (e.g., Excel serial dates)
     */
    function checkForUnparseableDateTimeValues(rows, cells, startColIndex, isTabSeparated) {
        for (const rowData of rows) {
            let cols;
            if (isTabSeparated || rowData.includes('\t')) {
                cols = rowData.split('\t');
            } else {
                // Cross-module call: parseCSVLine is in the orchestrator (type detection area)
                cols = window.CSVHandler.parseCSVLine ? window.CSVHandler.parseCSVLine(rowData) : rowData.split(',');
            }

            for (let colOffset = 0; colOffset < cols.length; colOffset++) {
                const targetColIndex = startColIndex + colOffset;
                if (targetColIndex >= cells.length) continue;

                const targetCell = cells[targetColIndex];
                const dataType = targetCell.dataset.type;
                const value = cols[colOffset]?.trim();

                if (!value || value === '' || value === '-') continue;

                // Check date/datetime/time columns for unparseable values
                if (dataType === 'date') {
                    const formatted = formatValueForDateInput(value);
                    if (formatted === null) {
                        console.log('[checkForUnparseableDateTimeValues] Unparseable date value:', value);
                        return true;
                    }
                } else if (dataType === 'datetime' || dataType === 'timestamp') {
                    const formatted = formatValueForDatetimeInput(value);
                    if (formatted === null) {
                        console.log('[checkForUnparseableDateTimeValues] Unparseable datetime value:', value);
                        return true;
                    }
                } else if (dataType === 'time') {
                    const formatted = formatValueForTimeInput(value);
                    if (formatted === null) {
                        console.log('[checkForUnparseableDateTimeValues] Unparseable time value:', value);
                        return true;
                    }
                }
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
     * Handle paste from Excel/spreadsheets into grid
     */
    function handleGridCellPaste(event) {
        event.preventDefault();
        const clipboardData = event.clipboardData || window.clipboardData;
        const pastedText = clipboardData.getData('text');

        if (!pastedText) return;

        // Parse pasted data (tab-separated for Excel, could also be comma-separated)
        const rows = pastedText.trim().split(/\r?\n/);

        // GitHub Issue #162: Handle both input elements and contenteditable cells
        // For inputs, the target is the input inside a td.grid-cell
        // For contenteditable, the target is the td.grid-cell itself
        let targetElement = event.target;
        let cell = targetElement.classList.contains('grid-cell') ? targetElement : targetElement.closest('.grid-cell');
        if (!cell) {
            console.warn('[handleGridCellPaste] Could not find grid-cell for paste target');
            return;
        }

        const currentRow = cell.parentElement;
        const tbody = currentRow.parentElement;
        const allRows = Array.from(tbody.children).filter(r => !r.classList.contains('vs-spacer'));
        // GitHub Issue #223: Use absolute row index from data attribute in virtual scroll mode
        let startRowIndex;
        if (csvState.virtualScrollActive && currentRow.dataset.vsRowIndex !== undefined) {
            startRowIndex = parseInt(currentRow.dataset.vsRowIndex, 10);
        } else {
            startRowIndex = allRows.indexOf(currentRow);
        }
        const cells = Array.from(currentRow.querySelectorAll('.grid-cell'));
        const startColIndex = cells.indexOf(cell);

        // GitHub Issue #135: Get expected column count
        const expectedColCount = cells.length - startColIndex;

        // GitHub Issue #135, #163: Check if data has different column count than grid
        // GitHub Issue #178: Also detect pipe-delimited data
        const isTabSeparated = rows.some(row => row.includes('\t'));
        const isPipeSeparated = !isTabSeparated && rows.some(row => row.includes('|'));

        // Parse first row to get actual column count
        let firstRowCols;
        if (isTabSeparated) {
            firstRowCols = rows[0].split('\t');
        } else if (isPipeSeparated) {
            firstRowCols = rows[0].split('|').map(f => f.trim());
        } else {
            // Cross-module call: parseCSVLine is in the orchestrator (type detection area)
            firstRowCols = window.CSVHandler.parseCSVLine ? window.CSVHandler.parseCSVLine(rows[0]) : rows[0].split(',');
        }

        // Issue #252: Only redirect when pasted data has MORE columns than fit
        // from the target cell. Fewer (e.g. a single value into a single cell)
        // should paste in place — the loop below already handles partial widths.
        if (firstRowCols.length > expectedColCount) {
            // If grid already has user data, don't redirect — show error in Step 3
            if (hasGridData()) {
                if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                    window.CSVHandler.showModalNotification(
                        'warning',
                        `Pasted data has ${firstRowCols.length} columns but only ${expectedColCount} fit from the selected cell. Fix the data and try again.`,
                        { blocking: false }
                    );
                }
                return;
            }
            handleGridPasteColumnMismatch(pastedText, firstRowCols.length, expectedColCount, isTabSeparated);
            return; // Don't paste in grid - data has been moved to paste area
        }

        // GitHub Issue #162: Pre-check for unparseable date/datetime/time values
        // If any values can't be converted for HTML5 inputs, redirect to paste area
        const hasUnparseableDateTimeValues = checkForUnparseableDateTimeValues(rows, cells, startColIndex, isTabSeparated);
        if (hasUnparseableDateTimeValues) {
            // If grid already has user data, don't redirect — show error in Step 3
            if (hasGridData()) {
                if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                    window.CSVHandler.showModalNotification(
                        'warning',
                        'Pasted data contains date/time values that cannot be parsed. Fix the values and try again.',
                        { blocking: false }
                    );
                }
                return;
            }
            handleGridPasteDateTimeIssue(pastedText);
            return; // Don't paste in grid - data has been moved to paste area
        }

        // GitHub Issue #162: Save grid state before paste for Ctrl+Z undo
        saveGridStateForUndo();

        rows.forEach((rowData, rowOffset) => {
            // GitHub Issue #135: Properly parse CSV/TSV/PSV - handle quoted fields with commas
            let cols;
            if (rowData.includes('\t')) {
                // Tab-separated (Excel paste) - split by tabs (preferred, handles commas in values)
                cols = rowData.split('\t');
            } else if (isPipeSeparated) {
                // GitHub Issue #178: Pipe-separated - split by pipes and trim
                cols = rowData.split('|').map(f => f.trim());
            } else {
                // Comma-separated - use proper CSV parsing for quoted fields
                // Cross-module call: parseCSVLine is in the orchestrator (type detection area)
                cols = window.CSVHandler.parseCSVLine ? window.CSVHandler.parseCSVLine(rowData) : rowData.split(',');
            }
            let targetRowIndex = startRowIndex + rowOffset;

            // Add rows if needed
            while (targetRowIndex >= allRows.length) {
                addGridRow();
                allRows.push(tbody.lastElementChild);
            }

            const targetRow = allRows[targetRowIndex];
            const targetCells = targetRow.querySelectorAll('.grid-cell');

            cols.forEach((colData, colOffset) => {
                const targetColIndex = startColIndex + colOffset;
                if (targetColIndex < targetCells.length) {
                    const targetCell = targetCells[targetColIndex];
                    const dataType = targetCell.dataset.type;
                    const value = colData.trim();

                    // GitHub Issue #135: Preserve raw values on paste - transformation happens in Step 2
                    if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
                        const input = targetCell.querySelector('.grid-number-input');
                        if (input) {
                            input.value = value;
                            input.type = 'text';
                        }
                    } else if (dataType === 'boolean' || dataType === 'bool') {
                        const checkbox = targetCell.querySelector('input[type="checkbox"]');
                        if (checkbox) {
                            const lowerVal = value.toLowerCase();
                            checkbox.checked = lowerVal === 'true' || lowerVal === 'yes' || lowerVal === 'y' || value === '1';
                        }
                    } else if (dataType === 'date') {
                        const input = targetCell.querySelector('.grid-date-input');
                        if (input) {
                            const formattedDate = formatValueForDateInput(value);
                            if (formattedDate) input.value = formattedDate;
                        }
                    } else if (dataType === 'datetime' || dataType === 'timestamp') {
                        const input = targetCell.querySelector('.grid-datetime-input');
                        if (input) {
                            const formattedDatetime = formatValueForDatetimeInput(value);
                            if (formattedDatetime) input.value = formattedDatetime;
                        }
                    } else if (dataType === 'time') {
                        const input = targetCell.querySelector('.grid-time-input');
                        if (input) {
                            const formattedTime = formatValueForTimeInput(value);
                            if (formattedTime) input.value = formattedTime;
                        }
                    } else {
                        targetCell.textContent = value;
                    }

                    // GitHub Issue #223: Sync pasted value to data model
                    if (csvState.virtualScrollActive && csvState.gridDataModel && csvState.gridDataModel[targetRowIndex]) {
                        csvState.gridDataModel[targetRowIndex][targetColIndex] = value;
                    }
                }
            });
        });

        updateDataSourceFromGrid();
    }

    // =========================================================================
    // Grid undo (Ctrl+Z): every edit, delete and paste, in order — back to the data as loaded
    // =========================================================================
    //
    // Entries, newest last in csvState.gridUndoStack:
    //   { type: 'cell', row, col, before }   a cell edit, recorded when the cell loses focus
    //   { type: 'delete', index, values }    a deleted row and where it was
    //   { type: 'snapshot', data, rowCount } the whole grid before a paste
    // Rows are data-model indices (large grids) or row positions (small grids); undoing in
    // reverse order keeps them right. A new load clears the history (populateGridFromMappedData).

    const UNDO_LIMIT = 1000;
    let editStart = null;   // { row, col, value } of the cell being edited

    function pushUndo(entry) {
        if (!csvState.gridUndoStack) csvState.gridUndoStack = [];
        if (csvState.gridUndoStack.length >= UNDO_LIMIT) csvState.gridUndoStack.shift();
        csvState.gridUndoStack.push(entry);
    }

    /** Before a paste: the whole grid, so one Ctrl+Z puts it back. */
    function saveGridStateForUndo() {
        commitCellEdit();
        const data = csvState.virtualScrollActive && csvState.gridDataModel
            ? csvState.gridDataModel.map(function (r) { return r.slice(); })
            : getVanillaGridData();
        pushUndo({ type: 'snapshot', data: data, rowCount: data.length });
    }

    function gridRowElements() {
        const tbody = document.getElementById('vanillaGridBody');
        return tbody ? Array.from(tbody.children).filter(r => !r.classList.contains('vs-spacer')) : [];
    }

    /** Where a cell is: its data row and column. */
    function cellPosition(td) {
        const tr = td.closest('tr');
        if (!tr) return null;
        const col = Array.from(tr.querySelectorAll('.grid-cell')).indexOf(td);
        const row = tr.dataset.vsRowIndex !== undefined ? Number(tr.dataset.vsRowIndex) : gridRowElements().indexOf(tr);
        return row < 0 || col < 0 ? null : { row, col };
    }

    function cellElementAt(row, col) {
        let tr;
        if (csvState.virtualScrollActive) {
            tr = document.querySelector(`#vanillaGridBody tr[data-vs-row-index="${row}"]`);
        } else {
            tr = gridRowElements()[row];
        }
        return tr ? tr.querySelectorAll('.grid-cell')[col] || null : null;
    }

    function getCellValueAt(row, col) {
        if (csvState.virtualScrollActive && csvState.gridDataModel) {
            const r = csvState.gridDataModel[row];
            return r ? (r[col] || '') : '';
        }
        const td = cellElementAt(row, col);
        return td ? getCellValue(td, td.dataset.type) : '';
    }

    /** Put a value into a cell on screen (whatever its editor), and into the data model. */
    function setCellValueAt(row, col, value) {
        if (csvState.virtualScrollActive && csvState.gridDataModel && csvState.gridDataModel[row]) {
            csvState.gridDataModel[row][col] = value;
        }
        const td = cellElementAt(row, col);
        if (td) setCellElementValue(td, value);
    }

    function setCellElementValue(cell, cellValue) {
        const dataType = cell.dataset.type;
        if (dataType === 'boolean' || dataType === 'bool') {
            const checkbox = cell.querySelector('.grid-checkbox');
            if (checkbox) checkbox.checked = cellValue === 'true';
        } else if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
            const input = cell.querySelector('.grid-number-input');
            if (input) input.value = cellValue || '';
        } else if (dataType === 'date') {
            const input = cell.querySelector('.grid-date-input');
            if (input) input.value = cellValue || '';
        } else if (dataType === 'datetime' || dataType === 'timestamp') {
            const input = cell.querySelector('.grid-datetime-input');
            if (input) input.value = cellValue || '';
        } else if (dataType === 'time') {
            const input = cell.querySelector('.grid-time-input');
            if (input) input.value = cellValue || '';
        } else {
            cell.textContent = cellValue || '';
        }
    }

    /** A cell gained focus: remember its value, so leaving it records the edit. */
    function beginCellEdit(event) {
        const td = event.target && event.target.closest ? event.target.closest('.grid-cell') : null;
        if (!td) return;
        const pos = cellPosition(td);
        if (!pos) return;
        if (editStart && (editStart.row !== pos.row || editStart.col !== pos.col)) commitCellEdit();
        if (!editStart) editStart = { row: pos.row, col: pos.col, value: getCellValueAt(pos.row, pos.col) };
    }

    /** The edited cell lost focus (or something else is about to change): record the edit. */
    function commitCellEdit() {
        if (!editStart) return;
        const before = editStart;
        editStart = null;
        if (getCellValueAt(before.row, before.col) !== before.value) {
            pushUndo({ type: 'cell', row: before.row, col: before.col, before: before.value });
        }
    }

    function endCellEdit(event) {
        // Focus moving to another cell of the same edit target is not an edit ending
        const leaving = event.target && event.target.closest ? event.target.closest('.grid-cell') : null;
        const entering = event.relatedTarget && event.relatedTarget.closest ? event.relatedTarget.closest('.grid-cell') : null;
        if (leaving && entering === leaving) return;
        commitCellEdit();
    }

    /**
     * Ctrl+Z: a cell being edited goes back to how it was before the edit; otherwise the
     * last change (edit, delete or paste) is undone. Repeat to get back to the data as loaded.
     * Every row is checked again afterwards.
     */
    function undoGridChange() {
        // The cell being edited first
        if (editStart && getCellValueAt(editStart.row, editStart.col) !== editStart.value) {
            setCellValueAt(editStart.row, editStart.col, editStart.value);
            afterGridUndo();
            return true;
        }
        commitCellEdit();
        const entry = csvState.gridUndoStack && csvState.gridUndoStack.pop();
        if (!entry) return false;

        if (entry.type === 'cell') {
            setCellValueAt(entry.row, entry.col, entry.before);
        } else if (entry.type === 'delete') {
            insertGridRowAt(entry.index, entry.values);
        } else {
            restoreGridSnapshot(entry);
        }
        afterGridUndo();
        return true;
    }

    // Kept for callers of the old name
    const undoGridPaste = undoGridChange;

    function afterGridUndo() {
        if (!csvState.virtualScrollActive) renumberGridRows();
        const total = csvState.virtualScrollActive && csvState.gridDataModel ? csvState.gridDataModel.length : gridRowElements().length;
        updateGridRowCount(total, total);
        refreshGridIssues();
        updateDataSourceFromGrid();
    }

    function insertGridRowAt(index, values) {
        if (csvState.virtualScrollActive && csvState.gridDataModel) {
            csvState.gridDataModel.splice(index, 0, values.slice());
            return;
        }
        const tbody = document.getElementById('vanillaGridBody');
        if (!tbody) return;
        addGridRow({ skipFocus: true });
        const added = tbody.lastElementChild;
        const before = gridRowElements()[index];
        if (added && before && before !== added) tbody.insertBefore(added, before);
        const cells = added ? added.querySelectorAll('.grid-cell') : [];
        values.forEach((v, col) => { if (cells[col]) setCellElementValue(cells[col], v); });
    }

    function restoreGridSnapshot(previousState) {
        if (csvState.virtualScrollActive) {
            csvState.gridDataModel = previousState.data.map(function (r) { return r.slice(); });
            return;
        }
        const tbody = document.getElementById('vanillaGridBody');
        if (!tbody) return;
        while (tbody.children.length > previousState.rowCount) tbody.lastElementChild.remove();
        while (tbody.children.length < previousState.rowCount) addGridRow({ skipFocus: true });
        const rows = tbody.children;
        previousState.data.forEach((rowData, rowIndex) => {
            if (rowIndex >= rows.length) return;
            const cells = rows[rowIndex].querySelectorAll('.grid-cell');
            rowData.forEach((cellValue, colIndex) => {
                if (colIndex < cells.length) setCellElementValue(cells[colIndex], cellValue);
            });
        });
    }

    /** Ctrl+Z anywhere on Validate (focus may be on nothing, e.g. after a delete removed it). */
    function handleGridUndo(event) {
        if (!(event.ctrlKey || event.metaKey) || event.shiftKey || String(event.key).toLowerCase() !== 'z') return;
        if (csvState.modalStep !== 3 || document.querySelector('.dbmn-modal-backdrop, .dbmn-modal-overlay')) return;
        const active = document.activeElement;
        const inGrid = active && active.closest && active.closest('#vanillaGridBody');
        if (active && !inGrid && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;   // someone else's field
        const editing = editStart && getCellValueAt(editStart.row, editStart.col) !== editStart.value;
        if (!editing && !(csvState.gridUndoStack && csvState.gridUndoStack.length)) return;
        event.preventDefault();
        undoGridChange();
    }

    /**
     * Renumber grid rows after deletion
     */
    function renumberGridRows() {
        const tbody = document.getElementById('vanillaGridBody');
        if (!tbody) return;

        Array.from(tbody.children).forEach((row, index) => {
            const num = row.querySelector('.row-num-cell .row-num');
            const bin = row.querySelector('.row-num-cell .row-delete-btn');
            if (num) num.textContent = index + 1;
            if (bin) bin.setAttribute('aria-label', `Delete row ${index + 1}`);
        });
    }

    /** The row number, and in its place on hover or focus a bin that deletes the row. */
    function makeRowNumCell(displayNumber, onDelete) {
        const td = document.createElement('td');
        td.className = 'row-num-cell';
        const num = document.createElement('span');
        num.className = 'row-num';
        num.textContent = displayNumber;
        const bin = document.createElement('button');
        bin.type = 'button';
        bin.className = 'row-delete-btn icon';
        bin.dataset.icon = 'trash-2';
        bin.title = 'Delete row (Ctrl+Z to undo)';
        bin.setAttribute('aria-label', `Delete row ${displayNumber}`);
        bin.addEventListener('click', (event) => {
            event.stopPropagation();
            onDelete();
        });
        if (window.Icons && window.Icons.setIcon) window.Icons.setIcon(bin, 'trash-2');
        td.appendChild(num);
        td.appendChild(bin);
        return td;
    }

    /**
     * Delete one row from this run (never from the file or the run the rows came from). Any
     * source, any grid size. Ctrl+Z puts it back. Every row is checked again afterwards, so
     * the filter, the hint and the step bar follow.
     */
    function deleteGridRow(rowOrIndex) {
        commitCellEdit();
        if (csvState.virtualScrollActive && csvState.gridDataModel) {
            const removed = csvState.gridDataModel.splice(rowOrIndex, 1)[0];
            if (removed) pushUndo({ type: 'delete', index: rowOrIndex, values: removed.slice() });
            updateGridRowCount(csvState.gridDataModel.length, csvState.gridDataModel.length);
        } else if (rowOrIndex && rowOrIndex.remove) {
            const index = gridRowElements().indexOf(rowOrIndex);
            const values = Array.from(rowOrIndex.querySelectorAll('.grid-cell')).map(td => getCellValue(td, td.dataset.type));
            rowOrIndex.remove();
            if (index >= 0) pushUndo({ type: 'delete', index, values });
            renumberGridRows();
        }
        refreshGridIssues();
        updateDataSourceFromGrid();
    }

    /**
     * Update data source tracking when grid content changes
     */
    function updateDataSourceFromGrid() {
        if (!csvState.gridInitialized) return;
        scheduleGridIssueRefresh();

        // GitHub Issue #175: Keep validation errors visible until user hits NEXT again
        // Error highlights are cleared in goToNextStep() when validation passes

        if (hasGridData() && !csvState.currentFile) {
            csvState.sourceType = 'grid';
            csvState.sourceFileName = null;
        }

        // GitHub Issue #202: Grid is now a full step (Step 3), not a tab.
        // Update navigation buttons to reflect grid data state.
        // Cross-module call: updateCSVNavigationButtons is in the orchestrator
        if (window.CSVHandler && window.CSVHandler.updateCSVNavigationButtons) {
            window.CSVHandler.updateCSVNavigationButtons();
        }
    }

    /**
     * Get data from vanilla grid as array of arrays
     * Handles different cell types (checkbox, number input, text)
     */
    function getVanillaGridData() {
        // GitHub Issue #223: Return from data model when virtual scroll is active
        if (csvState.virtualScrollActive && csvState.gridDataModel) {
            return csvState.gridDataModel.map(function (row) { return row.slice(); });
        }

        const tbody = document.getElementById('vanillaGridBody');
        if (!tbody) return [];

        const data = [];
        Array.from(tbody.children).forEach(row => {
            if (row.classList.contains('vs-spacer')) return; // Skip virtual scroll spacers
            const rowData = [];
            row.querySelectorAll('.grid-cell').forEach(cell => {
                const dataType = cell.dataset.type;

                // GitHub Issue #129: Handle type-specific inputs
                if (dataType === 'boolean' || dataType === 'bool') {
                    const checkbox = cell.querySelector('.grid-checkbox');
                    rowData.push(checkbox?.checked ? 'true' : 'false');
                } else if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
                    const input = cell.querySelector('.grid-number-input');
                    rowData.push(input?.value || '');
                } else if (dataType === 'date') {
                    const input = cell.querySelector('.grid-date-input');
                    rowData.push(input?.value || '');
                } else if (dataType === 'datetime' || dataType === 'timestamp') {
                    const input = cell.querySelector('.grid-datetime-input');
                    rowData.push(input?.value || '');
                } else if (dataType === 'time') {
                    const input = cell.querySelector('.grid-time-input');
                    rowData.push(input?.value || '');
                } else {
                    rowData.push(cell.textContent || '');
                }
            });
            if (rowData.length > 0) data.push(rowData);
        });
        return data;
    }

    /**
     * Get data from the grid as CSV-compatible format
     */
    function getGridDataAsCSV() {
        if (!csvState.gridInitialized || !csvState.gridTemplateVariables) {
            return null;
        }

        const headers = csvState.gridTemplateVariables.map(v => v.name);

        // GitHub Issue #223: Read from data model when virtual scroll is active
        const data = (csvState.virtualScrollActive && csvState.gridDataModel)
            ? csvState.gridDataModel
            : getVanillaGridData();

        // Filter out empty rows
        const nonEmptyRows = data.filter(row => row.some(cell => cell !== '' && cell !== null));

        if (nonEmptyRows.length === 0) {
            return null;
        }

        // Build CSV string
        const csvLines = [headers.join(',')];
        nonEmptyRows.forEach(row => {
            const escapedRow = row.map(cell => {
                const cellStr = cell || '';
                if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
                    return `"${cellStr.replace(/"/g, '""')}"`;
                }
                return cellStr;
            });
            csvLines.push(escapedRow.join(','));
        });

        return csvLines.join('\n');
    }

    /**
     * Check if grid has any data entered
     */
    function hasGridData() {
        if (!csvState.gridInitialized) return false;

        // GitHub Issue #223: Check data model directly when virtual scroll is active
        if (csvState.virtualScrollActive && csvState.gridDataModel) {
            return csvState.gridDataModel.length > 0 &&
                csvState.gridDataModel.some(function (row) { return row.some(function (cell) { return cell !== '' && cell !== null; }); });
        }

        const data = getVanillaGridData();
        return data.some(row => row.some(cell => cell !== '' && cell !== null));
    }

    /**
     * Remove completely empty rows from grid
     * GitHub Issue #154: Empty rows should be auto-deleted, not cause validation errors
     */
    function removeEmptyGridRows() {
        // GitHub Issue #223: Filter data model when virtual scroll is active
        if (csvState.virtualScrollActive && csvState.gridDataModel) {
            var originalLength = csvState.gridDataModel.length;
            csvState.gridDataModel = csvState.gridDataModel.filter(function (rowData) {
                return rowData.some(function (cell, colIndex) {
                    var v = csvState.gridTemplateVariables[colIndex];
                    if (v && (v.dataType === 'boolean' || v.dataType === 'bool')) {
                        var lv = (cell || '').toLowerCase();
                        return lv === 'true' || lv === 'yes' || lv === 'y' || cell === '1';
                    }
                    return cell && cell.trim() !== '';
                });
            });
            var removedCount = originalLength - csvState.gridDataModel.length;
            if (removedCount > 0) {
                // Re-validate after removing rows
                csvState.gridValidationErrors = new Map();
                for (var i = 0; i < csvState.gridDataModel.length; i++) {
                    var errors = validateDataModelRow(csvState.gridDataModel[i], i);
                    if (errors.length > 0) csvState.gridValidationErrors.set(i, errors);
                }
                refreshVirtualRows();
                updateGridRowCount(csvState.gridDataModel.length, csvState.gridDataModel.length);
                updateDataSourceFromGrid();
            }
            return;
        }

        const tbody = document.getElementById('vanillaGridBody');
        if (!tbody) return;

        const rows = Array.from(tbody.children);
        let removedCount2 = 0;

        rows.forEach(row => {
            if (row.classList.contains('vs-spacer')) return;
            const cells = Array.from(row.querySelectorAll('.grid-cell'));
            const isEmpty = cells.every(cell => {
                const dataType = cell.dataset.type;
                if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
                    const input = cell.querySelector('.grid-number-input');
                    return !input?.value?.trim();
                } else if (dataType === 'boolean' || dataType === 'bool') {
                    const checkbox = cell.querySelector('input[type="checkbox"]');
                    return !checkbox?.checked;
                } else if (dataType === 'date') {
                    const input = cell.querySelector('.grid-date-input');
                    return !input?.value?.trim();
                } else if (dataType === 'datetime' || dataType === 'timestamp') {
                    const input = cell.querySelector('.grid-datetime-input');
                    return !input?.value?.trim();
                } else if (dataType === 'time') {
                    const input = cell.querySelector('.grid-time-input');
                    return !input?.value?.trim();
                } else {
                    return !cell.textContent?.trim();
                }
            });

            if (isEmpty) {
                row.remove();
                removedCount2++;
            }
        });

        if (removedCount2 > 0) {
            renumberGridRows();
            updateDataSourceFromGrid();
        }
    }

    /**
     * GitHub Issue #175: Validate grid data against modifier constraints
     * Returns validation result with list of invalid cells and error messages
     * This validation BLOCKS navigation - user must fix errors to proceed
     */
    /**
     * Validate a single grid row and return errors for that row.
     * Highlights error cells immediately via grid-cell-error class.
     */
    function validateGridRow(row, rowIndex) {
        const rowErrors = [];
        if (!csvState.gridTemplateVariables) return rowErrors;

        row.querySelectorAll('.grid-cell').forEach((cell, colIndex) => {
            const variable = csvState.gridTemplateVariables[colIndex];
            if (!variable || !variable.modifiers) {
                return;
            }

            const mods = variable.modifiers;
            const dataType = variable.dataType;
            let value = getCellValue(cell, dataType);

            // Skip validation for optional/nullable fields when empty
            if ((mods.isOptional || mods.isNullable) && (!value || value.trim() === '')) {
                return;
            }

            // Skip validation for empty required fields (handled by blank cell validation)
            if (!value || value.trim() === '') {
                return;
            }

            value = value.trim();

            // String validations
            if (dataType === 'string') {
                const len = value.length;

                // Exact length check
                if (mods.exactLength !== null && len !== mods.exactLength) {
                    rowErrors.push({
                        row: rowIndex, col: colIndex, cell,
                        variable: variable.name, value,
                        error: `must be exactly ${mods.exactLength} characters (got ${len})`
                    });
                    return;
                }

                // Min length check
                if (mods.minLength !== null && len < mods.minLength) {
                    rowErrors.push({
                        row: rowIndex, col: colIndex, cell,
                        variable: variable.name, value,
                        error: `minimum ${mods.minLength} characters required (got ${len})`
                    });
                    return;
                }

                // Max length check
                if (mods.maxLength !== null && len > mods.maxLength) {
                    rowErrors.push({
                        row: rowIndex, col: colIndex, cell,
                        variable: variable.name, value,
                        error: `maximum ${mods.maxLength} characters allowed (got ${len})`
                    });
                    return;
                }
            }

            // Number validations
            if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
                const num = parseFloat(value);

                if (isNaN(num)) {
                    rowErrors.push({
                        row: rowIndex, col: colIndex, cell,
                        variable: variable.name, value,
                        error: 'must be a valid number'
                    });
                    return;
                }

                // Integer check
                if (mods.isInteger && !Number.isInteger(num)) {
                    rowErrors.push({
                        row: rowIndex, col: colIndex, cell,
                        variable: variable.name, value,
                        error: 'must be an integer (no decimals)'
                    });
                    return;
                }

                // Min value check
                if (mods.minValue !== null) {
                    const passes = mods.minExclusive ? num > mods.minValue : num >= mods.minValue;
                    if (!passes) {
                        const op = mods.minExclusive ? '>' : '\u2265';
                        rowErrors.push({
                            row: rowIndex, col: colIndex, cell,
                            variable: variable.name, value,
                            error: `must be ${op} ${mods.minValue}`
                        });
                        return;
                    }
                }

                // Max value check
                if (mods.maxValue !== null) {
                    const passes = mods.maxExclusive ? num < mods.maxValue : num <= mods.maxValue;
                    if (!passes) {
                        const op = mods.maxExclusive ? '<' : '\u2264';
                        rowErrors.push({
                            row: rowIndex, col: colIndex, cell,
                            variable: variable.name, value,
                            error: `must be ${op} ${mods.maxValue}`
                        });
                        return;
                    }
                }
            }
        });

        // Highlight immediately
        rowErrors.forEach(({ cell }) => {
            if (cell) cell.classList.add('grid-cell-error');
        });

        return rowErrors;
    }

    function validateGridData() {
        // GitHub Issue #223: Use data model validation when virtual scroll is active
        if (csvState.virtualScrollActive && csvState.gridDataModel) {
            var errors = [];
            csvState.gridValidationErrors = new Map();
            for (var i = 0; i < csvState.gridDataModel.length; i++) {
                var rowErrors = validateDataModelRow(csvState.gridDataModel[i], i);
                if (rowErrors.length > 0) {
                    csvState.gridValidationErrors.set(i, rowErrors);
                    errors.push.apply(errors, rowErrors);
                }
            }
            // Re-render to show updated error highlights
            refreshVirtualRows();
            var count = errors.length;
            return {
                valid: count === 0,
                errors: errors,
                message: count === 0 ? '' : count + ' validation error' + (count !== 1 ? 's' : '') + ' found'
            };
        }

        const tbody = document.getElementById('vanillaGridBody');
        if (!tbody || !csvState.gridTemplateVariables) {
            return { valid: true, errors: [], message: '' };
        }

        const errors2 = [];
        Array.from(tbody.children).forEach((row, rowIndex) => {
            errors2.push(...validateGridRow(row, rowIndex));
        });

        const count2 = errors2.length;
        return {
            valid: count2 === 0,
            errors: errors2,
            message: count2 === 0 ? '' : `${count2} validation error${count2 !== 1 ? 's' : ''} found`
        };
    }

    /**
     * Helper to get cell value based on data type
     */
    function getCellValue(cell, dataType) {
        if (dataType === 'boolean' || dataType === 'bool') {
            const checkbox = cell.querySelector('.grid-checkbox');
            return checkbox?.checked ? 'true' : 'false';
        } else if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
            const input = cell.querySelector('.grid-number-input');
            return input?.value || '';
        } else if (dataType === 'date') {
            const input = cell.querySelector('.grid-date-input');
            return input?.value || '';
        } else if (dataType === 'datetime' || dataType === 'timestamp') {
            const input = cell.querySelector('.grid-datetime-input');
            return input?.value || '';
        } else if (dataType === 'time') {
            const input = cell.querySelector('.grid-time-input');
            return input?.value || '';
        } else {
            return cell.textContent || '';
        }
    }

    /**
     * GitHub Issue #175: Highlight grid cells with validation errors (amber/warning color)
     */
    function highlightGridErrorCells(errors) {
        // GitHub Issue #223: cell may be null when using data model (virtual scroll) — error styling
        // is applied via gridValidationErrors Map in renderVirtualRow() instead
        errors.forEach(({ cell }) => {
            if (cell) cell.classList.add('grid-cell-error');
        });
    }

    /**
     * GitHub Issue #175: Clear all grid error highlights
     */
    function clearGridErrorCellHighlights() {
        document.querySelectorAll('.grid-cell-error').forEach(cell => {
            cell.classList.remove('grid-cell-error');
        });
    }

    /**
     * GitHub Issue #175: Show grid validation errors in modal footer
     * Uses showModalNotification for consistent footer messaging
     */
    function showGridValidationErrors(validationResult) {
        hideGridValidationErrors();


        // Group errors by column + error type for a concise summary
        const grouped = {};
        for (const e of validationResult.errors) {
            const key = `${e.variable}|||${e.error}`;
            if (!grouped[key]) {
                grouped[key] = { variable: e.variable, error: e.error, count: 0 };
            }
            grouped[key].count++;
        }

        const summaries = Object.values(grouped);
        const parts = summaries.slice(0, 3).map(g => {
            const countText = g.count === 1 ? '1 invalid record' : `${g.count} invalid records`;
            return `"${g.variable}" has ${countText} — ${g.error}`;
        });

        const moreCount = summaries.length - parts.length;
        const moreText = moreCount > 0 ? ` (+${moreCount} more columns)` : '';

        const message = `${parts.join(' | ')}${moreText}`;

        // Use the modal notification system (footer notification)
        // Signature: showModalNotification(type, message, options)
        // Use 'warning' type for amber color (matches amber cell highlighting)
        // Cross-module call: showModalNotification is in the orchestrator
        if (window.CSVHandler && window.CSVHandler.showModalNotification) {
            window.CSVHandler.showModalNotification('warning', message, { persistent: true });
        }
    }

    /**
     * GitHub Issue #175: Hide grid validation errors
     */
    function hideGridValidationErrors() {
        // Clear modal notification
        // Cross-module call: clearModalNotification is in the orchestrator
        if (window.CSVHandler && window.CSVHandler.clearModalNotification) {
            window.CSVHandler.clearModalNotification();
        }
        // Also remove any fallback container
        const existing = document.getElementById('gridValidationErrors');
        if (existing) {
            existing.remove();
        }
    }

    /**
     * Validate grid for blank cells
     * Returns validation result with list of blank cells
     * GitHub Issue #175: Skip optional/nullable fields - they're allowed to be blank
     */
    function validateGridForBlankCells() {
        // GitHub Issue #223: Use data model when virtual scroll is active
        if (csvState.virtualScrollActive && csvState.gridDataModel) {
            var blankCells = [];
            for (var rowIndex = 0; rowIndex < csvState.gridDataModel.length; rowIndex++) {
                var rowData = csvState.gridDataModel[rowIndex];
                for (var colIndex = 0; colIndex < (csvState.gridTemplateVariables || []).length; colIndex++) {
                    var variable = csvState.gridTemplateVariables[colIndex];
                    if (!variable) continue;
                    // Skip optional/nullable
                    if (variable.modifiers && (variable.modifiers.isOptional || variable.modifiers.isNullable)) continue;
                    // Booleans are never blank
                    if (variable.dataType === 'boolean' || variable.dataType === 'bool') continue;
                    var value = rowData[colIndex] || '';
                    if (!value || value.trim() === '') {
                        blankCells.push({ row: rowIndex, col: colIndex, cell: null });
                    }
                }
            }
            var count = blankCells.length;
            return {
                valid: count === 0,
                blankCells: blankCells,
                message: count === 0 ? '' : describeBlankCells(blankCells)
            };
        }

        const tbody = document.getElementById('vanillaGridBody');
        if (!tbody || !csvState.gridTemplateVariables) {
            return { valid: true, blankCells: [], message: '' };
        }

        const blankCells2 = [];
        Array.from(tbody.children).forEach((row, rowIndex) => {
            if (row.classList.contains('vs-spacer')) return;
            row.querySelectorAll('.grid-cell').forEach((cell, colIndex) => {
                const dataType = cell.dataset.type;

                const variable2 = csvState.gridTemplateVariables[colIndex];
                if (variable2 && variable2.modifiers) {
                    if (variable2.modifiers.isOptional || variable2.modifiers.isNullable) {
                        return;
                    }
                }

                let value2 = '';

                if (dataType === 'boolean' || dataType === 'bool') {
                    return;
                } else if (dataType === 'number' || dataType === 'integer' || dataType === 'int') {
                    const input = cell.querySelector('.grid-number-input');
                    value2 = input?.value || '';
                } else if (dataType === 'date') {
                    const input = cell.querySelector('.grid-date-input');
                    value2 = input?.value || '';
                } else if (dataType === 'datetime' || dataType === 'timestamp') {
                    const input = cell.querySelector('.grid-datetime-input');
                    value2 = input?.value || '';
                } else if (dataType === 'time') {
                    const input = cell.querySelector('.grid-time-input');
                    value2 = input?.value || '';
                } else {
                    value2 = cell.textContent || '';
                }

                if (!value2 || value2.trim() === '') {
                    blankCells2.push({ row: rowIndex, col: colIndex, cell });
                }
            });
        });

        const count2 = blankCells2.length;
        return {
            valid: count2 === 0,
            blankCells: blankCells2,
            message: count2 === 0 ? '' : describeBlankCells(blankCells2)
        };
    }

    /**
     * "6 empty fields in 3 rows: product.supplier.gln (3), reorderQty (3)" — which required
     * columns are empty, so the user knows what to fix (optional ones are never counted).
     */
    function describeBlankCells(blankCells) {
        const vars = csvState.gridTemplateVariables || [];
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

    /**
     * Highlight blank cells with warning style
     */
    function highlightBlankCells(blankCells) {
        // GitHub Issue #223: Store blank cells in a Map for virtual scroll rendering
        if (csvState.virtualScrollActive) {
            csvState.gridBlankCells = new Map();
            blankCells.forEach(function (item) {
                var rowIndex = item.row;
                if (!csvState.gridBlankCells.has(rowIndex)) {
                    csvState.gridBlankCells.set(rowIndex, []);
                }
                csvState.gridBlankCells.get(rowIndex).push({ col: item.col });
            });
            // Re-render visible rows so blank styling appears
            if (typeof refreshVirtualRows === 'function') refreshVirtualRows();
            return;
        }
        blankCells.forEach(({ cell }) => {
            if (cell) cell.classList.add('grid-cell-blank-warning');
        });
    }

    /**
     * Clear all blank cell warning highlights
     */
    function clearBlankCellHighlights() {
        csvState.gridBlankCells = null;
        document.querySelectorAll('.grid-cell-blank-warning').forEach(cell => {
            cell.classList.remove('grid-cell-blank-warning');
        });
        // Re-render visible rows to clear blank styling in virtual scroll
        if (csvState.virtualScrollActive && typeof refreshVirtualRows === 'function') {
            refreshVirtualRows();
        }
    }

    // Grid drag/drop handlers
    function handleGridDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';

        // Show drop overlay
        const overlay = document.getElementById('gridDropOverlay');
        if (overlay) {
            overlay.classList.remove('hidden');
        }

        const container = document.getElementById('gridEntryContainer');
        if (container) {
            container.classList.add('drag-over');
        }
    }

    function handleGridDragLeave(event) {
        event.preventDefault();

        // Hide drop overlay
        const overlay = document.getElementById('gridDropOverlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }

        const container = document.getElementById('gridEntryContainer');
        if (container) {
            container.classList.remove('drag-over');
        }
    }

    function handleGridDrop(event) {
        event.preventDefault();
        event.stopPropagation();

        // Hide drop overlay
        const overlay = document.getElementById('gridDropOverlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }

        const container = document.getElementById('gridEntryContainer');
        if (container) {
            container.classList.remove('drag-over');
        }

        const files = event.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            const supportedExtensions = ['.csv', '.xlsx', '.xls', '.tsv', '.txt'];
            const fileName = file.name.toLowerCase();
            const isSupported = supportedExtensions.some(ext => fileName.endsWith(ext));

            if (isSupported) {
                // GitHub Issue #202: Update file tab data (stay on grid tab, no file tab)
                if (window.CSVHandler && window.CSVHandler.updateFileTabData) {
                    window.CSVHandler.updateFileTabData(true, file.name);
                }

                // Process the file (reuse existing logic)
                csvState.currentFile = file;
                csvState.sourceType = 'file';
                csvState.sourceFileName = file.name;
                csvState.sourceSheetName = null;
                csvState.typeDetectionCompleted = false;
                csvState.selectedColumnTypes = {};
                csvState.fileDetailsShown = false;

                // GitHub Issue #202: Show progress in the dropzone inside grid panel
                const dropzone = document.getElementById('csvDropzone');
                if (dropzone) {
                    dropzone.classList.remove('hidden');
                    if (window.CSVHandler && window.CSVHandler.showProgressInDropzone) {
                        window.CSVHandler.showProgressInDropzone(dropzone, file);
                    }
                }

                // Cross-module call: processMultiFormatFile is in the orchestrator (or data-ingestion module)
                if (window.CSVHandler && window.CSVHandler.processMultiFormatFile) {
                    window.CSVHandler.processMultiFormatFile(file, dropzone);
                }
            } else {
                const supportedList = supportedExtensions.join(', ');
                // Cross-module call: showCSVError is in the orchestrator
                if (window.CSVHandler && window.CSVHandler.showCSVError) {
                    window.CSVHandler.showCSVError(`Please drop a supported file format: ${supportedList}`);
                }
            }
        }
    }

    /**
     * Hide grid and show file details container
     */
    function hideGridShowFileDetails() {
        const gridContainer = document.getElementById('gridEntryContainer');
        const fileDetails = document.getElementById('fileDetailsContainer');
        const pasteContainer = document.getElementById('pasteAreaContainer');

        if (gridContainer) gridContainer.classList.add('hidden');
        if (fileDetails) fileDetails.classList.remove('hidden');
        if (pasteContainer) pasteContainer.classList.add('hidden');
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

    // =========================================================================
    // GitHub Issue #223: Virtual Scroll Constants
    // Reuses proven pattern from console tables (console.html)
    // =========================================================================
    const VS_ROW_HEIGHT = 33; // px: 13px font + 12px padding + 2px border + 6px misc
    const VS_BUFFER = 20;     // Extra rows rendered above/below viewport
    const VS_RENDER_THRESHOLD = 5; // Re-render when scroll moves by this many rows

    /**
     * GitHub Issue #202/#223: Populate grid with mapped data from Step 2
     * Uses data model + virtual scrolling for large datasets
     */
    function populateGridFromMappedData(parsedData, templateVariables) {
        if (!parsedData || !templateVariables || templateVariables.length === 0) {
            console.warn('[populateGridFromMappedData] Missing parsedData or templateVariables');
            return;
        }

        const headers = parsedData.headers || csvState.currentHeaders || [];
        const rows = parsedData.rows || [];

        // Ensure grid is initialized
        if (!csvState.gridInitialized && csvState.endpointConfig) {
            initializeDataEntryGrid(csvState.endpointConfig);
        }

        if (!csvState.gridInitialized || !csvState.gridTemplateVariables) {
            console.warn('[populateGridFromMappedData] Grid not initialized');
            return;
        }

        // New data: Ctrl+Z goes back to this, not to what an earlier load held
        csvState.gridUndoStack = [];
        editStart = null;

        // Clear existing grid rows and any old virtual scroll handler
        const tbody = document.getElementById('vanillaGridBody');
        if (!tbody) {
            console.warn('[populateGridFromMappedData] No grid tbody found');
            return;
        }
        teardownVirtualScroll();
        tbody.innerHTML = '';

        // Build mapping: grid column index → CSV column index
        const columnMap = [];
        csvState.gridTemplateVariables.forEach((gridVar, gridColIdx) => {
            const tv = templateVariables.find(v => v.name === gridVar.name);
            const mappedColumnName = tv ? tv.mappedTo : null;
            if (mappedColumnName) {
                const csvColIdx = headers.indexOf(mappedColumnName);
                columnMap.push({ gridColIdx, csvColIdx, mappedColumnName });
            } else {
                columnMap.push({ gridColIdx, csvColIdx: -1, mappedColumnName: null });
            }
        });

        // GitHub Issue #223: Build data model — source of truth for all grid data
        const gridData = [];
        const colCount = csvState.gridTemplateVariables.length;
        for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            const modelRow = new Array(colCount).fill('');
            columnMap.forEach(({ gridColIdx, csvColIdx }) => {
                if (csvColIdx >= 0 && Array.isArray(row)) {
                    const rawValue = String(row[csvColIdx] || '').trim();
                    if (rawValue) {
                        // Apply case transforms at data model level
                        const v = csvState.gridTemplateVariables[gridColIdx];
                        const mods = v && v.modifiers ? v.modifiers : {};
                        if (mods.toUpper) {
                            modelRow[gridColIdx] = rawValue.toUpperCase();
                        } else if (mods.toLower) {
                            modelRow[gridColIdx] = rawValue.toLowerCase();
                        } else {
                            modelRow[gridColIdx] = rawValue;
                        }
                    }
                }
            });
            gridData.push(modelRow);
        }

        csvState.gridDataModel = gridData;
        csvState.gridValidationErrors = new Map();
        csvState.gridLoadErrors = [];

        // Set up virtual scrolling (reuses console table pattern)
        setupVirtualScroll();

        // Show initial row count
        updateGridRowCount(gridData.length, gridData.length);

        // Start background validation
        validateDataModelInBackground();
    }

    /**
     * GitHub Issue #223: Set up virtual scrolling on the grid container
     * Pattern: top spacer → visible rows → bottom spacer (same as console tables)
     */
    function setupVirtualScroll() {
        const container = document.querySelector('.csv-grid-entry');
        if (!container) return;

        // Increase max-height for large datasets
        container.style.maxHeight = '500px';

        csvState.virtualScrollActive = true;
        csvState.virtualScroll = {
            lastRenderedStart: -1,
            lastRenderedEnd: -1,
            scrollRAFPending: false
        };

        // Clean up any previous handler
        if (csvState._vsScrollHandler) {
            container.removeEventListener('scroll', csvState._vsScrollHandler);
        }

        // Attach scroll handler with RAF throttling (Issue #131 pattern from console)
        csvState._vsScrollHandler = function () {
            if (csvState.virtualScroll.scrollRAFPending) return;
            csvState.virtualScroll.scrollRAFPending = true;
            requestAnimationFrame(function () {
                csvState.virtualScroll.scrollRAFPending = false;
                updateVirtualRows();
            });
        };
        container.addEventListener('scroll', csvState._vsScrollHandler, { passive: true });

        // Initial render
        updateVirtualRows();
    }

    /**
     * GitHub Issue #223: Clean up virtual scroll state and handlers
     */
    function teardownVirtualScroll() {
        if (csvState._vsScrollHandler) {
            const container = document.querySelector('.csv-grid-entry');
            if (container) {
                container.removeEventListener('scroll', csvState._vsScrollHandler);
                container.style.maxHeight = '';
            }
            csvState._vsScrollHandler = null;
        }
        csvState.virtualScrollActive = false;
        csvState.virtualScroll = null;
        csvState.gridDataModel = null;
        csvState.gridValidationErrors = null;
        csvState.gridErrorIndices = null;
    }

    /**
     * GitHub Issue #223: Core virtual scroll renderer
     * Calculates visible range, renders top spacer + data rows + bottom spacer
     */
    function updateVirtualRows() {
        if (!csvState.virtualScrollActive || !csvState.gridDataModel) return;

        const container = document.querySelector('.csv-grid-entry');
        const tbody = document.getElementById('vanillaGridBody');
        if (!container || !tbody) return;

        // Use filtered error indices when error filter is active. A delete can run a redraw
        // before the filter's rows are recomputed: ignore indices past the end.
        const modelLength = csvState.gridDataModel.length;
        const filtered = csvState.gridErrorFilterActive && csvState.gridErrorIndices
            ? csvState.gridErrorIndices.filter(i => i < modelLength) : null;
        const useFiltered = !!filtered;
        const totalRows = useFiltered ? filtered.length : modelLength;
        if (totalRows === 0) return;

        const scrollTop = Math.max(0, container.scrollTop);
        const viewportHeight = container.clientHeight;

        // Calculate visible range with buffer
        const rawStart = Math.floor(scrollTop / VS_ROW_HEIGHT) - VS_BUFFER;
        const rawEnd = Math.ceil((scrollTop + viewportHeight) / VS_ROW_HEIGHT) + VS_BUFFER;
        const visibleStart = Math.max(0, rawStart);
        const visibleEnd = Math.min(totalRows, rawEnd);

        const vs = csvState.virtualScroll;

        // Skip re-render if range hasn't changed significantly
        if (vs.lastRenderedStart === visibleStart && vs.lastRenderedEnd === visibleEnd) {
            return;
        }

        vs.lastRenderedStart = visibleStart;
        vs.lastRenderedEnd = visibleEnd;

        // Build new content using DocumentFragment for performance
        const fragment = document.createDocumentFragment();
        const colSpan = (csvState.gridTemplateVariables?.length || 1) + 2;

        // Top spacer (pushes visible rows to correct scroll position)
        if (visibleStart > 0) {
            const topSpacer = document.createElement('tr');
            topSpacer.className = 'vs-spacer';
            const td = document.createElement('td');
            td.colSpan = colSpan;
            td.style.cssText = 'height:' + (visibleStart * VS_ROW_HEIGHT) + 'px;padding:0;border:none;';
            topSpacer.appendChild(td);
            fragment.appendChild(topSpacer);
        }

        // Render visible rows — map viewport position to actual data index when filtered
        for (let i = visibleStart; i < visibleEnd; i++) {
            const dataIndex = useFiltered ? filtered[i] : i;
            fragment.appendChild(renderVirtualRow(dataIndex));
        }

        // Bottom spacer (represents remaining rows below viewport)
        if (visibleEnd < totalRows) {
            const bottomSpacer = document.createElement('tr');
            bottomSpacer.className = 'vs-spacer';
            const td = document.createElement('td');
            td.colSpan = colSpan;
            td.style.cssText = 'height:' + ((totalRows - visibleEnd) * VS_ROW_HEIGHT) + 'px;padding:0;border:none;';
            bottomSpacer.appendChild(td);
            fragment.appendChild(bottomSpacer);
        }

        // Replace tbody content
        tbody.innerHTML = '';
        tbody.appendChild(fragment);
    }

    /**
     * GitHub Issue #223: Render a single virtual row from the data model
     * Creates a <tr> with inputs pre-filled from gridDataModel[rowIndex]
     * All edits sync back to gridDataModel via event handlers
     * Validation errors from gridValidationErrors are shown as cell highlights
     */
    function renderVirtualRow(rowIndex) {
        var rowData = csvState.gridDataModel[rowIndex];
        var row = document.createElement('tr');
        row.dataset.vsRowIndex = rowIndex;
        row.style.height = VS_ROW_HEIGHT + 'px';
        row.style.boxSizing = 'border-box';

        // Row number cell (hover or Tab shows the delete bin)
        row.appendChild(makeRowNumCell(rowIndex + 1, function () { deleteGridRow(rowIndex); }));

        // Get validation errors for this row (if any)
        var rowErrors = csvState.gridValidationErrors ? csvState.gridValidationErrors.get(rowIndex) : null;
        // Get blank cell warnings for this row (if any)
        var rowBlanks = csvState.gridBlankCells ? csvState.gridBlankCells.get(rowIndex) : null;

        // Data cells for each template variable
        csvState.gridTemplateVariables.forEach(function (v, colIndex) {
            var value = rowData[colIndex] || '';
            var td = document.createElement('td');
            td.className = 'grid-cell';
            td.dataset.col = colIndex;
            td.dataset.type = v.dataType;

            var mods = v.modifiers || {};
            if (mods.isOptional || mods.isNullable) td.classList.add('grid-cell-optional');

            // Flag validation errors on this cell
            if (rowErrors && rowErrors.some(function (e) { return e.col === colIndex; })) {
                td.classList.add('grid-cell-error');
            }

            // Flag blank cell warnings
            if (rowBlanks && rowBlanks.some(function (b) { return b.col === colIndex; })) {
                td.classList.add('grid-cell-blank-warning');
            }

            // Closure to sync value back to data model on edit
            var capturedRowIndex = rowIndex;
            var syncValue = function (newValue) {
                if (csvState.gridDataModel[capturedRowIndex]) {
                    csvState.gridDataModel[capturedRowIndex][colIndex] = newValue;
                }
            };

            // Type-specific cell rendering
            if (v.dataType === 'boolean' || v.dataType === 'bool') {
                td.className = 'grid-cell grid-cell-boolean';
                if (mods.isOptional || mods.isNullable) td.classList.add('grid-cell-optional');
                if (rowErrors && rowErrors.some(function (e) { return e.col === colIndex; })) td.classList.add('grid-cell-error');
                if (rowBlanks && rowBlanks.some(function (b) { return b.col === colIndex; })) td.classList.add('grid-cell-blank-warning');
                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'grid-checkbox';
                var lv = value.toLowerCase();
                cb.checked = lv === 'true' || lv === 'yes' || lv === 'y' || value === '1';
                cb.addEventListener('change', function () {
                    syncValue(cb.checked ? 'true' : 'false');
                    cancelProgressiveCopy();
                    updateDataSourceFromGrid();
                });
                cb.addEventListener('keydown', handleGridCellKeydown);
                td.appendChild(cb);
            } else if (v.dataType === 'number' || v.dataType === 'integer' || v.dataType === 'int') {
                td.className = 'grid-cell grid-cell-number';
                if (mods.isOptional || mods.isNullable) td.classList.add('grid-cell-optional');
                if (rowErrors && rowErrors.some(function (e) { return e.col === colIndex; })) td.classList.add('grid-cell-error');
                if (rowBlanks && rowBlanks.some(function (b) { return b.col === colIndex; })) td.classList.add('grid-cell-blank-warning');
                var inp = document.createElement('input');
                inp.type = 'text';
                inp.className = 'grid-number-input';
                inp.inputMode = 'decimal';
                inp.value = value;
                if (mods.minValue !== null) { inp.dataset.minValue = mods.minValue; inp.dataset.minExclusive = mods.minExclusive; }
                if (mods.maxValue !== null) { inp.dataset.maxValue = mods.maxValue; inp.dataset.maxExclusive = mods.maxExclusive; }
                if (mods.isInteger) inp.dataset.isInteger = 'true';
                inp.addEventListener('input', function (e) {
                    e.target.value = e.target.value.replace(/[^0-9.-]/g, '');
                    syncValue(e.target.value);
                    cancelProgressiveCopy();
                    updateDataSourceFromGrid();
                });
                inp.addEventListener('keydown', handleGridCellKeydown);
                inp.addEventListener('paste', handleGridCellPaste);
                td.appendChild(inp);
            } else if (v.dataType === 'date') {
                td.className = 'grid-cell grid-cell-date';
                if (mods.isOptional || mods.isNullable) td.classList.add('grid-cell-optional');
                if (rowErrors && rowErrors.some(function (e) { return e.col === colIndex; })) td.classList.add('grid-cell-error');
                if (rowBlanks && rowBlanks.some(function (b) { return b.col === colIndex; })) td.classList.add('grid-cell-blank-warning');
                var dinp = document.createElement('input');
                dinp.type = 'date';
                dinp.className = 'grid-date-input';
                var df = formatValueForDateInput(value);
                if (df) dinp.value = df;
                else if (df === null && value) { dinp.type = 'text'; dinp.value = value; }
                dinp.addEventListener('change', function () { syncValue(dinp.value); cancelProgressiveCopy(); updateDataSourceFromGrid(); });
                dinp.addEventListener('keydown', handleGridCellKeydown);
                dinp.addEventListener('paste', handleGridCellPaste);
                td.appendChild(dinp);
            } else if (v.dataType === 'datetime' || v.dataType === 'timestamp') {
                td.className = 'grid-cell grid-cell-datetime';
                if (mods.isOptional || mods.isNullable) td.classList.add('grid-cell-optional');
                if (rowErrors && rowErrors.some(function (e) { return e.col === colIndex; })) td.classList.add('grid-cell-error');
                if (rowBlanks && rowBlanks.some(function (b) { return b.col === colIndex; })) td.classList.add('grid-cell-blank-warning');
                var dtinp = document.createElement('input');
                dtinp.type = 'datetime-local';
                dtinp.className = 'grid-datetime-input';
                dtinp.step = '1';
                var dtf = formatValueForDatetimeInput(value);
                if (dtf) dtinp.value = dtf;
                else if (dtf === null && value) { dtinp.type = 'text'; dtinp.value = value; }
                dtinp.addEventListener('change', function () { syncValue(dtinp.value); cancelProgressiveCopy(); updateDataSourceFromGrid(); });
                dtinp.addEventListener('keydown', handleGridCellKeydown);
                dtinp.addEventListener('paste', handleGridCellPaste);
                td.appendChild(dtinp);
            } else if (v.dataType === 'time') {
                td.className = 'grid-cell grid-cell-time';
                if (mods.isOptional || mods.isNullable) td.classList.add('grid-cell-optional');
                if (rowErrors && rowErrors.some(function (e) { return e.col === colIndex; })) td.classList.add('grid-cell-error');
                if (rowBlanks && rowBlanks.some(function (b) { return b.col === colIndex; })) td.classList.add('grid-cell-blank-warning');
                var tinp = document.createElement('input');
                tinp.type = 'time';
                tinp.className = 'grid-time-input';
                tinp.step = '1';
                var tf = formatValueForTimeInput(value);
                if (tf) tinp.value = tf;
                else if (tf === null && value) { tinp.type = 'text'; tinp.value = value; }
                tinp.addEventListener('change', function () { syncValue(tinp.value); cancelProgressiveCopy(); updateDataSourceFromGrid(); });
                tinp.addEventListener('keydown', handleGridCellKeydown);
                tinp.addEventListener('paste', handleGridCellPaste);
                td.appendChild(tinp);
            } else {
                // String: contenteditable
                td.contentEditable = 'true';
                if (mods.minLength !== null) td.dataset.minLength = mods.minLength;
                if (mods.maxLength !== null) td.dataset.maxLength = mods.maxLength;
                if (mods.exactLength !== null) td.dataset.exactLength = mods.exactLength;
                if (mods.toUpper) td.dataset.toUpper = 'true';
                if (mods.toLower) td.dataset.toLower = 'true';
                td.textContent = value;
                td.addEventListener('keydown', handleGridCellKeydown);
                td.addEventListener('paste', handleGridCellPaste);
                td.addEventListener('input', function () {
                    if (mods.toUpper && td.textContent) {
                        var sel = window.getSelection();
                        var range = sel.getRangeAt(0);
                        var offset = range.startOffset;
                        td.textContent = td.textContent.toUpperCase();
                        try { var r = document.createRange(); r.setStart(td.firstChild || td, Math.min(offset, td.textContent.length)); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); } catch (e) { /* ignore */ }
                    } else if (mods.toLower && td.textContent) {
                        var sel = window.getSelection();
                        var range = sel.getRangeAt(0);
                        var offset = range.startOffset;
                        td.textContent = td.textContent.toLowerCase();
                        try { var r = document.createRange(); r.setStart(td.firstChild || td, Math.min(offset, td.textContent.length)); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); } catch (e) { /* ignore */ }
                    }
                    syncValue(td.textContent || '');
                    cancelProgressiveCopy();
                    updateDataSourceFromGrid();
                });
            }

            row.appendChild(td);
        });

        // Delete button
        var actionsCell = document.createElement('td');
        actionsCell.className = 'actions-cell';
        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'grid-delete-row-btn';
        deleteBtn.innerHTML = '\u00D7';
        deleteBtn.title = 'Delete row';
        deleteBtn.onclick = function () {
            var delIdx = parseInt(row.dataset.vsRowIndex, 10);
            csvState.gridDataModel.splice(delIdx, 1);
            // Shift validation error indices
            var newErrors = new Map();
            if (csvState.gridValidationErrors) {
                csvState.gridValidationErrors.forEach(function (errs, idx) {
                    if (idx < delIdx) {
                        newErrors.set(idx, errs);
                    } else if (idx > delIdx) {
                        newErrors.set(idx - 1, errs.map(function (e) { return Object.assign({}, e, { row: idx - 1 }); }));
                    }
                });
            }
            csvState.gridValidationErrors = newErrors;
            updateGridRowCount(csvState.gridDataModel.length, csvState.gridDataModel.length);
            updateVirtualRows();
            updateDataSourceFromGrid();
        };
        actionsCell.appendChild(deleteBtn);
        row.appendChild(actionsCell);

        return row;
    }

    /**
     * GitHub Issue #223: Validate a data model row without DOM
     * Same validation logic as validateGridRow but operates on plain arrays
     */
    function validateDataModelRow(rowData, rowIndex) {
        var rowErrors = [];
        if (!csvState.gridTemplateVariables) return rowErrors;

        csvState.gridTemplateVariables.forEach(function (variable, colIndex) {
            if (!variable || !variable.modifiers) return;

            var mods = variable.modifiers;
            var dataType = variable.dataType;
            var value = rowData[colIndex] || '';

            // Skip optional/nullable fields when empty
            if ((mods.isOptional || mods.isNullable) && (!value || value.trim() === '')) return;
            // Skip empty required fields (handled by blank cell validation)
            if (!value || value.trim() === '') return;

            value = value.trim();

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
     * GitHub Issue #223: Background validation of the entire data model
     * Processes in batches via requestAnimationFrame to avoid blocking UI
     * Updates progress and re-renders visible rows when complete
     */
    function validateDataModelInBackground() {
        if (!csvState.gridDataModel || csvState.gridDataModel.length === 0) {
            finalizeVirtualGridPopulate();
            return;
        }

        var BATCH_SIZE = 5000;
        var totalRows = csvState.gridDataModel.length;
        csvState.gridValidationErrors = new Map();
        csvState.gridLoadErrors = [];
        var offset = 0;

        // Show progress
        showGridLoadProgress(totalRows);

        function processBatch() {
            var end = Math.min(offset + BATCH_SIZE, totalRows);
            for (var i = offset; i < end; i++) {
                var errors = validateDataModelRow(csvState.gridDataModel[i], i);
                if (errors.length > 0) {
                    csvState.gridValidationErrors.set(i, errors);
                    csvState.gridLoadErrors.push.apply(csvState.gridLoadErrors, errors);
                }
            }
            offset = end;
            updateGridLoadProgress(offset, totalRows);

            if (offset < totalRows) {
                requestAnimationFrame(processBatch);
            } else {
                // Validation complete — finalize
                finalizeVirtualGridPopulate();
            }
        }

        requestAnimationFrame(processBatch);
    }

    /**
     * GitHub Issue #223: Finalize grid after virtual scroll setup + background validation
     */
    function finalizeVirtualGridPopulate() {
        hideGridLoadProgress();

        csvState.gridLoadErrors = null;
        // The background pass has just checked every row's rules: reuse them, add the empty
        // required cells, and render once — already filtered when there is anything to fix
        refreshGridIssues({ reuseRuleErrors: true });
        updateDataSourceFromGrid();

    }

    /**
     * GitHub Issue #223: Force re-render of visible virtual rows
     * Call after data model changes (edits, undo, filter toggle)
     */
    function refreshVirtualRows() {
        if (!csvState.virtualScrollActive || !csvState.virtualScroll) return;
        csvState.virtualScroll.lastRenderedStart = -1;
        csvState.virtualScroll.lastRenderedEnd = -1;
        updateVirtualRows();
    }

    /**
     * Update the grid hint with row loading progress
     */
    function updateGridRowCount(loaded, total) {
        const hint = document.querySelector('#csvDataValidationStep .grid-hint');
        if (!hint) return;
        if (loaded < total) {
            hint.textContent = `Loading rows... ${loaded} of ${total}`;
        } else {
            updateGridHint();
        }
    }

    /** The line under the grid: what it is showing, and how many rows need fixing. */
    function updateGridHint() {
        const hint = document.querySelector('#csvDataValidationStep .grid-hint');
        if (!hint) return;
        const total = csvState.virtualScrollActive && csvState.gridDataModel
            ? csvState.gridDataModel.length
            : (document.getElementById('vanillaGridBody')?.children.length || 0);
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
     * and make the grid show the result: cell highlights, the rows to fix (Filter Errors, on
     * unless the user chose Show All), the hint line and the step bar. Runs on load, after a
     * delete or an undo, shortly after an edit, and when Next is pressed (which then stops or
     * goes on from what this returns). Nothing goes to the footer.
     *
     * Returns { valid, rowCount, lines } — lines name each column's problem for the
     * "Can't continue yet" modal.
     */
    function refreshGridIssues(options) {
        clearTimeout(issueRefreshTimer);
        if (!csvState.gridTemplateVariables) return { valid: true, rowCount: 0, lines: [] };

        const blank = validateGridForBlankCells();
        let ruleErrors;
        if (options && options.reuseRuleErrors && csvState.virtualScrollActive && csvState.gridValidationErrors) {
            ruleErrors = [];
            csvState.gridValidationErrors.forEach(list => { ruleErrors.push.apply(ruleErrors, list); });
        } else {
            clearGridErrorCellHighlights();
            ruleErrors = validateGridData().errors;
        }

        // Highlights: amber cells for rules, blank styling for empty required cells
        if (!csvState.virtualScrollActive) {
            document.querySelectorAll('.grid-cell-blank-warning').forEach(cell => cell.classList.remove('grid-cell-blank-warning'));
        }
        highlightBlankCells(blank.blankCells);
        highlightGridErrorCells(ruleErrors);

        const rows = new Set();
        blank.blankCells.forEach(c => rows.add(c.row));
        ruleErrors.forEach(e => rows.add(e.row));
        setIssueRows(rows);
        updateGridHint();

        return { valid: rows.size === 0, rowCount: rows.size, lines: describeIssues(blank.blankCells, ruleErrors) };
    }

    let issueRefreshTimer = null;

    /** After an edit: wait until typing stops, then check every row again. */
    function scheduleGridIssueRefresh() {
        if (csvState.modalStep !== 3) return;
        const next = document.getElementById('csvNextBtn');
        if (next && next.dataset.loadingProgress === 'true') return;   // the load ends with a full check
        clearTimeout(issueRefreshTimer);
        issueRefreshTimer = setTimeout(function check() {
            // Not while a cell is being edited: the refresh redraws the rows, which would
            // take the cell away mid-edit. It runs once focus leaves the grid.
            const body = document.getElementById('vanillaGridBody');
            if (body && body.contains(document.activeElement)) {
                issueRefreshTimer = setTimeout(check, 600);
                return;
            }
            refreshGridIssues();
        }, 600);
    }

    /** The rows to fix become Filter Errors' rows; the filter is on unless the user chose Show All. */
    function setIssueRows(rows) {
        if (rows.size === 0) {
            hideErrorFilter();
            return;
        }
        csvState.gridErrorRows = rows;
        const btn = document.getElementById('gridErrorFilterBtn');
        if (btn) btn.disabled = false;
        setErrorFilter(csvState.gridErrorFilterTouched ? !!csvState.gridErrorFilterActive : true);
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

    /**
     * Finalize grid after all rows have been rendered.
     * Uses accumulated inline errors from csvState.gridLoadErrors instead of re-validating.
     */
    function finalizeGridPopulate(rows) {
        updateDataSourceFromGrid();
        hideGridLoadProgress();

        csvState.gridLoadErrors = null;
        // Every row, empty required cells included: the grid opens on the rows to fix
        refreshGridIssues();
    }

    // =========================================================================
    // Error filter toggle for Step 3
    // =========================================================================

    /**
     * Show the error filter button in the footer and store error row indices
     */
    function showErrorFilter(errors, options) {
        setTimeout(function () { if (window.BatchStepper) window.BatchStepper.refresh(); }, 0);
        const btn = document.getElementById('gridErrorFilterBtn');
        if (!btn) return;

        // GitHub Issue #223: Build error row set from data model validation or DOM errors
        let errorRows;
        if (csvState.virtualScrollActive && csvState.gridValidationErrors && !(options && options.rowsFromErrors)) {
            errorRows = new Set(csvState.gridValidationErrors.keys());
        } else {
            errorRows = new Set(errors.map(e => e.row));
        }
        csvState.gridErrorRows = errorRows;
        csvState.gridErrorFilterTouched = false;

        btn.disabled = false;
        // Validate opens on the rows that need fixing; Show All is one click away.
        setErrorFilter(true);
    }

    /** Filter on or off, and the button to match ("Show All" while on). */
    function setErrorFilter(on) {
        const btn = document.getElementById('gridErrorFilterBtn');
        csvState.gridErrorFilterActive = !!on;
        applyErrorRowVisibility(!!on);
        if (btn) btn.textContent = on ? 'Show All' : `Filter Errors (${csvState.gridErrorRows?.size || 0})`;
    }


    /**
     * Update the error filter with new errors, preserving current filter state
     * Called on re-validation (Next click) — does NOT reset the toggle
     */
    function updateErrorFilter(errors) {
        setTimeout(function () { if (window.BatchStepper) window.BatchStepper.refresh(); }, 0);
        const btn = document.getElementById('gridErrorFilterBtn');
        if (!btn) return;

        const errorRows = new Set(errors.map(e => e.row));
        csvState.gridErrorRows = errorRows;

        const count = errorRows.size;

        // Validate defaults to Filter Errors, unless the user has chosen Show All
        if (!csvState.gridErrorFilterTouched && !csvState.gridErrorFilterActive && count > 0) {
            btn.disabled = false;
            setErrorFilter(true);
            return;
        }

        // Update button text but preserve active/inactive state
        if (csvState.gridErrorFilterActive) {
            btn.textContent = 'Show All';
            // Re-apply filter with updated error rows
            applyErrorRowVisibility(true);
        } else {
            btn.textContent = `Filter Errors (${count})`;
        }

        btn.disabled = false;
    }

    /**
     * Apply row visibility based on error filter state
     */
    function applyErrorRowVisibility(showErrorsOnly) {
        // GitHub Issue #223: With virtual scroll, rebuild filtered indices and re-render
        if (csvState.virtualScrollActive) {
            if (showErrorsOnly && csvState.gridErrorRows) {
                csvState.gridErrorIndices = Array.from(csvState.gridErrorRows).sort((a, b) => a - b);
            } else {
                csvState.gridErrorIndices = null;
            }
            refreshVirtualRows();
            return;
        }

        const tbody = document.getElementById('vanillaGridBody');
        if (!tbody) return;

        Array.from(tbody.children).forEach((row, idx) => {
            if (row.classList.contains('vs-spacer')) return;
            if (showErrorsOnly && !csvState.gridErrorRows?.has(idx)) {
                row.classList.add('grid-row-hidden');
            } else {
                row.classList.remove('grid-row-hidden');
            }
        });
    }

    /**
     * Toggle between showing error rows only and all rows
     */
    function toggleErrorFilter() {
        const btn = document.getElementById('gridErrorFilterBtn');
        if (!btn) return;

        csvState.gridErrorFilterActive = !csvState.gridErrorFilterActive;
        csvState.gridErrorFilterTouched = true;
        const showErrorsOnly = csvState.gridErrorFilterActive;

        applyErrorRowVisibility(showErrorsOnly);

        const count = csvState.gridErrorRows?.size || 0;
        if (showErrorsOnly) {
            btn.textContent = 'Show All';
        } else {
            btn.textContent = `Filter Errors (${count})`;
        }
    }

    /**
     * Hide the error filter button and show all rows
     */
    function hideErrorFilter() {
        setTimeout(function () { if (window.BatchStepper) window.BatchStepper.refresh(); }, 0);
        const btn = document.getElementById('gridErrorFilterBtn');
        if (btn) {
            btn.textContent = 'Filter Errors';
            btn.disabled = true;
        }
        csvState.gridErrorRows = null;
        csvState.gridErrorIndices = null;
        csvState.gridErrorFilterActive = false;

        // GitHub Issue #223: Re-render to show all rows in virtual scroll mode
        if (csvState.virtualScrollActive) {
            refreshVirtualRows();
            return;
        }

        const tbody = document.getElementById('vanillaGridBody');
        if (tbody) {
            Array.from(tbody.children).forEach(row => row.classList.remove('grid-row-hidden'));
        }
    }

    /**
     * Cancel any in-progress chunked grid render
     */
    function cancelChunkedRender() {
        if (csvState.gridRenderAbortController) {
            csvState.gridRenderAbortController.abort();
            csvState.gridRenderAbortController = null;
            // Reset button and clean up errors when actually aborting a render
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
     * Build data model from mapped data with progress callback.
     * Same logic as populateGridFromMappedData but reports per 5000 rows.
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

        var headers = parsedData.headers || csvState.currentHeaders || [];
        var rows = parsedData.rows || [];

        // Ensure grid is initialized
        if (!csvState.gridInitialized && csvState.endpointConfig) {
            initializeDataEntryGrid(csvState.endpointConfig);
        }
        if (!csvState.gridInitialized || !csvState.gridTemplateVariables) {
            if (onComplete) onComplete();
            return;
        }

        // Clear existing grid rows
        var tbody = document.getElementById('vanillaGridBody');
        if (!tbody) {
            if (onComplete) onComplete();
            return;
        }
        teardownVirtualScroll();
        tbody.innerHTML = '';

        // Build column mapping
        var columnMap = [];
        csvState.gridTemplateVariables.forEach(function (gridVar, gridColIdx) {
            var tv = templateVariables.find(function (v) { return v.name === gridVar.name; });
            var mappedColumnName = tv ? tv.mappedTo : null;
            if (mappedColumnName) {
                var csvColIdx = headers.indexOf(mappedColumnName);
                columnMap.push({ gridColIdx: gridColIdx, csvColIdx: csvColIdx, mappedColumnName: mappedColumnName });
            } else {
                columnMap.push({ gridColIdx: gridColIdx, csvColIdx: -1, mappedColumnName: null });
            }
        });

        var colCount = csvState.gridTemplateVariables.length;
        var gridData = [];
        var totalRows = rows.length;
        var BATCH_SIZE = 5000;
        var offset = 0;

        function processBatch() {
            var end = Math.min(offset + BATCH_SIZE, totalRows);
            for (var r = offset; r < end; r++) {
                var row = rows[r];
                var modelRow = new Array(colCount).fill('');
                columnMap.forEach(function (cm) {
                    if (cm.csvColIdx >= 0 && Array.isArray(row)) {
                        var rawValue = String(row[cm.csvColIdx] || '').trim();
                        if (rawValue) {
                            var v = csvState.gridTemplateVariables[cm.gridColIdx];
                            var mods = v && v.modifiers ? v.modifiers : {};
                            if (mods.toUpper) {
                                modelRow[cm.gridColIdx] = rawValue.toUpperCase();
                            } else if (mods.toLower) {
                                modelRow[cm.gridColIdx] = rawValue.toLowerCase();
                            } else {
                                modelRow[cm.gridColIdx] = rawValue;
                            }
                        }
                    }
                });
                gridData.push(modelRow);
            }
            offset = end;
            if (onProgress) onProgress(offset, totalRows);

            if (offset < totalRows) {
                requestAnimationFrame(processBatch);
            } else {
                // Finalize
                csvState.gridDataModel = gridData;
                csvState.gridValidationErrors = new Map();
                csvState.gridLoadErrors = [];
                setupVirtualScroll();
                updateGridRowCount(gridData.length, gridData.length);
                if (onComplete) onComplete();
            }
        }

        requestAnimationFrame(processBatch);
    }

    /**
     * Batched background validation with progress callback.
     * Same as validateDataModelInBackground but calls onProgress and onComplete.
     * @param {Function} onProgress - (processed, total)
     * @param {Function} onComplete - ()
     */
    function validateDataModelInBackgroundBatched(onProgress, onComplete) {
        if (!csvState.gridDataModel || csvState.gridDataModel.length === 0) {
            finalizeVirtualGridPopulate();
            if (onComplete) onComplete();
            return;
        }

        var BATCH_SIZE = 5000;
        var totalRows = csvState.gridDataModel.length;
        csvState.gridValidationErrors = new Map();
        csvState.gridLoadErrors = [];
        var offset = 0;

        function processBatch() {
            var end = Math.min(offset + BATCH_SIZE, totalRows);
            for (var i = offset; i < end; i++) {
                var errors = validateDataModelRow(csvState.gridDataModel[i], i);
                if (errors.length > 0) {
                    csvState.gridValidationErrors.set(i, errors);
                    csvState.gridLoadErrors.push.apply(csvState.gridLoadErrors, errors);
                }
            }
            offset = end;
            if (onProgress) onProgress(offset, totalRows);

            if (offset < totalRows) {
                requestAnimationFrame(processBatch);
            } else {
                finalizeVirtualGridPopulate();
                if (onComplete) onComplete();
            }
        }

        requestAnimationFrame(processBatch);
    }

    /**
     * Batched getGridDataAsCSV — builds CSV in 5000-row chunks.
     * @param {Function} onProgress - (processed, total)
     * @param {Function} onComplete - (csvString | null)
     */
    function getGridDataAsCSVBatched(onProgress, onComplete) {
        if (!csvState.gridInitialized || !csvState.gridTemplateVariables) {
            if (onComplete) onComplete(null);
            return;
        }

        // Only batch for virtual scroll (large datasets)
        if (!csvState.virtualScrollActive || !csvState.gridDataModel) {
            var result = getGridDataAsCSV();
            if (onProgress) onProgress(1, 1);
            if (onComplete) onComplete(result);
            return;
        }

        var headers = csvState.gridTemplateVariables.map(function (v) { return v.name; });
        var data = csvState.gridDataModel;
        var BATCH_SIZE = 5000;
        var totalRows = data.length;
        var csvLines = [headers.join(',')];
        var offset = 0;
        var hasData = false;

        function processBatch() {
            var end = Math.min(offset + BATCH_SIZE, totalRows);
            for (var r = offset; r < end; r++) {
                var row = data[r];
                // Filter empty rows
                var isEmpty = true;
                for (var c = 0; c < row.length; c++) {
                    if (row[c] !== '' && row[c] !== null) { isEmpty = false; break; }
                }
                if (isEmpty) continue;
                hasData = true;

                var escapedRow = row.map(function (cell) {
                    var cellStr = cell || '';
                    if (cellStr.indexOf(',') >= 0 || cellStr.indexOf('"') >= 0 || cellStr.indexOf('\n') >= 0) {
                        return '"' + cellStr.replace(/"/g, '""') + '"';
                    }
                    return cellStr;
                });
                csvLines.push(escapedRow.join(','));
            }
            offset = end;
            if (onProgress) onProgress(offset, totalRows);

            if (offset < totalRows) {
                requestAnimationFrame(processBatch);
            } else {
                if (onComplete) onComplete(hasData ? csvLines.join('\n') : null);
            }
        }

        requestAnimationFrame(processBatch);
    }

    // =========================================================================
    // End of GitHub Issue #129: Grid Data Entry Functions
    // =========================================================================

    // Public API - exposed on window namespace
    window.DTDataEntryGrid = {
        // Init function to receive shared state
        init: function (sharedState, vscodeFn) {
            csvState = sharedState;
            getVscode = vscodeFn;
        },

        // Template variable extraction
        parseModifiersForGrid,
        parseTemplateVariableContent,
        extractTemplateVariablesFromEndpoint,
        analyzeGridNestingLevels,

        // Grid initialization and management
        initializeDataEntryGrid,
        addGridRow,
        populateGridFromMappedData,
        getVanillaGridData,
        getGridDataAsCSV,
        hasGridData,
        removeEmptyGridRows,
        renumberGridRows,
        updateDataSourceFromGrid,

        // Keyboard navigation
        handleGridCellKeydown,
        handleGridCellInput,

        // Progressive copy
        isInProgressiveCopyPosition,
        progressiveCopyNextLevel,
        copyFieldsFromPreviousRow,
        copyFromCellAbove,
        clearGridCell,
        showProgressiveHint,
        hideProgressiveHint,
        cancelProgressiveCopy,

        // Paste handling
        handleGridCellPaste,
        handleGridPasteColumnMismatch,
        handleGridPasteDateTimeIssue,
        checkForUnparseableDateTimeValues,

        // Date/time formatting for inputs
        formatValueForDateInput,
        formatValueForDatetimeInput,
        formatValueForTimeInput,

        // Undo support
        saveGridStateForUndo,
        undoGridPaste,
        handleGridUndo,

        // Validation
        validateGridRow,
        validateGridData,
        getCellValue,
        highlightGridErrorCells,
        clearGridErrorCellHighlights,
        showGridValidationErrors,
        hideGridValidationErrors,
        validateGridForBlankCells,
        highlightBlankCells,
        clearBlankCellHighlights,

        // Error filter
        showErrorFilter,
        refreshGridIssues,
        deleteGridRow,
        undoGridChange,
        updateErrorFilter,
        hideErrorFilter,
        toggleErrorFilter,

        // Chunked render control
        cancelChunkedRender,

        // GitHub Issue #223: Virtual scroll
        setupVirtualScroll,
        teardownVirtualScroll,
        updateVirtualRows,
        renderVirtualRow,
        refreshVirtualRows,
        validateDataModelRow,
        validateDataModelInBackground,

        // GitHub Issue #223: Step transition progress + batched functions
        showStepTransitionProgress,
        populateGridFromMappedDataBatched,
        validateDataModelInBackgroundBatched,
        getGridDataAsCSVBatched,
        showGridLoadProgress,
        updateGridLoadProgress,
        hideGridLoadProgress,

        // Drag/drop
        handleGridDragOver,
        handleGridDragLeave,
        handleGridDrop,

        // UI helpers
        hideGridShowFileDetails,
        clearFileAndShowGrid
    };
})();

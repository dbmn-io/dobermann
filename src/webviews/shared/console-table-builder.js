// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Shared Console Table Builder
 *
 * Unified table generation utility for both frontend (webviews) and backend (services).
 * Eliminates code duplication between console.html and response-data-extractor.ts
 *
 * GitHub Issue #110: Parent field population for denormalized exports
 *
 * Core capabilities:
 * - Parent-child relationship tracking (WeakMap)
 * - Path-based data extraction with denormalization
 * - Column discovery and hierarchy building
 * - Data classification (success/errors)
 * - Type inference and formatting
 * - Value extraction with flat key support
 */

/**
 * Create a console table builder instance
 * @returns {Object} Builder with methods for table generation
 */
function createConsoleTableBuilder() {
    // WeakMap to track parent-child relationships without mutating data
    let parentChildMap = new WeakMap();

    return {
        /**
         * Clear the parent-child map (call at start of extraction)
         */
        clearParentMap() {
            parentChildMap = new WeakMap();
        },

        // =============================================================
        // CORE DATA EXTRACTION (Parent Field Support)
        // =============================================================

        /**
         * Extract data at a specific path from an array of objects
         * Supports nested paths like 'data.items' or 'response.data'
         * Tracks parent-child relationships using WeakMap
         *
         * @param {Array} data - Array of data objects
         * @param {String} path - Dot-notation path (e.g., "data.ItemPackage")
         * @returns {Array} Extracted data with parent relationships tracked
         */
        extractAtPath(data, path) {
            if (path === 'root' || !path) {
                return data;
            }

            // Clear WeakMap at start of extraction
            parentChildMap = new WeakMap();

            let extracted = [];
            for (let index = 0; index < data.length; index++) {
                const row = data[index];
                const result = this.extractSingleAtPath(row, path);
                if (result !== null) {
                    if (Array.isArray(result)) {
                        // For large arrays, use concat to avoid stack overflow
                        if (result.length > 100000) {
                            extracted = extracted.concat(result);
                        } else {
                            extracted.push(...result);
                        }
                    } else {
                        extracted.push(result);
                    }
                }
            }

            // Denormalize with parent fields using WeakMap
            const denormalized = extracted.map(item => this.denormalizeWithParentFields(item));

            return denormalized;
        },

        /**
         * Extract value from a single object using dot notation path
         * Uses WeakMap to track parent-child relationships
         *
         * @private
         * @param {Object} obj - Object to extract from
         * @param {String} path - Dot-notation path
         * @returns {*} Extracted value or null
         */
        extractSingleAtPath(obj, path) {
            const parts = path.split('.');
            let current = obj;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];

                if (current && typeof current === 'object' && part in current) {
                    current = current[part];

                    // Handle intermediate arrays
                    // If we've reached an array and there are more path parts remaining,
                    // we need to extract from each array item
                    if (Array.isArray(current) && i < parts.length - 1) {
                        const remainingPath = parts.slice(i + 1).join('.');
                        const extracted = [];

                        current.forEach((item) => {
                            const result = this.extractSingleAtPath(item, remainingPath);
                            if (result !== null) {
                                // Use WeakMap to track parent relationships
                                if (Array.isArray(result)) {
                                    result.forEach(child => {
                                        if (typeof child === 'object' && child !== null) {
                                            parentChildMap.set(child, item);
                                        }
                                    });
                                    extracted.push(...result);
                                } else {
                                    if (typeof result === 'object' && result !== null) {
                                        parentChildMap.set(result, item);
                                    }
                                    extracted.push(result);
                                }
                            }
                        });

                        return extracted.length > 0 ? extracted : null;
                    }
                } else {
                    return null;
                }
            }

            return current;
        },

        /**
         * Denormalize data with parent field values
         * Uses WeakMap to look up parent without mutating child data
         *
         * @param {Object} childData - Child data object
         * @param {String} levelPrefix - Level prefix (default: "parent_L1")
         * @returns {Object} Denormalized object with parent fields
         */
        denormalizeWithParentFields(childData, levelPrefix = 'parent_L1') {
            // If childData is not an object, return as-is
            if (typeof childData !== 'object' || childData === null) {
                return childData;
            }

            // Create a copy to avoid mutation
            const denormalized = { ...childData };

            // Use WeakMap to look up parent
            const parentData = parentChildMap.get(childData);

            if (parentData && typeof parentData === 'object' && !Array.isArray(parentData)) {
                Object.keys(parentData).forEach(key => {
                    const value = parentData[key];
                    const fieldType = this.inferDataType(value);

                    // Only include simple fields (no nested objects/arrays)
                    if (fieldType !== 'object' && fieldType !== 'array') {
                        const parentFieldKey = `${levelPrefix}.${key}`;
                        denormalized[parentFieldKey] = value;
                    }
                });
            }

            return denormalized;
        },

        // =============================================================
        // COLUMN DISCOVERY AND MANAGEMENT
        // =============================================================

        /**
         * Infer columns from data array
         *
         * @param {Array} data - Array of data objects
         * @returns {Array<ColumnDefinition>} Array of column definitions
         */
        inferColumnsFromData(data) {
            if (!data || data.length === 0) {
                return [];
            }

            const columnMap = new Map();
            const sampleSize = Math.min(data.length, 10); // Sample first 10 items

            for (let i = 0; i < sampleSize; i++) {
                const item = data[i];
                if (typeof item === 'object' && item !== null) {
                    this.analyzeObjectStructure(item, '', columnMap);
                }
            }

            // Convert to array and create hierarchy
            const allColumns = this.buildColumnHierarchy(columnMap);

            return this.excludeEnvelopeNoise(allColumns);
        },

        /**
         * The envelope, minus the fields that never earned a column.
         *
         * The extension wraps every response as `{ executionId, duration, httpStatus,
         * httpStatusText, headers, data, status }` and columns were discovered in that key
         * order, so a failed batch showed twenty-two columns with the `error` SIXTEENTH —
         * off the side of the table, readable only by building a view. Of the envelope, one
         * field earns its place in a table of results:
         *
         *   headers         transport metadata; eleven columns, identical on every row of a
         *                   run, and nothing to do with the record
         *   status          'error' on the Error tab, 'completed' on the Completed tab — the
         *                   tab already said so
         *   httpStatusText  'Bad Request' restates 400
         *   executionId     a UUID nobody reads; the Raw tab keeps its own transaction list,
         *                   so nothing needs this on screen to navigate
         *   duration        per-request timing — real, but noise in a table of records
         *
         * What is left is the status code and the body, which is the whole rule.
         *
         * NOTHING IS HIDDEN. The Raw tab shows the complete response, envelope and headers
         * included, and the View editor builds its tree straight from the response
         * (buildResponseTreeForEditor, not this function), so any of these can be added back
         * to a view when they genuinely matter — `duration` when hunting a slow endpoint, a
         * `retry-after` on a 429, a correlation id for a support ticket.
         *
         * Only the ENVELOPE is filtered, by exact id. An API's own `status` field is
         * `data.status` and is untouched, as is any field of its body.
         *
         * Auto-discovered columns only. A saved View carries its own explicit column list.
         *
         * @param {Array<Object>} columns - Columns from buildColumnHierarchy
         * @returns {Array<Object>} The same columns, without the envelope noise
         */
        excludeEnvelopeNoise(columns) {
            if (!Array.isArray(columns)) return columns;
            const DROP = new Set(['executionId', 'duration', 'httpStatusText', 'status']);
            return columns.filter(column => {
                const id = column && column.id;
                if (typeof id !== 'string') return true;
                if (id === 'headers' || id.startsWith('headers.')) return false;
                return !DROP.has(id);
            });
        },

        /**
         * Recursively analyze object structure to discover nested columns
         *
         * @param {Object} obj - Object to analyze
         * @param {String} prefix - Current path prefix
         * @param {Map} columnMap - Map to store column definitions
         */
        analyzeObjectStructure(obj, prefix, columnMap) {
            Object.keys(obj).forEach(key => {
                const value = obj[key];
                const fullKey = prefix ? `${prefix}.${key}` : key;
                const type = this.inferDataType(value);

                // Check if this is a parent field (starts with parent_L)
                // Parent fields should ALWAYS be treated as flat primitive columns
                const isParentField = fullKey.startsWith('parent_L');

                if (type === 'object' && !Array.isArray(value) && value !== null && !isParentField) {
                    // This is a nested object - create a group and analyze its children
                    // BUT NOT for parent fields!
                    if (!columnMap.has(fullKey)) {
                        columnMap.set(fullKey, {
                            id: fullKey,
                            name: this.formatColumnName(key),
                            type: 'object', // Mark as object for nested groups
                            sortable: false,
                            filterable: false,
                            nested: false
                        });
                    }

                    // Recursively analyze nested object
                    this.analyzeObjectStructure(value, fullKey, columnMap);
                } else {
                    // This is a primitive value, array, null, OR a parent field - create a regular column
                    if (!columnMap.has(fullKey)) {
                        // For parent fields, strip the parent_LX. prefix from the key before formatting the name
                        // This ensures "parent_L1.ItemId" becomes "Item Id" not "Parent L1. Item Id"
                        const displayKey = isParentField ? key.replace(/^parent_L\d+\./, '') : key;

                        columnMap.set(fullKey, {
                            id: fullKey,
                            name: this.formatColumnName(displayKey),
                            type: isParentField ? 'string' : type, // Parent fields are always strings
                            sortable: true,
                            filterable: true,
                            nested: fullKey.includes('.')
                        });
                    }
                }
            });
        },

        /**
         * Build column hierarchy with groups and children
         *
         * @param {Map} columnMap - Map of column definitions
         * @returns {Array<ColumnDefinition>} Hierarchical column array
         */
        buildColumnHierarchy(columnMap) {
            const columns = Array.from(columnMap.values());

            const result = [];
            const groupMap = new Map();

            // First pass: identify groups (object type columns with dots in their path)
            columns.forEach(column => {
                if ((column.type === 'object' || column.type === 'group') && columns.some(c => c.id.startsWith(column.id + '.'))) {
                    const groupColumn = { ...column, children: [] };
                    groupMap.set(column.id, groupColumn);
                }
            });

            // Second pass: assign children to groups and collect top-level columns
            columns.forEach(column => {
                const parent = this.getParentPath(column.id);

                if (parent && groupMap.has(parent)) {
                    // This column belongs to a group
                    groupMap.get(parent).children.push(column.id);
                } else if (!groupMap.has(column.id) && !parent) {
                    // This is a top-level column (not a group and has no parent)
                    result.push(column);
                }
            });

            // Add groups to result only if they have actual children that exist as columns
            groupMap.forEach(group => {
                if (group.children && group.children.length > 0) {
                    // Verify children actually exist in the columns array
                    const validChildren = group.children.filter(childId =>
                        columns.find(col => col.id === childId)
                    );

                    if (validChildren.length > 0) {
                        // Update children array to only include valid ones
                        group.children = validChildren;
                        result.push(group);
                    }
                }
            });

            // Add child columns after their parent groups
            columns.forEach(column => {
                const parent = this.getParentPath(column.id);
                if (parent && groupMap.has(parent)) {
                    result.push(column);
                }
            });

            return result;
        },

        /**
         * Get parent path from a dotted column ID
         * e.g., "data.VariableId" -> "data"
         *
         * Parent fields like "parent_L0.ItemId" should be treated as TOP-LEVEL columns
         * They're flat denormalized fields, not nested object structures
         *
         * @param {String} columnId - Column ID
         * @returns {String|null} Parent path or null
         */
        getParentPath(columnId) {
            // Parent fields are flat columns, not nested groups
            if (columnId.startsWith('parent_L')) {
                return null;
            }

            const lastDot = columnId.lastIndexOf('.');
            return lastDot > 0 ? columnId.substring(0, lastDot) : null;
        },

        // =============================================================
        // TYPE INFERENCE AND FORMATTING
        // =============================================================

        /**
         * Infer data type from single value
         *
         * @param {*} value - Value to analyze
         * @returns {String} Type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array'
         */
        inferDataType(value) {
            if (Array.isArray(value)) return 'array';
            if (typeof value === 'boolean') return 'boolean';
            if (typeof value === 'number') return 'number';
            if (typeof value === 'object' && value !== null) return 'object';

            // Check if string looks like a date
            if (typeof value === 'string') {
                const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
                if (dateRegex.test(value) && !isNaN(Date.parse(value))) {
                    return 'date';
                }
            }

            return 'string';
        },

        /**
         * Format column name for display
         * Returns column names exactly as they appear in the data without transformation
         *
         * @param {String} key - Raw column key
         * @returns {String} Column name (unchanged)
         */
        formatColumnName(key) {
            // Return column names as-is without any transformation
            // Examples: isActive stays isActive, user_name stays user_name, API_KEY stays API_KEY
            return key;
        },

        // =============================================================
        // DATA CLASSIFICATION AND VALUE EXTRACTION
        // =============================================================

        /**
         * Classify responses into completed and error based on database status field
         * The status field is the source of truth (set based on HTTP status AND test results)
         * - HTTP 200 with passing tests = status: 'completed'
         * - HTTP 200 with failing tests = status: 'error'
         * - HTTP 4xx/5xx = status: 'error'
         *
         * Classification must match retry logic in extension.ts:
         * - COMPLETED tab: status === 'completed'
         * - ERROR tab: status === 'error' OR status === 'failed'
         * - Items with 'pending' or other status are NOT shown (they haven't been executed yet)
         *
         * Falls back to httpStatus if status field is not available (legacy data)
         *
         * @param {Array} responses - Array of response objects
         * @returns {Object} Object with success (completed) and errors arrays
         */
        classifyResponses(responses) {
            const success = [];
            const errors = [];

            responses.forEach(response => {
                // Use database status field if available (authoritative source)
                const status = response.status || response.metadata?.status;

                if (status) {
                    // Status field is the source of truth
                    // Must match retry logic: only 'error' or 'failed' count as errors
                    if (status === 'completed') {
                        success.push(response);
                    } else if (status === 'error' || status === 'failed') {
                        // Only actual errors go to ERROR tab (matches retry count logic)
                        errors.push(response);
                    }
                    // 'pending', 'split', or other statuses are NOT included in either tab
                    // They haven't been executed yet or are internal states
                } else {
                    // Fallback to httpStatus for legacy data without status field
                    const httpStatus = response.httpStatus;
                    // Status 0 = network error, >= 400 = HTTP error
                    // Success = 2xx or 3xx (200-399)
                    if (typeof httpStatus === 'number' && httpStatus >= 200 && httpStatus < 400) {
                        success.push(response);
                    } else {
                        errors.push(response);
                    }
                }
            });

            return { success, errors };
        },

        /**
         * Extract nested value from object using dot notation path
         * Supports flat keys (e.g., "parent_L1.ItemId" as single property)
         *
         * @param {Object} obj - Object to extract from
         * @param {String} path - Path (dot notation or flat key)
         * @returns {*} Extracted value or null
         */
        extractNestedValue(obj, path) {
            // If path exists as a flat key (e.g., "parent_L1.ItemId"), use it directly
            if (obj && obj[path] !== undefined) {
                return obj[path];
            }

            // Otherwise, traverse using dot notation for truly nested paths
            const parts = path.split('.');
            let current = obj;

            for (const part of parts) {
                if (current && current[part] !== undefined) {
                    current = current[part];
                } else {
                    return null;
                }
            }

            return current;
        },

        /**
         * Format cell value for export/display
         * Arrays → "[N items]", Objects → JSON, null/undefined → "", primitives → String
         *
         * @param {*} value - Value to format
         * @returns {String} Formatted value
         */
        formatCellValue(value) {
            if (value === null || value === undefined) {
                return '';
            }
            if (Array.isArray(value)) {
                return `[${value.length} items]`;
            }
            if (typeof value === 'object') {
                return JSON.stringify(value);
            }
            return String(value);
        },

        // =============================================================
        // ADDITIONAL PARENT FIELD FUNCTIONS
        // =============================================================

        /**
         * Add parent fields to column map for inheritance
         *
         * @param {Map} columnMap - Column map to add to
         * @param {Array} parentDataChain - Chain of parent data objects
         */
        addParentFields(columnMap, parentDataChain) {
            if (!parentDataChain || parentDataChain.length === 0) {
                return; // No parent data to include
            }

            // Process each level of parent data
            parentDataChain.forEach((parentLevel, levelIndex) => {
                const parentData = parentLevel.sampleData || parentLevel;
                const levelPrefix = `parent_L${levelIndex}`;

                if (typeof parentData === 'object' && parentData !== null) {
                    // Discover fields from parent level data
                    this.analyzeParentStructure(parentData, levelPrefix, columnMap, levelIndex);
                }
            });
        },

        /**
         * Analyze parent structure to discover parent fields
         *
         * @param {Object} obj - Parent object
         * @param {String} prefix - Prefix (e.g., "parent_L0")
         * @param {Map} columnMap - Column map
         * @param {Number} level - Parent level number
         */
        analyzeParentStructure(obj, prefix, columnMap, level) {
            Object.keys(obj).forEach(key => {
                const value = obj[key];
                const fullKey = `${prefix}.${key}`;
                const type = this.inferDataType(value);

                // Only include simple fields from parents (no nested objects/arrays)
                if (type !== 'object' && type !== 'array') {
                    columnMap.set(fullKey, {
                        id: fullKey,
                        name: `${key} (L${level})`, // Visual indicator of parent level
                        type: type,
                        isParent: true,
                        parentLevel: level,
                        originalKey: key,
                        sortable: true,
                        filterable: true,
                        defaultHidden: true // Parent fields hidden by default
                    });
                }
            });
        },

        /**
         * Extract parent field schema for later use
         *
         * @param {Object} parentData - Parent data object
         * @returns {Object} Schema with only simple fields
         */
        extractParentFieldSchema(parentData) {
            if (typeof parentData !== 'object' || parentData === null) {
                return {};
            }

            const schema = {};
            Object.keys(parentData).forEach(key => {
                const value = parentData[key];
                const fieldType = this.inferDataType(value);

                // Only include simple values (no nested objects/arrays)
                if (fieldType !== 'object' && fieldType !== 'array') {
                    schema[key] = value;
                }
            });

            return schema;
        },

        // =============================================================
        // VIEW-DRIVEN RENDERING (GitHub Issue #229)
        // =============================================================

        /**
         * Read a value from a row object using an absolute path, stripping
         * the rowBasis prefix so we descend inside the row.
         *
         * @param {Object} rowObj - Row-scoped object produced by walking to rowBasis
         * @param {String} absId  - Absolute JSON path from the response root
         * @param {String} rowBasis - The view's row basis ("root" or a dot path)
         * @returns {*} The leaf value (scalar, object, or array) or undefined
         */
        extractRelativeValue(rowObj, absId, rowBasis) {
            if (rowObj === null || rowObj === undefined) return undefined;
            const relative = (!rowBasis || rowBasis === 'root')
                ? absId
                : (absId === rowBasis
                    ? ''
                    : (absId.startsWith(rowBasis + '.')
                        ? absId.slice(rowBasis.length + 1)
                        : absId));
            if (!relative) return rowObj;
            const parts = relative.split('.');
            let cur = rowObj;
            for (const p of parts) {
                if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
                cur = cur[p];
            }
            return cur;
        },

        /**
         * Walk each response to view.rowBasis, produce 0..N row objects
         * per response, read column values according to their source.
         *
         * - source: 'current'  → read relative to the row
         * - source: 'ancestor' → read from the response (same value every row)
         * - source: 'nested'   → store the raw nested payload (renderer handles cells)
         *
         * @param {Array} responses - Classified responses for a tab
         * @param {Object} view - { rowBasis, columns, ... }
         * @returns {Array<Object>} Flat row objects keyed by column.id
         */
        extractRowsForView(responses, view) {
            if (!Array.isArray(responses) || !view || !Array.isArray(view.columns)) return [];
            const rows = [];
            const rowBasis = view.rowBasis || 'root';
            const isAtOrAboveBasis = (id) => {
                if (rowBasis === 'root') return false;
                if (id === rowBasis) return true;
                return rowBasis.startsWith(id + '.');
            };
            const isAncestorLeaf = (id) => {
                if (rowBasis === 'root') return false;
                if (id === rowBasis) return false;
                return !id.startsWith(rowBasis + '.');
            };

            // Walk each row + its parentChain. Ancestor leaves resolve through
            // the longest matching prefix in parentChain so a row knows the
            // SPECIFIC ancestor object it came from (matters when the rowBasis
            // path crosses an array — see Phase 1B.13).
            const populateRow = (cols, rowObj, parentChain, flat) => {
                for (const c of cols || []) {
                    if (!c) continue;
                    if (c.source !== 'nested') {
                        if (isAncestorLeaf(c.id)) {
                            flat[c.id] = this.readAncestor(c.id, parentChain);
                        } else {
                            flat[c.id] = this.extractRelativeValue(rowObj, c.id, rowBasis);
                        }
                    } else {
                        // Phase 1B.14: only treat a nested wrapper as an
                        // expand-cell when (a) it sits INSIDE the row and
                        // (b) the resolved value is genuinely an array.
                        // Wrappers mis-tagged as 'array' by older versions
                        // of ensureStructuralWrapper (path crossed an array
                        // in extractSingleAtPath) fall through to recurse
                        // children — leaves resolve via parentChain or
                        // direct relative read as appropriate.
                        if (isAtOrAboveBasis(c.id)) {
                            populateRow(c.children, rowObj, parentChain, flat);
                        } else if (c.groupType === 'array') {
                            // When rowBasis is 'root', the response IS the row,
                            // so any path is "inside the row". For deeper
                            // rowBasis, the path must equal it or sit beneath.
                            const insideRow = rowBasis === 'root'
                                ? true
                                : (c.id === rowBasis || c.id.startsWith(rowBasis + '.'));
                            const raw = insideRow
                                ? this.extractRelativeValue(rowObj, c.id, rowBasis)
                                : undefined;
                            const children = Array.isArray(c.children) ? c.children : [];
                            if (insideRow && Array.isArray(raw) && children.length > 0) {
                                const keepKeys = [];
                                for (const ch of children) {
                                    if (!ch || !ch.id) continue;
                                    const rel = ch.id.startsWith(c.id + '.')
                                        ? ch.id.slice(c.id.length + 1)
                                        : ch.id;
                                    const top = rel.split('.')[0];
                                    if (top && !keepKeys.includes(top)) keepKeys.push(top);
                                }
                                flat[c.id] = raw.map(item => {
                                    if (!item || typeof item !== 'object') return item;
                                    const picked = {};
                                    for (const k of keepKeys) {
                                        if (k in item) picked[k] = item[k];
                                    }
                                    return picked;
                                });
                            } else if (insideRow && Array.isArray(raw)) {
                                flat[c.id] = raw;
                            } else {
                                // Mis-tagged or sibling-branch — recurse
                                // children so deep leaves still populate.
                                populateRow(c.children, rowObj, parentChain, flat);
                            }
                        } else {
                            populateRow(c.children, rowObj, parentChain, flat);
                        }
                    }
                }
            };

            // Issue #296: each row keeps the response it came from, so the
            // Completed/Error tabs can open its transaction. Non-enumerable:
            // it is not a column and never reaches search, sort or export.
            const linkResponse = (flat, response) => {
                Object.defineProperty(flat, '__response', { value: response, enumerable: false });
            };

            // Issue #270a: does the view select any ancestor column (a leaf
            // above the rowBasis)? Only then do empty responses earn a
            // placeholder row — with no ancestor column there is nothing to
            // show, so the response is still skipped as before.
            const viewHasAncestorColumn = (function walk(cols) {
                for (const c of cols || []) {
                    if (!c) continue;
                    if (c.source !== 'nested') {
                        if (isAncestorLeaf(c.id)) return true;
                    } else if (Array.isArray(c.children) && walk(c.children)) {
                        return true;
                    }
                }
                return false;
            })(view.columns);

            for (const response of responses) {
                if (response === null || response === undefined) continue;
                const expanded = this.expandRowBasis(response, rowBasis);
                if (expanded.length === 0) {
                    // Issue #270a: the response has no data at rowBasis. Rather
                    // than dropping it, surface one placeholder row per surviving
                    // ancestor branch so selected ancestor columns still show
                    // (detail columns render blank). buildEmptyRowChains forks
                    // per populated intermediate array, so N empty shipments each
                    // get their own placeholder carrying that shipment's fields.
                    if (!viewHasAncestorColumn) continue;
                    for (const parentChain of this.buildEmptyRowChains(response, rowBasis)) {
                        const flat = { __placeholder: true };
                        populateRow(view.columns, {}, parentChain, flat);
                        linkResponse(flat, response);
                        rows.push(flat);
                    }
                    continue;
                }
                for (const { row, parentChain } of expanded) {
                    const flat = {};
                    populateRow(view.columns, row, parentChain, flat);
                    linkResponse(flat, response);
                    // The record itself, as the system sent it (Compare's record window shows
                    // it). Non-enumerable, as __response: a reference, never a column.
                    Object.defineProperty(flat, '__record', { value: row, enumerable: false });
                    rows.push(flat);
                }
            }
            return rows;
        },

        /**
         * Phase 1B.13: walk a response to rowBasis and yield {row, parentChain}
         * per terminal item. parentChain maps absolute prefix paths → the
         * specific object at that path for THIS row's lineage. Lets ancestor
         * leaf reads honour array context (e.g. for one OlpnDetail row, its
         * parent shipment's ShipmentId resolves to that shipment, not the
         * full array of all shipments).
         *
         * @param {*} response
         * @param {String} rowBasis
         * @returns {Array<{row:*, parentChain:Object}>}
         */
        expandRowBasis(response, rowBasis) {
            if (!rowBasis || rowBasis === 'root') {
                return [{ row: response, parentChain: { '': response } }];
            }
            const parts = rowBasis.split('.');
            const out = [];
            const recurse = (current, idx, parentChain, currentPath) => {
                if (current === null || current === undefined) return;
                if (Array.isArray(current)) {
                    for (const item of current) {
                        if (idx === parts.length) {
                            // Reached rowBasis at an array — items are rows.
                            out.push({ row: item, parentChain });
                        } else if (item && typeof item === 'object') {
                            const newChain = { ...parentChain, [currentPath]: item };
                            recurse(item[parts[idx]], idx + 1, newChain,
                                currentPath ? currentPath + '.' + parts[idx] : parts[idx]);
                        }
                    }
                    return;
                }
                if (typeof current !== 'object') return;
                if (idx === parts.length) {
                    out.push({ row: current, parentChain });
                    return;
                }
                const newChain = { ...parentChain, [currentPath]: current };
                recurse(current[parts[idx]], idx + 1, newChain,
                    currentPath ? currentPath + '.' + parts[idx] : parts[idx]);
            };
            recurse(response, 0, { '': response }, '');
            return out;
        },

        /**
         * Issue #270a: for a response that yields NO rows at rowBasis, walk as
         * deep toward rowBasis as the data allows and return the parentChain(s)
         * at the deepest reachable object(s). Each chain lets readAncestor()
         * resolve ancestor-level columns for a placeholder row while detail
         * columns fall back to blank.
         *
         * Mirrors expandRowBasis's descent, but records a chain wherever the
         * walk dead-ends (missing/scalar segment, or an empty array — whether
         * that empty array IS the rowBasis or an intermediate before it). Forks
         * per item on populated intermediate arrays so each surviving branch
         * (e.g. each shipment whose details are empty) gets its own chain.
         *
         * @param {*} response
         * @param {String} rowBasis
         * @returns {Array<Object>} parentChain objects (may be empty)
         */
        buildEmptyRowChains(response, rowBasis) {
            if (!rowBasis || rowBasis === 'root') return [];
            const parts = rowBasis.split('.');
            const out = [];
            const recurse = (current, idx, parentChain, currentPath) => {
                if (current === null || current === undefined) {
                    out.push(parentChain);
                    return;
                }
                if (Array.isArray(current)) {
                    // Empty array — either the rowBasis itself or an intermediate
                    // — is the dead-end: emit a placeholder from here.
                    if (current.length === 0) {
                        out.push(parentChain);
                        return;
                    }
                    // rowBasis reached at a NON-empty array would have produced
                    // real rows (caller only invokes us when expanded is empty),
                    // so there is nothing more to fork here.
                    if (idx === parts.length) return;
                    for (const item of current) {
                        if (item && typeof item === 'object') {
                            const nextPath = currentPath ? currentPath + '.' + parts[idx] : parts[idx];
                            recurse(item[parts[idx]], idx + 1, { ...parentChain, [currentPath]: item }, nextPath);
                        }
                    }
                    return;
                }
                if (typeof current !== 'object') {
                    // Scalar where a deeper object was expected — dead-end.
                    out.push(parentChain);
                    return;
                }
                // Existing object AT rowBasis would have produced a row already;
                // nothing to place here.
                if (idx === parts.length) return;
                const nextPath = currentPath ? currentPath + '.' + parts[idx] : parts[idx];
                recurse(current[parts[idx]], idx + 1, { ...parentChain, [currentPath]: current }, nextPath);
            };
            recurse(response, 0, { '': response }, '');
            return out;
        },

        /**
         * Issue #250: count how many of the supplied responses produce zero
         * rows at the given rowBasis path. Used to surface a footer warning
         * when some responses are missing data at the row-basis path (so the
         * absence isn't mistaken for an API failure).
         *
         * Returns 0 for root or empty rowBasis (every response yields a row).
         *
         * @param {Array} responses
         * @param {String} rowBasis
         * @returns {Number} count of responses with zero expanded rows
         */
        countResponsesWithNoRows(responses, rowBasis) {
            if (!Array.isArray(responses) || !rowBasis || rowBasis === 'root') return 0;
            let empty = 0;
            for (const response of responses) {
                if (response === null || response === undefined) continue;
                if (this.expandRowBasis(response, rowBasis).length === 0) empty++;
            }
            return empty;
        },

        /**
         * Issue #270b: collect every node id (leaves + groups, recursively) from
         * a column-picker schema tree into `out`. Used to detect when a schema
         * has converged across sampled responses.
         *
         * @param {Array} nodes - schema tree nodes ({ id, kind, children })
         * @param {Set} out
         * @returns {Set}
         */
        collectNodeIds(nodes, out) {
            out = out || new Set();
            for (const n of nodes || []) {
                if (!n || !n.id) continue;
                out.add(n.id);
                if (n.children) this.collectNodeIds(n.children, out);
            }
            return out;
        },

        /**
         * Issue #270b: union `incoming` schema-tree nodes into `base` (mutated in
         * place), keyed by id. A leaf seen later as a group is upgraded to the
         * richer group form; matching groups merge their children recursively.
         * An array form is preferred over object (it can serve as a rowBasis).
         * `seenIds` accumulates every id encountered so callers can detect when
         * the merged schema stops growing.
         *
         * @param {Array} base - accumulator node array (mutated + returned)
         * @param {Array} incoming - nodes from one response's tree
         * @param {Set} [seenIds]
         * @returns {Array} base
         */
        mergeSchemaTrees(base, incoming, seenIds) {
            if (!Array.isArray(base)) base = [];
            const byId = new Map();
            for (const n of base) byId.set(n.id, n);
            for (const inc of incoming || []) {
                if (!inc || !inc.id) continue;
                if (seenIds) seenIds.add(inc.id);
                const existing = byId.get(inc.id);
                if (!existing) {
                    base.push(inc);
                    byId.set(inc.id, inc);
                    if (seenIds && inc.children) this.collectNodeIds(inc.children, seenIds);
                    continue;
                }
                const existingIsGroup = existing.kind === 'array' || existing.kind === 'object';
                const incIsGroup = inc.kind === 'array' || inc.kind === 'object';
                if (!existingIsGroup && incIsGroup) {
                    existing.kind = inc.kind;
                    existing.children = inc.children || [];
                    if (seenIds && existing.children) this.collectNodeIds(existing.children, seenIds);
                } else if (existingIsGroup && incIsGroup) {
                    existing.children = this.mergeSchemaTrees(existing.children || [], inc.children || [], seenIds);
                    if (existing.kind === 'object' && inc.kind === 'array') existing.kind = 'array';
                }
                // else: both leaves, or existing group + incoming leaf → keep existing.
            }
            return base;
        },

        /**
         * Phase 1B.13: resolve an absolute ancestor path against a row's
         * parentChain by finding the longest prefix the chain knows about
         * and walking the remainder on that object.
         */
        readAncestor(absPath, parentChain) {
            if (!parentChain) return undefined;
            let bestKey = '';
            let bestObj = parentChain[''] !== undefined ? parentChain[''] : null;
            for (const key of Object.keys(parentChain)) {
                if (key === '') continue;
                if (absPath === key || absPath.startsWith(key + '.')) {
                    if (key.length > bestKey.length) {
                        bestKey = key;
                        bestObj = parentChain[key];
                    }
                }
            }
            if (bestObj === null || bestObj === undefined) return undefined;
            const remainder = bestKey ? absPath.slice(bestKey.length + 1) : absPath;
            if (remainder === '') return bestObj;
            // Walk remainder using extractSingleAtPath so any further arrays
            // along the way still expand consistently.
            return this.extractSingleAtPath(bestObj, remainder);
        },

        /**
         * Flatten nested array columns into cartesian-product rows for exports.
         * Every nested+array column becomes one row per child item, with the
         * basis/ancestor columns repeated. Matches the legacy CSV/Excel flatten.
         *
         * Issue #229 Phase 1B.2: screen rendering no longer calls this — the
         * rowBasis choice owns denormalisation. Secondary nested arrays stay
         * as raw payloads for renderExpandableArray to render as cells.
         *
         * @param {Array<Object>} rows - Output of extractRowsForView
         * @param {Object} view - Source view spec
         * @returns {Array<Object>} Flattened rows suitable for tabular export
         */
        flattenNestedForExport(rows, view) {
            if (!Array.isArray(rows) || !view || !Array.isArray(view.columns)) return rows || [];
            const rowBasis = view.rowBasis || 'root';
            // Phase 1B.13b: skip nested-array columns that sit AT or ABOVE
            // rowBasis. extractRowsForView has already iterated those when
            // producing rows; flattening them again would treat row[col.id]
            // (undefined) as an empty array and blank out every direct child
            // — clobbering ancestor values that survived from the upstream
            // extraction.
            const isAtOrAboveBasis = (id) => {
                if (rowBasis === 'root') return false;
                if (id === rowBasis) return true;
                return rowBasis.startsWith(id + '.');
            };
            const nestedArrayCols = view.columns.filter(
                c => c && c.source === 'nested' && c.groupType === 'array' && !isAtOrAboveBasis(c.id)
            );
            if (nestedArrayCols.length === 0) return rows;

            let result = rows;
            for (const col of nestedArrayCols) {
                const childCols = Array.isArray(col.children) ? col.children : [];
                const next = [];
                for (const row of result) {
                    const arr = row[col.id];
                    const items = Array.isArray(arr)
                        ? arr
                        : (arr === null || arr === undefined ? [] : [arr]);
                    if (items.length === 0) {
                        const flatRow = { ...row };
                        for (const ch of childCols) {
                            if (ch && ch.id) flatRow[ch.id] = undefined;
                        }
                        delete flatRow[col.id];
                        next.push(flatRow);
                    } else {
                        for (const item of items) {
                            const flatRow = { ...row };
                            for (const ch of childCols) {
                                if (ch && ch.id) {
                                    flatRow[ch.id] = this.extractRelativeValue(item, ch.id, col.id);
                                }
                            }
                            delete flatRow[col.id];
                            next.push(flatRow);
                        }
                    }
                }
                result = next;
            }
            return result;
        },

        /**
         * Phase 1B.9 — Display-only alias for the envelope wrapper field.
         *
         * The extension writes each response as `{ httpStatus, headers, data:
         * <HTTP body>, status, metadata, ... }`. When an API returns a body
         * like `{ data: [...] }`, paths become `data.data.*` — ambiguous
         * (envelope-data vs body-data). Renaming the envelope field to
         * "body" is architecturally correct but a major migration; this
         * pure helper gives us a display-only alias so UI surfaces show
         * "body.*" while internal paths remain "data.*".
         *
         * Only the leading `data` segment is aliased. Deeper occurrences
         * (user's own API naming) are untouched. Non-envelope paths like
         * `status`, `metadata.x`, `root` pass through unchanged.
         *
         * @param {String} path - Absolute JSON path from the envelope root
         * @returns {String} Display text with leading `data` swapped for `body`
         */
        aliasEnvelopeDataPath(path) {
            if (typeof path !== 'string' || path === '') return path;
            if (path === 'data') return 'body';
            if (path.startsWith('data.')) return 'body.' + path.slice(5);
            return path;
        },

        /**
         * Adapt a view.columns tree into the flat legacy-renderer column
         * shape expected by renderMultiLevelHeaders / renderSimpleHeader.
         *
         * Collapses at/above-basis wrappers (their children promote), emits
         * expand-cell leaves for nested arrays beneath rowBasis, emits group
         * headers for nested objects beneath rowBasis, and collapses
         * sibling-branch wrappers so ancestor leaves flow out flat.
         *
         * Phase 1B.8 — Same-name envelope elision: when an object wrapper's
         * only child is a same-last-segment nested wrapper (e.g. the
         * RawResponse envelope's `data` wrapping a user `data` array/object),
         * the outer wrapper is skipped in the output so the UI shows just the
         * inner shape. Display-only: column ids are untouched.
         *
         * @param {Object} view - { rowBasis, columns, ... }
         * @returns {Array<Object>} Legacy column definitions (leaves or groups)
         */
        viewToLegacyColumnShape(view, sampleResponse) {
            if (!view || !Array.isArray(view.columns)) return [];
            const rowBasis = view.rowBasis || 'root';
            const out = [];
            const lastSegment = (id) => {
                const idx = id.lastIndexOf('.');
                return idx >= 0 ? id.slice(idx + 1) : id;
            };
            const isInsideBasis = (id) => {
                if (rowBasis === 'root') return true;
                return id.startsWith(rowBasis + '.');
            };
            // Phase 1B.15: when a sample is provided, classify whether the
            // wrapper's path actually resolves to an array in the response —
            // independent of the stored groupType. Wrappers whose persisted
            // groupType is 'array' but whose actual node is an object (legacy
            // ensureStructuralWrapper bug for paths that crossed arrays) get
            // treated as objects so their leaves don't get hidden behind an
            // empty expand-cell header.
            const isReallyArray = (col) => {
                if (col.groupType !== 'array') return false;
                if (!sampleResponse) return true; // backwards-compatible default
                const kind = this.classifyStructuralKind(sampleResponse, col.id);
                return kind === 'array';
            };
            const isSameNameEnvelope = (col) => {
                if (!col || col.source !== 'nested' || col.groupType !== 'object') return false;
                const children = Array.isArray(col.children) ? col.children : [];
                if (children.length !== 1) return false;
                const child = children[0];
                if (!child || child.source !== 'nested') return false;
                return lastSegment(child.id) === lastSegment(col.id);
            };
            const walk = (cols, parentId) => {
                for (const col of cols) {
                    if (!col || !col.id) continue;
                    const name = lastSegment(col.id);
                    if (col.source === 'nested') {
                        const children = Array.isArray(col.children) ? col.children : [];
                        const isBasis = col.id === rowBasis;
                        const isAncestorOfBasis = rowBasis !== 'root'
                            && rowBasis !== col.id
                            && rowBasis.startsWith(col.id + '.');
                        const inside = isInsideBasis(col.id);
                        if (isBasis || isAncestorOfBasis) {
                            walk(children, parentId);
                        } else if (inside && isReallyArray(col)) {
                            // Genuine expand-cell array.
                            out.push({
                                id: col.id,
                                name,
                                type: 'array',
                                sortable: false,
                                filterable: false,
                                parent: parentId || null
                            });
                        } else {
                            // Phase 1B.15: every non-array wrapper (object-
                            // style, mis-tagged array, sibling-branch, or
                            // anything not on the rowBasis lineage) collapses
                            // — children render as flat leaves at the parent
                            // level. Matches the CSV's shape and avoids deep
                            // multi-level header bands the user doesn't want.
                            walk(children, parentId);
                        }
                    } else {
                        out.push({
                            id: col.id,
                            name,
                            type: 'string',
                            sortable: true,
                            filterable: true,
                            isAncestor: col.source === 'ancestor',
                            parent: parentId || null
                        });
                    }
                }
            };
            walk(view.columns, null);
            return this.disambiguateColumnNames(out, rowBasis);
        },

        /**
         * Column headers are leaf names (`location.name` → "name") so a view reads like the
         * flat table the user built. When two columns share a leaf, the leaf is no longer a
         * name: those columns get their path relative to the row basis instead
         * (`location.name`, `product.supplier.name`). Applied to the on-screen table and to
         * every copy/export, so a header means the same thing in both. Mutates and returns.
         */
        disambiguateColumnNames(columns, rowBasis) {
            const counts = {};
            for (const col of columns) counts[col.name] = (counts[col.name] || 0) + 1;
            const prefix = rowBasis && rowBasis !== 'root' ? rowBasis + '.' : '';
            for (const col of columns) {
                if (counts[col.name] > 1) {
                    col.name = col.id.startsWith(prefix) ? col.id.slice(prefix.length) : col.id;
                }
            }
            return columns;
        },

        // Phase 1B.14: walk a JSON path drilling into the first object item
        // when crossing arrays; report the FINAL node's structural kind.
        // Mirrors the editor helper of the same name so the shared builder
        // can use it from anywhere (adapter, extraction, etc.).
        classifyStructuralKind(sample, path) {
            if (!sample || typeof sample !== 'object' || !path) return 'unknown';
            let cur = sample;
            for (const seg of path.split('.')) {
                if (Array.isArray(cur)) cur = cur.find(x => x && typeof x === 'object');
                if (cur === null || cur === undefined || typeof cur !== 'object') return 'unknown';
                cur = cur[seg];
            }
            if (Array.isArray(cur)) return 'array';
            if (cur && typeof cur === 'object') return 'object';
            return 'leaf';
        }
    };
}

// Export for use in both browser and Node.js environments
if (typeof module !== 'undefined' && module.exports) {
    // Node.js/CommonJS
    module.exports = { createConsoleTableBuilder };
} else {
    // Browser/Global
    window.ConsoleTableBuilder = { createConsoleTableBuilder };
}

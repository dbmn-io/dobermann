// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Template Completions Module
 * GitHub Issue #128: Template Variable Syntax Highlighting & Validation
 * GitHub Issue #175: String and Number Type Modifiers
 *
 * Provides Monaco editor auto-complete and syntax highlighting for:
 * - A8 system variables ({{A8:sequence}}, {{A8:date}}, {{A8:datetime}})
 * - Type modifiers (string, number, boolean, date, datetime)
 * - Date/datetime format specifiers (iso, YYYY-MM-DD, etc.)
 * - ENV variables ({{ENV:varName}})
 * - User variables with modifiers:
 *   - {{varName:string|modifier}} - String modifiers (upper, lower, 3-50, etc.)
 *   - {{varName:number|modifier}} - Number modifiers (int, >0, rnd(2), etc.)
 *   - {{varName:date:format}} - Date format (iso, YYYY-MM-DD, etc.)
 *   - {{varName:date:format|+2d}} - Date format + date math modifier
 *
 * Syntax:
 * - Colon (:) after type = FORMAT (dates only)
 * - Pipe (|) after type or format = MODIFIER (all types)
 */
(function() {
    'use strict';

    // =============================================================================
    // Template Variable Validation Constants
    // =============================================================================
    // (list and lookup: a value in a lookup table; the table and its columns come after the pipe)
    const VALID_TYPES = ['string', 'number', 'boolean', 'date', 'datetime', 'list', 'lookup'];
    // GitHub Issue #245: 'page' and 'size' drive pagination (also valid in the request body)
    const VALID_A8_VARS = ['sequence', 'date', 'datetime', 'page', 'size'];
    const VALID_SEQUENCE_MODIFIERS = ['local', 'global', 'parent'];
    const VALID_DATE_FORMATS = ['iso', 'yyyy-mm-dd', 'dd-mm-yyyy', 'mm/dd/yyyy', 'yyyymmdd', 'excel', 'dd/mm/yyyy hh:mm:ss', 'date', 'time', 'hh:mm', 'hh:mm:ss'];

    // GitHub Issue #175: String and Number Modifiers
    const VALID_STRING_MODIFIERS = ['upper', 'lower', 'notrim', 'opt', 'null', 'asstring'];
    const VALID_NUMBER_MODIFIERS = ['int', 'floor', 'ceil', 'opt', 'null', 'asstring'];
    // Pattern-based modifiers: n for exact length, n-, -n, n-m for length constraints
    // Pattern-based modifiers: n-, -n, n-m for length; >n, >=n, <n, <=n for comparisons; rnd(n) for rounding
    // d=days, w=weeks, M=months, y=years, h=hours, m=minutes
    // Case-sensitive: M (months) vs m (minutes)
    const DATE_MATH_PATTERN = /^[+-]\d+[dwMyhm]$/; // +2d, -1w, +2M, +1y, +4h, +30m

    // =============================================================================
    // Helper Functions
    // =============================================================================

    /**
     * Get description for A8 variable
     */
    function getA8Description(varName) {
        const descriptions = {
            'sequence': 'Auto-incrementing number for each transaction',
            'date': 'Current date (default: YYYYMMDD)',
            'datetime': 'Current date and time (default: ISO 8601)',
            // GitHub Issue #245: pagination drivers (work in query params or the body)
            'page': 'Pagination page number — {{A8:PAGE:start:totalCountPath}}',
            'size': 'Pagination page size — {{A8:SIZE:value:sizePath}}'
        };
        return descriptions[varName.toLowerCase()] || varName;
    }

    /**
     * GitHub Issue #175: Get detailed description for a modifier
     * @param {string} modifier - The modifier string
     * @param {string} dataType - The data type (string, number, date, datetime)
     * @returns {{ description: string, category: string, example?: string }}
     */
    function getModifierDescription(modifier, dataType) {
        const modLower = modifier.toLowerCase();

        // Empty value modifiers (all types)
        if (modLower === 'opt') {
            return {
                category: 'Empty Handling',
                description: 'Omit key entirely if value is empty',
                example: 'Empty → key removed from JSON'
            };
        }
        if (modLower === 'null') {
            return {
                category: 'Empty Handling',
                description: 'Pass null if value is empty',
                example: 'Empty → null in JSON'
            };
        }
        if (modLower === 'asstring') {
            return {
                category: 'Output',
                description: 'Output as JSON string regardless of type',
                example: '{{Qty:number|asString}} → "1" instead of 1'
            };
        }

        // String modifiers
        if (dataType === 'string') {
            if (modLower === 'upper') {
                return {
                    category: 'Transform',
                    description: 'Convert to UPPERCASE',
                    example: '"hello" → "HELLO"'
                };
            }
            if (modLower === 'lower') {
                return {
                    category: 'Transform',
                    description: 'Convert to lowercase',
                    example: '"HELLO" → "hello"'
                };
            }
            if (modLower === 'notrim') {
                return {
                    category: 'Transform',
                    description: 'Keep leading/trailing whitespace',
                    example: '"  text  " stays as "  text  "'
                };
            }
            // Exact length (just a number)
            const exactMatch = modifier.match(/^(\d+)$/);
            if (exactMatch) {
                return {
                    category: 'Validation',
                    description: `Exactly ${exactMatch[1]} characters`,
                    example: `"ABC" ✓ for |3, "ABCD" ✗ (too long)`
                };
            }
            // Length constraints
            const rangeMatch = modifier.match(/^(\d+)-(\d+)$/);
            if (rangeMatch) {
                return {
                    category: 'Validation',
                    description: `Length must be ${rangeMatch[1]}-${rangeMatch[2]} characters`,
                    example: `"abc" ✓ (3 chars), "a" ✗ (too short)`
                };
            }
            const minMatch = modifier.match(/^(\d+)-$/);
            if (minMatch) {
                return {
                    category: 'Validation',
                    description: `Minimum ${minMatch[1]} characters`,
                    example: `Min length constraint`
                };
            }
            const maxMatch = modifier.match(/^-(\d+)$/);
            if (maxMatch) {
                return {
                    category: 'Validation',
                    description: `Maximum ${maxMatch[1]} characters`,
                    example: `Max length constraint`
                };
            }
        }

        // Number modifiers
        if (dataType === 'number') {
            if (modLower === 'int') {
                return {
                    category: 'Validation',
                    description: 'Must be a whole number (integer)',
                    example: '42 ✓, 3.14 ✗'
                };
            }
            if (modLower === 'floor') {
                return {
                    category: 'Transform',
                    description: 'Round down to nearest integer',
                    example: '3.9 → 3, -1.1 → -2'
                };
            }
            if (modLower === 'ceil') {
                return {
                    category: 'Transform',
                    description: 'Round up to nearest integer',
                    example: '3.1 → 4, -1.9 → -1'
                };
            }
            const rndMatch = modifier.match(/^rnd\((\d+)\)$/i);
            if (rndMatch) {
                return {
                    category: 'Transform',
                    description: `Round to ${rndMatch[1]} decimal places`,
                    example: `19.999 → 20.00 (with rnd(2))`
                };
            }
            // Comparison operators
            if (modifier.startsWith('>=')) {
                const val = modifier.substring(2);
                return {
                    category: 'Validation',
                    description: `Must be ≥ ${val}`,
                    example: `${val} ✓, ${parseFloat(val) - 1} ✗`
                };
            }
            if (modifier.startsWith('>')) {
                const val = modifier.substring(1);
                return {
                    category: 'Validation',
                    description: `Must be > ${val}`,
                    example: `${parseFloat(val) + 1} ✓, ${val} ✗`
                };
            }
            if (modifier.startsWith('<=')) {
                const val = modifier.substring(2);
                return {
                    category: 'Validation',
                    description: `Must be ≤ ${val}`,
                    example: `${val} ✓, ${parseFloat(val) + 1} ✗`
                };
            }
            if (modifier.startsWith('<')) {
                const val = modifier.substring(1);
                return {
                    category: 'Validation',
                    description: `Must be < ${val}`,
                    example: `${parseFloat(val) - 1} ✓, ${val} ✗`
                };
            }
        }

        // Date/datetime modifiers
        // d=days, w=weeks, M=months, y=years, h=hours, m=minutes (case-sensitive for M vs m)
        if (dataType === 'date' || dataType === 'datetime') {
            const dateMathMatch = modifier.match(/^([+-])(\d+)([dwMyhm])$/);
            if (dateMathMatch) {
                const sign = dateMathMatch[1] === '+' ? 'Add' : 'Subtract';
                const amount = dateMathMatch[2];
                const unitMap = { 'd': 'day(s)', 'w': 'week(s)', 'M': 'month(s)', 'y': 'year(s)', 'h': 'hour(s)', 'm': 'minute(s)' };
                const unit = unitMap[dateMathMatch[3]];
                return {
                    category: 'Transform',
                    description: `${sign} ${amount} ${unit}`,
                    example: `${sign} ${amount} ${unit} to the date`
                };
            }
            // Format strings
            if (modLower === 'iso') {
                return {
                    category: 'Format',
                    description: 'ISO 8601 format',
                    example: '2024-01-15T14:30:00.000Z'
                };
            }
            if (modLower === 'date') {
                return {
                    category: 'Format',
                    description: 'Date portion only',
                    example: '2024-01-15'
                };
            }
            if (modLower === 'time') {
                return {
                    category: 'Format',
                    description: 'Time portion only',
                    example: '14:30:00'
                };
            }
            // Custom format
            return {
                category: 'Format',
                description: `Custom format: ${modifier}`,
                example: 'Formatted date string'
            };
        }

        return {
            category: 'Modifier',
            description: modifier,
            example: ''
        };
    }

    /**
     * GitHub Issue #175: Build a rich hover message for a modifier string
     * @param {string} modifierStr - The full modifier string (may contain pipes)
     * @param {string} dataType - The data type
     * @returns {string} Formatted hover message
     */
    function buildModifierHoverMessage(modifierStr, dataType) {
        if (!modifierStr) return '';

        const modifiers = modifierStr.split('|').filter(s => s.trim());
        if (modifiers.length === 0) return '';

        const lines = ['**Modifiers:**', ''];

        for (const mod of modifiers) {
            const info = getModifierDescription(mod.trim(), dataType);
            const icon = info.category === 'Validation' ? '✓' :
                        info.category === 'Transform' ? '⚙️' : '📅';
            lines.push(`${icon} \`${mod}\` - ${info.description}`);
            if (info.example) {
                lines.push(`   _${info.example}_`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Get CSS class for a modifier based on its type
     */
    function getModifierClass(modifier, dataType, hasError) {
        if (hasError) return 'tmpl-error';

        const modLower = modifier.toLowerCase();

        // Empty value modifiers - special color
        if (modLower === 'opt' || modLower === 'null') {
            return 'tmpl-modifier-empty';
        }

        // Validation modifiers - use a distinct color
        if (dataType === 'string') {
            // Exact length or length ranges
            if (/^\d+$/.test(modifier) || /^\d+-\d*$/.test(modifier) || /^-\d+$/.test(modifier)) {
                return 'tmpl-modifier-validation';
            }
        }
        if (dataType === 'number') {
            if (modLower === 'int' || /^[><]=?/.test(modifier)) {
                return 'tmpl-modifier-validation';
            }
        }

        // Transform modifiers
        if (['upper', 'lower', 'notrim', 'floor', 'ceil'].includes(modLower) ||
            /^rnd\(\d+\)$/i.test(modifier)) {
            return 'tmpl-modifier-transform';
        }

        // Date math
        if (DATE_MATH_PATTERN.test(modifier)) {
            return 'tmpl-modifier-transform';
        }

        // Format strings
        return 'tmpl-format';
    }

    /**
     * GitHub Issue #175: Tokenize template variable content for syntax highlighting
     *
     * Parses content like:
     * - "Name" → user variable
     * - "Name:string" → user variable + type
     * - "Name:string|upper" → user variable + type + modifier
     * - ":string|3-50" → inferred name + type + modifier
     * - "A8:datetime:iso|+2d" → A8 prefix + A8 type + format + modifier
     * - "ENV:host" → ENV prefix + ENV name
     *
     * @param {string} content - The content inside {{ }}
     * @param {boolean} isA8 - Whether this is an A8 variable
     * @param {boolean} isENV - Whether this is an ENV variable
     * @returns {Array<{text: string, type: string, dataType?: string, hover?: string}>}
     */
    function tokenizeTemplateContent(content, isA8, isENV) {
        const tokens = [];

        if (!content) return tokens;

        // Find position of first colon and first pipe
        const firstColonIdx = content.indexOf(':');
        const firstPipeIdx = content.indexOf('|');

        if (isA8) {
            // A8 variable: A8:type[:format][|modifier]
            // First part is "A8"
            tokens.push({ text: 'A8', type: 'a8-prefix' });
            tokens.push({ text: ':', type: 'separator' });

            const afterA8 = content.substring(3); // After "A8:"
            tokenizeA8Content(afterA8, tokens);
        } else if (isENV) {
            // ENV variable: ENV:name
            tokens.push({ text: 'ENV', type: 'env-prefix' });
            tokens.push({ text: ':', type: 'separator' });

            const envName = content.substring(4); // After "ENV:"
            if (envName) {
                tokens.push({ text: envName, type: 'env-value' });
            }
        } else if (firstColonIdx === 0) {
            // Inferred variable: :type or :type|modifier
            tokens.push({ text: ':', type: 'separator' });
            const afterColon = content.substring(1);
            tokenizeTypeAndModifiers(afterColon, tokens);
        } else if (firstColonIdx > 0) {
            // Named variable: Name:type or Name:type|modifier
            const varName = content.substring(0, firstColonIdx);
            tokens.push({ text: varName, type: 'user-var' });
            tokens.push({ text: ':', type: 'separator' });
            const afterColon = content.substring(firstColonIdx + 1);
            tokenizeTypeAndModifiers(afterColon, tokens);
        } else {
            // Just a variable name (no type)
            tokens.push({ text: content, type: 'user-var' });
        }

        return tokens;
    }

    /**
     * Tokenize A8 variable content (after "A8:")
     * Format: type[:format][|modifier]
     */
    function tokenizeA8Content(content, tokens) {
        // Check for pipe (modifier)
        const pipeIdx = content.indexOf('|');
        const beforePipe = pipeIdx !== -1 ? content.substring(0, pipeIdx) : content;
        const afterPipe = pipeIdx !== -1 ? content.substring(pipeIdx + 1) : '';

        // Split beforePipe by colon to get type and optional format
        const colonIdx = beforePipe.indexOf(':');
        const a8Type = colonIdx !== -1 ? beforePipe.substring(0, colonIdx) : beforePipe;
        const format = colonIdx !== -1 ? beforePipe.substring(colonIdx + 1) : '';

        // A8 type (sequence, date, datetime)
        tokens.push({ text: a8Type, type: 'a8-value' });

        // Format (if present)
        if (format) {
            tokens.push({ text: ':', type: 'separator' });
            tokens.push({ text: format, type: 'format' });
        }

        // Modifiers (after pipe)
        if (afterPipe) {
            tokens.push({ text: '|', type: 'separator' });
            tokenizeModifiers(afterPipe, tokens, a8Type.toLowerCase());
        }
    }

    /**
     * Tokenize type and modifiers
     * Format: type[|modifier1|modifier2] or type[:format][|modifier] for dates
     */
    function tokenizeTypeAndModifiers(content, tokens) {
        // Check for pipe (modifier separator)
        const pipeIdx = content.indexOf('|');
        const beforePipe = pipeIdx !== -1 ? content.substring(0, pipeIdx) : content;
        const afterPipe = pipeIdx !== -1 ? content.substring(pipeIdx + 1) : '';

        // For date/datetime, colon can introduce format before pipe
        // For string/number, colon after type is backward compat (deprecated)
        const colonIdx = beforePipe.indexOf(':');
        let dataType, format;

        if (colonIdx !== -1) {
            dataType = beforePipe.substring(0, colonIdx);
            format = beforePipe.substring(colonIdx + 1);
        } else {
            dataType = beforePipe;
            format = '';
        }

        // Type
        if (dataType) {
            tokens.push({ text: dataType, type: 'type' });
        }

        // Format (for date/datetime with colon syntax)
        if (format) {
            tokens.push({ text: ':', type: 'separator' });
            tokens.push({ text: format, type: 'format' });
        }

        // Modifiers (after pipe)
        if (afterPipe) {
            tokens.push({ text: '|', type: 'separator' });
            tokenizeModifiers(afterPipe, tokens, dataType.toLowerCase());
        }
    }

    /**
     * Tokenize pipe-delimited modifiers
     */
    function tokenizeModifiers(modifierStr, tokens, dataType) {
        const parts = modifierStr.split('|');

        for (let i = 0; i < parts.length; i++) {
            const mod = parts[i];
            const modType = getModifierTokenType(mod, dataType);

            tokens.push({
                text: mod,
                type: modType,
                dataType: dataType
            });

            // Add pipe separator between modifiers
            if (i < parts.length - 1) {
                tokens.push({ text: '|', type: 'separator' });
            }
        }
    }

    /**
     * Determine the token type for a modifier
     */
    function getModifierTokenType(modifier, dataType) {
        const modLower = modifier.toLowerCase();

        // Empty value modifiers (all types) - special handling
        if (modLower === 'opt' || modLower === 'null') {
            return 'modifier-empty-behavior';
        }
        // Output format directive (all types)
        if (modLower === 'asstring') {
            return 'modifier-transform';
        }

        // String modifiers
        if (dataType === 'string') {
            // Validation: exact length, length constraints
            if (/^\d+$/.test(modifier) || /^\d+-\d*$/.test(modifier) || /^-\d+$/.test(modifier)) {
                return 'modifier-validation';
            }
            // Transform: upper, lower, noTrim
            if (['upper', 'lower', 'notrim'].includes(modLower)) {
                return 'modifier-transform';
            }
        }

        // Number modifiers
        if (dataType === 'number') {
            // Validation: comparisons, int
            if (modLower === 'int' || /^[><]=?-?\d+/.test(modifier)) {
                return 'modifier-validation';
            }
            // Transform: rnd, floor, ceil
            if (/^rnd\(\d+\)$/i.test(modifier) || ['floor', 'ceil'].includes(modLower)) {
                return 'modifier-transform';
            }
        }

        // Date/datetime modifiers
        if (dataType === 'date' || dataType === 'datetime') {
            // Date math is a transform
            if (DATE_MATH_PATTERN.test(modifier)) {
                return 'modifier-transform';
            }
            // Format strings
            return 'format';
        }

        // Default
        return 'format';
    }

    /**
     * Validate a template variable and return error info if invalid
     * @param {string} innerContent - The content inside {{ }}
     * @returns {{ valid: boolean, error?: string, errorPart?: string }}
     */
    function validateTemplateVariable(innerContent) {
        // Empty variables {{}} are valid placeholders - user will fill them in
        if (!innerContent || innerContent.trim() === '') {
            return { valid: true, isEmpty: true };
        }

        const parts = innerContent.split(':');
        const prefix = parts[0].toUpperCase();

        // A8 variables: {{A8:var}} or {{A8:var:format}} or {{A8:var|modifier}} or {{A8:var:format|modifier}}
        if (prefix === 'A8') {
            if (parts.length < 2 || !parts[1]) {
                return { valid: false, error: 'A8 variable requires type (sequence, date, datetime, page, size)', errorPart: 'all' };
            }

            // GitHub Issue #175: Handle pipe in A8 variable (e.g., datetime|+2d)
            const a8Part = parts[1];
            const pipeIdx = a8Part.indexOf('|');
            const a8Var = (pipeIdx !== -1 ? a8Part.substring(0, pipeIdx) : a8Part).toLowerCase();

            if (!VALID_A8_VARS.includes(a8Var)) {
                return { valid: false, error: `Invalid A8 variable: ${a8Var}. Use: sequence, date, datetime, page, size`, errorPart: 'value' };
            }

            // GitHub Issue #245: pagination variables — {{A8:PAGE[:start[:totalCountPath]]}} / {{A8:SIZE:value[:sizePath]}}
            if (a8Var === 'page') {
                // Start value (parts[2]) is optional; when present it must be 0 or 1.
                // isBlocking: pagination syntax errors must prevent saving (GitHub Issue #245).
                if (parts.length > 2 && parts[2] !== '' && parts[2] !== '0' && parts[2] !== '1') {
                    return { valid: false, error: `Invalid page start value: ${parts[2]}. Use 0 or 1`, errorPart: 'value', isBlocking: true };
                }
                return { valid: true };
            }
            if (a8Var === 'size') {
                // SIZE requires a value, and it must be a positive integer.
                if (parts.length < 3 || parts[2] === '') {
                    return { valid: false, error: 'A8:SIZE requires a page size, e.g. {{A8:SIZE:20}}', errorPart: 'value', isBlocking: true };
                }
                if (!/^\d+$/.test(parts[2]) || parseInt(parts[2], 10) <= 0) {
                    return { valid: false, error: `Invalid page size: ${parts[2]}. Use any whole number greater than 0`, errorPart: 'value', isBlocking: true };
                }
                return { valid: true };
            }

            // Check sequence modifiers (colon syntax: A8:sequence:local)
            if (a8Var === 'sequence' && parts.length > 2) {
                const modifier = parts[2].toLowerCase();
                if (modifier && !VALID_SEQUENCE_MODIFIERS.includes(modifier)) {
                    return { valid: false, error: `Invalid sequence modifier: ${parts[2]}. Use: local, global, parent`, errorPart: 'modifier' };
                }
            }

            // Check date/datetime formats and modifiers
            if (a8Var === 'date' || a8Var === 'datetime') {
                // Get modifier part after pipe (if present in parts[1])
                const modifierAfterPipe = pipeIdx !== -1 ? a8Part.substring(pipeIdx + 1) : '';

                // Check format in parts[2] if present (colon syntax: A8:datetime:iso)
                if (parts.length > 2) {
                    // parts[2] could be "format" or "format|modifier"
                    const formatPart = parts[2];
                    const formatPipeIdx = formatPart.indexOf('|');
                    const format = (formatPipeIdx !== -1 ? formatPart.substring(0, formatPipeIdx) : formatPart).toLowerCase();

                    if (format && !VALID_DATE_FORMATS.includes(format) && !format.match(/^[ymdh\/\-\s:]+$/i)) {
                        return { valid: false, error: `Invalid date format: ${format}`, errorPart: 'modifier' };
                    }
                }

                // Validate date math modifiers
                if (modifierAfterPipe) {
                    const modifiers = modifierAfterPipe.split('|');
                    for (const mod of modifiers) {
                        if (mod && !DATE_MATH_PATTERN.test(mod) && !VALID_DATE_FORMATS.includes(mod.toLowerCase())) {
                            return { valid: false, error: `Invalid date modifier: ${mod}. Use: +2d, -1d, +4h, +30m`, errorPart: 'format' };
                        }
                    }
                }
            }
            return { valid: true };
        }

        // ENV variables: {{ENV:varName}}
        if (prefix === 'ENV') {
            if (parts.length < 2 || !parts[1]) {
                return { valid: false, error: 'ENV variable requires variable name', errorPart: 'all' };
            }
            const envVars = window.currentActiveEnvironment?.variables || {};
            const envVarName = parts[1];
            if (!envVars[envVarName]) {
                return { valid: false, error: `ENV variable '${envVarName}' not found in environment`, errorPart: 'value', isWarning: true };
            }
            return { valid: true, envValue: envVars[envVarName] };
        }

        // User variables: {{VAR}} or {{VAR:type}} or {{VAR:type|modifier}} or {{VAR:type:format|modifier}}
        // {{note | ifblank:none}}: a pipe before any colon, a text value and its modifiers
        const namePipe = innerContent.indexOf('|');
        const nameColon = innerContent.indexOf(':');
        if (namePipe > 0 && (nameColon === -1 || namePipe < nameColon)) {
            const mods = validateModifiers(innerContent.slice(namePipe + 1), 'string');
            return mods.valid ? { valid: true } : { valid: false, error: mods.error, errorPart: 'format' };
        }

        // list / lookup (James, 2026-11-23): {{uom:list|uom:wms}}, {{uom:list|uom}}, {{uom:lookup|uom:tms>wms}}
        const listType = /^[^:|]+:\s*(list|lookup)\s*(?:\|(.*))?$/i.exec(innerContent);
        if (listType) return validateListType(listType[1].toLowerCase(), listType[2] || '');

        if (parts.length > 1) {
            // GitHub Issue #175: Check if type part contains pipe (type|modifier)
            const typeWithPotentialModifier = parts[1];
            const pipeIndex = typeWithPotentialModifier.indexOf('|');

            let type, modifierStr;

            if (pipeIndex !== -1) {
                // Type with pipe: {{VAR:type|modifier}}
                type = typeWithPotentialModifier.substring(0, pipeIndex).trim().toLowerCase();   // ({{note:string | …}}: spaces around the pipe)
                modifierStr = typeWithPotentialModifier.substring(pipeIndex + 1);

                // Append remaining parts (if any) to modifier string
                if (parts.length > 2) {
                    // ifblank:text keeps its colon: everything after the type's pipe, as written
                    modifierStr = /(^|\|)\s*ifblank:/i.test(innerContent.slice(innerContent.indexOf('|') + 1))
                        ? innerContent.slice(innerContent.indexOf('|') + 1)
                        : modifierStr + '|' + parts.slice(2).join('|');
                }
            } else {
                type = typeWithPotentialModifier.trim().toLowerCase();

                // For dates: parts[2] could be format, parts[3+] could be modifiers (with pipe)
                // For string/number: parts[2+] is modifiers (backward compat with colon, or pipe)
                if (parts.length > 2) {
                    const afterType = parts.slice(2).join(':');
                    // Check if it contains pipe (new syntax with modifiers)
                    if (afterType.includes('|')) {
                        modifierStr = afterType;
                    } else {
                        // For dates, this is just format. For string/number, backward compat
                        modifierStr = afterType;
                    }
                }
            }

            if (type && !VALID_TYPES.includes(type)) {
                return { valid: false, error: `Invalid type: ${type}. Use: string, number, boolean, date, datetime`, errorPart: 'type' };
            }

            // GitHub Issue #175: Validate modifiers for string/number/date types
            if (modifierStr) {
                const modifierValidation = validateModifiers(modifierStr, type);
                if (!modifierValidation.valid) {
                    return { valid: false, error: modifierValidation.error, errorPart: 'format' };
                }
            }
        }

        return { valid: true };
    }

    /** The lookup tables the editor's host gave ({ name, columns: [names] }), by name any case. */
    function lookupTableNamed(name) {
        const want = String(name || '').trim().toLowerCase();
        return (window.dbmnLookupTables || []).find(t => String(t.name).trim().toLowerCase() === want);
    }
    function lookupColumnNamed(table, name) {
        const want = String(name || '').trim().toLowerCase();
        return (table.columns || []).find(c => String(c).toLowerCase() === want);
    }
    /**
     * A list or lookup type's table spec, then its modifiers. A table or column not there is a
     * warning (the tables may change before a run; Validate checks again then).
     */
    function validateListType(type, rest) {
        const parts = rest.split('|').map(p => p.trim()).filter(Boolean);
        if (!parts.length) {
            return { valid: false, error: type === 'list' ? 'list needs a table: {{name:list|table:column}}' : 'lookup needs a table and two columns: {{name:lookup|table:from>to}}', errorPart: 'type' };
        }
        const spec = parts.shift();
        const tableName = spec.split(':')[0].trim();
        const cols = spec.split(':').slice(1).join(':').split('>').map(c => c.trim());
        if (type === 'lookup' && (cols.length !== 2 || !cols[0] || !cols[1])) {
            return { valid: false, error: 'lookup needs a table and two columns: {{name:lookup|table:from>to}}', errorPart: 'format' };
        }
        if (type === 'list' && cols.length > 1) {
            return { valid: false, error: 'list names one column: {{name:list|table:column}} (lookup sends another: table:from>to)', errorPart: 'format' };
        }
        const table = lookupTableNamed(tableName);
        if (window.dbmnLookupTables && !table) return { valid: false, error: `No lookup table called ${tableName}`, errorPart: 'format', isWarning: true };
        if (table) {
            if (!cols[0] && (table.columns || []).length !== 1) {
                return { valid: false, error: `${table.name} has more than one column: say which, e.g. ${tableName}:${String(table.columns[0] || 'column').toLowerCase()}`, errorPart: 'format', isWarning: true };
            }
            const missing = cols.filter(c => c && !lookupColumnNamed(table, c));
            if (missing.length) return { valid: false, error: `${table.name} has no column called ${missing[0]}`, errorPart: 'format', isWarning: true };
        }
        const mods = validateModifiers(parts.join('|'), 'string');
        return mods.valid ? { valid: true } : { valid: false, error: mods.error, errorPart: 'format' };
    }

    /**
     * GitHub Issue #175: Validate modifiers for string/number/date types
     * @param {string} modifierStr - The modifier string (pipe-delimited)
     * @param {string} dataType - The data type (string, number, date, datetime)
     * @returns {{ valid: boolean, error?: string }}
     */
    function validateModifiers(modifierStr, dataType) {
        if (!modifierStr) return { valid: true };
        // ifblank:text (any type): what a blank becomes; an old lu: what it is now
        const rest = [];
        for (const raw of modifierStr.split('|').map(x => x.trim()).filter(Boolean)) {
            const low = raw.toLowerCase();
            if (low.indexOf('ifblank:') === 0) {
                if (!raw.slice(8).trim()) return { valid: false, error: 'ifblank needs the text a blank becomes: ifblank:none' };
                continue;
            }
            if (low.indexOf('lu:') === 0) return { valid: false, error: 'lu is now a type: {{name:list|table:column}} or {{name:lookup|table:from>to}}' };
            rest.push(raw);
        }
        modifierStr = rest.join('|');
        if (!modifierStr) return { valid: true };

        // Split by pipe to get individual modifiers
        const modifiers = modifierStr.split('|').map(s => s.trim()).filter(s => s.length > 0);

        for (const mod of modifiers) {
            const modLower = mod.toLowerCase();

            // Universal modifiers work with all types
            if (modLower === 'opt' || modLower === 'null' || modLower === 'asstring') continue;

            if (dataType === 'string') {
                // String modifiers: upper, lower, noTrim, n (exact), n-, -n, n-m
                if (VALID_STRING_MODIFIERS.includes(modLower)) continue;
                if (/^\d+$/.test(mod)) continue; // exact length: n
                if (/^\d+-$/.test(mod)) continue; // min length: n-
                if (/^-\d+$/.test(mod)) continue; // max length: -n
                if (/^\d+-\d+$/.test(mod)) continue; // range: n-m

                // Check for invalid range
                const rangeMatch = mod.match(/^(\d+)-(\d+)$/);
                if (rangeMatch) {
                    const min = parseInt(rangeMatch[1], 10);
                    const max = parseInt(rangeMatch[2], 10);
                    if (min > max) {
                        return { valid: false, error: `Invalid length range: min (${min}) cannot be greater than max (${max})` };
                    }
                    continue;
                }

                return { valid: false, error: `Unknown string modifier: ${mod}. Use: upper, lower, noTrim, opt, null, asString, n, n-, -n, n-m` };
            }

            if (dataType === 'number') {
                // Number modifiers: int, floor, ceil, rnd(n), >n, >=n, <n, <=n
                if (VALID_NUMBER_MODIFIERS.includes(modLower)) continue;
                if (/^rnd\(\d+\)$/i.test(mod)) continue; // rnd(2)
                if (/^[><]=?-?\d+\.?\d*$/.test(mod)) continue; // >0, >=0, <100, <=100, >-10, >=0.5

                return { valid: false, error: `Unknown number modifier: ${mod}. Use: int, floor, ceil, rnd(n), opt, null, asString, >n, >=n, <n, <=n` };
            }

            if (dataType === 'date' || dataType === 'datetime') {
                // Date modifiers: date math (+2d, -1d, +4h, +30m) or format strings
                if (DATE_MATH_PATTERN.test(mod)) continue;
                if (VALID_DATE_FORMATS.includes(modLower)) continue;
                // Custom format strings are also allowed
                if (/^[ymdh\/\-\s:]+$/i.test(mod)) continue;

                return { valid: false, error: `Unknown date modifier: ${mod}. Use: +2d, -1d, +4h, +30m, opt, null, iso, YYYY-MM-DD, etc.` };
            }
        }

        return { valid: true };
    }

    /**
     * Find the extent of a JSON value starting at the given position.
     * Handles objects, arrays, strings, numbers, booleans, and null.
     * @param {string} text - The full text to search
     * @param {number} startPos - Position after the colon (value starts here or after whitespace)
     * @returns {{start: number, end: number}|null} - Start and end positions of the value, or null if not found
     */
    function findJsonValueExtent(text, startPos) {
        // Skip whitespace
        let pos = startPos;
        while (pos < text.length && /\s/.test(text[pos])) {
            pos++;
        }

        if (pos >= text.length) return null;

        const valueStart = pos;
        const char = text[pos];

        // Object or Array - use bracket matching
        if (char === '{' || char === '[') {
            const openBracket = char;
            const closeBracket = char === '{' ? '}' : ']';
            let depth = 1;
            let inString = false;
            let escaped = false;
            pos++;

            while (pos < text.length && depth > 0) {
                const c = text[pos];

                if (escaped) {
                    escaped = false;
                } else if (c === '\\' && inString) {
                    escaped = true;
                } else if (c === '"') {
                    inString = !inString;
                } else if (!inString) {
                    if (c === openBracket) {
                        depth++;
                    } else if (c === closeBracket) {
                        depth--;
                    }
                }
                pos++;
            }

            return depth === 0 ? { start: valueStart, end: pos } : null;
        }

        // String value
        if (char === '"') {
            let escaped = false;
            pos++;
            while (pos < text.length) {
                const c = text[pos];
                if (escaped) {
                    escaped = false;
                } else if (c === '\\') {
                    escaped = true;
                } else if (c === '"') {
                    return { start: valueStart, end: pos + 1 };
                }
                pos++;
            }
            return null;
        }

        // Number, boolean, null - read until delimiter
        while (pos < text.length && /[^\s,\}\]]/.test(text[pos])) {
            pos++;
        }
        return { start: valueStart, end: pos };
    }

    // =============================================================================
    // Syntax Highlighting (Monaco Decorations)
    // =============================================================================

    /**
     * Update template variable decorations in the Monaco editor
     * Applies syntax highlighting for template variables, ENV variables, and BASE64 markers
     *
     * GitHub Issue #175: Updated to handle pipe-delimited modifiers
     * Color scheme:
     * - Brackets {{ }} : Dim gray
     * - User variable name : Cyan/blue
     * - A8/ENV prefix : Green
     * - Types (string, number, etc.) : Blue
     * - Date formats (iso, YYYY-MM-DD) : Orange
     * - Validation modifiers (>0, 3-50, int) : Yellow/gold
     * - Transform modifiers (upper, rnd, +2d) : Purple
     * - Separators (: |) : Dim gray
     * - Errors : Red
     */
    // Guard to prevent recursive deltaDecorations calls
    let decorationUpdatePending = false;

    function updateTemplateVariableDecorations() {
        if (!window.monacoEditor) return;

        // Prevent recursive calls by deferring with setTimeout
        // This breaks the synchronous call chain that causes "deltaDecorations recursively" error
        if (decorationUpdatePending) {
            return;
        }
        decorationUpdatePending = true;

        // Defer the actual update to break the recursive chain
        setTimeout(() => {
            decorationUpdatePending = false;
            doUpdateDecorations();
        }, 0);
    }

    function doUpdateDecorations() {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        const text = model.getValue();
        const decorations = [];

        // Find all template variables {{...}}
        const regex = /\{\{([^}]*)\}\}/g;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const fullMatch = match[0];
            const innerContent = match[1];
            const matchStart = match.index;

            // Validate the template variable
            const validation = validateTemplateVariable(innerContent);
            const hasError = !validation.valid;
            const isWarning = validation.isWarning;

            // Check for A8/ENV prefix
            const firstColonIdx = innerContent.indexOf(':');
            const prefix = firstColonIdx !== -1 ? innerContent.substring(0, firstColonIdx).toUpperCase() : '';
            const isA8 = prefix === 'A8';
            const isENV = prefix === 'ENV';

            // Determine bracket class based on type and error state
            let bracketClass = 'tmpl-bracket';
            if (hasError && !isWarning) bracketClass = 'tmpl-error-bracket';

            // Special case: Empty variable {{}} - highlight as placeholder (valid, just unfilled)
            if (!innerContent || innerContent.trim() === '') {
                decorations.push({
                    range: new monaco.Range(
                        model.getPositionAt(matchStart).lineNumber,
                        model.getPositionAt(matchStart).column,
                        model.getPositionAt(matchStart + fullMatch.length).lineNumber,
                        model.getPositionAt(matchStart + fullMatch.length).column
                    ),
                    options: {
                        inlineClassName: 'tmpl-error-empty',
                        hoverMessage: { value: '📝 Empty placeholder - add a variable name' }
                    }
                });
                continue; // Skip normal decoration for empty variables
            }

            // Special case: Template variable not inside quotes (invalid JSON)
            let quoteCheck = matchStart - 1;
            let foundOpenQuote = false;
            while (quoteCheck >= 0) {
                const c = text[quoteCheck];
                if (c === '"') {
                    foundOpenQuote = true;
                    break;
                }
                if (c === '}' && quoteCheck > 0 && text[quoteCheck - 1] === '}') {
                    quoteCheck -= 2;
                    continue;
                }
                if (c === '{' && quoteCheck > 0 && text[quoteCheck - 1] === '{') {
                    quoteCheck -= 2;
                    continue;
                }
                if (c === ':' || c === ',' || c === '{' || c === '[' || c === '\n') {
                    break;
                }
                quoteCheck--;
            }

            if (!foundOpenQuote) {
                decorations.push({
                    range: new monaco.Range(
                        model.getPositionAt(matchStart).lineNumber,
                        model.getPositionAt(matchStart).column,
                        model.getPositionAt(matchStart + fullMatch.length).lineNumber,
                        model.getPositionAt(matchStart + fullMatch.length).column
                    ),
                    options: {
                        inlineClassName: 'tmpl-error-empty',
                        hoverMessage: { value: '❌ Template variable must be inside quotes\n\nChange to: "' + fullMatch + '"' }
                    }
                });
                continue;
            }

            // 1. Opening bracket {{
            decorations.push({
                range: new monaco.Range(
                    model.getPositionAt(matchStart).lineNumber,
                    model.getPositionAt(matchStart).column,
                    model.getPositionAt(matchStart + 2).lineNumber,
                    model.getPositionAt(matchStart + 2).column
                ),
                options: {
                    inlineClassName: bracketClass,
                    hoverMessage: hasError ? { value: `⚠️ ${validation.error}` } : null
                }
            });

            // 2. Inner content - parse and decorate using tokenizer
            const tokens = tokenizeTemplateContent(innerContent, isA8, isENV);
            let currentPos = matchStart + 2;

            for (const token of tokens) {
                const tokenStart = currentPos;
                const tokenEnd = currentPos + token.text.length;

                // Determine class based on token type
                let tokenClass = 'tmpl-var-user';
                let hoverText = token.hover || '';

                switch (token.type) {
                    case 'a8-prefix':
                        tokenClass = 'tmpl-var-a8';
                        hoverText = '🔧 A8 System Variable';
                        break;
                    case 'env-prefix':
                        tokenClass = 'tmpl-var-env';
                        hoverText = '🌐 Environment Variable';
                        break;
                    case 'a8-value':
                        tokenClass = hasError && validation.errorPart === 'value' ? 'tmpl-error' : 'tmpl-var-a8-value';
                        hoverText = VALID_A8_VARS.includes(token.text.toLowerCase())
                            ? `🔧 ${token.text} - ${getA8Description(token.text)}`
                            : `❌ Invalid A8 variable: ${token.text}`;
                        break;
                    case 'env-value':
                        const envValue = window.currentActiveEnvironment?.variables?.[token.text];
                        tokenClass = hasError && validation.errorPart === 'value' ? 'tmpl-warning' : 'tmpl-var-env-value';
                        hoverText = envValue ? `🌐 Value: "${envValue}"` : `⚠️ ENV '${token.text}' not found`;
                        break;
                    case 'user-var':
                        tokenClass = 'tmpl-var-user';
                        hoverText = `📌 User Variable: ${token.text}\n_Provided at runtime_`;
                        break;
                    case 'type':
                        tokenClass = hasError && validation.errorPart === 'type' ? 'tmpl-error' : 'tmpl-type';
                        hoverText = VALID_TYPES.includes(token.text.toLowerCase())
                            ? `📋 Type: ${token.text}`
                            : `❌ Invalid type: ${token.text}`;
                        break;
                    case 'format':
                        tokenClass = 'tmpl-format';
                        hoverText = `📅 Format: ${token.text}`;
                        break;
                    case 'modifier-validation':
                        tokenClass = hasError && validation.errorPart === 'format' ? 'tmpl-error' : 'tmpl-modifier-validation';
                        hoverText = buildModifierHoverMessage(token.text, token.dataType || 'string');
                        break;
                    case 'modifier-transform':
                        tokenClass = hasError && validation.errorPart === 'format' ? 'tmpl-error' : 'tmpl-modifier-transform';
                        hoverText = buildModifierHoverMessage(token.text, token.dataType || 'string');
                        break;
                    case 'separator':
                        tokenClass = token.text === '|' ? 'tmpl-pipe' : 'tmpl-separator';
                        break;
                    case 'error':
                        tokenClass = 'tmpl-error';
                        hoverText = `❌ ${token.hover || 'Invalid'}`;
                        break;
                }

                // Add decoration for this token
                if (token.text.length > 0) {
                    decorations.push({
                        range: new monaco.Range(
                            model.getPositionAt(tokenStart).lineNumber,
                            model.getPositionAt(tokenStart).column,
                            model.getPositionAt(tokenEnd).lineNumber,
                            model.getPositionAt(tokenEnd).column
                        ),
                        options: {
                            inlineClassName: tokenClass,
                            hoverMessage: hoverText ? { value: hoverText } : null
                        }
                    });
                }

                currentPos = tokenEnd;
            }

            // 3. Closing bracket }}
            const closingStart = matchStart + fullMatch.length - 2;
            decorations.push({
                range: new monaco.Range(
                    model.getPositionAt(closingStart).lineNumber,
                    model.getPositionAt(closingStart).column,
                    model.getPositionAt(closingStart + 2).lineNumber,
                    model.getPositionAt(closingStart + 2).column
                ),
                options: {
                    inlineClassName: bracketClass,
                    hoverMessage: hasError ? { value: `⚠️ ${validation.error}` } : null
                }
            });
        }

        // Find BASE64 keys: "keyName:BASE64"
        const base64Regex = /"([^"]+):BASE64"\s*:/g;
        while ((match = base64Regex.exec(text)) !== null) {
            const fullMatch = match[0];
            const keyName = match[1];
            const matchStart = match.index;

            // Position of "BASE64" text within the key (after "keyName:")
            // Format: "keyName:BASE64": value
            //         ^       ^      ^
            //         |       |      +-- colonPos (end of key, before ": value")
            //         |       +-- base64TextStart
            //         +-- matchStart + 1 (after opening quote)
            const base64TextStart = matchStart + 1 + keyName.length + 1; // +1 for quote, +1 for colon
            const base64TextEnd = base64TextStart + 6; // "BASE64" is 6 chars

            // 1. Decoration for just "BASE64" text (inverted colors)
            decorations.push({
                range: new monaco.Range(
                    model.getPositionAt(base64TextStart).lineNumber,
                    model.getPositionAt(base64TextStart).column,
                    model.getPositionAt(base64TextEnd).lineNumber,
                    model.getPositionAt(base64TextEnd).column
                ),
                options: {
                    inlineClassName: 'tmpl-base64-marker',
                    hoverMessage: { value: `🔐 BASE64 Encoding\nThe value of "${keyName}" will be BASE64 encoded` }
                }
            });

            // 2. Find and decorate the value (object/array/string) with italics
            const colonAfterKey = matchStart + fullMatch.length - 1; // Position of the colon after the key
            const valueExtent = findJsonValueExtent(text, colonAfterKey + 1);

            if (valueExtent) {
                decorations.push({
                    range: new monaco.Range(
                        model.getPositionAt(valueExtent.start).lineNumber,
                        model.getPositionAt(valueExtent.start).column,
                        model.getPositionAt(valueExtent.end).lineNumber,
                        model.getPositionAt(valueExtent.end).column
                    ),
                    options: {
                        inlineClassName: 'tmpl-base64-value',
                        hoverMessage: { value: `📦 This content will be BASE64 encoded` }
                    }
                });
            }
        }

        // Apply decorations (replace previous ones)
        window.templateVariableDecorations = window.monacoEditor.deltaDecorations(
            window.templateVariableDecorations || [],
            decorations
        );
    }

    // =============================================================================
    // Auto-Complete Provider
    // =============================================================================

    /**
     * Register the completion provider for template variables
     * Should be called after Monaco editor is initialized
     */
    function registerCompletionProvider() {
        if (typeof monaco === 'undefined') {
            console.warn('[TemplateCompletions] Monaco not available');
            return;
        }

        // Check if already registered using a flag on Monaco itself
        // This persists across webview JS context reloads
        if (monaco._templateCompletionsRegistered) {
            return;
        }

        // Mark as registered
        monaco._templateCompletionsRegistered = true;

        monaco.languages.registerCompletionItemProvider('jsonc', {
                triggerCharacters: ['{', ':', '|', '>'],
                provideCompletionItems: function(model, position, context) {
                    const triggerChar = context.triggerCharacter;

                    // Get text until cursor
                    const textUntilPosition = model.getValueInRange({
                        startLineNumber: position.lineNumber,
                        startColumn: 1,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column
                    });

                    // Check if we're inside {{ }}
                    const lastOpenBraces = textUntilPosition.lastIndexOf('{{');
                    const lastCloseBraces = textUntilPosition.lastIndexOf('}}');
                    if (lastOpenBraces === -1 || lastCloseBraces > lastOpenBraces) {
                        return { suggestions: [] };
                    }

                    const afterBraces = textUntilPosition.substring(lastOpenBraces + 2);
                    const afterBracesLower = afterBraces.toLowerCase();

                    // Get word at cursor position for range calculation
                    const word = model.getWordUntilPosition(position);

                    // Use word-based range if there's a word being typed, otherwise use cursor position
                    // This ensures suggestions work correctly when triggered by : or |
                    const range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: word.word ? word.startColumn : position.column,
                        endColumn: position.column
                    };

                    // ============================================================
                    // PIPE TRIGGER (|) = MODIFIERS ONLY
                    // ============================================================
                    // list / lookup: the table after the first pipe, its columns after the table's colon,
                    // the other column after '>', and the modifiers after a further pipe
                    const listCtx = /^[^:|]+:\s*(list|lookup)\s*\|(.*)$/i.exec(afterBraces);
                    if (listCtx) {
                        const listSuggestions = getListSuggestions(listCtx[1].toLowerCase(), listCtx[2], range);
                        if (listSuggestions) return { suggestions: listSuggestions };
                    }
                    // {{note | …}}: modifiers after a pipe straight after the name
                    if (triggerChar === '|' && /^[^:|]+\|([^:]*\|)?$/.test(afterBraces)) {
                        return { suggestions: getStringModifierSuggestions(range) };
                    }

                    if (triggerChar === '|') {
                        if (afterBracesLower.includes(':string')) {
                            return { suggestions: getStringModifierSuggestions(range) };
                        }
                        if (afterBracesLower.includes(':number')) {
                            return { suggestions: getNumberModifierSuggestions(range) };
                        }
                        if (afterBracesLower.includes(':date')) {
                            return { suggestions: getDateMathSuggestions(range) };
                        }
                        if (afterBracesLower.includes(':boolean')) {
                            return { suggestions: getBooleanModifierSuggestions(range) };
                        }
                        return { suggestions: [] };
                    }

                    // ============================================================
                    // COLON TRIGGER (:) = TYPES or DATE FORMATS (never modifiers)
                    // ============================================================
                    if (triggerChar === ':') {
                        const colonCount = (afterBraces.match(/:/g) || []).length;

                        // After A8: -> A8 variables
                        if (afterBracesLower === 'a8:' || afterBraces.match(/^A8:$/i)) {
                            return { suggestions: getA8VariableSuggestions(range) };
                        }

                        // After ENV: -> environment variables (not data types)
                        if (afterBracesLower === 'env:' || afterBraces.match(/^ENV:$/i)) {
                            return { suggestions: getEnvVariableSuggestions(range) };
                        }

                        // GitHub Issue #153: After A8:sequence: -> sequence modifiers
                        if (afterBracesLower.match(/^a8:sequence:$/)) {
                            return { suggestions: getSequenceModifierSuggestions(range) };
                        }

                        // GitHub Issue #245: After A8:PAGE: -> start value 0 or 1 (only valid options)
                        if (afterBracesLower.match(/^a8:page:$/)) {
                            return { suggestions: getPageStartSuggestions(range) };
                        }

                        // GitHub Issue #245: After A8:SIZE: -> common sizes (any positive integer allowed)
                        if (afterBracesLower.match(/^a8:size:$/)) {
                            return { suggestions: getSizeSuggestions(range) };
                        }

                        // After :date: or :datetime: -> date formats
                        if (afterBracesLower.endsWith(':date:') || afterBracesLower.endsWith(':datetime:')) {
                            return { suggestions: getDateFormatSuggestions(range) };
                        }

                        // After A8:date: or A8:datetime: -> date formats
                        if (afterBracesLower.match(/a8:date:$/) || afterBracesLower.match(/a8:datetime:$/)) {
                            return { suggestions: getDateFormatSuggestions(range) };
                        }

                        // GitHub Issue #175: After :string:, :number:, :boolean:, :int: -> NO suggestions
                        // These types don't have format specifiers after colon - user must type | for modifiers
                        if (afterBracesLower.match(/:string:$/) ||
                            afterBracesLower.match(/:number:$/) ||
                            afterBracesLower.match(/:boolean:$/) ||
                            afterBracesLower.match(/:bool:$/) ||
                            afterBracesLower.match(/:int:$/) ||
                            afterBracesLower.match(/:integer:$/)) {
                            return { suggestions: [], incomplete: false };
                        }

                        // First colon after variable name -> types (string, number, etc.)
                        if (colonCount === 1) {
                            return { suggestions: getTypeSuggestions(range) };
                        }

                        // Multiple colons for non-date types -> no suggestions
                        return { suggestions: [], incomplete: false };
                    }

                    // ============================================================
                    // BRACE TRIGGER ({) = Initial (A8:, ENV:)
                    // ============================================================
                    if (triggerChar === '{') {
                        if (afterBraces === '' || afterBraces === '{') {
                            return { suggestions: getInitialSuggestions(range) };
                        }
                    }

                    // Manual trigger or other
                    if (afterBraces.match(/^A8:sequence:\w*$/i)) {
                        return { suggestions: getSequenceModifierSuggestions(range) };
                    }
                    if (afterBraces.match(/^A8:$/i) || afterBraces.match(/^A8:\w*$/i)) {
                        return { suggestions: getA8VariableSuggestions(range) };
                    }
                    if (afterBraces.match(/^ENV:$/i) || afterBraces.match(/^ENV:\w*$/i)) {
                        return { suggestions: getEnvVariableSuggestions(range) };
                    }

                    return { suggestions: [] };
                }
            });
    }

    /**
     * Get initial suggestions when user just typed {{
     * Shows A8: and ENV: prefixes to guide them to system and environment variables
     */
    function getInitialSuggestions(range) {
        return [
            {
                label: 'A8:',
                kind: monaco.languages.CompletionItemKind.Module,
                insertText: 'A8:',
                detail: 'System variables',
                documentation: 'A8 system variables: sequence, date, datetime',
                range: range
            },
            {
                label: 'ENV:',
                kind: monaco.languages.CompletionItemKind.Reference,
                insertText: 'ENV:',
                detail: 'Environment variables',
                documentation: 'Reference an environment variable by name',
                range: range
            }
        ];
    }

    /**
     * Get A8 system variable suggestions
     */
    function getA8VariableSuggestions(range) {
        return [
            {
                label: 'sequence',
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: 'sequence',
                detail: 'Auto-incrementing sequence number',
                documentation: 'Generates a unique sequence number for each transaction',
                range: range
            },
            // GitHub Issue #153: surface the sequence modifiers up front so they're discoverable from A8:
            ...getSequenceModifierSuggestions(range).map(function(item) {
                return Object.assign({}, item, { label: 'sequence:' + item.label, insertText: 'sequence:' + item.insertText });
            }),
            {
                label: 'date',
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: 'date',
                detail: 'Current date (YYYYMMDD)',
                documentation: 'Inserts current date in YYYYMMDD format',
                range: range
            },
            {
                label: 'datetime',
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: 'datetime',
                detail: 'Current datetime (ISO 8601)',
                documentation: 'Inserts current datetime in ISO 8601 format',
                range: range
            },
            // GitHub Issue #245: pagination drivers — work in query params AND the request body.
            // Plain insertText (no snippet) to match the entries above and avoid any
            // dependency on monaco.languages.CompletionItemInsertTextRules.
            {
                label: 'PAGE',
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: 'PAGE:0',
                detail: 'Pagination page number',
                documentation: 'Drives pagination. Basic form A8:PAGE:startValue (e.g. {{A8:PAGE:0}}) — fetch pages one at a time. Add a total-count path (A8:PAGE:0:header.totalCount) to enable Fetch All; the console "Configure Pagination" step can fill this in for you from the response.',
                range: range
            },
            {
                label: 'SIZE',
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: 'SIZE:20',
                detail: 'Pagination page size',
                documentation: 'Page size for pagination. Format: A8:SIZE:value (e.g. {{A8:SIZE:20}}). Optionally A8:SIZE:value:sizePath to read the size back from the response.',
                range: range
            }
        ];
    }

    /**
     * GitHub Issue #153: sequence modifiers for {{A8:sequence:...}} (nested arrays)
     */
    function getSequenceModifierSuggestions(range) {
        return [
            {
                label: 'local',
                kind: monaco.languages.CompletionItemKind.EnumMember,
                insertText: 'local',
                detail: 'Sequence restarts in each array',
                documentation: 'Unique within the array, resets for each array instance (not persisted)',
                range: range
            },
            {
                label: 'global',
                kind: monaco.languages.CompletionItemKind.EnumMember,
                insertText: 'global',
                detail: 'Sequence persisted per array path',
                documentation: 'Unique per item, continues across runs for the same array path',
                range: range
            },
            {
                label: 'parent',
                kind: monaco.languages.CompletionItemKind.EnumMember,
                insertText: 'parent',
                detail: "Reuse the parent element's sequence",
                documentation: "Inherits the sequence value of the enclosing array element",
                range: range
            }
        ];
    }

    /**
     * Get environment variable suggestions for {{ENV:...}}.
     * Reads the active environment's variables (same source the validator uses).
     */
    function getEnvVariableSuggestions(range) {
        const envVars = (window.currentActiveEnvironment && window.currentActiveEnvironment.variables) || {};
        const names = Object.keys(envVars);
        if (names.length === 0) {
            // Don't fall through to data-type suggestions — tell the user there's nothing to pick.
            return [{
                label: 'No environment variables defined',
                kind: monaco.languages.CompletionItemKind.Text,
                insertText: '',
                detail: 'Add variables in the active environment',
                filterText: '',
                sortText: '',
                range: range
            }];
        }
        return names.map(function(name) {
            return {
                label: name,
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: name,
                detail: 'Environment variable',
                documentation: 'Value: ' + String(envVars[name]),
                range: range
            };
        });
    }

    /**
     * GitHub Issue #245: page start value — only 0 or 1 are valid.
     */
    function getPageStartSuggestions(range) {
        return [
            { label: '0', kind: monaco.languages.CompletionItemKind.Value, insertText: '0', detail: '0-based pagination', sortText: '0', range: range },
            { label: '1', kind: monaco.languages.CompletionItemKind.Value, insertText: '1', detail: '1-based pagination', sortText: '1', range: range }
        ];
    }

    /**
     * GitHub Issue #245: common page sizes — any positive integer is allowed,
     * these are just quick picks.
     */
    function getSizeSuggestions(range) {
        return [
            { label: '20', kind: monaco.languages.CompletionItemKind.Value, insertText: '20', detail: 'Page size', sortText: '0', range: range },
            { label: '100', kind: monaco.languages.CompletionItemKind.Value, insertText: '100', detail: 'Page size', sortText: '1', range: range },
            { label: '1000', kind: monaco.languages.CompletionItemKind.Value, insertText: '1000', detail: 'Page size', sortText: '2', range: range }
        ];
    }

    /**
     * Get type modifier suggestions
     */
    /**
     * After `:list|` / `:lookup|`: the lookup tables; after `table:` its columns; after `>` the other
     * columns; after a further `|` the modifiers.
     */
    function getListSuggestions(type, typed, range) {
        const tables = window.dbmnLookupTables || [];
        const kind = monaco.languages.CompletionItemKind;
        const segs = typed.split('|');
        if (segs.length > 1) return getStringModifierSuggestions(range);
        const spec = segs[0];
        if (spec.indexOf(':') === -1) {
            if (!tables.length) return [{ label: 'No lookup tables yet', kind: kind.Text, insertText: '', detail: 'Make one in the Hub: Reporting › + New lookup table', range: range }];
            return tables.map(t => ({
                label: t.name, kind: kind.Module, insertText: String(t.name).toLowerCase(),
                detail: `Lookup table · ${t.columns.length} column${t.columns.length === 1 ? '' : 's'}`,
                documentation: t.columns.join(', ') + (type === 'list' && t.columns.length === 1 ? '\nOne column: {{name:list|' + String(t.name).toLowerCase() + '}} needs none named' : ''),
                range: range
            }));
        }
        const table = lookupTableNamed(spec.split(':')[0]);
        if (!table) return [];
        const cols = spec.split(':').slice(1).join(':').split('>');
        const used = cols.length > 1 ? cols[0].trim().toLowerCase() : '';
        if (cols.length > 1 && type !== 'lookup') return [];
        return table.columns.filter(c => String(c).toLowerCase() !== used).map(c => ({
            label: String(c), kind: kind.Field, insertText: String(c).toLowerCase(),
            detail: cols.length > 1 ? `${table.name}: the column sent` : type === 'lookup' ? `${table.name}: the column the value is in (then > the one sent)` : `${table.name}: the column the value must be in`,
            range: range
        }));
    }

    function getTypeSuggestions(range) {
        return [
            {
                label: 'list',
                kind: monaco.languages.CompletionItemKind.TypeParameter,
                insertText: 'list|',
                detail: 'One of a lookup table\'s values',
                documentation: '{{uom:list|uom:wms}}: the value must be in table uom\'s WMS column, and is sent as it is. A table of one column needs none named: {{site:list|sites}}',
                sortText: 'z1',
                command: { id: 'editor.action.triggerSuggest', title: 'Tables' },
                range: range
            },
            {
                label: 'lookup',
                kind: monaco.languages.CompletionItemKind.TypeParameter,
                insertText: 'lookup|',
                detail: 'Looked up in a lookup table',
                documentation: '{{uom:lookup|uom:tms>wms}}: the value must be in table uom\'s TMS column; that row\'s WMS is sent',
                sortText: 'z2',
                command: { id: 'editor.action.triggerSuggest', title: 'Tables' },
                range: range
            },
            {
                label: 'string',
                kind: monaco.languages.CompletionItemKind.TypeParameter,
                insertText: 'string',
                detail: 'String type (default)',
                documentation: 'Value will be treated as a string',
                range: range
            },
            {
                label: 'number',
                kind: monaco.languages.CompletionItemKind.TypeParameter,
                insertText: 'number',
                detail: 'Number type',
                documentation: 'Value will be converted to a number (no quotes in JSON)',
                range: range
            },
            {
                label: 'boolean',
                kind: monaco.languages.CompletionItemKind.TypeParameter,
                insertText: 'boolean',
                detail: 'Boolean type',
                documentation: 'Value will be converted to true/false',
                range: range
            },
            {
                label: 'date',
                kind: monaco.languages.CompletionItemKind.TypeParameter,
                insertText: 'date',
                detail: 'Date type',
                documentation: 'Value will be parsed and formatted as a date. Add :format for custom format (e.g., :date:iso)',
                range: range
            },
            {
                label: 'datetime',
                kind: monaco.languages.CompletionItemKind.TypeParameter,
                insertText: 'datetime',
                detail: 'DateTime type',
                documentation: 'Value will be parsed and formatted as datetime. Add :format for custom format (e.g., :datetime:iso)',
                range: range
            }
        ];
    }

    /**
     * Get date/datetime format suggestions
     */
    function getDateFormatSuggestions(range) {
        return [
            {
                label: 'iso',
                kind: monaco.languages.CompletionItemKind.Constant,
                insertText: 'iso',
                detail: 'ISO 8601 format',
                documentation: 'Full ISO 8601 format (e.g., 2024-01-04T14:30:00.000Z)',
                range: range
            },
            {
                label: 'YYYY-MM-DD',
                kind: monaco.languages.CompletionItemKind.Constant,
                insertText: 'YYYY-MM-DD',
                detail: 'Year-Month-Day',
                documentation: 'Format: 2024-01-04',
                range: range
            },
            {
                label: 'DD-MM-YYYY',
                kind: monaco.languages.CompletionItemKind.Constant,
                insertText: 'DD-MM-YYYY',
                detail: 'Day-Month-Year',
                documentation: 'Format: 04-01-2024',
                range: range
            },
            {
                label: 'MM/DD/YYYY',
                kind: monaco.languages.CompletionItemKind.Constant,
                insertText: 'MM/DD/YYYY',
                detail: 'US format',
                documentation: 'Format: 01/04/2024',
                range: range
            },
            {
                label: 'YYYYMMDD',
                kind: monaco.languages.CompletionItemKind.Constant,
                insertText: 'YYYYMMDD',
                detail: 'Compact date',
                documentation: 'Format: 20240104',
                range: range
            },
            {
                label: 'DD/MM/YYYY HH:mm:ss',
                kind: monaco.languages.CompletionItemKind.Constant,
                insertText: 'DD/MM/YYYY HH:mm:ss',
                detail: 'Date with time',
                documentation: 'Format: 04/01/2024 14:30:00',
                range: range
            }
        ];
    }

    /**
     * GitHub Issue #175: Get string modifier suggestions
     */
    function getStringModifierSuggestions(range) {
        return [
            {
                label: 'ifblank:',
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: 'ifblank:',
                detail: 'What a blank becomes',
                documentation: 'ifblank:none sends "none" for a blank value, or one of spaces only (notrim keeps spaces)',
                range: range
            },
            {
                label: 'opt',
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: 'opt',
                detail: 'Optional - omit if empty',
                documentation: 'Omit this key entirely from the JSON if value is empty',
                range: range
            },
            {
                label: 'null',
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: 'null',
                detail: 'Null if empty',
                documentation: 'Pass null value in JSON if value is empty',
                range: range
            },
            {
                label: '3',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '3',
                detail: 'Exact length (3 chars)',
                documentation: 'Validate exactly 3 characters',
                range: range
            },
            {
                label: '3-50',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '3-50',
                detail: 'Length range (3-50 chars)',
                documentation: 'Validate length between 3 and 50 characters',
                range: range
            },
            {
                label: '3-',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '3-',
                detail: 'Min length (at least 3 chars)',
                documentation: 'Validate minimum length of 3 characters',
                range: range
            },
            {
                label: '-50',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '-50',
                detail: 'Max length (at most 50 chars)',
                documentation: 'Validate maximum length of 50 characters',
                range: range
            },
            {
                label: 'upper',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'upper',
                detail: 'Convert to UPPERCASE',
                documentation: 'Transform value to uppercase letters',
                range: range
            },
            {
                label: 'lower',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'lower',
                detail: 'Convert to lowercase',
                documentation: 'Transform value to lowercase letters',
                range: range
            },
            {
                label: 'noTrim',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'noTrim',
                detail: 'Preserve whitespace',
                documentation: 'Keep leading/trailing spaces (default is to trim)',
                range: range
            },
            {
                label: 'asString',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'asString',
                detail: 'Output as JSON string',
                documentation: 'Force output as JSON string regardless of type. Already default for strings.',
                range: range
            }
        ];
    }

    /**
     * GitHub Issue #175: Get number modifier suggestions
     */
    function getNumberModifierSuggestions(range) {
        return [
            {
                label: 'opt',
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: 'opt',
                detail: 'Optional - omit if empty',
                documentation: 'Omit this key entirely from the JSON if value is empty',
                range: range
            },
            {
                label: 'null',
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: 'null',
                detail: 'Null if empty',
                documentation: 'Pass null value in JSON if value is empty',
                range: range
            },
            {
                label: '>0',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '>0',
                detail: 'Greater than 0 (positive)',
                documentation: 'Validate that value is greater than 0',
                range: range
            },
            {
                label: '>=0',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '>=0',
                detail: 'Greater or equal to 0 (non-negative)',
                documentation: 'Validate that value is 0 or more',
                range: range
            },
            {
                label: '<=100',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '<=100',
                detail: 'Less or equal to 100',
                documentation: 'Validate that value is 100 or less',
                range: range
            },
            {
                label: 'int',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'int',
                detail: 'Integer validation',
                documentation: 'Validate that value is a whole number (no decimals)',
                range: range
            },
            {
                label: 'rnd(2)',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'rnd(2)',
                detail: 'Round to 2 decimals',
                documentation: 'Round the number to 2 decimal places',
                range: range
            },
            {
                label: 'floor',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'floor',
                detail: 'Round down',
                documentation: 'Round the number down to nearest integer',
                range: range
            },
            {
                label: 'ceil',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'ceil',
                detail: 'Round up',
                documentation: 'Round the number up to nearest integer',
                range: range
            },
            {
                label: 'asString',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'asString',
                detail: 'Output as JSON string',
                documentation: 'Force output as JSON string: {{Qty:number|asString}} outputs "1" instead of 1',
                range: range
            }
        ];
    }

    /**
     * GitHub Issue #175: Get date math modifier suggestions
     */
    function getDateMathSuggestions(range) {
        return [
            {
                label: 'opt',
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: 'opt',
                detail: 'Optional - omit if empty',
                documentation: 'Omit this key entirely from the JSON if value is empty',
                range: range
            },
            {
                label: 'null',
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: 'null',
                detail: 'Null if empty',
                documentation: 'Pass null value in JSON if value is empty',
                range: range
            },
            {
                label: '+1d',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: '+1d',
                detail: 'Add 1 day',
                documentation: 'Add 1 day to the date',
                range: range
            },
            {
                label: '+2d',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: '+2d',
                detail: 'Add 2 days',
                documentation: 'Add 2 days to the date',
                range: range
            },
            {
                label: '-1d',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: '-1d',
                detail: 'Subtract 1 day',
                documentation: 'Subtract 1 day from the date',
                range: range
            },
            {
                label: '+4h',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: '+4h',
                detail: 'Add 4 hours',
                documentation: 'Add 4 hours to the datetime',
                range: range
            },
            {
                label: '+30m',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: '+30m',
                detail: 'Add 30 minutes',
                documentation: 'Add 30 minutes to the datetime',
                range: range
            }
        ];
    }

    /**
     * GitHub Issue #185: Get boolean modifier suggestions
     */
    function getBooleanModifierSuggestions(range) {
        return [
            {
                label: 'opt',
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: 'opt',
                detail: 'Optional - omit if empty',
                documentation: 'Omit this key entirely from the JSON if value is empty',
                range: range
            },
            {
                label: 'null',
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: 'null',
                detail: 'Null if empty',
                documentation: 'Pass null value in JSON if value is empty',
                range: range
            },
            {
                label: 'asString',
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: 'asString',
                detail: 'Output as JSON string',
                documentation: 'Force output as JSON string: {{Flag:boolean|asString}} outputs "true" instead of true',
                range: range
            }
        ];
    }

    // Expose module API
    window.TemplateCompletions = {
        registerCompletionProvider: registerCompletionProvider,
        updateDecorations: updateTemplateVariableDecorations,
        validate: validateTemplateVariable,
        validateModifiers: validateModifiers,
        // (list / lookup's predictive text: tables, then columns, then modifiers)
        listSuggestions: getListSuggestions,
        VALID_TYPES: VALID_TYPES,
        VALID_A8_VARS: VALID_A8_VARS,
        VALID_SEQUENCE_MODIFIERS: VALID_SEQUENCE_MODIFIERS,
        VALID_DATE_FORMATS: VALID_DATE_FORMATS,
        // GitHub Issue #175: String and number modifiers
        VALID_STRING_MODIFIERS: VALID_STRING_MODIFIERS,
        VALID_NUMBER_MODIFIERS: VALID_NUMBER_MODIFIERS
    };

})();

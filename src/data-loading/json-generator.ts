// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * JSON Generator for Array Repetition
 *
 * Centralizes JSON generation logic to eliminate duplication between
 * preview generation and batch execution. Handles both individual row
 * processing and consolidated array repetition.
 */

import { TemplateParser, ExtendedSequenceManager, SequenceContext, TimezoneConfig, ROOT_ARRAY_PATH } from './template-parser';
import { RepeatableArray } from './types';
import { APIEndpointManager } from '../apiEndpointManager';
import { ArrayRepetitionHelper } from '../services/transaction-preparation/helpers/array-repetition.helper';
import { convertValueBySourceFormat } from '../utils/source-format-converter';

export interface JsonGenerationOptions {
    template: string;
    mappings: Array<{
        variable: string;
        column: string | null;
        dataType: string;
        /** GitHub Issue #162: Source format for value conversion (e.g., 'excel_serial') */
        sourceFormat?: string;
    }>;
    headers: string[];
    repeatableArrays?: RepeatableArray[];
    endpointId?: string;
    sequenceStartValue?: number;
    isBatchExecution?: boolean;
    /** GitHub Issue #162: Timezone configuration for date/datetime processing */
    timezoneConfig?: TimezoneConfig;
    /** GitHub Issue #165: Environment variables for {{ENV:varName}} template substitution */
    environmentVariables?: Record<string, string>;
}

export interface JsonGenerationResult {
    success: boolean;
    jsonData?: any;
    error?: string;
    metadata: {
        rowsProcessed: number;
        isConsolidated: boolean;
        arrayRepetitionUsed: boolean;
        maxRepetitions?: number;
        nestingLevel?: number; // GitHub Issue #119: Track nesting depth (2 or 3)
    };
}

export class JsonGenerator {
    private templateParser: TemplateParser;
    private endpointManager?: APIEndpointManager;

    constructor(endpointManager?: APIEndpointManager) {
        this.templateParser = new TemplateParser();
        this.endpointManager = endpointManager;
    }

    /**
     * Unified variable substitution function (GitHub Issue #165 Refactor)
     *
     * Single source of truth for all variable substitution patterns:
     * - {{varName}} - simple variable
     * - {{varName:type}} - variable with type hint
     * - {{}} or {{:type}} - shorthand (infer from currentKey)
     * - {{ENV:varName}} - environment variable
     * - {{A8:...}} - A8 system variable
     *
     * @param template - Value to process (string, object, array, or primitive)
     * @param mappedData - Map of variable names to values (includes ENV:xxx keys)
     * @param currentKey - JSON key for shorthand inference (optional)
     * @returns Processed value with variables substituted
     */
    private substituteVariables(template: any, mappedData: Record<string, string>, currentKey?: string): any {
        if (typeof template === 'string') {
            return this.substituteVariablesInString(template, mappedData, currentKey);
        } else if (Array.isArray(template)) {
            return template
                .map(item => this.substituteVariables(item, mappedData))
                .filter(item => item !== JsonGenerator.OMIT_KEY);
        } else if (template && typeof template === 'object') {
            const result: any = {};
            for (const [key, value] of Object.entries(template)) {
                const substituted = this.substituteVariables(value, mappedData, key);
                // `|opt` with an empty value: leave the key out altogether.
                if (substituted === JsonGenerator.OMIT_KEY) { continue; }
                result[key] = substituted;
            }
            return result;
        } else {
            return template;
        }
    }

    /**
     * Returned by substituteVariablesInString when a whole-value `|opt` variable is
     * empty; substituteVariables drops the key (or array element) that holds it.
     *
     * Nested/grouped templates (root variables + a lines array) are filled here rather
     * than by TemplateParser, and this path used to read everything after the colon as
     * the type — so `|opt` and `|null` were silently ignored and `number|>=0` was not
     * recognised as a number. TemplateParser remains the reference for what the
     * modifiers mean; this mirrors its empty-value handling for the nested path.
     */
    private static readonly OMIT_KEY: unique symbol = Symbol('dbmn.omitKey');

    /**
     * `|opt` means the value is not required, and an empty one drops the key/value pair
     * from the JSON; `|null` sends null. Neither needs the source file to HAVE the column —
     * Run Batch lets such a variable stay unmapped. For each one, append an empty column
     * (or map an existing same-named column) so generation treats it as empty instead of
     * leaving `{{part:string|opt}}` in the request as literal text.
     *
     * Required variables are untouched: an unmapped one still shows up unsubstituted,
     * which is what makes the mistake visible.
     */
    private addEmptyColumnsForUnmappedOptionals(
        csvData: string,
        options: JsonGenerationOptions
    ): { csvData: string; options: JsonGenerationOptions } {
        let variables: Array<{ name: string; dataType: string; isA8Variable?: boolean; formatModifier?: string }>;
        try {
            variables = this.templateParser.extractVariables(options.template);
        } catch {
            return { csvData, options };
        }

        const mappings = options.mappings ?? [];
        const isMapped = (name: string) => mappings.some(m => m.variable === name && !!m.column);
        // extractVariables() reports the whole spec as the type ("string|opt",
        // "date:iso|opt"); other producers split it into formatModifier. Read both.
        const isOptional = (v: { dataType: string; formatModifier?: string }) =>
            [...JsonGenerator.splitTypeAndModifiers(v.dataType).modifiers,
             ...JsonGenerator.splitTypeAndModifiers('x|' + (v.formatModifier ?? '')).modifiers]
                .some(m => m === 'opt' || m === 'null');

        const missing = variables.filter(v =>
            !v.isA8Variable
            && !v.name.toUpperCase().startsWith('A8:')
            && !v.name.toUpperCase().startsWith('ENV:')
            && isOptional(v)
            && !isMapped(v.name)
        );
        if (missing.length === 0) {
            return { csvData, options };
        }

        const lines = csvData.trim().split('\n').map(l => l.replace(/\r$/, ''));
        const existingHeaders = lines[0].split(',').map(h => h.trim());
        const toAppend = missing.filter(v => !existingHeaders.includes(v.name));

        const newLines = toAppend.length === 0 ? lines : lines.map((line, i) => {
            if (i === 0) { return line + ',' + toAppend.map(v => v.name).join(','); }
            if (line.trim().length === 0) { return line; }
            return line + ','.repeat(toAppend.length);
        });

        return {
            csvData: newLines.join('\n'),
            options: {
                ...options,
                headers: [...(options.headers ?? existingHeaders), ...toAppend.map(v => v.name)],
                mappings: [
                    ...mappings.filter(m => !missing.some(v => v.name === m.variable)),
                    ...missing.map(v => ({
                        variable: v.name,
                        column: v.name,
                        dataType: JsonGenerator.splitTypeAndModifiers(v.dataType).baseType ?? 'string'
                    }))
                ]
            }
        };
    }

    /**
     * THE GROUPING RULE (decided 2026-09-17): in a nested template, a new request — or a new
     * element of an outer array — starts when ANY input variable at that level changes.
     *
     * It used to be the FIRST variable only. Rows that agreed on that one column were folded
     * together even when another header field differed, and the request silently took the
     * first row's values: a PO shipping to two sites became one order for the first site; a
     * template with `buyerName` above `supplierName` put every supplier's lines on one order.
     * A request's header is a statement about every line in it, so rows whose headers
     * differ are different requests — and template order no longer changes the answer.
     *
     * What this does NOT do is repair inconsistent data. When the header carries an
     * identifier from the file (`{{poNumber}}`) and rows for one identifier disagree on
     * another header field, the data is corrupt either way: the old rule hid it inside one
     * request under the first row's values; this rule sends two requests with the same
     * identifier, and the API decides (duplicate error, or overwrite). The rule is cleanly
     * right when the identifier is GENERATED ({{A8:sequence}}) and the header fields are the
     * only thing that says which rows belong together. Catching the conflict before anything
     * is sent belongs in Run Batch validation — parked 2026-09-17.
     *
     * Returns the source columns for a level's variables: mapped through the column mapping,
     * de-duplicated, in template order. A8 and ENV variables never reach here
     * (extractVariablesFromObject skips them) — they are not data, so not part of a key.
     * Mirrored by CsvSortingService.determineSortColumns and the Run Batch preview.
     */
    private groupingColumnsFor(variables: string[] | undefined, options: JsonGenerationOptions): string[] {
        const columns: string[] = [];
        for (const variable of variables ?? []) {
            const mapping = (options.mappings as Array<{ variable: string; column?: string | null }> | undefined)
                ?.find(m => m.variable === variable);
            const column = mapping?.column || variable;
            if (!columns.includes(column)) { columns.push(column); }
        }
        return columns;
    }

    /** Hash-group rows on several columns (trimmed values); columns missing from the header are ignored. */
    private groupRowsByColumns(rows: string[][], headers: string[], columnNames: string[]): Record<string, string[][]> {
        const indices = columnNames.map(name => headers.indexOf(name)).filter(i => i !== -1);
        const groups: Record<string, string[][]> = {};
        for (const row of rows) {
            const groupKey = indices.map(i => (row[i] ?? '').trim()).join('\u0001');
            (groups[groupKey] ||= []).push(row);
        }
        return groups;
    }

    /** Assign a substituted root-level value, or remove the key when `|opt` said to omit it. */
    private assignOrOmit(target: Record<string, unknown>, key: string, value: unknown): void {
        if (value === JsonGenerator.OMIT_KEY) {
            delete target[key];
        } else {
            target[key] = value;
        }
    }

    /** Split "number|>=0|opt" (or "date:iso|+2d") into its base type and lowercased modifiers. */
    private static splitTypeAndModifiers(typeSpec: string | undefined): { baseType: string | undefined; modifiers: string[] } {
        if (!typeSpec) { return { baseType: undefined, modifiers: [] }; }
        const [typeAndFormat, ...mods] = typeSpec.split('|');
        const baseType = typeAndFormat.split(':')[0].trim();
        return { baseType: baseType || undefined, modifiers: mods.map(m => m.trim().toLowerCase()) };
    }

    /**
     * Substitute variables in a string template
     * Handles all variable patterns consistently
     */
    private substituteVariablesInString(template: string, mappedData: Record<string, string>, currentKey?: string): any {
        let result: any = template;

        // Step 1: Handle {{}} and {{:type}} shorthand - infer name from currentKey
        if (currentKey) {
            const shorthandPattern = /\{\{(:[^}]*)?\}\}/g;
            if (result.match(shorthandPattern)) {
                const shorthandMatches = [...result.matchAll(/\{\{(:[^}]*)?\}\}/g)];
                for (const match of shorthandMatches) {
                    const fullMatch = match[0];
                    const typeHint = match[1]?.substring(1).trim();
                    const varValue = mappedData[currentKey];

                    if (varValue !== undefined) {
                        let convertedValue: any = varValue;
                        if (typeHint) {
                            convertedValue = this.convertValueByType(varValue, typeHint);
                        }

                        if (template === fullMatch) {
                            return convertedValue;
                        }

                        result = result.replace(fullMatch, String(convertedValue));
                    }
                }
            }
        }

        // Step 2: Handle explicit variable patterns {{varName}} and {{varName:type}}
        const variablePattern = /\{\{([^:}]+)(?::([^}]+))?\}\}/g;
        const matches = [...result.matchAll(variablePattern)];

        for (const match of matches) {
            const fullMatch = match[0];
            let varName = match[1].trim();
            let dataType = match[2]?.trim();

            // Handle ENV: and A8: prefixes - the colon is part of the name
            // For {{ENV:org}} - varName="ENV", dataType="org" -> varName="ENV:org"
            // For {{A8:SEQ}} - varName="A8", dataType="SEQ" -> varName="A8:SEQ"
            if ((varName.toUpperCase() === 'ENV' || varName.toUpperCase() === 'A8') && dataType) {
                varName = `${varName}:${dataType}`;
                dataType = undefined;
            }

            const varValue = mappedData[varName];

            if (varValue !== undefined) {
                // "number|>=0|opt" → type "number", modifiers [">=0", "opt"]. Validation and
                // transform modifiers have already been applied to the data upstream; the
                // two that change the SHAPE of the JSON — opt and null — have to act here.
                const { baseType, modifiers } = JsonGenerator.splitTypeAndModifiers(dataType);
                const isWholeValue = result === fullMatch;
                const isEmpty = varValue === null || String(varValue).trim() === '';

                if (isEmpty && isWholeValue) {
                    if (modifiers.includes('opt')) { return JsonGenerator.OMIT_KEY; }
                    if (modifiers.includes('null')) { return null; }
                }

                let convertedValue: any = varValue;
                if (baseType) {
                    convertedValue = this.convertValueByType(varValue, baseType);
                }

                if (isWholeValue) {
                    return convertedValue;
                }

                result = result.replace(fullMatch, String(convertedValue));
            }
        }

        return result;
    }

    /**
     * Generate JSON for a single CSV row (for preview)
     */
    async generateSingleRowJson(
        csvRow: string,
        options: JsonGenerationOptions
    ): Promise<JsonGenerationResult> {

        try {
            const rowData = this.parseCSVRow(csvRow, options.headers);
            const mappedData = this.applyMappings(rowData, options.mappings, options.environmentVariables);

            // GitHub Issue #142: Use unified factory for sequence manager
            const sequenceManager = this.createSequenceManager(options);

            // Check if array repetition is enabled
            const hasArrayRepetition = this.hasEnabledArrayRepetition(options.repeatableArrays);

            // For batch execution, don't use repeat config - each member handles its own row only
            // Array repetition should only be used for preview/consolidated generation
            const repeatConfig = (hasArrayRepetition && !options.isBatchExecution) ?
                this.convertToRepeatConfig(options.repeatableArrays || []) : undefined;

            // GitHub Issue #162: Pass timezone config for date/datetime conversion
            const processResult = await this.templateParser.processTemplateAsync(
                options.template,
                mappedData,
                repeatConfig,
                options.endpointId || 'preview',
                sequenceManager,
                undefined, // sequenceContext
                options.timezoneConfig
            );

            if (!processResult.success) {
                return {
                    success: false,
                    error: processResult.error,
                    metadata: {
                        rowsProcessed: 0,
                        isConsolidated: false,
                        arrayRepetitionUsed: false
                    }
                };
            }

            // GitHub Issue #145: Add A8 post-processing (was MISSING - this fixes Run API)
            let jsonData = JSON.parse(processResult.processedJson || '{}');
            jsonData = await this.postProcessJson(jsonData, options, sequenceManager);

            return {
                success: true,
                jsonData,
                metadata: {
                    rowsProcessed: 1,
                    isConsolidated: false,
                    arrayRepetitionUsed: hasArrayRepetition,
                    maxRepetitions: hasArrayRepetition ? this.getMaxRepetitions(options.repeatableArrays || []) : undefined
                }
            };

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                metadata: {
                    rowsProcessed: 0,
                    isConsolidated: false,
                    arrayRepetitionUsed: false
                }
            };
        }
    }

    /**
     * Generate consolidated JSON for multiple CSV rows (for batch execution with array repetition)
     */
    async generateConsolidatedJson(
        csvRows: string[],
        options: JsonGenerationOptions
    ): Promise<JsonGenerationResult> {
        try {
            const hasArrayRepetition = this.hasEnabledArrayRepetition(options.repeatableArrays);
            
            if (!hasArrayRepetition) {
                throw new Error('Array repetition must be enabled for consolidated JSON generation');
            }

            if (csvRows.length === 0) {
                return {
                    success: false,
                    error: 'No CSV rows provided for consolidated JSON generation',
                    metadata: {
                        rowsProcessed: 0,
                        isConsolidated: true,
                        arrayRepetitionUsed: true
                    }
                };
            }

            // Parse all rows
            const allRowData = csvRows.map(row => this.parseCSVRow(row, options.headers));
            
            // Extract the array item template from the full template
            const arrayPath = this.getEnabledArrayPath(options.repeatableArrays || []);
            const itemTemplate = this.extractArrayItemTemplate(options.template, arrayPath);
            
            // Process each row to create array items
            const arrayItems: any[] = [];
            for (const rowData of allRowData) {
                const mappedData = this.applyMappings(rowData, options.mappings, options.environmentVariables);
                
                // GitHub Issue #288: the real, persisting sequence manager. This used
                // to be a stand-in returning `sequenceStartValue + index`, so batch
                // execution handed out 1001, 1002… on every run and never advanced
                // the endpoint's counter. Each item is its own call, so every plain
                // {{A8:sequence}} in one item shares one number.
                const sequenceManager = this.createSequenceManager(options);

                // GitHub Issue #162: Pass timezone config for date/datetime conversion
                const itemResult = await this.templateParser.processTemplateAsync(
                    itemTemplate,
                    mappedData,
                    undefined, // No array repetition for individual items
                    options.endpointId || 'batch',
                    sequenceManager,
                    undefined, // sequenceContext
                    options.timezoneConfig
                );

                if (!itemResult.success) {
                    return {
                        success: false,
                        error: `Failed to process row ${arrayItems.length + 1}: ${itemResult.error}`,
                        metadata: {
                            rowsProcessed: arrayItems.length,
                            isConsolidated: true,
                            arrayRepetitionUsed: true
                        }
                    };
                }

                arrayItems.push(JSON.parse(itemResult.processedJson || '{}'));
            }

            // GitHub Issue #220: Top-level array has no outer variables to process
            let finalJson: string | object;
            if (arrayPath === ROOT_ARRAY_PATH) {
                finalJson = this.buildArrayJson('[]', arrayPath, arrayItems);
            } else {
                // GitHub Issue #127: Process outer template variables using first row's data
                // Outer variables (e.g., ItemId, Description) should be the same for all rows in a batch
                // Only the inner array items (e.g., ItemCode/GTIN) vary per row
                const firstRowMappedData = this.applyMappings(allRowData[0], options.mappings, options.environmentVariables);

                // Process the outer template to replace non-array variables
                // GitHub Issue #162: Pass timezone config for date/datetime conversion
                const outerTemplateResult = await this.templateParser.processTemplateAsync(
                    options.template,
                    firstRowMappedData,
                    undefined,
                    options.endpointId || 'batch',
                    undefined, // sequenceManager
                    undefined, // sequenceContext
                    options.timezoneConfig
                );

                if (!outerTemplateResult.success) {
                    return {
                        success: false,
                        error: `Failed to process outer template variables: ${outerTemplateResult.error}`,
                        metadata: {
                            rowsProcessed: arrayItems.length,
                            isConsolidated: true,
                            arrayRepetitionUsed: true
                        }
                    };
                }

                // Build the complete JSON structure with the processed outer template and array items
                finalJson = this.buildArrayJson(outerTemplateResult.processedJson!, arrayPath, arrayItems);
            }

            // GitHub Issue #142: Use unified factory and post-processing
            const sequenceManager = this.createSequenceManager(options, csvRows.length - 1);
            finalJson = await this.postProcessJson(finalJson, options, sequenceManager);

            return {
                success: true,
                jsonData: finalJson,
                metadata: {
                    rowsProcessed: csvRows.length,
                    isConsolidated: true,
                    arrayRepetitionUsed: true,
                    maxRepetitions: this.getMaxRepetitions(options.repeatableArrays || [])
                }
            };

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                metadata: {
                    rowsProcessed: 0,
                    isConsolidated: true,
                    arrayRepetitionUsed: true
                }
            };
        }
    }

    /**
     * Generate nested JSON from grouped CSV data (GitHub Issue #119)
     * Each CSV group becomes one outer array element with nested inner array items
     *
     * @param csvGroups - Groups created by ArrayRepetitionHelper.groupRowsByFieldValues()
     *                    Each group: [header, row1, row2, ...]
     * @param options - JSON generation options
     */
    async generateNestedArrayJson(
        csvGroups: string[][][],
        options: JsonGenerationOptions
    ): Promise<JsonGenerationResult> {
        try {
            if (csvGroups.length === 0) {
                // No groups - return empty array
                const parsed = JSON.parse(options.template);
                const analysis = this.analyzeNestedArrays(options.template);

                if (!analysis.hasNestedArrays || !analysis.outerArray) {
                    return {
                        success: false,
                        error: 'Template does not have nested array structure',
                        metadata: {
                            rowsProcessed: 0,
                            isConsolidated: true,
                            arrayRepetitionUsed: true
                        }
                    };
                }

                parsed[analysis.outerArray] = [];

                return {
                    success: true,
                    jsonData: parsed,
                    metadata: {
                        rowsProcessed: 0,
                        isConsolidated: true,
                        arrayRepetitionUsed: true
                    }
                };
            }

            // Analyze nested structure
            const analysis = this.analyzeNestedArrays(options.template);

            if (!analysis.hasNestedArrays || !analysis.outerArray || !analysis.innerArray) {
                return {
                    success: false,
                    error: 'Template does not have nested array structure for grouping',
                    metadata: {
                        rowsProcessed: 0,
                        isConsolidated: true,
                        arrayRepetitionUsed: true
                    }
                };
            }

            const parsed = JSON.parse(options.template);
            const outerArrayTemplate = parsed[analysis.outerArray][0];

            // GitHub Issue #127: Navigate through intermediate objects to find innerArray
            // For path "messages[].data.ItemCode", we need to traverse through "data" to reach "ItemCode"
            const pathSegments = analysis.nestingPath!.split('[].').filter(s => s);
            const remainingPath = pathSegments.length > 1 ? pathSegments[1] : analysis.innerArray;
            const pathParts = remainingPath!.split('.');

            // Navigate to the container of the inner array
            let innerArrayContainer = outerArrayTemplate;
            const intermediateKeys: string[] = [];
            for (let i = 0; i < pathParts.length - 1; i++) {
                intermediateKeys.push(pathParts[i]);
                innerArrayContainer = innerArrayContainer[pathParts[i]];
                if (!innerArrayContainer) {
                    return {
                        success: false,
                        error: `Cannot navigate to inner array: path segment '${pathParts[i]}' not found`,
                        metadata: { rowsProcessed: 0, isConsolidated: true, arrayRepetitionUsed: true }
                    };
                }
            }

            const innerArrayTemplate = innerArrayContainer[analysis.innerArray!]?.[0];
            if (!innerArrayTemplate) {
                return {
                    success: false,
                    error: `Inner array '${analysis.innerArray}' not found or empty in template`,
                    metadata: { rowsProcessed: 0, isConsolidated: true, arrayRepetitionUsed: true }
                };
            }

            const outerArrayResult: any[] = [];
            let totalRowsProcessed = 0;

            // GitHub Issue #288: one context for all outer elements, so each
            // element's plain {{A8:sequence}} draws its own number (and :local
            // counts the elements 1, 2, 3)
            const outerSequenceContext = this.templateParser.createSequenceContext({
                arrayPath: analysis.outerArray,
                arrayInstanceId: `${analysis.outerArray}_outer`
            });

            // Process each CSV group
            for (const group of csvGroups) {

                const headerRow = group[0];
                const dataRows = group.slice(1);

                if (dataRows.length === 0) {
                    continue; // Skip empty groups
                }

                totalRowsProcessed += dataRows.length;

                // Map first row to outer object variables
                const firstRow = this.parseCSVRow(dataRows[0].join(','), headerRow);
                const outerMappedData = this.applyMappings(firstRow, options.mappings, options.environmentVariables);

                // Process outer object (excluding inner array)
                // GitHub Issue #127: Handle intermediate objects (e.g., "data" between messages[0] and ItemCode)
                const outerObj: any = {};

                // Helper to process object while excluding inner array at correct level
                // GitHub Issue #165: Refactored to use unified substituteVariables
                const processObjectExcludingInnerArray = async (
                    template: any,
                    mappedData: Record<string, any>,
                    currentPath: string[]
                ): Promise<any> => {
                    const result: any = {};
                    for (const [key, value] of Object.entries(template)) {
                        const keyPath = [...currentPath, key];

                        if (key === analysis.innerArray && currentPath.join('.') === intermediateKeys.join('.')) {
                            // Skip inner array at this level - we'll add it later
                            continue;
                        }

                        if (typeof value === 'string') {
                            // Use unified substituteVariables for string processing
                            result[key] = this.substituteVariablesInString(value, mappedData, key);
                        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                            // Nested object - process recursively, tracking path
                            result[key] = await processObjectExcludingInnerArray(value, mappedData, keyPath);
                        } else if (Array.isArray(value)) {
                            // For arrays other than inner array, just copy
                            result[key] = value;
                        } else {
                            result[key] = value;
                        }
                    }
                    return result;
                };

                // Process the outer template, excluding the inner array
                const processedOuter = await processObjectExcludingInnerArray(outerArrayTemplate, outerMappedData, []);
                Object.assign(outerObj, processedOuter);

                // GitHub Issue #153: Create sequence manager and context for this outer array element
                // This enables :local counters to reset for each outer element (order)
                const sequenceManager = this.createSequenceManager(options);

                // GitHub Issue #288: resolve this outer element's own A8 variables
                // now, before its items, so every plain {{A8:sequence}} in the element
                // shares one number. They used to wait for the root pass, where every
                // outer element shared the root's number.
                Object.assign(outerObj, await this.processA8VariablesInJson(
                    outerObj,
                    options.endpointId || 'execution',
                    sequenceManager,
                    outerSequenceContext
                ));

                // Process inner array items
                const innerArrayResult: any[] = [];

                // Create a sequence context for inner array items
                // The arrayInstanceId ensures :local resets for each group/order
                const innerSequenceContext = this.templateParser.createSequenceContext({
                    arrayPath: analysis.innerArray,
                    arrayInstanceId: `${analysis.innerArray}_group_${outerArrayResult.length}`
                });

                for (const dataRow of dataRows) {
                    const rowData = this.parseCSVRow(dataRow.join(','), headerRow);
                    const innerMappedData = this.applyMappings(rowData, options.mappings, options.environmentVariables);

                    // Process inner array item (handles CSV variables)
                    let innerObj = await this.processNestedObject(innerArrayTemplate, innerMappedData);

                    // GitHub Issue #153: Process A8 variables with sequence context for each inner item
                    // This enables :local to increment per item within this array instance
                    innerObj = await this.processA8VariablesInJson(
                        innerObj,
                        options.endpointId || 'execution',
                        sequenceManager,
                        innerSequenceContext
                    );

                    innerArrayResult.push(innerObj);
                }

                // Combine outer + inner at the correct location
                // GitHub Issue #127: Navigate through intermediate objects to place inner array
                if (intermediateKeys.length > 0) {
                    // Navigate to the container where inner array belongs
                    let container = outerObj;
                    for (const key of intermediateKeys) {
                        if (!container[key]) {
                            container[key] = {};
                        }
                        container = container[key];
                    }
                    container[analysis.innerArray!] = innerArrayResult;
                } else {
                    // Direct child of outer array element
                    outerObj[analysis.innerArray!] = innerArrayResult;
                }
                outerArrayResult.push(outerObj);
            }

            // Build final JSON
            let finalJson: any = { ...parsed };
            finalJson[analysis.outerArray] = outerArrayResult;

            // GitHub Issue #178: Process root-level properties for CSV + ENV variable substitution
            // Root-level properties (outside arrays) need both CSV and ENV variables substituted
            // Previously only ENV variables were included, leaving CSV variables as raw placeholders
            let rootMappedData: Record<string, string> = {};
            if (csvGroups.length > 0 && csvGroups[0].length > 1) {
                const firstGroupHeader = csvGroups[0][0];
                const firstGroupDataRow = csvGroups[0][1];
                const firstRow = this.parseCSVRow(firstGroupDataRow.join(','), firstGroupHeader);
                rootMappedData = this.applyMappings(firstRow, options.mappings, options.environmentVariables);
            } else if (options.environmentVariables) {
                for (const [varName, varValue] of Object.entries(options.environmentVariables)) {
                    rootMappedData[`ENV:${varName}`] = varValue;
                }
            }
            // Process each root-level property except the outer array
            for (const [key, value] of Object.entries(finalJson)) {
                if (key !== analysis.outerArray) {
                    this.assignOrOmit(finalJson, key, this.substituteVariables(value, rootMappedData, key));
                }
            }

            // GitHub Issue #142: Use unified factory and post-processing
            const sequenceManager = this.createSequenceManager(options);
            finalJson = await this.postProcessJson(finalJson, options, sequenceManager);

            return {
                success: true,
                jsonData: finalJson,
                metadata: {
                    rowsProcessed: totalRowsProcessed,
                    isConsolidated: true,
                    arrayRepetitionUsed: true
                }
            };

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error during nested JSON generation',
                metadata: {
                    rowsProcessed: 0,
                    isConsolidated: true,
                    arrayRepetitionUsed: true
                }
            };
        }
    }

    /**
     * Generate 3-level nested JSON from CSV data (GitHub Issue #119 - Extended)
     * Supports structures like shipments[].packages[].items[]
     * @param csvData Full CSV data including headers
     * @param options Generation options including template and mappings
     */
    async generate3LevelNestedArrayJson(
        csvData: string[][],
        options: JsonGenerationOptions
    ): Promise<JsonGenerationResult> {
        try {
            const analysis = this.analyzeNestedArrays(options.template);

            if (!analysis.hasNestedArrays || analysis.nestingLevel !== 3) {
                return {
                    success: false,
                    error: 'Template does not have 3-level nested array structure',
                    metadata: {
                        rowsProcessed: 0,
                        isConsolidated: true,
                        arrayRepetitionUsed: true,
                        nestingLevel: analysis.nestingLevel || 0
                    }
                };
            }

            if (!analysis.outerArray || !analysis.middleArray || !analysis.innerArray || !analysis.nestingPath) {
                return {
                    success: false,
                    error: 'Could not identify array structure',
                    metadata: {
                        rowsProcessed: 0,
                        isConsolidated: true,
                        arrayRepetitionUsed: true,
                        nestingLevel: 3
                    }
                };
            }

            const headerRow = csvData[0];
            const dataRows = csvData.slice(1);

            if (dataRows.length === 0) {
                const parsed = JSON.parse(options.template);
                parsed[analysis.outerArray] = [];
                return {
                    success: true,
                    jsonData: parsed,
                    metadata: {
                        rowsProcessed: 0,
                        isConsolidated: true,
                        arrayRepetitionUsed: true,
                        nestingLevel: 3
                    }
                };
            }

            // Extract templates for each nesting level using TemplateParser approach
            const innerTemplate = this.extractNestedTemplate(options.template, analysis.nestingPath, 'inner');
            const middleTemplate = this.extractNestedTemplate(options.template, analysis.nestingPath, 'middle');
            const outerTemplate = this.extractNestedTemplate(options.template, analysis.nestingPath, 'outer');

            // GitHub Issue #288: the real, persisting sequence manager. This was an
            // in-memory counter starting at sequenceStartValue, so every run of a
            // 3-level batch reused the same numbers and the endpoint's counter
            // never moved.
            const sequenceManager = this.createSequenceManager(options);

            // Group by outer grouping column (e.g., ShipmentID)
            // GitHub Issue #134: Handle empty outerVariables (static wrapper like messages[])
            // When outer array has no variables, all rows belong to a single outer group
            let outerGroups: Record<string, string[][]>;
            if (analysis.outerVariables && analysis.outerVariables.length > 0) {
                outerGroups = this.groupRowsByColumns(dataRows, headerRow, this.groupingColumnsFor(analysis.outerVariables, options));
            } else {
                // No outer variable - all rows belong to one outer group (static wrapper)
                outerGroups = { '_static_wrapper': dataRows };
            }

            const outerArrayResult: any[] = [];
            let totalRowsProcessed = 0;

            // Process each outer group (e.g., each shipment)
            for (const outerGroupRows of Object.values(outerGroups)) {
                if (outerGroupRows.length === 0) continue;

                totalRowsProcessed += outerGroupRows.length;

                // Process first row for outer-level data through TemplateParser
                const firstRow = this.parseCSVRow(outerGroupRows[0].join(','), headerRow);
                const outerMappedData = this.applyMappings(firstRow, options.mappings, options.environmentVariables);
                const outerObj = await this.processRowThroughTemplateParser(
                    outerMappedData,
                    outerTemplate,
                    options,
                    sequenceManager
                );

                // Group by middle grouping column (e.g., PackageID) within this outer group
                const middleGroups = this.groupRowsByColumns(outerGroupRows, headerRow, this.groupingColumnsFor(analysis.middleVariables, options));

                const middleArrayResult: any[] = [];

                // Process each middle group (e.g., each package within shipment)
                for (const middleGroupRows of Object.values(middleGroups)) {
                    if (middleGroupRows.length === 0) continue;

                    // Process first row for middle-level data through TemplateParser
                    const middleFirstRow = this.parseCSVRow(middleGroupRows[0].join(','), headerRow);
                    const middleMappedData = this.applyMappings(middleFirstRow, options.mappings, options.environmentVariables);
                    const middleObj = await this.processRowThroughTemplateParser(
                        middleMappedData,
                        middleTemplate,
                        options,
                        sequenceManager
                    );

                    // Process inner array items (level 3) - each row becomes an item through TemplateParser
                    const innerArrayResult: any[] = [];
                    for (const row of middleGroupRows) {
                        const rowData = this.parseCSVRow(row.join(','), headerRow);
                        const innerMappedData = this.applyMappings(rowData, options.mappings, options.environmentVariables);
                        const innerItem = await this.processRowThroughTemplateParser(
                            innerMappedData,
                            innerTemplate,
                            options,
                            sequenceManager
                        );
                        innerArrayResult.push(innerItem);
                    }

                    middleObj[analysis.innerArray] = innerArrayResult;
                    middleArrayResult.push(middleObj);
                }

                outerObj[analysis.middleArray] = middleArrayResult;
                outerArrayResult.push(outerObj);
            }

            const parsed = JSON.parse(options.template);
            let finalJson: any = { ...parsed };
            finalJson[analysis.outerArray] = outerArrayResult;

            // GitHub Issue #178: Process root-level properties for CSV + ENV variable substitution
            // Root-level properties (outside the outer array) need both CSV and ENV variables substituted
            if (dataRows.length > 0) {
                const firstRow = this.parseCSVRow(dataRows[0].join(','), headerRow);
                const rootMappedData = this.applyMappings(firstRow, options.mappings, options.environmentVariables);
                for (const [key, value] of Object.entries(finalJson)) {
                    if (key !== analysis.outerArray) {
                        this.assignOrOmit(finalJson, key, this.substituteVariables(value, rootMappedData, key));
                    }
                }
            }

            // GitHub Issue #142: Use unified factory and post-processing
            const postProcessSequenceManager = this.createSequenceManager(options);
            finalJson = await this.postProcessJson(finalJson, options, postProcessSequenceManager);

            return {
                success: true,
                jsonData: finalJson,
                metadata: {
                    rowsProcessed: totalRowsProcessed,
                    isConsolidated: true,
                    arrayRepetitionUsed: true,
                    nestingLevel: 3
                }
            };

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error during 3-level JSON generation',
                metadata: {
                    rowsProcessed: 0,
                    isConsolidated: true,
                    arrayRepetitionUsed: true,
                    nestingLevel: 3
                }
            };
        }
    }

    /**
     * Helper method to group rows by a specific column value
     */
    private groupRowsByColumn(rows: string[][], headers: string[], columnName: string): Record<string, string[][]> {
        const columnIndex = headers.indexOf(columnName);
        if (columnIndex === -1) {
            throw new Error(`Column "${columnName}" not found in headers`);
        }

        const groups: Record<string, string[][]> = {};

        for (const row of rows) {
            const groupKey = row[columnIndex];
            if (!groups[groupKey]) {
                groups[groupKey] = [];
            }
            groups[groupKey].push(row);
        }

        return groups;
    }

    /**
     * Process a nested object template by replacing variables
     * Issue #130: Added currentKey parameter to support {{}} shorthand inference
     * GitHub Issue #165: Refactored to use unified substituteVariables function
     *
     * @param template - The template to process
     * @param mappedData - Map of variable names to values
     * @param currentKey - The JSON key containing this value (for {{}} inference)
     */
    private async processNestedObject(template: any, mappedData: Record<string, string>, currentKey?: string): Promise<any> {
        // Delegate to unified substituteVariables function
        return this.substituteVariables(template, mappedData, currentKey);
    }

    /**
     * Convert a string value to the specified data type
     */
    private convertValueByType(value: string, dataType: string): any {
        switch (dataType.toLowerCase()) {
            case 'number':
                const num = Number(value);
                return isNaN(num) ? value : num;
            case 'boolean':
                return value.toLowerCase() === 'true' || value === '1';
            case 'null':
                return null;
            default:
                return value; // Return as string for unknown types or 'string' type
        }
    }

    /**
     * Generate JSON files for batch execution (handles both individual and consolidated)
     */
    async generateBatchJsonFiles(
        csvData: string,
        options: JsonGenerationOptions
    ): Promise<{
        success: boolean;
        files: Array<{
            fileName: string;
            content: any;
            rowRange: { start: number; end: number };
        }>;
        error?: string;
        metadata: {
            totalRows: number;
            totalFiles: number;
            arrayRepetitionUsed: boolean;
            maxRepetitions?: number;
            nestingLevel?: number;
        };
    }> {
        try {
            // An |opt / |null variable needs no column in the file: give it an empty one,
            // so every path below sees an empty value and omits the key (or sends null).
            ({ csvData, options } = this.addEmptyColumnsForUnmappedOptionals(csvData, options));

            // Parse CSV data
            const lines = csvData.trim().split('\n');
            const headers = lines[0].split(',').map(h => h.trim());
            let dataLines = lines.slice(1).filter(line => line.trim().length > 0);

            const files: Array<{
                fileName: string;
                content: any;
                rowRange: { start: number; end: number };
            }> = [];

            // GitHub Issue #119: Detect nested arrays FIRST (highest priority routing)
            const nestingAnalysis = this.analyzeNestedArrays(options.template);

            // GitHub Issue #147: auto-sort so rows with equal headers sit together, which keeps
            // each request's rowRange contiguous for the Console's Input tab. Sorts on EVERY
            // grouping column, outermost level first (see groupingColumnsFor). Grouping itself
            // gathers by key, so this is about order and display, not correctness.
            if (nestingAnalysis.hasNestedArrays) {
                const levelVariables: string[] = [];
                if ((nestingAnalysis.nestingLevel ?? 0) >= 2 && nestingAnalysis.outerArray) {
                    try {
                        levelVariables.push(...this.extractVariablesFromObject(JSON.parse(options.template), [nestingAnalysis.outerArray]));
                    } catch { /* unparseable template is reported further down */ }
                }
                levelVariables.push(...(nestingAnalysis.outerVariables ?? []), ...(nestingAnalysis.middleVariables ?? []));
                const sortIndices = this.groupingColumnsFor(levelVariables, options)
                    .map(column => headers.indexOf(column))
                    .filter(index => index !== -1);

                if (sortIndices.length > 0) {
                    const cellsOf = (line: string) => line.split(',').map(v => v.trim().replace(/"/g, ''));
                    dataLines = dataLines
                        .map(line => ({ line, cells: cellsOf(line) }))
                        .sort((a, b) => {
                            for (const index of sortIndices) {
                                const diff = (a.cells[index] || '').localeCompare(b.cells[index] || '');
                                if (diff !== 0) { return diff; }
                            }
                            return 0; // Array.prototype.sort is stable: file order is kept within a group
                        })
                        .map(entry => entry.line);
                }
            }

            if (nestingAnalysis.hasNestedArrays && nestingAnalysis.nestingLevel === 1) {
                // GitHub Issue #140: 1-LEVEL ARRAY WITH ROOT GROUPING
                // Template like: { "dest": "{{dest}}", "OriginalOrderLine": [...] }
                // Root variables (dest) drive grouping, array items repeat within each group
                const csvDataArray = [headers, ...dataLines.map(line =>
                    line.split(',').map(v => v.trim().replace(/"/g, ''))
                )];

                // A new request whenever ANY root-level variable changes (see groupingColumnsFor)
                const arrayRepetitionHelper = new ArrayRepetitionHelper();
                const csvGroups = arrayRepetitionHelper.groupRowsByFieldValues(
                    csvDataArray,
                    this.groupingColumnsFor(nestingAnalysis.outerVariables, options)
                );

                // GitHub Issue #140: For nested arrays, ignore maxRepetitions
                // Each CSV group (unique toLoc value) becomes ONE file
                // maxRepetitions is only for flat array repetition, not nested grouping
                let fileIndex = 1;
                // GitHub Issue #181: Track actual CSV row positions for RAW tab input display
                let cumulativeRowStart = 1;

                for (const group of csvGroups) {
                    const headerRow = group[0];
                    const dataRows = group.slice(1);

                    if (dataRows.length === 0) continue;

                    // Parse first row for root-level variables
                    const firstRow = this.parseCSVRow(dataRows[0].join(','), headerRow);
                    const rootMappedData = this.applyMappings(firstRow, options.mappings, options.environmentVariables);

                    // Start with the template and replace root variables
                    const parsed = JSON.parse(options.template);
                    const arrayName = nestingAnalysis.outerArray!;

                    // GitHub Issue #165: Replace root-level variables using unified function
                    for (const [key, value] of Object.entries(parsed)) {
                        if (key !== arrayName) {
                            this.assignOrOmit(parsed, key, this.substituteVariables(value, rootMappedData, key));
                        }
                    }

                    // Build array items from all rows in this group
                    const arrayItems: any[] = [];
                    const arrayTemplate = JSON.parse(options.template)[arrayName][0];

                    // GitHub Issue #153: Create sequence manager and context BEFORE the loop
                    // so :local modifier can track per-item sequences
                    const sequenceManager = this.createSequenceManager(options, fileIndex - 1);
                    const endpointId = options.endpointId || 'execution';

                    // GitHub Issue #153: Get the parent sequence value for :parent modifier
                    // This is the same value that {{A8:sequence}} at root level will use
                    const parentSequenceValue = await sequenceManager.getNextSequence(endpointId);

                    // Pre-cache the sequence value so root-level {{A8:sequence}} uses the SAME value
                    // This ensures :parent and root {{A8:sequence}} are consistent
                    this.templateParser.setSequenceCache(endpointId, parentSequenceValue);

                    const arraySequenceContext = this.templateParser.createSequenceContext({
                        arrayPath: arrayName,
                        arrayInstanceId: `${arrayName}_group_${fileIndex}`,
                        parentSequence: parentSequenceValue
                    });

                    for (const dataRow of dataRows) {
                        const rowData = this.parseCSVRow(dataRow.join(','), headerRow);
                        const itemMappedData = this.applyMappings(rowData, options.mappings, options.environmentVariables);
                        let item = await this.processNestedObject(arrayTemplate, itemMappedData);

                        // GitHub Issue #153: Process A8 variables for EACH item with shared context
                        // This enables :local to increment 1, 2, 3 per item
                        item = await this.processA8VariablesInJson(
                            item,
                            endpointId,
                            sequenceManager,
                            arraySequenceContext
                        );

                        arrayItems.push(item);
                    }

                    parsed[arrayName] = arrayItems;

                    // Process remaining A8 variables at root level
                    // Pass context so cache isn't cleared - root {{A8:sequence}} will use cached parentSequenceValue
                    const rootContext = this.templateParser.createSequenceContext({
                        parentSequence: parentSequenceValue
                    });
                    const processedJson = await this.postProcessJson(parsed, options, sequenceManager, rootContext);

                    // Each group becomes one file
                    // GitHub Issue #181: rowRange tracks actual CSV row positions (1-based)
                    files.push({
                        fileName: `grouped-${String(fileIndex).padStart(3, '0')}.json`,
                        content: processedJson,
                        rowRange: { start: cumulativeRowStart, end: cumulativeRowStart + dataRows.length - 1 }
                    });
                    cumulativeRowStart += dataRows.length;
                    fileIndex++;
                }

                return {
                    success: true,
                    files,
                    metadata: {
                        totalRows: dataLines.length,
                        totalFiles: files.length,
                        arrayRepetitionUsed: false, // Not using array repetition for nested
                        maxRepetitions: undefined,
                        nestingLevel: 1
                    }
                };

            } else if (nestingAnalysis.hasNestedArrays && nestingAnalysis.nestingLevel === 3) {
                // 3-LEVEL NESTING: shipments[].packages[].items[]
                // Batch outer groups (shipments) by maxRepetitions, like 2-level nesting
                // GitHub Issue #119: Batch shipments into files (e.g., 3 shipments per file)
                const csvDataArray = [headers, ...dataLines.map(line =>
                    line.split(',').map(v => v.trim().replace(/"/g, ''))
                )];

                // Root-variable pre-grouping: Extract root-level CSV variables from template
                // Same fix as 2-level — root variables must drive grouping
                const parsed3 = JSON.parse(options.template);
                const outerArrayName3 = nestingAnalysis.outerArray!;
                const rootCsvVars3 = this.extractVariablesFromObject(parsed3, [outerArrayName3]);

                const rootGroupByColumns3 = this.groupingColumnsFor(rootCsvVars3, options);

                // Issue #130: Translate template variable name to mapped CSV column name
                // GitHub Issue #134: Handle empty outerVariables (static wrapper like messages[])
                // Empty = static wrapper with nothing to group on: all rows are one group.
                let groupByColumns: string[];
                if (nestingAnalysis.outerVariables && nestingAnalysis.outerVariables.length > 0) {
                    groupByColumns = this.groupingColumnsFor(nestingAnalysis.outerVariables, options);
                } else if (nestingAnalysis.middleVariables && nestingAnalysis.middleVariables.length > 0) {
                    // Fallback to the middle level when outer is empty (static wrapper)
                    groupByColumns = this.groupingColumnsFor(nestingAnalysis.middleVariables, options);
                } else {
                    groupByColumns = [];
                }

                const arrayRepetitionHelper = new ArrayRepetitionHelper();

                // GitHub Issue #147: Restore maxRepetitions batching for nested arrays
                const hasArrayRepetition3 = this.hasEnabledArrayRepetition(options.repeatableArrays);

                // Pre-group by root CSV variable if present
                let rootGroups3: string[][][] = [csvDataArray];
                if (rootGroupByColumns3.length > 0) {
                    rootGroups3 = arrayRepetitionHelper.groupRowsByFieldValues(
                        csvDataArray,
                        rootGroupByColumns3
                    );
                }

                let fileIndex = 1;
                // GitHub Issue #181: Track actual CSV row positions for RAW tab input display
                let cumulativeRowStart = 1;

                for (const rootGroup of rootGroups3) {
                    // Within each root group, apply outer-variable grouping
                    let outerGroups: string[][][];
                    if (groupByColumns.length === 0) {
                        outerGroups = [rootGroup];
                    } else {
                        outerGroups = arrayRepetitionHelper.groupRowsByFieldValues(
                            rootGroup,
                            groupByColumns
                        );
                    }

                    // Nested grouping + array repetition work TOGETHER:
                    // 1. Group CSV rows by outer variable (already done above)
                    // 2. Batch those groups by maxRepetitions
                    const maxRepetitions3 = hasArrayRepetition3
                        ? this.getMaxRepetitions(options.repeatableArrays || [])
                        : outerGroups.length;

                    // Batch groups by maxRepetitions
                    for (let i = 0; i < outerGroups.length; i += maxRepetitions3) {
                        const groupBatch = outerGroups.slice(i, Math.min(i + maxRepetitions3, outerGroups.length));

                        // Process each group in the batch and combine results
                        const batchResults: any[] = [];
                        for (const group of groupBatch) {
                            const result = await this.generate3LevelNestedArrayJson(group, options);
                            if (!result.success) {
                                return {
                                    success: false,
                                    files: [],
                                    error: result.error,
                                    metadata: {
                                        totalRows: dataLines.length,
                                        totalFiles: 0,
                                        arrayRepetitionUsed: hasArrayRepetition3
                                    }
                                };
                            }
                            batchResults.push(result.jsonData);
                        }

                        // Combine batch results into single JSON
                        // For 3-level nesting, the outer array should contain all batch items
                        const combinedJson = this.combineNestedJsonResults(batchResults, options.template);

                        // GitHub Issue #181: Calculate actual CSV data rows in this batch of groups
                        const batchDataRows = groupBatch.reduce((sum, g) => sum + (g.length - 1), 0);
                        files.push({
                            fileName: `nested-${String(fileIndex).padStart(3, '0')}.json`,
                            content: combinedJson,
                            rowRange: { start: cumulativeRowStart, end: cumulativeRowStart + batchDataRows - 1 }
                        });
                        cumulativeRowStart += batchDataRows;
                        fileIndex++;
                    }
                }

                return {
                    success: true,
                    files,
                    metadata: {
                        totalRows: dataLines.length,
                        totalFiles: files.length,
                        arrayRepetitionUsed: hasArrayRepetition3,
                        maxRepetitions: hasArrayRepetition3 ? this.getMaxRepetitions(options.repeatableArrays || []) : undefined,
                        nestingLevel: 3
                    }
                };

            } else if (nestingAnalysis.hasNestedArrays && nestingAnalysis.nestingLevel === 2) {
                // 2-LEVEL NESTING: orders[].items[]
                // GitHub Issue #119: Batch groups together based on maxRepetitions
                // If maxRepetitions = 8, create files with up to 8 outer objects (e.g., 8 orders) each
                const csvDataArray = [headers, ...dataLines.map(line =>
                    line.split(',').map(v => v.trim().replace(/"/g, ''))
                )];

                // Root-variable pre-grouping: Extract root-level CSV variables from template
                // For templates like { RoleId, RoleName, Grant: [{ ResourceId, ExclusionGrant: [...] }] }
                // root variables (RoleId, RoleName) must drive grouping so each unique root value
                // becomes a separate file, just like 1-level nesting handles it
                const parsed2 = JSON.parse(options.template);
                const outerArrayName2 = nestingAnalysis.outerArray!;
                const rootCsvVars2 = this.extractVariablesFromObject(parsed2, [outerArrayName2]);

                // Determine root grouping column (if any root CSV variables exist)
                const rootGroupByColumns2 = this.groupingColumnsFor(rootCsvVars2, options);

                // GitHub Issue #134: Handle empty outerVariables (static wrapper like messages[])
                // Issue #130: Translate template variable name to mapped CSV column name
                // Empty = static wrapper with nothing to group on: all rows are one group.
                let groupByColumns2: string[];
                if (nestingAnalysis.outerVariables && nestingAnalysis.outerVariables.length > 0) {
                    groupByColumns2 = this.groupingColumnsFor(nestingAnalysis.outerVariables, options);
                } else if (nestingAnalysis.innerVariables && nestingAnalysis.innerVariables.length > 0) {
                    // Fallback when outer is empty (static wrapper). The inner level is the LINES,
                    // so only its first variable identifies a group — every variable would make
                    // one group per row.
                    groupByColumns2 = this.groupingColumnsFor([nestingAnalysis.innerVariables[0]], options);
                } else {
                    groupByColumns2 = [];
                }

                const arrayRepetitionHelper = new ArrayRepetitionHelper();

                // GitHub Issue #147: Restore maxRepetitions batching for nested arrays
                const hasArrayRepetition = this.hasEnabledArrayRepetition(options.repeatableArrays);

                // Pre-group by root CSV variable if present, then apply outer-variable grouping within each root group
                let rootGroups: string[][][] = [csvDataArray];
                if (rootGroupByColumns2.length > 0) {
                    rootGroups = arrayRepetitionHelper.groupRowsByFieldValues(
                        csvDataArray,
                        rootGroupByColumns2
                    );
                }

                let fileIndex = 1;
                // GitHub Issue #181: Track actual CSV row positions for RAW tab input display
                let cumulativeRowStart = 1;

                for (const rootGroup of rootGroups) {
                    // Within each root group, apply outer-variable grouping
                    let csvGroups: string[][][];
                    if (groupByColumns2.length === 0) {
                        csvGroups = [rootGroup];
                    } else {
                        csvGroups = arrayRepetitionHelper.groupRowsByFieldValues(
                            rootGroup,
                            groupByColumns2
                        );
                    }

                    // Nested grouping + array repetition work TOGETHER:
                    // 1. Group CSV rows by outer variable (already done above)
                    // 2. Batch those groups by maxRepetitions
                    const maxRepetitions = hasArrayRepetition
                        ? this.getMaxRepetitions(options.repeatableArrays || [])
                        : csvGroups.length;

                    // Batch groups by maxRepetitions
                    for (let i = 0; i < csvGroups.length; i += maxRepetitions) {
                        const groupBatch = csvGroups.slice(i, Math.min(i + maxRepetitions, csvGroups.length));

                        // Pass batch of groups to generateNestedArrayJson
                        const result = await this.generateNestedArrayJson(groupBatch, options);

                        if (!result.success) {
                            return {
                                success: false,
                                files: [],
                                error: result.error,
                                metadata: {
                                    totalRows: dataLines.length,
                                    totalFiles: 0,
                                    arrayRepetitionUsed: hasArrayRepetition
                                }
                            };
                        }

                        // GitHub Issue #181: Calculate actual CSV data rows in this batch of groups
                        const batchDataRows = groupBatch.reduce((sum, g) => sum + (g.length - 1), 0);
                        files.push({
                            fileName: `nested-${String(fileIndex).padStart(3, '0')}.json`,
                            content: result.jsonData,
                            rowRange: { start: cumulativeRowStart, end: cumulativeRowStart + batchDataRows - 1 }
                        });
                        cumulativeRowStart += batchDataRows;
                        fileIndex++;
                    }
                }

                return {
                    success: true,
                    files,
                    metadata: {
                        totalRows: dataLines.length,
                        totalFiles: files.length,
                        arrayRepetitionUsed: hasArrayRepetition,
                        maxRepetitions: hasArrayRepetition ? this.getMaxRepetitions(options.repeatableArrays || []) : undefined,
                        nestingLevel: 2
                    }
                };

            }

            // FLAT ARRAY or SINGLE ROW routing (existing logic)
            const hasArrayRepetition = this.hasEnabledArrayRepetition(options.repeatableArrays);
            const maxRepetitions = hasArrayRepetition ? this.getMaxRepetitions(options.repeatableArrays || []) : 1;

            if (hasArrayRepetition) {
                // Generate consolidated files
                const chunks = Math.ceil(dataLines.length / maxRepetitions);
                
                for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex++) {
                    const startIndex = chunkIndex * maxRepetitions;
                    const endIndex = Math.min(startIndex + maxRepetitions, dataLines.length);
                    const chunkRows = dataLines.slice(startIndex, endIndex);

                    const result = await this.generateConsolidatedJson(chunkRows, options);
                    
                    if (!result.success) {
                        return {
                            success: false,
                            files: [],
                            error: result.error,
                            metadata: {
                                totalRows: dataLines.length,
                                totalFiles: 0,
                                arrayRepetitionUsed: hasArrayRepetition
                            }
                        };
                    }

                    files.push({
                        fileName: `batch-${String(chunkIndex + 1).padStart(3, '0')}.json`,
                        content: result.jsonData,
                        rowRange: { start: startIndex + 1, end: endIndex }
                    });
                }
            } else {
                // Generate individual files - one row per file
                for (let i = 0; i < dataLines.length; i++) {
                    // #288: sequences now advance on every draw, so this flag is no
                    // longer what makes them increment. It still matters here: it
                    // suppresses array repetition (the repeatConfig in
                    // generateSingleRowJson), which per-row files must not use.
                    const batchOptions = { ...options, isBatchExecution: true };
                    const result = await this.generateSingleRowJson(dataLines[i], batchOptions);
                    
                    if (!result.success) {
                        return {
                            success: false,
                            files: [],
                            error: result.error,
                            metadata: {
                                totalRows: dataLines.length,
                                totalFiles: 0,
                                arrayRepetitionUsed: hasArrayRepetition
                            }
                        };
                    }

                    files.push({
                        fileName: `row-${String(i + 1).padStart(3, '0')}.json`,
                        content: result.jsonData,
                        rowRange: { start: i + 1, end: i + 1 }
                    });
                }
            }

            return {
                success: true,
                files,
                metadata: {
                    totalRows: dataLines.length,
                    totalFiles: files.length,
                    arrayRepetitionUsed: hasArrayRepetition,
                    maxRepetitions: hasArrayRepetition ? maxRepetitions : undefined
                }
            };

        } catch (error) {
            return {
                success: false,
                files: [],
                error: error instanceof Error ? error.message : 'Unknown error',
                metadata: {
                    totalRows: 0,
                    totalFiles: 0,
                    arrayRepetitionUsed: false
                }
            };
        }
    }

    // Helper methods

    /**
     * Analyze template for nested array structure (GitHub Issue #119)
     * Detects if template has nested arrays (e.g., orders[].items)
     * and identifies which variables belong to outer vs inner arrays
     * Made public for GitHub Issue #147 - consistent nesting detection across codebase
     */
    public analyzeNestedArrays(template: string): {
        hasNestedArrays: boolean;
        nestingLevel?: number;
        outerArray?: string;
        middleArray?: string;
        innerArray?: string;
        nestingPath?: string;
        outerVariables?: string[];
        middleVariables?: string[];
        innerVariables?: string[];
    } {
        const arrays = this.templateParser.detectArrays(template);

        // Find nested array paths (contain [] in them, e.g., "orders[].items" or "shipments[].packages[].items")
        const nestedArrays = arrays.filter(arr =>
            arr.path.includes('[]') && arr.path.split('.').length > 1
        );

        if (nestedArrays.length === 0) {
            // GitHub Issue #220: Top-level array has no outer variables, always flat repetition
            const rootArrays = arrays.filter(arr => !arr.path.includes('.') && !arr.path.includes('[]'));
            if (rootArrays.length > 0 && rootArrays[0].path === ROOT_ARRAY_PATH) {
                return { hasNestedArrays: false };
            }

            // GitHub Issue #140: Check for 1-level arrays with root grouping variables
            // This handles templates like: { "dest": "{{dest}}", "OriginalOrderLine": [...] }
            // Where root-level variables should drive grouping

            if (rootArrays.length > 0) {
                try {
                    const parsed = JSON.parse(template);

                    // GitHub Issue #279: A template can hold MORE THAN ONE root-level array,
                    // where only one carries per-row {{variables}} (the array to group/repeat)
                    // while the others are static (e.g. AsnRequestedService). We used to inspect
                    // only rootArrays[0]; when that happened to be a static array, we bailed out
                    // and the whole template fell back to flat/single-row generation, so batch
                    // rows were never grouped. Instead, scan every root array and select the
                    // first one whose items contain variables as the grouping array.
                    //
                    // extractVariablesFromObject skips array values entirely, so root variables
                    // are the same regardless of which array names we exclude — pass them all.
                    const rootVariables = this.extractVariablesFromObject(
                        parsed,
                        rootArrays.map(arr => arr.path)
                    );

                    for (const rootArray of rootArrays) {
                        const arrayName = rootArray.path; // e.g., "OriginalOrderLine" or "AsnLine"
                        const arrayTemplate = parsed[arrayName];

                        if (!Array.isArray(arrayTemplate) || arrayTemplate.length === 0) {
                            continue;
                        }

                        // Extract array item variables
                        const arrayVariables = this.extractVariablesFromObject(arrayTemplate[0]);

                        // If we have both root variables AND array variables, this is 1-level grouping
                        if (rootVariables.length > 0 && arrayVariables.length > 0) {
                            return {
                                hasNestedArrays: true,
                                nestingLevel: 1,
                                outerArray: arrayName,
                                innerArray: arrayName,
                                nestingPath: arrayName,
                                outerVariables: rootVariables,
                                innerVariables: arrayVariables
                            };
                        }
                    }
                } catch (error) {
                    // If parsing fails, fall through to no nesting
                }
            }

            return { hasNestedArrays: false };
        }

        // Find the deepest nesting by counting [] markers (most nested path)
        const sortedByDepth = nestedArrays.sort((a, b) => {
            const depthA = (a.path.match(/\[\]/g) || []).length;
            const depthB = (b.path.match(/\[\]/g) || []).length;
            return depthB - depthA; // Sort descending (deepest first)
        });

        // Detect nesting level by counting [][] patterns
        const nestedPath = sortedByDepth[0].path; // e.g., "orders[].items" or "shipments[].packages[].items"
        const arrayMarkers = (nestedPath.match(/\[\]/g) || []).length;
        // Nesting level = array markers + 1 (the final array name doesn't have [] appended)
        const nestingLevel = arrayMarkers + 1;

        // GitHub Issue #127: Split path by array markers to correctly identify array levels
        // This handles intermediate objects like "data:BASE64" that aren't arrays
        // e.g., "messages[].data:BASE64.ItemCode" should identify:
        //   - outerArray = "messages" (followed by [])
        //   - innerArray = "ItemCode" (last segment of remaining path)
        //   - intermediate path = "data:BASE64" (just an object to traverse)
        const arraySegments = nestedPath.split('[].').filter(s => s);

        // Parse template and extract variables based on nesting level
        try {
            const parsed = JSON.parse(template);

            if (nestingLevel === 2) {
                // 2-level nesting: outer[].inner or outer[].intermediate.inner
                const outerArray = arraySegments[0]; // e.g., "messages"
                const remainingPath = arraySegments[1]; // e.g., "data:BASE64.ItemCode" or just "items"

                // Get the inner array name (last segment after dots)
                const remainingParts = remainingPath.split('.');
                const innerArray = remainingParts[remainingParts.length - 1]; // e.g., "ItemCode" or "items"

                // Navigate to outer object
                const outerObj = parsed[outerArray][0];

                // Navigate to inner object, traversing any intermediate objects
                let innerContainer = outerObj;
                for (let i = 0; i < remainingParts.length - 1; i++) {
                    innerContainer = innerContainer[remainingParts[i]];
                    if (!innerContainer) {
                        return { hasNestedArrays: false };
                    }
                }
                const innerObj = innerContainer[innerArray]?.[0];

                if (!innerObj) {
                    return { hasNestedArrays: false };
                }

                // Extract variables for CSV grouping from the PARENT of the inner array
                // For path "messages[].data.ItemCode", outerVariables should come from "data" (not "messages[0]")
                // because ItemId, Description, Weight are inside "data", not at the messages[0] level
                const outerVariables = this.extractVariablesFromObject(innerContainer, [innerArray]);

                // For inner variables, include variables from intermediate objects too
                let allInnerVariables: string[] = [];
                if (remainingParts.length > 1) {
                    // There are intermediate objects - extract their variables too
                    let intermediateObj = outerObj;
                    for (let i = 0; i < remainingParts.length - 1; i++) {
                        intermediateObj = intermediateObj[remainingParts[i]];
                        if (intermediateObj && typeof intermediateObj === 'object') {
                            const intermediateVars = this.extractVariablesFromObject(
                                intermediateObj,
                                [remainingParts[i + 1] || innerArray]
                            );
                            allInnerVariables = [...allInnerVariables, ...intermediateVars];
                        }
                    }
                }

                // Add variables from the actual inner array items
                const innerVariables = this.extractVariablesFromObject(innerObj);
                allInnerVariables = [...allInnerVariables, ...innerVariables];

                return {
                    hasNestedArrays: true,
                    nestingLevel: 2,
                    outerArray,
                    innerArray,
                    nestingPath: nestedPath,
                    outerVariables,
                    innerVariables: allInnerVariables
                };
            } else if (nestingLevel === 3) {
                // 3-level nesting: outer[].middle[].inner
                const outerArray = arraySegments[0];
                const middleSegment = arraySegments[1];
                const innerSegment = arraySegments[2];

                // Handle intermediate objects in each segment
                const middleParts = middleSegment.split('.');
                const middleArray = middleParts[0]; // First part after outer[] is the middle array

                const innerParts = innerSegment.split('.');
                const innerArray = innerParts[innerParts.length - 1];

                const outerObj = parsed[outerArray][0];
                const middleObj = outerObj[middleArray][0];

                // Navigate to inner through any intermediate objects
                let innerContainer = middleObj;
                for (let i = 0; i < innerParts.length - 1; i++) {
                    innerContainer = innerContainer[innerParts[i]];
                    if (!innerContainer) {
                        return { hasNestedArrays: false };
                    }
                }
                const innerObj = innerContainer[innerArray]?.[0];

                if (!innerObj) {
                    return { hasNestedArrays: false };
                }

                const outerVariables = this.extractVariablesFromObject(outerObj, [middleArray]);
                const middleVariables = this.extractVariablesFromObject(middleObj, [innerParts[0] || innerArray]);
                const innerVariables = this.extractVariablesFromObject(innerObj);

                return {
                    hasNestedArrays: true,
                    nestingLevel: 3,
                    outerArray,
                    middleArray,
                    innerArray,
                    nestingPath: nestedPath,
                    outerVariables,
                    middleVariables,
                    innerVariables
                };
            } else {
                // Unsupported nesting level (> 3)
                return { hasNestedArrays: false };
            }
        } catch (error) {
            // If parsing fails, return no nesting
            return { hasNestedArrays: false };
        }
    }

    /**
     * Extract variable names from a JSON object
     * Recursively finds all {{variable}} placeholders
     * Issue #130: Now supports {{}} and {{:type}} shorthand syntax
     * @param obj - Object to extract variables from
     * @param excludeKeys - Keys to skip (e.g., nested arrays)
     */
    private extractVariablesFromObject(obj: any, excludeKeys: string[] = []): string[] {
        const variables: string[] = [];

        /**
         * Extract variables from a value, with key context for shorthand inference
         * @param value - The value to extract from
         * @param currentKey - The JSON key containing this value (for {{}} inference)
         */
        const extract = (value: any, currentKey: string | null = null) => {
            if (typeof value === 'string') {
                // Updated regex to match all variable patterns including empty {{}} and {{:type}}
                const matches = value.matchAll(/\{\{([^}]*)\}\}/g);
                for (const match of matches) {
                    const content = match[1].trim();
                    let variableName: string | null = null;

                    if (content === '' || content.startsWith(':')) {
                        // Issue #130: Empty {{}} or type-only {{:type}} - infer from JSON key
                        if (currentKey) {
                            variableName = currentKey;
                        }
                    } else if (content.includes(':')) {
                        // Explicit name with type: {{Name:type}}
                        const colonIndex = content.indexOf(':');
                        const prefix = content.substring(0, colonIndex).trim();
                        // GitHub Issue #165: Skip A8 and ENV variables - they're not CSV columns
                        if (prefix.toUpperCase() !== 'A8' && prefix.toUpperCase() !== 'ENV') {
                            variableName = prefix;
                        }
                    } else {
                        // Explicit name only: {{Name}}
                        variableName = content;
                    }

                    if (variableName && !variables.includes(variableName)) {
                        variables.push(variableName);
                    }
                }
            } else if (Array.isArray(value)) {
                // Skip arrays (these are nested structures we want to exclude)
                return;
            } else if (value && typeof value === 'object') {
                for (const [key, val] of Object.entries(value)) {
                    if (!excludeKeys.includes(key)) {
                        // Pass the key as context for shorthand inference
                        extract(val, key);
                    }
                }
            }
        };

        extract(obj);
        return variables;
    }

    private parseCSVRow(row: string, headers: string[]): Record<string, string> {
        const values = row.split(',').map(v => v.trim().replace(/"/g, ''));
        const rowData: Record<string, string> = {};
        
        headers.forEach((header, index) => {
            rowData[header] = values[index] || '';
        });
        return rowData;
    }

    private applyMappings(
        rowData: Record<string, string>,
        mappings: Array<{ variable: string; column: string | null; dataType: string; sourceFormat?: string }>,
        environmentVariables?: Record<string, string>
    ): Record<string, string> {
        const mappedData: Record<string, string> = { ...rowData };

        mappings.forEach((mapping, index) => {
            if (mapping.column && rowData[mapping.column] !== undefined) {
                let value = rowData[mapping.column];

                // GitHub Issue #162: Apply source format conversion
                // GitHub Issue #218: STRING guard is built into shared utility
                if (mapping.sourceFormat) {
                    value = convertValueBySourceFormat(value, mapping.sourceFormat, mapping.dataType);
                }

                // Add the mapping so template variables can be replaced
                mappedData[mapping.variable] = value;
            }
        });

        // GitHub Issue #165: Inject environment variables with ENV: prefix
        // This allows template-parser to find them when processing {{ENV:varName}} patterns
        if (environmentVariables) {
            for (const [varName, varValue] of Object.entries(environmentVariables)) {
                mappedData[`ENV:${varName}`] = varValue;
            }
        }

        return mappedData;
    }

    private hasEnabledArrayRepetition(repeatableArrays?: RepeatableArray[]): boolean {
        return repeatableArrays ? 
            repeatableArrays.length > 0 && repeatableArrays.some(arr => arr.enabled) : 
            false;
    }

    private getMaxRepetitions(repeatableArrays: RepeatableArray[]): number {
        const enabledArrays = repeatableArrays.filter(arr => arr.enabled);
        return enabledArrays.length > 0 ?
            Math.max(...enabledArrays.map(arr => arr.maxRepetitions)) :
            100;
    }

    /**
     * GitHub Issue #147: Combine multiple nested JSON results into a single JSON structure
     * Used when batching multiple groups by maxRepetitions
     * @param results - Array of JSON objects from nested generation
     * @param template - Original template to determine outer array name
     * @returns Combined JSON with all outer array items merged
     */
    private combineNestedJsonResults(results: any[], template: string): any {
        if (results.length === 0) {
            return {};
        }
        if (results.length === 1) {
            return results[0];
        }

        try {
            const parsed = JSON.parse(template);
            // Find the outer array name
            const outerArrayName = Object.keys(parsed).find(key => Array.isArray(parsed[key]));

            if (!outerArrayName) {
                // No outer array found, just return first result
                return results[0];
            }

            // Combine all outer arrays from each result
            const combined = { ...results[0] };
            combined[outerArrayName] = [];

            for (const result of results) {
                if (result[outerArrayName] && Array.isArray(result[outerArrayName])) {
                    combined[outerArrayName].push(...result[outerArrayName]);
                }
            }

            return combined;
        } catch (error) {
            // If parsing fails, return first result
            return results[0];
        }
    }

    private convertToRepeatConfig(repeatableArrays: RepeatableArray[]): Record<string, number> {
        const repeatConfig: Record<string, number> = {};
        
        repeatableArrays
            .filter(arr => arr.enabled)
            .forEach(arr => {
                repeatConfig[arr.arrayPath] = arr.maxRepetitions;
            });
            
        return repeatConfig;
    }

    private getEnabledArrayPath(repeatableArrays: RepeatableArray[]): string {
        const enabledArray = repeatableArrays.find(arr => arr.enabled);
        if (!enabledArray) {
            throw new Error('No enabled repeatable array found');
        }
        return enabledArray.arrayPath;
    }

    private extractArrayItemTemplate(template: string, arrayPath: string): string {
        try {
            const parsed = JSON.parse(template);

            // GitHub Issue #220: Top-level array — template IS the array
            if (arrayPath === ROOT_ARRAY_PATH) {
                if (!Array.isArray(parsed) || parsed.length === 0) {
                    throw new Error('Top-level array template is empty or not an array');
                }
                return JSON.stringify(parsed[0]);
            }

            // GitHub Issue #127: Handle nested paths like "messages[].data.ItemCode"
            // Split by []. to get array segments, then navigate through intermediate objects
            const segments = arrayPath.split('[].').filter(s => s);

            let current: any = parsed;

            for (let i = 0; i < segments.length; i++) {
                const segment = segments[i];

                // Each segment might have intermediate objects (e.g., "data.ItemCode")
                const parts = segment.split('.');

                for (let j = 0; j < parts.length; j++) {
                    const part = parts[j];

                    if (current[part] === undefined) {
                        throw new Error(`Path segment '${part}' not found in template at path '${arrayPath}'`);
                    }

                    const value = current[part];

                    // If this is the last part and it's an array, we found our target
                    if (j === parts.length - 1 && i === segments.length - 1) {
                        if (!Array.isArray(value) || value.length === 0) {
                            throw new Error(`Array path '${arrayPath}' not found or empty in template`);
                        }
                        // Return the first item as the template for array items
                        return JSON.stringify(value[0]);
                    }

                    // If it's an array (but not our target), navigate into first element
                    if (Array.isArray(value)) {
                        if (value.length === 0) {
                            throw new Error(`Empty array at '${part}' in path '${arrayPath}'`);
                        }
                        current = value[0];
                    } else {
                        current = value;
                    }
                }
            }

            throw new Error(`Array path '${arrayPath}' not found in template`);
        } catch (error) {
            throw new Error(`Failed to extract array item template: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private buildArrayJson(template: string, arrayPath: string, arrayItems: any[]): any {
        try {
            // GitHub Issue #220: Top-level array — the array IS the result, no wrapping object
            if (arrayPath === ROOT_ARRAY_PATH) {
                return arrayItems;
            }

            const parsed = JSON.parse(template);

            // GitHub Issue #127: Handle nested paths like "messages[].data.ItemCode"
            // Split by []. to get array segments, then navigate through intermediate objects
            const segments = arrayPath.split('[].').filter(s => s);

            let current: any = parsed;
            let parent: any = null;
            let lastKey: string = '';

            for (let i = 0; i < segments.length; i++) {
                const segment = segments[i];

                // Each segment might have intermediate objects (e.g., "data.ItemCode")
                const parts = segment.split('.');

                for (let j = 0; j < parts.length; j++) {
                    const part = parts[j];

                    // Track parent and key for final assignment
                    parent = current;
                    lastKey = part;

                    // If this is the last part and last segment, set the array here
                    if (j === parts.length - 1 && i === segments.length - 1) {
                        current[part] = arrayItems;
                        return parsed;
                    }

                    const value = current[part];

                    // If it's an array, navigate into first element
                    if (Array.isArray(value)) {
                        if (value.length === 0) {
                            throw new Error(`Empty array at '${part}' in path '${arrayPath}'`);
                        }
                        current = value[0];
                    } else {
                        current = value;
                    }
                }
            }

            return parsed;
        } catch (error) {
            throw new Error(`Failed to build array JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Extract template for nested arrays (GitHub Issue #119)
     * For 3-level: shipments[].packages[].items[], this extracts templates for each level
     * @param template - Full JSON template
     * @param nestingPath - Path like "shipments[].packages[].items"
     * @param level - Which level to extract: 'outer', 'middle', 'inner'
     */
    private extractNestedTemplate(template: string, nestingPath: string, level: 'outer' | 'middle' | 'inner'): string {
        try {
            const parsed = JSON.parse(template);
            const pathParts = nestingPath.split('[].');

            let current: any = parsed;

            if (level === 'inner') {
                // Navigate to innermost array and return its first element
                for (let i = 0; i < pathParts.length; i++) {
                    const arrayName = pathParts[i];
                    if (Array.isArray(current[arrayName]) && current[arrayName].length > 0) {
                        if (i === pathParts.length - 1) {
                            // This is the innermost level
                            return JSON.stringify(current[arrayName][0]);
                        }
                        current = current[arrayName][0];
                    } else {
                        throw new Error(`Array '${arrayName}' not found or empty in template`);
                    }
                }
            } else if (level === 'middle') {
                // Navigate to middle array and return its first element (without the inner array)
                for (let i = 0; i < pathParts.length - 1; i++) {
                    const arrayName = pathParts[i];
                    if (Array.isArray(current[arrayName]) && current[arrayName].length > 0) {
                        if (i === pathParts.length - 2) {
                            // This is the middle level
                            const middleTemplate = { ...current[arrayName][0] };
                            // Remove the inner array
                            const innerArrayName = pathParts[pathParts.length - 1];
                            delete middleTemplate[innerArrayName];
                            return JSON.stringify(middleTemplate);
                        }
                        current = current[arrayName][0];
                    } else {
                        throw new Error(`Array '${arrayName}' not found or empty in template`);
                    }
                }
            } else if (level === 'outer') {
                // Return outer object (without the middle array)
                const outerArrayName = pathParts[0];
                if (Array.isArray(parsed[outerArrayName]) && parsed[outerArrayName].length > 0) {
                    const outerTemplate = { ...parsed[outerArrayName][0] };
                    // Remove the middle array
                    if (pathParts.length >= 2) {
                        const middleArrayName = pathParts[1];
                        delete outerTemplate[middleArrayName];
                    }
                    return JSON.stringify(outerTemplate);
                } else {
                    throw new Error(`Outer array '${outerArrayName}' not found or empty in template`);
                }
            }

            throw new Error(`Invalid level: ${level}`);
        } catch (error) {
            throw new Error(`Failed to extract nested template: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Process CSV rows through TemplateParser to create JSON object
     * This ensures ALL existing template functionality works (A8 variables, type conversion, etc.)
     */
    private async processRowThroughTemplateParser(
        rowData: Record<string, string>,
        template: string,
        options: JsonGenerationOptions,
        sequenceManager: { getNextSequence: (id: string) => Promise<number> }
    ): Promise<any> {
        // GitHub Issue #162: Pass timezone config for date/datetime conversion
        const result = await this.templateParser.processTemplateAsync(
            template,
            rowData,
            undefined, // No array repetition for individual items
            options.endpointId || 'batch',
            sequenceManager,
            undefined, // sequenceContext
            options.timezoneConfig
        );

        if (!result.success) {
            throw new Error(result.error || 'Template processing failed');
        }

        return JSON.parse(result.processedJson || '{}');
    }

    // ========================================================================
    // GitHub Issues #142 + #145: Unified JSON Generation Infrastructure
    // ========================================================================

    /**
     * Factory for creating sequence managers
     * GitHub Issue #142: Replaces 5+ duplicated sequence manager creations
     * GitHub Issue #153: Extended to support array sequence methods for :global modifier
     *
     * @param options - JSON generation options containing endpointId and batch context
     * @param offset - Optional offset for sequence numbers (used in batching)
     * @returns Extended sequence manager object with getNextSequence and getNextArraySequence methods
     */
    private createSequenceManager(options: JsonGenerationOptions, offset: number = 0): ExtendedSequenceManager {
        return {
            getNextSequence: async (id: string): Promise<number> => {
                if (this.endpointManager && options.endpointId) {
                    try {
                        // GitHub Issue #288: drawing a sequence consumes it, always.
                        // The counter used to advance only when `isBatchExecution`
                        // was set, and the Run Batch paths never set it — so every
                        // run re-read `sequenceCounter + 1` and handed out the same
                        // number forever. A value that has been issued is spent,
                        // whether it was issued for a preview or a real execution;
                        // gaps are fine, reuse is not.
                        return await this.endpointManager.getNextSequence(options.endpointId);
                    } catch (error) {
                        // Couldn't persist (endpoint not saved yet, storage failure).
                        // Say so — silently returning a number we failed to reserve
                        // is exactly what hid #288.
                        console.warn(
                            `[JsonGenerator] Could not advance the sequence for endpoint "${options.endpointId}" — ` +
                            'falling back to the start value, so repeated runs may reuse numbers.',
                            error
                        );
                        return (options.sequenceStartValue || 1001) + offset;
                    }
                }
                return (options.sequenceStartValue || 1001) + offset;
            },
            // GitHub Issue #153: Array sequence method for :global modifier
            getNextArraySequence: async (endpointId: string, arrayPath: string): Promise<number> => {
                if (this.endpointManager && options.endpointId) {
                    try {
                        // GitHub Issue #288: same rule for the `:global` counter —
                        // it advances on every draw, not only during batch execution.
                        return await this.endpointManager.getNextArraySequence(endpointId, arrayPath);
                    } catch (error) {
                        console.warn(
                            `[JsonGenerator] Could not advance the "${arrayPath}" array sequence for ` +
                            `endpoint "${endpointId}" — falling back, so repeated runs may reuse numbers.`,
                            error
                        );
                        return 1 + offset;
                    }
                }
                return 1 + offset;
            }
        };
    }

    /**
     * Unified post-processing for all JSON generation
     * GitHub Issues #142 + #145: Called by ALL generate* methods before returning
     * This ensures A8 variables are processed consistently everywhere
     * GitHub Issue #153: Added sequenceContext parameter for nested array sequence modifiers
     *
     * @param jsonData - The generated JSON data to post-process
     * @param options - JSON generation options
     * @param sequenceManager - Extended sequence manager for A8:sequence handling
     * @param sequenceContext - Optional sequence context for nested array modifiers
     * @returns Post-processed JSON data with A8 variables resolved
     */
    private async postProcessJson(
        jsonData: any,
        options: JsonGenerationOptions,
        sequenceManager: ExtendedSequenceManager,
        sequenceContext?: SequenceContext
    ): Promise<any> {
        // Process A8 variables ({{A8:sequence}}, {{A8:date}}, {{A8:datetime}})
        return await this.processA8VariablesInJson(
            jsonData,
            options.endpointId || 'execution',
            sequenceManager,
            sequenceContext
        );
    }

    /**
     * Process A8 variables in a JSON object (issue#11 fix)
     * GitHub Issue #153: Added sequenceContext parameter for nested array sequence modifiers
     */
    private async processA8VariablesInJson(
        jsonObj: any,
        endpointId: string,
        sequenceManager: ExtendedSequenceManager,
        sequenceContext?: SequenceContext
    ): Promise<any> {
        const jsonString = JSON.stringify(jsonObj);

        // Check if there are A8 variables to process
        if (!jsonString.includes('{{A8:')) {
            return jsonObj;
        }

        // Use template parser to process A8 variables
        // GitHub Issue #153: Pass sequence context for modifier support
        const result = await this.templateParser.processTemplateAsync(
            jsonString,
            {}, // No CSV data needed for A8 variables
            undefined, // No array repetition
            endpointId,
            sequenceManager,
            sequenceContext
        );

        if (result.success && result.processedJson) {
            return JSON.parse(result.processedJson);
        } else {
            return jsonObj; // Return original if processing fails
        }
    }
}
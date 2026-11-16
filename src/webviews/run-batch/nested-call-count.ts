// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch preview: how many API calls a nested template will make.
 *
 * Pure — no vscode, no DOM — so it is unit-tested (nested-call-count.test.ts) and portable.
 * Used by RunBatchWebview.handleGenerateBulkJson for Step 4's "Total API calls", which
 * execution then takes as its pre-calculated total.
 *
 * The rule is JsonGenerator.groupingColumnsFor's: a new group whenever ANY variable at the
 * level changes. This count used to key on the first variable alone, so a template whose
 * first header field is constant — Puppy School Lesson 5: buyerGln is one warehouse on every
 * row — was reported as ONE call while one per supplier was about to go out.
 */

export interface ColumnMappingLike {
    variable: string;
    column?: string | null;
}

export interface NestedAnalysisLike {
    nestingLevel: number;
    outerVariables?: string[];
    middleVariables?: string[];
}

/** ArrayRepetitionHelper.groupRowsByFieldValues: `csvData` includes the header row. */
export type GroupRows = (csvData: string[][], columns: string[]) => string[][][];

/** A level's variables → their mapped source columns, de-duplicated, in template order. */
export function groupingColumnsForPreview(
    variables: string[] | undefined,
    mappings: ColumnMappingLike[] | undefined
): string[] {
    const columns: string[] = [];
    for (const variable of variables ?? []) {
        const column = mappings?.find(m => m.variable === variable)?.column || variable;
        if (!columns.includes(column)) { columns.push(column); }
    }
    return columns;
}

export interface NestedCallCount {
    /** First variable of the grouping level, or '_static' — display only. */
    groupingVariable: string;
    /** Every variable that starts a new group — for "Each X and Y combination…" in Step 4. */
    groupingVariables: string[];
    totalGroups: number;
    totalTransactions: number;
}

/**
 * @param rootVariables Root-level CSV variables above the outer array (2- and 3-level only;
 *                      pass [] otherwise). Each distinct combination is its own set of calls.
 * @param maxGroupsShown Reps: outer groups per request at nesting level 2+.
 */
export function countNestedCalls(args: {
    analysis: NestedAnalysisLike;
    csvData: string[][];
    mappings: ColumnMappingLike[] | undefined;
    rootVariables: string[];
    maxGroupsShown: number;
    groupRows: GroupRows;
}): NestedCallCount {
    const { analysis, csvData, mappings, rootVariables, maxGroupsShown, groupRows } = args;

    // GitHub Issue #134: a static outer wrapper (no variables) groups on the middle level.
    const levelVariables = analysis.outerVariables?.length ? analysis.outerVariables
        : analysis.middleVariables?.length ? analysis.middleVariables
        : [];
    const groupingVariable = levelVariables[0] ?? '_static';
    const columns = groupingColumnsForPreview(levelVariables, mappings);
    const allGroups = columns.length === 0 ? [csvData.slice(1)] : groupRows(csvData, columns);

    const rootGroupCount = analysis.nestingLevel >= 2 && rootVariables.length > 0
        ? groupRows(csvData, groupingColumnsForPreview(rootVariables, mappings)).length
        : 0;

    // GitHub Issue #150: nesting level 1 is one call per group (Reps does not apply); level
    // 2+ packs Reps groups into a call, and root-variable groups each get their own calls
    // (an approximation — generateBatchJsonFiles decides the exact count).
    let totalTransactions: number;
    if (analysis.nestingLevel === 1) {
        totalTransactions = allGroups.length;
    } else if (rootGroupCount > 1) {
        const outerGroupsPerRoot = Math.max(1, Math.ceil(allGroups.length / rootGroupCount));
        totalTransactions = rootGroupCount * Math.ceil(outerGroupsPerRoot / maxGroupsShown);
    } else {
        totalTransactions = Math.ceil(allGroups.length / maxGroupsShown);
    }

    return { groupingVariable, groupingVariables: [...levelVariables], totalGroups: allGroups.length, totalTransactions };
}

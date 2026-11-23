// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's page. Any host: `asset` maps a path under src/webviews to a URL.
 *
 * Compare's stepped layout (#csvBatchContainer, .csv-step) over the design system's footer:
 * Views, Join, Columns, Results. The views sit across the top of every step in Compare's
 * slots, each in its colour, with Add a view. The SQL the clicks write shows on Join and, behind its button, on
 * Results.
 */
import type { AssetUrl } from '../pages';
import { sharedStyleLinks } from '../pages';

const attr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildQueryPage(asset: AssetUrl, config: { queryId: string; name: string }): string {
    const script = (rel: string) => `<script src="${asset(rel)}"></script>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Query: ${attr(config.name)}</title>
    ${sharedStyleLinks(asset, ['atomic', 'core', 'buttons', 'modals', 'tables', 'tabs', 'toast', 'console', 'search', 'data-transformer', 'compare', 'column-drag', 'column-head', 'dbmn-lanes', 'query', 'query-columns', 'dbmn-footer', 'dbmn-table', 'dbmn-name', 'dbmn-functions'])}
</head>
<body class="editor-slide-in">
    <script src="${asset('shared/button-contrast.js')}"></script>
    <script src="${asset('shared/dbmn-actions.js')}"></script>
    <div class="editor-window-controls">
        <button type="button" class="editor-window-btn icon" data-window-action="maximize" data-icon="maximize-2" title="Maximise" aria-label="Maximise"></button>
        <button type="button" class="editor-window-btn icon" data-window-action="close" data-icon="x" title="Close" aria-label="Close"></button>
    </div>

    <div id="csvBatchContainer" class="query-page">
        <!-- The query's name and its views, each in its colour, on every step -->
        <header class="report-toolbar compare-results-tools">
            <!-- Compare's slots, one per view, first: the match table on Join sits on their grid -->
            <!-- The gutter the lines' headings sit in (Request, View, ... on Views; the joins on Join): the same width on every step, so the slots never move -->
            <!-- ...and it holds the query's name (shared/dbmn-name.js): click it to rename, from the first step on -->
            <!-- The slots' row is a row of the grid every step's lines share (dbmn-lanes): the name in its gutter, a lane per view, its runs under one heading -->
            <div id="queryTop" class="dbmn-lanes query-top">
                <div id="queryViews" class="dbmn-lanes-row query-slots" data-line="slots" role="group" aria-label="The views joined">
                    <span id="queryHeadLead" class="dbmn-lanes-gutter query-lead query-head-lead" data-gutter><dbmn-name id="queryName" label="Query name" max="30" value="${attr(config.name)}"></dbmn-name><span id="queryKindLabel" class="query-kind-label" role="status"></span></span>
                </div>
            </div>
            <!-- On their own line under the rows of Views and Join (placeAdds moves them there) -->
            <span id="queryAdds" class="query-adds">
            <button type="button" class="btn btn-secondary" id="queryAddBtn" data-click="query:add">+ Add a view</button>
            <!-- A file is a view too, with a button of its own: a CSV, or a workbook whose sheets are picked next -->
            <button type="button" class="btn btn-secondary" id="queryAddFileBtn" data-click="query:addFile" title="A CSV, or a spreadsheet: each sheet you pick becomes a view, its first row the column names">+ Add a file</button>
            <input type="file" id="queryAddFile" class="hidden" accept=".csv,.tsv,.txt,.xlsx,.xls" aria-label="A CSV or Excel file">
            </span>
            <!-- Results' tools join the views, as Compare's join its slots: find, Distinct, Totals, the SQL, Export. The count of rows is the footer's (its summary): one place -->
            <div id="queryResultsControls" class="compare-results-controls hidden">
                <!-- What the report shows, on the left (James, 2026-11-22): a compare's two switches, then Totals, hidden
                     characters and Filter as full-size icon toggles (the design system's dbmn-toggle: aria-pressed is the state),
                     their words on hover; Distinct when rows repeat. Search, Chain and Export on the right, the gap between growing -->
                <div class="query-view-tools" role="group" aria-label="What the report shows">
                    <!-- A compare's Results, as Compare's (query-compare-results.js): the view and the columns shown -->
                    <span id="queryStatusTools" class="query-status-tools compare-results-controls" hidden>
                        <div class="toggle-group compare-view-toggle" role="group" aria-label="View">
                            <button type="button" class="toggle-btn active" id="queryViewSide" aria-pressed="true" title="A column per result under each compared column">Side by side</button>
                            <button type="button" class="toggle-btn" id="queryViewCompact" aria-pressed="false" title="One column each; values that differ in a pill">Compact</button>
                        </div>
                        <div class="toggle-group compare-view-toggle" role="group" aria-label="Columns shown">
                            <button type="button" class="toggle-btn active" id="queryColsAll" aria-pressed="true" title="Every column">All columns</button>
                            <button type="button" class="toggle-btn" id="queryColsChanged" aria-pressed="false" title="Hide the compared columns no row differs in">Only diffs</button>
                        </div>
                    </span>
                    <button type="button" class="dbmn-toggle" id="queryTotals" aria-pressed="false" data-icon="square-sigma" title="Totals" aria-label="Totals"></button>
                    <!-- As Word's Show/Hide ¶: spaces, tabs, line breaks and blanks marked in every cell, or in none -->
                    <button type="button" class="dbmn-toggle" id="querySpecial" aria-pressed="false" data-icon="pilcrow" title="Show hidden characters" aria-label="Show hidden characters"></button>
                    <!-- Lit while any filter is on; a click clears them all. Dimmed (disabled) with none on -->
                    <button type="button" class="dbmn-toggle" id="queryClearFilters" aria-pressed="false" data-icon="funnel" title="No filters on" aria-label="Clear all filters" disabled></button>
                    <!-- Offered only when rows repeat: it says how many -->
                    <label class="query-row font-size-12 hidden" id="queryDistinctLabel" title="SELECT DISTINCT: rows alike in every column shown fold into one"><input type="checkbox" id="queryDistinct"> <span id="queryDistinctText">Distinct</span></label>
                </div>
                <div id="queryStatusMenu" class="export-dropdown compare-status-menu" role="dialog" aria-label="Filter Status"></div>
                <div id="queryRelationMenu" class="export-dropdown compare-status-menu" role="dialog" aria-label="Filter relationship"></div>
                <div class="search-container">
                    <div class="search-input-wrapper">
                        <svg class="search-icon-inset" width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>
                        <div id="querySearchMirror" class="search-input-mirror" aria-hidden="true"></div>
                        <input type="text" id="querySearch" class="search-input" placeholder="Search rows, or @column=value" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-help="console#search">
                    </div>
                </div>
                <button type="button" id="queryChainBtn" class="export-button" data-click="query:chain" title="Send these rows to another API as its Run Batch input">Chain <span class="inline-icon" data-icon="chevron-right"></span></button>
                <button type="button" class="compare-tool-btn icon" id="queryExportBtn" data-click="query:export" title="Export to Excel" aria-label="Export to Excel" data-icon="download"></button>
            </div>
        </header>
        <!-- The search in words, while a column is asked for: "Reading this as: poDate (date) after 12 Nov 2026" -->
        <p id="queryReads" class="form-hint query-reads hidden" role="status"></p>

        <!-- Step 1: Views: each a saved result, read through one of its endpoint's Views -->
        <div id="queryViewsStep" class="csv-step hidden">
            <section class="execution-section">
                <!-- On the slots' grid, as Join is: a line per thing a view says, each view's under its slot -->
                <div id="queryViewRows" class="dbmn-lanes query-views"></div>
                <div id="queryViewsEmpty" class="query-views-empty"><p class="form-hint">No views yet. Click <strong>+ Add a view</strong> to pick a result, or <strong>+ Add a file</strong> for a CSV or Excel file.</p><div class="query-adds-holder" data-adds="empty"></div></div>
            </section>
        </div>

        <!-- Step 2: Join, on the slots' grid: every line has a cell under each view's slot, so the
             slots are the only headings. A view's rows; then per join its pairs of columns (a wire
             from one view's to the other's), LEFT JOIN or JOIN, and how the rows meet, a count
             under the view it counts. A count is a button: it lists the values it counts. A join's
             stats fold away -->
        <div id="queryJoinStep" class="csv-step hidden">
            <div id="queryJoins" class="dbmn-lanes query-joins"></div>
        </div>

        <!-- Step 3: Columns: every column of every view comes in; untick and order them here -->
        <div id="queryColumnsStep" class="csv-step hidden">
            <!-- On the slots' grid: each view's columns under its slot, ticked to show, each with a value of its own -->
            <!-- Every column taken out: said here, on the step, as Results waits (the step bar carries no reasons) -->
            <dbmn-status id="queryColumnsEmpty" class="query-columns-empty" tone="warn" inline hidden></dbmn-status>
            <div id="queryColumns" class="dbmn-lanes query-cols"></div>
        </div>

        <!-- Step 4: Results -->
        <div id="queryResultsStep" class="csv-step hidden">
            <!-- The design system's table (shared/dbmn-table.js): the rows stay with the host and are asked for as they scroll into view -->
            <!-- New engine: a column where text read as a number wasn't one (left blank) says how many rows -->
            <dbmn-status id="queryNotNumbers" class="query-engine-note hidden" inline tone="warn"></dbmn-status>
            <!-- Results working (a compare worked out, a sort, a search): what, and how far, until its first rows are in -->
            <!-- (the working line lies over the table's top while it works: the table never jumps for it) -->
            <div class="query-results-wrap">
                <dbmn-progress id="queryReading" class="query-engine-note hidden" inline stop></dbmn-progress>
                <dbmn-table id="queryTable" class="query-results" label="Results" removable></dbmn-table>
            </div>
        </div>

        <!-- The design system's footer (shared/dbmn-footer.js): what you can do on the left, how far
             along on the right. The query's name is at the top left (#queryName) -->
        <dbmn-footer>
            <dbmn-actions>
                <button type="button" id="queryBackBtn" class="btn btn-secondary" data-click="query:back" disabled>Back</button>
                <button type="button" id="queryNextBtn" class="btn btn-primary" data-click="query:next" disabled>Next</button>
                <!-- The Join step, once a join has a column: every join back to "Pick a column", after a confirm (a stuck query's way out) -->
            </dbmn-actions>
            <dbmn-steps id="queryStepper" label="Query steps"></dbmn-steps>
        </dbmn-footer>
    </div>

    ${script('shared/search-words.js')}
    ${script('shared/search-matcher.js')}
    ${script('shared/relation-glyph.js')}
    ${script('shared/dbmn-lanes.js')}
    ${script('shared/value-formatter.js')}
    ${script('shared/cell-detail.js')}
    ${script('shared/virtual-window.js')}
    ${script('shared/column-drag.js')}
    ${script('shared/column-head.js')}
    ${script('shared/help-mode.js')}
    ${script('shared/dbmn-modal.js')}
    ${script('shared/dbmn-context-menu.js')}
    ${script('shared/dbmn-toast.js')}
    ${script('shared/dbmn-clipboard.js')}
    ${script('shared/icons.js')}
    ${script('shared/dbmn-footer.js')}
    ${script('shared/dbmn-table.js')}
    ${script('shared/dbmn-name.js')}
    ${script('shared/dbmn-functions.js')}
    ${script('shared/editor-window-controls.js')}
    <!-- The Console's Chain dialog, as it is: Chain here posts the same messages -->
    ${script('console/modules/console-chain.js')}
    <script src="${asset('query/query-columns.js')}"></script>
    <script src="${asset('query/query-search-adds.js')}"></script>
    <script src="${asset('query/query-calc.js')}"></script>
    <script src="${asset('query/query-compare-results.js')}"></script>
    <script src="${asset('query/query-page.js')}" data-query-id="${attr(config.queryId)}"></script>
</body>
</html>`;
}

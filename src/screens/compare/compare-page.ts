// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Compare's page (#298). Any host: `asset` maps a path under src/webviews to a URL.
 *
 * Run Batch's stepped layout (#csvBatchContainer, .csv-step) holding the Console's pieces (the
 * stat cards, .data-table, the find box). The footer is the design system's (shared/dbmn-footer.js):
 * Back and Next, then the steps: Select, Match, Columns, Results. The four slots (BL, C1 to C3)
 * sit across the top of every step, where Results has them, with its toolbar. Work shows on the
 * steps (the step it leads to turns): no progress panel of its own. On Results the steps fold
 * into a summary of what is on screen. The compare's name follows the slots in the top row
 * (dbmn-name): a click renames it.
 */
import type { AssetUrl } from '../pages';
import { sharedStyleLinks } from '../pages';

const attr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildComparePage(asset: AssetUrl, config: { compareId: string; endpointName: string }): string {
    const script = (rel: string) => `<script src="${asset(rel)}"></script>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Compare: ${attr(config.endpointName)}</title>
    ${sharedStyleLinks(asset, ['atomic', 'core', 'buttons', 'modals', 'tables', 'tabs', 'toast', 'console', 'search', 'data-transformer', 'compare', 'column-drag', 'column-head', 'dbmn-footer', 'dbmn-table', 'dbmn-name'])}
</head>
<body class="editor-slide-in" data-endpoint-name="${attr(config.endpointName)}">
    <script src="${asset('shared/button-contrast.js')}"></script>
    <script src="${asset('shared/dbmn-actions.js')}"></script>
    <div class="editor-window-controls">
        <button type="button" class="editor-window-btn icon" data-window-action="maximize" data-icon="maximize-2" title="Maximise" aria-label="Maximise"></button>
        <button type="button" class="editor-window-btn icon" data-window-action="close" data-icon="x" title="Close" aria-label="Close"></button>
    </div>

    <!-- Run Batch's stepped layout: one scrolling step at a time, the step bar in the footer -->
    <div id="csvBatchContainer">

        <!-- The four slots, BL then C1 to C3, at the top of every step: on Select they fill as
             results are picked; on Results each opens a menu (show or hide, make Baseline, open
             in the Console), and the toolbar joins them: the view, the columns shown, clear
             filters, the gear, find, the count and Export (to Excel). In a narrow window the
             toolbar drops to a second line -->
        <div class="report-toolbar compare-results-tools" id="compareTop">
            <div id="compareResultButtons" class="compare-results-bar" role="group" aria-label="The results compared"></div>
            <!-- The compare's name, straight after its slots (shared/dbmn-name.js): a click renames it.
                 Not before them: the match on Match and the grid on Results line up under the slots -->
            <dbmn-name id="compareName" class="compare-name" label="Compare name" max="30" value="${attr(config.endpointName)}"></dbmn-name>
            <!-- A slot's menu, from Match on: make it the Baseline, open it in the Console; on
                 Results also show or hide it -->
            <div id="compareResultMenu" class="export-dropdown compare-baseline-menu" role="menu" aria-label="Result"></div>
            <div id="compareResultsControls" class="compare-results-controls hidden">
                <div class="toggle-group compare-view-toggle" role="group" aria-label="View">
                    <button type="button" class="toggle-btn" id="compareViewSide" data-click="compare:view" data-arg="side" title="A column per result under each column">Side by side</button>
                    <button type="button" class="toggle-btn" id="compareViewCompact" data-click="compare:view" data-arg="compact" title="One column each; values that differ in a pill">Compact</button>
                </div>
                <!-- Diffs hides the compared columns no row differs in, from view only -->
                <div class="toggle-group compare-view-toggle" role="group" aria-label="Columns shown">
                    <button type="button" class="toggle-btn active" id="compareColsAll" data-click="compare:changedOnly" data-arg="all" aria-pressed="true" title="Every column">All columns</button>
                    <button type="button" class="toggle-btn" id="compareColsChanged" data-click="compare:changedOnly" data-arg="changed" aria-pressed="false">Diffs</button>
                </div>
                <!-- Lit while any filter is on (Status, a column's count pill); clears them all -->
                <button type="button" class="compare-tool-btn icon" id="compareClearFilters" data-click="compare:clearFilters" title="No filters on" aria-label="Clear all filters" data-icon="funnel" disabled></button>
                <!-- The gear: which columns are in Compare -->
                <button type="button" class="compare-tool-btn icon" id="compareColumnsBtn" data-click="compare:columnsMenu" title="Columns" aria-label="Columns" aria-haspopup="dialog" aria-expanded="false" data-icon="settings"></button>
                <div class="search-container compare-search" id="compareSearchBox">
                    <button type="button" class="compare-tool-btn icon" id="compareSearchBtn" data-click="compare:searchOpen" title="Search rows" aria-label="Search rows" aria-controls="compareSearch" data-icon="search"></button>
                    <div class="search-input-wrapper">
                        <svg class="search-icon-inset" width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>
                        <div id="compareSearchMirror" class="search-input-mirror" aria-hidden="true"></div>
                        <input type="text" id="compareSearch" class="search-input" placeholder="Search rows, or @column=value" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-help="console#search">
                    </div>
                </div>
                <span class="search-results compare-count" id="compareShown"></span>
                <!-- Export: straight to Excel, the one format a compare report needs -->
                <button type="button" class="compare-tool-btn icon" id="compareExportBtn" data-click="compare:export" title="Export to Excel" aria-label="Export to Excel" data-icon="download"></button>
            </div>
        </div>

        <!-- Step 1: Select — the Baseline and the results to compare with it (shared/compare-picker.js) -->
        <!-- What is being worked out, and how far it has got, while results are read, matched or compared: the
             footer's steps only turn (shared/dbmn-footer.js), so the detail is here, in the screen -->
        <p id="compareWorking" class="compare-working hidden" role="status" aria-live="polite"></p>
        <div id="compareSelectStep" class="csv-step hidden">
            <div class="execution-section">
                <h3>Select</h3>
                <p class="form-hint" id="compareSelectHint"></p>
                <div id="compareSelect" class="compare-picker compare-select"></div>
            </div>
        </div>

        <!-- Step 2: Match — the key columns. The key must pair each record one to one -->
        <div id="compareMatchStep" class="csv-step hidden">
            <div class="compare-match-layout">
                <!-- How BL's records meet each other result's, once checked: on the slots' grid, each
                     kind under BL and its count under the result it is about -->
                <div class="compare-match-panel" data-help="compare#match">
                    <h3 id="compareMatchTitle" class="compare-step-title">How the records match</h3>
                    <div id="compareMatchBody"></div>
                    <div id="compareMatchVerdict" class="compare-match-verdict hidden"></div>
                </div>
                <!-- The key: beside the match in the room the slots leave, under it in a narrow window.
                     The match is checked as the ticks change (a moment after the last) -->
                <div class="compare-key-panel">
                    <h3 class="compare-step-title">Match on</h3>
                    <p class="form-hint" id="compareKeyHint">Tick the columns that identify a record.</p>
                    <div class="table-container compare-key-list">
                        <table class="data-table">
                            <thead><tr><th>Column</th><th>Sample from BL</th></tr></thead>
                            <tbody id="compareKeyColumns"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <!-- Step 3: Columns — the columns to compare (Strict or Relaxed) or only show (Don't compare);
             which rows, a short list, beside them -->
        <div id="compareColumnsStep" class="csv-step hidden">
            <div class="compare-split">
                <div class="execution-section">
                    <h3>Columns</h3>
                    <p class="form-hint">Tick the columns to show in Results. Strict or Relaxed compares a column; Don't compare only shows it. They are the View's, <strong id="compareColumnsView"></strong>.</p>
                    <div class="table-container">
                        <table class="data-table">
                            <thead><tr><th>Show</th><th>Column</th><th>Sample from BL</th><th data-help="compare#compare">Compare</th></tr></thead>
                            <tbody id="compareColumns"></tbody>
                        </table>
                    </div>
                </div>
                <div class="execution-section">
                    <h3>Which rows?</h3>
                    <div class="table-stats">
                        <div class="stat-item">
                            <div class="compare-joins" role="group" aria-label="Which rows" data-help="compare#compare">
                            <button type="button" class="compare-join" data-click="compare:join" data-arg="full" aria-pressed="true">
                                <svg class="compare-venn" viewBox="0 0 92 48" aria-hidden="true"><defs><clipPath id="vennClip-full"><circle cx="34" cy="24" r="20"/></clipPath></defs><circle class="venn-a is-in" cx="34" cy="24" r="20"/><circle class="venn-b is-in" cx="58" cy="24" r="20"/><circle class="venn-both" cx="58" cy="24" r="20" clip-path="url(#vennClip-full)"/></svg>
                                <span class="compare-join-name">Everything</span>
                            </button>
                            <button type="button" class="compare-join" data-click="compare:join" data-arg="left" aria-pressed="false">
                                <svg class="compare-venn" viewBox="0 0 92 48" aria-hidden="true"><defs><clipPath id="vennClip-left"><circle cx="34" cy="24" r="20"/></clipPath></defs><circle class="venn-a is-in" cx="34" cy="24" r="20"/><circle class="venn-b" cx="58" cy="24" r="20"/><circle class="venn-both" cx="58" cy="24" r="20" clip-path="url(#vennClip-left)"/></svg>
                                <span class="compare-join-name" id="compareJoinLeft">All of BL</span>
                            </button>
                            <button type="button" class="compare-join" data-click="compare:join" data-arg="right" aria-pressed="false">
                                <svg class="compare-venn" viewBox="0 0 92 48" aria-hidden="true"><defs><clipPath id="vennClip-right"><circle cx="34" cy="24" r="20"/></clipPath></defs><circle class="venn-a" cx="34" cy="24" r="20"/><circle class="venn-b is-in" cx="58" cy="24" r="20"/><circle class="venn-both" cx="58" cy="24" r="20" clip-path="url(#vennClip-right)"/></svg>
                                <span class="compare-join-name" id="compareJoinRight">All of C1</span>
                            </button>
                            <button type="button" class="compare-join" data-click="compare:join" data-arg="inner" aria-pressed="false">
                                <svg class="compare-venn" viewBox="0 0 92 48" aria-hidden="true"><defs><clipPath id="vennClip-inner"><circle cx="34" cy="24" r="20"/></clipPath></defs><circle class="venn-a" cx="34" cy="24" r="20"/><circle class="venn-b" cx="58" cy="24" r="20"/><circle class="venn-both" cx="58" cy="24" r="20" clip-path="url(#vennClip-inner)"/></svg>
                                <span class="compare-join-name">Matching only</span>
                            </button>
                            </div>
                            <p class="form-hint" id="compareJoinHint"></p>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Step 4: Results: the grid, under the slots and the toolbar -->
        <div id="compareResultsStep" class="csv-step hidden">
            <!-- The gear: which compared columns show -->
            <div id="compareColumnsMenu" class="export-dropdown compare-status-menu" role="dialog" aria-label="Show columns"></div>
            <!-- The Status column's filter, opened from its header (Excel style) -->
            <div id="compareStatusMenu" class="export-dropdown compare-status-menu" role="dialog" aria-label="Filter Status"></div>
            <!-- The Relationship column's filter: Match's pictures, ticked on or off -->
            <div id="compareRelationMenu" class="export-dropdown compare-status-menu" role="dialog" aria-label="Filter relationship"></div>
            <!-- The design system's table (shared/dbmn-table.js): the rows stay with the host and are
                 asked for as they scroll into view; Find is the toolbar's own box -->
            <dbmn-table id="compareGrid" class="compare-grid" label="Results" removable></dbmn-table>
        </div>

        <!-- The design system's footer (shared/dbmn-footer.js): what you can do on the left, how far
             along on the right. The compare's name is its tab's: double-click the tab to rename it.
             Next on Columns compares (its label says so) -->
        <dbmn-footer>
            <dbmn-actions>
                <button type="button" id="compareBackBtn" class="btn btn-secondary" data-click="compare:back" disabled>Back</button>
                <button type="button" id="compareNextBtn" class="btn btn-primary" data-click="compare:next" disabled>Next</button>
            </dbmn-actions>
            <dbmn-steps id="compareStepper" label="Compare steps"></dbmn-steps>
        </dbmn-footer>
    </div>

    ${script('shared/search-matcher.js')}
    ${script('shared/relation-glyph.js')}
    ${script('shared/virtual-window.js')}
    ${script('shared/column-drag.js')}
    ${script('shared/column-head.js')}
    ${script('shared/dbmn-context-menu.js')}
    ${script('shared/compare-picker.js')}
    ${script('shared/help-mode.js')}
    ${script('compare/compare-help.js')}
    ${script('shared/dbmn-modal.js')}
    ${script('shared/dbmn-toast.js')}
    ${script('shared/dbmn-clipboard.js')}
    ${script('shared/value-formatter.js')}
    ${script('shared/cell-detail.js')}
    ${script('shared/dbmn-table.js')}
    ${script('shared/icons.js')}
    ${script('shared/dbmn-footer.js')}
    ${script('shared/dbmn-name.js')}
    ${script('shared/editor-window-controls.js')}
    <script src="${asset('compare/compare-page.js')}" data-compare-id="${attr(config.compareId)}"></script>
</body>
</html>`;
}

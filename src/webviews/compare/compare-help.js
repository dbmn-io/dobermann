// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Compare's help map for help mode (shared/help-mode.js, #298): which control documents where on
 * dbmn.io/docs/compare. One list, as the Console's (console/modules/console-help.js); the step
 * bar's steps carry their own (compare-page.js, STEPS). Every section is a stable anchor in the
 * docs repo's docs/compare.md.
 */
(function () {
    'use strict';
    if (!window.HelpMode) return;
    window.HelpMode.register([
        // Select
        { selector: '#compareSelect .compare-picker-choices', help: 'compare#start' },
        { selector: '#compareSelect .compare-picker-runs', help: 'compare#start' },
        // Match and Compare: the key, the columns
        { selector: '.compare-key-list', help: 'compare#match' },
        { selector: '#compareColumns', help: 'compare#compare' },
        // The slots, at the top of every step; then Results' toolbar
        { selector: '#compareResultButtons', help: 'compare#results' },
        { selector: '.compare-results-tools .compare-view-toggle', help: 'compare#results', first: true },
        { selector: '#compareColsChanged', help: 'compare#results' },
        { selector: '#compareClearFilters', help: 'compare#filters' },
        { selector: '#compareColumnsBtn', help: 'compare#results' },
        { selector: '#compareSearchBox', help: 'console#search' },
        { selector: '#compareExportBtn', help: 'compare#export' },
        // Results: the grid
        { selector: '#compareGrid th.compare-status-head', help: 'compare#filters' },
        { selector: '#compareGrid .compare-col-filter', help: 'compare#filters', first: true },
        { selector: '#compareGrid .dbmn-table-body tr.compare-row', help: 'compare#record', first: true },
        // Footer
        { selector: '#compareBackBtn, #compareNextBtn', help: 'compare#start' }
    ]);
})();

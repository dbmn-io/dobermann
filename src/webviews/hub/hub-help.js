// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Hub's help map for help mode (shared/help-mode.js): which control documents where.
 * The Hub header's help button turns help mode on here and in every tab; each tab brings
 * its own map (console-help.js) or carries data-help in its markup.
 */
(function () {
    'use strict';
    if (!window.HelpMode) return;
    window.HelpMode.register([
        // Header
        { selector: '#hubEnvSelector', help: 'hub#environment-selector' },
        { selector: '#hubActivityChip', help: 'hub#activity-chip' },
        // Rail
        { selector: '.hub-nav-item[data-section="environments"]', help: 'hub#environments' },
        { selector: '.hub-nav-item[data-section="catalogue"]', help: 'hub#endpoints' },
        { selector: '.hub-nav-item[data-section="transactions"]', help: 'hub#history' },
        { selector: '.hub-nav-item[data-section="import"]', help: 'import-export#import' },
        { selector: '.hub-nav-item[data-section="export"]', help: 'import-export#export' },
        { selector: '.hub-nav-item[data-section="account"]', help: 'hub#account' },
        { selector: '.hub-nav-item[data-section="settings"]', help: 'hub#settings' },
        // List panel
        { selector: '#catalogueAddEndpoint', help: 'endpoints' },
        { selector: '#catalogueAddFromClipboard', help: 'sharing-endpoints' },
        { selector: '#catalogueFilterBtn', help: 'hub#endpoints' },
        { selector: '#catalogueBulkUpdate', help: 'hub#endpoints' },
        { selector: '#catalogueBulkExport', help: 'import-export#export' },
        { selector: '#catalogueBulkDelete', help: 'hub#endpoints' },
        { selector: '#transactionsFilterBtn, #transactionsBulkDelete', help: 'hub#history' },
        { selector: '#executeExport', help: 'import-export#export' },
        { selector: '#executeImport, #browseFile', help: 'import-export#import' },
        { selector: '#hubOpenTagManager', help: 'endpoints#tags' },
        { selector: '#hubAddSystem', help: 'hub#systems' },
        { selector: '#openWorkspaceFolder, #changeWorkspaceFolder', help: 'your-data' },
        { selector: '#catalogueSearch', help: 'hub#endpoints' },
        // The add row: Select, Add Endpoint, and Paste (new endpoint from the clipboard)
        { selector: '#catalogueList .hub-add-split-select', help: 'hub#endpoints' },
        { selector: '#catalogueList .hub-add-split-primary', help: 'endpoints' },
        { selector: '#catalogueList .hub-add-split-alt', help: 'sharing-endpoints' },
        // Lists: only the first row on screen is outlined (first: true), never every row
        { selector: '#catalogueList .catalogue-group-header', help: 'hub#endpoints', first: true },
        { selector: '#catalogueList .catalogue-row:not(.tx-row)', help: 'endpoints', first: true },
        { selector: '#catalogueList .catalogue-row-run-api', help: 'run-api', first: true },
        { selector: '#catalogueList .catalogue-row-run-batch', help: 'batch-preparation', first: true },
        { selector: '#hubEnvironmentList .hub-add-split-primary, #hubEnvironmentList .hub-list-row-add', help: 'environments' },
        { selector: '#hubEnvironmentList [data-env-id]', help: 'environments', first: true },
        { selector: '#transactionsSearch, #transactionsSelectMode', help: 'hub#history' },
        { selector: '#transactionsList .catalogue-group-header', help: 'hub#history', first: true },
        { selector: '.tx-row', help: 'hub#history', first: true },
        // Settings
        { selector: '.hub-settings-panel-title', help: 'hub#settings' },
        { selector: '#hubSystemList .hub-system-row', help: 'hub#systems', first: true },
        // Home (no tabs open, Issue #348): its actions document like the controls they reuse
        { selector: '#hubHome [data-home-action="addEndpoint"]', help: 'endpoints' },
        { selector: '#hubHome [data-home-action="addEndpointFromClipboard"]', help: 'sharing-endpoints' },
        { selector: '#hubHome [data-home-action="addEnvironment"]', help: 'environments' },
        { selector: '#hubHome [data-home-action="import"]', help: 'import-export#import' },
        { selector: '#hubHomePuppyBtn', help: 'hub#account' },
        // Tabs
        { selector: '.hub-tab', help: 'hub#tabs' }
    ]);
})();

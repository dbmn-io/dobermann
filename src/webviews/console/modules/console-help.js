// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's help map for help mode (shared/help-mode.js): which control documents where.
 * One list, so a new control gets its docs link here rather than another "?" icon. Every
 * section is a stable anchor on dbmn.io (docs repo CLAUDE.md: "Anchors are an API").
 */
(function () {
    'use strict';
    if (!window.HelpMode) return;
    window.HelpMode.register([
        // Header
        { selector: '#status-badge', help: 'console#execution-summary' },   // not the title row: the help button lives there
        // Tabs
        { selector: '.tab-item[data-tab="links"]', help: 'chain#links-tab' },
        { selector: '.tab-item[data-tab="input"]', help: 'console#input-tab' },
        { selector: '.tab-item[data-tab="raw"]', help: 'console#raw-tab' },
        { selector: '.tab-item[data-tab="success"]', help: 'console#completed-tab' },
        { selector: '.tab-item[data-tab="errors"]', help: 'console#error-tab' },
        { selector: '.tab-item[data-tab="info"]', help: 'console#settings-tab' },
        // Toolbar
        { selector: '#view-path-btn', help: 'named-views#the-views-dropdown' },
        { selector: '#report-toolbar .search-container', help: 'console#search' },
        { selector: '#input-status-filter-wrap', help: 'console#input-status' },
        { selector: '#copy-btn', help: 'console#copy' },
        { selector: '#export-btn', help: 'console#export' },
        { selector: '#chain-btn', help: 'chain' },
        // Raw tab — lists outline their first row on screen only (first: true)
        { selector: '.raw-filter-bar', help: 'console#raw-tab' },
        { selector: '.raw-cards-container .raw-card-header', help: 'console#view-transaction', first: true },
        // Settings tab
        { selector: '#info-configure-section', help: 'console#error-handling' },
        { selector: '#info-tab-content .execution-section:not(#info-configure-section) h3', help: 'console#settings-tab' },
        // Raw tab
        { selector: '#raw-expand-all, #raw-collapse-all', help: 'console#raw-tab' },
        // Table
        { selector: '#console-table thead', help: 'console#sorting' },
        // Links tab
        { selector: '#links-tab-content .execution-section h3', help: 'chain#links-tab' },
        { selector: '#links-tab-content .links-table tbody tr', help: 'chain#differences', first: true },
        // Footer
        { selector: '#rerun-transaction-btn', help: 'console#batch-controls' },
        { selector: '#reprocess-batch-btn', help: 'batch-reprocessing' },
        { selector: '#delete-transaction-btn', help: 'console#execution-history' },
        { selector: '#pause-batch-btn, #resume-batch-btn, #cancel-preparation-btn', help: 'console#batch-controls' },
        { selector: '#pagination-btn, #next-page-btn', help: 'pagination#fetching-pages' },
        // Modals
        { selector: '#views-modal-title', help: 'named-views#the-view-editor' },
        { selector: '#pagination-modal .modal-header h3', help: 'pagination' }
    ]);
})();

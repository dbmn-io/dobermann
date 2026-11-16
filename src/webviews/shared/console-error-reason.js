// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Console error reasons (#428) — why a transaction is on the Error tab, in words.
 *
 * A transaction is an error for one of two kinds of reason, and from the response alone
 * they look nothing alike:
 *
 *   - the server said no (a 4xx / 5xx, or no answer): the response is an error response;
 *   - the server said yes, but the endpoint's own response test failed: the response is a
 *     perfectly good 200, the same shape as the ones on the Completed tab.
 *
 * The second kind used to show a bare ERROR beside a 200, and a user spent a day hunting
 * for what had "flipped" good transactions. So a test failure is named everywhere it is
 * seen: TEST FAILED on its card, a Reason line under the card's header, a Reason column
 * first on the Error tab, and a "Test failed" Status filter on the Raw tab.
 *
 * The saved status stays 'error' — Reprocess, Resume, the error limit and the counts all
 * read it. "Test failed" is the saved test result (`testStatus: 'failed'`) on top of it.
 *
 * Pure — no DOM, no globals — so it loads in the webview (window.ConsoleErrorReason) and
 * in Node for tests (module.exports).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.ConsoleErrorReason = api;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /** The Error tab's Reason column. Not part of any view; the tab always adds it first. */
    const REASON_COLUMN_ID = '__reason';

    function statusOf(tx) {
        return String((tx && (tx.status || (tx.metadata && tx.metadata.status))) || '').toLowerCase();
    }

    function isError(tx) {
        const status = statusOf(tx);
        return status === 'error' || status === 'failed';
    }

    /** An error only because the endpoint's response test failed. */
    function isTestFailure(tx) {
        return isError(tx) && !!tx.metadata && tx.metadata.testStatus === 'failed';
    }

    /**
     * Why this transaction is an error, or '' when it is not one. The saved message first
     * (a failed test's says which test, and why); else the HTTP status; else no answer.
     */
    function reasonFor(tx) {
        if (!isError(tx)) return '';
        const message = tx.metadata && tx.metadata.errorMessage;
        if (message) return String(message);
        const http = tx.httpStatus;
        if (typeof http === 'number' && http >= 400) return `HTTP ${http}`;
        if (http === undefined || http === null || http === '-' || http === 'ERROR' || http === 0) return 'No response';
        return 'Error';
    }

    /**
     * The Error tab's rows and columns with the Reason column first. Each row carries the
     * response it came from (`__response`, from extractRowsForView); rows without one get
     * an empty reason. Returns a new column list; the rows gain the `__reason` value.
     */
    function withReasonColumn(rows, columns) {
        for (const row of rows || []) {
            if (row && typeof row === 'object') row[REASON_COLUMN_ID] = reasonFor(row.__response);
        }
        const reasonColumn = { id: REASON_COLUMN_ID, name: 'Reason', type: 'string', sortable: true, filterable: true, parent: null };
        return [reasonColumn].concat((columns || []).filter(c => !c || c.id !== REASON_COLUMN_ID));
    }

    return { REASON_COLUMN_ID, isError, isTestFailure, reasonFor, withReasonColumn };
}));

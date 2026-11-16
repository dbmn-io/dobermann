// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Which actions an execution offers in a given state — ONE rule set (Issue #314).
 *
 * The Console footer (batch-actions.js) and the History list's right-click menu
 * (transactions.js) both ask this. Lifted verbatim from the footer's
 * updateButtonVisibility so the two can never disagree; change it here only.
 *
 * Loads in the webview (window.ExecutionActions) and in Node (module.exports).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.ExecutionActions = api;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * @param {string|undefined} status  execution status (any case)
     * @param {boolean} isBatch
     * @returns {string[]} action ids: delete, rerun, reprocess, resume, pause, cancel
     */
    function visibleActions(status, isBatch) {
        const phase = String(status || '').toLowerCase();
        const actions = [];

        if (phase === 'cancelled' && isBatch) {
            // #335: a cancelled batch resumes from the next row, making new transactions (its
            // Resume asks about the ones Cancel cut off). Reprocess is for finished batches.
            actions.push('resume', 'delete');
        } else if (phase === 'completed' || phase === 'error' || phase === 'cancelled' || !phase) {
            actions.push('delete');
            actions.push(isBatch ? 'reprocess' : 'rerun');
        } else if (phase === 'preparing' || phase === 'queued' || phase === 'pending') {
            actions.push('cancel', 'delete');
        } else if (phase === 'executing' || phase === 'running') {
            // #335: Pause lets the requests in flight finish; Cancel aborts them (batch and single)
            if (isBatch) actions.push('pause');
            actions.push('cancel');
        } else if (phase === 'paused' || phase === 'stopped') {
            // #335: still live (it waits to resume): Cancel takes it off the active list (it can
            // still be resumed), keeping its results; Delete removes it
            actions.push('resume', 'cancel', 'delete');
        }
        return actions;
    }

    /** Labels and icons the menu shows for each action (the footer has its own buttons). */
    const LABELS = {
        resume:    { label: 'Resume',     icon: 'play' },
        pause:     { label: 'Pause',      icon: 'pause' },
        cancel:    { label: 'Cancel',     icon: 'square' },
        rerun:     { label: 'Re-run',     icon: 'refresh-cw' },
        reprocess: { label: 'Reprocess…', icon: 'refresh-cw' },
        delete:    { label: 'Delete',     icon: 'trash-2', danger: true }
    };

    return { visibleActions, LABELS };
}));

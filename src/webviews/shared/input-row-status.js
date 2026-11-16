// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #304: the status of each input row — the status of the transaction
 * that sent it. Shared by the Console's Input tab (webview) and its export
 * (host), so the table and the exported file always agree.
 *
 * A row can belong to more than one transaction (a failed request split into
 * smaller ones): the smallest transaction covering it wins — it is the row's
 * latest outcome. Rows no transaction covers yet are Not processed.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.InputRowStatus = api;
})(this, function () {
    'use strict';

    /** Filter values, in dropdown order ('all' is the unfiltered view). */
    const STATUSES = ['completed', 'error', 'running', 'cancelled', 'not_processed'];

    const LABELS = {
        all: 'All',
        completed: 'Completed',
        error: 'Error',
        running: 'Running',
        cancelled: 'Cancelled',
        not_processed: 'Not processed'
    };

    /** A transaction status as one of STATUSES. Pending, split or unknown → not_processed. */
    function normalize(status) {
        const s = String(status || '').toLowerCase().trim();
        if (s === 'completed' || s === 'complete' || s === 'success') return 'completed';
        if (s === 'error' || s === 'failed' || s === 'failure') return 'error';
        if (s === 'running' || s === 'executing' || s === 'processing') return 'running';
        if (s === 'cancelled' || s === 'canceled') return 'cancelled'; // #335: cut off in flight
        return 'not_processed';
    }

    /**
     * @param {number} rowCount - number of input rows
     * @param {Array<{ key: *, rowStart: number|string, rows: number|string, status: string }>} transactions
     *        rowStart is 1-based; rows is the count of input rows the transaction sent
     * @returns {{ status: string[], owner: Array<*> }} per row: its status and its transaction's key (or null)
     */
    function rowStatuses(rowCount, transactions) {
        const status = new Array(rowCount).fill('not_processed');
        const owner = new Array(rowCount).fill(null);
        const size = new Array(rowCount).fill(Infinity);
        for (const tx of transactions || []) {
            const start = parseInt(tx && tx.rowStart, 10);
            const count = parseInt(tx && tx.rows, 10);
            if (!(start >= 1) || !(count >= 1)) continue;
            const end = Math.min(rowCount, start - 1 + count);
            for (let i = start - 1; i < end; i++) {
                if (count < size[i]) {
                    size[i] = count;
                    status[i] = normalize(tx.status);
                    owner[i] = tx.key;
                }
            }
        }
        return { status, owner };
    }

    /** Row count per status, plus 'all'. */
    function counts(statusList) {
        const out = { all: statusList.length };
        STATUSES.forEach(s => { out[s] = 0; });
        statusList.forEach(s => { out[s]++; });
        return out;
    }

    /**
     * Column id for the row's outcome — "Result", or "DBMN Result" when the
     * input already has a result column in any case (a file's own `status`
     * beside our `Status` read as the same thing, so neither is used).
     */
    function columnId(sampleRow) {
        const keys = sampleRow && typeof sampleRow === 'object' ? Object.keys(sampleRow) : [];
        return keys.some(k => k.toLowerCase() === 'result') ? 'DBMN Result' : 'Result';
    }

    /**
     * Input rows with the Result column added, filtered to one status.
     * Returns new objects; the input rows are not changed.
     * @returns {{ records: Object[], indices: number[] }} indices = each record's input row index
     */
    function annotate(inputData, statusList, filter, colId) {
        const records = [];
        const indices = [];
        for (let i = 0; i < inputData.length; i++) {
            const st = statusList[i] || 'not_processed';
            if (filter && filter !== 'all' && st !== filter) continue;
            const row = inputData[i];
            records.push(Object.assign({ [colId]: LABELS[st] }, row));
            indices.push(i);
        }
        return { records, indices };
    }

    return { STATUSES, LABELS, normalize, rowStatuses, counts, columnId, annotate };
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Console live counts — the bookkeeping behind the Completed / Error tab numbers while a
 * batch is running.
 *
 * The Console does not get its tab counts from the host. It keeps a running tally as each
 * member's result arrives, and a map from executionId to that member's position in
 * `rawData.responses` so a retry can find and replace its row in O(1). Three things must
 * therefore ALWAYS agree: the responses array, the index map, and the two tallies.
 *
 * They used to be kept in step by hand, inline in console.html, and one path forgot. When a
 * user resumed a batch and chose to retry its failures, the `clear_errors` handler removed
 * the failed rows and painted "0" on the Error tab — but left the error tally at its old
 * value and the index map pointing at positions that had all just shifted. The first retried
 * row to report in repainted the badge from the stale tally (64 errors, an empty table), and
 * the stale positions meant the tally could never come down. It only came right when the
 * batch finished and the Console reloaded from disk.
 *
 * So: every operation here returns the array, the map and the tallies TOGETHER, rebuilt from
 * the same rows. Pure — no DOM, no globals — so it loads in the webview (window.ConsoleLiveCounts)
 * and in Node for tests (module.exports).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.ConsoleLiveCounts = api;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function executionIdOf(response) {
        return response && response.metadata ? response.metadata.executionId : undefined;
    }

    /**
     * Which tally a single row belongs to, for adjusting the tallies when a row is replaced.
     * 'unknown' covers pending / running / split: counted in neither tab.
     */
    function classifyResult(result) {
        if (!result) return 'unknown';
        const status = result.status || (result.metadata && result.metadata.status) || '';
        const s = String(status).toLowerCase();
        if (s === 'completed' || s === 'complete' || s === 'success' || s === 'ok') return 'success';
        if (s === 'error' || s === 'failed' || s === 'fail' || s === 'failure') return 'errors';
        return 'unknown';
    }

    /** executionId → position in `responses`. */
    function buildIndexMap(responses) {
        const map = new Map();
        (responses || []).forEach(function (response, index) {
            const id = executionIdOf(response);
            if (id !== undefined && id !== null) map.set(id, index);
        });
        return map;
    }

    /**
     * Everything derived from a set of rows, rebuilt together.
     * `classifyResponses` is the Console's own classifier (console-table-builder.js) — passed
     * in so the tab contents and the tab counts can never disagree about what an error is.
     */
    function seed(responses, classifyResponses) {
        const rows = responses || [];
        const classified = classifyResponses(rows);
        return {
            responses: rows,
            classified: classified,
            indexMap: buildIndexMap(rows),
            liveSuccess: (classified.success || []).length,
            liveErrors: (classified.errors || []).length
        };
    }

    /**
     * The user chose to retry the failures of a batch: take the failed rows out of the table
     * (they come back, one by one, as they are re-run) and rebuild EVERYTHING from what is
     * left. "Failed" means exactly what the Error tab shows — the rows `classifyResponses`
     * files under errors — so a completed row is never dropped for having an odd httpStatus,
     * and a member still waiting its turn keeps its row and its position.
     */
    function clearErrors(responses, classifyResponses) {
        const rows = responses || [];
        const failed = new Set(classifyResponses(rows).errors || []);
        return seed(rows.filter(function (row) { return !failed.has(row); }), classifyResponses);
    }

    /**
     * GitHub Issue #312: a chunk of a large batch has arrived (the Console opens on the
     * first chunk and the host streams the rest). Merge it in and rebuild everything from
     * the merged rows. A chunk row whose execution already has a row — a live result that
     * landed while the stream was still running — REPLACES that row rather than doubling it.
     */
    function append(responses, incoming, classifyResponses) {
        const rows = (responses || []).slice();
        const positions = buildIndexMap(rows);
        (incoming || []).forEach(function (row) {
            const id = executionIdOf(row);
            const at = (id !== undefined && id !== null) ? positions.get(id) : undefined;
            if (at !== undefined) {
                rows[at] = row;
            } else {
                if (id !== undefined && id !== null) positions.set(id, rows.length);
                rows.push(row);
            }
        });
        return seed(rows, classifyResponses);
    }

    /**
     * Where is this execution's row? -1 if it has none.
     * A position is only trusted if the row there really is that execution's. Anything else
     * is a stale entry: it is dropped and treated as "no row yet", so an update can never
     * land on — or take its tally from — somebody else's row.
     */
    function resolveIndex(indexMap, responses, executionId) {
        if (executionId === undefined || executionId === null || !indexMap.has(executionId)) return -1;
        const index = indexMap.get(executionId);
        const row = (responses || [])[index];
        if (row && executionIdOf(row) === executionId) return index;
        indexMap.delete(executionId);
        return -1;
    }

    return { classifyResult, buildIndexMap, seed, clearErrors, append, resolveIndex };
}));

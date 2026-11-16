// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* DBMN Hub — Activity chip + drawer
 *
 * Header-right "activity surface" from the design doc. Shows the running
 * count + idle/active state at a glance; clicking opens a drawer with
 * Running / Queued / Recent sections.
 *
 * Data source: subscribes to `hubState.transactions` (already streamed
 * by the host) and re-derives the running/queued/recent partition each
 * time. Clicking a row posts `openTransaction` so the Console tab opens.
 */
(function () {
    'use strict';

/** @typedef {{running: any[], queued: any[], paused: any[], recent: any[]}} ActivityView */

// Live progress overlay keyed by executionId. The batch engine keeps
// per-member progress in-memory (no per-transaction record write), so
// the drawer's tx.preparationState + completedExecutions calculation
// stays at 0 until the run finishes. The hub.js setTabStatus handler
// calls `applyLiveProgress` to feed in-flight progress here so the
// drawer's bar ticks during a run.
const liveProgress = new Map();

    function partition(transactions) {
        const txs = Array.isArray(transactions) ? transactions.slice() : [];
        const running = [];
        const queued = [];
        const paused = [];
        const recent = [];
        // Newest first.
        txs.sort((a, b) => {
            const at = new Date(a.createdAt || a.startedAt || 0).getTime();
            const bt = new Date(b.createdAt || b.startedAt || 0).getTime();
            return bt - at;
        });
        for (const t of txs) {
            const status = String(t.status || '').toLowerCase();
            if (status === 'running') {
                running.push(t);
            } else if (status === 'queued' || status === 'pending') {
                queued.push(t);
            } else if (status === 'paused') {
                // Issue #265: not running, so not in Running. Issue #313: but
                // actionable (Resume), unlike finished work — listed after the
                // queue, newest five only (there is no "stopped" state to age
                // them out, so paused batches can pile up over months).
                if (paused.length < 5) paused.push(t);
            } else {
                if (recent.length < 5) recent.push(t);
            }
        }
        return { running, queued, paused, recent };
    }

    function renderChip(chip, label, view) {
        if (!chip || !label) return;
        const r = view.running.length;
        const q = view.queued.length;
        // Only flag failure when the MOST RECENT completed transaction
        // failed — `view.recent` is sorted newest-first. The previous
        // `.some()` rule kept the chip red for hours after a single
        // failure, even when subsequent runs succeeded. `stopped` is a
        // user-cancelled state, not a failure.
        const mostRecent = view.recent[0];
        const recentFailed = mostRecent && /^(failed|error)$/i.test(String(mostRecent.status || ''));

        const p = view.paused.length;
        chip.classList.remove('is-idle', 'is-running', 'is-failed', 'is-paused');
        if (r > 0) {
            chip.classList.add('is-running');
            label.textContent = q > 0 ? `${r} running · ${q} queued` : `${r} running`;
        } else if (p > 0) {
            // Issue #313: nothing runs, but something waits for the user
            chip.classList.add('is-paused');
            label.textContent = `${p} paused`;
        } else if (recentFailed) {
            chip.classList.add('is-failed');
            label.textContent = 'Recent failure';
        } else {
            chip.classList.add('is-idle');
            label.textContent = 'Idle';
        }
    }

    function rowFor(tx, opts) {
        const status = String(tx.status || '').toLowerCase();
        const spec = window.Icons?.statusIcon?.(tx.status) || { icon: 'clock', bucket: 'pending' };
        const row = document.createElement('div');
        row.className = 'hub-activity-row is-' + status;
        row.dataset.txId = tx.id || tx.executionId || '';
        // Hub state transactions carry `executionType`, not `isBatch`/`type`.
        // The wrong fields here made every batch open as an individual via
        // the drawer — `hub-manager.openConsoleTab(id, false)` → individual
        // report config → empty responses → Console showed only Settings.
        row.dataset.isBatch = tx.executionType === 'batch' ? 'true' : 'false';

        const ic = document.createElement('span');
        ic.className = 'icon';
        ic.setAttribute('data-icon', spec.icon);
        ic.setAttribute('data-bucket', spec.bucket);
        row.appendChild(ic);

        const name = document.createElement('span');
        name.className = 'hub-activity-row-name';
        name.textContent = tx.endpointName || tx.name || tx.id || 'Transaction';
        row.appendChild(name);

        if (opts && opts.kind === 'running') {
            // Three sources of progress, checked in order:
            //   1. Live overlay populated by setTabStatus (in-flight,
            //      per-member from the engine — most accurate during a run).
            //   2. tx.progress — a 0-100 number some execution paths set.
            //   3. preparationState + batchResumptionData fallback — only
            //      complete on persisted records.
            let pct = null;
            const live = liveProgress.get(tx.id);
            if (live && live.total > 0) {
                pct = Math.round((live.done / live.total) * 100);
            } else if (typeof tx.progress === 'number') {
                pct = tx.progress;
            } else if (tx.executionType === 'batch') {
                const total = tx.preparationState?.totalTransactions
                    || tx.preparationState?.totalRows
                    || 0;
                const r = tx.batchResumptionData;
                const done = (r?.completedExecutions?.length || 0)
                    + (r?.failedExecutions?.length || 0)
                    + (r?.skippedExecutions?.length || 0);
                if (total > 0) pct = Math.round((done / total) * 100);
            }
            if (pct != null) {
                const bar = document.createElement('span');
                bar.className = 'hub-activity-bar';
                const clamped = Math.max(0, Math.min(100, pct));
                bar.innerHTML = `<i style="width:${clamped}%"></i>`;
                row.appendChild(bar);
            }
        } else if (opts && opts.kind === 'queued') {
            const meta = document.createElement('span');
            meta.className = 'hub-activity-row-meta';
            meta.textContent = `#${opts.position}`;
            row.appendChild(meta);
        } else {
            const meta = document.createElement('span');
            meta.className = 'hub-activity-row-meta';
            const created = tx.createdAt || tx.completedAt || tx.startedAt;
            meta.textContent = created ? new Date(created).toLocaleTimeString() : '';
            row.appendChild(meta);
        }

        return row;
    }

    function renderDrawer(drawer, view) {
        if (!drawer) return;
        drawer.innerHTML = '';
        let appended = 0;

        if (view.running.length) {
            const t = document.createElement('span');
            t.className = 'hub-activity-section-title';
            t.textContent = 'Running';
            drawer.appendChild(t);
            view.running.forEach(tx => drawer.appendChild(rowFor(tx, { kind: 'running' })));
            appended += view.running.length;
        }

        if (view.queued.length) {
            const t = document.createElement('span');
            t.className = 'hub-activity-section-title';
            t.textContent = 'Queued';
            drawer.appendChild(t);
            view.queued.forEach((tx, i) => drawer.appendChild(rowFor(tx, { kind: 'queued', position: i + 1 })));
            appended += view.queued.length;
        }

        // Issue #313: paused batches follow the queue — no section of their own,
        // the PAUSED icon says what they are — above the Recent divider.
        if (view.paused.length) {
            view.paused.forEach(tx => drawer.appendChild(rowFor(tx, { kind: 'paused' })));
            appended += view.paused.length;
        }

        if (appended > 0 && view.recent.length) {
            const div = document.createElement('div');
            div.className = 'hub-activity-divider';
            drawer.appendChild(div);
        }

        if (view.recent.length) {
            const t = document.createElement('span');
            t.className = 'hub-activity-section-title';
            t.textContent = 'Recent';
            drawer.appendChild(t);
            view.recent.forEach(tx => drawer.appendChild(rowFor(tx, { kind: 'recent' })));
            appended += view.recent.length;
        }

        if (appended === 0) {
            const empty = document.createElement('div');
            empty.className = 'hub-activity-empty';
            empty.textContent = 'No activity yet';
            drawer.appendChild(empty);
        }

        if (window.Icons) window.Icons.injectIcons(drawer);
    }

    function init(options) {
        const chip = document.getElementById('hubActivityChip');
        const label = document.getElementById('hubActivityLabel');
        const drawer = document.getElementById('hubActivityDrawer');
        if (!chip || !drawer) return;

        const getState = options.getState;
        const postMessage = options.postMessage;

        let lastView = { running: [], queued: [], paused: [], recent: [] };

        function rebuild() {
            const state = getState() || {};
            lastView = partition(state.transactions || []);
            renderChip(chip, label, lastView);
            if (!drawer.classList.contains('hidden')) renderDrawer(drawer, lastView);
        }

        function closeDrawer() {
            drawer.classList.add('hidden');
            chip.classList.remove('is-active');
            chip.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', outsideClose);
            window.removeEventListener('blur', closeDrawer);
        }

        chip.addEventListener('click', () => {
            const isOpen = !drawer.classList.contains('hidden');
            if (isOpen) {
                closeDrawer();
            } else {
                renderDrawer(drawer, lastView);
                drawer.classList.remove('hidden');
                chip.classList.add('is-active');
                chip.setAttribute('aria-expanded', 'true');
                setTimeout(() => {
                    document.addEventListener('mousedown', outsideClose);
                    // Iframes swallow document-level clicks (cross-document
                    // event boundary), so a click into a tab body never
                    // triggers `outsideClose`. Window blur is the proxy:
                    // when the Hub window loses focus (because an iframe
                    // got it), close the drawer.
                    window.addEventListener('blur', closeDrawer);
                }, 0);
            }
        });

        function outsideClose(e) {
            if (drawer.contains(e.target) || chip.contains(e.target)) return;
            closeDrawer();
        }

        // Row click → open Console tab for that transaction.
        drawer.addEventListener('click', (e) => {
            const row = e.target.closest('.hub-activity-row');
            if (!row) return;
            const id = row.dataset.txId;
            if (!id) return;
            postMessage({
                type: 'openTransaction',
                id,
                isBatch: row.dataset.isBatch === 'true'
            });
            drawer.classList.add('hidden');
            chip.classList.remove('is-active');
        });

        function applyLiveProgress(executionId, progress) {
            if (!executionId || !progress) return;
            const done = Number(progress.done);
            const total = Number(progress.total);
            if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return;
            const prev = liveProgress.get(executionId);
            if (prev && prev.done === done && prev.total === total) return;
            liveProgress.set(executionId, { done, total });
            // Drop entries once the run is over so the overlay doesn't leak
            // across reuses of the same execution id (rare but possible).
            if (done >= total) {
                setTimeout(() => liveProgress.delete(executionId), 5000);
            }
            // Re-render only if the drawer is open — chip stays the same
            // (it's a count, not a percentage).
            if (!drawer.classList.contains('hidden')) {
                renderDrawer(drawer, lastView);
            }
        }

        window.HubActivity = {
            update: rebuild,
            rebuild,
            applyLiveProgress
        };

        rebuild();
    }

    window.HubActivity = { init };
})();

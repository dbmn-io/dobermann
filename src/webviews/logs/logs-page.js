// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Logs screen's script (src/screens/logs): passes lines from the controller to the log list,
 * and the footer's buttons (Refresh, Copy, Save), the search and scrolling back to the
 * controller. Not live: Refresh reads the lines again. No rules of its own:
 * the controller searches every line kept; the list filters what it holds the same way meanwhile.
 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const log = $('logsList');
    const status = $('logsStatus');
    const searching = $('logsSearching');
    const count = n => Number(n || 0).toLocaleString();
    /** What the controller has said about the lines: all of them here, or more further back. */
    const ui = { done: false, shown: undefined };

    /** Right of the footer: how many lines, nothing more (how long logs are kept is a setting, and the docs say it). */
    function tell() {
        const detail = ui.shown || { shown: 0, total: 0 };
        const lines = n => `${count(n)} line${n === 1 ? '' : 's'}`;
        status.textContent = log.search.trim() ? `${lines(detail.shown)} found` : lines(detail.total);
    }
    log.addEventListener('dbmn-log-shown', event => { ui.shown = event.detail; tell(); });

    /** While the controller looks through the lines kept: how far back it has got, in place of the count. */
    function looking(on, back, value) {
        searching.hidden = !on;
        status.hidden = on;
        // (and where the eye is: the search box's glass spins)
        log.busy = on;
        if (!on) return;
        searching.setAttribute('value', String(value || 0));
        if (back) {
            const d = new Date(`${back}T12:00:00`);
            searching.setAttribute('count', `back to ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
        } else searching.removeAttribute('count');
    }

    // The ★'s saved searches: kept by the controller (James, 2026-11-23: "everywhere where we have a search box")
    log.addEventListener('dbmn-saved-change', event => vscode.postMessage({ type: 'logs.saveSearches', searches: event.detail.searches }));

    // A request's line clicked: the controller reads its run log
    log.addEventListener('dbmn-log-open', event => vscode.postMessage({ type: 'logs.open', open: event.detail.open, key: event.detail.key }));

    // Scrolled down to the oldest line here: the ones before it
    log.addEventListener('dbmn-log-end', () => { if (!ui.done) vscode.postMessage({ type: 'logs.older' }); });

    // The search reaches every line kept: the controller searches, a moment after typing stops.
    // Every key first stops a search still looking, so typing is never held up by one
    let searchTimer;
    log.addEventListener('input', () => {
        vscode.postMessage({ type: 'logs.typing' });
        looking(true);
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => vscode.postMessage({ type: 'logs.search', text: log.search }), 350);
    });

    /** The lines shown, as they show: a request's body is never among them. */
    function copy() {
        const text = log.text();
        if (!text) { if (window.DbmnToast) window.DbmnToast.info('No lines to copy.'); return; }
        window.DbmnClipboard.writeText(text).then(ok => {
            if (!window.DbmnToast) return;
            const lines = text.split('\n').filter(l => !l.startsWith('    ')).length;
            if (ok) window.DbmnToast.success(`Copied ${count(lines)} line${lines === 1 ? '' : 's'}`);
            else window.DbmnToast.error('Could not copy the lines.');
        });
    }

    window.DbmnActions.register({
        // Not live: the lines are read again when asked, as the search box has them now
        'logs:refresh': () => vscode.postMessage({ type: 'logs.refresh', text: log.search }),
        'logs:copy': copy,
        'logs:save': () => vscode.postMessage({ type: 'logs.save' })
    });

    window.addEventListener('message', event => {
        const m = event.data || {};
        switch (m.type) {
            case 'logs.searching': looking(true, m.back, m.value); break;
            case 'logs.lines':
                looking(false);
                ui.done = !!m.done;
                if (typeof m.search === 'string' && m.search) log.search = m.search;
                log.lines = m.lines || [];
                tell();
                break;
            case 'logs.older':
                looking(false);
                ui.done = !!m.done;
                log.older(m.lines || []);
                if (!(m.lines || []).length) log.askAgain();
                tell();
                break;
            case 'logs.searchFor': log.search = m.text || ''; break;
            case 'logs.searches': log.savedSearches = m.searches || []; break;
            case 'logs.opened': if (window.CellDetail) window.CellDetail.open(m.text || '', { title: 'The request' }); break;
        }
    });

    if (window.Icons) window.Icons.injectIcons();
    vscode.postMessage({ type: 'logs.ready' });
})();

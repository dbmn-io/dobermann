// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #470: Run Batch's one Execute confirmation. Execute on Review asks the host what it will send
 * (runBatch.executeAsk → runBatch.executeConfirm { summary }: execute-summary.ts), and this window says it in plain
 * words: N rows as M requests to <environment> with its header values, the URL; Error handling and Threads to
 * choose; on production the shared guard's line and Warning frequency (<dbmn-guard-line>), folded in, no second
 * window. Its one button says Execute. The choices go back with the run (executeBulkLoadCommand.confirm).
 *
 *   window.RunBatchConfirm.send(executionMessage, post)   // in place of post(executionMessage)
 *
 * Cancel, Escape, a header prompt cancelled or an answer with an error: no run, Execute comes back.
 */
(function () {
    'use strict';
    let pending = null;

    const make = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
    /** Execute comes back (its "Processing…" spin stops): the page's own handler for the host's message. */
    const resetExecute = () => window.postMessage({ type: 'resetExecuteButton' }, '*');

    /** What Review chose already (its Error Handling and Threads), when the window offers it. */
    function reviewChoice(summary) {
        const mode = document.getElementById('batchErrorModeSelect');
        const threads = document.getElementById('processingModeDropdown');
        const t = threads ? parseInt(threads.value, 10) : NaN;
        return {
            errorHandling: mode ? (mode.value === 'stopOnFirst' ? 'stop' : 'continue') : summary.errorHandling.value,
            threads: summary.threads.options.includes(t) ? t : summary.threads.value
        };
    }

    function show(summary) {
        const body = make('div', 'run-batch-confirm');
        body.appendChild(make('p', 'run-batch-confirm-sentence', summary.sentence));
        let line = null;
        if (summary.guard) {
            line = document.createElement('dbmn-guard-line');
            line.guard = summary.guard;
            body.appendChild(line);
        }
        const chosen = reviewChoice(summary);
        return window.DbmnModal.show({
            title: 'Execute',
            body,
            fields: [
                { id: 'errorHandling', type: 'radio', label: 'Error handling', value: chosen.errorHandling, options: summary.errorHandling.options },
                { id: 'threads', type: 'select', label: 'Threads', value: String(chosen.threads), options: summary.threads.options.map(n => ({ value: String(n), label: n === 1 ? '1 (one at a time)' : String(n) })) }
            ],
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'execute', label: 'Execute', variant: summary.guard ? 'danger' : 'primary' }
            ],
            dismissible: true,
            size: 'sm'
        }).then(result => {
            if (!result || result.actionId !== 'execute') return null;
            const fields = result.fields || {};
            const confirm = { errorHandling: fields.errorHandling === 'stop' ? 'stop' : 'continue', threads: parseInt(fields.threads, 10) || 1 };
            // (the guard's answer, only when it asked: its Warning frequency in minutes)
            if (line && line.minutes !== null && line.minutes !== undefined) confirm.production = { minutes: line.minutes };
            return confirm;
        });
    }

    function send(message, post) {
        if (!window.DbmnModal || !window.DbmnModal.show) { post(message); return; }
        pending = { message, post };
        // (the host plans the run as it will be sent, from the endpoint as saved: the window's count is that, never a
        // figure read off the page, which can be a step behind a Rows per request just changed)
        post({ type: 'runBatch.executeAsk' });
    }

    window.addEventListener('message', event => {
        const m = event.data || {};
        if (m.type === 'resetExecuteButton') { pending = null; return; }
        if (m.type !== 'runBatch.executeConfirm' || !pending) return;
        const { message, post } = pending;
        pending = null;
        if (m.error || !m.summary) {
            resetExecute();
            if (window.DbmnModal && window.DbmnModal.alert) window.DbmnModal.alert({ title: 'Not run', body: m.error || 'Nothing to run yet.' });
            return;
        }
        show(m.summary).then(confirm => {
            if (!confirm) { resetExecute(); return; }
            post(Object.assign({}, message, { confirm }));
        }, () => resetExecute());
    });

    window.RunBatchConfirm = { send };
})();

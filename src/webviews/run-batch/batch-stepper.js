// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch's steps: Source, Map, Validate, Review (#435: Review ends with Execute, no step of
 * its own), in the footer. This file says what each step is; the design system's <dbmn-steps>
 * (shared/dbmn-footer.js) draws it.
 *
 * Shows where you are, what each step decided ("replenishment.csv · 295 rows", "6 of 6 mapped",
 * "3 API calls": its hover text), and the walk forward after Import Data (dt-auto-advance.js) as
 * it ticks each step off. While a file is read or rows are checked the step turns, and how far
 * it has got is said in the screen (#batchWorking).
 *
 * Every step reached is clickable: back is a jump (CSVHandler.goToStep → goBackTo), forward
 * walks through each step's own checks (DTAutoAdvance.walkTo), so nothing skips a check.
 * A later step is clickable only when nothing before it needs the user; one that waits says
 * what it waits for. The bar only reads state — it never decides a step itself.
 */
(function () {
    'use strict';

    const STEPS = [
        { label: 'Source', help: 'batch-preparation#step-1-load-data' },
        { label: 'Map', help: 'batch-preparation#step-2-map-transform' },
        { label: 'Validate', help: 'batch-preparation#step-3-review-edit-data' },
        { label: 'Review', help: 'batch-preparation#step-4-review-json' }
    ];
    function handler() { return window.CSVHandler; }
    function state() { const h = handler(); return h && (h.csvState || (h.getState && h.getState())); }
    function walk() { return window.DTAutoAdvance && window.DTAutoAdvance.status ? window.DTAutoAdvance.status() : { walking: false, checkingStep: null }; }
    function chained() { return !!(window.ChainPreload && window.ChainPreload.isChained && window.ChainPreload.isChained()); }
    function plural(n, one, many) { return `${n.toLocaleString()} ${n === 1 ? one : many}`; }
    function textOf(id) { const el = document.getElementById(id); return el ? el.textContent.trim() : ''; }

    function rowCount(s) {
        const parsed = s.currentParsedData;
        return (parsed && (parsed.totalRows || (parsed.rows && parsed.rows.length)))
            || (window.currentParsedCsvData && window.currentParsedCsvData.length)
            || (s.gridDataModel && s.gridDataModel.length) || 0;
    }

    function unmappedCount(s) {
        const h = handler();
        if (!h || !h.getVariablesThatNeedMapping || !s.templateVariables || s.templateVariables.length === 0) return 0;
        return h.getVariablesThatNeedMapping().filter(v => !v.mappedTo).length;
    }

    function errorRowCount(s) { return s.gridErrorRows ? s.gridErrorRows.size : 0; }

    /**
     * What stops the walk at step n, if anything. Amber, like the footer notification and the
     * highlighted cells: 'warn' for unmapped variables (Map) and for rows to fix (Validate).
     */
    function issueAt(n, s) {
        const reached = s.maxStepReached || 1;
        if (n === 2 && reached >= 2 && !s.dataEntryMode && unmappedCount(s) > 0) return 'warn';
        if (n === 3 && errorRowCount(s) > 0) return 'warn';
        return null;
    }

    /** Work still going (reading a file, checking rows). At 100% it is done: its "Complete" is cleared a second later by
     *  whoever set it, and in that second it showed on the next step (a stray "Complete" above the footer on Review and
     *  Validate still turning: the tester, 2026-11-25). Done work is shown nowhere. */
    function live(s) { const p = s.stepProgress; return p && !(p.percent >= 100) ? p : null; }

    function summaryOf(n, s, status) {
        // #435: reading a file or checking rows says how far it has got here, in the step
        const going = live(s);
        if (going && n === going.step && going.text) return going.text;
        const reached = s.maxStepReached || 1;
        const rows = rowCount(s);
        if (n === 1) {
            if (!s.currentHeaders || s.currentHeaders.length === 0) return '';
            const origin = s.originalSourceType || s.sourceType;
            const name = chained() ? ((window.ChainPreload.sourceLabel && window.ChainPreload.sourceLabel()) || 'Chained rows')
                : origin === 'paste' ? 'Pasted text'
                : origin === 'grid' ? 'Entered rows'
                : (s.sourceFileName || window.currentCSVFileName || 'File');
            return rows ? `${name} · ${plural(rows, 'row', 'rows')}` : name;
        }
        if (status === 'checking') return n === 3 ? 'Checking rows…' : 'Checking…';
        if (n === 2) {
            if (s.dataEntryMode) return 'Not needed';
            if (reached < 2) return '';
            const unmapped = unmappedCount(s);
            const h = handler();
            const total = h && h.getVariablesThatNeedMapping ? h.getVariablesThatNeedMapping().length : 0;
            return unmapped > 0 ? `${unmapped} not mapped` : total ? `${total} of ${total} mapped` : 'Nothing to map';
        }
        if (n === 3) {
            const errors = errorRowCount(s);
            if (errors > 0) return `${plural(errors, 'row needs', 'rows need')} fixing`;
            return reached >= 4 && rows ? `${plural(rows, 'row', 'rows')} valid` : '';
        }
        const calls = textOf('totalApiCallsDisplay');
        return reached >= 4 && /\d/.test(calls) ? `${calls} API ${calls === '1' ? 'call' : 'calls'}` : '';
    }

    /** One step's state: current, checking, done, needs, available, blocked, pending or locked. */
    function stepState(n, s, w) {
        const current = s.modalStep || 1;
        if (n === 1 && chained()) return { status: n === current ? 'current' : 'locked' };
        if (n === 2 && s.dataEntryMode && n !== current) return { status: 'skipped' };
        if (n === current) return { status: 'current', checking: w.checkingStep === n, issue: issueAt(n, s) };
        if (n < current) return { status: issueAt(n, s) ? 'needs' : 'done', issue: issueAt(n, s) };
        // Ahead: the first step from here that needs the user holds everything after it
        for (let k = current; k < n; k++) {
            if (issueAt(k, s)) return { status: 'blocked', waitsFor: STEPS[k - 1].label };
        }
        if (w.walking) return { status: 'pending' };
        const reachable = Math.max(s.maxStepReached || 1, current + 1);
        if (n > reachable || current === 1) return { status: 'pending' };
        return { status: issueAt(n, s) ? 'needs' : 'available', issue: issueAt(n, s) };
    }

    /** Data imported but not run yet: the Hub keeps this tab through Close
     *  all and asks before it closes (Issue #348). Executing closes the tab. */
    function hasUnsavedWork(s) {
        return rowCount(s) > 0 || (s.maxStepReached || 1) > 1;
    }

    /** The footer's steps (the design system's <dbmn-steps>, shared/dbmn-footer.js), given their names once. */
    let bar = null;

    function render() {
        const nav = document.getElementById('batchStepper');
        const s = state();
        if (!nav || !s || typeof nav.render !== 'function') return;
        if (window.dbmnSetTabDirty) window.dbmnSetTabDirty(hasUnsavedWork(s));
        if (bar !== nav) {
            bar = nav;
            bar.steps = STEPS;
            bar.addEventListener('dbmn-step', event => handler().goToStep(event.detail.step));
        }
        const w = walk();
        const current = s.modalStep || 1;
        const states = STEPS.map((_, i) => {
            const n = i + 1;
            const st = stepState(n, s, w);
            // Reading a file or checking rows: the step it belongs to turns (steps and a progress
            // bar never show together); how far it has got is said in the screen (below)
            const working = !!(live(s) && n === live(s).step);
            const status = st.checking || working ? 'checking' : st.status;
            // What the step decided ("replenishment.csv · 295 rows", "6 of 6 mapped") is its hover text
            const summary = st.status === 'blocked' ? `Waits for ${st.waitsFor}` : summaryOf(n, s, status);
            const title = st.status === 'locked' ? 'Set by the chain'
                : st.status === 'skipped' ? 'Not needed for entered data' : undefined;
            return { ...st, checking: st.checking || working, summary, title };
        });
        bar.render(states, current);
        // "Reading rows · 1,200 of 5,000", in the screen while it lasts
        const says = live(s) && live(s).text ? live(s).text : '';
        const line = document.getElementById('batchWorking');
        if (line) {
            line.classList.toggle('hidden', !says);
            if (line.textContent !== says) line.textContent = says;
        }
    }

    // Step summaries that live in other steps' markup (API calls, environment) refresh the bar
    function watch(id) {
        const el = document.getElementById(id);
        if (el && window.MutationObserver) {
            new MutationObserver(render).observe(el, { childList: true, characterData: true, subtree: true });
        }
    }

    function init() {
        watch('totalApiCallsDisplay');
        render();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.BatchStepper = { refresh: render, stepState, issueAt, hasUnsavedWork };
})();

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* Compare's page script (#298; compare-page.ts builds the page). UI state only: the compare
 * itself runs in CompareController, which holds every result and the outcome and sends one
 * window of rows at a time. A file, not inline script, so the web app's CSP lets it run.
 *
 * One saved compare: the Baseline (BL) and one to three others (C1, C2, C3). Steps: Select (what
 * is compared; from the Console, BL is the result it showed), Match (the key, which must pair
 * records one to one), Compare (the columns and which rows), Results: the results as buttons (BL
 * picks another Baseline; C1 to C3 show or hide), Side by side or Compact, and the grid. Back
 * and Next in the footer (the design system's, shared/dbmn-footer.js). Work shows on the steps, on
 * the step it leads to (startWork), and the screen moves once that step is ready, so the steps
 * never flash past. The compare's name follows the slots in the top row (dbmn-name): a click renames it. */
(function () {
    'use strict';
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);

    const STEPS = [
        { label: 'Select', help: 'compare#start' },
        { label: 'Match', help: 'compare#match' },
        { label: 'Columns', help: 'compare#compare' },
        { label: 'Results', help: 'compare#results' }
    ];
    const STEP_PANELS = ['compareSelectStep', 'compareMatchStep', 'compareColumnsStep', 'compareResultsStep'];
    const RESULTS = 4;

    const ui = {
        step: 1,
        reached: 1,
        endpoint: null,
        sources: [],          // BL, then C1, C2, C3: { id, environment, header, executedAt, rows, status, incomplete, missing }
        runs: [],             // the endpoint's results, for Select
        picked: null,         // Select's choice: { baselineId, ids }, or null while not enough is picked
        picks: null,          // Select's picks as they stand, for the slots: { baselineId, ids }
        saved: null,          // the compare's saved setup (key, columns): Select can skip ahead with it
        savedCompared: false, // the saved setup was compared with the results saved (not since changed)
        work: null,           // work under way, shown on the step bar: { step, plan, summary, progress }
        shown: false,         // a step's screen is showing (none while a compare first opens)
        max: 4,
        view: null,
        sides: null,          // compare.sides: columns, each result's row counts, the saved setup
        keyColumns: [],
        profile: null,        // compare.matchProfile for the key ticked: { pairs, ok }
        drill: null,          // Match's drill-in, while open: { place, kind, index, total, body }
        compare: {},          // column id → ticked (in Results)
        relaxed: {},          // column id → Relaxed
        showOnly: {},         // column id → shown in Results, never compared (Don't compare)
        join: 'full',
        result: null,         // the compare Results show: { keyColumns, compareColumns, shownColumns }
        on: new Set(),        // the other results shown (BL always is)
        hidden: new Set(),    // compared columns hidden (the gear, × on a heading): not compared
        order: [],            // compared columns in the order dragged
        sort: null,           // { column, place?, dir }
        resultsView: 'side',  // 'side' (a column per result) or 'compact'; the last one used
        changedOnly: false,   // hide, from view only, the compared columns no row differs in
        recordView: 'table',  // the record window: 'table' or 'json'; the last one used
        recordAll: false,     // the record window also marks values that differ in columns not compared
        counts: {},           // with the results and columns shown: { same, diff, missing, missingBy }
        allCounts: {},        // with every result and column, for "4 of 6"
        columnDiffCounts: {},
        rowCounts: [],
        filter: { same: true, diff: true, missing: [], columns: [], relations: null },   // the Status filter (Which rows sets where it starts), columns whose count pill is on, and the Relationship filter (null: every relationship)
        relationCounts: {},   // rows of each relationship (one to one, one to many, only in BL, only in C)
        search: '',
        busy: false,
        running: false        // opened to run as saved: Results are on the way
    };

    // The footer's steps (shared/dbmn-footer.js): shown what stands, they say which step was asked for
    const bar = $('compareStepper');
    bar.steps = STEPS;
    bar.addEventListener('dbmn-step', event => goTo(event.detail.step));

    function post(message) { vscode.postMessage(message); }
    /** Two counts share a slot: 105K, 72.1K (the whole number on hover); under 10,000 as it is. */
    const SHORT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    function short(n) { return n < 10000 ? n.toLocaleString() : SHORT.format(n); }
    function plural(n, one, many) { return `${Number(n).toLocaleString()} ${n === 1 ? one : many}`; }
    function text(node, value) { if (node) node.textContent = value; }
    function el(tagName, className, content) {
        const node = document.createElement(tagName);
        if (className) node.className = className;
        if (content !== undefined) node.textContent = content;
        return node;
    }
    /** The Baseline is BL; the others are C1, C2, C3. */
    function letter(place) { return place === 0 ? 'BL' : `C${place}`; }
    function several() { return ui.sources.length > 2; }
    /** Where a result ran: its environment and its header values ("DEV 880"). */
    function placeName(r) {
        return [r.environment].concat((r.header || []).map(h => h.value)).join(' ');
    }
    /** How a result is named: where it ran, and when (resultLabel). */
    function columnName(id) {
        const c = ui.sides && ui.sides.columns.find(col => col.id === id);
        return c ? c.name : id;
    }
    function keyOk() { return !!(ui.profile && ui.profile.ok); }

    /* ---------- Step bar ---------- */

    /** A column's name before the results are read: the last part of its id. */
    function savedName(id) { return ui.sides ? columnName(id) : String(id).split('.').pop(); }
    function waitsFor(n) {
        // Not read yet: Select's picks and the saved key and columns say how far it can skip
        if (!ui.sides) {
            if (n >= 2 && !ui.picked) return 'Select';
            // Skip past Match only with the results the key was last compared on: other results
            // (C3 added) must pass Match first, however often the compare is closed and opened
            if (n >= 3 && !(ui.saved && ui.saved.keyColumns.length && ui.savedCompared && picksAsSaved())) return 'Match';
            if (n >= 4 && !(ui.saved && ui.saved.compareColumns.length)) return 'Columns';
            return null;
        }
        if (n >= 3 && !keyOk()) return 'Match';
        if (n >= 4 && !Object.keys(ui.compare).some(isCompared)) return 'Columns';
        return null;
    }
    /** Select's picks are the compare's results as saved, the Baseline first. */
    function picksAsSaved() {
        const choice = ui.picked;
        if (!choice) return false;
        const ids = [choice.baselineId].concat(choice.ids);
        return ids.length === ui.sources.length && ids.every((id, i) => ui.sources[i] && ui.sources[i].id === id);
    }
    /** Ticked on Columns and compared (not Don't compare). */
    function isCompared(id) { return !!ui.compare[id] && !ui.showOnly[id]; }
    function summaryOf(n) {
        if (n === 1) return ui.sources.length > 1 ? `${ui.sources.length} results` : '';
        if (n === 2) {
            const key = ui.keyColumns.length ? ui.keyColumns : ui.saved ? ui.saved.keyColumns : [];
            return key.length ? `on ${key.map(savedName).join(' + ')}` : '';
        }
        if (n === 3 && !ui.sides) return ui.saved && ui.saved.compareColumns.length ? `${ui.saved.compareColumns.length} compared` : '';
        if (n === 3) {
            const count = Object.keys(ui.compare).filter(isCompared).length;
            // "18 compared · 2 shown · Rows: Everything": the columns compared, those only shown,
            // then Which rows
            const shown = Object.keys(ui.compare).filter(id => ui.compare[id] && ui.showOnly[id]).length;
            const rows = { full: 'Everything', left: 'All of BL', right: 'All of C1', inner: 'Matching only' }[ui.join];
            return ui.reached >= 3 ? `${count} compared${shown ? ` · ${shown} shown` : ''} · Rows: ${rows}` : '';
        }
        if (!ui.result) return '';
        const c = ui.counts;
        return `${(c.diff || 0).toLocaleString()} DIFF · ${(c.missing || 0).toLocaleString()} missing`;
    }
    /*
     * The step bar is also where work shows, as in Run Batch: no loader of its own. Work runs on
     * the step it leads to (ui.work.step): that step is current, with its fill and what it is
     * doing ("Checking the match · 125,010 of 420,020"); the steps before it are ticked. The
     * screen stays on the step it shows until the work's step is ready, then moves once.
     */
    function renderBar() {
        const work = ui.work;
        const at = work ? work.step : ui.step;
        const states = STEPS.map((_, i) => {
            const n = i + 1;
            if (n === at) {
                if (!work) return { status: 'current', summary: summaryOf(n) };
                // (steps and a progress bar never show together: the step's number turns, and what it is doing is its hover text)
                return { status: 'current', summary: work.summary, checking: true, title: work.summary };
            }
            if (n < at) return { status: 'done', summary: summaryOf(n) };
            if (work) return { status: 'pending', summary: '' };
            const blocked = waitsFor(n);
            if (!blocked) return { status: 'available', summary: summaryOf(n) };
            if (n === ui.step + 1) return { status: 'blocked', waitsFor: blocked, summary: `Waits for ${blocked}` };
            return { status: 'pending', summary: '' };
        });
        bar.render(states, at);
        // How far the work has got ("Checking the match · 125,010 of 420,020") is said in the screen: the steps only turn
        const working = $('compareWorking');
        const says = work && work.plan.length ? work.summary : '';
        working.classList.toggle('hidden', !says);
        if (working.textContent !== says) working.textContent = says;
        // On Results the wizard is done: the steps fold into what is on screen (click it for the steps).
        // Only once the results are in, and not while they are read, matched or compared again;
        // quick work on Results (Counting, Exporting) keeps the summary and turns its tick
        bar.summary = [summaryOf(1), summaryOf(2), summaryOf(RESULTS)].filter(Boolean);
        bar.folded = ui.shown && ui.step === RESULTS && !!ui.result && !(work && (work.step !== RESULTS || work.plan.length));
        renderFooterButtons();
    }
    /** Back and Next. Next says where it goes; on Columns it compares (it says so); Results has no Next. */
    function renderFooterButtons() {
        const next = $('compareNextBtn');
        next.classList.toggle('hidden', !ui.shown || ui.step === RESULTS);
        next.textContent = ui.step === 3 ? 'Generate' : ui.step < 3 ? `Next: ${STEPS[ui.step].label}` : 'Next';
        $('compareBackBtn').disabled = !ui.shown || ui.step === 1 || ui.busy;
        next.disabled = ui.busy || (ui.step === 1 ? !ui.picked : !!waitsFor(ui.step + 1));
        next.title = ui.step === 1 && !ui.picked ? 'Tick at least one result to compare with the Baseline' : '';
    }

    /* ---------- Steps ---------- */

    function showStep(n) {
        // Compare's columns are drawn each time it shows: a saved compare opens straight on
        // Results, so stepping back is the first time this tab shows them
        if (n === 3 && ui.sides) renderColumns();
        // Select draws the picks as they are each time (stepping back from Results is its first time)
        if (n === 1 && (ui.step !== 1 || !$('compareSelect').firstChild)) renderSelect();
        ui.step = n;
        ui.shown = true;
        ui.reached = Math.max(ui.reached, n);
        STEP_PANELS.forEach((id, i) => $(id).classList.toggle('hidden', i + 1 !== n));
        // The slots stay at the top of every step; Results' toolbar joins them
        $('compareResultsControls').classList.toggle('hidden', n !== RESULTS);
        renderResultsBar();
        closeMenus();
        renderBar();
        updatePeek();
        if (n === RESULTS) requestRows(true);
    }
    /** The footer stays on Results: its steps fold into the summary (renderBar), and its buttons
     * are still to hand. (It used to shrink to a strip.) */
    function updatePeek() {
        document.body.classList.remove('is-footer-peek');
    }
    /** The step the user clicked: earlier steps open as they are, later ones once ready. */
    function goTo(n) {
        if (n === ui.step || ui.busy) return;
        if (n < ui.step) return showStep(n);
        if (ui.step === 1) return next(n);
        if (waitsFor(n)) return;
        if (n < RESULTS) return showStep(n);
        return ui.result ? showStep(RESULTS) : runCompare();
    }
    /**
     * Next, or a later step clicked (`target`): from Select the picks are read only now, and only
     * when they changed; reading goes as far as the step asked for (Results: read, matched and
     * compared as saved). Match and Compare go on; Compare compares.
     */
    function next(target) {
        if (ui.busy) return;
        if (ui.step === 1) {
            const to = target || 2;
            const choice = ui.picked;
            if (!choice || waitsFor(to)) return;
            const ids = [choice.baselineId].concat(choice.ids);
            const same = picksAsSaved();
            if (same && ui.sides) {
                if (to < RESULTS) return showStep(waitsFor(to) ? 2 : to);
                return ui.result ? showStep(RESULTS) : waitsFor(RESULTS) ? showStep(2) : runCompare();
            }
            // Read on the way to the step asked for (compare.init says whether Results follow)
            startWork(to, to === RESULTS ? ['read', 'match', 'compare'] : ['read', 'match']);
            showReading();
            const toResults = to === RESULTS ? { to: 'results' } : {};
            post(same ? Object.assign({ type: 'compare.load' }, toResults) : Object.assign({ type: 'compare.edit', ids }, toResults));
            return;
        }
        if (waitsFor(ui.step + 1)) return;
        if (ui.step + 1 < RESULTS) return showStep(ui.step + 1);
        return ui.result ? showStep(RESULTS) : runCompare();
    }

    function runCompare() {
        startWork(RESULTS, ['compare']);
        const cols = (ui.sides ? ui.sides.columns : []).map(c => c.id).filter(id => !ui.keyColumns.includes(id));
        post({
            type: 'compare.run',
            setup: {
                keyColumns: ui.keyColumns,
                compareColumns: cols.filter(isCompared),
                relaxedColumns: cols.filter(id => isCompared(id) && ui.relaxed[id]),
                shownColumns: cols.filter(id => ui.compare[id] && ui.showOnly[id]),
                join: ui.join
            }
        });
    }

    /* ---------- Work, on the step bar ---------- */

    /*
     * `step`: where the work leads (its step is current on the bar meanwhile). `plan`: the
     * pieces it is made of, in order ('read', 'match', 'compare'): the step's fill is how far
     * through them it is, each an equal share. Without a plan (Counting, Exporting) the step's
     * ring turns instead.
     */
    const PHASES = [['read', /^Reading/], ['match', /^Checking/], ['compare', /^Comparing/]];
    function startWork(step, plan, summary) {
        ui.busy = true;
        ui.work = { step, plan: plan || [], summary: summary || (plan && plan[0] === 'read' ? 'Reading the results' : plan && plan[0] === 'match' ? 'Checking the match' : plan ? 'Comparing' : ''), progress: plan ? 0 : undefined };
        renderBar();
        updatePeek();
    }
    /**
     * Match while the results are read: the step shows at once, empty, and says so (the step bar
     * has the progress). The columns and the match fill in as they come.
     */
    function showReading() {
        $('compareKeyColumns').replaceChildren();
        text($('compareKeyHint'), 'The View’s columns show once the results are read.');
        $('compareMatchBody').replaceChildren(el('p', 'compare-match-empty', 'Reading the results…'));
        $('compareMatchVerdict').className = 'compare-match-verdict hidden';
        showStep(2);
    }
    /** The work is done; `step`, when given, is ready to show. */
    function endWork(step) {
        ui.busy = false;
        ui.work = null;
        if (step) showStep(step); else { renderBar(); updatePeek(); }
    }
    /** Quick work on the step shown (Counting, Exporting, a Check): its ring turns. */
    function setBusy(busy, phase) {
        if (busy) startWork(ui.step, phase === 'Checking the match' ? ['match'] : null, phase);
        else if (ui.work) endWork();
    }
    function progress(m) {
        const work = ui.work;
        if (!work) return;
        const phase = PHASES.find(([, re]) => re.test(m.phase));
        const at = phase ? work.plan.indexOf(phase[0]) : -1;
        const share = m.total ? Math.min(m.done, m.total) / m.total : 0;
        // Reading counts results (Reading C1 · 2 of 3); the match and the compare count records
        work.summary = !m.total ? m.phase
            : phase && phase[0] === 'read' ? `${m.phase} · ${Math.min(m.done + 1, m.total)} of ${m.total}`
            : `${m.phase} · ${Math.min(m.done, m.total).toLocaleString()} of ${m.total.toLocaleString()}`;
        if (at >= 0) work.progress = Math.round((at + share) / work.plan.length * 100);
        renderBar();
    }

    /** Select: the Baseline first, then what to compare with it. */
    function renderSelect() {
        if (!window.ComparePicker) return;
        const known = new Set(ui.runs.map(r => r.id));
        const base = ui.sources[0];
        text($('compareSelectHint'), `Results of ${ui.endpoint ? ui.endpoint.name : 'this endpoint'}, through the ${ui.view || 'Root'} View. Choose the Baseline, then up to three results to compare with it.`);
        window.ComparePicker.mount($('compareSelect'), {
            runs: ui.runs,
            baselineId: base && known.has(base.id) ? base.id : (ui.runs[0] && ui.runs[0].id),
            picked: ui.sources.slice(1).map(src => src.id).filter(id => known.has(id)),
            max: ui.max,
            onChange: (choice, picks) => {
                ui.picked = choice;
                ui.picks = picks;
                renderBar();
                // The slots fill as results are ticked (showStep draws them when Select first shows)
                if (ui.step === 1) renderResultsBar();
            }
        });
    }
    function openSelect() {
        renderSelect();
        showStep(1);
    }
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /* ---------- Match ---------- */

    function renderKeyColumns() {
        $('compareKeyColumns').replaceChildren(...ui.sides.columns.map(col => {
            const tr = el('tr');
            const label = el('label', 'compare-status-option');
            const box = el('input');
            box.type = 'checkbox';
            box.checked = ui.keyColumns.includes(col.id);
            box.value = col.id;
            box.setAttribute('aria-label', `Match on ${col.name}`);
            box.setAttribute('data-change', 'compare:key');
            label.appendChild(box);
            { const name = el('span', 'font-mono', col.name); name.title = col.name; label.appendChild(name); }
            const td = el('td');
            td.appendChild(label);
            tr.appendChild(td);
            // A value from BL, so the column is plain at a glance
            const sample = sampleText(ui.sides.samples ? ui.sides.samples[col.id] : undefined);
            const cell = el('td', 'compare-key-sample font-mono', sample);
            if (sample) cell.title = sample;
            tr.appendChild(cell);
            return tr;
        }));
        text($('compareKeyHint'), `Columns of the ${ui.view || 'Root'} View. Tick the ones that identify a record.`);
    }
    function sampleText(value) {
        if (value === undefined || value === null || (value && value.$dbmnMissing)) return '';
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }

    /** The match, checked a moment after the ticks last changed: a check under way for older ticks stops. */
    let checkTimer = null;
    function scheduleCheck() {
        clearTimeout(checkTimer);
        if (!ui.keyColumns.length) {
            // Nothing to check: a check under way gives way
            if (ui.work && ui.work.step === 2 && ui.work.plan.length === 1) endWork();
            return;
        }
        checkTimer = setTimeout(checkKey, 400);
    }

    /** How the key ticked matches every other result, its progress on the step bar. */
    function checkKey() {
        // While the results are read on the way to Match or Results, the check is part of that work
        if (!ui.keyColumns.length || ui.busy && !(ui.work && ui.work.plan.includes('match'))) return;
        if (!ui.work) setBusy(true, 'Checking the match');
        post({ type: 'compare.match', keyColumns: ui.keyColumns });
    }

    /* Each kind of key, its little picture (BL blue, C orange: shared/relation-glyph.js) and its name */
    const OK_ROWS = [
        ['oneToOne', () => 'One to one', null],
        // One to many is compared: BL's record against each of the other result's
        ['oneToMany', c => `Repeated in ${c}`, () => 'BL\'s record is compared with each'],
        ['onlyBase', () => 'Only in BL', c => `shows as Missing ${c} in Results`],
        ['onlyOther', c => `Only in ${c}`, () => 'shows as Missing BL in Results']
    ];
    // A value on more than one of BL's records stops the compare: BL is always the "one"
    const MANY_ROWS = [
        ['manyToOne', () => 'Repeated in BL'],
        ['manyToMany', () => 'Repeated in both']
    ];
    /** The kinds whose cells show both sides' records, the picture between. */
    const PAIRED = new Set(['oneToMany', 'manyToOne', 'manyToMany']);
    const glyph = window.RelationGlyph.svg;

    /**
     * One group of the panel, on the slots' grid: a row per kind, its picture and name under BL,
     * its count under each other result (the slots head the columns). A count of keys that match
     * more than one record opens them.
     */
    function matchTable(rows, others, many) {
        const byPlace = new Map(ui.profile.pairs.map(x => [x.place, x]));
        const cName = others.length === 1 ? letter(others[0]) : 'C';
        const key = ui.keyColumns.map(columnName).join(' + ');
        const table = el('div', 'compare-match-table');
        rows.forEach(([kind, label, note]) => {
            const row = el('div', 'compare-match-row');
            // Under BL: the kind's picture, its name on hover
            const name = el('div', 'compare-match-kind');
            name.appendChild(glyph(kind));
            name.title = note && others.length === 1 ? `${label(cName)}: ${note(cName)}` : label(cName);
            row.appendChild(name);
            for (let place = 1; place < (ui.max || 4); place++) {
                const td = el('div', `compare-match-count ${tone(place)}`);
                if (others.includes(place)) {
                    const pair = byPlace.get(place) || {};
                    const n = (pair.counts || {})[kind] || 0;
                    if (n) td.classList.add('is-some');
                    if (n && kind === 'oneToMany') td.classList.add('is-repeat');
                    if (n && PAIRED.has(kind)) {
                        // Both sides, the picture between: BL's records, then this result's ("36 ●< 200")
                        const inBase = (pair.recordsBase || {})[kind] || 0;
                        const inOther = (pair.recordsOther || {})[kind] || 0;
                        const alone = (pair.unmatched || {})[kind] || 0;
                        const b = el('button', 'compare-match-drill compare-match-pair');
                        b.type = 'button';
                        b.appendChild(el('span', 'compare-match-base', short(inBase)));
                        b.appendChild(glyph(kind));
                        b.appendChild(el('span', 'compare-match-other', short(inOther)));
                        b.title = `${label(letter(place))}: ${inBase.toLocaleString()} in BL, ${inOther.toLocaleString()} in ${letter(place)}, on ${plural(n, 'value', 'values')} of ${key}`
                            + (alone ? `. ${alone.toLocaleString()} of them are on values the other side doesn't have` : '')
                            + '. Click to see them';
                        b.setAttribute('data-click', 'compare:matchGroup');
                        b.setAttribute('data-arg', `${place}:${kind}`);
                        td.appendChild(b);
                    } else td.textContent = n.toLocaleString();
                }
                row.appendChild(td);
            }
            table.appendChild(row);
        });
        if (!many) return table;
        const box = el('div', 'compare-match-many');
        box.appendChild(el('div', 'compare-match-group-title', 'Match more than one record: can’t be compared'));
        box.appendChild(table);
        return box;
    }

    function renderMatch() {
        const p = ui.profile;
        const others = ui.sources.slice(1).map((_, i) => i + 1);
        text($('compareMatchTitle'), others.length === 1 ? `How BL matches ${letter(1)}` : 'How BL matches each result');
        const body = $('compareMatchBody');
        const verdict = $('compareMatchVerdict');
        const empty = ui.sides ? ui.sides.sides.map((x, i) => (x.rows ? -1 : i)).filter(i => i >= 0) : [];
        const say = (ok, message, warn) => {
            verdict.className = `compare-match-verdict ${ok ? (warn ? 'is-warn' : 'is-ok') : 'is-bad'}`;
            text(verdict, `${ok ? '✓' : '✗'} ${message}`);
        };
        verdict.className = 'compare-match-verdict hidden';
        if (empty.length) {
            // Nothing to match: say which result has no records through the View
            body.replaceChildren();
            say(false, `${empty.map(letter).join(' and ')} ${empty.length === 1 ? 'has' : 'have'} no records through ${ui.view || 'Root'}. Open ${empty.length === 1 ? 'it' : 'them'} in the Console to see why, or Edit to pick another result.`);
            renderBar();
            return;
        }
        if (!p) {
            body.replaceChildren(el('p', 'compare-match-empty', ui.keyColumns.length
                ? 'Checking how the records match…'
                : 'Tick the columns that identify a record.'));
            renderBar();
            return;
        }
        const anyMany = p.pairs.some(x => MANY_ROWS.some(([k]) => x.counts[k] > 0));
        const parts = [el('div', 'compare-match-group-title', 'Can be compared'), matchTable(OK_ROWS, others, false)];
        if (anyMany) parts.push(matchTable(MANY_ROWS.map(([k, l]) => [k, l, null]), others, true));
        body.replaceChildren(...parts);
        const key = ui.keyColumns.map(columnName).join(' + ');
        // One to many goes ahead, said plainly: BL's record is compared with each of them
        const repeats = p.pairs.filter(x => (x.counts.oneToMany || 0) > 0).map(x => letter(x.place));
        if (p.ok && repeats.length) say(true, `Some values repeat in ${repeats.join(', ')}: BL's record is compared with each of them. Go on to Columns.`, true);
        else if (p.ok) say(true, 'Each record matches one record. Go on to Columns.');
        else if (anyMany) say(false, `${key} is on more than one of BL's records. Add a column so BL holds each value once.`);
        else say(false, `No record matches on ${key}. Is it a database id that each environment numbers for itself?`);
        renderBar();
    }

    /* ---------- Match's drill-in: the keys that match more than one record ---------- */

    const MANY_TITLE = Object.fromEntries(MANY_ROWS.map(([k, label]) => [k, label]));

    /**
     * A key far from a key (a user id on every record): why it can't match a record, and its
     * first keys with the records each holds in BL and the other result. No records to look through.
     */
    function renderLargeGroup(m) {
        const wrap = el('div', 'compare-drill');
        const key = ui.keyColumns.map(columnName).join(' + ');
        wrap.appendChild(el('p', 'compare-drill-none', `One ${key} is on up to ${plural(m.most, 'record', 'records')}, so it can't pick out a record. Tick columns whose values change from record to record.`));
        const table = el('table', 'data-table');
        const head = el('tr');
        head.appendChild(el('th', '', key));
        [0, m.place].forEach(p => {
            const th = el('th', `compare-sub compare-record-head ${tone(p)}`);
            th.appendChild(el('strong', '', letter(p)));
            th.title = resultLabel(p);
            head.appendChild(th);
        });
        const thead = el('thead');
        thead.appendChild(head);
        table.appendChild(thead);
        const body = el('tbody');
        m.keys.forEach(k => {
            const tr = el('tr');
            tr.appendChild(el('td', 'font-mono', k.values.map(v => sampleText(v) || '(blank)').join(' + ')));
            tr.appendChild(el('td', 'compare-match-count', k.base.toLocaleString()));
            tr.appendChild(el('td', 'compare-match-count', k.other.toLocaleString()));
            body.appendChild(tr);
        });
        table.appendChild(body);
        const box = el('div', 'table-container compare-drill-records');
        box.appendChild(table);
        wrap.appendChild(box);
        if (m.total > m.keys.length) wrap.appendChild(el('p', 'compare-match-note', `The first ${m.keys.length} of ${plural(m.total, 'value', 'values')}.`));
        return wrap;
    }

    /**
     * The records that share repeated values of the key, a page of values at a time: BL's on the
     * left, the other result's on the right, a row per record, each value's records side by side
     * (one row against two is "one to many"). The key's columns first, then the View's. ‹ › page.
     */
    function renderMatchGroup(m) {
        const wrap = el('div', 'compare-drill');
        const head = el('div', 'compare-drill-head');
        const to = m.index + m.values.length;
        head.appendChild(el('span', 'compare-drill-key', `${(m.index + 1).toLocaleString()}–${to.toLocaleString()} of ${plural(m.total, 'value', 'values')}`));
        // Dig further in the Console: the whole result, every column, not just the View's
        const open = el('span', 'compare-drill-open');
        [0, m.place].forEach(p => {
            const b = el('button', 'secondary-btn', `Open ${letter(p)} in the Console`);
            b.type = 'button';
            b.title = `${letter(p)} · ${resultLabel(p)}`;
            b.setAttribute('data-click', 'compare:openConsole');
            b.setAttribute('data-arg', String(p));
            open.appendChild(b);
        });
        head.appendChild(open);
        const pager = el('span', 'compare-drill-pager');
        [['‹', -1, 'Previous values'], ['›', 1, 'Next values']].forEach(([label, step, title]) => {
            const b = el('button', 'secondary-btn', label);
            b.type = 'button';
            b.title = title;
            b.disabled = step < 0 ? m.index === 0 : to >= m.total;
            b.setAttribute('data-click', 'compare:matchPage');
            b.setAttribute('data-arg', String(step));
            pager.appendChild(b);
        });
        head.appendChild(pager);
        wrap.appendChild(head);
        // The key's columns first, then the rest in the View's order
        const order = m.columns.map((c, i) => (c.key ? i : -1)).filter(i => i >= 0)
            .concat(m.columns.map((c, i) => (c.key ? -1 : i)).filter(i => i >= 0));
        const keys = order.filter(i => m.columns[i].key);
        // The "one" side lists a record a value; opening one shows the "many" side's for it alone.
        // Repeated in both has no one side: a value a row, both sides inside
        const one = m.kind === 'oneToMany' ? 0 : m.kind === 'manyToOne' ? m.place : null;
        const many = m.kind === 'oneToMany' ? [m.place] : m.kind === 'manyToOne' ? [0] : [0, m.place];
        const recordsOf = (v, p) => (p === 0 ? v.base : v.other);
        const heldOf = (v, p) => v.held[p === 0 ? 0 : 1];
        const cols = one === null ? keys : order;
        wrap.appendChild(el('p', 'compare-match-note', one === null
            ? `A value a row. Open one for its ${many.map(letter).join(' and ')} records.`
            : `${letter(one)}'s record for each value. Open one for its ${letter(many[0])} records.`));
        // Values the one side doesn't have: missing as well as repeated, listed only when asked
        if (one !== null && m.lonely) {
            const label = el('label', 'compare-drill-alone');
            const box = el('input');
            box.type = 'checkbox';
            box.checked = !!m.alone;
            box.setAttribute('data-change', 'compare:drillAlone');
            label.appendChild(box);
            label.appendChild(document.createTextNode(` Show the ${plural(m.lonely, `value ${letter(one)} doesn't have`, `values ${letter(one)} doesn't have`)}`));
            wrap.appendChild(label);
        }
        const recordsTable = (rows, place) => {
            const box = el('div', 'compare-drill-many');
            const title = el('div', `compare-drill-pane-head ${tone(place)}`);
            title.appendChild(el('strong', '', letter(place)));
            title.appendChild(document.createTextNode(` ${resultLabel(place)}`));
            box.appendChild(title);
            const table = el('table', 'data-table');
            // Its headings in its result's colour
            const tr = el('tr', `compare-drill-tinted ${tone(place)}`);
            order.forEach(i => tr.appendChild(el('th', '', m.columns[i].name)));
            const thead = el('thead');
            thead.appendChild(tr);
            table.appendChild(thead);
            const body = el('tbody');
            rows.forEach(r => {
                const row = el('tr');
                order.forEach(i => { const td = el('td', m.columns[i].key ? 'compare-drill-keycell' : ''); td.appendChild(valueNode(r[i], false)); row.appendChild(td); });
                body.appendChild(row);
            });
            table.appendChild(body);
            box.appendChild(table);
            return box;
        };
        const table = el('table', 'data-table compare-drill-list');
        // The list's headings in the one side's colour, as its slot
        const listHead = el('tr', one === null ? '' : `compare-drill-tinted ${tone(one)}`);
        listHead.appendChild(el('th', '', one === null ? '' : letter(one)));
        cols.forEach(i => listHead.appendChild(el('th', '', m.columns[i].name)));
        const thead = el('thead');
        thead.appendChild(listHead);
        table.appendChild(thead);
        const body = el('tbody');
        m.values.forEach((v, n) => {
            const row = el('tr');
            const toggle = el('td');
            const b = el('button', 'expand-toggle');
            b.type = 'button';
            b.setAttribute('data-click', 'compare:drillExpand');
            b.setAttribute('data-arg', String(n));
            b.setAttribute('aria-expanded', 'false');
            const icon = el('span', 'expand-icon');
            icon.innerHTML = window.Icons ? window.Icons.icon('chevron-right') : '▸';
            b.appendChild(icon);
            b.appendChild(document.createTextNode(many.map(p => `${heldOf(v, p).toLocaleString()} in ${letter(p)}`).join(', ')));
            toggle.appendChild(b);
            row.appendChild(toggle);
            const mine = one === null ? null : recordsOf(v, one)[0];
            // The value's key from whichever side has it
            const any = mine || recordsOf(v, many[0])[0] || recordsOf(v, many[many.length - 1])[0];
            if (one !== null && !mine) {
                keys.forEach(i => { const td = el('td', 'compare-drill-keycell'); td.appendChild(valueNode(any[i], false)); row.appendChild(td); });
                const none = el('td', 'compare-match-note', `No ${letter(one)} record`);
                none.colSpan = cols.length - keys.length;
                if (none.colSpan > 0) row.appendChild(none);
            } else {
                cols.forEach(i => { const td = el('td', m.columns[i].key ? 'compare-drill-keycell' : ''); td.appendChild(valueNode((mine || any)[i], false)); row.appendChild(td); });
            }
            body.appendChild(row);
            // Opened: the many side's records for this value alone ("and N more" past the first few)
            const detail = el('tr', 'compare-drill-detail hidden');
            detail.setAttribute('data-detail', String(n));
            const cell = el('td');
            cell.colSpan = cols.length + 1;
            const inner = el('div', 'array-content');
            many.forEach(p => {
                inner.appendChild(recordsTable(recordsOf(v, p), p));
                const extra = heldOf(v, p) - recordsOf(v, p).length;
                if (extra > 0) inner.appendChild(el('p', 'compare-match-note', `and ${plural(extra, 'more record', 'more records')}`));
            });
            cell.appendChild(inner);
            detail.appendChild(cell);
            body.appendChild(detail);
        });
        table.appendChild(body);
        const box = el('div', 'table-container compare-drill-table');
        box.appendChild(table);
        wrap.appendChild(box);
        return wrap;
    }

    function matchGroup(m) {
        if (!ui.drill || ui.drill.place !== m.place || ui.drill.kind !== m.kind || JSON.stringify(m.keyColumns) !== JSON.stringify(ui.keyColumns)) return;
        ui.drill.index = m.index;
        ui.drill.total = m.total;
        const content = m.large ? renderLargeGroup(m) : renderMatchGroup(m);
        if (ui.drill.body && ui.drill.body.isConnected) {
            ui.drill.body.replaceChildren(content);
            return;
        }
        const body = el('div', 'compare-drill-body');
        body.appendChild(content);
        ui.drill.body = body;
        const drill = ui.drill;
        window.DbmnModal.show({
            title: `${MANY_TITLE[m.kind](letter(m.place))}: ${plural(m.records, 'record', 'records')} share ${plural(m.total, 'value', 'values')} of ${ui.keyColumns.map(columnName).join(' + ')}`,
            body,
            size: 'large',
            maximisable: true,
            actions: [{ id: 'close', label: 'Close', variant: 'secondary' }]
        }).then(() => { if (ui.drill === drill) ui.drill = null; });
    }

    /* ---------- Compare ---------- */

    // Which rows Results start with: a soft rule. Every row is counted; the Status filter ticks them back on
    const JOIN_HINT = {
        full: () => 'Results start with every record: same, DIFF and missing.',
        left: () => 'Results start without the records BL lacks: Missing BL starts unticked in the Status filter.',
        right: () => 'Results start without the records C1 lacks: Missing C1 starts unticked in the Status filter.',
        inner: () => 'Results start with the records every result has: Missing starts unticked in the Status filter.'
    };
    /** Where the Status filter starts for the join (as compare-lens filterForJoin). */
    function filterForJoin(join, places) {
        const missing = join === 'inner' ? [] : places.filter(p => !(join === 'left' && p === 0) && !(join === 'right' && p === 1));
        return { same: true, diff: true, missing, columns: [], relations: null };
    }

    function renderColumns() {
        text($('compareColumnsView'), ui.view || 'Root');
        // First time here: every column is ticked (untick what you don't care about)
        if (!Object.keys(ui.compare).length) {
            ui.sides.columns.filter(c => !ui.keyColumns.includes(c.id)).forEach(c => { ui.compare[c.id] = true; });
        }
        $('compareColumns').replaceChildren(...ui.sides.columns.map(col => {
            const isKey = ui.keyColumns.includes(col.id);
            const tr = el('tr');
            const td = el('td');
            const box = el('input');
            box.type = 'checkbox';
            box.checked = !isKey && !!ui.compare[col.id];
            box.disabled = isKey;
            box.value = col.id;
            box.setAttribute('aria-label', `Show ${col.name} in Results`);
            box.setAttribute('data-change', 'compare:column');
            td.appendChild(box);
            tr.appendChild(td);
            const name = el('td', 'font-mono', col.name);
            if (isKey) name.appendChild(el('span', 'color-description', ' · key'));
            tr.appendChild(name);
            // A value from BL, as on Match
            const sample = sampleText(ui.sides.samples ? ui.sides.samples[col.id] : undefined);
            const cell = el('td', 'compare-key-sample font-mono', sample);
            if (sample) cell.title = sample;
            tr.appendChild(cell);
            const modeTd = el('td');
            if (!isKey) {
                const mode = el('select', 'form-input');
                // Don't compare: shown in Results beside the compared columns, never compared
                const current = ui.showOnly[col.id] ? 'none' : ui.relaxed[col.id] ? 'relaxed' : 'strict';
                [['strict', 'Strict'], ['relaxed', 'Relaxed'], ['none', 'Don\'t compare']].forEach(([value, label]) => {
                    const o = el('option', '', label);
                    o.value = value;
                    o.selected = current === value;
                    mode.appendChild(o);
                });
                mode.setAttribute('data-col', col.id);
                mode.setAttribute('aria-label', `How ${col.name} is compared`);
                mode.setAttribute('data-change', 'compare:mode');
                mode.disabled = !ui.compare[col.id];
                modeTd.appendChild(mode);
            }
            tr.appendChild(modeTd);
            return tr;
        }));
        text($('compareJoinLeft'), 'All of BL');
        text($('compareJoinRight'), 'All of C1');
        renderJoin();
        renderBar();
    }

    function renderJoin() {
        document.querySelectorAll('.compare-join').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('data-arg') === ui.join)));
        text($('compareJoinHint'), JOIN_HINT[ui.join]());
    }

    /* ---------- Results: the results compared, the Status filter, and a virtual grid fed a window at a time ---------- */

    /** Find waits this long after the last key before it searches. */
    const SEARCH_PAUSE = 450;
    /* The grid's state lives with the table (below): its rows are asked for as they scroll into view. */
    /** A column's width set by the user (its right edge dragged, or fitted), by column id: kept with the compare. */
    let userWidths = {};

    /** Each result's colour class: BL blue, C1 orange, C2 green, C3 purple (compare.css). */
    function tone(place) { return `compare-r${Math.min(place, 3)}`; }
    function tag(place) { return el('span', `compare-tag ${tone(place)}`, letter(place)); }
    /** The results shown, by place: BL first, then those not hidden. */
    function shownPlaces() { return [0, ...[...ui.on].sort((a, b) => a - b)]; }

    /**
     * A row's Status: a red DIFF and who differs, and/or Missing and who lacks the record; else
     * Same. DIFF and Missing are a group each, kept on one line: a row with both wraps to two.
     */
    function statusNode(status) {
        const box = el('span', 'compare-status');
        if (status.diff.length) {
            const group = el('span', 'compare-status-group');
            group.appendChild(el('span', 'status-pill-generic compare-diff', 'DIFF'));
            // With two results shown, DIFF can only be the other one: no letter
            if (shownPlaces().length > 2) status.diff.forEach(p => group.appendChild(tag(p)));
            box.appendChild(group);
        }
        if (status.missing.length) {
            const group = el('span', 'compare-status-group');
            group.appendChild(el('span', 'status-pill-generic compare-missing', 'Missing'));
            status.missing.forEach(p => group.appendChild(tag(p)));
            box.appendChild(group);
        }
        if (!status.diff.length && !status.missing.length) box.appendChild(el('span', 'status-pill-generic compare-same', 'Same'));
        return box;
    }
    function statusText(status) {
        const parts = [];
        if (status.diff.length) parts.push(`DIFF ${status.diff.map(letter).join(' ')}`);
        if (status.missing.length) parts.push(`Missing ${status.missing.map(letter).join(' ')}`);
        return parts.join(' · ') || 'Same';
    }

    /*
     * The Status filter: Same, DIFF, and Missing by result, each there is with its count ("4 of 6":
     * hiding results or columns left 2 out). A row with a difference and a missing record shows for either.
     */
    function filterOptions() {
        const c = ui.counts, all = ui.allCounts;
        const by = (x, p) => ((x.missingBy || [])[p] || 0);
        const out = [];
        if (c.same || all.same) out.push({ value: 'same', n: c.same || 0, of: c.same || 0 });
        if (c.diff || all.diff) out.push({ value: 'diff', n: c.diff || 0, of: all.diff || 0 });
        shownPlaces().forEach(p => { if (by(c, p) || by(all, p)) out.push({ value: `missing:${p}`, place: p, n: by(c, p), of: by(all, p) }); });
        return out;
    }
    function ticked(value) {
        if (value === 'same' || value === 'diff') return !!ui.filter[value];
        return ui.filter.missing.includes(Number(value.split(':')[1]));
    }
    function isFiltered() { return filterOptions().some(o => !ticked(o.value)); }

    /** A tick-box line for a dropdown: the Status filter's and the gear's. */
    function tickOption(action, value, checked, content, count) {
        const row = el('label', 'export-option compare-status-option');
        const box = el('input');
        box.type = 'checkbox';
        box.value = value;
        box.checked = checked;
        box.setAttribute('data-change', action);
        row.appendChild(box);
        row.appendChild(content);
        if (count !== undefined) row.appendChild(el('span', 'tab-count', count));
        return { row, box };
    }

    /*
     * Each line: a tick box (show or hide it), an Only radio (that line alone; on the line already
     * alone, every line back), its pill and its count. Nothing else on the line is a control.
     */
    function renderStatusMenu() {
        const options = filterOptions();
        const on = options.filter(o => ticked(o.value)).length;
        // Hiding only ever adds Same, so only DIFF and Missing say "of"
        const count = o => (o.n === o.of ? o.n.toLocaleString() : `${o.n.toLocaleString()} of ${o.of.toLocaleString()}`);
        const pill = o => {
            if (o.place === undefined) return el('span', `status-pill-generic compare-${o.value}`, o.value === 'diff' ? 'DIFF' : 'Same');
            const box = el('span', 'compare-status');
            box.appendChild(el('span', 'status-pill-generic compare-missing', 'Missing'));
            box.appendChild(tag(o.place));
            return box;
        };
        const name = o => (o.place === undefined ? (o.value === 'diff' ? 'DIFF' : 'Same') : `Missing ${letter(o.place)}`);
        const line = (o, i) => {
            const alone = on === 1 && ticked(o.value);
            const row = el('div', 'compare-status-line');
            const tickCell = el('label', 'compare-status-control compare-status-tick');
            tickCell.title = `Show ${name(o)}`;
            const box = el('input');
            box.type = 'checkbox';
            box.id = `compareStatusTick${i}`;
            box.value = o.value;
            box.checked = ticked(o.value);
            box.setAttribute('data-change', 'compare:statusKind');
            tickCell.appendChild(box);
            const onlyCell = el('label', alone ? 'compare-status-control compare-status-only is-alone' : 'compare-status-control compare-status-only');
            onlyCell.title = alone ? 'Show every line again' : `Only ${name(o)}`;
            const radio = el('input');
            radio.type = 'radio';
            radio.name = 'compareStatusOnly';
            radio.checked = alone;
            radio.setAttribute('aria-label', onlyCell.title);
            radio.setAttribute('data-click', 'compare:statusOnly');
            radio.setAttribute('data-arg', o.value);
            onlyCell.appendChild(radio);
            const label = el('label', 'compare-status-name');
            label.htmlFor = box.id;
            label.title = tickCell.title;
            label.appendChild(pill(o));
            row.append(tickCell, onlyCell, label, el('span', 'compare-status-count', count(o)));
            return row;
        };
        const head = el('div', 'compare-status-line compare-status-heading');
        head.append(el('span', '', 'Show'), el('span', '', 'Only'));
        const gone = (ui.allCounts.diff || 0) - (ui.counts.diff || 0);
        const parts = [head, ...options.map(line)];
        if (gone > 0) parts.push(el('p', 'compare-menu-note', `${gone.toLocaleString()} DIFF ${gone === 1 ? 'row is' : 'rows are'} only in hidden results or columns.`));
        $('compareStatusMenu').replaceChildren(...parts);
    }
    /** A dropdown under the button that opened it, outside the grid's scroll box so the grid never clips it. */
    function openMenu(id, button, alignRight) {
        const menu = $(id);
        const opening = !menu.classList.contains('show');
        closeMenus();
        if (!opening) return false;
        const r = button.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = `${r.bottom + 4}px`;
        if (alignRight) { menu.style.left = 'auto'; menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`; }
        else { menu.style.left = `${Math.max(8, r.left - 8)}px`; menu.style.right = 'auto'; }
        menu.classList.add('show');
        button.setAttribute('aria-expanded', 'true');
        return true;
    }
    function closeMenus() {
        ['compareStatusMenu', 'compareColumnsMenu', 'compareResultMenu', 'compareRelationMenu'].forEach(id => $(id).classList.remove('show'));
        document.querySelectorAll('[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    }
    function setFilter(filter) {
        ui.filter = filter;
        renderStatusMenu();
        requestRows(true);
    }

    /* The gear: which columns show. A hidden column is not compared; the View is not touched. */
    function comparedColumns() { return ui.result ? ui.result.compareColumns : []; }
    /** Results' columns: the compared ones, then those shown only (Don't compare on the Compare step). */
    function resultColumns() { return ui.result ? ui.result.compareColumns.concat(ui.result.shownColumns || []) : []; }
    function isShownOnly(id) { return !!ui.result && (ui.result.shownColumns || []).includes(id); }
    /** The columns in Compare, in the order dragged (new ones at the end). */
    function columnOrder() {
        const shown = resultColumns().filter(id => !ui.hidden.has(id));
        return ui.order.filter(id => shown.includes(id)).concat(shown.filter(id => !ui.order.includes(id)));
    }
    /*
     * "Diffs" hides a compared column no row differs in from the grid only: it is still
     * compared and counted, so it comes back as soon as a row differs in it (another result shown,
     * another Baseline). The key, shown-only columns and a column filtered on always show.
     */
    function hiddenUnchanged(id) {
        return ui.changedOnly && ui.columnDiffCounts[id] === 0 && !isShownOnly(id) && !ui.filter.columns.includes(id);
    }
    /** The columns the grid shows. */
    function orderedColumns() { return columnOrder().filter(id => !hiddenUnchanged(id)); }
    function renderColumnsMenu() {
        const cols = resultColumns();
        const shown = cols.filter(id => !ui.hidden.has(id)).length;
        const all = tickOption('compare:columnShow', 'all', shown === cols.length, el('span', '', '(Select all)'));
        all.box.indeterminate = shown > 0 && shown < cols.length;
        $('compareColumnsMenu').replaceChildren(
            all.row,
            el('div', 'export-option-divider'),
            ...cols.map(id => {
                const label = el('span', 'font-mono', columnName(id));
                if (isShownOnly(id)) label.appendChild(el('span', 'color-description', ' · show only'));
                return tickOption('compare:columnShow', id, !ui.hidden.has(id), label).row;
            }),
            el('p', 'compare-menu-note', 'An unticked column is removed from Compare.')
        );
    }
    function setHidden(hidden) {
        // One compared column always stays
        const cols = comparedColumns();
        if (cols.length && cols.every(id => hidden.has(id))) hidden.delete(cols[0]);
        ui.hidden = hidden;
        if (ui.sort && ui.hidden.has(ui.sort.column)) setSort(null, true);
        if (ui.filter.columns.some(c => hidden.has(c))) ui.filter = Object.assign({}, ui.filter, { columns: ui.filter.columns.filter(c => !hidden.has(c)) });
        renderColumnsMenu();
        recount();
    }
    /** The results or columns shown changed: the host counts every row again, then the grid follows. */
    function recount() {
        setBusy(true, 'Counting');
        post({ type: 'compare.lens', visible: [...ui.on], hidden: [...ui.hidden] });
        renderResultsBar();
    }

    /* ---------- The slots: BL, then C1 to C3, across the top of every step ----------
       Four, always the same size: an empty one is a dashed outline, an incomplete result a
       barber pole in its colour. On Select they show the picks as they are ticked; on Results
       each opens its menu (show or hide, make Baseline, open in the Console). */

    const INCOMPLETE = 'Not every page was fetched. Rows on the pages not fetched will look missing.';
    /** What fills the slots: on Select the picks as they stand, otherwise the results compared. */
    function slotRuns() {
        if (ui.step !== 1 || !ui.picks) return ui.sources;
        const byId = new Map(ui.runs.map(r => [r.id, r]));
        return [ui.picks.baselineId, ...ui.picks.ids].map(id => byId.get(id)).filter(Boolean);
    }
    function runWhen(place, list) {
        const runs = list || ui.sources;
        const r = runs[place];
        if (!r) return '';
        const d = new Date(r.executedAt);
        if (isNaN(d.getTime())) return '';
        // Seconds only when another result ran in the same minute
        const minute = x => Math.floor(new Date(x.executedAt).getTime() / 60000);
        const seconds = runs.some((x, i) => i !== place && minute(x) === minute(r));
        // The year only when it is not this one: the slots are narrow
        const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
        const time = d.toLocaleTimeString(undefined, seconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
        return `${day} · ${time}`;
    }
    /** "Staging 840 · 10 Nov 2026 · 07:04": what a result is called in the export and the record panel. */
    function resultLabel(place) {
        const r = ui.sources[place];
        return r ? `${placeName(r)} · ${runWhen(place)}` : letter(place);
    }
    function slot(place, runs) {
        const r = runs[place];
        const results = ui.step === RESULTS;
        if (!r) {
            const box = el('div', `compare-result ${tone(place)} is-empty`);
            const inner = el('div', 'compare-result-btn');
            inner.appendChild(el('span', 'compare-result-letter', letter(place)));
            inner.appendChild(el('span', 'compare-result-name', 'Empty'));
            if (ui.step === 1) inner.appendChild(el('span', 'compare-result-when', 'Tick a result'));
            box.appendChild(inner);
            return box;
        }
        const on = place === 0 || !results || ui.on.has(place);
        // A slot's menu from Match on (Select picks the results itself)
        const menu = ui.step > 1 && !!ui.sides;
        const box = el('div', `compare-result ${tone(place)}${on ? '' : ' is-off'}${r.incomplete ? ' is-incomplete' : ''}`);
        const b = el(menu ? 'button' : 'div', 'compare-result-btn');
        b.id = `compareResult${place}`;
        b.appendChild(el('span', 'compare-result-letter', letter(place)));
        b.appendChild(el('span', `compare-result-name${r.missing ? ' color-error' : ''}`, r.missing ? 'No longer in History' : placeName(r)));
        b.appendChild(el('span', 'compare-result-when', runWhen(place, runs)));
        // The full name, its rows and why it is incomplete: a narrow window shortens the slot
        const counted = runs === ui.sources && ui.sides && ui.sides.sides && ui.sides.sides[place];
        const lines = [`${letter(place)}${place === 0 ? ' (Baseline)' : ''}: ${placeName(r)} · ${runWhen(place, runs)}${counted ? ` · ${plural(counted.rows, 'row', 'rows')}` : ''}`];
        if (r.incomplete) lines.push(`Incomplete. ${INCOMPLETE}`);
        if (results && !on) lines.push('Hidden: not compared while hidden');
        if (menu) {
            b.type = 'button';
            b.setAttribute('aria-haspopup', 'menu');
            b.setAttribute('aria-expanded', 'false');
            b.setAttribute('data-click', 'compare:resultMenu');
            b.setAttribute('data-arg', String(place));
            b.appendChild(el('span', 'compare-result-caret', '▾'));
        }
        b.title = lines.join('\n');
        box.appendChild(b);
        return box;
    }
    function renderResultsBar() {
        const runs = slotRuns();
        const slots = [];
        for (let p = 0; p < Math.max(ui.max || 4, runs.length); p++) slots.push(slot(p, runs));
        $('compareResultButtons').replaceChildren(...slots);
    }
    /**
     * A slot's menu: make it the Baseline (BL: another result), open it in the Console, and on
     * Results show or hide it. Before Results every result is matched, so none hides.
     */
    function renderResultMenu(place) {
        const r = ui.sources[place] || {};
        const item = (label, action, arg, disabled, title) => {
            const o = el('button', 'export-option compare-baseline-option');
            o.type = 'button';
            o.setAttribute('role', 'menuitem');
            o.setAttribute('data-click', action);
            o.setAttribute('data-arg', String(arg));
            if (typeof label === 'string') o.appendChild(el('span', '', label)); else label.forEach(n => o.appendChild(n));
            if (disabled) o.disabled = true;
            if (title) o.title = title;
            return o;
        };
        const head = el('div', 'compare-menu-title');
        head.appendChild(tag(place));
        head.appendChild(el('span', '', placeName(r)));
        head.appendChild(el('span', 'compare-result-when', runWhen(place)));
        const items = [head];
        if (r.incomplete) {
            const warn = el('div', 'compare-menu-warning');
            warn.appendChild(el('span', 'status-pill-generic warning', 'Incomplete'));
            warn.appendChild(el('span', '', INCOMPLETE));
            items.push(warn);
        }
        const results = ui.step === RESULTS;
        if (place === 0) {
            const others = results ? [...ui.on].sort((a, b) => a - b) : ui.sources.map((_, p) => p).filter(p => p > 0);
            items.push(el('div', 'compare-menu-head', 'Make baseline'));
            others.forEach(p => items.push(item([tag(p), el('span', '', placeName(ui.sources[p] || {})), el('span', 'compare-result-when', runWhen(p))], 'compare:makeBaseline', p)));
            if (!others.length) items.push(el('p', 'compare-menu-note', 'Show another result to make it the Baseline.'));
        } else if (!results) {
            items.push(item('Make Baseline', 'compare:makeBaseline', place, false, `It swaps places with BL: it becomes BL, BL takes ${letter(place)}. The key is checked again`));
            const last = ui.sources.length <= 2;
            items.push(item('Remove from the compare', 'compare:removeResult', place, last, last ? 'BL needs one result to compare with' : 'The results after it move up a place. The key is checked again'));
        } else {
            const on = ui.on.has(place);
            items.push(on
                ? item(`Hide ${letter(place)}`, 'compare:toggleResult', place, ui.on.size === 1, ui.on.size === 1 ? 'One result stays beside BL' : 'It is not compared while hidden')
                : item(`Show ${letter(place)}`, 'compare:toggleResult', place));
            items.push(item('Make Baseline', 'compare:makeBaseline', place, !on, on ? `It swaps places with BL: it becomes BL, BL takes ${letter(place)}` : `Show ${letter(place)} first`));
        }
        items.push(item('Open in the Console', 'compare:openConsole', place));
        items.push(el('p', 'compare-menu-note', 'To compare other results, go back to Select.'));
        $('compareResultMenu').replaceChildren(...items);
    }

    function renderView() {
        ['side', 'compact'].forEach(v => {
            const b = $(v === 'side' ? 'compareViewSide' : 'compareViewCompact');
            b.classList.toggle('active', ui.resultsView === v);
            b.setAttribute('aria-pressed', String(ui.resultsView === v));
        });
    }
    /** All columns over Diffs, with how many columns the second one hides. */
    function renderChangedOnly() {
        [['compareColsAll', !ui.changedOnly], ['compareColsChanged', ui.changedOnly]].forEach(([id, on]) => {
            $(id).classList.toggle('active', on);
            $(id).setAttribute('aria-pressed', String(on));
        });
        const unchanged = comparedColumns().filter(id => !ui.hidden.has(id) && ui.columnDiffCounts[id] === 0).length;
        $('compareColsChanged').title = unchanged
            ? `Hide the ${unchanged.toLocaleString()} compared ${unchanged === 1 ? 'column' : 'columns'} with no differences. They are still compared.`
            : 'Every compared column has a difference';
    }

    /** A filter's funnel, shown while it filters: a click clears that filter alone (the arrow opens its menu). */
    function funnelSign(which, arg) {
        const funnel = el('button', 'compare-funnel icon');
        funnel.type = 'button';
        funnel.setAttribute('data-icon', 'funnel');
        funnel.setAttribute('data-click', 'compare:clearFilter');
        funnel.setAttribute('data-arg', arg === undefined ? which : `${which}:${arg}`);
        funnel.title = 'Clear this filter';
        funnel.setAttribute('aria-label', funnel.title);
        return funnel;
    }
    /** Status's filter, as a spreadsheet's: the arrow opens it; a funnel after it while it filters. */
    /*
     * Relationship: how each row's key meets the results, in Match's pictures (the name on hover).
     * It shows once the rows have more than one (one to one and one to many, say), with a filter.
     */
    const RELATION_KINDS = ['oneToOne', 'oneToMany', 'onlyBase', 'onlyOther'];
    function relationName(kind, row) {
        if (kind === 'oneToMany') return `One to many: ${row && row.repeated ? `repeated in ${row.repeated.map(letter).join(', ')}; ` : ''}BL's record is compared with each`;
        return { oneToOne: 'One to one', onlyBase: 'Not in every result', onlyOther: 'Not in BL' }[kind];
    }
    function showRelations() {
        return !!ui.filter.relations || RELATION_KINDS.filter(k => ui.relationCounts[k] > 0).length > 1;
    }
    /** The relationship's heading: Match's picture for it, its filter's arrow, a funnel while it filters. */
    function relationHead(th) {
        th.classList.add('compare-relation-head');
        th.title = 'How each row\'s key meets the results';
        const name = th.querySelector('.column-name');
        if (name) { name.replaceChildren(glyph('oneToMany')); name.title = th.title; }
        const on = !!ui.filter.relations;
        const b = el('button', 'compare-head-btn icon');
        b.type = 'button';
        b.setAttribute('data-click', 'compare:relationMenu');
        b.setAttribute('aria-haspopup', 'dialog');
        b.setAttribute('aria-expanded', 'false');
        b.setAttribute('aria-label', on ? 'Filter relationship (active filter)' : 'Filter relationship');
        b.title = b.getAttribute('aria-label');
        b.setAttribute('data-icon', 'chevron-down');
        const actions = th.querySelector('.header-actions') || th;
        actions.appendChild(b);
        if (on) actions.appendChild(funnelSign('relation'));
    }
    /** As the Status filter: each line a tick-box, an Only button (on the line alone, every line back), the picture and its count. */
    function renderRelationMenu() {
        const shown = new Set(ui.filter.relations || RELATION_KINDS);
        const kinds = RELATION_KINDS.filter(k => ui.relationCounts[k] > 0);
        const on = kinds.filter(k => shown.has(k)).length;
        const head = el('div', 'compare-status-line compare-status-heading');
        head.append(el('span', '', 'Show'), el('span', '', 'Only'));
        const lines = kinds.map((k, i) => {
            const name = relationName(k);
            const alone = on === 1 && shown.has(k);
            const row = el('div', 'compare-status-line');
            const tickCell = el('label', 'compare-status-control compare-status-tick');
            tickCell.title = `Show ${name}`;
            const box = el('input');
            box.type = 'checkbox';
            box.id = `compareRelationTick${i}`;
            box.value = k;
            box.checked = shown.has(k);
            box.setAttribute('data-change', 'compare:relationKind');
            tickCell.appendChild(box);
            const onlyCell = el('label', alone ? 'compare-status-control compare-status-only is-alone' : 'compare-status-control compare-status-only');
            onlyCell.title = alone ? 'Show every line again' : `Only ${name}`;
            const radio = el('input');
            radio.type = 'radio';
            radio.name = 'compareRelationOnly';
            radio.checked = alone;
            radio.setAttribute('aria-label', onlyCell.title);
            radio.setAttribute('data-click', 'compare:relationOnly');
            radio.setAttribute('data-arg', k);
            onlyCell.appendChild(radio);
            const label = el('label', 'compare-status-name compare-relation-option');
            label.htmlFor = box.id;
            label.title = name;
            label.appendChild(glyph(k));
            row.append(tickCell, onlyCell, label, el('span', 'compare-status-count', (ui.relationCounts[k] || 0).toLocaleString()));
            return row;
        });
        $('compareRelationMenu').replaceChildren(head, ...lines);
    }
    /** Status's heading: its filter's arrow (a spreadsheet's), a funnel after it while it filters. It is filtered, not sorted. */
    function statusHead(th) {
        th.classList.add('compare-status-head');
        const on = isFiltered();
        const filter = el('button', 'compare-head-btn icon');
        filter.type = 'button';
        filter.setAttribute('data-click', 'compare:statusMenu');
        filter.setAttribute('aria-haspopup', 'dialog');
        filter.setAttribute('aria-expanded', 'false');
        filter.setAttribute('aria-label', on ? 'Filter Status (active filters)' : 'Filter Status');
        filter.title = on ? 'Active filters' : 'Filter Status';
        filter.setAttribute('data-icon', 'chevron-down');
        const actions = th.querySelector('.header-actions') || th;
        actions.appendChild(filter);
        if (on) actions.appendChild(funnelSign('status'));
    }
    /** A compared column's count pill: click to show only rows that differ there (a funnel after it while on). */
    function columnFilterPill(id, n) {
        const on = ui.filter.columns.includes(id);
        const box = el('span', 'compare-col-filter');
        const pill = el('button', `tab-count compare-col-count${on ? ' is-active' : ''}`, n.toLocaleString());
        pill.type = 'button';
        pill.setAttribute('data-click', 'compare:columnFilter');
        pill.setAttribute('data-arg', id);
        pill.setAttribute('aria-pressed', String(on));
        pill.title = on ? `Showing only rows that differ in ${columnName(id)}. Click to stop` : `${n.toLocaleString()} rows differ in ${columnName(id)}. Click to show only those`;
        box.appendChild(pill);
        if (on) box.appendChild(funnelSign('column', id));
        return box;
    }
    /** The toolbar's filter button: lit while any filter is on, and clears them all. */
    function renderFilterButton() {
        const on = isFiltered() || ui.filter.columns.length > 0 || !!ui.filter.relations;
        const b = $('compareClearFilters');
        b.disabled = !on;
        b.classList.toggle('is-active', on);
        b.title = on ? 'Clear all filters' : 'No filters on';
    }

    /** The gear on the toolbar: lit while columns are removed from Compare. */
    function renderGear() {
        renderChangedOnly();
        const g = $('compareColumnsBtn');
        g.classList.toggle('is-active', ui.hidden.size > 0);
        g.title = ui.hidden.size ? `Columns: ${ui.hidden.size} removed from Compare` : 'Columns';
        g.setAttribute('aria-label', g.title);
    }
    /** Find is an icon until opened; it stays open while it has text. */
    function openSearch(open) {
        $('compareSearchBox').classList.toggle('is-open', open);
        $('compareSearchBtn').setAttribute('aria-expanded', String(open));
        if (open) $('compareSearch').focus();
    }

    /* ---------- The grid: the design system's table (shared/dbmn-table.js) ----------
     * The rows stay with the host and are asked for a page at a time as they scroll into view; the
     * table draws only the rows in view, holds each column's width, and moves, removes, sorts and
     * resizes from the headings, as every DBMN table does. Its columns: the key's (pinned), the
     * relationship and Status (pinned; filtered from their headings, not sorted), then each column
     * in Compare: Side by side, a group over one column per result shown (BL, C1…), each sorting by
     * that result's values; Compact, one column. A column's id is `<column>|<place>`, or
     * `<column>|` where it is not one result's: the key its width is kept by.
     */
    const table = $('compareGrid');
    const grid = { key: '', asked: 0, waiting: new Map() };
    function cellId(column, place) { return `${column}|${place === undefined ? '' : place}`; }
    /** A column id back to its column and result (undefined: not one result's); null for Status and the relationship. */
    function parseId(id) {
        const at = String(id).lastIndexOf('|');
        if (at < 0) return null;
        const rest = id.slice(at + 1);
        return { column: id.slice(0, at), place: rest === '' ? undefined : Number(rest) };
    }
    /** The table's sort as Compare's: { column, place, dir }. */
    function sortFrom(sort) {
        const at = sort && parseId(sort.id);
        if (!at) return null;
        return at.place === undefined ? { column: at.column, dir: sort.dir } : { column: at.column, place: at.place, dir: sort.dir };
    }
    function tableSort() { return ui.sort ? { id: cellId(ui.sort.column, ui.sort.place), dir: ui.sort.dir } : null; }
    const nothing = () => document.createDocumentFragment();
    // A value that is a list of records is compared and tinted like any other: never a table's "3 records"
    const asValue = { count: () => 0 };

    function tableColumns() {
        const side = ui.resultsView === 'side';
        const places = shownPlaces();
        const columns = ui.result.keyColumns.map((id, k) => ({
            id: cellId(id), name: columnName(id), pinned: true, className: 'compare-key-col', nested: asValue,
            render: (_v, row) => valueNode(row._key[k])
        }));
        if (showRelations()) {
            columns.push({
                id: 'relation', name: 'Relationship', pinned: true, sortable: false, className: 'compare-relation-cell',
                render: (_v, row) => glyph(row._c.relation),
                cell: (td, _v, row) => { td.title = relationName(row._c.relation, row._c); },
                head: relationHead
            });
        }
        columns.push({ id: 'status', name: 'Status', pinned: true, sortable: false, className: 'compare-status-cell', render: (_v, row) => statusNode(row._c.status), head: statusHead });
        orderedColumns().forEach(id => {
            const name = columnName(id);
            if (!side) {
                columns.push({ id: cellId(id), name, className: 'compare-first', nested: asValue, render: nothing, head: th => fieldHead(th, id), cell: (td, _v, row) => compactCellFor(td, row, id) });
                return;
            }
            const group = { id, name, className: `compare-field-head${isShownOnly(id) ? ' compare-shown-head' : ''}`, head: th => fieldHead(th, id) };
            places.forEach((p, i) => columns.push({
                id: cellId(id, p), name: letter(p), group, className: i ? '' : 'compare-first', nested: asValue, render: nothing,
                head: th => subHead(th, p), cell: (td, _v, row) => sideCell(td, row, id, p)
            }));
        });
        return columns;
    }
    /** A column's heading in Compare (a group's, Side by side): its count pill, which filters to the rows that differ there. */
    function fieldHead(th, id) {
        th.classList.add('compare-field-head');
        th.dataset.c = id;
        if (isShownOnly(id)) { th.classList.add('compare-shown-head'); return; }
        const n = ui.columnDiffCounts[id] || 0;
        if (!n && !ui.filter.columns.includes(id)) return;
        const name = th.querySelector('.column-name');
        (name || th).appendChild(columnFilterPill(id, n));
    }
    /** A result's heading under a column (Side by side): its letter on its colour; the whole of it sorts by that result's values. */
    function subHead(th, p) {
        th.classList.add('compare-sub', tone(p), 'compare-sort-all');
        th.addEventListener('click', event => {
            if (event.target.closest('.col-sort-btn, .col-edge')) return;
            const button = th.querySelector('.col-sort-btn');
            if (button) button.click();
        });
    }

    /**
     * Status keeps one width: the widest one line of Status can be with the results shown (DIFF and
     * every other result's letter, or Missing and every other's), measured off screen in the
     * grid's own styles. A row with DIFF and Missing wraps to two lines rather than widening the
     * column for a rare row. Measured from the rows drawn, it would be as wide as the first page's.
     */
    function statusWidth() {
        const others = shownPlaces().slice(1);
        const probe = el('div', 'compare-status-probe');
        [{ diff: others, missing: [] }, { diff: [], missing: others }].forEach(c => probe.appendChild(statusNode(c)));
        table.appendChild(probe);
        const widest = Math.max(0, ...[...probe.children].map(n => n.getBoundingClientRect().width));
        probe.remove();
        // (its cell's padding either side, and its border)
        return widest ? Math.ceil(widest) + 18 : 0;
    }
    /** What the columns are: drawn again only when that changes (the counts and filters in the headings are drawn again on their own). */
    function columnsKey() {
        return [ui.resultsView, shownPlaces().join(','), showRelations(), ui.result.keyColumns.join('\u0001'), orderedColumns().join('\u0001')].join('\u0002');
    }
    function drawTable() {
        if (!ui.result) return;
        const key = columnsKey();
        if (key === grid.key) { table.redrawHeads(); renderGear(); renderFilterButton(); return; }
        grid.key = key;
        table.columns = tableColumns();
        const widths = Object.assign({}, userWidths);
        const status = statusWidth();
        if (status) widths.status = status;
        table.layout = { widths, sort: tableSort() };
        renderGear();
        renderFilterButton();
    }
    /** The rows asked for again from the top (a filter, a search, a count); `false` is a resize, which the table follows itself. */
    function requestRows(reset) {
        if (!ui.result || reset === false) return;
        drawTable();
        grid.waiting.clear();
        if (!table.source) table.source = { page };
        else table.reload();
    }
    /** One page of rows, asked of the host: the answer comes back as compare.rowsPage. */
    function page(start, count, opts) {
        const requestId = ++grid.asked;
        const sort = opts && opts.sort ? sortFrom(opts.sort) : null;
        post({ type: 'compare.rows', requestId, filter: ui.filter, search: ui.search, sort, start, count });
        return new Promise(resolve => grid.waiting.set(requestId, resolve));
    }
    function rowsPage(m) {
        const resolve = grid.waiting.get(m.requestId);
        if (!resolve) return;
        grid.waiting.delete(m.requestId);
        const at = new Map(m.columns.map((id, i) => [id, i]));
        text($('compareShown'), m.total ? `${plural(m.total, 'row', 'rows')}` : 'No rows');
        resolve({ rows: m.rows.map(r => tableRow(r, at)), total: m.total });
    }
    /**
     * A row as the table holds it: the host's row (`_c`), and each column's value by its id, so the
     * table can tell numbers from text (its sort icon) and fit a column to what it holds. The cells
     * are drawn from the host's row.
     */
    function tableRow(c, at) {
        const places = shownPlaces();
        const src = places.map(p => c.values[p]).find(Boolean) || [];
        const row = { _c: c, _at: at, _key: src.slice(0, ui.result.keyColumns.length) };
        ui.result.keyColumns.forEach((id, k) => { row[cellId(id)] = src[k]; });
        resultColumns().forEach(id => {
            const ci = at.get(id);
            if (ci === undefined) return;
            places.forEach(p => {
                const values = c.values[p];
                if (!values) return;
                row[cellId(id, p)] = values[ci];
                if (!(cellId(id) in row)) row[cellId(id)] = values[ci];
            });
        });
        return row;
    }
    function keyText(row) { return row._key.map(v => (v && typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' + '); }

    // The table says what was done to its headings; Compare keeps it with the compare
    table.addEventListener('dbmn-table-layout', event => {
        const d = event.detail || {};
        if (!ui.result) return;
        if (d.change === 'sorted') {
            ui.sort = sortFrom(d.layout && d.layout.sort);
            post({ type: 'compare.layout', sort: ui.sort });
        } else if (d.change === 'moved') {
            // The columns shown in their new order; those Diffs hides keep their places among them
            const shown = [];
            (d.layout.order || []).forEach(id => {
                const at = parseId(id);
                if (at && !ui.result.keyColumns.includes(at.column) && !shown.includes(at.column)) shown.push(at.column);
            });
            const on = new Set(shown);
            let k = 0;
            ui.order = columnOrder().map(id => (on.has(id) ? shown[k++] : id));
            grid.key = columnsKey();
            post({ type: 'compare.layout', columnOrder: ui.order });
        } else if (d.change === 'removed') {
            const hidden = new Set(ui.hidden);
            (d.ids || [d.id]).forEach(id => { const at = parseId(id); hidden.add(at ? at.column : id); });
            setHidden(hidden);
        } else if (d.change === 'resized' && d.width) {
            userWidths[d.id] = d.width;
            post({ type: 'compare.layout', columnWidths: userWidths });
        }
    });
    // A click on a row opens its record, and so does a right-click anywhere on it (a long value's own click opens just that value)
    table.rowClass = () => 'cursor-pointer compare-row';
    table.addEventListener('dbmn-table-row', event => post({ type: 'compare.record', index: Number(event.detail.row._c.index) }));
    table.addEventListener('dbmn-table-row-menu', event => post({ type: 'compare.record', index: Number(event.detail.row._c.index) }));
    table.emptyText = () => (ui.search ? 'No rows match the search.' : isFiltered() || ui.filter.columns.length || ui.filter.relations ? 'No rows match the filters.' : 'Nothing here.');

    /** First click ascending, then descending, then back to the compare's own order. Saved with the compare. */
    function setSort(next, quiet) {
        ui.sort = next;
        post({ type: 'compare.layout', sort: next });
        if (!quiet) requestRows(true);
    }

    /* ---------- The grid's rows ---------- */

    /** A value as the grid shows it. Where two values read alike, the type tells them apart. */
    function valueNode(value, showType) {
        if (value === null) return el('span', 'color-description', 'null');
        // A field the record does not have (the host's marker; a message can't carry undefined)
        if (value === undefined || (value && typeof value === 'object' && value.$dbmnMissing === true)) return el('span', 'color-description', 'missing');
        if (typeof value === 'object') return el('span', 'font-mono', JSON.stringify(value));
        if (typeof value === 'string') {
            if (value === '') return el('span', 'color-description', 'blank');
            return el('span', '', showType || /^\s|\s$/.test(value) ? JSON.stringify(value) : value);
        }
        return el('span', '', String(value));
    }
    function readsAlike(a, b) {
        const s = v => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));
        return s(a) === s(b);
    }

    /** Whether a result's value is one that differs (Side by side tints it): unlike BL's, or BL's when BL is the odd one out. */
    function cellDiffers(status, groups, place, places) {
        if (!status.diff.includes(place) || groups[place] < 0) return false;
        if (place === 0) {
            const other = places.find(q => q !== 0 && groups[q] >= 0);
            return other !== undefined && groups[0] !== groups[other];
        }
        return groups[0] >= 0 && groups[place] !== groups[0];
    }

    /**
     * Compact: the value most results hold, plain, when BL has the record and one value is held
     * by more results than any other; every other value in a pill naming who holds it, in the
     * first one's colour. With BL and one other, the pill needs no letter.
     */
    function compactCell(td, row, groups, ci, places) {
        const list = [];
        places.forEach(p => {
            const g = groups[p];
            if (g < 0) return;
            const found = list.find(x => x.g === g);
            if (found) found.who.push(p); else list.push({ g, who: [p], v: row.values[p][ci] });
        });
        const pair = places.length === 2;
        const showType = item => list.some(o => o !== item && readsAlike(o.v, item.v));
        const pill = item => {
            const box = el('span', `compare-pill ${tone(item.who[0])}${pair ? ' is-bare' : ''}`);
            if (!pair) {
                const who = el('span', 'compare-pill-who');
                item.who.forEach(p => who.appendChild(tag(p)));
                box.appendChild(who);
            }
            box.appendChild(valueNode(item.v, showType(item)));
            return box;
        };
        if (!list.length) return td;
        if (list.length === 1 && groups[0] >= 0) { td.appendChild(valueNode(list[0].v)); td._oneValue = { v: list[0].v }; return td; }
        let plain = null;
        if (pair) plain = list.find(x => x.who.includes(0)) || null;
        else if (groups[0] >= 0) {
            const big = Math.max(...list.map(x => x.who.length));
            const tops = list.filter(x => x.who.length === big);
            if (tops.length === 1) plain = tops[0];
        }
        list.forEach(item => {
            if (item === plain) {
                const v = valueNode(item.v, showType(item));
                v.classList.add('compare-plain');
                td.appendChild(v);
            } else td.appendChild(pill(item));
        });
        return td;
    }

    /** One result's value under a column (Side by side): tinted where it differs; empty where the result has no record for the key. */
    function sideCell(td, row, id, p) {
        const c = row._c;
        const ci = row._at.get(id);
        const values = c.values[p];
        if (ci === undefined) return;
        // A result with no record for this key: an empty cell (its Missing pill says so)
        if (!values) { td.classList.add('compare-no-record'); return; }
        const title = `${keyText(row)}: ${columnName(id)} · ${letter(p)}`;
        // A column shown, not compared: as it is, never tinted
        if (isShownOnly(id)) {
            td.classList.add('compare-shown-cell');
            td.appendChild(valueNode(values[ci]));
            holdValue(td, values[ci], title);
            return;
        }
        const places = shownPlaces();
        const groups = c.groups[ci - ui.result.keyColumns.length] || [];
        const differs = cellDiffers(c.status, groups, p, places);
        if (differs) td.classList.add('compare-differs', tone(p));
        const others = places.filter(q => q !== p && c.values[q]).map(q => c.values[q][ci]);
        td.appendChild(valueNode(values[ci], differs && others.some(v => readsAlike(v, values[ci]))));
        holdValue(td, values[ci], title);
    }
    /** A column's cell in Compact: the values, who holds each (compactCell); a column shown, not compared: BL's, or the first result's with a record. */
    function compactCellFor(td, row, id) {
        const c = row._c;
        const ci = row._at.get(id);
        if (ci === undefined) return;
        const places = shownPlaces();
        const title = `${keyText(row)}: ${columnName(id)}`;
        if (isShownOnly(id)) {
            td.classList.add('compare-shown-cell');
            const p = places.find(q => c.values[q]);
            if (p === undefined) return;
            if (p !== 0) td.appendChild(tag(p));
            td.appendChild(valueNode(c.values[p][ci]));
            holdValue(td, c.values[p][ci], `${title} · ${letter(p)}`);
            return;
        }
        compactCell(td, c, c.groups[ci - ui.result.keyColumns.length] || [], ci, places);
        // One value (every result alike): it can open in full; several open the record
        if (td._oneValue) holdValue(td, td._oneValue.v, title);
    }
    /*
     * A long value opens in full: a long one, or one that is structured (JSON, a list or object,
     * BASE64, ZPL), opens the cell value window (shared/cell-detail.js) on a click, as in every
     * table (the table opens it). Any other cell opens the record; so does a right-click anywhere
     * on a row.
     */
    function holdValue(td, value, title) {
        if (value === undefined || (value && typeof value === 'object' && value.$dbmnMissing === true)) return;
        const raw = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
        // (the value as it is, not as shown, and what it is: for the window, should it be cut off on screen)
        td.dataset.full = raw;
        td.dataset.title = title;
        if (raw.length > 20) td.title = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
        if (raw.length <= 60 && !(window.CellDetail && window.CellDetail.worthOpening(raw))) return;
        td.classList.add('cell-expandable');
        td.title = raw.length > 300 ? `${raw.slice(0, 300)}… (click to view full)` : `${raw} (click to view full)`;
    }

    /* ---------- One record, every View column, each result shown side by side ---------- */

    /** A result's heading in the record window: its letter and name on its tint. */
    function recordHead(p) {
        const th = el('th', `compare-sub compare-record-head ${tone(p)}`);
        th.appendChild(el('strong', '', letter(p)));
        th.appendChild(document.createTextNode(` ${resultLabel(p)}`));
        return th;
    }
    const isMissing = v => v === undefined || (v && typeof v === 'object' && v.$dbmnMissing === true);

    /**
     * How a field is marked in the record window: 'compared' when the compare found it differs;
     * 'uncompared' when the user asked to see every difference and the results hold different
     * values in a column not compared (exactly as held: 100 and "100" differ); else ''.
     */
    function fieldMark(f) {
        if (f.differs) return 'compared';
        if (!ui.recordAll || f.role === 'key') return '';
        const held = f.values.filter(vals => vals.length).map(vals => JSON.stringify(vals.map(v => (isMissing(v) ? null : v))));
        return new Set(held).size > 1 ? 'uncompared' : '';
    }
    const markClass = mark => (mark === 'compared' ? 'highlight-cell' : mark === 'uncompared' ? 'compare-uncompared-diff' : '');

    /** The record window's Table: a row per column, a column per result. */
    function recordTable(m) {
        const table = el('table', 'data-table');
        const head = el('tr');
        head.appendChild(el('th', '', 'Column'));
        m.places.forEach(p => head.appendChild(recordHead(p)));
        head.appendChild(el('th'));
        const thead = el('thead');
        thead.appendChild(head);
        table.appendChild(thead);
        const body = el('tbody');
        m.fields.forEach(f => {
            const tr = el('tr');
            const mark = fieldMark(f);
            tr.appendChild(el('td', 'font-mono', f.name));
            f.values.forEach(values => {
                const td = el('td', markClass(mark));
                if (!values.length) td.appendChild(el('span', 'color-description', 'no row'));
                values.forEach((v, i) => { if (i) td.appendChild(el('br')); td.appendChild(valueNode(v, f.differs)); });
                tr.appendChild(td);
            });
            const role = { key: 'Key', strict: 'Compared', relaxed: 'Compared, Relaxed', shown: 'Not compared', notCompared: 'Not compared' }[f.role];
            tr.appendChild(el('td', 'color-description', role));
            body.appendChild(tr);
        });
        table.appendChild(body);
        return table;
    }

    /**
     * Each result's record as its system sent it, lined up side by side: a JSON line per field
     * (nested ones too), in the order the first result has them, so the same field sits on the same
     * line in every result. A field a result lacks leaves its line blank. Values are as sent,
     * never reformatted; only the key order can follow another result's to line them up.
     */
    const ABSENT = {};
    function alignedJson(roots) {
        const lines = [];
        const isObj = v => v !== ABSENT && v !== null && typeof v === 'object' && !Array.isArray(v);
        const pad = depth => '  '.repeat(depth);
        const walk = (vals, path, depth, label, comma) => {
            const present = vals.filter(v => v !== ABSENT);
            const allObj = present.length && present.every(isObj);
            const allArr = present.length && present.every(Array.isArray);
            const keys = [];
            if (allObj) present.forEach(o => Object.keys(o).forEach(k => { if (!keys.includes(k)) keys.push(k); }));
            const length = allArr ? Math.max(...present.map(x => x.length)) : 0;
            if ((allObj && keys.length) || (allArr && length)) {
                const [open, close] = allObj ? ['{', '}'] : ['[', ']'];
                lines.push({ path, cells: vals.map(v => (v === ABSENT ? '' : `${pad(depth)}${label}${open}`)) });
                const members = allObj ? keys : Array.from({ length }, (_, i) => i);
                const has = (v, m) => v !== ABSENT && (allObj ? Object.prototype.hasOwnProperty.call(v, m) : m < v.length);
                const lastOf = vals.map(v => members.filter(m => has(v, m)).pop());
                members.forEach(m => walk(
                    vals.map(v => (has(v, m) ? v[m] : ABSENT)),
                    allObj ? (path ? `${path}.${m}` : String(m)) : `${path}[${m}]`,
                    depth + 1,
                    allObj ? `${JSON.stringify(m)}: ` : '',
                    vals.map((v, i) => has(v, m) && m !== lastOf[i])
                ));
                lines.push({ path, cells: vals.map((v, i) => (v === ABSENT ? '' : `${pad(depth)}${close}${comma[i] ? ',' : ''}`)) });
                return;
            }
            // A value: as sent (an object or list a result holds where another has a plain value, whole)
            const held = new Set(vals.map(v => (v === ABSENT ? '\u0000absent' : JSON.stringify(v))));
            lines.push({
                path,
                leaf: true,
                differs: held.size > 1,
                cells: vals.map((v, i) => (v === ABSENT ? ''
                    : `${pad(depth)}${label}${JSON.stringify(v, null, 2).replace(/\n/g, `\n${pad(depth)}`)}${comma[i] ? ',' : ''}`)),
            });
        };
        walk(roots, '', 0, '', roots.map(() => false));
        return lines;
    }

    /** The record window's JSON: each record as sent, the lines that differ tinted (DIFF: Selected or All). */
    function recordJson(m) {
        const table = el('table', 'data-table compare-json');
        const head = el('tr');
        // Each result an equal share of the width (more only when its lines need it)
        m.places.forEach(p => { const th = recordHead(p); th.style.width = `${100 / m.places.length}%`; head.appendChild(th); });
        const thead = el('thead');
        thead.appendChild(head);
        table.appendChild(thead);
        const body = el('tbody');
        const raw = m.raw || m.places.map(() => []);
        // Several records for one key: each result's records as a list
        const several = raw.some(records => records.length > 1);
        const roots = raw.map(records => (!records.length || records[0] === undefined ? ABSENT : several ? records : records[0]));
        // The compared columns the compare found differing, by where they sit in the record
        const found = m.fields.filter(f => f.differs && f.path).map(f => f.path);
        const inFound = path => {
            const rel = several ? path.replace(/^\[\d+\]\.?/, '') : path;
            return found.some(p => rel === p || rel.startsWith(`${p}.`) || rel.startsWith(`${p}[`));
        };
        const lines = roots.every(r => r === ABSENT) ? [] : alignedJson(roots);
        lines.forEach((line, i) => {
            const mark = !line.leaf || !line.differs ? '' : inFound(line.path) ? 'compared' : ui.recordAll ? 'uncompared' : '';
            const tr = el('tr');
            line.cells.forEach((text, v) => {
                const none = roots[v] === ABSENT;
                const td = el('td', `compare-json-line${none ? ' color-description' : mark ? ` ${markClass(mark)}` : ''}`, none && i === 0 ? 'no record' : text);

                tr.appendChild(td);
            });
            body.appendChild(tr);
        });
        if (!lines.length) {
            const tr = el('tr');
            m.places.forEach(() => tr.appendChild(el('td', 'compare-json-line color-description', 'no record')));
            body.appendChild(tr);
        }
        table.appendChild(body);
        return table;
    }

    function recordDetail(m) {
        const wrap = el('div', 'compare-record');
        const toggle = el('div', 'toggle-group compare-record-toggle');
        toggle.setAttribute('role', 'group');
        toggle.setAttribute('aria-label', 'Show the record as');
        const box = el('div', 'table-container');
        const show = view => {
            ui.recordView = view;
            toggle.querySelectorAll('button').forEach(b => {
                b.classList.toggle('active', b.dataset.view === view);
                b.setAttribute('aria-pressed', String(b.dataset.view === view));
            });
            box.replaceChildren(view === 'json' ? recordJson(m) : recordTable(m));
        };
        [['table', 'Table', 'The View\'s columns'], ['json', 'JSON', 'Each record as its system sent it']].forEach(([view, label, title]) => {
            const b = el('button', 'toggle-btn', label);
            b.type = 'button';
            b.title = title;
            b.dataset.view = view;
            b.addEventListener('click', () => show(view));
            toggle.appendChild(b);
        });
        // DIFF: Selected marks what the compare found in its compared columns; All also marks what
        // differs in the columns it leaves out (ids, timestamps...)
        const all = el('div', 'compare-record-all');
        all.appendChild(el('span', 'compare-record-label', 'DIFF'));
        const which = el('div', 'toggle-group');
        which.setAttribute('role', 'group');
        which.setAttribute('aria-label', 'Mark differences in');
        const markWhich = () => which.querySelectorAll('button').forEach(b => {
            const on = (b.dataset.all === 'true') === ui.recordAll;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        [['true', 'All', 'Every column that differs, compared or not'], ['false', 'Selected', 'Only the columns compared']].forEach(([v, label, title]) => {
            const b = el('button', 'toggle-btn', label);
            b.type = 'button';
            b.dataset.all = v;
            b.title = title;
            b.addEventListener('click', () => { ui.recordAll = v === 'true'; markWhich(); show(ui.recordView); });
            which.appendChild(b);
        });
        markWhich();
        all.appendChild(which);
        const bar = el('div', 'compare-record-bar');
        bar.appendChild(toggle);
        // DIFF needs two records to compare: hidden when only one result has this record
        const records = m.places.filter((_, v) => m.fields.some(f => f.values[v] && f.values[v].length));
        if (records.length > 1) bar.appendChild(all);
        wrap.appendChild(bar);
        wrap.appendChild(box);
        show(ui.recordView);
        const key = m.fields.filter(f => f.role === 'key').map(f => f.values.map(v => v[0]).find(v => v !== undefined)).join(' + ');
        window.DbmnModal.show({
            title: `${key || 'Record'}: ${statusText(m.status)}`,
            body: wrap,
            size: 'large',
            maximisable: true,
            actions: [{ id: 'close', label: 'Close', variant: 'secondary' }]
        });
    }

    /* ---------- Messages from the controller ---------- */

    function applyCounts(m) {
        ui.counts = m.counts || {};
        ui.allCounts = m.allCounts || ui.counts;
        ui.columnDiffCounts = m.columnDiffCounts || {};
        ui.relationCounts = m.relationCounts || {};
        if (m.visible) ui.on = new Set(m.visible.filter(p => p > 0));
    }

    window.addEventListener('message', event => {
        const m = event.data || {};
        switch (m.type) {
            case 'compare.named':
                ui.name = m.name || ui.name;
                $('compareName').value = ui.name;
                break;
            case 'compare.init':
                ui.name = m.name || '';
                $('compareName').value = ui.name;
                ui.endpoint = m.endpoint;
                ui.sources = m.sources || [];
                ui.runs = m.runs || [];
                ui.max = m.max || 4;
                ui.view = m.view || 'Root';
                ui.resultsView = m.resultsView === 'compact' ? 'compact' : 'side';
                ui.sides = null;
                ui.result = null;
                ui.profile = null;
                ui.reached = 1;
                ui.picked = null;
                ui.picks = null;
                ui.saved = m.setup || null;
                ui.savedCompared = !!m.compared;
                renderResultsBar();
                renderView();
                // Select waits for compare.openEdit. Otherwise the results are read on the way to
                // the step asked for (Results only when the compare has a setup to run)
                if (m.opens === 'select') { ui.work = null; ui.busy = false; showStep(1); }
                else if (ui.work) {
                    if (m.opens !== 'results' && ui.work.step === RESULTS) { ui.work.step = 2; ui.work.plan = ['read', 'match']; }
                    renderBar();
                } else if (m.opens === 'results') { startWork(RESULTS, ['read', 'match', 'compare']); showReading(); }
                else { startWork(2, ['read', 'match']); showReading(); }
                break;
            case 'compare.sources':
                // Another Baseline: the results swapped places (Match's samples are the new BL's)
                ui.sources = m.sources || ui.sources;
                if (ui.sides && m.samples) {
                    ui.sides.samples = m.samples;
                    if (m.sides) ui.sides.sides = m.sides;
                    renderKeyColumns();
                }
                renderResultsBar();
                break;
            case 'compare.openEdit':
                setBusy(false);
                openSelect();
                break;
            case 'compare.progress':
                progress(m);
                break;
            case 'compare.sides': {
                ui.sides = m;
                ui.view = m.view || ui.view;
                ui.compare = {};
                ui.relaxed = {};
                ui.showOnly = {};
                ui.result = null;
                ui.profile = null;
                ui.hidden = new Set(m.setup ? m.setup.hiddenColumns || [] : []);
                renderResultsBar();
                if (m.setup && m.setup.keyColumns.length) {
                    // The key and columns used last time are filled in; Match still checks the key
                    ui.keyColumns = m.setup.keyColumns.slice();
                    m.setup.compareColumns.forEach(c => { ui.compare[c] = true; });
                    m.setup.relaxedColumns.forEach(c => { ui.relaxed[c] = true; });
                    (m.setup.shownColumns || []).forEach(c => { ui.compare[c] = true; ui.showOnly[c] = true; });
                    ui.join = m.setup.join;
                    if (m.setup.missingColumns.length) {
                        window.DbmnToast && window.DbmnToast.warn(`The View no longer has ${m.setup.missingColumns.join(', ')}. Pick the key and columns again.`);
                    }
                } else {
                    ui.keyColumns = [];
                }
                ui.running = !!m.running;
                renderKeyColumns();
                renderMatch();
                if (ui.work) {
                    // Results only when they follow at once; otherwise Match, once its key is checked
                    if (!ui.running && ui.work.step === RESULTS) { ui.work.step = 2; ui.work.plan = ['read', 'match']; }
                    // No key to check: Match, to pick one
                    if (!ui.keyColumns.length) endWork(2);
                    else renderBar();
                } else showStep(2);
                // The key used last time is checked at once
                if (ui.keyColumns.length) checkKey();
                break;
            }
            case 'compare.matchGroup':
                matchGroup(m);
                break;
            case 'compare.matchProfile':
                if (JSON.stringify(m.keyColumns) !== JSON.stringify(ui.keyColumns)) break;
                ui.profile = { pairs: m.pairs || [], ok: !!m.ok };
                renderMatch();
                // Checked: Match is ready, or Compare when it was asked for and the key pairs one to
                // one (on the way to Results, the compare goes on)
                if (ui.work && ui.work.step === 2) endWork(2);
                else if (ui.work && ui.work.step === 3) endWork(m.ok ? 3 : 2);
                else renderBar();
                break;
            case 'compare.result': {
                ui.running = false;
                applyCounts(m);
                ui.rowCounts = m.rowCounts || [];
                ui.hidden = new Set(m.hiddenColumns || []);
                ui.order = m.columnOrder || [];
                userWidths = Object.assign({}, m.columnWidths);
                ui.sort = m.sort || null;
                if (m.join) ui.join = m.join;
                ui.result = {
                    keyColumns: ui.keyColumns.slice(),
                    compareColumns: ui.sides.columns.map(c => c.id).filter(id => !ui.keyColumns.includes(id) && isCompared(id)),
                    shownColumns: ui.sides.columns.map(c => c.id).filter(id => !ui.keyColumns.includes(id) && ui.compare[id] && ui.showOnly[id])
                };
                ui.reached = RESULTS;
                // A new compare: its columns drawn afresh, with the widths and sort kept with it
                grid.key = '';
                // Which rows sets where the Status filter starts
                ui.filter = filterForJoin(ui.join, shownPlaces());
                renderResultsBar();
                renderView();
                ui.busy = false;
                ui.work = null;
                showStep(RESULTS);
                break;
            }
            case 'compare.counts':
                setBusy(false);
                applyCounts(m);
                renderResultsBar();
                if ($('compareStatusMenu').classList.contains('show')) renderStatusMenu();
                renderBar();
                requestRows(true);
                break;
            case 'compare.rowsPage':
                rowsPage(m);
                break;
            case 'compare.recordDetail':
                recordDetail(m);
                break;
            case 'compare.exported':
                setBusy(false);
                break;
            case 'compare.cancelled':
                ui.running = false;
                endWork(ui.shown ? ui.step : ui.sides ? 2 : 1);
                break;
            case 'compare.error':
                ui.running = false;
                // Back to where the work started; Select when nothing is read yet
                if (ui.shown) endWork();
                else if (ui.sides) endWork(2);
                else { endWork(); openSelect(); }
                window.DbmnToast ? window.DbmnToast.error(m.message) : console.error(m.message);
                break;
        }
    });

    /* ---------- Actions ---------- */

    let searchTimer = null;
    // The compare's name, after the slots in the top row: renamed in place, the controller checks and answers (compare.named)
    $('compareName').addEventListener('dbmn-name-change', event => post({ type: 'compare.rename', name: event.detail.name }));

    window.DbmnActions.register({
        'compare:back': () => { if (!ui.busy && ui.step > 1) showStep(ui.step - 1); },
        'compare:next': () => next(),
        // A tick changes the key; the match is checked a moment after the last
        'compare:key': (_arg, _event, box) => {
            ui.keyColumns = box.checked ? ui.keyColumns.concat(box.value) : ui.keyColumns.filter(c => c !== box.value);
            // A key column is not compared
            if (box.checked) delete ui.compare[box.value];
            ui.profile = null;
            ui.result = null;
            renderMatch();
            scheduleCheck();
        },
        // Match's drill-in: open it on a kind of key, page through its values
        'compare:matchGroup': arg => {
            const [place, kind] = String(arg).split(':');
            ui.drill = { place: Number(place), kind, index: 0 };
            post({ type: 'compare.matchGroup', keyColumns: ui.keyColumns, place: Number(place), kind, index: 0 });
        },
        // A value's row in the drill-in: open or close its many side's records
        'compare:drillExpand': (n, _event, button) => {
            const detail = ui.drill && ui.drill.body && ui.drill.body.querySelector(`tr[data-detail="${n}"]`);
            if (!detail) return;
            const open = detail.classList.toggle('hidden') === false;
            button.setAttribute('aria-expanded', String(open));
            const icon = button.querySelector('.expand-icon');
            if (icon && window.Icons) icon.innerHTML = window.Icons.icon(open ? 'chevron-down' : 'chevron-right');
        },
        'compare:drillAlone': (_arg, _event, box) => {
            if (!ui.drill) return;
            ui.drill.alone = box.checked;
            post({ type: 'compare.matchGroup', keyColumns: ui.keyColumns, place: ui.drill.place, kind: ui.drill.kind, index: 0, alone: ui.drill.alone });
        },
        'compare:matchPage': step => {
            if (!ui.drill) return;
            post({ type: 'compare.matchGroup', keyColumns: ui.keyColumns, place: ui.drill.place, kind: ui.drill.kind, index: Math.max(0, ui.drill.index + Number(step) * 25), alone: !!ui.drill.alone });
        },
        'compare:column': (_arg, _event, box) => { ui.compare[box.value] = box.checked; ui.result = null; renderColumns(); },
        'compare:mode': (_arg, _event, select) => {
            const id = select.getAttribute('data-col');
            ui.relaxed[id] = select.value === 'relaxed';
            ui.showOnly[id] = select.value === 'none';
            ui.result = null;
            renderBar();
        },
        'compare:join': join => {
            ui.join = join;
            post({ type: 'compare.setJoin', join });
            // Results already there start again from the join's filter
            if (ui.result) ui.filter = filterForJoin(join, shownPlaces());
            renderJoin();
            renderBar();
        },
        'compare:changedOnly': arg => {
            const on = arg === 'changed';
            if (on === ui.changedOnly) return;
            ui.changedOnly = on;
            renderChangedOnly();
            drawTable();
        },
        'compare:view': view => {
            if (view === ui.resultsView) return;
            ui.resultsView = view;
            // Remembered for every compare
            post({ type: 'compare.setView', view });
            renderView();
            drawTable();
        },
        'compare:toggleResult': place => {
            const p = Number(place);
            closeMenus();
            if (ui.busy) return;
            if (ui.on.has(p)) {
                // One other result always stays
                if (ui.on.size === 1) return;
                ui.on.delete(p);
                if (ui.sort && ui.sort.place === p) setSort(null, true);
            } else {
                ui.on.add(p);
                // Its missing records show, unless Which rows leaves them out
                const start = filterForJoin(ui.join, [p]);
                if (start.missing.includes(p) && !ui.filter.missing.includes(p)) ui.filter = Object.assign({}, ui.filter, { missing: ui.filter.missing.concat(p) });
            }
            recount();
        },
        'compare:resultMenu': (place, event) => {
            renderResultMenu(Number(place));
            openMenu('compareResultMenu', event.target.closest('button'), false);
        },
        'compare:makeBaseline': place => {
            closeMenus();
            if (ui.busy) return;
            if (ui.step !== RESULTS) {
                // Before Results: the results swap places and the key ticked is checked again;
                // nothing is compared until Columns' Compare
                ui.result = null;
                ui.profile = null;
                if (ui.keyColumns.length) startWork(ui.step, ['match']);
                post({ type: 'compare.baseline', place: Number(place), keyColumns: ui.keyColumns });
                renderMatch();
                return;
            }
            if (ui.sort && ui.sort.place !== undefined) ui.sort = null;
            // Every result measured against the new BL: the key checked again, then compared
            startWork(RESULTS, ['match', 'compare']);
            post({ type: 'compare.baseline', place: Number(place) });
        },
        'compare:statusMenu': (_arg, event) => { if (openMenu('compareStatusMenu', event.target.closest('button'), false)) renderStatusMenu(); },
        'compare:statusKind': (_arg, _event, box) => {
            const f = { same: ui.filter.same, diff: ui.filter.diff, missing: ui.filter.missing.slice(), columns: ui.filter.columns, relations: ui.filter.relations };
            if (box.value === 'same' || box.value === 'diff') f[box.value] = box.checked;
            else {
                const p = Number(box.value.split(':')[1]);
                f.missing = box.checked ? f.missing.concat(p) : f.missing.filter(x => x !== p);
            }
            setFilter(f);
        },
        'compare:statusOnly': value => {
            const options = filterOptions();
            const alone = options.filter(o => ticked(o.value)).length === 1 && ticked(value);
            if (alone) return setFilter({ same: true, diff: true, missing: shownPlaces(), columns: ui.filter.columns, relations: ui.filter.relations });
            const missing = value.startsWith('missing:') ? [Number(value.split(':')[1])] : [];
            setFilter({ same: value === 'same', diff: value === 'diff', missing, columns: ui.filter.columns, relations: ui.filter.relations });
        },
        // A column's funnel: clear that filter alone
        'compare:clearFilter': arg => {
            const [which, ...rest] = String(arg).split(':');
            const id = rest.join(':');
            if (which === 'status') ui.filter = Object.assign({}, ui.filter, { same: true, diff: true, missing: shownPlaces() });
            else if (which === 'relation') ui.filter = Object.assign({}, ui.filter, { relations: null });
            else if (which === 'column') ui.filter = Object.assign({}, ui.filter, { columns: ui.filter.columns.filter(c => c !== id) });
            closeMenus();
            requestRows(true);
        },
        'compare:clearFilters': () => {
            ui.filter = { same: true, diff: true, missing: shownPlaces(), columns: [], relations: null };
            if ($('compareStatusMenu').classList.contains('show')) renderStatusMenu();
            requestRows(true);
        },
        // The Relationship filter: open it, tick a relationship on or off
        'compare:relationMenu': (_arg, event) => { if (openMenu('compareRelationMenu', event.target.closest('button'), false)) renderRelationMenu(); },
        'compare:relationOnly': kind => {
            const kinds = RELATION_KINDS.filter(k => ui.relationCounts[k] > 0);
            const shown = new Set(ui.filter.relations || RELATION_KINDS);
            const alone = kinds.filter(k => shown.has(k)).length === 1 && shown.has(kind);
            ui.filter = Object.assign({}, ui.filter, { relations: alone ? null : [kind] });
            renderRelationMenu();
            requestRows(true);
        },
        'compare:relationKind': (_arg, _event, box) => {
            const shown = new Set(ui.filter.relations || RELATION_KINDS);
            if (box.checked) shown.add(box.value); else shown.delete(box.value);
            ui.filter = Object.assign({}, ui.filter, { relations: shown.size === RELATION_KINDS.length ? null : RELATION_KINDS.filter(k => shown.has(k)) });
            renderRelationMenu();
            requestRows(true);
        },
        'compare:columnFilter': id => {
            const columns = ui.filter.columns.includes(id) ? ui.filter.columns.filter(c => c !== id) : ui.filter.columns.concat(id);
            ui.filter = Object.assign({}, ui.filter, { columns });
            requestRows(true);
        },
        'compare:columnsMenu': (_arg, event) => { renderColumnsMenu(); openMenu('compareColumnsMenu', event.target.closest('button'), false); },
        'compare:columnShow': (_arg, _event, box) => {
            const cols = resultColumns();
            if (box.value === 'all') return setHidden(new Set(box.checked ? [] : cols));
            const hidden = new Set(ui.hidden);
            if (box.checked) hidden.delete(box.value); else hidden.add(box.value);
            setHidden(hidden);
        },
        // The summary and the rows the screen shows now, as one workbook, always side by side
        'compare:export': () => {
            closeMenus();
            setBusy(true, 'Exporting');
            post({ type: 'compare.export', filter: ui.filter, search: ui.search, sort: ui.sort, names: ui.sources.map((_, p) => resultLabel(p)), columnOrder: orderedColumns() });
        },
        'compare:searchOpen': () => openSearch(true),
        'compare:record': index => post({ type: 'compare.record', index: Number(index) }),
        'compare:removeResult': place => {
            closeMenus();
            if (ui.busy || ui.sources.length <= 2) return;
            ui.result = null;
            ui.profile = null;
            if (ui.keyColumns.length) startWork(ui.step, ['match']);
            post({ type: 'compare.remove', place: Number(place), keyColumns: ui.keyColumns });
            renderMatch();
        },
        'compare:openConsole': place => { closeMenus(); post({ type: 'compare.openConsole', place: Number(place) }); }
    });

    if (window.SearchMatcher && window.SearchMatcher.followScroll) window.SearchMatcher.followScroll($('compareSearch'), $('compareSearchMirror'));
    // `@` in Find lists Results' columns, then the operators (search-matcher.js)
    if (window.SearchMatcher && window.SearchMatcher.attachColumnSuggest) {
        window.SearchMatcher.attachColumnSuggest({
            input: $('compareSearch'),
            headings: () => (ui.result ? [...ui.result.keyColumns, ...orderedColumns()].map(columnName) : [])
        });
    }
    $('compareSearch').addEventListener('input', function () {
        const value = this.value;
        // (an @name no column has shows red)
        window.SearchMatcher.renderHighlight($('compareSearchMirror'), value, ui.result ? [...ui.result.keyColumns, ...orderedColumns()].map(columnName) : undefined);
        if (searchTimer) clearTimeout(searchTimer);
        // A pause after the last key before searching: a word typed is one search, not one a letter
        searchTimer = setTimeout(() => { ui.search = value; requestRows(true); }, SEARCH_PAUSE);
    });
    // Find closes back to its icon when left empty
    $('compareSearch').addEventListener('blur', function () { if (!this.value) openSearch(false); });
    // A click outside an open menu closes it
    document.addEventListener('click', event => {
        // A click the menu itself handled has already redrawn it: the target is gone, not outside
        if (!event.target.isConnected) return;
        if (!event.target.closest('.export-dropdown, [data-click="compare:statusMenu"], [data-click="compare:columnsMenu"], [data-click="compare:resultMenu"], [data-click="compare:relationMenu"]')) closeMenus();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });
    window.addEventListener('resize', () => { if (ui.step === RESULTS) requestRows(false); });

    renderBar();
    if (window.Icons && window.Icons.injectIcons) window.Icons.injectIcons(document.body);
    post({ type: 'compare.ready' });
})();

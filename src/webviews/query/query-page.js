// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* Query's page script (query-page.ts builds the page). UI state only: the query runs in
 * QueryController, which holds every view's rows and sends one window of result rows at a time.
 * A file, not inline script, so the web app's CSP lets it run.
 *
 * Steps: Views (the results joined, each through a View), Join (FROM the first view, then a
 * LEFT JOIN or JOIN per view with its pairs in ON ... AND, its counts and relationship, and a
 * preview), Columns (tick and order), Results (search, sort, Distinct rows, the SQL). */
(function () {
    'use strict';
    const vscode = acquireVsCodeApi();
    // The Console's Chain dialog (console-chain.js) posts through window.vscode
    window.vscode = vscode;
    const $ = id => document.getElementById(id);
    // + Add a view / + Add a file move between steps (placeAdds): held here, so a redraw that takes their line away never loses them
    const ADDS = document.getElementById('queryAdds');
    const addsEl = id => ADDS.querySelector('#' + id);

    const STEPS = [{ label: 'Views' }, { label: 'Join' }, { label: 'Columns' }, { label: 'Results' }];
    const PANELS = ['queryViewsStep', 'queryJoinStep', 'queryColumnsStep', 'queryResultsStep'];
    const PAGE = 200;
    /** What fx offers: the one list of functions (Map's, the Join's and calculated columns'), from the host
     * (column-functions.ts, query.state's columnFunctions); `sql` is the function in pieces: 'x' the value, a piece a value
     * typed in, `kind: 'other'` another column or a value (James, 2026-11-25: one window, steps, no formulas). */
    const fnList = () => (ui.state && ui.state.columnFunctions) || [];
    const fnDefaults = () => (ui.state && ui.state.functionDefaults) || {};
    /** Shared classes: a SQL word, and quiet text. */
    const KW = 'font-mono font-bold font-size-12 text-link';
    /** A join's relationship: Compare's name and picture for it (relation-glyph.js). */
    /* How rows meet a joining view, a line each when there are any: [kind, its name, in the warning colour] */
    const KINDS = [
        ['oneToOne', 'One to one', false],
        ['manyToOne', 'Many to one', false],
        // (one to many is how a header meets its lines: said, not warned of)
        ['oneToMany', 'One to many', false],
        ['manyToMany', 'Many to many', true],
        ['onlyBase', 'No match', false],
        ['onlyOther', 'Not used', false]
    ];

    /** A view's name: what SQL takes without quotes, short enough for its slot (query-store's cleanViewName). */
    const NAME_MAX = 12;
    const NAME_RULE = `Letters, digits and _, a letter first, up to ${NAME_MAX}. The SQL and the search call the view this.`;
    function cleanName(text) { return String(text || '').replace(/[^A-Za-z0-9_]/g, '').replace(/^[^A-Za-z]+/, '').slice(0, NAME_MAX); }

    const ui = {
        step: 1,
        state: null,        // query.state: views, joins, columns, sql, total, preview
        sources: [],
        sourceViews: {},    // the Views each result's endpoint has, by endpoint id        // endpoints with results and Views, for Add a view
        busy: '',           // work under way, on the step bar
        reads: {},          // how far each view being read has got, by its id: { rows, done, total } (its Rows cell's bar)
        search: '',
        sort: null,         // { column, dir }
        totals: false,      // a total under each column of numbers
        // A compare's Results (query-compare-results.js): Compare's filters, its view, Diffs
        filter: { kinds: null, columns: [], relations: null, hidden: [] },
        resultsView: 'side',
        diffsOnly: false,
        rows: [],           // Results' rows loaded so far
        shown: 0,
        total: 0,
        seq: 0,
        loading: false,
        statsOpen: {},      // a join's stats shown, by its view
        // The plain join lines brought up (+ Add join, or a line he had) and not taken away; touched: one was added or taken
        // away, so the first line no longer comes by itself (query-join-rules.js joinLines; James, 2026-11-23)
        joinLines: new Set(),
        joinsTouched: false,
        joinCounts: null    // the Join step's counts, run by run (the host's query.joinCounts)
    };

    // The footer's steps (shared/dbmn-footer.js): shown what stands, they say which step was asked for
    const bar = $('queryStepper');
    bar.steps = STEPS;
    // (a step clicked while the page works waits: the other steps are drawn waiting too)
    bar.addEventListener('dbmn-step', event => { if (!ui.busy) goTo(event.detail.step); });

    function post(message) { vscode.postMessage(message); }
    function el(tagName, className, content) {
        const node = document.createElement(tagName);
        if (className) node.className = className;
        if (content !== undefined) node.textContent = content;
        return node;
    }
    function count(n) { return Number(n || 0).toLocaleString(); }
    /** A big figure made short for the footer's summary: 9,999 as it is, then 12K, 1.2M (the whole figure on hover). */
    function short(n) {
        const v = Number(n || 0);
        return v < 10000 ? v.toLocaleString() : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
    }
    /**
     * The lanes, as the grid draws them (dbmn-lanes): a view and its runs together (BL, C1, C2...)
     * in one lane, whatever order the saved query has them in; any other view a lane of its own.
     */
    function laneGroups() {
        const all = (ui.state && ui.state.views) || [];
        const out = [];
        const seen = new Set();
        all.forEach(v => {
            const head = v.runOf ? all.find(x => x.id === v.runOf) || v : v;
            if (seen.has(head.id)) return;
            const group = [head, ...all.filter(x => x.runOf === head.id && x !== head)];
            group.forEach(x => seen.add(x.id));
            out.push(group);
        });
        return out;
    }
    /** Every view, lane by lane (a view's runs beside it). */
    function views() { return laneGroups().flat(); }
    /** Set the grid's tracks on a lanes container: a lane per view, as wide as its runs. */
    /** The slots row's free places after the last view: the Add pair's, and empty ones to make three at the start. */
    function addPlaces() { return Math.max(1, 3 - views().length); }
    function applyLanes(box) {
        // (a gutter a bit narrower than dbmn-lanes' 230px, as James asked: its own option; each run at least a slot wide,
        // 200px, so slots never shrink and more views than fit scroll the row, as the mock has it (and "Pick a column"
        // is never cut); the end as wide as the free places it holds, each one slot wide, 8px apart)
        const places = addPlaces();
        if (box && window.DbmnLanes) window.DbmnLanes.apply(box, laneGroups().map(g => ({ runs: g.length })), { gutter: 180, run: 200, end: 6 + places * 200 + (places - 1) * 8 });
    }
    /** The lookup tables Translate values can read: { id, name, count, columns }. */
    function lookupTables() { return (ui.state && ui.state.lookupTables) || []; }
    function viewAt(id) { return views().findIndex(v => v.id === id); }
    function view(id) { return views().find(v => v.id === id); }
    /** A view's colour, the grid's (dbmn-lanes): its lane's (dbmn-view-N), and its run's in the lane (dbmn-run-N: BL the view's own). One colour function for slots, lines, the builder and Results. */
    function colour(id) {
        const groups = laneGroups();
        for (let li = 0; li < groups.length; li++) {
            const ri = groups[li].findIndex(v => v.id === id);
            if (ri >= 0) return `dbmn-view-${li % 6} dbmn-run-${ri}`;
        }
        return '';   // a calculated column, or a column of the user's own SQL
    }
    function day(iso) {
        const d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
    /** How old a view's data is: since its request ran, or its file was read. */
    function age(iso) {
        const then = new Date(iso).getTime();
        if (isNaN(then)) return '';
        const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
        const said = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
        if (minutes < 1) return 'just now';
        if (minutes < 60) return said(minutes, 'min');
        if (minutes < 60 * 24) return said(Math.round(minutes / 60), 'hour');
        const days = Math.round(minutes / (60 * 24));
        return days < 60 ? said(days, 'day') : said(Math.round(days / 30), 'month');
    }
    /** A view's age in words without "ago": "5 days". */
    function ageSpan(iso) { return age(iso).replace(/ ago$/, ''); }
    const AGE_WARN_DAYS = 7, AGE_OLD_DAYS = 30;
    /** How stale a view's data is: '' fresh, 'week' older than a week (a warning), 'month' older than a month (out of date). */
    function ageLevel(iso) {
        const then = new Date(iso).getTime();
        if (isNaN(then)) return '';
        const days = (Date.now() - then) / 86400000;
        return days > AGE_OLD_DAYS ? 'month' : days > AGE_WARN_DAYS ? 'week' : '';
    }
    function ageSays(v) {
        const level = ageLevel(v.executedAt);
        if (!level) return '';
        const fix = v.file ? 'Pick the file again on Views to bring it up to date.' : 'Read the newest result on Views to bring it up to date.';
        return `${level === 'month' ? 'Older than a month' : 'Older than a week'}: ${v.file ? 'read' : 'ran'} ${ageSpan(v.executedAt)} ago. ${fix}`;
    }
    /**
     * A result that did not fetch every page (a batch stopped before its last page, #23): its rows past it look
     * Missing in a compare. Said on its slot (a warning sign), in its menu's summary, and once as the query opens.
     */
    function isIncomplete(v) {
        return !!(v && !v.file && v.executionId && ((ui.sources || []).find(r => r.id === v.executionId) || {}).incomplete);
    }
    const INCOMPLETE_SAYS = 'Incomplete: not every page of this result was fetched, so rows on the pages it missed will look Missing.';
    function incompleteIcon(v) {
        if (!isIncomplete(v)) return null;
        const icon = el('span', 'query-age-icon query-age-week query-incomplete-icon');
        icon.dataset.icon = 'triangle-alert';
        icon.title = INCOMPLETE_SAYS;
        return icon;
    }
    /** The age's icon: a yellow triangle past a week, a red octagon past a month. Nothing when fresh. */
    function ageIcon(v) {
        const level = ageLevel(v.executedAt);
        if (!level) return null;
        const icon = el('span', `query-age-icon query-age-${level}`);
        icon.dataset.icon = level === 'month' ? 'octagon-x' : 'triangle-alert';
        icon.dataset.age = level;
        icon.title = ageSays(v);
        return icon;
    }
    function cellText(value) {
        if (value === null || value === undefined) return '';
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }

    /* ---------- Steps ---------- */

    function joinsReady() {
        const s = ui.state;
        // (a view not joined yet holds Next up: notJoined; a hidden one sits out and holds nothing up)
        return !!s && !s.error && s.views.some(v => !v.waiting && !v.error) && s.views.every(v => !v.error || v.off);
    }
    /** Columns left empty (the last column taken out, with no key): Results would show the column just removed. A compare always has its key. */
    const EMPTY_REPORT = 'Pick a column for the report first: nothing is in it.';
    // (through ui: the step bar can draw before the Columns step is made)
    function reportEmpty() { const c = ui.columnsStep; return !!(c && typeof c.isEmpty === 'function' && c.isEmpty()); }
    /**
     * Every view on show joined before Columns and Results: until then Next waits and says which view (James, 2026-11-23:
     * "unjoined or unselected columns should block"). A hidden view holds nothing up. The rule: query-join-rules.js.
     */
    function notJoined() { return window.QueryJoinRules ? window.QueryJoinRules.notJoined(ui.state) : ''; }
    function waitsFor(n) {
        if (n >= 2 && views().length === 0) return 'Views';
        if (n >= 3 && (!joinsReady() || notJoined())) return 'Join';
        if (n >= 4 && reportEmpty()) return 'Columns';
        // A new query is walked through: a step opens once the one before it has been visited, so
        // Join and Columns are seen before Results (a view left unjoined still sits out and holds
        // nothing up). A saved query, opened again, has been through them: every step is open
        if (n > (ui.reached || 1) + 1) return STEPS[n - 2].label;
        return '';
    }
    function renderBar() {
        const states = STEPS.map((_, i) => {
            const n = i + 1;
            if (n === ui.step) return ui.busy ? { status: 'current', summary: ui.busy, checking: true } : { status: 'current', summary: '' };
            // While it works (reading the views, joining): the other steps wait, and look it (James, 2026-11-22)
            if (ui.busy) return { status: n < ui.step ? 'done' : 'pending', summary: '', title: 'Wait until this step is done' };
            if (n < ui.step) return { status: 'done', summary: '' };
            const blocked = waitsFor(n);
            if (!blocked) return { status: 'available', summary: '', title: `Go to ${STEPS[i].label}` };
            // (an empty report says what to do, in the footer's status, as the step bar's reason)
            const says = blocked === 'Columns' && reportEmpty() ? EMPTY_REPORT : blocked === 'Join' && notJoined() ? notJoined() : `Waits for ${blocked}`;
            return n === ui.step + 1 ? { status: 'blocked', waitsFor: blocked, summary: says } : { status: 'pending', summary: '' };
        });
        // What each step holds, for the list the folded steps open
        const said = stepSummaries();
        states.forEach((st, i) => { if (!st.summary || st.status === 'done') st.summary = said[i]; });
        bar.render(states, ui.step);
        // On Results the wizard is done: the steps fold into what is on screen (click it for the steps)
        // (the row count shortened when it is big: the whole figure shows on hover)
        const shown = ui.shownText && (ui.shownExact && ui.shownExact !== ui.shownText ? { text: ui.shownText, title: ui.shownExact } : ui.shownText);
        bar.summary = (hasStatus() ? compareSummary(shown) : [said[0], said[2], shown]).filter(Boolean);
        // (once its rows are in: until then Results shows as a step that is working, then the steps shrink away)
        bar.folded = ui.step === 4 && !!ui.settled && !!ui.arrived;
        const next = $('queryNextBtn');
        next.classList.toggle('hidden', ui.step === 4);
        // Results: what you do with the rows (Chain, Export) is the footer's Actions, where Next was
        $('queryActionsBtn').classList.toggle('hidden', ui.step !== 4);
        $('queryActionsBtn').disabled = !!ui.busy;
        next.textContent = ui.step < 4 ? `Next: ${STEPS[ui.step].label}` : 'Next';
        next.disabled = !!waitsFor(ui.step + 1) || !!ui.busy;
        next.title = ui.step === 3 && reportEmpty() ? EMPTY_REPORT : ui.step === 2 && notJoined() ? notJoined() : '';
        // (and on the Columns step itself, where the columns are put back)
        const emptyNote = $('queryColumnsEmpty');
        if (emptyNote) {
            emptyNote.hidden = !(ui.step === 3 && reportEmpty());
            if (!emptyNote.hidden && emptyNote.textContent !== EMPTY_REPORT) emptyNote.textContent = EMPTY_REPORT;
        }
        $('queryBackBtn').disabled = ui.step === 1 || !!ui.busy;
    }
    /** A line per step: its views, its joins, its columns, its rows. */
    function stepSummaries() {
        const s = ui.state;
        if (!s) return ['', '', '', ''];
        const many = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
        const within = s.views.filter(v => !v.waiting && !v.off && !v.error);
        const joined = (s.joins || []).filter(j => within.some(v => v.id === j.view)).length;
        const columns = (s.columns || []).length;
        return [
            many(within.length, 'view'),
            s.views.length > 1 ? many(joined, 'join') : '',
            columns ? many(columns, 'column') : '',
            ui.shownText || ''
        ];
    }
    /**
     * A compare's folded steps on Results say what it found (#29, as old Compare): its results, how many DIFF and how many
     * Missing (the Status menu's counts, among the rows the search finds), and the rows shown. Not its key (James,
     * 2026-11-23: "remove KEY from this summary").
     */
    function compareSummary(shown) {
        const s = ui.state;
        const c = ui.counts;
        const results = ((s.compare && s.compare.views) || []).filter(id => !ui.filter.hidden.includes(placeOfView(id))).length;
        const missing = c ? Object.values(c.missing || {}).reduce((a, b) => a + b, 0) : 0;
        return [
            `${count(results)} results`,
            c ? `${count(c.diff || 0)} Diff` : '',
            c ? `${count(missing)} missing` : '',
            shown
        ];
    }
    function placeOfView(id) { const v = view(id); return v ? (v.run || v.name) : id; }
    function goTo(n) {
        if (n < 1 || n > 4 || (n > ui.step && waitsFor(n))) return;
        if (n === 4 && ui.step !== 4) ui.arrived = false;
        ui.step = n;
        if (n > (ui.reached || 1)) post({ type: 'query.reached', step: n });
        ui.reached = Math.max(ui.reached || 1, n);
        PANELS.forEach((id, i) => $(id).classList.toggle('hidden', i + 1 !== n));
        $('queryResultsControls').classList.toggle('hidden', n !== 4);
        renderTop();
        renderReads();
        placeAdds();
        // Back on Views: its ages are as of now
        if (n === 1 && ui.state) renderViews();
        renderBar();
        updatePeek();
        if (n === 4) loadRows();
    }
    /** Results give the rows the whole height: the step bar folds into the peek strip (core.css),
     * as Compare's does. It comes back up while something runs, for its progress. */
    function updatePeek() {
        // (the footer stays on Results: its steps fold into the summary, and its buttons are still to hand)
        document.body.classList.remove('is-footer-peek');
    }

    /* ---------- The views, across the top and on Views ---------- */

    /** A view's name, asked for in a dialog. */
    async function renameView(v) {
        const body = el('div', 'dbmn-modal-field');
        const label = el('label', 'dbmn-modal-label', 'Name');
        const input = el('input', 'dbmn-modal-input');
        input.type = 'text';
        input.id = 'queryViewNameInput';
        label.htmlFor = input.id;
        input.value = v.name;
        input.maxLength = NAME_MAX;
        input.spellcheck = false;
        input.addEventListener('input', () => { const clean = cleanName(input.value); if (clean !== input.value) input.value = clean; });
        body.append(label, input, el('p', 'form-hint', NAME_RULE));
        const answer = await window.DbmnModal.show({
            title: `Rename ${v.name}`, body, size: 'sm',
            actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'ok', label: 'Rename', variant: 'primary' }]
        });
        if (answer.actionId === 'ok' && input.value && input.value !== v.name) post({ type: 'query.renameView', id: v.id, name: input.value });
    }

    /**
     * What a slot's click offers, on Views: its view moved to the first place or renamed, its
     * data brought up to date (the newest result read, or its file picked again), opened in the
     * Console, or removed.
     */
    /**
     * A view's summary, as its slot's menu shows it first: where it comes from, how old, how many rows. Given to
     * the menu once the menu takes a summary (DbmnContextMenu.takesSummary); till then the menu is the actions.
     */
    function slotSummary(v) {
        const lines = [];
        if (v.file) lines.push(['File', v.sheet ? `${v.file}, ${v.sheet}` : v.file]);
        else {
            lines.push(['Request', [v.system, v.request || v.endpointName].filter(Boolean).join(' · ')]);
            lines.push(['View', v.view || 'Top-level fields']);
            lines.push(['Result', v.environment || '']);
            (((ui.sources || []).find(r => r.id === v.executionId) || {}).header || []).forEach(h => lines.push([h.name, String(h.value)]));
        }
        const level = ageLevel(v.executedAt);
        lines.push(level ? { 0: v.file ? 'Read' : 'Ran', 1: `${day(v.executedAt)} · ${age(v.executedAt)}`, tone: 'warn' } : [v.file ? 'Read' : 'Ran', `${day(v.executedAt)} · ${age(v.executedAt)}`]);
        if (!v.reading) lines.push(['Rows', count(v.rows)]);
        if (isIncomplete(v)) lines.push({ 0: 'Pages', 1: 'Not every page was fetched: some rows will look Missing', tone: 'warn' });
        return { title: v.run ? `${v.run} · ${(view(v.runOf) || v).name}` : v.name, lines: lines.map(l => (Array.isArray(l) ? l : Object.assign([l[0], l[1]], { tone: l.tone }))) };
    }
    function withSummary(v, items) {
        if (!window.DbmnContextMenu || !window.DbmnContextMenu.takesSummary) return items;
        return [{ summary: slotSummary(v) }, ...(items.length ? [{ separator: true }] : []), ...items];
    }

    function slotMenu(event, v) {
        if (!window.DbmnContextMenu) return;
        const place = viewAt(v.id);
        const first = place === 0;
        // In a compare, the first view is its Baseline: any of the compare's views can be made it (#7, the joins follow);
        // a view outside the compare can't go first while the compare is there (the host refuses it too)
        const compare = ui.state && ui.state.compare;
        const inCompare = id => !compare || compare.views.includes(id);
        const all = views();
        const items = [
            ...(inCompare(v.id) ? [{ id: 'first', label: first ? (compare ? 'First: the Baseline' : 'First: every row is kept') : compare ? 'Make it the Baseline' : 'Move to first', icon: 'chevrons-left', disabled: first }] : []),
            // (what a drag of the slot does, for the keyboard)
            { id: 'left', label: 'Move left', icon: 'chevron-left', disabled: first || (place === 1 && !inCompare(v.id)) },
            { id: 'right', label: 'Move right', icon: 'chevron-right', disabled: place === all.length - 1 || (first && !!all[1] && !inCompare(all[1].id)) },
            { id: 'rename', label: 'Rename', icon: 'pencil' },
            // Out of the report without losing it or its joins
            { id: 'toggle', label: v.off ? 'Show in the query' : 'Hide from the query', icon: v.off ? 'eye' : 'eye-off' },
            { separator: true },
            ...(v.file
                ? [{ id: 'pick', label: 'Pick the file again', icon: 'upload' }]
                : [{ id: 'run', label: `Add another run of ${v.runOf ? (view(v.runOf) || v).name : v.name}`, icon: 'plus' },
                    // Its endpoint's other Views (a run reads through its view's)
                    ...((ui.sourceViews[v.endpointId] || []).length > 1 ? [{ id: 'view', label: `Change view (${v.view || 'Top-level fields'})`, icon: 'table' }] : []),
                    { id: 'latest', label: 'Read the newest result', icon: 'refresh-cw' }, { id: 'console', label: 'Open in the Console', icon: 'external-link' }]),
            { separator: true },
            { id: 'remove', label: 'Remove from the query', icon: 'x', danger: true }
        ];
        window.DbmnContextMenu.show(event, withSummary(v, items), id => {
            if (id === 'first') { setBusy('Joining…'); post({ type: 'query.moveFirst', id: v.id }); }
            else if (id === 'left' || id === 'right') { setBusy('Joining…'); post({ type: 'query.moveView', id: v.id, to: place + (id === 'left' ? -1 : 1) }); }
            else if (id === 'rename') renameView(v);
            else if (id === 'toggle') { setBusy('Joining…'); post({ type: 'query.toggleView', id: v.id }); }
            // A file's rows are kept as they were read: this reads it again (or another file in its place)
            else if (id === 'pick') pickAgain(v);
            // Nothing is sent: the newest saved result of this endpoint is read here
            else if (id === 'latest') { setBusy('Reading the newest result…'); post({ type: 'query.latest', id: v.id }); }
            else if (id === 'console') post({ type: 'query.openConsole', id: v.id });
            else if (id === 'remove') post({ type: 'query.removeView', id: v.id });
            else if (id === 'run') addView(view(v.runOf) || v);
            else if (id === 'view') {
                const head = view(v.runOf) || v;
                const names = ui.sourceViews[head.endpointId] || [];
                window.DbmnContextMenu.show(event, names.map(n => ({ id: n, label: n, checked: n === head.view })), picked => {
                    if (picked && picked !== head.view) { setBusy('Reading the result…'); post({ type: 'query.changeView', id: head.id, view: picked }); }
                });
            }
        });
    }
    function pickAgain(v) {
        const picker = filePicker(file => { picker.remove(); sendFile(file, { type: 'query.fileData', id: v.id }); });
        picker.dataset.pick = v.id;
        document.body.appendChild(picker);
        picker.click();
    }

    /** Compare's slots: a view's name and the result it reads, in its colour. As many as there are
     * views. A slot is a button: Move to first, Rename, Remove. */
    function renderTop() {
        // A run's slot under its view's heading (grouped), or a view's own slot: one button each
        // What a result says of itself: its environment and its header values (ORG and the like, from Add a view's list)
        const factsOf = v => [{ name: 'Environment', value: v.environment || '' }, ...(((ui.sources || []).find(r => r.id === v.executionId) || {}).header || []).map(h => ({ name: h.name, value: String(h.value) }))].filter(f => f.value);
        // A view's runs: what every one of them says alike goes up to the view's heading; only what differs stays on a run's slot
        // (James, 2026-11-22: the same environment once, above; the time, or an ORG that differs, below)
        const sharedOf = group => (group.length < 2 ? [] : factsOf(group[0]).filter(f => group.every(v => factsOf(v).some(x => x.name === f.name && x.value === f.value))));
        const slotBox = (v, grouped, shared) => {
            // Sitting out: hidden by the user, or (past the first) not joined yet
            // (not joined yet greys only from Join on: on Views nothing is joined yet, and a view is picked here in its colours)
            const out = !!v.off || (ui.step >= 2 && !!v.waiting && !v.reading && !v.error);
            const box = el('div', `compare-result ${colour(v.id)}${out ? ' is-off' : ''}`);
            // The views are changed on Views and Join (a slot's menu, and a drag to another place). On
            // Columns and Results a slot is the heading its lane hangs under, and nothing more
            const edit = ui.step <= 2;
            box.dataset.view = v.id;
            // On Results, in a compare: a result's menu (Hide, Make Baseline, Open in the Console)
            const onResults = !edit && ui.step === 4 && hasStatus();
            // A slot is a button on every step: its summary first, then what can be done with it (James, 2026-11-22)
            const inner = el('button', 'compare-result-btn');
            if (!edit && !onResults) {
                inner.type = 'button';
                inner.setAttribute('aria-haspopup', 'menu');
                inner.addEventListener('click', event => {
                    if (!window.DbmnContextMenu) return;
                    const items = v.file ? [] : [{ id: 'console', label: 'Open in the Console', icon: 'external-link' }];
                    window.DbmnContextMenu.show(event, withSummary(v, items), id => { if (id === 'console') post({ type: 'query.openConsole', id: v.id }); });
                });
            }
            if (onResults) {
                inner.type = 'button';
                inner.setAttribute('aria-haspopup', 'menu');
                inner.addEventListener('click', event => compareResults.slotMenu(event, v));
                if (ui.filter.hidden.includes(v.run || v.name)) box.classList.add('is-off');
            }
            if (edit) {
                inner.type = 'button';
                inner.setAttribute('aria-haspopup', 'menu');
                inner.addEventListener('click', event => { if (!slotDragged) slotMenu(event, v); });
            }
            // Under its view's heading a run is its chip (BL, C1...); a view on its own, its name.
            // Under it, quietly: where and when its result was read (a run's), or its request too (a view's)
            const name = el('span', `compare-result-name query-slot-name${v.error ? ' color-error' : ''}`);
            if (grouped) name.appendChild(el('span', 'query-run-chip', v.run || 'BL'));
            else {
                name.appendChild(el('span', 'query-slot-text', v.name));
                if (v.run) name.appendChild(el('span', 'query-run-chip', v.run));
            }
            const own = grouped ? factsOf(v).filter(f => !(shared || []).some(x => x.name === f.name)).map(f => f.value) : [];
            const where = v.file ? `File · ${v.file}` : grouped ? own.join(' · ') : [v.request || v.endpointName, v.environment].filter(Boolean).join(' · ');
            const what = el('span', 'query-slot-what', [where, day(v.executedAt)].filter(Boolean).join(' · '));
            // Data a week old, or a month: said on the slot, on every step
            const old = ageIcon(v);
            if (old) name.prepend(old);
            const part = incompleteIcon(v);
            if (part) name.prepend(part);
            // On Results the slots fold to one line of chips (James, 2026-11-24): the label, its date and its warning mark
            const date = el('span', 'query-slot-date', day(v.executedAt) || '');
            inner.append(name, date, what);
            // Where it comes from and how old it is: on the slot, quietly; whole on Views, and on hover here
            // (the whole of it is the click's summary, not the hover: James, 2026-11-22. Until the menu can show a
            // summary, DbmnContextMenu.takesSummary, the hover still says it, so it is never nowhere)
            inner.title = window.DbmnContextMenu && window.DbmnContextMenu.takesSummary
                ? `${v.run || v.name}: click for its details`
                : (() => { const sum = slotSummary(v); return [sum.title, ...sum.lines.map(l => `${l[0]}: ${l[1]}`)].join('\n'); })();
            // (the row count on hover, on Results: the chip has no room for it)
            if (ui.step === 4 && !v.reading && v.rows !== undefined) inner.title += `\nRows: ${count(v.rows)}`;
            if (old) inner.title += `\n${old.title}`;
            if (part) inner.title += `\n${INCOMPLETE_SAYS}`;
            if (out) inner.title += v.off ? '\nHidden: left out of the report. Its menu shows it again.' : '\nNot joined yet: left out of the report until its columns are picked on Join.';
            if (v.off) { const eye = el('i', 'query-sign'); eye.dataset.icon = 'eye-off'; name.prepend(eye); }
            // In a compare: "to show" on a view joined in only to show. The views in it carry no mark: the join
            // says what is compared, BL is the Baseline, and the tab's icon says it's a compare (James, 2026-11-22)
            const compare = ui.state && ui.state.compare;
            if (compare && !compare.views.includes(v.id)) {
                const badge = el('span', 'query-slot-badge', 'to show');
                badge.title = 'Joined in to show: not compared';
                inner.appendChild(badge);
            }
            if (edit) inner.appendChild(el('span', 'compare-result-caret', '▾'));
            box.appendChild(inner);
            return box;
        };
        // A lane per view (dbmn-lanes), its runs side by side under one heading
        const lanes = laneGroups().map((group, li) => {
            const lane = el('div', `dbmn-lane dbmn-view-${li % 6} dbmn-runs-${group.length} query-slot-lane`);
            lane.dataset.lane = String(li);
            lane.dataset.view = group[0].id;
            if (group.length > 1) {
                const head = el('div', 'dbmn-lane-head query-slot-head');
                const what = [group[0].request || group[0].endpointName, group[0].view, ...sharedOf(group).map(f => f.value)].filter(Boolean).join(' · ');
                head.append(el('span', 'query-slot-head-name', group[0].name), el('span', 'query-slot-what', what));
                head.title = `${group[0].name}: ${what}`;
                lane.appendChild(head);
            }
            group.forEach((v, ri) => {
                const cell = el('div', `dbmn-lane-run dbmn-run-${ri}`);
                cell.dataset.run = String(ri);
                cell.dataset.view = v.id;
                cell.appendChild(slotBox(v, group.length > 1, sharedOf(group)));
                lane.appendChild(cell);
            });
            return lane;
        });
        const end = el('div', 'dbmn-lanes-end');
        end.dataset.end = '';
        // Add a view and Add a file: the next slot, after the last view, on every step (James, 2026-11-22); with fewer
        // than two views, empty slots after it, so a new query shows three places from the start (James, 2026-11-23)
        end.dataset.adds = 'slots';
        for (let i = 1; i < addPlaces(); i++) {
            const empty = el('div', 'query-slot-empty');
            empty.appendChild(el('span', '', 'then the next'));
            end.appendChild(empty);
        }
        // The name's gutter stays put: moving it out and back takes the focus from a name being
        // typed, and each view's rows coming in redraws the slots ("Should never lose focus")
        const box = $('queryViews'), lead = $('queryHeadLead');
        [...box.children].forEach(c => { if (c !== lead) c.remove(); });
        if (lead && box.firstElementChild !== lead) box.prepend(lead);
        box.append(...lanes, end);
        $('queryTop').classList.toggle('query-top-chips', ui.step === 4);
        // A view just added: its lane grows open from nothing (DbmnLanes), and the pair after it is carried right as it
        // opens, by the grid itself, on its own line (James, 2026-11-23: "The view needs to expand… These buttons need
        // to move across as the view comes in"; before, the pair was slid separately and came in from above)
        ['queryTop', 'queryViewRows', 'queryJoins', 'queryColumns'].forEach(id => applyLanes($(id)));
        // The band as wide as the lanes need (the name's gutter, every view, the place after), when that is more than the
        // band: the band grows while the window has room, so nothing scrolls sideways that would fit (core.css --band-fit).
        // (Too narrow, the lines scrolled sideways each time Add a view's pair was brought into sight, and the names'
        // gutter slid under the band's left edge: query-looks, 2026-11-24, "Not used" at -34)
        const lanesMin = parseFloat($('queryTop').style.getPropertyValue('--lanes-min')) || 0;
        document.querySelector('.query-page').style.setProperty('--band-fit', `${Math.ceil(lanesMin) + 20}px`);
        placeAdds();
        // The slot row and the step's lines under it scroll sideways as one (the step's bar moves both)
        const stepBox = { 1: 'queryViewRows', 2: 'queryJoins', 3: 'queryColumns' }[ui.step] || '';
        if (ui.lanesPaired !== stepBox) {
            if (ui.unpairLanes) ui.unpairLanes();
            ui.unpairLanes = stepBox && window.DbmnLanes && window.DbmnLanes.together ? window.DbmnLanes.together([$('queryTop'), $(stepBox)]) : null;
            ui.lanesPaired = stepBox;
        }
        injectIcons($('queryViews'));
        // A view is added on Views and Join only (James, 2026-11-22): there, the next slot after the last view
        ADDS.classList.toggle('hidden', ui.step > 2);
    }

    /**
     * A slot dragged to another place, on Views and Join: it follows the pointer, the slots it
     * passes slide aside, and let go it is the view in that place (its joins go with it).
     */
    let slotDragged = false;
    (function slotDrag() {
        const row = $('queryViews');
        let press = null, drag = null;
        // A view's lane moves, its runs with it
        const slots = () => Array.from(row.querySelectorAll(':scope > .dbmn-lane'));
        row.addEventListener('pointerdown', event => {
            const slot = event.target.closest && event.target.closest('.compare-result') && event.target.closest('.dbmn-lane');
            if (!slot || event.button !== 0 || ui.step > 2 || ui.busy || slots().length < 2) return;
            press = { slot, x: event.clientX, pointer: event.pointerId };
        });
        row.addEventListener('pointermove', event => {
            if (!press) return;
            const dx = event.clientX - press.x;
            if (!drag) {
                if (Math.abs(dx) < 5) return;
                const all = slots();
                const rects = all.map(s => s.getBoundingClientRect());
                const from = all.indexOf(press.slot);
                const step = all.length > 1 ? Math.abs(rects[1].left - rects[0].left) : rects[0].width;
                drag = { all, rects, from, to: from, step };
                try { row.setPointerCapture(press.pointer); } catch (error) { /* a pointer already gone */ }
                row.classList.add('is-moving');
                press.slot.classList.add('is-lifted');
            }
            const d = drag;
            const middle = d.rects[d.from].left + d.rects[d.from].width / 2 + dx;
            let to = d.from;
            d.all.forEach((slot, j) => {
                if (j === d.from) return;
                const mid = d.rects[j].left + d.rects[j].width / 2;
                const shift = j < d.from && middle < mid ? 1 : j > d.from && middle > mid ? -1 : 0;
                to -= shift;
                slot.style.transform = shift ? `translateX(${shift * d.step}px)` : '';
            });
            d.to = to;
            // Held between the first place and the last
            const least = d.rects[0].left - d.rects[d.from].left, most = d.rects[d.rects.length - 1].left - d.rects[d.from].left;
            press.slot.style.transform = `translateX(${Math.max(least - 12, Math.min(most + 12, dx))}px)`;
        });
        const end = () => {
            const d = drag, p = press;
            press = null; drag = null;
            if (!d) return;
            row.classList.remove('is-moving');
            p.slot.classList.remove('is-lifted');
            d.all.forEach(slot => { slot.style.transform = ''; });
            // The click that ends a drag is not a click on the slot
            slotDragged = true;
            setTimeout(() => { slotDragged = false; }, 0);
            if (d.to === d.from) return;
            // Where it was let go at once; the lanes under it follow when the query answers
            const others = d.all.filter(s => s !== p.slot);
            row.insertBefore(p.slot, others[d.to] || row.querySelector(':scope > .dbmn-lanes-end'));
            // The place in the saved query: before the lane it lands on (left), or after its last run (right)
            const order = ((ui.state && ui.state.views) || []).map(x => x.id);
            const target = laneGroups()[d.to] || [];
            const to = d.to < d.from ? order.indexOf(target[0] && target[0].id) : order.indexOf((target[target.length - 1] || {}).id);
            setBusy('Joining…');
            post({ type: 'query.moveView', id: p.slot.dataset.view, to: Math.max(0, to) });
        };
        row.addEventListener('pointerup', end);
        row.addEventListener('pointercancel', end);
    })();

    /** Views, on the slots' grid as Join is: a line per thing a view says, each view's under its slot. */
    function renderViews() {
        const box = $('queryViewRows');
        const full = !!ui.state && views().length >= ui.state.maxViews;
        addsEl('queryAddBtn').disabled = full;
        addsEl('queryAddBtn').title = full ? `A query takes up to ${ui.state.maxViews} views.` : '';
        addsEl('queryAddFileBtn').disabled = full;
        box.classList.toggle('hidden', views().length === 0);
        const said = (row, label, text, className) => {
            const cells = {};
            views().forEach(v => {
                const cell = at(v.id, `query-view-cell${className ? ' ' + className : ''}`);
                const value = text(v);
                if (value instanceof Element && value.tagName === 'DBMN-PROGRESS') cell.classList.add('is-reading');
                if (value instanceof Element && value.classList.contains('query-read-done')) cell.classList.add('is-read-done');
                // One line, shortened with "…" (the whole of it on hover): never into the next lane
                if (value instanceof Node) cell.appendChild(value); else cell.appendChild(el('span', 'query-view-text', value));
                cell.title = cell.textContent;
                cells[v.id] = cell;
            });
            // A line that says the same for every run of a view (its request, its View) says it once, across the view's lane
            laneGroups().forEach(group => {
                if (group.length < 2) return;
                // (A row per: a run still being read says nothing yet, and doesn't split the line: its runs share one View)
                const said = group.map(v => text(v)).filter(x => !(row === 'rowPer' && x === ''));
                if (said.some(x => x instanceof Node) || said.some(x => x !== said[0])) return;
                const cell = at(group[0].id, `query-view-cell${className ? ' ' + className : ''}`);
                cell.appendChild(el('span', 'query-view-text', said[0] ?? ''));
                cell.title = said[0] ?? '';
                cells['lane:' + group[0].id] = cell;
            });
            const made = line('query-view-line', cells, [], [el('span', 'query-lead-text', label)]);
            made.dataset.row = row;
            return made;
        };
        const aged = v => {
            const level = ageLevel(v.executedAt);
            const wrap = el('span', `query-age${level ? ' query-age-' + level : ''}`);
            const icon = ageIcon(v);
            if (icon) wrap.appendChild(icon);
            wrap.appendChild(el('span', '', ageSpan(v.executedAt)));
            if (level) wrap.title = ageSays(v);
            return wrap;
        };
        const rows = v => {
            if (v.error) return el('span', 'query-warn', v.error);
            // Still being read: the footer's progress bar, the whole cell, where its count will be
            return v.reading ? readProgress(v) : readDone(v, rowsButton(v));
        };
        box.replaceChildren(
            said('request', 'Request', v => v.file ? `File · ${v.file}` : [v.system, v.request || v.endpointName].filter(Boolean).join(' · ')),
            said('view', 'View', v => v.file ? (v.sheet ? `Sheet · ${v.sheet}` : '') : v.view || 'Top-level fields'),
            said('result', 'Result', v => v.file ? '' : v.environment),
            said('updated', 'Last updated', v => day(v.executedAt)),
            said('age', 'Age', aged),
            said('rowPer', 'A row per', v => v.reading ? '' : v.file ? 'line' : v.rowBasis === 'root' ? 'response' : v.rowBasis),
            said('rows', 'Rows', rows, 'query-view-rows'));
        applyLanes(box);
        injectIcons(box);
        placeAdds();
    }

    /** A view still being read, in its Rows cell: the design system's progress bar (as the footer's), how far it has got. */
    function readProgress(v) {
        const bar = document.createElement('dbmn-progress');
        bar.setAttribute('inline', '');
        bar.className = 'query-read-progress';
        bar.dataset.readView = v.id;
        fillRead(bar, ui.reads[v.id]);
        return bar;
    }
    /**
     * Its figures: "Reading C2", rows read and the share of its pages. A view waiting its turn: "Waiting", an
     * empty bar, the one read next saying so ("next"). One at a time, in order.
     */
    function fillRead(bar, read) {
        // One line, one word, one bar per view (James, 2026-11-22: "just say loading", no sweep then a second fill)
        bar.removeAttribute('busy');
        bar.removeAttribute('count');
        if (!read) {
            bar.setAttribute('phase', 'Waiting');
            bar.setAttribute('value', '0');
            return;
        }
        bar.setAttribute('phase', 'Loading');
        // (the bar glides to each new figure itself: dbmn-progress)
        bar.setAttribute('value', String(read.total ? Math.round(100 * read.done / read.total) : 0));
    }
    /** When each view's rows came in: for a moment after, its count fades in where its bar was. */
    const justRead = {};
    const justNow = id => !!justRead[id] && Date.now() - justRead[id] < 1400;
    function readDone(v, node) {
        if (justNow(v.id)) node.classList.add('query-read-done');
        return node;
    }

    /** + Add a view / + Add a file: the slots row's next slot (or, with no views yet, under the empty step's words). */
    function placeAdds() {
        // (the slots row's next slot, with no views too: the same place and shape on every step; first in it, before any
        // empty slots; each view added scrolls the pair into sight, so add, add, add stays under the pointer)
        const holder = document.querySelector('[data-adds="slots"]');
        if (!holder) return;
        if (holder.firstChild !== ADDS) holder.prepend(ADDS);
        const count = views().length;
        if (ui.addsAt !== undefined && count > ui.addsAt && ADDS.scrollIntoView) ADDS.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        ui.addsAt = count;
    }

    /** Read a file the user picked and send it: text for CSV-like files, base64 for a workbook. */
    function sendFile(file, message) {
        if (!file) return;
        const excel = /\.(xlsx|xls)$/i.test(file.name);
        const reader = new FileReader();
        reader.onerror = () => { setBusy(''); if (window.DbmnToast) window.DbmnToast.error(`Could not read ${file.name}. If it is open in Excel, save and close it, then pick it again.`); };
        reader.onload = () => {
            const content = String(reader.result || '');
            post(Object.assign({ name: file.name }, excel ? { base64: content.slice(content.indexOf(',') + 1) } : { text: content }, message));
        };
        setBusy(`Reading ${file.name}…`);
        if (excel) reader.readAsDataURL(file); else reader.readAsText(file);
    }
    /** A hidden file input, opened by a button. */
    function filePicker(onFile) {
        const input = el('input', 'hidden');
        input.type = 'file';
        input.accept = '.csv,.tsv,.txt,.xlsx,.xls';
        input.addEventListener('change', () => { const file = input.files && input.files[0]; input.value = ''; if (file) onFile(file); });
        return input;
    }

    function injectIcons(root) {
        if (window.Icons && window.Icons.injectIcons) window.Icons.injectIcons(root);
    }

    /**
     * Add a view: find a saved result (type to search: its request, endpoint, System, environment),
     * pick it, and pick its View when it has more than one.
     */
    /**
     * Add a view: the saved results on the shared table (dbmn-table), searched with its own box,
     * as many ticked as the query takes. Each with what tells runs of one request apart: its
     * header values (ORG...), how many requests it sent, whether a batch is complete, when it ran. Every result
     * ticked comes in, through its endpoint's standard View (Change view on its slot picks another); a query takes up to ten,
     * and four of one endpoint (a compare's four). Another run of a view: only that endpoint's
     * results it hasn't already, read through its View.
     */
    async function addView(of) {
        // Every result in History, asked for each time Add a view opens (not as the query opens: it can take a while),
        // so a run made or deleted since, with this query open, is in it or gone (the host's run list is shared and kept
        // until the history changes, so asking again is cheap)
        setBusy('Reading your results…');
        await new Promise(resolve => { ui.onAllSources = resolve; post({ type: 'query.sources' }); });
        setBusy('');
        const runOf = of && of.id ? of : null;
        const used = new Set(views().map(v => v.executionId).filter(Boolean));
        const list = ui.sources.filter(r => !runOf || (r.endpointId === runOf.endpointId && !used.has(r.id)));
        const headerNames = [...new Set(list.flatMap(r => (r.header || []).map(h => h.name)))];
        const body = el('div', 'query-add-form query-add-results');
        const tableEl = document.createElement('dbmn-table');
        tableEl.className = 'query-add-table';
        tableEl.setAttribute('label', 'Results');
        tableEl.setAttribute('searchable', '');
        tableEl.setAttribute('selectable', '');
        tableEl.setAttribute('placeholder', 'Search results: get inventory, an environment, a header value…');
        // Its saved searches (the ★ beside its box, the design system's): one list for every query, kept by the host
        tableEl.setAttribute('saved-searches', '');
        tableEl.savedSearches = (ui.state && ui.state.addViewSearches) || [];
        tableEl.addEventListener('dbmn-saved-change', e => post({ type: 'query.saveAddViewSearches', searches: (e.detail && e.detail.searches) || [] }));
        ui.addPicker = tableEl;
        body.appendChild(tableEl);
        const note = el('p', 'form-hint query-add-note');
        body.append(note);
        if (!list.length) note.textContent = runOf ? `No other result of ${runOf.name}'s endpoint. Run it again, and the result can be added here.` : 'No results yet. Run a request, and its result can be added here.';
        tableEl.columns = [
            { id: 'method', name: 'Method' }, { id: 'path', name: 'Path' }, { id: 'endpoint', name: 'Endpoint' }, { id: 'system', name: 'System' }, { id: 'environment', name: 'Environment', aliases: ['env'] },
            ...headerNames.map(n => ({ id: `h:${n}`, name: n })),
            // How many requests the run sent (a batch's size). Not the View's rows: those are only known once it is read
            { id: 'requests', name: 'Requests', numbers: true }, { id: 'complete', name: 'Complete' }, { id: 'runAt', name: 'Run at' }, { id: 'type', name: 'Type' }
        ];
        // One fact, one search name everywhere (as the Hub's History): @env, @ran (when it ran, so @ran>7d reads a date),
        // @status, besides the headings' own names (2026-11-22)
        tableEl.searchFields = [
            { id: 'ran', name: 'ran', get: row => row._result.executedAt || '' },
            { id: 'status', name: 'status', get: row => row._result.status || '' }
        ];
        tableEl.rows = list.map(r => Object.assign({
            _id: r.id, _result: r,
            method: r.method || '', path: r.path || '', endpoint: r.endpoint, system: r.system, environment: r.environment,
            requests: r.rows === '' ? '' : Number(r.rows),
            complete: r.isBatch ? (r.incomplete ? 'Incomplete' : 'Complete') : '',
            runAt: day(r.executedAt), type: r.isBatch ? 'Batch' : 'Single'
        }, Object.fromEntries(headerNames.map(n => [`h:${n}`, ((r.header || []).find(h => h.name === n) || {}).value || '']))));
        // Each comes in through its endpoint's standard View (the first the Console has): Change view on its slot picks another
        const standardView = r => ((r && ui.sourceViews[r.endpointId]) || [])[0] || '';
        // A query takes up to ten; four of one endpoint
        const maxViews = (ui.state && ui.state.maxViews) || 10;
        const maxEach = (ui.state && ui.state.maxPerEndpoint) || 4;
        const problem = picked => {
            if (!picked.length) return 'Tick the results to add.';
            if (runOf) {
                const compare = ui.state && ui.state.compare;
                const room = Math.min(maxViews - views().length, maxEach - views().filter(v => v.endpointId === runOf.endpointId).length, compare ? (ui.state.maxCompare || 4) - compare.views.length : maxEach);
                return picked.length > room ? `${room <= 0 ? 'No room for another run' : `Room for ${room} more run${room === 1 ? '' : 's'}`}: a compare takes ${ui.state.maxCompare || 4}, and a query ${maxEach} of one endpoint.` : '';
            }
            if (views().length + picked.length > maxViews) return `A query takes up to ${maxViews} views: there is room for ${Math.max(0, maxViews - views().length)} more.`;
            const byEndpoint = new Map();
            picked.forEach(r => byEndpoint.set(r._result.endpointId, (byEndpoint.get(r._result.endpointId) || 0) + 1));
            for (const [id, n] of byEndpoint) {
                const have = views().filter(v => v.endpointId === id).length;
                if (have + n > maxEach) { const name = (picked.find(r => r._result.endpointId === id) || {}).endpoint; return `Up to ${maxEach} results of one endpoint (${name}): untick ${have + n - maxEach}.`; }
            }
            return '';
        };
        const refresh = () => {
            const picked = tableEl.selected || [];
            const said = problem(picked);
            note.textContent = said || `${count(picked.length)} ticked.`;
            note.classList.toggle('query-warn', !!said && picked.length > 0);
            const add = document.querySelector('.dbmn-modal [data-action-id="add"]');
            if (add) add.disabled = !!said;
        };
        tableEl.addEventListener('dbmn-table-select', refresh);
        // A double-click adds the one result at once
        tableEl.addEventListener('dbmn-table-row-open', event => {
            tableEl.selected = [event.detail.row];
            refresh();
            const add = document.querySelector('.dbmn-modal [data-action-id="add"]');
            if (add && !add.disabled) add.click();
        });
        setTimeout(() => { refresh(); const box = tableEl.querySelector('input[type="search"], input'); if (box) box.focus(); }, 0);
        const answer = await window.DbmnModal.show({
            title: runOf ? `Another run of ${runOf.name}` : 'Add a view', body, size: 'lg', maximisable: true,
            actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'add', label: 'Add', variant: 'primary' }]
        });
        const picked = (tableEl.selected || []).map(r => r._result);
        if (answer.actionId !== 'add' || !picked.length || problem(tableEl.selected || [])) return;
        setBusy(picked.length > 1 ? `Reading ${picked.length} results…` : 'Reading the result…');
        if (runOf) post({ type: 'query.addRuns', of: runOf.id, executionIds: picked.map(r => r.id) });
        else post({ type: 'query.addViews', items: picked.map(r => ({ endpointId: r.endpointId, executionId: r.id, view: standardView(r) })) });
    }

    /** A workbook of several sheets was read: which become views? Each sheet ticked is one. */
    async function pickSheets(m) {
        const body = el('div', 'query-sheet-list');
        const room = Math.max(0, m.room);
        const note = el('p', 'form-hint');
        const boxes = m.sheets.map((s, i) => {
            const label = el('label', 'query-sheet');
            const box = el('input');
            box.type = 'checkbox';
            box.value = s.sheet;
            box.checked = i < room;
            label.append(box, el('span', 'query-sheet-name', s.sheet), el('span', 'form-hint', `${count(s.rows)} row${s.rows === 1 ? '' : 's'} · ${count(s.columns)} column${s.columns === 1 ? '' : 's'}`));
            body.appendChild(label);
            return box;
        });
        body.appendChild(note);
        // No more than the query has room for: past that, the sheets not ticked cannot be
        const tidy = () => {
            const ticked = boxes.filter(b => b.checked).length;
            boxes.forEach(b => { b.disabled = !b.checked && ticked >= room; });
            note.textContent = ticked >= room && boxes.length > room ? `A query takes up to ${ui.state ? ui.state.maxViews : room} views: there is room for ${count(room)} more.` : '';
            note.hidden = !note.textContent;
        };
        body.addEventListener('change', tidy);
        tidy();
        const answer = await window.DbmnModal.show({
            title: `Sheets of ${m.name}`, body,
            actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'add', label: 'Add', variant: 'primary' }]
        });
        const sheets = answer.actionId === 'add' ? boxes.filter(b => b.checked).map(b => b.value) : [];
        if (sheets.length) setBusy(`Reading ${m.name}…`);
        post({ type: 'query.addSheets', sheets });
    }

    /** A view's count of rows is a button: it opens the rows themselves, to look through and search. */
    function rowsButton(v) {
        const show = el('button', 'query-count-btn', count(v.rows));
        show.type = 'button';
        show.dataset.rows = v.id;
        show.title = `Look through ${v.name}'s rows`;
        show.addEventListener('click', () => previewView(v));
        return show;
    }

    /**
     * A view's own rows, in a dialog: the design system's table (dbmn-table) with its search box, the
     * same search as everywhere (words in what is shown, @column, @@word…), every row reached by
     * scrolling: the host searches and sorts, and sends the page in view (query.viewRows).
     */
    /** A view's rows, or (`count`) the records behind one of the Join step's counts, in the shared table. */
    async function previewView(v, count) {
        const body = el('div', 'query-add-form query-rows-dialog');
        const tableEl = document.createElement('dbmn-table');
        tableEl.id = 'queryViewTable';
        tableEl.className = 'query-add-table';
        tableEl.setAttribute('label', `${v.name}'s rows`);
        tableEl.setAttribute('searchable', '');
        tableEl.setAttribute('placeholder', `Search ${v.name}, or @column=value`);
        const says = el('p', 'form-hint query-add-note');
        says.id = 'queryViewShown';
        says.hidden = true;
        body.append(tableEl, says);
        // A Join count's duplicates: a Status column first, Duplicate on each key's later records (the host sorts them by
        // the key); the key's columns marked (James, 2026-11-22: a status, no table mode)
        const keyCols = (count && count.keys) || [];
        tableEl.columns = [
            ...(count && count.duplicates ? [{ id: 'Status', name: 'Status', sortable: false, render: () => '', cell: (td, value) => { td.replaceChildren(); if (value === 'Duplicate') { const pill = el('span', 'status-pill-generic compare-duplicate', 'Duplicate'); td.appendChild(pill); } } }] : []),
            ...(v.columns || []).map(c => ({ id: c.name, name: c.name, ...(count && count.duplicates && keyCols.includes(c.name) ? { key: true } : {}) }))
        ];
        // Pages asked for and not yet in, by their number
        const waiting = new Map();
        let asked = 0;
        ui.viewRows = m => {
            const done = waiting.get(m.seq);
            if (!done) return;
            waiting.delete(m.seq);
            says.textContent = m.error || '';
            says.hidden = !m.error;
            done({ rows: m.rows.map(line => Object.fromEntries(m.columns.map((c, i) => [c, line[i]]))), total: m.found, of: m.total });
        };
        tableEl.source = {
            page: (offset, limit, { search, sort }) => new Promise(resolve => {
                const seq = ++asked;
                waiting.set(seq, resolve);
                post({ type: 'query.viewRows', id: v.id, offset, limit, search, sort, seq, ...(count ? { count: { kind: count.kind, of: count.of } } : {}) });
            })
        };
        setTimeout(() => { const box = tableEl.querySelector('input'); if (box) box.focus(); }, 0);
        await window.DbmnModal.show({
            title: count ? count.title : `${v.name} · ${v.file ? (v.sheet ? `${v.file}, ${v.sheet}` : v.file) : (v.request || v.endpointName)}`, body, size: 'lg', maximisable: true,
            actions: [{ id: 'close', label: 'Close', variant: 'secondary' }]
        });
        ui.viewRows = null;
        waiting.forEach(done => done({ rows: [] }));
        post({ type: 'query.viewRowsClosed' });
    }

    /* ---------- Join ---------- */

    /** The functions as SQL around `name`, the first innermost. */
    /** What a column's functions do, in words and in order: "gtin: Trim spaces, then First characters (4)". */
    function fnWords(fns, name) {
        const said = (fns || []).map(f => {
            // Translate values: its lookup table, by name
            if (f.fn === 'translate') {
                const table = lookupTables().find(t => t.id === f.table);
                return table ? `Translate values (${table.name})` : 'Translate values';
            }
            const def = fnList().find(d => d.id === f.fn);
            if (!def) return '';
            // (the values typed for it, as the dialog asks for them; a lookup table's id says nothing to a person)
            const values = def.sql.filter(p => p && typeof p === 'object' && p.kind !== 'lookup').map(p => String((p.kind === 'other' ? (f.col !== undefined ? f.col.split('\n').pop() : f.value) : f[p.key]) ?? '')).filter(v => v !== '');
            return values.length ? `${def.label} (${values.join(' → ')})` : def.label;
        }).filter(Boolean);
        return said.length ? `${name}: ${said.join(', then ')}` : name;
    }

    /** One side of a pair, under its view's slot: the column and ƒ. The left side has a box under
     * every earlier view (`of`: the view this box is under), each listing that view's columns:
     * one of them holds the pair's column, and picking in another moves the pair to that view. */
    function sidePicker(join, pairIndex, side, of) {
        const ref = join.on[pairIndex][side];
        const viewId = side === 'left' ? of.id : join.view;
        // The box that holds the column; the others wait, quieter, to be picked from instead
        const mine = side === 'right' || (ref.view === of.id && !!ref.column);
        const wrap = el('span', 'query-pick');
        const from = [view(viewId)].filter(Boolean);
        const cs = el('select');
        cs.dataset.side = side;
        const blank = el('option', '', 'Pick a column');
        blank.value = '';
        cs.appendChild(blank);
        from.forEach(v => v.columns.forEach(c => { const o = el('option', '', c.name); o.value = c.name; o.title = c.sample; cs.appendChild(o); }));
        cs.value = mine && ref.column ? ref.column : '';
        cs.setAttribute('aria-label', from[0] ? `${from[0].name} column` : 'Column');
        cs.addEventListener('change', () => {
            // A column picked under another view: the pair is that view's now, and the box it was in empties
            if (side === 'left' && cs.value && ref.view !== of.id) { ref.view = of.id; ref.fns = []; }
            // (emptying a box that was waiting changes nothing)
            if (cs.value || mine) ref.column = cs.value;
            sendJoin(join);
        });
        wrap.appendChild(cs);
        // ƒ belongs to the column picked: a box that is waiting has none
        if (!mine && ref.column) return wrap;
        // ƒ says how many functions the column has; which ones, in order, on hover
        // The shared fx (white to add, yellow with steps; which ones on hover): James, 2026-11-25, one fx everywhere
        const has = (ref.fns || []).length;
        const fx = window.DbmnFunctions.button({ steps: has, words: has ? fnWords(ref.fns, ref.column) : 'Functions on this column before it joins', label: 'Functions on this column', onClick: () => pickFns(join, ref) });
        fx.dataset.fx = side;
        wrap.appendChild(fx);
        return wrap;
    }

    /** ƒ: functions on the column, in the design system's dialog (shared/dbmn-functions.js), the
     * same one Compare and Run Batch use. They apply in the order they are ticked; a few of the
     * column's values, as they are and as the functions leave them, come from the host. Query keeps
     * a function as { fn, n, from, to }; the dialog speaks { id, params }. */
    async function pickFns(join, ref, done) {
        if (!window.DbmnFunctions) return;
        const viewId = ref.view || (join && join.view);
        const v = view(viewId);
        // The source column by its plain name ("Source column: uom"); "uom (BL)" when another view has a column of that name
        const plain = ref.column || 'column';
        const shared = views().some(o => o.id !== viewId && (o.columns || []).some(c => c.name === plain));
        const name = shared && v ? `${plain} (${v.run || v.name})` : plain;
        const known = id => fnList().some(d => d.id === id) || id === 'translate';
        const toQuery = applied => applied.filter(a => known(a.id)).map(a => Object.assign({ fn: a.id }, a.params || {}));
        const fromQuery = fns => (fns || []).filter(f => known(f.fn)).map(f => {
            const params = {};
            Object.keys(f).forEach(k => { if (k !== 'fn') params[k] = f[k]; });
            return { id: f.fn, params };
        });
        let asked = 0;
        const waiting = new Map();
        ui.fnSample = m => {
            const resolve = waiting.get(m.seq);
            if (!resolve) return;
            waiting.delete(m.seq);
            // (Translate values: lines already { before, after, missing?, twice? } with the lookup they are for)
            if (m.lookup) { resolve({ rows: m.rows || [], lookup: m.lookup, agree: null, error: m.error }); return; }
            // (each value before and after; with the chain of steps asked for, after each step in turn too: the last is `after`)
            resolve(Object.assign({ rows: (m.rows || []).map(r => Object.assign({ before: r[0], after: r[r.length - 1] }, m.steps ? { steps: r.slice(1) } : {})), agree: null, error: m.error }, m.table ? { table: m.table, value: m.value } : {}));
        };
        // Translate values' "+ Add": the host adds the row, and says so (query.lookupRowAdded); the dialog then asks its sample again
        let addSeq = 0;
        const adding = new Map();
        ui.lookupRowAdded = m => { const done = adding.get(m.seq); if (!done) return; adding.delete(m.seq); done(m.ok ? { ok: true } : { ok: false, error: m.error || 'The row could not be added.' }); };
        const applied = await window.DbmnFunctions.open({
            // (no title: the dialog's header is "Functions", with "Source column: …" from `column` beside it)
            column: name,
            // Translate values, always (with no lookup table yet, "+ New lookup table…" makes one): the table, its from and to columns
            // (Translate values first: James 2026-11-23, the Functions dialog mock)
            functions: [{ id: 'translate', label: 'Translate values', sql: ['TRANSLATE(', 'x', ', ', { key: 'table', label: 'Lookup table', kind: 'lookup', options: lookupTables() }, ')'] }].concat(fnList())
                .map(d => ({ id: d.id, label: d.label, sql: d.sql })),
            defaults: fnDefaults(),
            applied: fromQuery(ref.fns),
            // (a step's other column: one of the same view's, as the engine reads it)
            columns: v ? (v.columns || []).map(c => ({ id: c.name, label: c.name })) : [],
            asLabel: join ? 'Joins as' : 'Shows as',
            // A lookup table opens in its own tab, from Reporting
            onOpenLookup: id => post({ type: 'query.openLookup', id }),
            onAddLookupRow: ({ table, from, to, value, out }) => new Promise(resolve => {
                const seq = ++addSeq;
                adding.set(seq, resolve);
                post({ type: 'query.addLookupRow', seq, table, from, to, value, out });
            }),
            // "+ New lookup table…": a new table in its own tab, as Reporting's + New lookup table makes
            // (its name and columns from the shared dialog, shared/lookup-new.js, when the page has it; else the host's default)
            onNewLookup: () => {
                if (!window.LookupNew) { post({ type: 'query.newLookup' }); return; }
                window.LookupNew.ask({ taken: lookupTables().map(t => t.name) }).then(made => { if (made) post({ type: 'query.newLookup', name: made.name, columns: made.columns }); });
            },
            sample: (list, opts) => new Promise(resolve => {
                const seq = ++asked;
                waiting.set(seq, resolve);
                // (this record's value: the one shown in the cell whose ƒ was clicked, first among the samples; `steps`: the
                // value after each function too, for the dialog's chain)
                post({ type: 'query.fnSample', view: viewId, column: ref.column, fns: toQuery(list), seq, record: sampleOf(viewId, ref.column), steps: !!(opts && opts.steps) });
            })
        });
        ui.fnSample = null;
        if (!applied) return;
        ref.fns = toQuery(applied).map(f => (f.n === undefined ? f : Object.assign(f, { n: Math.max(1, parseInt(f.n, 10) || 1) })));
        if (done) done();
        else sendJoin(join);
    }

    function sendJoin(join) {
        setBusy('Joining…');
        post({ type: 'query.setJoin', view: join.view, kind: join.kind, on: join.on });
        renderJoins();   // the picks show at once; the counts follow
    }

    /** What a join needs said in words: a column to pick, or sides that can never match. The counts are in the match table. */
    function joinNote(join, stats) {
        let said = '';
        if (!stats) {
            // A pair naming a column its view no longer has
            const gone = [];
            join.on.forEach(p => [[p.left.view, p.left.column], [join.view, p.right.column]].forEach(([id, column]) => {
                const of = view(id);
                if (column && of && !of.reading && !of.error && !of.columns.some(c => c.name === column)) gone.push(`${column} is no longer in ${of.name}.`);
            }));
            const of = view(join.view);
            said = gone.length ? `${gone.join(' ')} Pick another column.` : ui.state && ui.state.error ? 'Not counted: the query can\'t run (above).' : of && of.off ? 'Hidden: left out of the report.' : join.on.some(p => p.left.column && p.right.column) ? 'Joins to a view that is left out.' : 'Not joined yet: pick the columns it joins on, or hide it.';
        } else if (stats.typeMismatch) said = 'One side is numbers and the other text, so they never match. Try fx: As text.';
        if (!said) return null;
        const line = el('span', 'query-row form-hint query-counts');
        const warn = el('span', 'query-warn', said);
        const sign = el('i', 'query-sign');
        sign.dataset.icon = 'triangle-alert';
        warn.prepend(sign);
        line.appendChild(warn);
        return line;
    }

    /* ---------- Join, on the slots' grid: every line has what it is on the left, a cell under each view, then its tools ---------- */

    /** A cell under a view's slot, in its colour. */
    function at(id, className) { return el('div', `query-at dbmn-lane-run ${colour(id)}${className ? ' ' + className : ''}`); }
    /** A line: `lead` on the left (what the line is), `cells` by view id (a view with none gets an
     * empty cell, so the lanes run on), then `says` on the right (its tools). */
    function line(className, cells, says, lead) {
        // A row of the grid (dbmn-lanes): the gutter, a lane per view (its runs' cells in it), the end.
        // data-line names the line, data-lane / data-run / data-gutter / data-end its cells (the looks specs read them)
        const row = el('div', `dbmn-lanes-row query-line${className ? ' ' + className : ''}`);
        row.dataset.line = (className || 'line').split(' ')[0].replace(/^query-/, '');
        const start = el('div', 'dbmn-lanes-gutter query-lead');
        start.dataset.gutter = '';
        (lead || []).forEach(node => { if (node) start.append(node); });
        row.appendChild(start);
        if (cells && cells.__span) {
            // One cell across every lane: words said once for the whole line
            const span = el('div', 'dbmn-lanes-span query-span');
            span.append(cells.__span);
            row.appendChild(span);
        } else {
            laneGroups().forEach((group, li) => {
                const lane = el('div', `dbmn-lane dbmn-view-${li % 6} dbmn-runs-${group.length}`);
                lane.dataset.lane = String(li);
                // (one cell across a view's lane: what every run of it says alike, said once)
                const whole = cells && cells['lane:' + group[0].id];
                if (whole) {
                    whole.classList.add('dbmn-lane-run', 'query-lane-whole');
                    whole.dataset.view = group[0].id;
                    lane.appendChild(whole);
                    row.appendChild(lane);
                    return;
                }
                group.forEach((v, ri) => {
                    const cell = (cells && cells[v.id]) || at(v.id);
                    cell.classList.add('dbmn-lane-run');
                    cell.dataset.run = String(ri);
                    cell.dataset.view = v.id;
                    lane.appendChild(cell);
                });
                row.appendChild(lane);
            });
        }
        const end = el('div', 'dbmn-lanes-end query-says');
        end.dataset.end = '';
        (says || []).forEach(node => { if (node) end.appendChild(node); });
        row.appendChild(end);
        return row;
    }
    /** Compare's picture of a relationship, each side in its view's colour. */
    function picture(kind, join) {
        const node = window.RelationGlyph.svg(kind);
        const left = colour((join.on[0] && join.on[0].left.view) || (views()[0] || {}).id);
        const right = colour(join.view);
        node.querySelectorAll('.g-b').forEach(c => { if (left) c.classList.add(...left.split(' ')); });
        node.querySelectorAll('.g-c').forEach(c => { if (right) c.classList.add(...right.split(' ')); });
        return node;
    }
    /** How many rows of each kind a join has: [rows, the joining view's records]. */
    function kindCounts(stats, kind) {
        if (kind === 'onlyBase') return [stats.leftRows - stats.leftMatched, 0];
        if (kind === 'onlyOther') return [0, stats.rightRows - stats.rightMatched];
        return [stats.rows[kind] || 0, stats.records[kind] || 0];
    }
    /** What a count means, on hover. */
    /** What each kind of join is called in its SQL, and which unmatched rows it keeps. */
    const JOIN_SQL = { inner: 'JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', outer: 'OUTER JOIN', compare: 'Compare' };
    const keeps = kind => ({ left: kind === 'left' || kind === 'outer', right: kind === 'right' || kind === 'outer' });
    /** What a join does with the rows so far that find no match: `blank` says what is left blank ("Bins blank"). */
    const unmatchedSays = (join, blank, rowsWord) => (keeps(join.kind).left
        ? `${JOIN_SQL[join.kind]} keeps ${rowsWord}, with ${blank}`
        : `${JOIN_SQL[join.kind]} leaves ${rowsWord} out`);

    function kindTitle(kind, join, rows, records) {
        const name = (view(join.view) || {}).name || 'the view';
        switch (kind) {
            case 'oneToOne': return `${count(rows)} rows each match one ${name} row of their own`;
            case 'manyToOne': return `${count(rows)} rows share ${count(records)} ${name} rows. No rows are added`;
            case 'oneToMany': return `${count(rows)} rows match ${count(records)} ${name} rows: a row comes out once for each. Add a column to the join (+ AND) to stop it`;
            case 'manyToMany': return `${count(rows)} rows match ${count(records)} ${name} rows, several each way: every pairing makes a row. Add a column to the join (+ AND) to stop it`;
            case 'onlyBase': return `${count(rows)} rows have no match in ${name}: ${unmatchedSays(join, `${name}'s columns blank`, 'them')}`;
            default: return keeps(join.kind).right
                ? `${count(records)} ${name} rows match no row: ${JOIN_SQL[join.kind]} keeps them, with the other views' columns blank`
                : `${count(records)} ${name} rows match no row. They are not in the report`;
        }
    }
    function valueKind(v) {
        if (!v.right) return 'onlyBase';
        if (!v.left) return 'onlyOther';
        return v.left > 1 ? (v.right > 1 ? 'manyToMany' : 'manyToOne') : v.right > 1 ? 'oneToMany' : 'oneToOne';
    }
    /**
     * The Join step while the host counts (its state's `counting`, and each `query.counting` stage):
     * what it is doing, for how long (counted here, a second at a time), and Stop. Stopped, it says so
     * and offers to count again.
     */
    function countingSays(records) {
        const box = el('span', 'query-counting');
        const c = ui.counting || {};
        if (c.stopped) {
            box.append(el('span', 'query-note', c.stage || 'Stopped'));
            const again = el('button', 'compare-tool-btn text-link font-size-12', 'Count again');
            again.type = 'button';
            again.addEventListener('click', event => { event.stopPropagation(); ui.counting = null; setBusy('Joining…'); post({ type: 'query.recount' }); });
            box.append(again);
            return box;
        }
        const stage = c.stage && /^Counting how the records meet/.test(c.stage) && records
            ? c.stage.replace('Counting how the records meet', `Counting how ${count(records)} records meet`) : (c.stage || 'Counting how the records meet');
        const words = el('span', 'query-counting-stage is-pending', `${stage}…`);
        const time = el('span', 'query-counting-time font-mono');
        time.dataset.since = c.since || '';
        time.textContent = secondsSince(c.since);
        const stop = el('button', 'compare-tool-btn text-link font-size-12', 'Stop');
        stop.type = 'button';
        stop.title = 'Stop counting: the counts are left out until you count again';
        stop.addEventListener('click', event => { event.stopPropagation(); post({ type: 'query.stopCounting' }); });
        box.append(words, time, stop);
        return box;
    }
    function secondsSince(iso) {
        const t = new Date(iso || '').getTime();
        if (isNaN(t)) return '';
        const s = Math.max(0, Math.round((Date.now() - t) / 1000));
        return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
    }
    // (the seconds go on while the page is free to count them)
    setInterval(() => document.querySelectorAll('.query-counting-time').forEach(t => { t.textContent = secondsSince(t.dataset.since); }), 1000);

    /** A count under the view it counts. */
    function counted(id, n, warn) {
        const cell = at(id, 'query-count compare-match-count');
        cell.textContent = count(n);
        if (n) cell.classList.add('is-some');
        if (n && warn) cell.classList.add('is-repeat');
        return cell;
    }

    /** Why a view has no rows; a file view's line has the button that picks its file again. */
    function errorLine(v) {
        const said = el('span', 'query-row form-hint');
        said.appendChild(el('span', 'query-warn', v.error));
        if (v.file) {
            const picker = filePicker(file => sendFile(file, { type: 'query.fileData', id: v.id }));
            const pick = el('button', 'compare-tool-btn text-link font-size-12', `Pick ${v.file}`);
            pick.type = 'button';
            pick.addEventListener('click', () => picker.click());
            said.append(picker, pick);
        }
        return said;
    }

    /** A view's colour as a CSS value (its lane's), for pictures drawn in two views' colours. */
    function colourValue(id) {
        const probe = el('span', colour(id));
        probe.hidden = true;
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).getPropertyValue('--compare-c').trim();
        probe.remove();
        return value;
    }
    /** The kinds of join, said with the two views' names: [kind, name, what it keeps]. */
    function joinKinds(left, right) {
        return [
            // (as the mock words them)
            ['compare', 'Compare', 'Match the same record in every view, by a key, and compare them. Every record of every view is kept'],
            ['inner', 'Join', 'Only rows both have'],
            ['left', 'Left join', 'All of the left view; the right where it matches'],
            ['right', 'Right join', 'All of the right view; the left where it matches'],
            ['outer', 'Outer join', 'Every row of both, matched where they can be']
        ];
    }
    /** Every join back to "Pick a column" (the views, columns and filters stay), after a confirm: the join menu's Reset joins. */
    function resetJoins() {
        window.DbmnModal.confirm({ title: 'Reset every join?', body: 'Every join goes back to "Pick a column". The views and the report\'s columns stay.', confirmLabel: 'Reset joins', confirmVariant: 'danger' })
            .then(yes => { if (!yes) return; setBusy('Joining…'); post({ type: 'query.resetJoins' }); });
    }

    /**
     * Which rows a join keeps: its picture (the shared RelationGlyph.join, in the two views'
     * colours) and a caret; a click opens the kinds under it, each with its picture, name and
     * what it keeps (the shared menu). No SQL words: the pictures say it.
     */
    function kindButton(join, v, onPick) {
        const leftView = view(join.on[0] && join.on[0].left.view) || views()[0] || { name: 'the rows so far' };
        const colours = { left: colourValue(leftView.id), right: colourValue(v.id) };
        const kinds = joinKinds(leftView.name, v.name);
        const current = kinds.find(k => k[0] === join.kind) || kinds[1];
        const b = el('button', 'btn btn-secondary query-join-kind');
        b.type = 'button';
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-expanded', 'false');
        b.setAttribute('aria-label', `How ${v.name} joins ${leftView.name}: ${current[1]}`);
        b.title = `${current[1]}: ${current[2]}`;
        b.dataset.kind = join.kind;
        b.append(window.RelationGlyph.join(join.kind, colours), el('span', 'query-join-caret', '\u25BE'));
        b.addEventListener('click', () => {
            b.setAttribute('aria-expanded', 'true');
            // A compare takes so many views: Compare can't be picked for another once it is full
            const compare = ui.state && ui.state.compare;
            const full = !!compare && join.kind !== 'compare' && compare.views.length >= (ui.state.maxCompare || 4);
            // Compare is the way in on a query's first join, and the compare's own kind; never on a plain join beside a compare
            const firstJoin = ((ui.state.joins || [])[0] || {}).view === join.view;
            const offerCompare = join.kind === 'compare' || (!compare && firstJoin);
            const items = kinds.filter(([id]) => id !== 'compare' || offerCompare).map(([id, label, detail]) => ({
                id, label, glyph: window.RelationGlyph.join(id, colours), checked: id === join.kind,
                detail: id === 'compare' && full ? `A compare takes ${ui.state.maxCompare || 4} views: take one out to put ${v.name} in` : detail,
                disabled: id === 'compare' && full
            }));
            // Delete join, at the bottom: the view (a compare: every view in it) goes back to not joined.
            // Reset joins under it, for every join (James, 2026-11-23: "Just in the menu", not the footer)
            // (query-join-rules.js: Delete join greyed, saying why, on a view not joined yet; Hide this view there, the way on without it)
            const rules = window.QueryJoinRules.menu(ui.state, join);
            items.push({ separator: true }, { id: 'delete', label: 'Delete join', icon: 'trash-2', disabled: rules.remove.disabled, detail: rules.remove.detail || undefined },
                { id: 'reset', label: 'Reset joins', icon: 'many-to-one-sync', disabled: rules.reset.disabled, detail: rules.reset.detail });
            if (rules.hide) items.push({ id: 'hide', label: 'Hide this view', icon: 'eye-off', detail: `${v.name} is left out of the report until it is shown again (Views)` });
            window.DbmnContextMenu.show(b, items, id => {
                b.setAttribute('aria-expanded', 'false');
                if (id === 'reset') { resetJoins(); return; }
                if (id === 'hide') { setBusy('Joining…'); post({ type: 'query.toggleView', id: v.id }); return; }
                if (id === 'delete') {
                    // An empty line: the line goes (the host has nothing to delete)
                    if (rules.remove.line && join.kind !== 'compare') {
                        ui.joinLines.delete(join.view);
                        ui.joinsTouched = true;
                        renderJoins();
                        return;
                    }
                    const gone = join.kind === 'compare' ? ui.state.joins.filter(j => j.kind === 'compare').map(j => j.view) : [join.view];
                    // (a compare deleted: its first view keeps an empty line, so the step doesn't go blank; nothing else appears)
                    if (join.kind === 'compare' && gone.length) ui.joinLines.add(gone[0]);
                    setBusy('Joining…');
                    post({ type: 'query.deleteJoin', views: gone });
                    return;
                }
                if (!id || id === join.kind) return;
                if (onPick) onPick(id);
                else { join.kind = id; sendJoin(join); }
            });
        });
        return b;
    }

    /**
     * One view's join. A line per pair: the join's kind on the left, each column under its view's
     * slot with a wire between the two (the relationship drawn on it), + AND on the right. Under
     * them, always, the rows the join leaves, across the lanes joined so far. Its chevron opens
     * a line per way the rows meet, each count under the view it counts.
     */
    function joinBand(v, join, earlier) {
        const open = !!ui.statsOpen[v.id];
        const band = el('section', 'query-join');
        band.dataset.view = v.id;
        band.setAttribute('aria-label', `Join ${v.name}`);
        if (!join.on.length) join.on.push({ left: { view: earlier[0].id, column: '' }, right: { column: '' } });
        const stats = v.error ? null : join.stats;
        // The key's lines grouped by the view they join to, in the views' order (never mixed: James, 2026-11-22)
        join.on.forEach(pair => { if (viewAt(pair.left.view) < 0) pair.left.view = earlier[0].id; });
        const shown = join.on.map((pair, p) => ({ pair, p })).sort((a, b) => (viewAt(a.pair.left.view) - viewAt(b.pair.left.view)) || (a.p - b.p));
        shown.forEach(({ pair, p }, row) => {
            const cells = {};
            // A box under every earlier view, until one is picked from: that view is what this one joins to
            earlier.forEach(e => {
                const mine = e.id === pair.left.view && !!pair.left.column;
                // (room for the link's dot on the side facing the view joined: only that side, so the box keeps the rest; James,
                // 2026-11-23, three views read "Pick a columr")
                const cell = at(e.id, mine ? `query-link-from ${viewAt(e.id) < viewAt(v.id) ? 'is-dot-right' : 'is-dot-left'}` : '');
                // Once a column is picked, the other views' boxes go: emptying it ("Pick a column") brings them back
                if (mine || !pair.left.column) cell.appendChild(sidePicker(join, p, 'left', e));
                cells[e.id] = cell;
            });
            const right = at(v.id, `query-link-to ${viewAt(pair.left.view) < viewAt(v.id) ? 'is-dot-left' : 'is-dot-right'}`);
            right.appendChild(sidePicker(join, p, 'right', v));
            cells[v.id] = right;
            const lead = [];
            const says = [];
            if (row === 0) {
                lead.push(kindButton(join, v));
                const and = el('button', 'compare-tool-btn text-link font-mono font-size-12', '+ AND');
                and.dataset.and = '';
                and.type = 'button';
                and.title = 'Another pair of columns, for a key made of two';
                // Which earlier view its column comes from is said by the box it is picked in
                and.addEventListener('click', () => { join.on.push({ left: { view: earlier[0].id, column: '' }, right: { column: '' }, picked: true }); renderJoins(); });
                says.push(and);
            }
            // A pair can always be taken out: the last one leaves the join asking for its columns, from any earlier view
            if (join.on.length > 1 || pair.left.column || pair.right.column) {
                const drop = el('button', 'compare-tool-btn icon');
                drop.type = 'button';
                drop.title = 'Remove this pair';
                drop.setAttribute('aria-label', 'Remove this pair');
                drop.dataset.icon = 'x';
                drop.addEventListener('click', () => { join.on.splice(p, 1); sendJoin(join); });
                says.push(drop);
            }
            const made = line('query-pair', cells, says, lead);
            // The link between the two columns, across the lanes, once both are picked: how the sides meet on the
            // join's first pair (one dot or two each end), a plain line on the others. Drawn once on the page
            // (drawLinks), from where the cells are (it went missing when Join moved onto the lanes grid)
            if (pair.left.column && pair.right.column) {
                made.dataset.linkFrom = pair.left.view;
                made.dataset.linkTo = v.id;
                made.dataset.relation = stats ? stats.relationship : 'none';
            }
            band.appendChild(made);
        });

        // The rows this join leaves, across the lanes joined so far
        const after = {};
        const lanes = views().slice(0, viewAt(v.id) + 1);
        lanes.forEach((lane, i) => { after[lane.id] = el('div', `query-at query-after${i === lanes.length - 1 ? ' is-end' : ''}`); });
        if (stats) {
            // Rows with no match: their count, as the numbers under it are written, under the view they are rows of
            const none = stats.leftRows - stats.leftMatched;
            const grows = stats.rowsAfter > stats.leftRows;
            // What a join does to the rows is said plainly, as information: rows with no match, and rows
            // that come out more than once. Only many to many, where both sides repeat, is a warning
            const many = stats.relationship === 'manyToMany';
            const sign = warn => { const i = el('i', 'query-sign'); i.dataset.icon = warn ? 'triangle-alert' : 'info'; return i; };
            if (none) {
                const cell = after[join.on[0].left.view] || after[lanes[0].id];
                const warn = el('span', 'query-after-warn query-made query-note', count(none));
                warn.prepend(sign(false));
                warn.title = `${count(none)} ${none === 1 ? 'row has' : 'rows have'} no match in ${v.name}: ${unmatchedSays(join, `${v.name} blank`, 'them')}`;
                cell.classList.add('is-count');
                cell.appendChild(warn);
            }
            if (grows) {
                const cell = after[lanes[0].id];
                const warn = el('span', `query-after-grows ${many ? 'query-warn' : 'query-note'}`, 'Rows multiply');
                if (!cell.childNodes.length || many) warn.prepend(sign(many));
                warn.title = `A row comes out once for each ${v.name} row it matches. Add a column to the join (+ AND) to stop it`;
                cell.prepend(warn);
            }
            after[v.id].appendChild(el('span', 'query-made', count(stats.rowsAfter)));
            // Anywhere on the bar opens how the rows meet, as its chevron does
            lanes.forEach(lane => after[lane.id].addEventListener('click', () => { ui.statsOpen[v.id] = !open; renderJoins(); }));
        }
        // A view brought in to show beside a compare: its bar is one sentence across the lanes, as the mock has it
        // ("1,198 of the rows find a Suppliers record · 9 Suppliers records not used"), the rows it leaves at its end
        const besideCompare = !!(ui.state && ui.state.compare) && stats;
        let sentence = null;
        if (besideCompare) {
            const unused = stats.rightRows - stats.rightMatched;
            const bar = el('div', 'query-after query-join-said');
            const words = el('span', 'query-made query-join-stat', `${count(stats.leftMatched)} of ${count(stats.leftRows)} rows find a ${v.name} record${unused ? ` · ${count(unused)} ${v.name} ${unused === 1 ? 'record' : 'records'} not used` : ''}`);
            words.title = `${count(stats.leftMatched)} of the rows so far find a record of ${v.name}; ${count(stats.leftRows - stats.leftMatched)} don't (${unmatchedSays(join, `${v.name} blank`, 'them')}). Open the chevron for how they meet`;
            bar.appendChild(words);
            if (stats.rowsAfter > stats.leftRows) {
                const many = stats.relationship === 'manyToMany';
                const w = el('span', many ? 'query-warn' : 'query-note', 'Rows multiply');
                w.title = `A row comes out once for each ${v.name} row it matches. Add a column to the join (+ AND) to stop it`;
                bar.appendChild(w);
            }
            bar.addEventListener('click', () => { ui.statsOpen[v.id] = !open; renderJoins(); });
            sentence = bar;
        }
        // Its chevron, beside what it opens
        const more = el('button', 'compare-tool-btn icon');
        more.type = 'button';
        more.dataset.stats = '';
        more.dataset.icon = open ? 'chevron-down' : 'chevron-right';
        more.disabled = !stats;
        more.setAttribute('aria-expanded', String(open && !!stats));
        more.setAttribute('aria-label', `How the rows meet ${v.name}`);
        more.title = open ? 'Hide how the rows meet this view' : 'Show how the rows meet this view';
        more.addEventListener('click', () => { ui.statsOpen[v.id] = !open; renderJoins(); });
        // (while the host counts, a made join says so, as the compare does)
        const counting = !stats && !!ui.counting && !ui.counting.stopped && join.on.some(p => p.left.column && p.right.column);
        // Its note read whole (James, 2026-11-23: "there is something cut off, I don't know what this is meant to say"): with no
        // counts on the line, said across the lanes under the join; beside counts, at the end, on as many lines as it takes
        const made_ = note => note && !stats
            ? line('query-made-line', { __span: note }, [], [el('span', 'query-lead-text', 'Rows after this join'), more])
            : line('query-made-line', after, note ? [note] : [], [el('span', 'query-lead-text', 'Rows after this join'), more]);
        const made = counting
            ? line('query-made-line', { __span: countingSays(0) }, [], [el('span', 'query-lead-text', 'Rows after this join'), more])
            : sentence
            ? line('query-made-line', { __span: sentence }, [el('span', 'query-made query-compare-rows', `${count(stats.rowsAfter)} rows`)], [el('span', 'query-lead-text', 'Rows after this join'), more])
            : made_(v.error ? errorLine(v) : joinNote(join, stats));
        made.dataset.kind = 'made';
        made.classList.toggle('is-openable', !!stats);
        band.appendChild(made);
        // The views after this one are not part of its join: their lanes are out, and say why
        const shut = () => {
            const last = viewAt(v.id);
            band.querySelectorAll('.dbmn-lane-run[data-view]').forEach(cell => {
                const later = view(cell.dataset.view);
                // (a view this join takes a column from is part of it, wherever it sits)
                if (!later || viewAt(later.id) <= last || !cell.classList.contains('query-at') || join.on.some(p => p.left.view === later.id)) return;
                cell.classList.add('query-lane-off');
                cell.title = `${later.name} joins further down: a view joins to the views before it. Drag ${later.name}'s slot to the left of ${v.name} to join it here.`;
            });
            return band;
        };
        if (!stats || !open) return shut();

        const leftId = join.on[0].left.view;
        KINDS.forEach(([kind, label, warn]) => {
            // (no match, either side: one row at the bottom, below)
            if (kind === 'onlyBase' || kind === 'onlyOther') return;
            const [rows, records] = kindCounts(stats, kind);
            if (!rows && !records) return;
            const cells = {};
            // A count is a button: it opens the values it counts
            const put = (id, n, side) => {
                const cell = counted(id, n, warn);
                const show = el('button', 'query-count-btn', cell.textContent);
                show.type = 'button';
                show.dataset.side = side;
                show.title = 'Show the values behind this count';
                show.addEventListener('click', () => showValues(join, kind, side));
                cell.replaceChildren(show);
                cells[id] = cell;
            };
            if (kind !== 'onlyOther') put(leftId, rows, 'left');
            if (kind !== 'onlyBase') put(v.id, records, 'right');
            const name = kind === 'onlyBase' ? (keeps(join.kind).left ? 'No match: kept' : 'No match: left out')
                : kind === 'onlyOther' && keeps(join.kind).right ? 'No match: kept' : label;
            const row = line('query-kind-line', cells, [], [picture(kind, join), el('span', `query-kind query-lead-text${warn ? ' query-warn' : ''}`, name)]);
            row.dataset.kind = kind;
            row.title = kindTitle(kind, join, rows, records);
            band.appendChild(row);
        });
        // No match: ONE row at the bottom however many views the join takes, a plain dot; each side's count under its
        // view, "kept" (or "left out") beside it as a small label (James, 2026-11-22)
        const [noLeft] = kindCounts(stats, 'onlyBase');
        const [, noRight] = kindCounts(stats, 'onlyOther');
        if (noLeft || noRight) {
            const cells = {};
            const side = (id, n, kind, sideName, kept) => {
                if (!n) return;
                const cell = counted(id, n, false);
                const show = el('button', 'query-count-btn', cell.textContent);
                show.type = 'button';
                show.dataset.side = sideName;
                show.title = 'Show the values behind this count';
                show.addEventListener('click', () => showValues(join, kind, sideName));
                cell.replaceChildren(el('span', 'query-nomatch-kept', kept ? 'kept' : 'left out'), show);
                cell.classList.add('query-nomatch-cell');
                cell.title = kindTitle(kind, join, kind === 'onlyBase' ? n : 0, kind === 'onlyOther' ? n : 0);
                cells[id] = cell;
            };
            side(leftId, noLeft, 'onlyBase', 'left', keeps(join.kind).left);
            side(v.id, noRight, 'onlyOther', 'right', keeps(join.kind).right);
            const dot = el('span', 'query-nomatch-glyph');
            dot.appendChild(window.RelationGlyph.svg('onlyBase'));
            const row = line('query-kind-line', cells, [], [dot, el('span', 'query-kind query-lead-text', 'No match')]);
            row.dataset.kind = 'noMatch';
            band.appendChild(row);
        }
        return shut();
    }

    /** A column's value on the first record every view has (the report's sample row), or ''. */
    function sampleOf(viewId, column) {
        const hit = ((ui.state && ui.state.sampleRow) || []).find(c => c.view === viewId && c.column === column);
        if (hit) return hit.value;
        // Before the join is worked out (or on data it never finishes on): the view's own first row, so a sample never waits
        const v = view(viewId);
        const own = v && (v.columns || []).find(c => c.name === column);
        return own ? own.sample || '' : '';
    }
    /** A pair as the host takes it back: { left: { view, column, fns }, right: { column, fns } }. */
    function pagePair(left, right) {
        return { left: { view: left.view, column: left.column, fns: left.fns || [] }, right: { column: right.column, fns: right.fns || [] } };
    }

    /**
     * A compare's Join: one band for every view in it. A line per key column: the Baseline's column
     * once, each other view's column under its slot (with ƒ), the value on the first record they
     * all have under each; + AND adds a key column across all of them. Under a view out of the
     * compare, "Not compared": picking one of its columns puts it in (a compare takes so many). The
     * kind is one button for the compare: picking another kind makes every one of its joins that.
     * Then how many are in, and the rows the compare leaves.
     */
    function compareBand() {
        const s = ui.state;
        const joins = s.joins.filter(j => j.kind === 'compare');
        const first = joins[0];
        // (just picked here, before the host says so: the compare from the joins as they stand)
        const compare = s.compare || { baseline: (first.on[0] && first.on[0].left.view) || (views()[0] || {}).id, views: [] };
        if (!s.compare) compare.views = [compare.baseline, ...joins.map(j => j.view)];
        // Compare picked before the key: its key's line, with every box still to pick (as a join's first pair)
        if (!first.on.length) first.on.push({ left: { view: compare.baseline, column: '' }, right: { column: '' } });
        const baseline = view(compare.baseline) || views()[0];
        const members = compare.views;
        const max = s.maxCompare || 4;
        const full = members.length >= max;
        const band = el('section', 'query-join query-compare');
        band.dataset.compare = '';
        band.setAttribute('aria-label', `Compare ${members.map(id => (view(id) || {}).name).join(', ')}`);
        const joinOf = id => s.joins.find(j => j.view === id);
        // (one change for the whole compare: one refresh, one step back)
        // (another kind: the host clears the compare to one join line of that kind, its first view's; the others not joined)
        const sendAll = (kind) => {
            if (kind !== 'compare' && joins[0]) ui.joinLines.add(joins[0].view);
            joins.forEach(j => { j.kind = kind; });
            post({ type: 'query.setCompareKind', kind });
        };
        first.on.forEach((pair, p) => {
            const cells = {};
            views().forEach(v => {
                if (v.id === baseline.id) {
                    // One picker and one value for the Baseline's lane: its runs share its key (James, 2026-11-22)
                    const cell = at(v.id, 'query-compare-key');
                    cell.append(sidePicker(first, p, 'left', v), el('span', 'query-compare-value font-mono', sampleOf(v.id, pair.left.column)));
                    const runsOfBase = views().filter(x => x.runOf === baseline.id);
                    if (runsOfBase.length && runsOfBase.every(x => members.includes(x.id))) cells['lane:' + baseline.id] = cell;
                    else cells[v.id] = cell;
                    return;
                }
                const join = joinOf(v.id);
                if (members.includes(v.id) && join && v.runOf) {
                    // A run: its first run's column, the same View ("sku, the same")
                    const ref = join.on[p] && join.on[p].right;
                    const cell = at(v.id, 'query-compare-key');
                    cell.append(el('span', 'query-compare-same font-mono', ref && ref.column ? `${ref.column}, the same` : 'the same column'), el('span', 'query-compare-value font-mono', ref ? sampleOf(v.id, ref.column) : ''));
                    cells[v.id] = cell;
                    return;
                }
                if (members.includes(v.id) && join) {
                    const cell = at(v.id, 'query-compare-key');
                    const ref = join.on[p] && join.on[p].right;
                    if (!join.on[p]) join.on[p] = { left: Object.assign({}, pair.left), right: { column: '' } };
                    const pick = sidePicker(join, p, 'right', v);
                    // The first key column: "Not compared" takes the view out; it then joins the Baseline below, to show
                    if (p === 0) {
                        const select = pick.querySelector('select');
                        const out = el('option', '', 'Not compared');
                        out.value = '\u0000out';
                        // (first in the picker: how a view is taken out of the compare)
                        select.insertBefore(out, select.options[0] || null);
                        select.addEventListener('change', event => {
                            if (select.value !== '\u0000out') return;
                            event.stopImmediatePropagation();
                            post({ type: 'query.setJoin', view: v.id, kind: 'left', on: join.on.filter(x => x.right.column).map(x => pagePair(x.left, x.right)) });
                            setBusy('Joining…');
                        }, true);
                    }
                    cell.append(pick, el('span', 'query-compare-value font-mono', ref ? sampleOf(v.id, ref.column) : ''));
                    cells[v.id] = cell;
                    return;
                }
                // A view after the Baseline, out of the compare: its columns, to put it in
                if (p === 0 && join && viewAt(v.id) > viewAt(baseline.id)) {
                    // (built as a view in the compare is, picker then value, so the lanes line up: James, 2026-11-23, "the cell
                    // widths are different"; its own join line below says it isn't joined)
                    const cell = at(v.id, 'query-compare-out');
                    const select = el('select');
                    select.setAttribute('aria-label', `${v.name} in the compare`);
                    const no = el('option', '', 'Not compared'); no.value = ''; select.appendChild(no);
                    v.columns.forEach(c => {
                        const o = el('option', '', full ? `${c.name} (a compare takes ${max})` : c.name);
                        o.value = c.name; o.title = c.sample; o.disabled = full;
                        select.appendChild(o);
                    });
                    select.addEventListener('change', () => {
                        if (!select.value) return;
                        setBusy('Joining…');
                        post({ type: 'query.setJoin', view: v.id, kind: 'compare', on: [pagePair(first.on[0].left, { column: select.value })] });
                    });
                    const pick = el('span', 'query-pick');
                    pick.appendChild(select);
                    cell.append(pick, el('span', 'query-compare-value font-mono', ''));
                    cells[v.id] = cell;
                }
            });
            const lead = [];
            const says = [];
            if (p === 0) {
                lead.push(kindButton(first, view(first.view) || baseline, kind => { setBusy('Joining…'); sendAll(kind); }));
                const and = el('button', 'compare-tool-btn text-link font-mono font-size-12', '+ AND');
                and.dataset.and = '';
                and.type = 'button';
                and.title = 'Another key column, across every view in the compare';
                and.addEventListener('click', () => { first.on.push({ left: { view: baseline.id, column: '' }, right: { column: '' }, picked: true }); renderJoins(); });
                says.push(and);
            } else {
                // (a further key line: its gutter empty, its × at the end)
                const drop = el('button', 'compare-tool-btn icon');
                drop.type = 'button';
                drop.title = 'Take this key column out';
                drop.setAttribute('aria-label', 'Take this key column out');
                drop.dataset.icon = 'x';
                drop.addEventListener('click', () => { first.on.splice(p, 1); sendJoin(first); });
                says.push(drop);
            }
            band.appendChild(line('query-pair query-compare-line', cells, says, lead));
        });
        // How many are in: said once, under the lanes
        // (how many a compare takes is said where it matters: a full compare's other views offer their columns "(a compare takes 4)", disabled)
        // The summary: one bar across the lanes, as the mock has it. Closed: each later view's records that
        // meet the Baseline's one to one ("C1 1,198 · C2 1,199 one to one"), the repeats said once at its end,
        // the rows the compare leaves after it. While the counts are worked out it says so (is-pending)
        const nameOf = v => v.run || v.name;
        const inCompare = views().filter(v => members.includes(v.id));
        const keyed = first.on.length > 0 && first.on.every(p => p.left.column);
        if (!keyed || inCompare.length < 2) return band;
        // Every record counted, run by run (the host's query.joinCounts): each run's or view's figures against
        // the Baseline under it, its bar where they will show while it counts, the ones to come waiting
        const jc = ui.joinCounts && ui.joinCounts.baseline === baseline.id ? ui.joinCounts : null;
        // No counts from the host, and why: said in one line where they would be, not bars that wait for nothing
        if (!jc && ui.joinCountsWhy) {
            const why = document.createElement('dbmn-status');
            why.setAttribute('inline', '');
            why.textContent = ui.joinCountsWhy;
            band.appendChild(line('query-compare-verdict', { __span: why }, [], []));
            return band;
        }
        const others = inCompare.filter(v => v.id !== baseline.id);
        const countOf = v => (jc && jc.views[v.id]) || { state: 'waiting' };
        const done = others.map(countOf).filter(c => c.count);
        // The lines: matched, only here, only in the Baseline, then a repeated key or a blank one only when there are any
        const repeats = done.some(c => c.count.repeatedKeys || c.count.baselineRepeatedKeys);
        const blanks = done.some(c => c.count.noKey);
        const KINDS = [
            { kind: 'oneToOne', rows: 'matched', title: v => `${nameOf(v)} matched with ${nameOf(baseline)}`, of: c => c.matched, says: v => `Matched: ${nameOf(v)}'s records that ${nameOf(baseline)} has too` },
            { kind: 'onlyOther', rows: 'onlyHere', title: v => `Only in ${nameOf(v)}`, of: c => c.onlyHere, says: v => `Only in ${nameOf(v)}: not in ${nameOf(baseline)}. Each shows as Missing in ${nameOf(baseline)}` },
            { kind: 'onlyBase', rows: 'onlyBaseline', title: v => `Only in ${nameOf(baseline)}, not in ${nameOf(v)}`, of: c => c.onlyBaseline, says: v => `Only in ${nameOf(baseline)}: ${nameOf(baseline)}'s records ${nameOf(v)} hasn't. Each shows as Missing in ${nameOf(v)}` },
            // (a key's records after its first: what the dialog tags Duplicate, so the figure is the rows it tags)
            ...(repeats ? [{ kind: 'repeat', rows: 'repeat', title: v => `Duplicated in ${nameOf(v)}`, of: c => Math.max(0, (c.repeatedRecords || 0) - (c.repeatedKeys || 0)), says: v => `A key ${nameOf(v)} has more than once: ${nameOf(baseline)}'s record shows once for each in Results` }] : []),
            ...(blanks ? [{ kind: 'noKey', rows: 'noKey', title: v => `${nameOf(v)}: no key`, of: c => c.noKey, says: v => `${nameOf(v)}'s records with a blank key: they match nothing, and show as No key` }] : [])
        ];
        // (the repeat line's picture: one to many, many to one, or many to many when both sides repeat)
        const glyphOf = k => {
            if (k.kind !== 'repeat') return k.kind === 'noKey' ? 'onlyOther' : k.kind;
            const other = done.some(c => c.count.repeatedKeys), base = done.some(c => c.count.baselineRepeatedKeys);
            return other && base ? 'manyToMany' : base ? 'manyToOne' : 'oneToMany';
        };
        const gutter = el('div', 'query-counts-gutter');
        KINDS.forEach(k => {
            const g = el('span', 'query-counts-glyph');
            g.appendChild(window.RelationGlyph.svg(glyphOf(k)));
            g.title = k.kind === 'oneToOne' ? 'Matched with the Baseline' : k.kind === 'onlyOther' ? 'Only in this run or view' : k.kind === 'onlyBase' ? 'Only in the Baseline: missing here'
                : k.kind === 'repeat' ? (glyphOf(k) === 'manyToMany' ? 'Many to many: a key repeats on both sides' : glyphOf(k) === 'manyToOne' ? 'Many to one: the Baseline has a key more than once' : 'One to many: a key repeats here') : 'No key';
            gutter.appendChild(g);
        });
        const cells = {};
        inCompare.forEach(v => {
            const cell = at(v.id, 'query-counts-cell');
            cell.style.setProperty('--count-lines', String(KINDS.length));
            if (v.id === baseline.id) {
                KINDS.forEach(() => cell.appendChild(el('span', 'query-counts-n is-quiet', '–')));
            } else {
                const c = countOf(v);
                if (c.state === 'counting' || (c.state === 'waiting' && !c.count)) {
                    // One bar in its cells while it counts (the design system's, as the reading bars); the ones to come wait
                    cell.classList.add('is-counting');
                    cell.appendChild(countProgress(v, c));
                } else if (c.state === 'failed') {
                    cell.appendChild(el('span', 'query-warn', 'Could not count'));
                } else {
                    if (c.stale || c.state !== 'done') cell.classList.add('is-stale');
                    if (justCounted(v.id)) cell.classList.add('is-read-done');
                    KINDS.forEach(k => {
                        const n = k.of(c.count) || 0;
                        const span = el('span', `query-counts-n${n ? '' : ' is-quiet'}${k.kind === 'repeat' && n ? ' query-warn' : ''}`);
                        // Every count opens its records, in the rows dialog's table (search and count at its top)
                        if (n && c.state === 'done' && !c.stale) {
                            const open = el('button', 'query-count-btn', count(n));
                            open.type = 'button';
                            open.title = `${k.says(v)}. Click to see them`;
                            // (the run's own key columns: a duplicates table puts them first, in the key's order)
                            const keys = first.on.map((p, i) => (v.id === baseline.id ? p.left.column : ((joinOf(v.id) || { on: [] }).on[i] || { right: {} }).right.column)).filter(Boolean);
                            open.addEventListener('click', () => previewView(k.rows === 'onlyBaseline' ? baseline : v, { kind: k.rows, of: v.id, title: k.title(v), duplicates: k.rows === 'repeat', keys }));
                            span.appendChild(open);
                        } else { span.textContent = count(n); span.title = k.says(v); }
                        cell.appendChild(span);
                    });
                }
            }
            cells[v.id] = cell;
        });
        band.appendChild(line('query-counts-line', cells, [], [gutter]));
        // A repeated key: said once, plainly, as a fact, not a problem (James, 2026-11-23: "I like we're showing it's one to
        // many… it just is what it is… You're making it look like a problem"): how many key values repeat and over how many
        // records, by the runs alike. No warning colour, no advice
        const rep = others.filter(v => countOf(v).count && countOf(v).count.repeatedKeys);
        if (rep.length) {
            const keyName = first.on.map(p => p.left.column).filter(Boolean).join(' + ');
            const byN = new Map();
            rep.forEach(v => { const c = countOf(v).count; const at = `${c.repeatedKeys}\u0000${c.repeatedRecords}`; byN.set(at, [...(byN.get(at) || []), nameOf(v)]); });
            const list = names => (names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
            const words = [...byN].map(([at, names]) => {
                const [keys, records] = at.split('\u0000').map(Number);
                return `${count(keys)} ${keyName} ${keys === 1 ? 'value repeats' : 'values repeat'} in ${list(names)}, across ${count(records)} records.`;
            });
            const said = document.createElement('dbmn-status');
            said.setAttribute('inline', '');
            said.textContent = words.join(' ');
            band.appendChild(line('query-compare-verdict', { __span: said }, [], []));
        }
        // Results' rows, once every run is counted
        const r = jc && jc.results;
        const said = el('span', `query-made query-counts-results${r && r.stale ? ' is-stale' : ''}`);
        if (r && (r.state === 'done' || r.stale)) {
            said.append(el('b', '', count(r.rows)), ' rows · ', el('b', '', count(r.inEvery)), ` in every ${others.every(v => v.run) ? 'run' : 'view'}`);
        } else said.textContent = 'Counting…';
        band.appendChild(line('query-made-line', { __span: said }, [], [el('span', 'query-lead-text', 'Results')]));
        return band;
    }

    /** A run's or view's bar in its count cells: "Counting" filling as the host says, or "Waiting" empty. */
    function countProgress(v, c) {
        const bar = document.createElement('dbmn-progress');
        bar.setAttribute('inline', '');
        bar.className = 'query-read-progress';
        bar.dataset.countView = v.id;
        fillCount(bar, c);
        return bar;
    }
    function fillCount(bar, c) {
        bar.removeAttribute('busy');
        bar.removeAttribute('count');
        bar.setAttribute('phase', c.state === 'counting' ? 'Counting' : 'Waiting');
        bar.setAttribute('value', String(c.state === 'counting' && c.total ? Math.round(100 * c.done / c.total) : 0));
    }
    /** When each run's counts came in: for a moment after, its cell fades from a full bar into them. */
    const countedAt = {};
    const justCounted = id => !!countedAt[id] && Date.now() - countedAt[id] < 1400;
    /** The host's counts: a bar moved in place, or the Join step drawn again when a run starts or finishes. */
    function joinCountsIn(counts) {
        const before = ui.joinCounts;
        const shape = c => (c ? Object.entries(c.views).map(([id, x]) => `${id}:${x.state}:${x.stale ? 1 : 0}`).join('|') + `|${c.results ? c.results.state + (c.results.stale ? 's' : '') : ''}` : '');
        if (counts && before) Object.entries(counts.views).forEach(([id, x]) => { if (x.state === 'done' && (!before.views[id] || before.views[id].state !== 'done')) countedAt[id] = Date.now(); });
        ui.joinCounts = counts;
        // (drawn whichever step is on show: the Join step is ready when it's opened)
        if (counts && before && shape(counts) === shape(before)) {
            document.querySelectorAll('dbmn-progress[data-count-view]').forEach(bar => { const x = counts.views[bar.dataset.countView]; if (x) fillCount(bar, x); });
            return;
        }
        renderJoins();
    }

    /**
     * The values behind a count, in a dialog: each value of that kind once, with how many of that
     * view's rows hold it, under a sentence that says what the count is.
     */
    function showValues(join, kind, side) {
        const stats = join.stats;
        const mine = view(side === 'left' ? join.on[0].left.view : join.view) || {};
        const theirs = view(side === 'left' ? join.view : join.on[0].left.view) || {};
        const column = join.on.map(p => p[side].column).filter(Boolean).join(' + ') || 'key';
        const list = stats.values.filter(value => valueKind(value) === kind).map(value => ({ key: value.key.map(k => k === null ? '(blank)' : cellText(k)).join(' · '), held: value[side] }));
        // Rows with nothing to join on match nothing
        if (kind === 'onlyBase' && stats.leftBlank) list.unshift({ key: '(blank)', held: stats.leftBlank });
        const matched = stats.keys.oneToOne + stats.keys.oneToMany + stats.keys.manyToOne + stats.keys.manyToMany;
        const all = side === 'left' ? stats.leftValues : stats.rightValues;
        const n = kind === 'onlyBase' || kind === 'onlyOther' ? Math.max(0, all - matched) : stats.keys[kind];
        const some = (one, many) => (n === 1 ? one : many);
        const has = `${mine.name} has ${count(all)} different ${column} ${all === 1 ? 'value' : 'values'}.`;
        const label = (KINDS.find(k => k[0] === kind) || [])[1] || '';
        let title;
        let said;
        if (kind === 'onlyBase') {
            const rows = stats.leftRows - stats.leftMatched;
            title = `${column} values in ${mine.name} with no match in ${theirs.name}`;
            said = `${has} ${count(n)} of them ${some('has', 'have')} no record in ${theirs.name}. ${count(rows)} ${rows === 1 ? 'row holds' : 'rows hold'} ${some('it', 'them')}${stats.leftBlank ? ' or have no value at all' : ''}: ${unmatchedSays(join, `${theirs.name} blank`, 'those rows')}.`;
        } else if (kind === 'onlyOther') {
            title = `${column} values in ${mine.name} that are not used`;
            said = `${has} ${count(n)} of them ${some('is', 'are')} not in ${theirs.name}, so nothing joins to ${some('it', 'them')}.`;
        } else {
            title = `${column} values in ${mine.name} that match ${theirs.name}: ${label.toLowerCase()}`;
            said = `${has} ${count(n)} of them ${some('matches', 'match')} ${theirs.name} ${label.toLowerCase()}.`;
        }
        const body = el('div', 'query-values');
        body.dataset.kind = kind;
        body.dataset.side = side;
        body.appendChild(el('p', 'form-hint', said));
        const box = el('div', 'table-container compare-drill-records');
        const table = el('table', 'data-table');
        const head = el('thead');
        const headRow = el('tr');
        headRow.append(el('th', '', column), el('th', 'text-right', `Rows in ${mine.name}`));
        head.appendChild(headRow);
        const rows = el('tbody');
        list.forEach(value => {
            const tr = el('tr', 'query-value');
            tr.append(el('td', 'font-mono', value.key), el('td', 'font-mono text-right', count(value.held)));
            rows.appendChild(tr);
        });
        table.append(head, rows);
        box.appendChild(table);
        body.appendChild(box);
        // The engine keeps the first 50 values of a kind
        if (n > list.length) body.appendChild(el('p', 'form-hint', `The first ${count(list.length)} of ${count(n)}.`));
        window.DbmnModal.show({ title, body, size: 'md', actions: [{ id: 'close', label: 'Close', variant: 'secondary' }] });
    }

    function renderJoins() {
        const s = ui.state;
        const box = $('queryJoins');
        if (!s || !s.views.length) { box.replaceChildren(el('p', 'form-hint', 'Add a view first.')); return; }
        // Each view's rows, under its slot
        const totals = {};
        s.views.forEach(v => {
            const cell = at(v.id, 'query-count');
            if (!v.error && !v.reading) { cell.appendChild(readDone(v, rowsButton(v))); if (justNow(v.id)) cell.classList.add('is-read-done'); }
            else if (v.reading) { cell.classList.add('is-reading'); cell.appendChild(readProgress(v)); }
            cell.title = v.file ? `${v.name}: a row per line of ${v.file}` : `${v.name}: a row per ${v.rowBasis === 'root' ? 'response' : v.rowBasis}`;
            totals[v.id] = cell;
        });
        const first = s.views[0];
        const lines = [line('query-total-line', totals, [first.error ? errorLine(first) : null], [el('span', 'query-lead-text', 'Rows')])];
        if (s.views.length < 2) lines.push(el('p', 'compare-match-empty', 'Add another view to join.'));
        // What stops the query running (a lookup table deleted, say): said once, in full, above the joins; never a
        // join's guess that its view is left out (its counts are missing for this reason, not that one)
        if (s.error) {
            const why = document.createElement('dbmn-status');
            why.className = 'query-error-note';
            why.setAttribute('inline', '');
            why.setAttribute('tone', 'warn');
            why.textContent = s.error;
            lines.unshift(why);
        }
        // The views in a compare join as one: one band, first; the joins that bring views in to show below it
        if (s.joins.some(j => j.kind === 'compare')) lines.push(compareBand());
        // The plain joins: each made, and each brought up by + Add join; nothing appears or goes by itself (James, 2026-11-23:
        // "add an add join button and stop sort of flipping and adding and removing the second join")
        const shown = window.QueryJoinRules.joinLines(s, ui.joinLines, ui.joinsTouched);
        shown.lines.forEach(id => {
            const v = view(id);
            const join = s.joins.find(j => j.view === id);
            if (!v || !join) return;
            ui.joinLines.add(id);
            // (its columns from any other view: a view moved keeps its join, to a view on its right too)
            lines.push(joinBand(v, join, s.views.filter(x => x.id !== v.id)));
        });
        // Add join: the next view not joined gets its line, every box "Pick a column". The lists' add-row button
        // (dbmn-table-add-row: a plus, the screen's own font), in the gutter under the join's picture, straight under the
        // last join (James, 2026-11-23: "in a weird spot… make it a proper add row")
        if (shown.next) {
            const add = el('button', 'dbmn-table-add-row query-add-join');
            add.type = 'button';
            add.title = `A join for ${(view(shown.next) || {}).name || 'the next view'}`;
            const plus = el('span', 'dbmn-table-add-icon');
            plus.dataset.icon = 'plus';
            add.append(plus, el('span', '', 'Add join'));
            add.addEventListener('click', () => { ui.joinLines.add(shown.next); ui.joinsTouched = true; renderJoins(); });
            const row = el('div', 'dbmn-lanes-row query-line query-add-join-line');
            const start = el('div', 'dbmn-lanes-gutter query-lead');
            start.dataset.gutter = '';
            start.appendChild(add);
            row.appendChild(start);
            lines.push(row);
        }
        box.replaceChildren(...lines);
        applyLanes(box);
        injectIcons(box);
        placeAdds();
        requestAnimationFrame(() => drawLinks(box));
    }

    /**
     * Each join pair's link, from the end of its left column's cell to the start of its right one however far apart:
     * a dot each end for one, two for many (the join's first pair: its relationship), lines between, each end in its
     * view's colour. Drawn from where the cells are now, and again when the step changes size.
     */
    function drawLinks(box) {
        const NS = 'http://www.w3.org/2000/svg';
        // Option A (James, 2026-11-22): per pair of views a join joins, its relationship once, where the two views meet
        // (one dot = one, two = many), centred on that pair's key lines; lines only from dot to dot, nothing else drawn.
        // A view joined to two views: two drawings. (The join's figures are for the whole join: with two views joined
        // to, each drawing is plain dots, its relationship not known apart)
        box.querySelectorAll('.query-join').forEach(band => {
            band.querySelectorAll(':scope > svg.query-link').forEach(n => n.remove());
            const rows = Array.from(band.querySelectorAll('.query-pair[data-link-from]'));
            if (!rows.length || !band.offsetParent) return;
            const r = band.getBoundingClientRect();
            const groups = new Map();
            rows.forEach(row => {
                const from = row.querySelector(`.query-at[data-view="${CSS.escape(row.dataset.linkFrom)}"]`);
                const to = row.querySelector(`.query-at[data-view="${CSS.escape(row.dataset.linkTo)}"]`);
                if (!from || !to) return;
                const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
                const k = `${row.dataset.linkFrom}\u0000${row.dataset.linkTo}`;
                if (!groups.has(k)) groups.set(k, { from: row.dataset.linkFrom, to: row.dataset.linkTo, a, b, ys: [], relation: row.dataset.relation });
                groups.get(k).ys.push((a.top + a.bottom) / 2 - r.top);
            });
            if (!groups.size) return;
            const svg = document.createElementNS(NS, 'svg');
            svg.setAttribute('class', 'query-link');
            const put = (tag, attrs, className) => {
                const node = document.createElementNS(NS, tag);
                Object.keys(attrs).forEach(k => node.setAttribute(k, attrs[k]));
                if (className) node.setAttribute('class', className);
                svg.appendChild(node);
            };
            const alone = groups.size === 1;
            const names = [];
            groups.forEach(g => {
                const relationship = alone ? g.relation : 'none';
                const name = (KINDS.find(k => k[0] === relationship) || [])[1];
                if (name) names.push(name);
                // (drawn from whichever view is on the left: the view joined to can be on either side)
                const back = g.a.left > g.b.left;
                const lo = back ? g.b : g.a, hi = back ? g.a : g.b;
                const x1 = lo.right - r.left - 9, x2 = hi.left - r.left + 9;
                const mid = (Math.min(...g.ys) + Math.max(...g.ys)) / 2;
                const manyFrom = relationship === 'manyToOne' || relationship === 'manyToMany', manyTo = relationship === 'oneToMany' || relationship === 'manyToMany';
                const many = { left: back ? manyTo : manyFrom, right: back ? manyFrom : manyTo };
                const ys = side => (many[side] ? [mid - 6, mid + 6] : [mid]);
                const leftView = back ? g.to : g.from, rightView = back ? g.from : g.to;
                ys('left').forEach(y1 => ys('right').forEach(y2 => put('line', { x1, y1, x2, y2 }, 'is-dashed')));
                ys('left').forEach(cy => put('circle', { cx: x1, cy, r: 4 }, colour(leftView)));
                ys('right').forEach(cy => put('circle', { cx: x2, cy, r: 4 }, colour(rightView)));
            });
            if (names.length) {
                svg.setAttribute('role', 'img');
                svg.setAttribute('aria-label', names.join(', '));
                const said = document.createElementNS(NS, 'title');
                said.textContent = names.join(', ');
                svg.insertBefore(said, svg.firstChild);
            } else svg.setAttribute('aria-hidden', 'true');
            band.appendChild(svg);
        });
    }
    // (the links follow the cells when the window, and so the lanes, change size)
    if (window.ResizeObserver) new ResizeObserver(() => { const box = $('queryJoins'); if (box) drawLinks(box); }).observe($('queryJoins'));

    /** Results' columns: the steps', or what the user's own SQL makes. */
    function resultCols() { return (ui.state && ui.state.resultColumns) || []; }

    /* ---------- Columns ---------- */

    /* The Columns step (query-columns.js), drawn with this page's own pieces; calculated columns in the shared Functions window */
    const columnsStep = window.QueryColumns.create({
        // Columns tells the step bar when its report becomes empty or not (Next: Results waits while it is)
        stepsChanged: () => renderBar(),
        el, at, line, views, view, viewAt, colour, post, setBusy, count, injectIcons, CALC_VIEW: '',
        state: () => ui.state,
        openCalc: calc => openCalc(calc),
        pickFns: (ref, done) => pickFns(null, ref, done),
        fnWords: (fns, name) => fnWords(fns, name)
    });
    ui.columnsStep = columnsStep;
    function renderColumns() { columnsStep.render(); }
    /**
     * A calculated column, in the shared Functions window (James, 2026-11-25: steps only, no typed formulas): its Name, what
     * it starts from (any view's column, or another calculation), then steps, each one Map's and the Join's; its sample on
     * the first rows, step by step, from the host (query.calcSample). A typed formula saved before opens empty under its
     * name, to be rebuilt; the host keeps it read-only until then.
     */
    async function openCalc(calc) {
        if (!window.DbmnFunctions) return;
        const s = ui.state || {};
        const name = calc ? calc.name : '';
        const starts = views().flatMap(v => (v.columns || []).map(c => ({ id: `${v.id}\n${c.name}`, label: `${v.run || v.name}.${c.name}` })))
            .concat((s.calc || []).filter(c => c.start && c.name !== name).map(c => ({ id: `calc:${c.name}`, label: c.name })));
        const label = id => { const hit = starts.find(c => c.id === id); return hit ? hit.label : id; };
        const known = id => fnList().some(d => d.id === id);
        const toQuery = applied => applied.filter(a => known(a.id)).map(a => Object.assign({ fn: a.id }, a.params || {}));
        const fromQuery = fns => (fns || []).filter(f => known(f.fn)).map(f => { const params = {}; Object.keys(f).forEach(k => { if (k !== 'fn') params[k] = f[k]; }); return { id: f.fn, params }; });
        let asked = 0;
        const waiting = new Map();
        ui.calcSample = m => {
            const resolve = waiting.get(m.seq);
            if (!resolve) return;
            waiting.delete(m.seq);
            if (!m.ok) { resolve({ rows: [], error: m.error }); return; }
            // (each row: the record's key, the start, then after each step; the last is what the column shows)
            resolve({ rows: (m.rows || []).map(r => ({ before: r[1], steps: r.slice(2), after: r[r.length - 1] })), agree: null });
        };
        const made = await window.DbmnFunctions.open({
            column: label(calc && calc.start && calc.start.col !== undefined ? calc.start.col : (starts[0] || {}).id),
            functions: fnList(),
            defaults: fnDefaults(),
            applied: fromQuery(calc && calc.steps),
            columns: starts,
            calc: { name, start: calc && calc.start && calc.start.col !== undefined ? calc.start.col : (starts[0] || {}).id, starts },
            sample: (list, opts) => new Promise(resolve => {
                const seq = ++asked;
                waiting.set(seq, resolve);
                post({ type: 'query.calcSample', seq, name, start: { col: opts && opts.start !== undefined ? opts.start : (starts[0] || {}).id }, steps: toQuery(list) });
            })
        });
        ui.calcSample = null;
        if (!made) return;
        setBusy('Updating…');
        post({ type: 'query.setCalcSteps', name: made.name, ...(calc ? { was: calc.name } : {}), start: { col: made.start }, steps: toQuery(made.steps || []) });
    }

    /* ---------- Results ---------- */

    /* The design system's table (shared/dbmn-table.js) over rows that stay with the host: it asks
     * for the pages in view, says what was sorted, moved, removed or resized, and this page passes
     * each on. The search is this page's own box (Results' tools), so the host is asked with what
     * it holds. */
    const table = $('queryTable');
    const grid = {
        key: '',            // the columns the table was last given
        waiting: new Map(), // pages asked for and not yet in, by their number
        asked: 0,
        sorting: false
    };

    function colId(c) { return `${c.view}:${c.column}`; }
    function columnsKey() {
        // (a compare's headings carry its filters and counts: they are drawn again when either changes)
        const compare = hasStatus() ? `\u0002status:${JSON.stringify([ui.filter, ui.resultsView, ui.diffsOnly, ui.counts && ui.counts.columns, ui.counts && ui.counts.relations])}` : '';
        return resultCols().map(c => `${colId(c)}#${c.type || ''}#${c.group || ''}`).join('\u0001') + compare;
    }

    /** The table's columns: each in its view's colour, the same name in two views saying whose it is. */
    const compareResults = window.QueryCompareResults.create({
        el, ui, post, view, views, colour, count, day, hasStatus: () => hasStatus(), withSummary: (v, items) => withSummary(v, items), specialOn: () => specialOn(),
        reload: () => loadRows(),
        // Clear all filters empties the search too: back to every record (James, 2026-11-22)
        clearSearch: () => {
            clearTimeout(searchTimer);
            $('querySearch').value = '';
            savedNow();
            ui.search = '';
            window.SearchMatcher.renderHighlight($('querySearchMirror'), '', searchHeadings(), notInReport());
            renderReads();
        },
        redraw: () => { grid.key = ''; drawTable(); loadRows(true); },
        renderSlots: () => renderTop()
    });

    /** Where a column of Results is, for its status: its run (BL, C1…), its view, or a COMPARE side's number. */
    function placeOf(c) {
        if (!c.view) { const m = / (\d+)$/.exec(c.column); return m ? m[1] : c.column; }
        const v = view(c.view);
        return v ? (v.run || v.name) : c.view;
    }
    function hasStatus() { return !!(ui.state && ui.state.statusPlaces); }
    function tableColumns() {
        const all = resultCols();
        const groupSize = new Map();
        all.forEach(c => { if (c.group) groupSize.set(c.group, (groupSize.get(c.group) || 0) + 1); });
        const compared = c => !!(c.group && groupSize.get(c.group) > 1);
        const status = hasStatus();
        // Diffs: a compared column no row differs in is hidden; a hidden result's cells too (from view only)
        const differs = ((ui.counts || {}).columns) || {};
        let columns = all.filter(c => !(status && ui.diffsOnly && compared(c) && !differs[c.group]) && !(status && compared(c) && ui.filter.hidden.includes(placeOf(c))));
        // Compact: each compared column in one cell
        if (status && ui.resultsView === 'compact') {
            const seen = new Set();
            columns = columns.filter(c => { if (!compared(c)) return true; if (seen.has(c.group)) return false; seen.add(c.group); return true; })
                .map(c => (compared(c) ? Object.assign({ compact: true }, c) : c));
        }
        const names = columns.map(c => c.column);
        const lead = status ? compareResults.leadColumns() : [];
        return lead.concat(columns.map(c => {
            if (c.compact) {
                const cells = all.filter(x => x.group === c.group);
                return { id: `compact:${c.group}`, name: c.group, className: 'compare-first', head: th => compareResults.groupHead(th, c.group), render: () => '', cell: (td, _v, row) => compareResults.compactCell(td, row, cells, placeOf, colId) };
            }
            // A compared column: its name over its cells, each headed by its place; a cell that differs in its place's tint
            if (c.group && groupSize.get(c.group) > 1) {
                // Its value differs from the first cell of its own column (a place without the record is Missing, not different)
                const first = all.find(x => x.group === c.group);
                const firstId = colId(first);
                const text = v => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
                // (a COMPARE calculation's sides have no view: each side the colour of its place, 1 blue, 2 orange…)
                const tint = c.view ? colour(c.view) : `dbmn-run-${Math.max(0, (Number(placeOf(c)) || 1) - 1) % 4}`;
                return {
                    id: colId(c), name: placeOf(c), className: `compare-sub ${tint}`, numbers: c.type === 'number',
                    group: { id: `group:${c.group}`, name: c.group, head: th => compareResults.groupHead(th, c.group) },
                    cell: (td, v, row) => {
                        const st = row.__status;
                        if (!st) { td.classList.toggle('compare-differs', colId(c) !== firstId && text(v) !== text(row[firstId])); return; }
                        // Tinted where its place is one that differs (Status) and its value is unlike the one it is measured
                        // against: the Baseline's, or the first present when the Baseline lacks the record; the Baseline's own
                        // when it is the odd one out ("DIFF BL", 2026-11-22: as old Compare)
                        const place = placeOf(c);
                        const cells = all.filter(x => x.group === c.group).filter(x => !st.missing.includes(placeOf(x)) && !ui.filter.hidden.includes(placeOf(x)));
                        const here = !st.missing.includes(place) && st.diff.includes(place);
                        const others = cells.filter(x => colId(x) !== colId(c));
                        const against = colId(c) === firstId ? others : cells.slice(0, 1).filter(x => colId(x) !== colId(c));
                        td.classList.toggle('compare-differs', here && against.some(x => text(row[colId(x)]) !== text(v)));
                    }
                };
            }
            const v = view(c.view);
            const name = v && v.name;
            // A compared column's cells: its name and whose each is; a renamed column: its name
            const grouped = c.group && columns.filter(x => x.group === c.group).length > 1;
            const text = grouped ? `${c.group} (${name || ''})`
                : c.group ? c.group
                    : names.indexOf(c.column) !== names.lastIndexOf(c.column) && v ? (name ? `${c.column} (${name})` : `${v.table}.${c.column}`) : c.column;
            // (the host says what kind of values a column holds: a column of numbers sorts 0 to 1, not A to Z)
            // (a compare's key: the table's key mark on its heading, as it was before)
            const first = (ui.state.joins || []).find(j => j.kind === 'compare');
            const isKey = !c.group && !!first && first.on.some(p => p.left && p.left.view === c.view && p.left.column === c.column);
            return { id: colId(c), name: text, className: `compare-sub ${colour(c.view)}`, numbers: c.type === 'number', ...(isKey ? { key: true } : {}) };
        }));
    }
    function sortOf() {
        const c = ui.sort && resultCols()[ui.sort.column];
        if (!c) return null;
        // (a compared column shown compact: its arrow on the compact column, which sorts by its first cell)
        const compact = c.group && (table.columns || []).some(t => t.id === `compact:${c.group}`) ? `compact:${c.group}` : '';
        return { id: compact || colId(c), dir: ui.sort.dir };
    }

    /** Give the table its columns when they are not the ones it has, with the widths and sort kept for them. */
    function drawTable() {
        const key = columnsKey();
        if (key === grid.key) return;
        grid.key = key;
        const columns = resultCols();
        // The user's own SQL makes its own columns: they are neither moved nor taken out here
        table.toggleAttribute('locked', columns.length < 2);
        table.columns = tableColumns();
        const kept = (ui.state && ui.state.widths) || {};
        const widths = {};
        columns.forEach(c => { if (kept[colId(c)]) widths[colId(c)] = kept[colId(c)]; });
        table.layout = { widths, sort: sortOf() };
    }

    /** One page of rows, asked of the host: the answer comes back as query.rowsData. */
    function page(start, limit) {
        const id = ++grid.asked;
        if (start === 0) { grid.stopped = false; readingStop(true); reading('Reading the rows'); }
        post({ type: 'query.rows', seq: id, offset: start, limit, search: ui.search, sort: ui.sort, totals: ui.totals, ...(hasStatus() ? { filter: ui.filter } : {}) });
        return new Promise(resolve => grid.waiting.set(id, { resolve, ids: resultCols().map(colId) }));
    }

    /** Results from the top: after a search, a sort, or a change to the query. `keep`: staying scrolled where it is (a column was taken out). */
    function loadRows(keep) {
        if (!ui.state) return;
        drawTable();
        markFiltered();
        // (what an empty Results says: its Status filter or Only diffs left nothing, or its search found nothing, #34)
        if (!table.emptyText) table.emptyText = ({ searched }) => (hasStatus() && (compareResults.anyFilter() || ui.diffsOnly) ? 'No rows match the filters.' : searched ? 'No rows match the search.' : 'No rows.');
        if (!table.source) table.source = { page };
        else table.reload(keep ? { keep: true } : undefined);
    }

    /**
     * Results working on its rows (the first page asked, not in yet): the line above the table says what and
     * how far, and the table's own "No rows." from before is not shown meanwhile. Null: the rows are in.
     */
    function reading(say) {
        // (the design system's working line, dbmn-progress inline: its stage, how far, the seconds it has taken, Stop)
        // It shows only once the work has taken a moment: a quick filter or sort never flashes it (James, 2026-11-22)
        const line = $('queryReading');
        const on = !!say;
        // (a stage said meanwhile doesn't put it off: the moment counts from when the work began)
        if (on && line.classList.contains('hidden') && !readingShow) readingShow = setTimeout(() => { readingShow = undefined; line.classList.remove('hidden'); }, READING_AFTER_MS);
        if (!on) { clearTimeout(readingShow); readingShow = undefined; line.classList.add('hidden'); }
        table.classList.toggle('is-reading', on);
        if (!on) { line.removeAttribute('since'); line.removeAttribute('note'); line.removeAttribute('tone'); return; }
        const it = typeof say === 'string' ? { phase: say } : say;
        if (!line.hasAttribute('since')) line.setAttribute('since', String(Date.now()));
        line.setAttribute('phase', it.phase);
        if (typeof it.value === 'number') { line.setAttribute('value', String(it.value)); line.removeAttribute('busy'); } else { line.removeAttribute('value'); line.setAttribute('busy', ''); }
    }

    /** How long Results works before its working line shows. */
    const READING_AFTER_MS = 600;
    let readingShow;
    /** The records of the Baseline Join and Columns check (the host's SAMPLE_ROWS). */
    const SAMPLE_ROWS = 1000;

    /** Stop on the working line, or (stopped) the link that asks again. */
    function readingStop(on) {
        const line = $('queryReading');
        if (on) { line.setAttribute('stop', ''); line.removeAttribute('again'); } else { line.removeAttribute('stop'); line.setAttribute('again', 'Work them out'); }
    }
    $('queryReading').addEventListener('dbmn-progress-stop', () => {
        // Stop: Results' run ends between its slices; the line says so and offers to start again
        grid.stopped = true;
        post({ type: 'query.stopReading' });
        const line = $('queryReading');
        line.setAttribute('phase', 'Stopped: Results\' rows not worked out');
        line.removeAttribute('value');
        line.removeAttribute('busy');
        readingStop(false);
    });
    $('queryReading').addEventListener('dbmn-progress-again', () => { grid.key = ''; loadRows(); });

    /** A stage of the engine's work, in words, with how far along it is (the engine's units of work: a share, not rows). */
    function readingStage(stage, done, total) {
        const phase = stage === 'Done' ? 'Reading the first rows'
            : /^Comparing/.test(stage) ? 'Comparing the records'
                : stage === 'Holding the rows' ? 'Working out each row\'s status'
                    : /^Finding the keys/.test(stage) ? 'Finding the keys'
                        : /^Sorting/.test(stage) ? 'Sorting' : /^Filtering/.test(stage) ? 'Filtering' : /^Grouping/.test(stage) ? 'Counting' : stage;
        return total > 0 && done < total ? { phase, value: Math.floor((100 * done) / total) } : { phase };
    }

    function rowsArrived(m) {
        const asked = grid.waiting.get(m.seq);
        if (!asked) return;
        grid.waiting.delete(m.seq);
        if (m.offset === 0 && ![...grid.waiting.keys()].some(k => k > m.seq)) reading(null);
        ui.shown = m.shown;
        ui.total = m.total;
        if (grid.sorting) { grid.sorting = false; setBusy(''); }
        if (m.offset === 0) {
            // A total under each column of numbers, for the rows shown: as many decimals as its values have, two at most
            if (m.totals) {
                const totals = {};
                m.totals.forEach((t, i) => {
                    const places = (m.places && m.places[i]) || 0;
                    totals[asked.ids[i]] = t === null ? (i === 0 ? 'Total' : '') : t.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places });
                });
                // (Compact: a compared column's total is its Baseline's, and no other)
                // (Side by side: a compared column's total unlike its Baseline's marked as a DIFF, in the row and its card)
                const baseline = ui.state && ui.state.compare ? ui.state.compare.baseline : undefined;
                const marked = window.QueryCompareResults.markTotals(totals, resultCols(), baseline, colId, colour);
                table.totals = window.QueryCompareResults.compactTotals(marked, (table.columns || []).map(c => c.id), resultCols(), baseline, colId);
            } else table.totals = null;
        }
        // The rows on screen, in the footer's summary (the one place the count shows): a search changes it
        ui.shownText = m.shown === m.total ? `${short(m.total)} rows` : `${short(m.shown)} of ${short(m.total)} rows`;
        // (the whole figure, for the summary's hover)
        ui.shownExact = m.shown === m.total ? `${count(m.total)} rows` : `${count(m.shown)} of ${count(m.total)} rows`;
        ui.arrived = true;
        renderBar();
        // A column a search just added: scrolled into view and lit (dbmn-table reveal), once it is drawn
        if (ui.revealNext && m.offset === 0) revealAdded();
        // A compare's counts (every control's): its headings are drawn again when they change
        if (m.offset === 0 && m.counts) {
            const was = columnsKey();
            ui.counts = m.counts;
            ui.countsAll = m.countsAll;
            // A DIFF only in spaces, hidden characters or blank against null looks like no difference: hidden
            // characters come on by themselves, once, and say why (unless the user has them off on this report)
            if (m.quiet && !specialOn() && !ui.specialOffHere && !ui.specialAuto) {
                ui.specialAuto = true;
                applySpecial();
                if (window.DbmnToast) window.DbmnToast.info(`Hidden characters shown: ${count(m.quiet)} ${m.quiet === 1 ? 'difference is' : 'differences are'} only in spaces or blanks.`);
            }
            compareResults.renderTools();
            // (the folded steps say the compare's DIFF and Missing: drawn again with them)
            renderBar();
            if (columnsKey() !== was) setTimeout(() => { drawTable(); }, 0);
        }
        asked.resolve({ rows: m.rows.map((r, n) => { const row = {}; asked.ids.forEach((id, i) => { row[id] = r[i]; }); if (m.status) { row.__status = m.status[n]; row.__index = m.index[n]; } return row; }), total: m.shown });
    }

    function moved(list, from, to) { list.splice(to, 0, list.splice(from, 1)[0]); return list; }

    /** What the user did to the table's headings, passed on: the host keeps the order, the widths and the columns shown. */
    function tableChanged(detail) {
        if (!ui.state) return;
        const at = id => resultCols().findIndex(c => colId(c) === id);
        if (detail.change === 'sorted') {
            const sort = detail.layout && detail.layout.sort;
            // A compact column (every cell of a compared column together) sorts by its first cell (the Baseline's; blank where it lacks the record)
            const column = !sort ? -1 : sort.id.indexOf('compact:') === 0 ? resultCols().findIndex(c => c.group === sort.id.slice(8)) : at(sort.id);
            ui.sort = sort && column >= 0 ? { column, dir: sort.dir } : null;
            grid.sorting = true;
            setBusy(`Sorting ${count(ui.shown)} rows…`);
        } else if (detail.change === 'moved' && (hasStatus() || resultCols().some(c => c.group))) {
            // Groups move as one: the report's columns in the table's new order (a COMPARE calculation's sides are one)
            const order = (table.columns || []).map(c => c.id).filter(id => id !== '__status' && id !== '__relation')
                .flatMap(id => (id.indexOf('compact:') === 0 ? resultCols().filter(c => c.group === id.slice(8)).map(colId) : [id]));
            const byId = new Map(resultCols().map(c => [colId(c), c]));
            const seen = new Set();
            const select = [];
            const shownIds = new Set(order);
            order.concat(resultCols().map(colId).filter(id => !shownIds.has(id))).forEach(id => {
                const c = byId.get(id);
                if (!c) return;
                if (!c.view && c.group) {
                    if (seen.has(`calc:${c.group}`)) return;
                    seen.add(`calc:${c.group}`);
                    select.push({ view: '', column: c.group });
                    return;
                }
                select.push(Object.assign({ view: c.view, column: c.column }, c.fns && c.fns.length ? { fns: c.fns } : {}, c.group ? { group: c.group } : {}));
            });
            setBusy('Updating…');
            post({ type: 'query.setSelect', select });
        } else if (detail.change === 'moved') {
            const from = at(detail.id);
            const to = detail.to;
            if (from < 0 || from === to) return;
            const sorted = sortOf();
            const columns = moved(resultCols().slice(), from, to);
            ui.state.resultColumns = columns;
            ui.state.columns = columns;
            ui.sort = sorted ? { column: at(sorted.id), dir: sorted.dir } : null;
            grid.key = columnsKey();
            post({ type: 'query.moveColumn', from, to });
        } else if (detail.change === 'removed') {
            // (a compared column goes as one: every cell of it; in Compact its one column is `compact:<group>`, every cell of
            // that group: else nothing left the report, the table only hid it, and a search naming it showed it again in
            // its old place, James 2026-11-23)
            const named = detail.ids && detail.ids.length ? detail.ids : [detail.id];
            const gone = new Set(named.flatMap(id => (String(id).indexOf('compact:') === 0 ? resultCols().filter(c => c.group === String(id).slice(8)).map(colId) : [id])));
            const i = at(detail.id);
            const columns = resultCols().filter(c => !gone.has(colId(c)));
            if (!columns.length || columns.length === resultCols().length) return;
            // Its search terms go with it, now: Results' columns change here before the host's state comes, so the
            // check there (applyState) would see nothing gone; and with its term gone it isn't added straight back
            if (ui.search && window.QuerySearchAdds && window.SearchMatcher.withoutColumns) {
                const next = window.QuerySearchAdds.searchAfterRemoval(ui.search, searchCols(resultCols().filter(c => gone.has(colId(c)))), searchCols(columns), window.SearchMatcher.withoutColumns);
                if (next !== ui.search) setSearch(next, false);
            }
            const sorted = sortOf();
            ui.state.resultColumns = columns;
            ui.sort = sorted && sorted.id !== detail.id ? { column: at(sorted.id), dir: sorted.dir } : null;
            grid.key = columnsKey();
            grid.keep = true;
            // Said once: where a column taken out comes back from
            if (!grid.toldHide && window.DbmnToast) { grid.toldHide = true; window.DbmnToast.info('Column removed. Tick it on the Columns step to bring it back.'); }
            setBusy('Updating…');
            // (a COMPARE calculation's sides are one column of the report; the rest keep their functions and groups)
            const select = [];
            const calcs = new Set();
            columns.forEach(c => {
                if (!c.view && c.group) { if (!calcs.has(c.group)) { calcs.add(c.group); select.push({ view: '', column: c.group }); } return; }
                select.push(Object.assign({ view: c.view, column: c.column }, c.fns && c.fns.length ? { fns: c.fns } : {}, c.group ? { group: c.group } : {}));
            });
            void i;
            post({ type: 'query.setSelect', select });
        } else if (detail.change === 'resized' && detail.width) {
            // A width the user set is the query's: kept with it
            ui.state.widths = Object.assign({}, ui.state.widths, { [detail.id]: detail.width });
            post({ type: 'query.setWidth', key: detail.id, width: detail.width });
        }
    }

    /* ---------- State ---------- */

    function setBusy(text) {
        ui.busy = text || '';
        renderBar();
        updatePeek();
    }

    /** Hidden characters shown: the user's choice, or turned on by itself for this report (a DIFF only in spaces). */
    function specialOn() { return !!(ui.special || ui.specialAuto); }
    /** Drawn everywhere at once (the whole table, Compact's cells, the record window), or nowhere. */
    function applySpecial() {
        const on = specialOn();
        const box = $('querySpecial');
        if (box) box.setAttribute('aria-pressed', String(on));
        if (table && table.specialCharacters !== on) table.specialCharacters = on;
        if (hasStatus() && ui.resultsView === 'compact' && ui.state) { grid.key = ''; drawTable(); loadRows(true); }
    }

    /** Distinct's line and the not-a-number line, from a state (or the whole compare's figures, once Results has them). */
    function renderFigures(m) {
        // Distinct is there only when rows repeat (or it is on): it says how many it folds
        const repeats = m.duplicates || 0;
        $('queryDistinctLabel').classList.toggle('hidden', !repeats && !m.distinct);
        $('queryDistinctText').textContent = !repeats ? 'Distinct' : m.distinct ? `Distinct: ${count(repeats)} repeated ${repeats === 1 ? 'row' : 'rows'} folded` : `Distinct: fold ${count(repeats)} repeated ${repeats === 1 ? 'row' : 'rows'}`;
        // Text read as a number that wasn't one is left blank, and said: how many rows, in which column (James, 2026-11-21)
        // (a Results column's, by its number; a join key's, by its name: it may not be in Results)
        const counted = (m.notNumbers || []).filter(x => x.name || (m.resultColumns || [])[x.column]);
        const rowsIn = list => list.map(x => `${count(x.rows)} ${x.rows === 1 ? 'row' : 'rows'} in ${x.name || m.resultColumns[x.column].column}`).join(', ');
        const notNumbers = counted.filter(x => !x.kind);
        // (Translate values meeting a value its lookup table holds in two rows: the first row's used, and said)
        const twice = counted.filter(x => x.kind === 'twice');
        $('queryNotNumbers').classList.toggle('hidden', !counted.length);
        $('queryNotNumbers').textContent = [
            notNumbers.length ? `Text that isn't a number was left blank: ${rowsIn(notNumbers)}.` : '',
            twice.length ? `In the lookup table twice, so the first row's was used: ${rowsIn(twice)}.` : ''
        ].filter(Boolean).join(' ');
    }

    /**
     * Saved searches (James, 2026-11-23, issue 16): the ★ beside the search (the design system's dbmn-saved-searches) shows
     * the query's list, and the name of the one the box holds. Picking one puts its text in the box and searches, the way
     * typing it does: an `@name` for a column not in the report adds it (addFromSearch); nothing is taken away. A save,
     * rename or delete sends the whole list to the host, which keeps it with the query.
     */
    const saved = document.getElementById('querySaved');
    function savedNow() { if (saved) saved.current = $('querySearch').value; }
    if (saved) {
        saved.addEventListener('dbmn-saved-pick', e => {
            const text = String((e.detail && e.detail.text) || '');
            setSearch(text, false);
            compareResults.renderTools();
            if (!addFromSearch(true)) loadRows();
        });
        saved.addEventListener('dbmn-saved-change', e => post({ type: 'query.saveSearches', searches: (e.detail && e.detail.searches) || [] }));
    }

    function applyState(m) {
        // (counting: the step is drawn, its counts still to come; done: no longer)
        ui.counting = m.counting ? { since: m.counting, stage: (ui.counting && ui.counting.since === m.counting && ui.counting.stage) || '' } : (ui.counting && ui.counting.stopped ? ui.counting : null);
        const firstState = !ui.state;
        // The first state with every view's rows read (the one before it lists the views as saved)
        const settled = !m.reading && !ui.settled;
        // A pair still being picked (one column, or none) is the page's own: it stays through a refresh
        const drafts = {};
        if (ui.state) ui.state.joins.forEach(j => { drafts[j.view] = j.on.filter(p => !(p.left.column && p.right.column) && (p.left.column || p.right.column || p.picked)); });
        // A view whose rows have just come in: its cell finishes its bar and fades into the count (justRead)
        if (ui.state) ui.state.views.forEach(v => { if (v.reading && m.views.some(x => x.id === v.id && !x.reading)) justRead[v.id] = Date.now(); });
        // Results' columns as the search knew them, before this state (a view taken out is still named here)
        const searchedBefore = ui.state && ui.search ? searchCols(resultCols()) : null;
        ui.state = m;
        if (saved) saved.searches = m.searches || [];
        // A column gone from Results takes its search terms with it (James, 2026-11-23: "if a column is removed
        // from table, so should its search filter"); a term another column still answers to stays. The reload below searches again
        if (searchedBefore && window.SearchMatcher.withoutColumns) {
            const now = new Set((m.resultColumns || []).map(colId));
            const gone = searchedBefore.filter(c => !now.has(c.id));
            const next = gone.length ? window.SearchMatcher.withoutColumns(ui.search, gone, searchCols(m.resultColumns || [])) : ui.search;
            if (next !== ui.search) setSearch(next, false);
        }
        showName(m.name);
        showKind(m.compare);
        if (!m.statusPlaces) { ui.filter = { kinds: null, columns: [], relations: null, hidden: [] }; ui.diffsOnly = false; }
        compareResults.renderTools();
        // (a draft the host has made whole, as it does a run's side, is not added again)
        m.joins.forEach(j => (drafts[j.view] || []).forEach(p => {
            const had = p.left.column && j.on.some(x => x.left && x.left.view === p.left.view && x.left.column === p.left.column);
            if (!had && m.views.some(v => v.id === p.left.view)) j.on.push(p);
        }));
        if (!m.reading) { ui.busy = ''; ui.settled = true; }
        if (!m.reading && ui.onSettled) { const run = ui.onSettled; ui.onSettled = null; setTimeout(run, 0); }
        $('queryDistinct').checked = !!m.distinct;
        renderFigures(m);
        if (firstState) {
            // Results as it was left: its search, its sort, its totals
            ui.search = m.search || '';
            ui.sort = m.sort || null;
            ui.totals = !!m.totals;
            $('querySearch').value = ui.search;
            savedNow();
            // (a column name that Results does not have shows in red, as in every table's search)
            window.SearchMatcher.renderHighlight($('querySearchMirror'), ui.search, searchHeadings(), notInReport());
            renderReads();
            $('queryTotals').setAttribute('aria-pressed', String(ui.totals));
            // (a search kept from last time lights Filter)
            compareResults.renderTools();
        }
        if (!m.reading && ui.sort && ui.sort.column >= m.resultColumns.length) ui.sort = null;
        renderTop();
        renderReads();
        renderViews();
        renderJoins();
        renderColumns();
        // Run: Results as soon as the views are read, or the step that still needs something.
        // Edit: Views at once
        if (settled && ui.start === 'results') goTo(joinsReady() ? 4 : m.views.length > 1 ? 2 : 1);
        else if (firstState && ui.start !== 'results') goTo(1);
        else if (waitsFor(ui.step)) goTo(m.views.length ? 2 : 1);
        else { renderBar(); updatePeek(); if (ui.step === 4 && !m.reading) { loadRows(grid.keep); grid.keep = false; } }
    }

    window.DbmnActions.register({
        'query:add': () => addView(),
        'query:addFile': () => addsEl('queryAddFile').click(),
        'query:back': () => goTo(ui.step - 1),
        'query:next': () => goTo(ui.step + 1),
        // The rows Results shows now (its search and sort), as a workbook
        'query:export': () => exportRows(),
        'query:chain': () => post({ type: 'console.chain', payload: {} }),
        // The footer's Actions on Results (James, 2026-11-24): what you do with the rows, opening upward
        'query:actions': (arg, event, button) => {
            window.DbmnContextMenu.show(button, [
                { id: 'chain', label: 'Chain to a Run Batch…', icon: 'link' },
                { id: 'export', label: 'Export to Excel', icon: 'download' }
            ], id => id === 'chain' ? post({ type: 'console.chain', payload: {} }) : exportRows());
        }
    });

    function exportRows() {
        setBusy('Exporting…');
        // (what Results shows: its search and sort, and a compare's Status filters and hidden results)
        // (and the Status menu's counts as shown, for the file's summary: #13)
        post({ type: 'query.export', search: ui.search, sort: ui.sort, ...(hasStatus() ? { filter: ui.filter, counts: ui.counts || null, diffsOnly: !!ui.diffsOnly } : {}) });
    }

    // + Add a file: the file picked is read and sent (a workbook's sheets are asked about next)
    addsEl('queryAddFile').addEventListener('change', () => {
        const file = addsEl('queryAddFile').files && addsEl('queryAddFile').files[0];
        addsEl('queryAddFile').value = '';
        if (file) sendFile(file, { type: 'query.addFile' });
    });
    $('queryTotals').addEventListener('click', () => {
        ui.totals = !ui.totals;
        $('queryTotals').setAttribute('aria-pressed', String(ui.totals));
        post({ type: 'query.totals', on: ui.totals });
        loadRows();
    });
    // Hidden characters: on or off is the user's choice for every query; off while they had come on by themselves
    // is this report's (they stay off here, the user's choice unchanged)
    $('querySpecial').addEventListener('click', () => {
        const on = !specialOn();
        if (!on && ui.specialAuto && !ui.special) { ui.specialOffHere = true; post({ type: 'query.specialOff' }); }
        else { ui.special = on; post({ type: 'query.preference', key: 'specialCharacters', value: on }); }
        ui.specialAuto = false;
        applySpecial();
    });
    $('queryDistinct').addEventListener('change', () => { setBusy('Updating…'); post({ type: 'query.distinct', on: $('queryDistinct').checked }); });
    let searchTimer = 0;
    window.SearchMatcher.followScroll($('querySearch'), $('querySearchMirror'));
    // The names a search can ask for: Results' columns (a name in several views also by letter: d.sku)
    /**
     * The names the search knows Results' columns by: each column's own name (@quantityOnHand: wherever it is), and,
     * with more than one view in Results, each with its view's alias as the slots and headings show it (@BL.quantityOnHand,
     * @C2.sku; a view not in a compare, its name), so @bl. lists BL's columns (James, 2026-11-22). The controller reads
     * the same names (query.controller.ts searchArg).
     */
    const aliasOf = v => (v && (v.run || v.name)) || '';
    /** Results' columns as the search names them (search-matcher's columnsIn / withoutColumns): each by its id, its own name, and its run's or view's when Results has two or more (BL.sku). */
    function searchCols(cols) {
        const many = new Set(cols.map(c => c.view).filter(id => view(id))).size > 1;
        return cols.map(c => ({ id: colId(c), name: c.column, aliases: many && view(c.view) ? [`${aliasOf(view(c.view))}.${c.column}`] : [] }));
    }
    /** The headings the search box filters: each wears the table's funnel (James, 2026-11-23); a click on one clears its terms. */
    function markFiltered() {
        table.filtered = ui.search && window.SearchMatcher.columnsIn ? window.SearchMatcher.columnsIn(ui.search, searchCols(resultCols())) : [];
    }
    /** The search box set to `text` (a term taken out): Results searches again. */
    function setSearch(text, reload) {
        clearTimeout(searchTimer);
        ui.search = text;
        $('querySearch').value = text;
        savedNow();
        window.SearchMatcher.renderHighlight($('querySearchMirror'), text, searchHeadings(), notInReport());
        renderReads();
        compareResults.renderTools();
        if (reload) loadRows();
    }
    /**
     * The views' columns not in the report, as the search can name them (James, 2026-11-23): each by its name, and by
     * its view's alias (C1.qty). Offered by `@` and drawn as known names, marked as not in the report yet; a search
     * naming one adds it (addFromSearch).
     */
    function notInReport() {
        if (!ui.state) return [];
        const inReport = new Set(resultCols().map(c => `${c.view}\n${c.column}`));
        const names = new Set(resultCols().map(c => c.column));
        const out = [];
        views().filter(v => !v.off).forEach(v => (v.columns || []).forEach(c => {
            if (inReport.has(`${v.id}\n${c.name}`)) return;
            if (!names.has(c.name)) out.push(c.name);
            out.push(`${aliasOf(v)}.${c.name}`);
        }));
        return [...new Set(out)];
    }
    /**
     * A search naming a view's column that isn't in the report adds it, and it stays (James, 2026-11-23: "@qty adds it
     * as a compare column. @c1.qty adds as report column", "a. Stay.", "e. just run. dont offer stop"): the report's
     * columns set as the Columns step sets them (query-search-adds.js says which), and the query runs again with the
     * normal working line; the search then finds the column. True when it did.
     */
    /** `whole`: the search is finished as it stands (a saved one picked): its last `@name` counts, though nothing follows it. */
    function addFromSearch(whole) {
        const adds = window.QuerySearchAdds, matcher = window.SearchMatcher;
        if (!adds || !matcher || !matcher.columnTerms || !ui.state || !ui.search) return false;
        // (a term once it is finished, as search-matcher says: an operator, or a space or comma after the name; so typing
        // @qt on the way to @qty adds nothing. A matcher without `done` counts every term as finished)
        const names = matcher.columnTerms(ui.search).filter(t => whole || t.done !== false).map(t => t.name);
        if (!names.length) return false;
        const report = (ui.state.columns || []).map(c => ({ view: c.view, column: c.column, group: c.group }));
        const known = views().filter(v => !v.off).map(v => ({ id: v.id, alias: aliasOf(v), columns: (v.columns || []).map(c => c.name) }));
        const add = adds.columnsToAdd(names, report, known, (ui.state.compare && ui.state.compare.views) || []);
        if (!add.length) return false;
        const select = (ui.state.columns || []).map(c => Object.assign({ view: c.view, column: c.column }, c.fns && c.fns.length ? { fns: c.fns } : {}, c.group ? { group: c.group } : {})).concat(add);
        const named = [...new Set(add.map(c => c.column))].join(', ');
        setBusy(`Adding ${named}…`);
        post({ type: 'query.setSelect', select });
        // The new column brought into view once Results has it (James, 2026-11-23: "JUST bring the new column into focus..
        // so scroll to right"; no Undo: the Delete key on its heading takes it out)
        ui.revealNext = add[0];
        return true;
    }
    /** The column a search added, scrolled into view sideways and lit (the table's reveal); compact, its compared column's. */
    function revealAdded() {
        const c = ui.revealNext;
        const ids = (table.columns || []).map(t => t.id);
        const id = c && c.group && ids.includes(`compact:${c.group}`) ? `compact:${c.group}` : c ? colId(c) : '';
        if (!id || !ids.includes(id)) return;
        ui.revealNext = null;
        if (typeof table.reveal === 'function') requestAnimationFrame(() => table.reveal(id));
    }
    function searchHeadings() {
        const columns = resultCols();
        const names = columns.map(c => c.column);
        const inViews = new Set(columns.map(c => c.view).filter(id => view(id)));
        const aliased = inViews.size > 1 ? columns.filter(c => view(c.view)).map(c => `${aliasOf(view(c.view))}.${c.column}`) : [];
        return [...new Set([...names, ...aliased, ...notInReport()])];
    }
    /** What kind of values the column a heading names holds (the host says: number, yes or no, date, text). */
    function searchType(heading) {
        const want = String(heading || '').toLowerCase();
        const hit = resultCols().find(c => c.column.toLowerCase() === want || (view(c.view) && `${aliasOf(view(c.view))}.${c.column}`.toLowerCase() === want));
        return (hit && hit.type) || '';
    }
    /** The search in words, under Results' tools: "Reading this as: poDate (date) after 12 Nov 2026". */
    function renderReads() {
        if ($('querySearch').value) window.SearchMatcher.renderHighlight($('querySearchMirror'), $('querySearch').value, searchHeadings(), notInReport());
        const says = ui.step === 4 && window.SearchMatcher.describeSearch ? window.SearchMatcher.describeSearch($('querySearch').value, searchHeadings(), searchType) : '';
        // (how the search is read: on the box's hover, not a line under it; James, 2026-11-22)
        $('queryReads').classList.add('hidden');
        $('querySearch').title = says ? `Reading this as: ${says.replace(/^Reading this as:\s*/i, '')}` : 'Search rows, or @column=value';
    }
    // `@` lists the columns, each with its kind, then the operators and values that fit it
    window.SearchMatcher.attachColumnSuggest({ input: $('querySearch'), headings: searchHeadings, types: searchType, hidden: notInReport, adds: notInReport });
    $('querySearch').addEventListener('input', () => {
        savedNow();
        renderReads();
        window.SearchMatcher.renderHighlight($('querySearchMirror'), $('querySearch').value, searchHeadings(), notInReport());
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { ui.search = $('querySearch').value; compareResults.renderTools(); if (!addFromSearch()) loadRows(); }, 200);
    });
    // The query's name, at the top left (shared/dbmn-name.js): a click renames it. The controller checks
    // the name and answers with the one it kept (query.named), refused or not
    function showName(name) {
        if (typeof name !== 'string') return;
        $('queryName').value = name;
        // Still the name it was given ("New query", "New query 2"): shown as not yet named
        $('queryName').unnamed = /^New query( \d+)?$/.test(name);
    }
    /** Compare or Query, under the name: a query with a Compare join is a compare. */
    function showKind(compare) {
        const label = $('queryKindLabel');
        const is = !!compare;
        label.className = 'query-kind-label' + (is ? ' is-compare' : '');
        label.title = is ? 'It has a Compare join: its views are compared' : 'No Compare join';
        label.innerHTML = (window.Icons ? window.Icons.icon(is ? 'scale' : 'blend') : '') + `<span>${is ? 'Compare' : 'Query'}</span>`;
    }
    $('queryName').addEventListener('dbmn-name-change', event => post({ type: 'query.rename', name: event.detail.name }));
    // (Enter in the name as the query opened, named or left as it was: on to Add a view)
    $('queryName').addEventListener('dbmn-name-done', () => {
        if (!ui.naming) return;
        ui.naming = false;
        requestAnimationFrame(() => { const add = $('queryAddBtn'); if (add && !add.disabled) add.focus(); });
    });

    // A compare's record: a row's click, or a right-click anywhere on it
    table.addEventListener('dbmn-table-row', event => { if (hasStatus()) compareResults.openRecord(event.detail.row); });
    table.addEventListener('dbmn-table-row-menu', event => { if (hasStatus()) compareResults.openRecord(event.detail.row); });

    // The table says what was done to its headings (sorted, moved, removed, resized)
    table.addEventListener('dbmn-table-layout', event => tableChanged(event.detail));
    // A heading's funnel clicked: that column's search terms go, and Results searches again
    table.addEventListener('dbmn-table-unfilter', event => {
        const col = resultCols().find(c => colId(c) === event.detail.id);
        if (col && ui.search && window.SearchMatcher.withoutColumns) setSearch(window.SearchMatcher.withoutColumns(ui.search, searchCols([col])), true);
    });

    window.addEventListener('message', event => {
        const m = event.data || {};
        switch (m.type) {
            case 'query.init':
                showName(m.name);
                // A new query: its name ready to type (James, 2026-11-23: "name first"); Enter then moves on to Add a view
                if (/^New query( \d+)?$/.test(m.name || '') && (Number(m.reached) || 1) <= 1 && $('queryName').edit) {
                    ui.naming = true;
                    requestAnimationFrame(() => $('queryName').edit());
                }
                // Side by side or Compact, as the user left it in any query (#18)
                if (m.prefs && m.prefs.resultsView === 'compact') ui.resultsView = 'compact';
                // Hidden characters: the user's own choice, and whether this report has them off (after turning on by itself)
                ui.special = !!(m.prefs && m.prefs.specialCharacters);
                ui.specialOffHere = !!m.specialOff;
                applySpecial();
                // Always Views first, where each view's rows are seen coming in (James, 2026-11-22: reopened on Results,
                // the loading couldn't be seen); a tab already open still goes where it's asked (query.goTo)
                ui.start = 'edit';
                // Run shows Results and nothing else while the query is read; Edit shows Views
                ui.step = ui.start === 'results' ? 4 : 1;
                // A query still being built opens its steps one at a time, from the furthest it reached
                ui.reached = Math.min(4, Math.max(1, Number(m.reached) || 4));
                PANELS.forEach((id, i) => $(id).classList.toggle('hidden', i + 1 !== ui.step));
                $('queryResultsControls').classList.toggle('hidden', ui.step !== 4);
                renderBar();
                break;
            // New Compare (the Console): its first view's other runs offered at once, once the page has settled
            case 'query.pickRun': {
                const offer = () => { const v = view(m.id); if (v) addView(v); };
                if (ui.settled && !ui.busy) offer(); else ui.onSettled = offer;
                break;
            }
            case 'query.goTo':
                if (!ui.settled) ui.start = m.start;
                else goTo(m.start === 'results' && joinsReady() ? 4 : m.start === 'results' ? ui.step : 1);
                break;
            // (its header values say which of a view's runs differ, on the slots: drawn again with them)
            case 'query.sourceList':
                // (this query's own results as it opens; every result once Add a view asks: `all`)
                if (m.all || !ui.sourcesAll) { ui.sources = m.results || []; ui.sourceViews = Object.assign({}, ui.sourceViews, m.views || {}); }
                // (an incomplete result in this query: said once, as it opens)
                if (!ui.toldIncomplete && ui.state && window.DbmnToast) {
                    const part = views().filter(isIncomplete);
                    if (part.length) {
                        ui.toldIncomplete = true;
                        window.DbmnToast.warn(`${part.map(v => v.run || v.name).join(', ')}: not every page was fetched, so rows on the pages it missed will look Missing.`);
                    }
                }
                if (m.all) { ui.sourcesAll = true; if (ui.onAllSources) { const done = ui.onAllSources; ui.onAllSources = null; done(); } }
                if (ui.state) renderTop();
                break;
            case 'query.progress':
                // (a view's own figures: its Rows cell's bar, where it is on show)
                if (m.view) {
                    ui.reads[m.view] = m.read || {};
                    // (every bar: which one is next changes as one starts)
                    document.querySelectorAll('dbmn-progress[data-read-view]').forEach(bar => fillRead(bar, ui.reads[bar.dataset.readView]));
                }
                // (a view's own figures are in its text already: "Reading C1: 25,000 rows (page 50 of 210)")
                setBusy(m.total && !m.read ? `${m.text} · ${count(m.done)} of ${count(m.total)}` : m.text);
                // (the Join step says how far a view still arriving has got)
                if (ui.step === 2 && ui.state && (ui.state.views || []).some(v => v.reading)) renderJoins();
                break;
            // Saved searches, as the host kept them after a save, a rename or a delete
            case 'query.searches': if (saved) saved.searches = m.searches || []; break;
            // Add a view's picker's, as kept: on the state, and on the picker if it is open
            case 'query.addViewSearches':
                if (ui.state) ui.state.addViewSearches = m.searches || [];
                if (ui.addPicker && ui.addPicker.isConnected) ui.addPicker.savedSearches = m.searches || [];
                break;
            case 'query.state': applyState(m); break;
            // The host's counting: its stage as it starts one, or stopped (since: null)
            case 'query.joinCounts': ui.joinCountsWhy = m.counts ? '' : (m.why || ''); joinCountsIn(m.counts); break;
            case 'query.counting':
                ui.counting = m.since ? { since: m.since, stage: m.stage } : { stopped: true, stage: m.stage };
                // (Results waiting on the step's count: it says so too)
                if (m.since && m.stage && !grid.stopped && !$('queryReading').classList.contains('hidden')) reading(m.stage);
                if (!m.since) setBusy('');
                if (ui.step === 2) renderJoins();
                break;
            case 'query.named': if (ui.state) ui.state.name = m.name; showName(m.name); renderBar(); break;
            case 'query.fileSheets': setBusy(''); pickSheets(m); break;
            case 'query.rowsData': rowsArrived(m); break;
            // Results has worked out the whole compare: the Join step's true figures (no longer a sample's), rows alike, numbers counted
            case 'query.figures':
                if (!ui.state) break;
                // (each figure as it is known: the join figures and numbers counted first, Distinct's count after)
                if (m.stats) {
                    (ui.state.joins || []).forEach(j => { if (Object.prototype.hasOwnProperty.call(m.stats, j.view)) j.stats = m.stats[j.view]; });
                    ui.state.sample = null;
                }
                if (typeof m.duplicates === 'number') ui.state.duplicates = m.duplicates;
                if (m.notNumbers) ui.state.notNumbers = m.notNumbers;
                renderFigures(ui.state);
                renderJoins();
                break;
            // Results' work as it goes (the first page not in yet)
            case 'query.reading':
                if (grid.stopped || $('queryReading').classList.contains('hidden')) break;
                // (a large compare: said once, before it starts, and kept beside the stages: "About 13 seconds")
                if (m.note) { $('queryReading').setAttribute('note', m.note); $('queryReading').setAttribute('tone', 'warn'); }
                reading(readingStage(m.stage, m.done, m.total));
                break;
            // A column moved: the SQL and Columns say the new order (Results already shows it)
            case 'query.arranged':
                if (!ui.state) break;
                ui.state.columns = m.columns;
                ui.state.allSelected = false;
                renderColumns();
                break;
            case 'query.exported': setBusy(''); break;
            case 'query.idle': setBusy(''); break;
            case 'query.fnSample': if (ui.fnSample) ui.fnSample(m); break;
            case 'query.lookupRowAdded': if (ui.lookupRowAdded) ui.lookupRowAdded(m); break;
            case 'query.calcSample': if (ui.calcSample) ui.calcSample(m); break;
            case 'query.recordDetail': compareResults.recordDetail(m); break;
            case 'query.viewRowsData': if (ui.viewRows) ui.viewRows(m); break;
            case 'query.error':
                // (Results' work ended in an error: no longer reading)
                reading(null);
                // A sort that failed leaves the table as it was
                if (grid.sorting) { grid.sorting = false; ui.sort = null; grid.key = ''; loadRows(true); }
                setBusy('');
                if (window.DbmnToast) window.DbmnToast.error(m.message);
                break;
        }
    });

    renderBar();
    injectIcons(document);
    post({ type: 'query.ready' });
})();

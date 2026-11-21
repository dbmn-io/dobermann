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
    /** What ƒ offers: each a standard SQLite function around the column. `sql` is the function as
     * it is written, in pieces: 'x' is the column, { n } a number typed in place, { text } some text. */
    const FNS = [
        { id: 'trim', label: 'Trim spaces', sql: ['TRIM(', 'x', ')'] },
        { id: 'upper', label: 'Upper case', sql: ['UPPER(', 'x', ')'] },
        { id: 'number', label: 'As a number', sql: ['CAST(', 'x', ' AS NUMERIC)'] },
        { id: 'text', label: 'As text', sql: ['CAST(', 'x', ' AS TEXT)'] },
        { id: 'ltrimZeros', label: 'Drop leading zeros', sql: ['LTRIM(', 'x', ", '0')"] },
        { id: 'first', label: 'First characters', sql: ['SUBSTR(', 'x', ', 1, ', { key: 'n', number: true, label: 'How many characters' }, ')'] },
        { id: 'last', label: 'Last characters', sql: ['SUBSTR(', 'x', ', -', { key: 'n', number: true, label: 'How many characters' }, ')'] },
        { id: 'replace', label: 'Replace text', sql: ['REPLACE(', 'x', ", '", { key: 'from', label: 'Text to replace' }, "', '", { key: 'to', label: 'Replace it with' }, "')"] }
    ];
    const FN_DEFAULTS = { n: 4, from: '-', to: '' };
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
        sqlOpen: false,
        statsOpen: {}       // a join's stats shown, by its view
    };

    // The footer's steps (shared/dbmn-footer.js): shown what stands, they say which step was asked for
    const bar = $('queryStepper');
    bar.steps = STEPS;
    bar.addEventListener('dbmn-step', event => goTo(event.detail.step));

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
    function applyLanes(box) {
        // (a gutter a bit narrower than dbmn-lanes' 230px, as James asked: its own option)
        if (box && window.DbmnLanes) window.DbmnLanes.apply(box, laneGroups().map(g => ({ runs: g.length })), { gutter: 180 });
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
        // A view that sits out (hidden, or not joined yet) holds nothing up: the report is the views that are in
        return !!s && !s.error && s.views.some(v => !v.waiting && !v.error) && s.views.every(v => !v.error || v.off);
    }
    /** Columns left empty (the last column taken out, with no key): Results would show the column just removed. A compare always has its key. */
    const EMPTY_REPORT = 'Pick a column for the report first: nothing is in it.';
    // (through ui: the step bar can draw before the Columns step is made)
    function reportEmpty() { const c = ui.columnsStep; return !!(c && typeof c.isEmpty === 'function' && c.isEmpty()); }
    function waitsFor(n) {
        if (n >= 2 && views().length === 0) return 'Views';
        if (n >= 3 && !joinsReady()) return 'Join';
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
            if (n < ui.step) return { status: 'done', summary: '' };
            const blocked = waitsFor(n);
            if (!blocked) return { status: 'available', summary: '', title: `Go to ${STEPS[i].label}` };
            // (an empty report says what to do, in the footer's status, as the step bar's reason)
            const says = blocked === 'Columns' && reportEmpty() ? EMPTY_REPORT : `Waits for ${blocked}`;
            return n === ui.step + 1 ? { status: 'blocked', waitsFor: blocked, summary: says } : { status: 'pending', summary: '' };
        });
        // What each step holds, for the list the folded steps open
        const said = stepSummaries();
        states.forEach((st, i) => { if (!st.summary || st.status === 'done') st.summary = said[i]; });
        bar.render(states, ui.step);
        // On Results the wizard is done: the steps fold into what is on screen (click it for the steps)
        // (the row count shortened when it is big: the whole figure shows on hover)
        bar.summary = [said[0], said[2], ui.shownText && (ui.shownExact && ui.shownExact !== ui.shownText ? { text: ui.shownText, title: ui.shownExact } : ui.shownText)].filter(Boolean);
        // (once its rows are in: until then Results shows as a step that is working, then the steps shrink away)
        bar.folded = ui.step === 4 && !!ui.settled && !!ui.arrived;
        const next = $('queryNextBtn');
        next.classList.toggle('hidden', ui.step === 4);
        next.textContent = ui.step < 4 ? `Next: ${STEPS[ui.step].label}` : 'Next';
        next.disabled = !!waitsFor(ui.step + 1) || !!ui.busy;
        next.title = ui.step === 3 && reportEmpty() ? EMPTY_REPORT : '';
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
    function slotMenu(event, v) {
        if (!window.DbmnContextMenu) return;
        const place = viewAt(v.id);
        const first = place === 0;
        const items = [
            { id: 'first', label: first ? 'First: every row is kept' : 'Move to first', icon: 'chevrons-left', disabled: first },
            // (what a drag of the slot does, for the keyboard)
            { id: 'left', label: 'Move left', icon: 'chevron-left', disabled: first },
            { id: 'right', label: 'Move right', icon: 'chevron-right', disabled: place === views().length - 1 },
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
        window.DbmnContextMenu.show(event, items, id => {
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
        const slotBox = (v, grouped) => {
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
            const inner = el(edit || onResults ? 'button' : 'div', 'compare-result-btn');
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
            const where = v.file ? `File · ${v.file}` : grouped ? v.environment : [v.request || v.endpointName, v.environment].filter(Boolean).join(' · ');
            const what = el('span', 'query-slot-what', [where, day(v.executedAt)].filter(Boolean).join(' · '));
            // Data a week old, or a month: said on the slot, on every step
            const old = ageIcon(v);
            if (old) name.prepend(old);
            inner.append(name, what);
            // Where it comes from and how old it is: on the slot, quietly; whole on Views, and on hover here
            inner.title = v.file ? `${v.name}: file ${v.file} · read ${day(v.executedAt)}, ${age(v.executedAt)} · ${count(v.rows)} rows` : `${v.name}: ${v.endpointName} · ${v.view || 'Root'} · ${v.environment} · ${day(v.executedAt)}, ${age(v.executedAt)} · ${count(v.rows)} rows`;
            if (old) inner.title += `\n${old.title}`;
            if (out) inner.title += v.off ? '\nHidden: left out of the report. Its menu shows it again.' : '\nNot joined yet: left out of the report until its columns are picked on Join.';
            if (v.off) { const eye = el('i', 'query-sign'); eye.dataset.icon = 'eye-off'; name.prepend(eye); }
            // In a compare: the scale on each view in it (the Baseline says so), "to show" on the others
            const compare = ui.state && ui.state.compare;
            if (compare) {
                const isIn = compare.views.includes(v.id);
                const badge = el('span', `query-slot-badge${isIn ? ' is-in' : ''}`);
                if (isIn) {
                    badge.innerHTML = window.Icons ? window.Icons.icon('scale') : '';
                    if (v.id === compare.baseline) badge.appendChild(el('span', '', 'Baseline'));
                    badge.title = v.id === compare.baseline ? 'The Baseline: every view in the compare is matched to it' : 'In the compare';
                } else {
                    badge.textContent = 'to show';
                    badge.title = 'Joined in to show: not compared';
                }
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
                const what = [group[0].request || group[0].endpointName, group[0].view].filter(Boolean).join(' · ');
                head.append(el('span', 'query-slot-head-name', group[0].name), el('span', 'query-slot-what', what));
                head.title = `${group[0].name}: ${what}`;
                lane.appendChild(head);
            }
            group.forEach((v, ri) => {
                const cell = el('div', `dbmn-lane-run dbmn-run-${ri}`);
                cell.dataset.run = String(ri);
                cell.dataset.view = v.id;
                cell.appendChild(slotBox(v, group.length > 1));
                lane.appendChild(cell);
            });
            return lane;
        });
        const end = el('div', 'dbmn-lanes-end');
        end.dataset.end = '';
        $('queryViews').replaceChildren($('queryHeadLead'), ...lanes, end);
        ['queryTop', 'queryViewRows', 'queryJoins', 'queryColumns'].forEach(id => applyLanes($(id)));
        // The slot row and the step's lines under it scroll sideways as one (the step's bar moves both)
        const stepBox = { 1: 'queryViewRows', 2: 'queryJoins', 3: 'queryColumns' }[ui.step] || '';
        if (ui.lanesPaired !== stepBox) {
            if (ui.unpairLanes) ui.unpairLanes();
            ui.unpairLanes = stepBox && window.DbmnLanes && window.DbmnLanes.together ? window.DbmnLanes.together([$('queryTop'), $(stepBox)]) : null;
            ui.lanesPaired = stepBox;
        }
        injectIcons($('queryViews'));
        // A view is added on Views and Join (the query's name is typed on any step)
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
        $('queryViewsEmpty').classList.toggle('hidden', views().length > 0);
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
                // One line, shortened with "…" (the whole of it on hover): never into the next lane
                if (value instanceof Node) cell.appendChild(value); else cell.appendChild(el('span', 'query-view-text', value));
                cell.title = cell.textContent;
                cells[v.id] = cell;
            });
            // A line that says the same for every run of a view (its request, its View) says it once, across the view's lane
            laneGroups().forEach(group => {
                if (group.length < 2) return;
                const said = group.map(v => text(v));
                if (said.some(x => x instanceof Node) || said.some(x => x !== said[0])) return;
                const cell = at(group[0].id, `query-view-cell${className ? ' ' + className : ''}`);
                cell.appendChild(el('span', 'query-view-text', said[0]));
                cell.title = said[0];
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
            // Still being read: a ghost, pulsing, where its count will be
            return v.reading ? el('span', 'query-ghost', 'Reading…') : rowsButton(v);
        };
        box.replaceChildren(
            said('request', 'Request', v => v.file ? `File · ${v.file}` : [v.system, v.request || v.endpointName].filter(Boolean).join(' · ')),
            said('view', 'View', v => v.file ? (v.sheet ? `Sheet · ${v.sheet}` : '') : v.view || 'Top-level fields'),
            said('result', 'Result', v => v.file ? '' : v.environment),
            said('updated', 'Last updated', v => day(v.executedAt)),
            said('age', 'Age', aged),
            said('rowPer', 'A row per', v => v.reading ? '' : v.file ? 'line' : v.rowBasis === 'root' ? 'response' : v.rowBasis),
            said('rows', 'Rows', rows, 'query-view-rows'),
            addsLine('views'));
        applyLanes(box);
        injectIcons(box);
        placeAdds();
    }

    /** The line + Add a view and + Add a file sit on, under the rows (Views and Join): one place each step keeps for them. */
    function addsLine(step) {
        const holder = el('div', 'query-adds-holder');
        holder.dataset.adds = step;
        return line('query-adds-line', { __span: holder }, [], []);
    }
    /** + Add a view / + Add a file into the line of the step on show. */
    function placeAdds() {
        // (no views yet: under the empty step's words, as the lines are hidden)
        const want = ui.step === 1 ? (views().length ? 'views' : 'empty') : ui.step === 2 ? 'join' : '';
        const holder = want && document.querySelector(`[data-adds="${want}"]`);
        if (holder && ADDS.parentElement !== holder) holder.appendChild(ADDS);
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
     * header values (ORG...), its rows, whether a batch is complete, when it ran. Every result
     * ticked comes in, through its endpoint's standard View (Change view on its slot picks another); a query takes up to ten,
     * and four of one endpoint (a compare's four). Another run of a view: only that endpoint's
     * results it hasn't already, read through its View.
     */
    async function addView(of) {
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
        body.appendChild(tableEl);
        const note = el('p', 'form-hint query-add-note');
        body.append(note);
        if (!list.length) note.textContent = runOf ? `No other result of ${runOf.name}'s endpoint. Run it again, and the result can be added here.` : 'No results yet. Run a request, and its result can be added here.';
        tableEl.columns = [
            { id: 'request', name: 'Request' }, { id: 'endpoint', name: 'Endpoint' }, { id: 'system', name: 'System' }, { id: 'environment', name: 'Environment' },
            ...headerNames.map(n => ({ id: `h:${n}`, name: n })),
            { id: 'rows', name: 'Rows', numbers: true }, { id: 'complete', name: 'Complete' }, { id: 'runAt', name: 'Run at' }, { id: 'type', name: 'Type' }
        ];
        tableEl.rows = list.map(r => Object.assign({
            _id: r.id, _result: r,
            request: r.request, endpoint: r.endpoint, system: r.system, environment: r.environment,
            rows: r.rows === '' ? '' : Number(r.rows),
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

    /** A view's own rows, in a dialog: its columns as it has them, and a search over every one. */
    async function previewView(v) {
        const body = el('div', 'query-add-form compare-drill-body');
        const searchBox = el('div', 'dbmn-modal-field');
        const search = el('input', 'dbmn-modal-input');
        search.type = 'text';
        search.id = 'queryViewSearch';
        search.placeholder = `Search ${v.name}: any value, in any column`;
        search.spellcheck = false;
        search.autocomplete = 'off';
        search.setAttribute('aria-label', `Search ${v.name}`);
        searchBox.appendChild(search);
        const says = el('p', 'form-hint', 'Reading…');
        says.id = 'queryViewShown';
        const box = el('div', 'table-container query-preview query-view-preview');
        const table = el('table', 'data-table');
        const head = el('thead');
        const rows = el('tbody');
        table.append(head, rows);
        box.appendChild(table);
        body.append(searchBox, says, box);
        let seq = 0;
        const ask = () => post({ type: 'query.viewRows', id: v.id, search: search.value, seq: ++seq });
        ui.viewRows = m => {
            if (m.seq !== seq) return;
            const tr = el('tr');
            m.columns.forEach(c => tr.appendChild(el('th', '', c)));
            head.replaceChildren(tr);
            rows.replaceChildren(...m.rows.map(line => {
                const row = el('tr');
                line.forEach(value => { const td = el('td', '', value); td.title = value; row.appendChild(td); });
                return row;
            }));
            const of = m.found === m.total ? `${count(m.total)} row${m.total === 1 ? '' : 's'}` : `${count(m.found)} of ${count(m.total)} rows`;
            says.textContent = m.rows.length < m.found ? `${of}. The first ${count(m.rows.length)} are shown: search to narrow them.` : of;
        };
        let timer = 0;
        search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(ask, 200); });
        ask();
        setTimeout(() => search.focus(), 0);
        await window.DbmnModal.show({
            title: `${v.name} · ${v.file ? (v.sheet ? `${v.file}, ${v.sheet}` : v.file) : (v.request || v.endpointName)}`, body, size: 'lg',
            actions: [{ id: 'close', label: 'Close', variant: 'secondary' }]
        });
        ui.viewRows = null;
    }

    /* ---------- Join ---------- */

    /** The functions as SQL around `name`, the first innermost. */
    function fnSql(fns, name) {
        return (fns || []).reduce((sql, f) => {
            const def = FNS.find(d => d.id === f.fn);
            if (!def) return sql;
            return def.sql.map(piece => piece === 'x' ? sql : typeof piece === 'string' ? piece : String(f[piece.key] ?? '')).join('');
        }, name);
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
        // ƒ says how many functions the column has; what they make is on hover and in the SQL
        const has = (ref.fns || []).length;
        const fx = el('button', 'compare-tool-btn font-mono' + (has ? ' text-link font-bold' : ''), has ? `ƒ ${has}` : 'ƒ');
        fx.dataset.fx = side;
        fx.type = 'button';
        fx.title = has ? fnSql(ref.fns, ref.column) : 'Functions on this column before it joins';
        fx.setAttribute('aria-label', 'Functions on this column');
        fx.addEventListener('click', () => pickFns(join, ref));
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
        const name = (v ? v.name + '.' : '') + (ref.column || 'column');
        const known = id => FNS.some(d => d.id === id) || id === 'translate';
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
            resolve(Object.assign({ rows: (m.rows || []).map(r => ({ before: r[0], after: r[1] })), agree: null, error: m.error }, m.table ? { table: m.table, value: m.value } : {}));
        };
        const applied = await window.DbmnFunctions.open({
            title: `Functions on ${ref.column || 'the column'}`,
            column: name,
            // Translate values, always (with no lookup table yet, "+ New lookup table…" makes one): the table, its from and to columns
            functions: FNS.concat([{ id: 'translate', label: 'Translate values', sql: ['TRANSLATE(', 'x', ', ', { key: 'table', label: 'Lookup table', kind: 'lookup', options: lookupTables() }, ')'] }])
                .map(d => ({ id: d.id, label: d.label, sql: d.sql })),
            defaults: FN_DEFAULTS,
            applied: fromQuery(ref.fns),
            asLabel: join ? 'Joins as' : 'Shows as',
            // A lookup table opens in its own tab, from Reporting
            onOpenLookup: id => post({ type: 'query.openLookup', id }),
            // "+ New lookup table…": a new table in its own tab, as Reporting's + New lookup table makes
            onNewLookup: () => post({ type: 'query.newLookup' }),
            sample: list => new Promise(resolve => {
                const seq = ++asked;
                waiting.set(seq, resolve);
                // (this record's value: the one shown in the cell whose ƒ was clicked, first among the samples)
                post({ type: 'query.fnSample', view: viewId, column: ref.column, fns: toQuery(list), seq, record: sampleOf(viewId, ref.column) });
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
            said = gone.length ? `${gone.join(' ')} Pick another column.` : of && of.off ? 'Hidden: left out of the report.' : join.on.some(p => p.left.column && p.right.column) ? 'Joins to a view that is left out.' : 'Pick the columns this view joins on. Until then it is left out of the report.';
        } else if (stats.typeMismatch) said = 'One side is numbers and the other text, so they never match. Try ƒ: As text.';
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
            // Delete join, at the bottom: the view (a compare: every view in it) goes back to not joined
            items.push({ separator: true }, { id: 'delete', label: 'Delete join', icon: 'trash-2' });
            window.DbmnContextMenu.show(b, items, id => {
                b.setAttribute('aria-expanded', 'false');
                if (id === 'delete') {
                    const gone = join.kind === 'compare' ? ui.state.joins.filter(j => j.kind === 'compare').map(j => j.view) : [join.view];
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
        join.on.forEach((pair, p) => {
            if (viewAt(pair.left.view) < 0) pair.left.view = earlier[0].id;
            const cells = {};
            // A box under every earlier view, until one is picked from: that view is what this one joins to
            earlier.forEach(e => {
                const mine = e.id === pair.left.view && !!pair.left.column;
                const cell = at(e.id, mine ? 'query-link-from' : '');
                // Once a column is picked, the other views' boxes go: emptying it ("Pick a column") brings them back
                if (mine || !pair.left.column) cell.appendChild(sidePicker(join, p, 'left', e));
                cells[e.id] = cell;
            });
            const right = at(v.id, 'query-link-to');
            right.appendChild(sidePicker(join, p, 'right', v));
            cells[v.id] = right;
            const lead = [];
            const says = [];
            if (p === 0) {
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
        const made = counting
            ? line('query-made-line', { __span: countingSays(0) }, [], [el('span', 'query-lead-text', 'Rows after this join'), more])
            : sentence
            ? line('query-made-line', { __span: sentence }, [el('span', 'query-made query-compare-rows', `${count(stats.rowsAfter)} rows`)], [el('span', 'query-lead-text', 'Rows after this join'), more])
            : line('query-made-line', after, [v.error ? errorLine(v) : joinNote(join, stats)], [el('span', 'query-lead-text', 'Rows after this join'), more]);
        made.dataset.kind = 'made';
        made.classList.toggle('is-openable', !!stats);
        band.appendChild(made);
        // The views after this one are not part of its join: their lanes are out, and say why
        const shut = () => {
            const last = viewAt(v.id);
            band.querySelectorAll('.dbmn-lane-run[data-view]').forEach(cell => {
                const later = view(cell.dataset.view);
                if (!later || viewAt(later.id) <= last || !cell.classList.contains('query-at')) return;
                cell.classList.add('query-lane-off');
                cell.title = `${later.name} joins further down: a view joins to the views before it. Drag ${later.name}'s slot to the left of ${v.name} to join it here.`;
            });
            return band;
        };
        if (!stats || !open) return shut();

        const leftId = join.on[0].left.view;
        KINDS.forEach(([kind, label, warn]) => {
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
        const sendAll = (kind) => { joins.forEach(j => { j.kind = kind; }); post({ type: 'query.setCompareKind', kind }); };
        first.on.forEach((pair, p) => {
            const cells = {};
            views().forEach(v => {
                if (v.id === baseline.id) {
                    const cell = at(v.id, 'query-compare-key');
                    cell.append(sidePicker(first, p, 'left', v), el('span', 'query-compare-value font-mono', sampleOf(v.id, pair.left.column)));
                    cells[v.id] = cell;
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
                    cell.append(pick, el('span', 'query-compare-out-says', 'joins below, to show'));
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
        const last = joins[joins.length - 1];
        const nameOf = v => v.run || v.name;
        const statsOf = v => (v.id === baseline.id ? first.stats : (joinOf(v.id) || {}).stats);
        // Each view's figures, from the engine's join statistics as they are: the Baseline's against the first
        // view joined to it, each other's against the Baseline (records, keys it repeats, records without a match)
        const summaryOf = v => {
            const st = statsOf(v);
            if (!st) return {};
            // (on the new engine a blank key is No key, as Results says: not counted as Only in)
            const noKey = ui.state.onEngine ? (v.id === baseline.id ? st.leftBlank : st.rightBlank) || 0 : 0;
            return v.id === baseline.id
                ? { records: v.rows, repeatedKeys: (st.keys.manyToOne || 0) + (st.keys.manyToMany || 0), repeatedRecords: (st.rows.manyToOne || 0) + (st.rows.manyToMany || 0), onlyHere: st.leftRows - st.leftMatched - noKey, noKey }
                : { records: st.rightRows, repeatedKeys: (st.keys.oneToMany || 0) + (st.keys.manyToMany || 0), repeatedRecords: (st.records.oneToMany || 0) + (st.records.manyToMany || 0), onlyHere: st.rightRows - st.rightMatched - noKey, noKey };
        };
        const summary = views().reduce((m, v) => { m[v.id] = summaryOf(v); return m; }, {});
        const inCompare = views().filter(v => members.includes(v.id));
        const others = inCompare.filter(v => v.id !== baseline.id);
        const keyed = first.on.length > 0 && first.on.every(p => p.left.column);
        const pending = keyed && (!!ui.counting || !last || !last.stats);
        const repeatedIn = new Map();
        inCompare.forEach(v => { const n = (summary[v.id] || {}).repeatedKeys || 0; if (n) repeatedIn.set(n, [...(repeatedIn.get(n) || []), nameOf(v)]); });
        const repeatWords = [...repeatedIn].map(([n, where]) => `${count(n)} ${n === 1 ? 'value repeats' : 'values repeat'} in ${where.join(', ')}`).join(' · ');
        // A sample's figures (the Baseline's first records and their keys in the others) until Results has worked out the whole
        const sample = ui.state.sample || null;
        const firstN = sample ? (sample.rows < sample.of ? `the first ${count(sample.rows)} records` : `the ${count(sample.rows)} records`) : '';
        const sampleTitle = sample ? `Of ${firstN} of ${nameOf(baseline)}, and their keys in the other views. The full counts come with Results.` : '';
        const asSample = node => { if (sample && node) { node.classList.add('is-sample'); node.title = sampleTitle; } return node; };
        // (each other view's count of the sample's keys it has: the engine's, the Baseline first)
        const sampleFound = v => (sample ? sample.byInput[inCompare.indexOf(v)] || 0 : 0);
        const bar = el('div', 'query-after query-compare-said');
        // A view of the compare still arriving: said in words (no compare of what has landed so far: its figures would change as the rest came in)
        const arriving = inCompare.filter(v => v.reading);
        if (arriving.length) {
            const names = arriving.map(nameOf);
            const it = arriving.length === 1 ? 'it' : 'them';
            const far = (ui.busy || '').replace(/^Reading [^:]*: ?/, '');
            const line = document.createElement('dbmn-status');
            line.setAttribute('inline', '');
            line.textContent = `Still reading ${names.join(', ')}${far && /^Reading /.test(ui.busy || '') ? `: ${far}` : ''}. The first ${count(SAMPLE_ROWS)} records of ${nameOf(baseline)} will be checked against ${it} when ${arriving.length === 1 ? 'it\'s' : 'they\'re'} in.`;
            bar.classList.add('is-pending');
            bar.appendChild(line);
        } else if (pending) {
            bar.classList.add('is-pending');
            bar.appendChild(countingSays(inCompare.reduce((n, v) => n + (v.rows || 0), 0)));
        } else if (keyed && sample) {
            // A sample: how many of the Baseline's first records each other view has
            // (the sentence says it is of a sample: only its figures are marked, the design system's sample figure)
            const stat = el('span', 'query-made query-compare-stat', `In ${firstN} of ${nameOf(baseline)}: `);
            others.forEach((v, i) => { stat.append(`${i ? ' · ' : ''}${nameOf(v)} `, asSample(el('span', 'dbmn-lanes-figure', count(sampleFound(v))))); });
            stat.append(' found');
            bar.appendChild(stat);
        } else if (keyed) {
            // Each later view's records that find one of the Baseline's (one to one or repeated: the chevron splits them)
            const found = others.filter(statsOf).map(v => `${nameOf(v)} ${count(statsOf(v).rightMatched || 0)} of ${count(statsOf(v).rightRows || 0)}`);
            const stat = el('span', 'query-made query-compare-stat', found.length ? `${found.join(' · ')} match ${nameOf(baseline)}` : '');
            stat.title = `How many of each one's records find a record of ${nameOf(baseline)}'s (the Baseline). Open the chevron for one to one, repeated and only in`;
            bar.appendChild(stat);
            if (repeatWords) {
                const w = el('span', 'query-warn query-compare-repeat', repeatWords);
                const i = el('i', 'query-sign');
                i.dataset.icon = 'triangle-alert';
                w.prepend(i);
                w.title = 'Open the chevron: what a repeated key does, and what to do about it';
                bar.appendChild(w);
            }
        }
        // The rows it leaves, at the end of the line: every record of every view in it, once
        const total = last && last.stats && !pending ? asSample(el('span', `query-made query-compare-rows${sample ? ' dbmn-lanes-figure' : ''}`, `${count(last.stats.rowsAfter)} rows`)) : null;
        // Its chevron opens how the records meet, a line per kind (closed to begin with), as a join's does
        const open = !!ui.statsOpen.__compare;
        const ready = keyed;
        const more = el('button', 'compare-tool-btn icon');
        more.type = 'button';
        more.dataset.stats = '';
        more.dataset.icon = open ? 'chevron-down' : 'chevron-right';
        more.disabled = !ready;
        more.setAttribute('aria-expanded', String(open && ready));
        more.setAttribute('aria-label', 'How the records meet in the compare');
        more.title = open ? 'Hide how the records meet' : 'Show how the records meet';
        more.addEventListener('click', () => { ui.statsOpen.__compare = !open; renderJoins(); });
        const made = line('query-made-line', { __span: bar }, [total], [el('span', 'query-lead-text', 'Rows after this compare'), more]);
        made.dataset.kind = 'made';
        made.classList.toggle('is-openable', ready);
        if (ready) bar.addEventListener('click', () => { ui.statsOpen.__compare = !open; renderJoins(); });
        band.appendChild(made);
        if (open && ready && pending) {
            // Open while counting: the three lines, each count still being worked out
            [['oneToOne', 'One to one'], ['manyToMany', 'Repeated'], ['onlyOther', 'Only in']].forEach(([kind, label]) => {
                const cells = {};
                inCompare.forEach(v => { const c = at(v.id, 'query-count compare-match-count is-pending'); c.textContent = '…'; cells[v.id] = c; });
                const row = line('query-kind-line', cells, [], [window.RelationGlyph.svg(kind), el('span', 'query-kind query-lead-text', label)]);
                row.dataset.kind = kind;
                band.appendChild(row);
            });
        } else if (open && ready) {
            // Open: three lines, always, a count under each view (a nought quiet), as the mock has them. Under
            // the Baseline: its records, its own repeats, its records no other view has; under each other
            // view: against the Baseline (one to one, repeated), and its records no other view has
            const kindLine = (kind, label, says, of) => {
                const cells = {};
                inCompare.forEach(v => {
                    const n = of(v);
                    if (n === null || n === undefined) return;
                    const cell = counted(v.id, n, kind === 'manyToMany');
                    asSample(cell);
                    if (!n) cell.classList.add('is-zero');
                    // Under the Baseline, One to one is its record count, said quietly ("1,204 records")
                    if (kind === 'oneToOne' && v.id === baseline.id) { cell.textContent = `${count(n)} records`; cell.classList.add('is-zero'); }
                    else if (n) {
                        // A count is a button: it opens the values it counts (the Baseline's against the first view
                        // joined to it, each other view's against the Baseline), as a join's counts do
                        const isBase = v.id === baseline.id;
                        const join = isBase ? first : joinOf(v.id);
                        const st = join && join.stats;
                        const which = kind === 'oneToOne' ? 'oneToOne'
                            : kind === 'manyToMany' ? (isBase ? (st && st.keys.manyToOne ? 'manyToOne' : 'manyToMany') : (st && st.keys.oneToMany ? 'oneToMany' : 'manyToMany'))
                                : isBase ? 'onlyBase' : 'onlyOther';
                        // (on the new engine the values behind a count are not read yet: a count, not a dead button)
                        if (join && st && !ui.state.onEngine) {
                            const show = el('button', 'query-count-btn', cell.textContent);
                            show.type = 'button';
                            show.dataset.side = isBase ? 'left' : 'right';
                            show.title = 'Show the values behind this count';
                            show.addEventListener('click', event => { event.stopPropagation(); showValues(join, which, isBase ? 'left' : 'right'); });
                            cell.replaceChildren(show);
                        }
                    }
                    cells[v.id] = cell;
                });
                const tag = el('span', `query-kind query-lead-text${kind === 'manyToMany' ? ' query-warn' : ''}`, label);
                tag.title = says;
                const row = line('query-kind-line', cells, [], [window.RelationGlyph.svg(kind), tag]);
                row.dataset.kind = kind;
                band.appendChild(row);
            };
            kindLine('oneToOne', 'One to one', `Records that meet ${nameOf(baseline)}'s one to one; under ${nameOf(baseline)}, its records`, v => {
                if (v.id === baseline.id) return (summary[v.id] || {}).records ?? v.rows ?? null;
                const st = statsOf(v); return st ? st.records.oneToOne : null;
            });
            kindLine('manyToMany', 'Repeated', `In a view more than once: ${nameOf(baseline)}'s record is compared with each`, v => {
                if (v.id === baseline.id) return (summary[v.id] || {}).repeatedRecords ?? null;
                const st = statsOf(v); return st ? (st.records.oneToMany || 0) + (st.records.manyToMany || 0) : null;
            });
            kindLine('onlyOther', 'Only in', `Records with no match in ${nameOf(baseline)} (under ${nameOf(baseline)}: no match in the view joined to it first): each shows as Missing`, v => (summary[v.id] || {}).onlyHere ?? null);
            // A blank key matches nothing: Results counts its records as No key (only said when there are any)
            const noKeys = inCompare.reduce((n, v) => n + ((summary[v.id] || {}).noKey || 0), 0);
            if (noKeys) kindLine('noKey', 'No key', 'Records whose key is blank: they match nothing, and Results shows each as No key', v => (summary[v.id] || {}).noKey ?? null);
            // Then one sentence: what it all means, and what to do (dbmn-status's tones)
            const only = inCompare.reduce((n, v) => n + ((summary[v.id] || {}).onlyHere || 0), 0);
            let words = [only ? `${count(only)} ${only === 1 ? 'record is' : 'records are'} in one view only: each shows as Missing in the others.` : noKeys ? 'Every record with a key is in the Baseline.' : '✓ Every view finds the Baseline\'s record.'];
            if (noKeys) words.push(`${count(noKeys)} ${noKeys === 1 ? 'record has' : 'records have'} no key: ${noKeys === 1 ? 'it matches' : 'they match'} nothing and ${noKeys === 1 ? 'shows' : 'show'} as No key.`);
            if (repeatWords) words.push(`${repeatWords}: a record on more than one row is compared with every row that has the same key, so Results shows extra rows and DIFFs that aren't real. Add a column to the key (+ AND) so each record has one row.`);
            let low = false;
            if (sample) {
                // Of a sample only, and said so: what was found in every view, repeats seen there, a key that looks wrong
                const runs = others.every(v => v.run) ? 'run' : 'view';
                const thin = others.filter(v => sampleFound(v) < sample.rows / 2);
                low = thin.length > 0;
                words = [`In ${firstN} of ${nameOf(baseline)}: ${count(sample.inEvery)} found in every ${runs}${repeatWords ? '' : `, none repeated in ${firstN}`}.`];
                thin.forEach(v => words.push(`Only ${count(sampleFound(v))} of ${firstN.replace('records', 'keys')} of ${nameOf(baseline)} ${sampleFound(v) === 1 ? 'is' : 'are'} in ${nameOf(v)}: check the key.`));
                if (repeatWords) words.push(`${repeatWords} in ${firstN}: a record on more than one row is compared with every row that has the same key. Add a column to the key (+ AND) so each record has one row.`);
                if (!low && !repeatWords && sample.inEvery === sample.rows) words.push('Looks like a safe compare.');
                words.push('The full counts come with Results.');
            }
            const verdict = document.createElement('dbmn-status');
            verdict.className = 'query-compare-verdict-text';
            verdict.setAttribute('inline', '');
            verdict.setAttribute('tone', repeatWords || low ? 'warn' : only && !sample ? 'warn' : 'ok');
            verdict.textContent = words.join(' ');
            const vline = line('query-compare-verdict', { __span: verdict }, [], []);
            band.appendChild(vline);
        }
        return band;
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
            if (!v.error && !v.reading) cell.appendChild(rowsButton(v));
            cell.title = v.file ? `${v.name}: a row per line of ${v.file}` : `${v.name}: a row per ${v.rowBasis === 'root' ? 'response' : v.rowBasis}`;
            totals[v.id] = cell;
        });
        const first = s.views[0];
        const lines = [line('query-total-line', totals, [first.error ? errorLine(first) : null], [el('span', 'query-lead-text', 'Rows in each view')]), addsLine('join')];
        if (s.views.length < 2) lines.push(el('p', 'compare-match-empty', 'Add another view to join.'));
        // "New compare engine (testing)" on, and this query more than a compare of runs: it says it runs on SQLite, and why
        if (s.engineNote) {
            const note = document.createElement('dbmn-status');
            note.className = 'query-engine-note';
            note.setAttribute('inline', '');
            note.setAttribute('tone', 'warn');
            note.textContent = s.engineNote;
            lines.unshift(note);
        }
        // The views in a compare join as one: one band, first; the joins that bring views in to show below it
        if (s.joins.some(j => j.kind === 'compare')) lines.push(compareBand());
        // A join a view at a time, as SQL is written: every join made, and the first still to make; the views after it wait
        let open = false;
        s.views.slice(1).forEach((v, i) => {
            const join = s.joins.find(j => j.view === v.id);
            if (!join || join.kind === 'compare') return;
            const made = join.on.length > 0 && join.on.every(p => p.left.column && p.right.column);
            if (!made) { if (open) return; open = true; }
            lines.push(joinBand(v, join, s.views.slice(0, i + 1)));
        });
        box.replaceChildren(...lines);
        applyLanes(box);
        injectIcons(box);
        placeAdds();
        renderSql();
    }

    /** Results' columns: the steps', or what the user's own SQL makes. */
    function resultCols() { return (ui.state && ui.state.resultColumns) || []; }

    /* ---------- Columns ---------- */

    /* The Columns step (query-columns.js) and the calculation builder (query-calc.js), drawn with this page's own pieces */
    const columnsStep = window.QueryColumns.create({
        // Columns tells the step bar when its report becomes empty or not (Next: Results waits while it is)
        stepsChanged: () => renderBar(),
        el, at, line, views, view, viewAt, colour, post, setBusy, count, injectIcons, CALC_VIEW: '',
        state: () => ui.state,
        openCalc: calc => openCalc(calc),
        pickFns: (ref, done) => pickFns(null, ref, done)
    });
    ui.columnsStep = columnsStep;
    function renderColumns() { columnsStep.render(); }
    /** A calculated column, in the builder: its name and formula; the host reads it and keeps it. */
    function openCalc(calc) {
        window.QueryCalc.open({
            el, post, colour, state: () => ui.state,
            onCheck: handler => { ui.calcCheck = handler; }
        }, calc).then(made => {
            if (!made) return;
            setBusy('Updating…');
            post({ type: 'query.setCalc', name: made.name, formula: made.formula, was: made.was });
        });
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
        return resultCols().map(c => `${colId(c)}#${c.type || ''}#${c.group || ''}`).join('\u0001') + (ui.state && ui.state.ownSql ? '\u0002own' : '') + compare;
    }

    /** The table's columns: each in its view's colour, the same name in two views saying whose it is. */
    const compareResults = window.QueryCompareResults.create({
        el, ui, post, view, views, colour, count, hasStatus: () => hasStatus(),
        reload: () => loadRows(),
        redraw: () => { grid.key = ''; drawTable(); loadRows(true); },
        renderSlots: () => renderTop()
    });

    /** Where a column of Results is, for its status: its run (BL, C1…), its view, or a COMPARE side's number. */
    function placeOf(c) {
        if (!c.view) { const m = / (\d+)$/.exec(c.column); return m ? m[1] : c.column; }
        const v = view(c.view);
        return v ? (v.run || v.name) : c.view;
    }
    function hasStatus() { return !!(ui.state && ui.state.statusPlaces && !ui.state.ownSql); }
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
                        const missing = row.__status && (row.__status.missing.includes(placeOf(c)) || row.__status.missing.includes(placeOf(first)));
                        td.classList.toggle('compare-differs', colId(c) !== firstId && !missing && text(v) !== text(row[firstId]));
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
            return { id: colId(c), name: text, className: `compare-sub ${colour(c.view)}`, numbers: c.type === 'number' };
        }));
    }
    function sortOf() {
        const c = ui.sort && resultCols()[ui.sort.column];
        return c ? { id: colId(c), dir: ui.sort.dir } : null;
    }

    /** Give the table its columns when they are not the ones it has, with the widths and sort kept for them. */
    function drawTable() {
        const key = columnsKey();
        if (key === grid.key) return;
        grid.key = key;
        const columns = resultCols();
        // The user's own SQL makes its own columns: they are neither moved nor taken out here
        table.toggleAttribute('locked', !!ui.state.ownSql || columns.length < 2);
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
        if (!table.source) table.source = { page };
        else table.reload(keep ? { keep: true } : undefined);
    }

    /**
     * Results working on its rows (the first page asked, not in yet): the line above the table says what and
     * how far, and the table's own "No rows." from before is not shown meanwhile. Null: the rows are in.
     */
    function reading(say) {
        // (the design system's working line, dbmn-progress inline: its stage, how far, the seconds it has taken, Stop)
        const line = $('queryReading');
        const on = !!say;
        line.classList.toggle('hidden', !on);
        table.classList.toggle('is-reading', on);
        if (!on) { line.removeAttribute('since'); return; }
        const it = typeof say === 'string' ? { phase: say } : say;
        if (!line.hasAttribute('since')) line.setAttribute('since', String(Date.now()));
        line.setAttribute('phase', it.phase);
        if (typeof it.value === 'number') { line.setAttribute('value', String(it.value)); line.removeAttribute('busy'); } else { line.removeAttribute('value'); line.setAttribute('busy', ''); }
    }

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
                table.totals = totals;
            } else table.totals = null;
        }
        // The rows on screen, in the footer's summary (the one place the count shows): a search changes it
        ui.shownText = m.shown === m.total ? `${short(m.total)} rows` : `${short(m.shown)} of ${short(m.total)} rows`;
        // (the whole figure, for the summary's hover)
        ui.shownExact = m.shown === m.total ? `${count(m.total)} rows` : `${count(m.shown)} of ${count(m.total)} rows`;
        ui.arrived = true;
        renderBar();
        // A compare's counts (every control's): its headings are drawn again when they change
        if (m.offset === 0 && m.counts) {
            const was = columnsKey();
            ui.counts = m.counts;
            ui.countsAll = m.countsAll;
            compareResults.renderTools();
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
            ui.sort = sort && at(sort.id) >= 0 ? { column: at(sort.id), dir: sort.dir } : null;
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
            // (a compared column goes as one: every cell of it)
            const gone = new Set(detail.ids && detail.ids.length ? detail.ids : [detail.id]);
            const i = at(detail.id);
            const columns = resultCols().filter(c => !gone.has(colId(c)));
            if (!columns.length || columns.length === resultCols().length) return;
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

    /* ---------- The SQL: read it, or write your own ---------- */

    /** The box holds SQL the user is typing: a new state leaves it alone. */
    let sqlTyped = false;
    function openSql(open) {
        ui.sqlOpen = open;
        $('querySqlPanel').classList.toggle('hidden', !open);
        $('querySqlBtn').setAttribute('aria-expanded', String(open));
        $('querySqlBtn').classList.toggle('is-active', open);
    }
    function renderSql() {
        const s = ui.state;
        if (!sqlTyped || s.ownSql === $('queryResultsSql').value.trim()) {
            $('queryResultsSql').value = s.ownSql || s.sql || '';
            sqlTyped = false;
        }
        $('querySqlReset').classList.toggle('hidden', !s.ownSql);
        const hint = $('querySqlHint');
        hint.classList.toggle('query-warn', !!s.sqlError);
        hint.textContent = s.sqlError ? `Your SQL no longer runs: ${s.sqlError}`
            : s.ownSql ? 'Your own SQL. Join and Columns no longer change Results.'
            : 'Each view is a table, by its name. Change the SQL and press Run to use your own.';
    }

    /* ---------- State ---------- */

    function setBusy(text) {
        ui.busy = text || '';
        renderBar();
        updatePeek();
    }

    /** Distinct's line and the not-a-number line, from a state (or the whole compare's figures, once Results has them). */
    function renderFigures(m) {
        // Distinct is there only when rows repeat (or it is on): it says how many it folds
        const repeats = m.duplicates || 0;
        $('queryDistinctLabel').classList.toggle('hidden', !repeats && !m.distinct);
        $('queryDistinctText').textContent = !repeats ? 'Distinct' : m.distinct ? `Distinct: ${count(repeats)} repeated ${repeats === 1 ? 'row' : 'rows'} folded` : `Distinct: fold ${count(repeats)} repeated ${repeats === 1 ? 'row' : 'rows'}`;
        // Text read as a number that wasn't one is left blank, and said: how many rows, in which column (James, 2026-11-21)
        const notNumbers = (m.notNumbers || []).filter(x => (m.resultColumns || [])[x.column]);
        $('queryNotNumbers').classList.toggle('hidden', !notNumbers.length);
        $('queryNotNumbers').textContent = notNumbers.length
            ? `Text that isn't a number was left blank: ${notNumbers.map(x => `${count(x.rows)} ${x.rows === 1 ? 'row' : 'rows'} in ${m.resultColumns[x.column].column}`).join(', ')}.`
            : '';
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
        ui.state = m;
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
        $('queryDistinct').checked = !!m.distinct;
        $('queryDistinct').disabled = !!m.ownSql;
        renderFigures(m);
        if (firstState) {
            // Results as it was left: its search, its sort, its totals
            ui.search = m.search || '';
            ui.sort = m.sort || null;
            ui.totals = !!m.totals;
            $('querySearch').value = ui.search;
            // (a column name that Results does not have shows in red, as in every table's search)
            window.SearchMatcher.renderHighlight($('querySearchMirror'), ui.search, searchHeadings());
            renderReads();
            $('queryTotals').checked = ui.totals;
            if (m.ownSql || m.sqlError) openSql(true);
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
        'query:copySql': () => {
            const sql = (ui.state && (ui.state.ownSql || ui.state.sql)) || '';
            if (window.DbmnClipboard) window.DbmnClipboard.writeText(sql).then(() => window.DbmnToast && window.DbmnToast.success('SQL copied'));
        },
        // The rows Results shows now (its search and sort), as a workbook
        'query:export': () => {
            setBusy('Exporting…');
            post({ type: 'query.export', search: ui.search, sort: ui.sort });
        },
        'query:toggleSql': () => openSql(!ui.sqlOpen),
        'query:runSql': () => {
            const typed = $('queryResultsSql').value.trim();
            // The steps' SQL, unchanged, is no SQL of the user's own
            const own = typed === (ui.state.sql || '').trim() ? '' : typed;
            if (!own && !ui.state.ownSql) return loadRows();
            ui.sort = null;
            setBusy('Running…');
            post({ type: 'query.setSql', sql: own });
        },
        'query:resetSql': () => {
            ui.sort = null;
            sqlTyped = false;
            setBusy('Running…');
            post({ type: 'query.setSql', sql: '' });
        },
        // The rows Results shows become a Run Batch's input: the Console's Chain (its dialog answers console.chainOptions)
        'query:chain': () => post({ type: 'console.chain', payload: {} })
    });

    // + Add a file: the file picked is read and sent (a workbook's sheets are asked about next)
    addsEl('queryAddFile').addEventListener('change', () => {
        const file = addsEl('queryAddFile').files && addsEl('queryAddFile').files[0];
        addsEl('queryAddFile').value = '';
        if (file) sendFile(file, { type: 'query.addFile' });
    });
    $('queryTotals').addEventListener('change', () => {
        ui.totals = $('queryTotals').checked;
        post({ type: 'query.totals', on: ui.totals });
        loadRows();
    });
    $('queryResultsSql').addEventListener('input', () => { sqlTyped = true; });
    $('queryDistinct').addEventListener('change', () => { setBusy('Updating…'); post({ type: 'query.distinct', on: $('queryDistinct').checked }); });
    let searchTimer = 0;
    window.SearchMatcher.followScroll($('querySearch'), $('querySearchMirror'));
    // The names a search can ask for: Results' columns (a name in several views also by letter: d.sku)
    function searchHeadings() {
        const columns = resultCols();
        const names = columns.map(c => c.column);
        const lettered = columns.filter(c => names.indexOf(c.column) !== names.lastIndexOf(c.column) && view(c.view))
            .map(c => `${view(c.view).name}.${c.column}`);
        return [...new Set(names), ...lettered];
    }
    /** What kind of values the column a heading names holds (the host says: number, yes or no, date, text). */
    function searchType(heading) {
        const want = String(heading || '').toLowerCase();
        const hit = resultCols().find(c => c.column.toLowerCase() === want || (view(c.view) && `${view(c.view).name}.${c.column}`.toLowerCase() === want));
        return (hit && hit.type) || '';
    }
    /** The search in words, under Results' tools: "Reading this as: poDate (date) after 12 Nov 2026". */
    function renderReads() {
        if ($('querySearch').value) window.SearchMatcher.renderHighlight($('querySearchMirror'), $('querySearch').value, searchHeadings());
        const says = ui.step === 4 && window.SearchMatcher.describeSearch ? window.SearchMatcher.describeSearch($('querySearch').value, searchHeadings(), searchType) : '';
        $('queryReads').textContent = says;
        $('queryReads').classList.toggle('hidden', !says);
    }
    // `@` lists the columns, each with its kind, then the operators and values that fit it
    window.SearchMatcher.attachColumnSuggest({ input: $('querySearch'), headings: searchHeadings, types: searchType });
    $('querySearch').addEventListener('input', () => {
        renderReads();
        window.SearchMatcher.renderHighlight($('querySearchMirror'), $('querySearch').value, searchHeadings());
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { ui.search = $('querySearch').value; loadRows(); }, 200);
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

    // A compare's record: a row's click, or a right-click anywhere on it
    table.addEventListener('dbmn-table-row', event => { if (hasStatus()) compareResults.openRecord(event.detail.row); });
    table.addEventListener('dbmn-table-row-menu', event => { if (hasStatus()) compareResults.openRecord(event.detail.row); });

    // The table says what was done to its headings (sorted, moved, removed, resized)
    table.addEventListener('dbmn-table-layout', event => tableChanged(event.detail));

    window.addEventListener('message', event => {
        const m = event.data || {};
        switch (m.type) {
            case 'query.init':
                showName(m.name);
                ui.start = m.empty ? 'edit' : m.start;
                // Run shows Results and nothing else while the query is read; Edit shows Views
                ui.step = ui.start === 'results' ? 4 : 1;
                // A query still being built opens its steps one at a time, from the furthest it reached
                ui.reached = Math.min(4, Math.max(1, Number(m.reached) || 4));
                PANELS.forEach((id, i) => $(id).classList.toggle('hidden', i + 1 !== ui.step));
                $('queryResultsControls').classList.toggle('hidden', ui.step !== 4);
                renderBar();
                break;
            case 'query.goTo':
                if (!ui.settled) ui.start = m.start;
                else goTo(m.start === 'results' && joinsReady() ? 4 : m.start === 'results' ? ui.step : 1);
                break;
            case 'query.sourceList': ui.sources = m.results || []; ui.sourceViews = m.views || {}; break;
            case 'query.progress':
                setBusy(m.total ? `${m.text} · ${count(m.done)} of ${count(m.total)}` : m.text);
                // (the Join step says how far a view still arriving has got)
                if (ui.step === 2 && ui.state && (ui.state.views || []).some(v => v.reading)) renderJoins();
                break;
            case 'query.state': {
                // ("New compare engine (testing)": how long the page takes to draw what the engine gave)
                const drawn = performance.now();
                applyState(m);
                if (m.onEngine) requestAnimationFrame(() => console.log(`[query-engine] page drew the step in ${Math.round(performance.now() - drawn)} ms (${m.total} rows)`));
                break;
            }
            // The host's counting: its stage as it starts one, or stopped (since: null)
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
                (ui.state.joins || []).forEach(j => { if (Object.prototype.hasOwnProperty.call(m.stats || {}, j.view)) j.stats = m.stats[j.view]; });
                ui.state.duplicates = m.duplicates;
                ui.state.notNumbers = m.notNumbers;
                ui.state.sample = null;
                renderFigures(ui.state);
                renderJoins();
                break;
            // Results' work as it goes (the first page not in yet)
            case 'query.reading': if (!grid.stopped && !$('queryReading').classList.contains('hidden')) reading(readingStage(m.stage, m.done, m.total)); break;
            // A column moved: the SQL and Columns say the new order (Results already shows it)
            case 'query.arranged':
                if (!ui.state) break;
                ui.state.columns = m.columns;
                ui.state.sql = m.sql;
                ui.state.allSelected = false;
                renderColumns();
                renderSql();
                break;
            case 'query.exported': setBusy(''); break;
            case 'query.idle': setBusy(''); break;
            case 'query.fnSample': if (ui.fnSample) ui.fnSample(m); break;
            case 'query.calcCheck': if (ui.calcCheck) ui.calcCheck(m); break;
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

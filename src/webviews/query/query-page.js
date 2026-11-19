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

    const STEPS = [{ label: 'Views' }, { label: 'Join' }, { label: 'Columns' }, { label: 'Results' }];
    const PANELS = ['queryViewsStep', 'queryJoinStep', 'queryColumnsStep', 'queryResultsStep'];
    const PAGE = 200;
    /** What ƒ offers: each a standard SQLite function around the column. `sql` is the function as
     * it is written, in pieces: 'x' is the column, { n } a number typed in place, { text } some text. */
    const FNS = [
        { id: 'trim', label: 'Trim spaces', sql: ['TRIM(', 'x', ')'] },
        { id: 'upper', label: 'Upper case', sql: ['UPPER(', 'x', ')'] },
        { id: 'text', label: 'As text', sql: ['CAST(', 'x', ' AS TEXT)'] },
        { id: 'number', label: 'As a number', sql: ['CAST(', 'x', ' AS NUMERIC)'] },
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
    function views() { return (ui.state && ui.state.views) || []; }
    function viewAt(id) { return views().findIndex(v => v.id === id); }
    function view(id) { return views().find(v => v.id === id); }
    /** A view's colour: Compare's four, then four more, then round again. */
    function colour(id) {
        if (viewAt(id) < 0) return '';   // a calculated column, or a column of the user's own SQL
        const n = viewAt(id) % 8;
        return n < 4 ? `compare-r${n}` : `query-c${n}`;
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
    function waitsFor(n) {
        if (n >= 2 && views().length === 0) return 'Views';
        if (n >= 3 && !joinsReady()) return 'Join';
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
            return n === ui.step + 1 ? { status: 'blocked', waitsFor: blocked, summary: `Waits for ${blocked}` } : { status: 'pending', summary: '' };
        });
        // What each step holds, for the list the folded steps open
        const said = stepSummaries();
        states.forEach((st, i) => { if (!st.summary || st.status === 'done') st.summary = said[i]; });
        bar.render(states, ui.step);
        // On Results the wizard is done: the steps fold into what is on screen (click it for the steps)
        bar.summary = [said[0], said[2], ui.shownText].filter(Boolean);
        // (once its rows are in: until then Results shows as a step that is working, then the steps shrink away)
        bar.folded = ui.step === 4 && !!ui.settled && !!ui.arrived;
        const next = $('queryNextBtn');
        next.classList.toggle('hidden', ui.step === 4);
        next.textContent = ui.step < 4 ? `Next: ${STEPS[ui.step].label}` : 'Next';
        next.disabled = !!waitsFor(ui.step + 1) || !!ui.busy;
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
        ui.reached = Math.max(ui.reached || 1, n);
        PANELS.forEach((id, i) => $(id).classList.toggle('hidden', i + 1 !== n));
        $('queryResultsControls').classList.toggle('hidden', n !== 4);
        renderTop();
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
                : [{ id: 'latest', label: 'Read the newest result', icon: 'refresh-cw' }, { id: 'console', label: 'Open in the Console', icon: 'external-link' }]),
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
        $('csvBatchContainer').classList.toggle('query-many', views().length > 5);
        $('queryViews').replaceChildren(...views().map(v => {
            // Sitting out: hidden by the user, or (past the first) not joined yet
            const out = !!v.off || (!!v.waiting && !v.reading && !v.error);
            const box = el('div', `compare-result ${colour(v.id)}${out ? ' is-off' : ''}`);
            // The views are changed on Views and Join (a slot's menu, and a drag to another place). On
            // Columns and Results a slot is the heading its lane hangs under, and nothing more
            const edit = ui.step <= 2;
            box.dataset.view = v.id;
            const inner = el(edit ? 'button' : 'div', 'compare-result-btn');
            if (edit) {
                inner.type = 'button';
                inner.setAttribute('aria-haspopup', 'menu');
                inner.addEventListener('click', event => { if (!slotDragged) slotMenu(event, v); });
            }
            const name = el('span', `compare-result-name${v.error ? ' color-error' : ''}`, v.name);
            // Data a week old, or a month: said on the slot, on every step
            const old = ageIcon(v);
            if (old) name.prepend(old);
            inner.appendChild(name);
            // Only its name: where it comes from and how old it is are on Views, and on hover here
            inner.title = v.file ? `${v.name}: file ${v.file} · read ${day(v.executedAt)}, ${age(v.executedAt)} · ${count(v.rows)} rows` : `${v.name}: ${v.endpointName} · ${v.view || 'Root'} · ${v.environment} · ${day(v.executedAt)}, ${age(v.executedAt)} · ${count(v.rows)} rows`;
            if (old) inner.title += `\n${old.title}`;
            if (out) inner.title += v.off ? '\nHidden: left out of the report. Its menu shows it again.' : '\nNot joined yet: left out of the report until its columns are picked on Join.';
            if (v.off) { const eye = el('i', 'query-sign'); eye.dataset.icon = 'eye-off'; name.prepend(eye); }
            if (edit) inner.appendChild(el('span', 'compare-result-caret', '▾'));
            box.appendChild(inner);
            return box;
        }), $('queryAdds'));
        injectIcons($('queryViews'));
        // A view is added on Views and Join (the query's name is typed on any step)
        $('queryAdds').classList.toggle('hidden', ui.step > 2);
    }

    /**
     * A slot dragged to another place, on Views and Join: it follows the pointer, the slots it
     * passes slide aside, and let go it is the view in that place (its joins go with it).
     */
    let slotDragged = false;
    (function slotDrag() {
        const row = $('queryViews');
        let press = null, drag = null;
        const slots = () => Array.from(row.querySelectorAll(':scope > .compare-result'));
        row.addEventListener('pointerdown', event => {
            const slot = event.target.closest && event.target.closest('.compare-result');
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
            row.insertBefore(p.slot, others[d.to] || $('queryAdds'));
            setBusy('Joining…');
            post({ type: 'query.moveView', id: p.slot.dataset.view, to: d.to });
        };
        row.addEventListener('pointerup', end);
        row.addEventListener('pointercancel', end);
    })();

    /** Views, on the slots' grid as Join is: a line per thing a view says, each view's under its slot. */
    function renderViews() {
        const box = $('queryViewRows');
        $('queryViewsEmpty').classList.toggle('hidden', views().length > 0);
        const full = !!ui.state && views().length >= ui.state.maxViews;
        $('queryAddBtn').disabled = full;
        $('queryAddBtn').title = full ? `A query takes up to ${ui.state.maxViews} views.` : '';
        $('queryAddFileBtn').disabled = full;
        box.classList.toggle('hidden', views().length === 0);
        const said = (row, label, text, className) => {
            const cells = {};
            views().forEach(v => {
                const cell = at(v.id, `query-view-cell${className ? ' ' + className : ''}`);
                const value = text(v);
                if (value instanceof Node) cell.appendChild(value); else cell.textContent = value;
                cell.title = cell.textContent;
                cells[v.id] = cell;
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
            return v.reading ? 'Reading…' : rowsButton(v);
        };
        box.replaceChildren(
            said('request', 'Request', v => v.file ? `File · ${v.file}` : [v.system, v.request || v.endpointName].filter(Boolean).join(' · ')),
            said('view', 'View', v => v.file ? (v.sheet ? `Sheet · ${v.sheet}` : '') : v.view || 'Top-level fields'),
            said('result', 'Result', v => v.file ? '' : v.environment),
            said('updated', 'Last updated', v => day(v.executedAt)),
            said('age', 'Age', aged),
            said('rowPer', 'A row per', v => v.reading ? '' : v.file ? 'line' : v.rowBasis === 'root' ? 'response' : v.rowBasis),
            said('rows', 'Rows', rows, 'query-view-rows'));
        injectIcons(box);
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
    async function addView() {
        const SHOWN = 100;
        const body = el('div', 'query-add-form compare-drill-body');
        const searchBox = el('div', 'dbmn-modal-field');
        const search = el('input', 'dbmn-modal-input');
        search.type = 'text';
        search.placeholder = 'Search results: get carriers, a path, an environment';
        search.spellcheck = false;
        search.autocomplete = 'off';
        search.setAttribute('aria-label', 'Search results');
        searchBox.appendChild(search);
        const box = el('div', 'table-container query-preview');
        const table = el('table', 'data-table');
        const head = el('thead');
        const headRow = el('tr');
        ['', 'Request', 'Endpoint', 'System', 'Environment', 'Run at'].forEach(h => headRow.appendChild(el('th', '', h)));
        head.appendChild(headRow);
        const rows = el('tbody');
        table.append(head, rows);
        box.appendChild(table);
        const more = el('p', 'form-hint');
        const viewField = el('p');
        const viewLabel = el('label', 'form-hint', 'View');
        const viewSel = el('select');
        viewSel.id = 'queryAddView';
        viewLabel.htmlFor = viewSel.id;
        viewField.append(viewLabel, el('br'), viewSel);
        body.append(searchBox, box, more, viewField);

        let picked = '';
        const haystack = r => [r.request, r.endpoint, r.system, r.environment, day(r.executedAt), r.isBatch ? 'batch' : ''].join('\n').toLowerCase();
        const viewsOf = r => (r && ui.sourceViews[r.endpointId]) || [];
        const fillViews = () => {
            const names = viewsOf(ui.sources.find(r => r.id === picked));
            viewSel.replaceChildren(...(names.length ? names : ['']).map(n => { const o = el('option', '', n || 'Top-level fields'); o.value = n; return o; }));
            // One View, or none: nothing to choose
            viewField.hidden = names.length < 2;
        };
        const draw = () => {
            const words = window.SearchWords.parseWords(search.value);
            const found = ui.sources.filter(r => window.SearchWords.matches(words, haystack(r)));
            if (!found.some(r => r.id === picked)) picked = found.length ? found[0].id : '';
            rows.replaceChildren(...found.slice(0, SHOWN).map(r => {
                const tr = el('tr');
                const pick = el('td');
                const radio = el('input');
                radio.type = 'radio';
                radio.name = 'queryAddResult';
                radio.value = r.id;
                radio.checked = r.id === picked;
                radio.setAttribute('aria-label', `${r.request || r.endpoint}, ${r.environment}, ${day(r.executedAt)}`);
                pick.appendChild(radio);
                tr.append(pick, el('td', '', r.request), el('td', '', r.endpoint), el('td', '', r.system), el('td', '', r.environment),
                    el('td', '', day(r.executedAt) + (r.isBatch ? ' · batch' : '')));
                tr.addEventListener('click', () => { radio.checked = true; picked = r.id; fillViews(); });
                tr.addEventListener('dblclick', () => { const add = document.querySelector('.dbmn-modal .btn-primary'); if (add) add.click(); });
                return tr;
            }));
            more.textContent = !ui.sources.length ? 'No results yet. Run a request, and its result can be added here.' : !found.length ? 'No result matches.' : found.length > SHOWN ? `The newest ${SHOWN} of ${count(found.length)}. Search to narrow them.` : '';
            more.hidden = !more.textContent;
            fillViews();
        };
        search.addEventListener('input', draw);
        draw();
        setTimeout(() => search.focus(), 0);
        const answer = await window.DbmnModal.show({
            title: 'Add a view', body, size: 'lg',
            actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'add', label: 'Add', variant: 'primary' }]
        });
        const result = ui.sources.find(r => r.id === picked);
        if (answer.actionId !== 'add' || !result) return;
        setBusy('Reading the result…');
        post({ type: 'query.addView', endpointId: result.endpointId, executionId: result.id, view: viewSel.value });
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

    /** ƒ: functions on the column, ticked from a list. Each is written as its SQL with the
     * column's own name in it and its values typed in place. They apply in the order they are
     * ticked (each ticked row says its place); the SQL they make together and a few of the
     * column's values, as they are and as the functions leave them, show beside the list. */
    async function pickFns(join, ref) {
        const viewId = ref.view || join.view;
        const v = view(viewId);
        const name = (v ? v.name + '.' : '') + (ref.column || 'column');
        const body = el('div', 'dbmn-modal-field query-fx-form');
        const group = el('div');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Functions');
        const sample = el('div', 'table-container');
        const table = el('table', 'data-table');
        const head = el('thead');
        const headRow = el('tr');
        headRow.append(el('th', '', name), el('th', '', 'Joins as'));
        head.appendChild(headRow);
        const rows = el('tbody');
        table.append(head, rows);
        sample.appendChild(table);
        const note = el('p', 'form-hint', '');
        const made = el('code', 'query-fx-sql font-mono', name);
        const clear = el('button', 'compare-match-drill', 'Clear all');
        clear.type = 'button';

        // The ticked ones, in the order they were ticked
        let order = (ref.fns || []).map(f => f.fn).filter(id => FNS.some(d => d.id === id));
        const options = FNS.map(def => {
            const had = (ref.fns || []).find(f => f.fn === def.id);
            const row = el('label');
            const box = el('input');
            box.type = 'checkbox';
            box.value = def.id;
            box.checked = !!had;
            const code = el('small', 'font-mono');
            const inputs = {};
            const tick = on => {
                box.checked = on;
                order = order.filter(id => id !== def.id);
                if (on) order.push(def.id);
                ask();
            };
            def.sql.forEach(piece => {
                if (piece === 'x') { code.appendChild(el('strong', '', name)); return; }
                if (typeof piece === 'string') { code.appendChild(document.createTextNode(piece)); return; }
                const input = el('input', 'dbmn-modal-input');
                input.type = piece.number ? 'number' : 'text';
                if (piece.number) input.min = '1';
                input.value = had ? had[piece.key] : FN_DEFAULTS[piece.key];
                input.setAttribute('aria-label', piece.label);
                input.dataset.fnValue = piece.key;
                // Typing a value ticks its function; a click in the box is not a click on the row
                // A text box is as wide as what is in it, so a saved value is in sight when the dialog opens
                const fit = () => { if (!piece.number) input.size = Math.min(40, Math.max(6, input.value.length + 1)); };
                fit();
                input.addEventListener('input', () => { fit(); if (box.checked) ask(); else tick(true); });
                // A value copied from a table comes with a tab or spaces around it, which would match nothing
                input.addEventListener('paste', e => {
                    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
                    if (text === text.trim()) return;
                    e.preventDefault();
                    input.setRangeText(text.trim(), input.selectionStart, input.selectionEnd, 'end');
                    input.dispatchEvent(new Event('input'));
                });
                input.addEventListener('click', e => e.preventDefault());
                inputs[piece.key] = input;
                code.appendChild(input);
            });
            box.addEventListener('change', () => tick(box.checked));
            const label = el('span', '', def.label);
            const place = el('b', 'query-fx-order', '');
            label.appendChild(place);
            row.append(box, label, code);
            group.appendChild(row);
            return { def, box, inputs, place };
        });
        clear.addEventListener('click', () => { options.forEach(o => { o.box.checked = false; }); order = []; ask(); });

        function picked() {
            return order.map(id => {
                const o = options.find(x => x.def.id === id);
                const f = { fn: id };
                if (o.inputs.n) f.n = Math.max(1, parseInt(o.inputs.n.value, 10) || 1);
                if (o.inputs.from) f.from = o.inputs.from.value;
                if (o.inputs.to) f.to = o.inputs.to.value;
                return f;
            });
        }
        const ORDINAL = ['1st', '2nd', '3rd'];
        let seq = 0;
        function ask() {
            seq += 1;
            const fns = picked();
            made.textContent = fnSql(fns, name);
            clear.disabled = !fns.length;
            // With more than one ticked, each says when it applies
            options.forEach(o => {
                const at = order.indexOf(o.def.id);
                o.place.textContent = order.length > 1 && at >= 0 ? (ORDINAL[at] || `${at + 1}th`) : '';
            });
            post({ type: 'query.fnSample', view: viewId, column: ref.column, fns, seq });
        }
        ui.fnSample = m => {
            if (m.seq !== seq) return;
            rows.replaceChildren(...(m.rows || []).map(r => {
                const tr = el('tr');
                tr.append(el('td', 'font-mono', show(r[0])), el('td', 'font-mono' + (show(r[0]) === show(r[1]) ? '' : ' text-link'), show(r[1])));
                // A value too long for its half is cut short: the whole of it on hover
                Array.from(tr.cells).forEach(td => { td.title = td.textContent; });
                return tr;
            }));
            note.textContent = m.error || ((m.rows || []).length ? '' : 'No values to show yet.');
        };
        function show(value) { return value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value); }

        const list = el('div', 'query-fx-side');
        const top = el('p', 'form-hint query-row');
        top.append(el('span', '', 'Tick any. They apply in the order you tick them.'), clear);
        list.append(top, group);
        const side = el('div', 'query-fx-side');
        side.append(el('p', 'form-hint', 'The column joins as'), made, sample, note);
        body.append(list, side);
        ask();
        const answer = await window.DbmnModal.show({
            title: `Functions on ${ref.column || 'the column'}`, body, size: 'lg',
            actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'ok', label: 'Apply', variant: 'primary' }]
        });
        const fns = picked();
        ui.fnSample = null;
        if (answer.actionId !== 'ok') return;
        ref.fns = fns;
        sendJoin(join);
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
    function at(id, className) { return el('div', `query-at ${colour(id)}${className ? ' ' + className : ''}`); }
    /** A line: `lead` on the left (what the line is), `cells` by view id (a view with none gets an
     * empty cell, so the lanes run on), then `says` on the right (its tools). */
    function line(className, cells, says, lead) {
        const row = el('div', `query-line${className ? ' ' + className : ''}`);
        const start = el('div', 'query-lead');
        (lead || []).forEach(node => { if (node) start.append(node); });
        const grid = el('div', 'query-cells');
        views().forEach(v => grid.appendChild(cells[v.id] || at(v.id)));
        const end = el('div', 'query-says');
        (says || []).forEach(node => { if (node) end.appendChild(node); });
        row.append(start, grid, end);
        return row;
    }
    /** Compare's picture of a relationship, each side in its view's colour. */
    function picture(kind, join) {
        const node = window.RelationGlyph.svg(kind);
        const left = colour((join.on[0] && join.on[0].left.view) || (views()[0] || {}).id);
        const right = colour(join.view);
        node.querySelectorAll('.g-b').forEach(c => { if (left) c.classList.add(left); });
        node.querySelectorAll('.g-c').forEach(c => { if (right) c.classList.add(right); });
        return node;
    }
    /**
     * The link between a pair's two columns, drawn over the lanes from the end of one cell to the
     * start of the other, however far apart: a dot at each end for one, two for many, and straight
     * lines between them. Each end is in its view's colour.
     */
    function link(fromId, toId, relationship) {
        const NS = 'http://www.w3.org/2000/svg';
        const page = getComputedStyle($('csvBatchContainer'));
        const col = parseFloat(page.getPropertyValue('--query-col')) || 200;
        const gap = parseFloat(page.getPropertyValue('--query-gap')) || 8;
        const a = viewAt(fromId);
        const b = viewAt(toId);
        const x1 = (a + 1) * col + a * gap - 9;
        const x2 = b * (col + gap) + 9;
        const many = { left: relationship === 'manyToOne' || relationship === 'manyToMany', right: relationship === 'oneToMany' || relationship === 'manyToMany' };
        const ys = side => (many[side] ? [10, 26] : [18]);
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'query-link');
        svg.dataset.relation = relationship;
        const name = (KINDS.find(k => k[0] === relationship) || [])[1];
        if (name) {
            svg.setAttribute('role', 'img');
            svg.setAttribute('aria-label', name);
            const said = document.createElementNS(NS, 'title');
            said.textContent = name;
            svg.appendChild(said);
        } else svg.setAttribute('aria-hidden', 'true');
        const put = (tag, attrs, className) => {
            const node = document.createElementNS(NS, tag);
            Object.keys(attrs).forEach(k => node.setAttribute(k, attrs[k]));
            if (className) node.setAttribute('class', className);
            svg.appendChild(node);
        };
        ys('left').forEach(y1 => ys('right').forEach(y2 => put('line', { x1, y1, x2, y2 })));
        if (name) {
            ys('left').forEach(cy => put('circle', { cx: x1, cy, r: 4 }, colour(fromId)));
            ys('right').forEach(cy => put('circle', { cx: x2, cy, r: 4 }, colour(toId)));
        }
        return svg;
    }
    /** How many rows of each kind a join has: [rows, the joining view's records]. */
    function kindCounts(stats, kind) {
        if (kind === 'onlyBase') return [stats.leftRows - stats.leftMatched, 0];
        if (kind === 'onlyOther') return [0, stats.rightRows - stats.rightMatched];
        return [stats.rows[kind] || 0, stats.records[kind] || 0];
    }
    /** What a count means, on hover. */
    function kindTitle(kind, join, rows, records) {
        const name = (view(join.view) || {}).name || 'the view';
        switch (kind) {
            case 'oneToOne': return `${count(rows)} rows each match one ${name} row of their own`;
            case 'manyToOne': return `${count(rows)} rows share ${count(records)} ${name} rows. No rows are added`;
            case 'oneToMany': return `${count(rows)} rows match ${count(records)} ${name} rows: a row comes out once for each. Add a column to the join (+ AND) to stop it`;
            case 'manyToMany': return `${count(rows)} rows match ${count(records)} ${name} rows, several each way: every pairing makes a row. Add a column to the join (+ AND) to stop it`;
            case 'onlyBase': return join.kind === 'inner' ? `${count(rows)} rows have no match in ${name}: JOIN leaves them out` : `${count(rows)} rows have no match in ${name}: LEFT JOIN keeps them, with ${name}'s columns blank`;
            default: return `${count(records)} ${name} rows match no row. They are not in the report`;
        }
    }
    function valueKind(v) {
        if (!v.right) return 'onlyBase';
        if (!v.left) return 'onlyOther';
        return v.left > 1 ? (v.right > 1 ? 'manyToMany' : 'manyToOne') : v.right > 1 ? 'oneToMany' : 'oneToOne';
    }
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
                const kinds = el('span', 'toggle-group');
                [['left', 'LEFT JOIN', 'Keeps every row, matched or not'], ['inner', 'JOIN', 'Keeps only rows that match']].forEach(([kind, label, title]) => {
                    const b = el('button', 'toggle-btn font-mono' + (join.kind === kind ? ' active' : ''), label);
                    b.type = 'button';
                    b.title = title;
                    b.setAttribute('aria-pressed', String(join.kind === kind));
                    b.addEventListener('click', () => { if (join.kind !== kind) { join.kind = kind; sendJoin(join); } });
                    kinds.appendChild(b);
                });
                lead.push(kinds);
                const and = el('button', 'compare-tool-btn text-link font-mono font-size-12', '+ AND');
                and.dataset.and = '';
                and.type = 'button';
                and.title = 'Another pair of columns, for a key made of two';
                // Which earlier view its column comes from is said by the box it is picked in
                and.addEventListener('click', () => { join.on.push({ left: { view: earlier[0].id, column: '' }, right: { column: '' }, picked: true }); renderJoins(); });
                says.push(and);
            } else lead.push(el('span', `query-and ${KW}`, 'AND'));
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
            // The link between the two columns, across the lanes, once both are picked: how the
            // sides meet on the join's first pair, a plain line on the others
            if (pair.left.column && pair.right.column) made.querySelector('.query-cells').appendChild(link(pair.left.view, v.id, p === 0 && stats ? stats.relationship : 'none'));
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
                warn.title = `${count(none)} ${none === 1 ? 'row has' : 'rows have'} no match in ${v.name}: ${join.kind === 'inner' ? 'JOIN leaves them out' : `LEFT JOIN keeps them, with ${v.name} blank`}`;
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
        const made = line('query-made-line', after, [v.error ? errorLine(v) : joinNote(join, stats)], [el('span', 'query-lead-text', 'Rows after this join'), more]);
        made.dataset.kind = 'made';
        made.classList.toggle('is-openable', !!stats);
        band.appendChild(made);
        // The views after this one are not part of its join: their lanes are out, and say why
        const shut = () => {
            const last = viewAt(v.id);
            band.querySelectorAll('.query-cells').forEach(cells => Array.from(cells.children).forEach((cell, i) => {
                const later = views()[i];
                if (i <= last || !later || !cell.classList.contains('query-at')) return;
                cell.classList.add('query-lane-off');
                cell.title = `${later.name} joins further down: a view joins to the views before it. Drag ${later.name}'s slot to the left of ${v.name} to join it here.`;
            }));
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
            const name = kind === 'onlyBase' ? (join.kind === 'inner' ? 'No match: left out' : 'No match: kept') : label;
            const row = line('query-kind-line', cells, [], [picture(kind, join), el('span', `query-kind query-lead-text${warn ? ' query-warn' : ''}`, name)]);
            row.dataset.kind = kind;
            row.title = kindTitle(kind, join, rows, records);
            band.appendChild(row);
        });
        return shut();
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
            said = `${has} ${count(n)} of them ${some('has', 'have')} no record in ${theirs.name}. ${count(rows)} ${rows === 1 ? 'row holds' : 'rows hold'} ${some('it', 'them')}${stats.leftBlank ? ' or have no value at all' : ''}: ${join.kind === 'inner' ? 'JOIN leaves those rows out' : `LEFT JOIN keeps those rows, with ${theirs.name} blank`}.`;
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
        const lines = [line('query-total-line', totals, [first.error ? errorLine(first) : null], [el('span', 'query-lead-text', 'Rows in each view')])];
        if (s.views.length < 2) lines.push(el('p', 'compare-match-empty', 'Add another view to join.'));
        s.views.slice(1).forEach((v, i) => {
            const join = s.joins.find(j => j.view === v.id);
            if (join) lines.push(joinBand(v, join, s.views.slice(0, i + 1)));
        });
        box.replaceChildren(...lines);
        injectIcons(box);
        renderSql();
    }

    /** Results' columns: the steps', or what the user's own SQL makes. */
    function resultCols() { return (ui.state && ui.state.resultColumns) || []; }

    /* ---------- Columns ---------- */

    function allColumns() {
        // A value of each column from one row of the report (the first where every view matched), not each view's own first row
        const row = new Map(((ui.state && ui.state.sampleRow) || []).map(c => [`${c.view}\u0000${c.column}`, c.value]));
        const sample = (v, c) => (row.has(`${v.id}\u0000${c.name}`) ? row.get(`${v.id}\u0000${c.name}`) : c.sample);
        return views().filter(v => !v.waiting && !v.off && !v.error).flatMap(v => v.columns.map(c => ({ view: v.id, column: c.name, sample: sample(v, c), empty: !!c.empty, filled: c.filled || 0, rows: v.rows || 0 })))
            .concat(((ui.state && ui.state.calc) || []).map(c => ({ view: '', column: c.name, sample: c.expr, calc: c })));
    }

    /** A calculated column: its name, and an SQL expression over the views' columns by letter. */
    async function editCalc(calc) {
        const body = el('div', 'dbmn-modal-fields');
        const field = (label, input) => { const f = el('div', 'dbmn-modal-field'); const l = el('label', '', label); l.htmlFor = input.id; f.append(l, input); return f; };
        const name = el('input', 'dbmn-modal-input');
        name.type = 'text'; name.id = 'queryCalcName'; name.value = calc ? calc.name : ''; name.spellcheck = false; name.autocomplete = 'off';
        const expr = el('input', 'dbmn-modal-input font-mono');
        expr.type = 'text'; expr.id = 'queryCalcExpr'; expr.value = calc ? calc.expr : ''; expr.spellcheck = false; expr.autocomplete = 'off';
        expr.placeholder = 'Stock.quantityOnHand - Products.reorderPoint';
        const insert = el('select', 'dbmn-modal-input');
        insert.id = 'queryCalcInsert';
        const first = el('option', '', 'Pick a column to put it in the calculation'); first.value = '';
        insert.appendChild(first);
        views().filter(v => !v.waiting && !v.error).forEach(v => v.columns.forEach(c => {
            const ref = `${v.name}.${/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) ? c.name : '"' + c.name.replace(/"/g, '""') + '"'}`;
            const o = el('option', '', `${ref}   ${c.sample}`); o.value = ref; insert.appendChild(o);
        }));
        insert.addEventListener('change', () => {
            if (!insert.value) return;
            const at = expr.selectionStart == null ? expr.value.length : expr.selectionStart;
            expr.value = expr.value.slice(0, at) + insert.value + expr.value.slice(expr.selectionEnd == null ? at : expr.selectionEnd);
            insert.value = '';
            expr.focus();
        });
        body.append(field('Name', name), field('Calculation', expr), field('Columns', insert),
            el('p', 'form-hint', 'Any SQL expression: + - * /, ROUND(x, 2), COALESCE(x, 0), x || \' \' || y, CASE WHEN x > 0 THEN \'In stock\' ELSE \'Out\' END.'));
        setTimeout(() => name.focus(), 0);
        const answer = await window.DbmnModal.show({
            title: calc ? 'Calculated column' : 'Add a calculated column', body,
            actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'ok', label: calc ? 'Save' : 'Add', variant: 'primary' }]
        });
        if (answer.actionId !== 'ok') return;
        setBusy('Updating…');
        post({ type: 'query.setCalc', name: name.value, expr: expr.value, was: calc ? calc.name : undefined });
    }
    /** Columns in the order shown, the ticked first as picked, then the rest. */
    function columnList() {
        const s = ui.state;
        const key = c => `${c.view}\u0000${c.column}`;
        const all = allColumns();
        const byKey = new Map(all.map(c => [key(c), c]));
        const picked = s.columns.filter(c => byKey.has(key(c))).map(c => Object.assign({ on: true }, byKey.get(key(c))));
        const on = new Set(picked.map(key));
        return picked.concat(all.filter(c => !on.has(key(c))).map(c => Object.assign({ on: false }, c)));
    }
    function sendColumns(list) {
        const on = list.filter(c => c.on);
        if (!on.length) { window.DbmnToast && window.DbmnToast.info('Tick at least one column.'); renderColumns(); return; }
        setBusy('Updating…');
        post({ type: 'query.setSelect', select: on.map(c => ({ view: c.view, column: c.column })) });
    }
    /** Columns, on the slots' grid: each view's columns under its slot, ticked to show, a value of
     * each under its name. Calculated columns stand after the views. The order is Results' to change. */
    function renderColumns() {
        const box = $('queryColumns');
        if (!box) return;
        const list = columnList();
        // A joining view's key is matched to another view's column: the same value, so it is not shown twice
        const keys = (ui.state && ui.state.keyColumns) || [];
        const keyOf = c => keys.find(k => k.view === c.view && k.column === c.column);
        // A name an earlier view has too: left unticked until it is wanted; ticked, its heading says whose it is
        const alsoIn = c => views().slice(0, Math.max(0, viewAt(c.view))).find(v => v.columns.some(x => x.name === c.column));
        const item = c => {
            const key = c.calc ? null : keyOf(c);
            const twin = c.calc || key ? null : alsoIn(c);
            const row = el('label', 'query-col' + (key ? ' is-key' : twin ? ' is-clash' : ''));
            const tick = el('input');
            tick.type = 'checkbox';
            tick.checked = c.on && !key;
            tick.disabled = !!key;
            tick.setAttribute('aria-label', `Show ${c.column}`);
            tick.addEventListener('change', () => { c.on = tick.checked; sendColumns(list); });
            const text = el('span', 'query-col-text');
            const same = key && view(key.sameView) ? `${view(key.sameView).name}.${key.sameColumn}` : '';
            const name = el('span', 'query-col-name', c.column);
            // Sharing its name with an earlier view's column: a sign beside it says whether, in the
            // row shown, the two hold the same value (a dashed triangle) or not (a warning)
            const other = twin ? list.find(x => !x.calc && x.view === twin.id && x.column === c.column) : null;
            const alike = !!other && String(other.sample || '') === String(c.sample || '');
            if (twin) {
                const sign = el('i', `query-sign ${alike ? 'query-same' : 'query-warn'}`);
                sign.dataset.icon = alike ? 'triangle-dashed' : 'triangle-alert';
                sign.dataset.twin = alike ? 'same' : 'differs';
                name.append(' ', sign);
            }
            // A column with no value in any row says so where its value would be, a dotted circle by its name
            const blank = !key && c.empty;
            if (blank) {
                const sign = el('i', 'query-sign query-empty');
                sign.dataset.icon = 'circle-dot-dashed';
                sign.dataset.empty = '';
                name.append(' ', sign);
            }
            // How many of its view's rows have a value here
            const of = (view(c.view) || {}).name;
            const has = c.calc ? '' : `${count(c.filled)} of ${count(c.rows)} rows of ${of} have a value in ${c.column}.`;
            text.append(name, el('span', `query-col-sample ${blank ? 'query-col-blank' : 'font-mono'}`, key ? `= ${same}` : blank ? 'no values' : c.sample || ''));
            row.title = key ? `The join matches ${c.column} to ${same}, so it would say the same twice. ${same} is the one shown.`
                : blank ? `${c.on ? '' : 'Left unticked: '}no row of ${of} has a value in ${c.column}.${twin ? ` ${twin.name} has a ${c.column} too.` : ''}`
                    : twin ? `${c.on ? '' : 'Left unticked: '}${twin.name} has a ${c.column} too, ${alike ? (c.sample ? 'with the same value in this row' : 'and both are blank in this row') : `with a different value in this row (${(other && other.sample) || 'blank'})`}. ${has} With both ticked, each heading says whose it is: ${c.column} (${of})`
                        : c.sample ? `${c.column}: ${c.sample}. ${has}` : c.calc ? c.column : `${c.column}: blank in the row shown. ${has}`;
            row.append(tick, text);
            return row;
        };
        // At the top of every lane, side by side: the columns each join matches, then the columns
        // that share a name. A lane without one of them leaves its place empty, so the rest line up
        const id = c => `${c.view}\u0000${c.column}`;
        const items = new Map(list.filter(c => !c.calc).map(c => [id(c), c]));
        let top = [];
        const placed = new Set();
        const place = (row, viewId, column) => {
            const c = items.get(`${viewId}\u0000${column}`);
            if (!c || placed.has(id(c)) || row.cells[viewId]) return;
            row.cells[viewId] = c;
            placed.add(id(c));
        };
        const rowFor = key => {
            let row = top.find(r => r.key === key);
            if (!row) { row = { key, cells: {} }; top.push(row); }
            return row;
        };
        keys.forEach(k => {
            const row = rowFor(`key\u0000${k.sameView}\u0000${k.sameColumn}`);
            place(row, k.sameView, k.sameColumn);
            place(row, k.view, k.column);
        });
        const shared = new Map();
        views().forEach(v => v.columns.forEach(c => shared.set(c.name, (shared.get(c.name) || []).concat(v.id))));
        shared.forEach((ids, name) => {
            if (ids.length < 2) return;
            // Beside a matched column of the same name when there is one
            const row = top.find(r => Object.keys(r.cells).some(v => r.cells[v].column === name)) || rowFor(`name\u0000${name}`);
            ids.forEach(viewId => place(row, viewId, name));
        });
        // A row left with one column is no pair: it goes back among its view's others
        top = top.filter(row => {
            const held = Object.keys(row.cells);
            if (held.length > 1) return true;
            held.forEach(v => placed.delete(id(row.cells[v])));
            return false;
        });
        const cells = {};
        views().forEach(v => {
            const order = name => v.columns.findIndex(c => c.name === name);
            const mine = list.filter(c => !c.calc && c.view === v.id).sort((x, y) => order(x.column) - order(y.column));
            const free = mine.filter(c => !keyOf(c));
            const cell = at(v.id, 'query-col-list');
            cell.dataset.view = v.id;
            if (mine.length) {
                // All of a view's columns at once; half ticked says some are
                const on = free.filter(c => c.on).length;
                const all = el('label', 'query-col query-col-all');
                const tick = el('input');
                tick.type = 'checkbox';
                tick.checked = free.length > 0 && on === free.length;
                tick.indeterminate = on > 0 && on < free.length;
                tick.setAttribute('aria-label', `Show every column of ${v.name}`);
                tick.addEventListener('change', () => { free.forEach(c => { c.on = tick.checked; }); sendColumns(list); });
                all.append(tick, el('span', 'query-col-name', `${count(on)} of ${count(free.length)}`));
                cell.append(all, ...top.map(row => (row.cells[v.id] ? item(row.cells[v.id]) : el('div', 'query-col query-col-gap'))));
                if (top.length) cell.appendChild(el('div', 'query-col-rule'));
                cell.append(...mine.filter(c => !placed.has(id(c))).map(item));
            }
            cells[v.id] = cell;
        });
        // Calculated columns, after the views
        const calc = el('div', 'query-col-list query-col-calc');
        list.filter(c => c.calc).forEach(c => {
            const row = el('div', 'query-col-row');
            const button = (icon, title, label, click) => {
                const b = el('button', 'compare-tool-btn icon');
                b.type = 'button'; b.title = title; b.setAttribute('aria-label', label); b.dataset.icon = icon;
                b.addEventListener('click', click);
                return b;
            };
            row.append(item(c),
                button('pencil', 'Change the calculation', `Change ${c.column}`, () => editCalc(c.calc)),
                button('x', 'Remove this column', `Remove ${c.column}`, () => { setBusy('Updating…'); post({ type: 'query.removeCalc', name: c.column }); }));
            calc.appendChild(row);
        });
        const add = el('button', 'compare-tool-btn text-link font-size-12', '+ Calculated column');
        add.type = 'button';
        add.id = 'queryCalcBtn';
        add.title = 'A column worked out from others: Stock.quantityOnHand - Products.reorderPoint';
        add.addEventListener('click', () => editCalc(null));
        calc.appendChild(add);
        const shown = list.filter(c => c.on && (c.calc || !keyOf(c))).length;
        const free = list.filter(c => c.calc || !keyOf(c)).length;
        box.replaceChildren(
            line('query-cols-line', cells, [calc], [el('span', 'query-lead-text', `${count(shown)} of ${count(free)} columns shown`)]),
            el('p', 'form-hint', 'The value under each name is from one row of the report: the first where every view matched. Filtering comes next: on Results, search the rows to keep only the ones you want (the SQL\'s WHERE), and drag a heading to change the order.'));
        injectIcons(box);
    }

    /* ---------- Results ---------- */

    /* Only the rows in view are drawn (the Console's windowing, virtual-window.js), from rows
     * fetched a page at a time and kept by page. The spacers above and below stand in for the
     * rest, so the scroll bar is the whole report's from the first page. */
    const ROW_H = 22;
    const grid = {
        pages: new Map(),   // rows fetched, by page number
        asked: new Set(),   // pages on their way
        fresh: false,       // a new search, sort or query: the table is swapped when its first page arrives
        keep: false,        // ...and stays scrolled where it is (a column was taken out)
        sizedFor: '',       // the columns the widths were measured for: a sort or a search keeps them
        rowH: 0,
        rendered: { start: -1, end: -1 },
        lastTop: 0,
        frame: 0
    };

    /** Results from the top: after a search, a sort, or a change to the query. What is on screen stays until the new rows arrive. */
    function loadRows() {
        if (!ui.state) return;
        ui.seq++;
        grid.pages.clear();
        grid.asked.clear();
        grid.fresh = true;
        if (!$('queryHead').firstChild) drawHead();
        ask(0);
    }
    function ask(page) {
        if (grid.asked.has(page) || grid.pages.has(page)) return;
        grid.asked.add(page);
        post({ type: 'query.rows', seq: ui.seq, offset: page * PAGE, limit: PAGE, search: ui.search, sort: ui.sort, totals: ui.totals });
    }

    function drawHead() {
        const columns = resultCols();
        const names = columns.map(c => c.column);
        const own = !!ui.state.ownSql;
        const tr = el('tr');
        columns.forEach(c => {
            const v = view(c.view);
            const name = v && v.name;
            // The same name in two views: each says whose it is
            const text = names.indexOf(c.column) !== names.lastIndexOf(c.column) && v ? (name ? `${c.column} (${name})` : `${v.table}.${c.column}`) : c.column;
            const th = el('th', `compare-sub sortable-header ${colour(c.view)}`);
            const content = el('div', 'flex align-center column-header-content');
            const actions = el('span', 'header-actions');
            // Each place its own job (column-head.js): the name drags, the icon sorts, x takes the column out, the right edge resizes
            actions.appendChild(window.ColumnHead.sortButton({ label: text }));
            if (!own && columns.length > 1) actions.appendChild(window.ColumnHead.hideButton({ label: text, title: 'Remove this column (Columns brings it back)' }));
            const label = el('span', 'column-name', text);
            const movable = !own && columns.length > 1;
            label.classList.toggle('is-movable', movable);
            label.title = (movable ? 'Hold and drag to move this column. ' : '') + (name ? `@${name}.${c.column} searches it` : '');
            content.append(label, actions);
            th.append(content, window.ColumnHead.edge());
            tr.appendChild(th);
        });
        $('queryHead').replaceChildren(tr);
        injectIcons(tr);
        markSort();
    }

    /** A column of numbers (going by the first page): its sort reads 0 to 1, not A to Z. */
    function isNumbers(i) {
        const rows = grid.pages.get(0) || [];
        let any = false;
        for (const r of rows) {
            const v = r[i];
            if (v === null || v === undefined || v === '') continue;
            if (typeof v !== 'number') return false;
            any = true;
        }
        return any;
    }
    function markSort() {
        const head = $('queryHead').firstChild;
        if (!head) return;
        Array.from(head.cells).forEach((th, i) => {
            th.classList.toggle('sort-asc', !!ui.sort && ui.sort.column === i && ui.sort.dir === 'asc');
            th.classList.toggle('sort-desc', !!ui.sort && ui.sort.column === i && ui.sort.dir === 'desc');
            const dir = ui.sort && ui.sort.column === i ? ui.sort.dir : '';
            window.ColumnHead.setSort(th.querySelector('.col-sort-btn'), dir, isNumbers(i));
        });
    }

    /** One row; with no values yet (its page is on its way), its cells empty. */
    function rowEl(columns, values) {
        const tr = el('tr');
        columns.forEach((c, i) => {
            const value = values ? values[i] : null;
            const text = cellText(value);
            const td = el('td', `query-cell ${colour(c.view)}` + (typeof value === 'number' ? ' text-right' : ''), text);
            if (text.length > 40) { td.classList.add('cell-expandable'); td.title = 'Click to see it all'; }
            tr.appendChild(td);
        });
        return tr;
    }

    /** Each column as wide as the first page's values need (long ones cut off), then held there: scrolling never shifts a column. */
    function sizeColumns(rows) {
        const table = $('queryTable');
        const columns = resultCols();
        table.classList.remove('is-sized');
        table.style.removeProperty('width');
        $('queryCols').replaceChildren();
        $('queryAbove').replaceChildren();
        $('queryBelow').replaceChildren();
        $('queryBody').replaceChildren(...rows.map(r => rowEl(columns, r)));
        const head = $('queryHead').firstChild;
        if (!head || !rows.length) return;
        // Not on screen (its tab is behind another, or another step is up): nothing has a width to
        // measure, and columns held at 0 would vanish beside one the user had set. Sized when seen
        if (!$('queryTableContainer').clientWidth) { grid.sizedFor = ''; return; }
        grid.rowH = $('queryBody').firstChild.getBoundingClientRect().height || ROW_H;
        let widths = Array.from(head.cells).map(th => Math.ceil(th.getBoundingClientRect().width));
        // A width the user set is the query's: kept as set. With none set, a narrow report fills the window
        const set = (ui.state && ui.state.widths) || {};
        const mine = columns.map(c => set[widthKey(c)] || 0);
        const sum = widths.reduce((a, b) => a + b, 0);
        const room = $('queryTableContainer').clientWidth;
        if (!mine.some(Boolean) && sum < room) widths = widths.map(w => Math.floor(w * room / sum));
        widths = widths.map((w, i) => mine[i] || w);
        $('queryCols').replaceChildren(...widths.map(w => { const col = el('col'); col.style.width = `${w}px`; return col; }));
        table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
        table.classList.add('is-sized');
        grid.sizedFor = columnsKey();
    }

    // Rows that arrived while the table was out of sight are sized when it comes back
    if (window.ResizeObserver) new ResizeObserver(() => {
        const first = grid.pages.get(0);
        if (!$('queryTableContainer').clientWidth || $('queryTable').classList.contains('is-sized') || !first || !first.length) return;
        sizeColumns(first);
        grid.rendered = { start: -1, end: -1 };
        render(true);
    }).observe($('queryTableContainer'));

    function widthKey(c) { return `${c.view}:${c.column}`; }

    /** One column's width, set: only it changes, the columns after it move along. */
    function setWidth(i, width) {
        const col = $('queryCols').children[i];
        const table = $('queryTable');
        if (!col) return 0;
        const w = Math.max(window.ColumnHead.MIN_WIDTH, Math.round(width));
        table.style.width = `${parseFloat(table.style.width) - parseFloat(col.style.width) + w}px`;
        col.style.width = `${w}px`;
        return w;
    }
    /** ...and kept with the query. */
    function saveWidth(i, width) {
        const c = resultCols()[i];
        if (!c || !width) return;
        ui.state.widths = Object.assign({}, ui.state.widths, { [widthKey(c)]: width });
        post({ type: 'query.setWidth', key: widthKey(c), width });
    }
    /** As wide as its name and the values on screen need. */
    function fitColumn(i) {
        const th = $('queryHead').firstChild.cells[i];
        const name = th.querySelector('.column-name');
        const actions = th.querySelector('.header-actions');
        // The text itself is measured (a cell is never narrower than its column, so it cannot say)
        const wide = window.ColumnHead.textWidth;
        let need = wide(name, name.textContent) + actions.offsetWidth + 22;
        Array.from($('queryBody').rows).forEach(r => { if (r.cells[i]) need = Math.max(need, wide(r.cells[i], r.cells[i].textContent) + 20); });
        saveWidth(i, setWidth(i, Math.min(window.ColumnHead.MAX_FIT, need)));
    }

    /** A column to another place without a drag (the heading's menu): its cells on screen move, then as a drag's end. */
    function moveTo(from, to) {
        if (from === to || grid.fresh) return;
        const count = resultCols().length;
        const move = parent => { const kids = parent.children; parent.insertBefore(kids[from], to > from ? kids[to].nextSibling : kids[to]); };
        Array.from($('queryTable').rows).filter(r => r.cells.length === count).forEach(move);
        if ($('queryCols').children.length === count) move($('queryCols'));
        columnMoved(from, to);
    }

    /** Sort by a column (null: as the query made them). The heading answers at once: its icon is a
     * ticking clock until the sorted rows arrive (a long report takes a moment). */
    function sortBy(sort) {
        if (grid.fresh || grid.sorting) return;   // one sort at a time
        const was = ui.sort;
        ui.sort = sort;
        const th = $('queryHead').firstChild.cells[(sort || was || { column: 0 }).column];
        if (th) window.ColumnHead.wait(th.querySelector('.col-sort-btn'), sort ? sort.dir : 'asc');
        grid.sorting = true;
        setBusy(`Sorting ${count(ui.shown)} rows…`);
        // Drawn before the sort is asked for
        requestAnimationFrame(() => setTimeout(loadRows, 0));
    }

    /** Right-click a heading: everything it can do, by name. */
    function headMenu(event, i) {
        if (!window.DbmnContextMenu || !ui.state) return;
        const last = resultCols().length - 1;
        const own = !!ui.state.ownSql;
        window.ColumnHead.menu(event, {
            numbers: isNumbers(i),
            dir: ui.sort && ui.sort.column === i ? ui.sort.dir : '',
            sorted: !!ui.sort,
            first: i === 0, last: i === last,
            sort: dir => sortBy(dir ? { column: i, dir } : null),
            move: own || last === 0 ? null : where => moveTo(i, where === 'start' ? 0 : last),
            fit: () => fitColumn(i),
            remove: own || last === 0 ? null : () => hideColumn(i)
        });
    }

    function columnsKey() { return resultCols().map(c => `${c.view}\u0000${c.column}`).join('\u0001'); }

    function spacer(body, height, span) {
        if (!height) return body.replaceChildren();
        const td = el('td');
        td.colSpan = span;
        td.style.height = `${height}px`;
        const tr = el('tr');
        tr.appendChild(td);
        body.replaceChildren(tr);
    }

    /** Draw the rows in view (and a little past them). `force`: even when the ones drawn still cover it. */
    function render(force) {
        if (!ui.state || grid.fresh || ui.step !== 4 || drag.isDragging()) return;
        const box = $('queryTableContainer');
        const at = { scrollTop: box.scrollTop, viewportHeight: box.clientHeight, rowHeight: grid.rowH || ROW_H, totalRows: ui.shown };
        if (!force && !window.VirtualWindow.needsRender(Object.assign({ rendered: grid.rendered, marginPx: 150 }, at))) return;
        const direction = Math.sign(box.scrollTop - grid.lastTop);
        grid.lastTop = box.scrollTop;
        const win = window.VirtualWindow.computeWindow(Object.assign({ overscanAhead: 700, overscanBehind: 350, direction }, at));
        const start = win.start - (win.start % 2);
        const columns = resultCols();
        const rows = [];
        for (let i = start; i < win.end; i++) {
            const page = Math.floor(i / PAGE);
            const got = grid.pages.get(page);
            if (!got) ask(page);
            rows.push(rowEl(columns, got && got[i - page * PAGE]));
        }
        $('queryBody').replaceChildren(...rows);
        const pad = window.VirtualWindow.paddings({ start, end: win.end, totalRows: ui.shown, rowHeight: at.rowHeight });
        spacer($('queryAbove'), pad.top, columns.length);
        spacer($('queryBelow'), pad.bottom, columns.length);
        grid.rendered = { start, end: win.end };
        // Pages far from here are let go
        if (grid.pages.size > 60) {
            const here = Math.floor(start / PAGE);
            Array.from(grid.pages.keys()).sort((a, b) => Math.abs(b - here) - Math.abs(a - here)).slice(0, grid.pages.size - 40).forEach(k => grid.pages.delete(k));
        }
    }

    function rowsArrived(m) {
        if (m.seq !== ui.seq) return;
        const page = Math.floor(m.offset / PAGE);
        grid.asked.delete(page);
        grid.pages.set(page, m.rows);
        ui.shown = m.shown;
        ui.total = m.total;
        if (grid.fresh) {
            // The new table, all at once: headings, widths, rows
            grid.fresh = false;
            if (grid.sorting) { grid.sorting = false; setBusy(''); }
            drawHead();
            // Widths are measured once for a set of columns: sorting or searching never moves them
            if (grid.sizedFor !== columnsKey() || !$('queryTable').classList.contains('is-sized')) sizeColumns(m.rows);
            if (!grid.keep) $('queryTableContainer').scrollTop = 0;
            grid.keep = false;
            grid.rendered = { start: -1, end: -1 };
            if (!m.totals) $('queryFoot').replaceChildren();
        }
        if (m.totals) {
            // A total under each column of numbers, for the rows shown: as many decimals as its values have, two at most
            const tr = el('tr');
            m.totals.forEach((t, i) => {
                const places = (m.places && m.places[i]) || 0;
                tr.appendChild(el('td', 'text-right font-bold', t === null ? (i === 0 ? 'Total' : '') : t.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places })));
            });
            $('queryFoot').replaceChildren(tr);
        }
        // The rows on screen, in Results' tools and in the footer's summary: a search changes both
        ui.shownText = m.shown === m.total ? `${count(m.total)} rows` : `${count(m.shown)} of ${count(m.total)} rows`;
        $('queryShown').textContent = ui.shownText;
        ui.arrived = true;
        renderBar();
        render(true);
    }

    function moved(list, from, to) { list.splice(to, 0, list.splice(from, 1)[0]); return list; }

    /** A column was dragged to a new place (column-drag.js moved its cells): the rows held here and
     * the saved order follow. Nothing is read again: the rows are the same. */
    function columnMoved(from, to) {
        const columns = moved(resultCols().slice(), from, to);
        if (ui.sort) {
            const s = ui.sort.column;
            const gone = s > from ? s - 1 : s;
            ui.sort = { column: s === from ? to : gone >= to ? gone + 1 : gone, dir: ui.sort.dir };
        }
        ui.state.resultColumns = columns;
        ui.state.columns = columns;
        grid.sizedFor = columnsKey();
        grid.pages.forEach(rows => rows.forEach(r => moved(r, from, to)));
        // Pages on their way are in the old order: they are asked for again
        const waiting = grid.asked.size > 0;
        ui.seq++;
        grid.asked.clear();
        post({ type: 'query.moveColumn', from, to });
        if (waiting) render(true);
    }

    /** × on a heading: the column goes at once; the rows follow (Distinct and the search may keep different ones). */
    function hideColumn(i) {
        const columns = resultCols().filter((_, n) => n !== i);
        if (!columns.length) return;
        if (ui.sort) ui.sort = ui.sort.column === i ? null : { column: ui.sort.column - (ui.sort.column > i ? 1 : 0), dir: ui.sort.dir };
        Array.from($('queryTable').rows).forEach(r => { if (r.cells.length === columns.length + 1) r.deleteCell(i); });
        // The other columns keep their widths: the table is narrower by this one
        const col = $('queryCols').children[i];
        if (col) {
            const table = $('queryTable');
            table.style.width = `${Math.max(0, parseFloat(table.style.width) - parseFloat(col.style.width))}px`;
            col.remove();
        }
        grid.pages.forEach(rows => rows.forEach(r => r.splice(i, 1)));
        ui.state.resultColumns = columns;
        grid.sizedFor = columnsKey();
        grid.keep = true;
        // Said once: where a column taken out comes back from
        if (!grid.toldHide && window.DbmnToast) { grid.toldHide = true; window.DbmnToast.info('Column removed. Tick it on the Columns step to bring it back.'); }
        setBusy('Updating…');
        post({ type: 'query.setSelect', select: columns.map(c => ({ view: c.view, column: c.column })) });
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

    function applyState(m) {
        const firstState = !ui.state;
        // The first state with every view's rows read (the one before it lists the views as saved)
        const settled = !m.reading && !ui.settled;
        // A pair still being picked (one column, or none) is the page's own: it stays through a refresh
        const drafts = {};
        if (ui.state) ui.state.joins.forEach(j => { drafts[j.view] = j.on.filter(p => !(p.left.column && p.right.column) && (p.left.column || p.right.column || p.picked)); });
        ui.state = m;
        m.joins.forEach(j => (drafts[j.view] || []).forEach(p => { if (m.views.some(v => v.id === p.left.view)) j.on.push(p); }));
        if (!m.reading) { ui.busy = ''; ui.settled = true; }
        $('queryDistinct').checked = !!m.distinct;
        $('queryDistinct').disabled = !!m.ownSql;
        // Distinct is there only when rows repeat (or it is on): it says how many it folds
        const repeats = m.duplicates || 0;
        $('queryDistinctLabel').classList.toggle('hidden', !repeats && !m.distinct);
        $('queryDistinctText').textContent = !repeats ? 'Distinct' : m.distinct ? `Distinct: ${count(repeats)} repeated ${repeats === 1 ? 'row' : 'rows'} folded` : `Distinct: fold ${count(repeats)} repeated ${repeats === 1 ? 'row' : 'rows'}`;
        if (firstState) {
            // Results as it was left: its search, its sort, its totals
            ui.search = m.search || '';
            ui.sort = m.sort || null;
            ui.totals = !!m.totals;
            $('querySearch').value = ui.search;
            window.SearchMatcher.renderHighlight($('querySearchMirror'), ui.search);
            $('queryTotals').checked = ui.totals;
            if (m.ownSql || m.sqlError) openSql(true);
        }
        if (!m.reading && ui.sort && ui.sort.column >= m.resultColumns.length) ui.sort = null;
        renderTop();
        renderViews();
        renderJoins();
        renderColumns();
        // Run: Results as soon as the views are read, or the step that still needs something.
        // Edit: Views at once
        if (settled && ui.start === 'results') goTo(joinsReady() ? 4 : m.views.length > 1 ? 2 : 1);
        else if (firstState && ui.start !== 'results') goTo(1);
        else if (waitsFor(ui.step)) goTo(m.views.length ? 2 : 1);
        else { renderBar(); updatePeek(); if (ui.step === 4 && !m.reading) loadRows(); }
    }

    window.DbmnActions.register({
        'query:add': () => addView(),
        'query:addFile': () => $('queryAddFile').click(),
        'query:back': () => goTo(ui.step - 1),
        'query:next': () => goTo(ui.step + 1),
        'query:back': () => goTo(ui.step - 1),
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
    $('queryAddFile').addEventListener('change', () => {
        const file = $('queryAddFile').files && $('queryAddFile').files[0];
        $('queryAddFile').value = '';
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
    // `@` lists Results' columns (a name in several views also by letter: d.sku), then the operators
    window.SearchMatcher.attachColumnSuggest({
        input: $('querySearch'),
        headings: () => {
            const columns = resultCols();
            const names = columns.map(c => c.column);
            const lettered = columns.filter(c => names.indexOf(c.column) !== names.lastIndexOf(c.column) && view(c.view))
                .map(c => `${view(c.view).name}.${c.column}`);
            return [...new Set(names), ...lettered];
        }
    });
    $('querySearch').addEventListener('input', () => {
        window.SearchMatcher.renderHighlight($('querySearchMirror'), $('querySearch').value);
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { ui.search = $('querySearch').value; loadRows(); }, 200);
    });
    $('queryTableContainer').addEventListener('scroll', () => {
        if (grid.frame) return;
        grid.frame = requestAnimationFrame(() => { grid.frame = 0; render(false); });
    });
    window.addEventListener('resize', () => render(false));
    // A heading: its arrow sorts, its × takes the column out (its name drags: column-drag.js)
    $('queryHead').addEventListener('click', event => {
        const th = event.target.closest('th');
        if (!th) return;
        if (event.target.closest('.col-hide-btn')) return hideColumn(th.cellIndex);
        if (!event.target.closest('.col-sort-btn')) return;
        const i = th.cellIndex;
        sortBy(!ui.sort || ui.sort.column !== i ? { column: i, dir: 'asc' } : ui.sort.dir === 'asc' ? { column: i, dir: 'desc' } : null);
    });
    $('queryHead').addEventListener('contextmenu', event => {
        const th = event.target.closest('th');
        if (th) headMenu(event, th.cellIndex);
    });
    // The right edge of a heading: drag for the column's width (the columns after it move along), double-click to fit
    window.ColumnHead.attachResize($('queryHead'), {
        canResize: () => $('queryTable').classList.contains('is-sized'),
        widthOf: th => th.getBoundingClientRect().width,
        setWidth: (th, width) => setWidth(th.cellIndex, width),
        done: (th, width) => saveWidth(th.cellIndex, width),
        fit: th => fitColumn(th.cellIndex)
    });
    // A long or structured value opens in full, as in the Console
    $('queryBody').addEventListener('click', event => {
        const td = event.target.closest('td.cell-expandable');
        if (!td || !window.CellDetail || String(window.getSelection())) return;
        const c = resultCols()[td.cellIndex];
        window.CellDetail.open(td.dataset.full || td.textContent, { title: c ? c.column : undefined });
    });
    const drag = window.ColumnDrag.attach({
        table: $('queryTable'),
        scroller: $('queryTableContainer'),
        canDrag: (th, event) => !!event.target.closest('.column-name.is-movable') && !grid.fresh,
        onMove: columnMoved,
        onEnd: () => render(false)
    });

    window.addEventListener('message', event => {
        const m = event.data || {};
        switch (m.type) {
            case 'query.init':
                ui.start = m.empty ? 'edit' : m.start;
                // Run shows Results and nothing else while the query is read; Edit shows Views
                ui.step = ui.start === 'results' ? 4 : 1;
                // (a query with nothing in it yet is new: its steps open one at a time)
                ui.reached = m.empty ? 1 : 4;
                PANELS.forEach((id, i) => $(id).classList.toggle('hidden', i + 1 !== ui.step));
                $('queryResultsControls').classList.toggle('hidden', ui.step !== 4);
                renderBar();
                break;
            case 'query.goTo':
                if (!ui.settled) ui.start = m.start;
                else goTo(m.start === 'results' && joinsReady() ? 4 : m.start === 'results' ? ui.step : 1);
                break;
            case 'query.sourceList': ui.sources = m.results || []; ui.sourceViews = m.views || {}; break;
            case 'query.progress': setBusy(m.total ? `${m.text} · ${count(m.done)} of ${count(m.total)}` : m.text); break;
            case 'query.state': applyState(m); break;
            case 'query.named': if (ui.state) ui.state.name = m.name; renderBar(); break;
            case 'query.fileSheets': setBusy(''); pickSheets(m); break;
            case 'query.rowsData': rowsArrived(m); break;
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
            case 'query.viewRowsData': if (ui.viewRows) ui.viewRows(m); break;
            case 'query.error':
                // A sort that failed leaves the table as it was
                if (grid.sorting) { grid.sorting = false; grid.fresh = false; drawHead(); }
                setBusy('');
                if (window.DbmnToast) window.DbmnToast.error(m.message);
                break;
        }
    });

    renderBar();
    injectIcons(document);
    post({ type: 'query.ready' });
})();

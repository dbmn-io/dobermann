// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The design system page's script (design-system-page.ts): feeds the components on show the
 * way a screen's script would, from made-up data. Nothing here talks to the host.
 */
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /* ── Steps: a wizard to walk through ── */
    const STEPS = [
        { label: 'Views' }, { label: 'Join' }, { label: 'Columns' }, { label: 'Results' }
    ];
    let current = 2;
    let reached = 2;

    function drawWizard() {
        const steps = $('dsSteps');
        const last = current === STEPS.length;
        steps.render(STEPS.map((step, i) => {
            const n = i + 1;
            return {
                status: n === current ? 'current' : n < current ? 'done' : n <= reached || n === current + 1 ? 'available' : 'pending',
                checking: n === current && last && working
            };
        }), current);
        steps.summary = ['3 views', '19 columns', '5,310 rows'];
        // On the last step the results are worked out first; then the steps shrink away behind the summary
        steps.folded = last && !working;
        $('dsBack').disabled = current === 1;
        const next = $('dsNext');
        next.textContent = last ? 'Refresh' : `Next: ${STEPS[current].label}`;
    }
    let working = false;
    let workTimer = 0;
    function go(n) {
        const was = current;
        current = Math.max(1, Math.min(STEPS.length, n));
        reached = Math.max(reached, current);
        clearTimeout(workTimer);
        working = current === STEPS.length && was !== current;
        if (working) workTimer = setTimeout(() => { working = false; drawWizard(); }, 900);
        drawWizard();
    }

    function drawWorking() {
        const working = $('dsWorking');
        // (Run Batch's four steps: Execute is the main button on Review, not a step)
        working.steps = ['Source', 'Map', 'Validate', 'Review'].map(label => ({ label }));
        working.render([
            { status: 'done' }, { status: 'done' }, { status: 'current', checking: true },
            { status: 'blocked', waitsFor: 'Validate' }
        ], 3);
    }

    /* ── Progress: a run to watch ── */
    let runTimer = 0;
    let threads = 8;
    let stopOnError = false;
    function run() {
        const bar = $('dsProgress');
        clearInterval(runTimer);
        const total = 501;
        let tick = 0;
        bar.removeAttribute('tone');
        const draw = () => {
            // Loading first (no estimate yet: the time taken so far), then running (the time left), then done (the time it took)
            const loading = tick < 4;
            const done = loading ? 0 : Math.min(total, (tick - 4) * 46);
            const finished = done >= total;
            const taken = `${tick}s`;
            const left = finished ? '' : `${Math.max(1, Math.ceil((total - done) / 46))}s left`;
            bar.setAttribute('phase', loading ? 'Loading input rows' : finished ? 'Done' : 'Executing');
            bar.setAttribute('count', loading ? `${(tick + 1) * 125} of ${total}` : finished ? String(total) : `${done} of ${total}`);
            bar.setAttribute('note', loading ? taken : finished ? `took ${taken}` : left);
            bar.setAttribute('value', String(loading ? (tick + 1) * 25 : Math.round(done / total * 100)));
            bar.stats = [
                // How it is being run: the two figures people go looking for. Threads can be changed here; a choice over the environment's limit is switched off
                { id: 'threads', label: 'Threads', value: threads, options: [1, 2, 4, 8, 16], max: 8, overTitle: 'This environment allows up to 8' },
                { id: 'stopOnError', label: 'Stop on next error', value: stopOnError, title: 'On: the batch stops at the next request that fails. Off: it carries on and lists the failures' },
                { label: 'Rows per request', value: '100' },
                { label: 'Started', value: '09:15:02' },
                { label: 'Taken', value: taken },
                { label: 'Left', value: loading ? 'Not known yet' : finished ? 'None' : left.replace(' left', '') },
                { label: 'Speed', value: loading || !done ? 'Not known yet' : '46 a second' },
                { label: 'Succeeded', value: String(Math.max(0, done - (done > 200 ? 3 : 0))) },
                { label: 'Failed', value: done > 200 ? '3' : '0' }
            ];
            if (finished) { bar.setAttribute('tone', 'ok'); clearInterval(runTimer); }
            tick += 1;
        };
        draw();
        runTimer = setInterval(draw, 450);
    }

    /* ── Colours: the theme's, under DBMN's names, with what each is for ── */
    const COLOURS = [
        ['editor-background', 'The page'],
        ['foreground', 'Text'],
        ['descriptionForeground', 'Quieter text, hints'],
        ['panel-border', 'Lines and outlines'],
        ['input-background', 'Fields, raised panels'],
        ['input-border', 'A field\'s outline'],
        ['button-background', 'The primary button'],
        ['button-foreground', 'Its text'],
        ['button-secondaryBackground', 'A secondary button'],
        ['textLink-foreground', 'Links, the current step'],
        ['focusBorder', 'Keyboard focus'],
        ['progressBar-background', 'Progress'],
        ['testing-iconPassed', 'Done, success'],
        ['editorWarning-foreground', 'Needs a look'],
        ['errorForeground', 'Failed, cannot be undone'],
        ['editorWidget-background', 'Menus and pop-ups'],
        ['list-hoverBackground', 'A row under the pointer']
    ];
    function drawColours() {
        // (read on the body: two hover colours are set there, and the names follow them)
        const theme = getComputedStyle(document.body);
        $('dsSwatches').replaceChildren(...COLOURS.map(([colour, use]) => {
            const name = `--dbmn-${colour}`;
            const row = el('div', 'ds-swatch');
            const swatch = el('span', 'ds-swatch-colour');
            swatch.style.setProperty('--swatch', `var(${name})`);
            const text = el('span', 'ds-swatch-text');
            const value = theme.getPropertyValue(name).trim();
            const label = el('span', 'ds-swatch-name', name);
            label.title = value ? `${name}: ${value}\nThe theme's --vscode-${colour}` : `${name} (this theme leaves --vscode-${colour} to the fallback)`;
            text.append(label, el('span', 'ds-swatch-use', use + (value ? ` · ${value}` : '')));
            row.append(swatch, text);
            return row;
        }));
    }

    /** The Hub's own theme picker (the palette button in its header), where the host has one. */
    function hubThemeButton() {
        try {
            const button = window.parent !== window && window.parent.document.getElementById('hubThemeBtn');
            return button && !button.hidden ? button : null;
        } catch (e) {
            return null;
        }
    }

    /* ── Icons: the whole list, by name ── */
    function iconButton(name, svg, note) {
        const button = el('button', 'ds-icon');
        button.type = 'button';
        button.dataset.name = name + ' ' + (note || '');
        button.title = `Copy "${name}"`;
        const glyph = el('span', 'ds-icon-glyph');
        glyph.innerHTML = svg;
        const label = el('span', 'ds-icon-name', name);
        if (note) { label.append(' '); label.append(el('small', '', note)); }
        button.append(glyph, label);
        button.addEventListener('click', () => {
            if (window.DbmnClipboard) window.DbmnClipboard.writeText(name).then(() => window.DbmnToast && window.DbmnToast.info(`Copied ${name}`));
        });
        return button;
    }
    function drawIcons() {
        const icons = window.Icons;
        if (!icons) return;
        const roles = icons.ICON_ROLES || {};
        const own = Object.keys(icons.ICONS).filter(name => !(name in roles));
        $('dsIcons').replaceChildren(...own.sort().map(name => iconButton(name, icons.icon(name))));
        $('dsRoles').replaceChildren(...Object.keys(roles).sort().map(role => iconButton(role, icons.roleIcon(role), roles[role])));
        $('dsIconCount').textContent = `${own.length} icons`;
    }
    function findIcons() {
        const words = $('dsIconFind').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        let shown = 0;
        document.querySelectorAll('#dsIcons .ds-icon, #dsRoles .ds-icon').forEach(button => {
            const hit = words.every(word => button.dataset.name.includes(word));
            button.hidden = !hit;
            if (hit && button.parentNode.id === 'dsIcons') shown += 1;
        });
        $('dsIconCount').textContent = `${shown} icons`;
    }

    /* ── The list of pieces: what exists, and where each stands ── */
    const C = 'Component', M = 'Shared module', S = 'Shared styles', R = 'Being replaced', P = 'Planned';
    const PIECES = [
        ['<dbmn-footer>', 'A screen\'s footer: actions left, progress right', C, 'Query, Run Batch, Console, Edit Endpoint, Edit Environment', 'shared/dbmn-footer.js'],
        ['<dbmn-actions>', 'The footer\'s buttons, the main one last', C, 'Query, Run Batch, Console, Edit Endpoint, Edit Environment', 'shared/dbmn-footer.js'],
        ['<dbmn-steps>', 'A wizard\'s steps in one line, and the summary they fold into', C, 'Query, Run Batch', 'shared/dbmn-footer.js'],
        ['<dbmn-progress>', 'The system\'s progress: the box is the bar', C, 'Console', 'shared/dbmn-footer.js'],
        ['<dbmn-status>', 'A few words of status (Saved, Not saved yet)', C, 'Edit Endpoint, Edit Environment', 'shared/dbmn-footer.js'],
        ['DbmnModal', 'Dialogs: a question, a form, an alert', M, 'Every screen', 'shared/dbmn-modal.js'],
        ['Lanes', 'One grid every line shares: a gutter, a lane per view split into its runs, an end column; spreadsheet cells', S, 'Design system; Query next', 'shared/dbmn-lanes.css, shared/dbmn-lanes.js'],
        ['<dbmn-map>', 'Which column in each source is which, a line at a time: key, functions, how many agree', C, 'Design system; Run Batch next', 'shared/dbmn-map.js'],
        ['DbmnFunctions', 'Functions on a column, ticked in order, tried on its values before and after', M, 'Design system; Query and Run Batch next', 'shared/dbmn-functions.js'],
        ['DbmnToast', 'Messages in the corner', M, 'Every screen', 'shared/dbmn-toast.js'],
        ['DbmnContextMenu', 'A right-click menu, or a menu under a button; an item may carry a picture and a quiet second line; a summary of what it is about may come first', M, 'Hub lists, tables; Query\'s join kind and slots', 'shared/dbmn-context-menu.js'],
        ['Join picture', 'Which rows a join keeps: two circles, the kept parts filled; Compare is the scale', M, 'Design system; Query\'s Join next', 'shared/relation-glyph.js (RelationGlyph.join)'],
        ['Icons', 'The one list of icons, and icons by job', M, 'Every screen', 'shared/icons.js'],
        ['DbmnActions', 'Named actions for markup (data-click)', M, 'Every screen', 'shared/dbmn-actions.js'],
        ['HelpMode', 'Help mode: click a control to read about it', M, 'Every screen', 'shared/help-mode.js'],
        ['DbmnClipboard', 'Copy to the clipboard, in every host', M, 'Every screen', 'shared/dbmn-clipboard.js'],
        ['ColumnHead', 'A table heading: sort, remove, resize, its menu', M, 'Query, Console', 'shared/column-head.js'],
        ['ColumnDrag', 'Drag a column to another place', M, 'Query, Console', 'shared/column-drag.js'],
        ['VirtualWindow', 'Draw only the rows in view', M, 'Query, Console', 'shared/virtual-window.js'],
        ['CellDetail', 'A cell\'s whole value, opened from the cell', M, 'Query, Console', 'shared/cell-detail.js'],
        ['SearchMatcher', 'The one search: words, -not, a,b, @column=value, the coloured box and its @ list; @@word in the Hub\'s lists only', M, 'Hub lists, Console, Query (Add a view, Results), <dbmn-table>', 'shared/search-matcher.js, shared/search.css'],
        ['SearchWords', 'The Hub lists\' fields and filter dialogs, over SearchMatcher (@tag=, @system=current, @ran>7d)', M, 'Hub lists', 'shared/search-words.js'],
        ['ThemePicker', 'Choosing a theme', M, 'Hub', 'shared/theme-picker.js'],
        ['SystemPicker', 'Choosing a System', M, 'Endpoint, Environment', 'shared/system-picker.js'],
        ['Buttons', '.btn, .btn-primary, .btn-secondary, .btn-danger', S, 'Every screen', 'shared/buttons.css'],
        ['Toggle button', '.dbmn-toggle: an icon that is on or off (aria-pressed); its name in the hover text', S, 'Query (Results: Totals, hidden characters, Filter), Design system', 'shared/buttons.css'],
        ['<dbmn-name>', 'A report\'s name on its screen, renamed in place', C, 'Query', 'shared/dbmn-name.js'],
        ['Rename dialog', 'Right-click → Rename in the Hub\'s lists: reports, endpoints, environments, runs', M, 'Hub lists', 'hub/hub-tabs.js (askRename)'],
        ['Tabs in a screen', 'A screen\'s own tabs (Environment, Console)', S, 'Environment, Console', 'shared/tabs.css'],

        ['<dbmn-table>', 'A table of rows: search, sort, move, resize, only the rows in view drawn; rows the page holds, or asked for as they scroll; hidden characters shown or not', C, 'Query, Console, Run Batch (Validate), the request card\'s INPUT rows, Design system, <dbmn-log>', 'shared/dbmn-table.js'],
        ['Request card', 'One request: its header, the INPUT rows behind it, Body or Details, and the response. To become one component; built twice today (the Console, Run Batch\'s Review), the INPUT rows already shared', P, 'Console (Raw tab, Raw window), Run Batch (Review)', 'console/modules/raw-tab-handler.js, shared/request-preview.js'],
        ['<dbmn-log>', 'Log lines as a table: the newest in view, followed until you scroll up', C, 'Logs', 'shared/dbmn-log.js'],
        ['<dbmn-level>', 'How serious a log line is: an icon and a word', C, 'Logs, <dbmn-log>', 'shared/dbmn-level.js'],
        ['Rows inside a row', 'A list of records in a cell, opened inside it, with the screen\'s own buttons beside it (part of <dbmn-table>)', C, 'Console, Design system', 'shared/dbmn-table.js'],
        ['The Hub\'s pieces', 'Banner, menu, list, tabs, settings rows', P, '', '']
    ];
    function drawInventory() {
        const chip = state => el('span', 'ds-chip' + (state === C ? ' is-component' : state === R ? ' is-leaving' : state === P ? ' is-planned' : ''), state);
        const table = $('dsInventory');
        table.columns = [
            { id: 'piece', name: 'Piece' },
            { id: 'job', name: 'What it is for' },
            { id: 'state', name: 'State', render: value => chip(value) },
            { id: 'used', name: 'Used by' },
            { id: 'file', name: 'File' }
        ];
        table.rows = PIECES.map(([piece, job, state, used, file]) => ({ piece, job, state, used, file }));
    }

    /* ── Which screen is on which component ── */
    const ON = 'On it', MOVE = 'To move', WAIT = 'Waits';
    const MOVES = [
        ['Query', 'Footer and steps', ON, 'dbmn-footer, dbmn-steps', ''],
        ['Run Batch', 'Footer and steps', ON, 'dbmn-footer, dbmn-steps', ''],
        ['Run Batch', 'Table', ON, 'Validate: dbmn-table editable, amber cells with the reason on hover, the errors filter showing the rows to fix', 'Source\'s file preview draws its own'],
        ['Console', 'Footer and progress', ON, 'dbmn-footer, dbmn-progress (written only through ConsoleProgress)', 'Next: Threads, Stop on next error and Rows per request in the box\'s figures'],
        ['Edit Endpoint', 'Footer and status', ON, 'dbmn-footer, dbmn-status (its More menu kept for buttons that don\'t fit)', ''],
        ['Edit Environment', 'Footer and status', ON, 'dbmn-footer, dbmn-status', ''],
        ['Design system', 'Table', ON, 'dbmn-table', ''],
        ['Logs', 'Footer and log', ON, 'dbmn-footer, dbmn-log', ''],
        ['Lookup table', 'Footer and table', ON, 'dbmn-footer, dbmn-status, dbmn-table editable (add-row, row-delete, edit-columns, a key column)', ''],
        ['Query', 'Table', ON, 'dbmn-table, its rows asked for as they scroll; a compare\'s Status column and its marks in each cell', ''],
        ['Console', 'Table', ON, 'dbmn-table for Completed, Errors and Input: Set as Row beside a list of records, each column moving among its own object\'s', 'Logs, Request and Raw draw their own'],
        ['Hub', 'Banner, menu, list, tabs', WAIT, 'Its own markup and styles', 'Described and split into components as each is next worked on']
    ];
    function drawMoving() {
        const chip = state => el('span', 'ds-chip' + (state === ON ? ' is-component' : state === MOVE ? ' is-leaving' : ' is-planned'), state);
        const table = $('dsMoving');
        table.columns = [
            { id: 'screen', name: 'Screen' },
            { id: 'piece', name: 'Piece' },
            { id: 'state', name: 'State', render: value => chip(value) },
            { id: 'today', name: 'Today' },
            { id: 'next', name: 'To move it' }
        ];
        table.rows = MOVES.map(([screen, piece, state, today, next]) => ({ screen, piece, state, today, next }));
    }

    /* ── Tables: the component over 5,000 made-up rows ── */
    function drawTable() {
        const customers = ['Harbour Foods', 'Kettle and Co', 'Mill Lane Deli', 'Northside Cafe', 'Quay Street Bakery', 'The Corner Larder'];
        const items = [['A-2207', 'Olive oil 1 L'], ['A-3110', 'Sea salt 500 g'], ['B-0418', 'Espresso beans 1 kg'], ['B-0420', 'Decaf beans 1 kg'], ['C-7001', 'Paper cups 250'], ['C-7004', 'Napkins 1000']];
        const statuses = ['Open', 'Open', 'Picked', 'Shipped', 'Open', 'On hold'];
        const rows = [];
        for (let i = 0; i < 5000; i++) {
            const item = items[(i * 7) % items.length];
            const status = statuses[(i * 5) % statuses.length];
            rows.push({
                order_no: `SO-${10412 + Math.floor(i / 2)}`,
                line: (i % 2) + 1,
                customer: customers[(i * 3) % customers.length],
                item: item[0],
                description: item[1],
                qty: 6 + ((i * 11) % 60),
                placed: new Date(Date.now() - (i % 90) * 86400000 - (i % 24) * 3600000).toISOString().slice(0, 16) + 'Z',
                urgent: i % 9 === 0,
                status,
                notes: status === 'On hold' ? { reason: 'Awaiting stock', expected: '2026-11-24', contact: 'purchasing', history: ['raised', 'chased', 'confirmed'] } : ''
            });
        }
        const table = $('dsOrders');
        table.columns = [
            { id: 'order_no', name: 'order_no' }, { id: 'line', name: 'line', numbers: true }, { id: 'customer', name: 'customer' },
            { id: 'item', name: 'item' }, { id: 'description', name: 'description' }, { id: 'qty', name: 'qty', numbers: true },
            { id: 'placed', name: 'placed' }, { id: 'urgent', name: 'urgent' }, { id: 'status', name: 'status' }, { id: 'notes', name: 'notes' }
        ];
        table.rows = rows;
    }

    /* ── Logs: the component over made-up lines, with more on request ── */
    const LOG_SAYS = [
        ['info', 'sign-in', 'Signed in', ''],
        ['debug', 'catalogue', 'Catalogue read: 42 endpoints, 3 environments', ''],
        ['info', 'batch', 'Batch started: 501 rows, 8 threads', ''],
        ['warn', 'batch', 'Row 212 answered slowly (4.1s)', ''],
        ['error', 'request', 'POST /orders answered 500', 'HTTP 500 Internal Server Error\n{ "message": "Order line 2: item C-7004 is not known" }\nRow 213 of 501'],
        ['info', 'batch', 'Batch finished: 498 succeeded, 3 failed', '']
    ];
    let logSeq = 0;
    function logLines(count, from) {
        const lines = [];
        for (let i = 0; i < count; i++) {
            const [level, source, message, detail] = LOG_SAYS[logSeq % LOG_SAYS.length];
            const inBatch = source === 'batch' || source === 'request';
            lines.push({
                key: `line-${++logSeq}`, time: from + i * 730, level, source, message, detail: detail || undefined,
                environment: inBatch ? 'Test' : '', run: inBatch ? { id: 'run-0412', name: 'Open orders' } : undefined
            });
        }
        return lines;
    }
    function drawLog() {
        const log = $('dsLog');
        if (!log || !window.DbmnLog) return;
        log.addEventListener('dbmn-log-shown', event => {
            const d = event.detail;
            const lines = d.shown === d.total ? `${d.total} lines` : `${d.shown} of ${d.total} lines`;
            $('dsLogNote').textContent = d.following ? `${lines} · following the newest` : `${lines} · not following${d.unseen ? ` · ${d.unseen} new` : ''}`;
        });
        log.lines = logLines(60, Date.now() - 60 * 730);
    }

    /* ── Tables: a list of records in a cell, opened inside it ── */
    function drawNested() {
        const table = $('dsNested');
        if (!table) return;
        const customers = ['Harbour Foods', 'Kettle and Co', 'Mill Lane Deli', 'Northside Cafe'];
        const items = [['A-2207', 'Olive oil 1 L'], ['A-3110', 'Sea salt 500 g'], ['B-0418', 'Espresso beans 1 kg'], ['C-7001', 'Paper cups 250'], ['C-7004', 'Napkins 1000']];
        const rows = [];
        for (let i = 0; i < 400; i++) {
            // (one order has more lines than are shown at once)
            const lineCount = i === 2 ? 140 : 1 + (i * 3) % 5;
            const lines = [];
            for (let n = 0; n < lineCount; n++) {
                const item = items[(i + n * 2) % items.length];
                lines.push({ line: n + 1, item: item[0], description: item[1], qty: 6 + ((i + n) * 11) % 60, picked: (i + n) % 3 !== 0 });
            }
            const packages = [];
            for (let n = 0; n < (i % 4 === 3 ? 0 : 1 + (i % 3)); n++) packages.push({ package: `PK-${5000 + i * 3 + n}`, kind: n % 2 ? 'Pallet' : 'Carton', weight_kg: 4 + ((i + n) * 7) % 30 });
            rows.push({ order_no: `SO-${10412 + i}`, customer: customers[(i * 3) % customers.length], lines, packages });
        }
        table.rowKey = row => row.order_no;
        table.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'customer', name: 'customer' }, { id: 'lines', name: 'lines' }, { id: 'packages', name: 'packages' }];
        table.rows = rows;
    }

    /* ── Tables: rows that stay with the screen (a made-up one, which answers a moment later) ── */
    function drawPaged() {
        const table = $('dsPaged');
        if (!table) return;
        const customers = ['Harbour Foods', 'Kettle and Co', 'Mill Lane Deli', 'Northside Cafe', 'Quay Street Bakery', 'The Corner Larder'];
        const TOTAL = 100000;
        const row = i => ({ order_no: `SO-${200000 + i}`, customer: customers[(i * 5) % customers.length], qty: 1 + ((i * 13) % 97), urgent: i % 7 === 0, placed: `2026-${String(1 + (i % 11)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` });
        // (what a controller would do with a database: here, sums in place of rows)
        const answer = (start, count, asked) => {
            const word = (asked.search || '').toLowerCase();
            let picks = null;
            if (word) { picks = []; for (let i = 0; i < TOTAL; i++) { if (row(i).customer.toLowerCase().includes(word)) picks.push(i); } }
            const total = picks ? picks.length : TOTAL;
            const at = n => {
                const k = asked.sort && asked.sort.dir === 'desc' ? total - 1 - n : n;
                return row(picks ? picks[k] : k);
            };
            const rows = [];
            for (let n = start; n < Math.min(total, start + count); n++) rows.push(at(n));
            return { rows, total };
        };
        // (no `numbers` given: qty and urgent sort as numbers because their values are numbers, and true or false)
        table.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'customer', name: 'customer' }, { id: 'qty', name: 'qty' }, { id: 'urgent', name: 'urgent' }, { id: 'placed', name: 'placed' }];
        table.searchWith($('dsPagedFind'));
        let asks = 0;
        let shown = '';
        const note = () => { $('dsPagedNote').textContent = `${shown} · asked for ${asks} page${asks === 1 ? '' : 's'} so far`; };
        table.addEventListener('dbmn-table-shown', event => { shown = event.detail.text; note(); });
        table.addEventListener('dbmn-table-layout', event => { if (window.DbmnToast) window.DbmnToast.info(`Told the screen: ${event.detail.change}`); });
        table.source = {
            page: (start, count, asked) => new Promise(done => {
                asks += 1;
                setTimeout(() => { done(answer(start, count, asked)); note(); }, 350);
            })
        };
    }

    /* ── Tables: hidden characters (specialCharacters), over values that differ only in what can't be seen ── */
    function drawSpecial() {
        const table = $('dsSpecial');
        if (!table) return;
        table.style.setProperty('--table-height', '160px');
        table.columns = [{ id: 'code', name: 'code' }, { id: 'name', name: 'name' }, { id: 'city', name: 'city' }, { id: 'note', name: 'note' }];
        table.rows = [
            { code: 'C-1001', name: 'Harbour Foods', city: 'Sydney', note: 'Same in both' },
            { code: 'C-1001 ', name: 'Harbour  Foods', city: 'Sydney', note: 'A space after the code, two in the name' },
            { code: 'C-1002', name: 'Kettle\u00a0and Co', city: '\tMelbourne', note: 'A non-breaking space; a tab first' },
            { code: 'C-1003', name: 'Mill\u200bLane Deli', city: '', note: 'A zero-width space; the city empty text' },
            { code: 'C-1004', name: 'Quay Street', city: null, note: 'The city missing' }
        ];
        const on = $('dsSpecialOn');
        const pressed = () => on.getAttribute('aria-pressed') === 'true';
        table.specialCharacters = pressed();
        on.addEventListener('click', () => {
            on.setAttribute('aria-pressed', pressed() ? 'false' : 'true');
            table.specialCharacters = pressed();
        });
    }

    /* ── Buttons: toggle buttons (.dbmn-toggle); the page holds the state and sets aria-pressed ── */
    function drawToggles() {
        const flip = button => button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        ['dsToggleTotals', 'dsToggleHidden'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => flip(b)); });
        const filter = $('dsToggleFilter');
        const again = $('dsToggleRefilter');
        if (!filter || !again) return;
        // On while a filter is applied; a click clears them all and leaves it off and inert
        const filtered = on => {
            filter.setAttribute('aria-pressed', on ? 'true' : 'false');
            filter.disabled = !on;
            filter.title = on ? 'Filters are on: click to clear them all' : 'No filters on';
            again.hidden = on;
        };
        filter.addEventListener('click', () => filtered(false));
        again.addEventListener('click', () => filtered(true));
    }

    /* ── Tables: editing (editable), over a few made-up rows of stock to load ── */
    function drawEdit() {
        const table = $('dsEdit');
        if (!table) return;
        table.style.setProperty('--table-height', '220px');
        table.columns = [{ id: 'sku', name: 'sku', editable: false }, { id: 'description', name: 'description' }, { id: 'qty', name: 'qty', numbers: true }, { id: 'uom', name: 'uom' }];
        const items = [['A-2207', 'Olive oil 1 L'], ['A-3110', 'Sea salt 500 g'], ['B-0418', 'Espresso beans 1 kg'], ['C-7001', 'Paper cups 250'], ['C-7004', 'Napkins 1000']];
        table.rows = Array.from({ length: 40 }, (_, i) => ({ sku: `${items[i % 5][0]}-${String(i + 1).padStart(2, '0')}`, description: items[i % 5][1], qty: 6 + (i * 7) % 50, uom: i % 3 ? 'EA' : 'CS' }));
        // (as a screen would: a quantity below zero is refused, and said why)
        table.addEventListener('dbmn-table-edit', e => {
            if (e.detail.changes.some(c => c.id === 'qty' && Number(c.value) < 0)) { e.preventDefault(); $('dsEditSaid').textContent = 'Refused: a quantity can\'t be below zero.'; return; }
            const n = e.detail.changes.length;
            $('dsEditSaid').textContent = `${e.detail.kind}: ${n} cell${n === 1 ? '' : 's'}${e.detail.left ? `, ${e.detail.left} with nowhere to go` : ''}`;
        });
    }

    /* ── A table people keep: a made-up lookup table of regions, with a key ── */
    function drawLookup() {
        const table = $('dsLookup');
        if (!table) return;
        table.style.setProperty('--table-height', '200px');
        table.columns = [{ id: 'code', name: 'code', key: true }, { id: 'name', name: 'name' }, { id: 'region', name: 'region' }];
        table.rows = [
            { code: 'VIC', name: 'Victoria', region: 'South' }, { code: 'NSW', name: 'New South Wales', region: 'East' },
            { code: 'VIC', name: 'Tasmania', region: 'South' }, { code: 'QLD', name: 'Queensland', region: 'North' }
        ];
        // (as a screen would: what stops it being kept, said under it)
        const say = () => {
            const problems = table.keyProblems;
            const rows = new Set(problems.map(p => p.row)).size;
            $('dsLookupSaid').textContent = problems.length ? `${rows} row${rows === 1 ? '' : 's'} to fix before it can be kept: a key is in one row only, and every row needs one.` : `${table.rows.length} rows, ready to keep.`;
        };
        ['dbmn-table-edit', 'dbmn-table-rows', 'dbmn-table-columns'].forEach(type => table.addEventListener(type, () => setTimeout(say, 0)));
        say();
    }

    /* ── Lining columns up (<dbmn-map>): three made-up results, kept here as the screen would keep them ── */
    function drawMap() {
        const map = $('dsMap');
        if (!map) return;
        const cols = names => names.map(n => ({ id: n, name: n }));
        const sources = [
            { id: 'bl', name: 'BL · GET /items/stock · PROD', short: 'BL', tone: 'compare-r0', columns: cols(['sku', 'warehouse', 'onHand', 'uom', 'updated']) },
            { id: 'c1', name: 'C1 · GET /inventory · UAT', short: 'C1', tone: 'compare-r1', columns: cols(['itemCode', 'warehouseCode', 'qtyOnHand', 'unit', 'lastChange']) },
            { id: 'c2', name: 'C2 · stock-count.xlsx', short: 'C2', tone: 'compare-r2', columns: cols(['SKU', 'Site', 'Counted', 'Notes']) }
        ];
        const examples = { sku: 'A-2207', itemCode: 'a-2207 ', SKU: 'A-2207', warehouse: 'SYD1', warehouseCode: '01', Site: 'Sydney', onHand: 48, qtyOnHand: 48, Counted: 47, uom: 'EA', unit: 'EA', updated: '2026-11-19', lastChange: '2026-11-18' };
        const agree = { qtyOnHand: 0.97, Counted: 0.82, unit: 1, lastChange: 0.12 };
        let n = 0;
        const line = (mode, picks, fns) => ({ id: `l${++n}`, mode, cells: Object.fromEntries(Object.entries(picks).map(([s, c]) => [s, { column: c, example: c ? examples[c] : undefined, agree: agree[c], fns: (fns && fns[s]) || [] }])) });
        let lines = [
            line('key', { bl: 'sku', c1: 'itemCode', c2: 'SKU' }, { c1: [{ id: 'trim', label: 'Trim spaces' }, { id: 'upper', label: 'Upper case' }] }),
            line('strict', { bl: 'onHand', c1: 'qtyOnHand', c2: 'Counted' }),
            line('relaxed', { bl: 'uom', c1: 'unit', c2: null }),
            line('strict', { bl: 'updated', c1: 'lastChange', c2: null }, { c1: [{ id: 'translate', label: 'Lookup: Dates', missing: true }] })
        ];
        map.modes = [
            { id: 'key', label: 'Key', title: 'Part of what says which rows are the same record' },
            { id: 'strict', label: 'Strict', title: 'Compared exactly' },
            { id: 'relaxed', label: 'Relaxed', title: 'Compared ignoring capitals, spaces and number formats' },
            { id: 'skip', label: "Don't compare", title: 'Shown, not compared' }
        ];
        map.keyMode = 'key';
        map.sources = sources;
        const redraw = () => {
            map.lines = lines;
            map.matched = { bl: { text: '1,198 rows in BL', tone: '' }, c1: { text: '1,180 of 1,201 match BL', tone: 'ok' }, c2: { text: '298 of 312 match BL', tone: 'warn' } };
        };
        const find = id => lines.find(l => l.id === id);
        map.addEventListener('dbmn-map-mode', e => { find(e.detail.line).mode = e.detail.mode; redraw(); });
        map.addEventListener('dbmn-map-remove', e => { lines = lines.filter(l => l.id !== e.detail.line); redraw(); });
        map.addEventListener('dbmn-map-pick', e => {
            const c = find(e.detail.line).cells;
            c[e.detail.source] = { column: e.detail.column, example: e.detail.column ? examples[e.detail.column] : undefined, agree: agree[e.detail.column], fns: [] };
            redraw();
        });
        map.addEventListener('dbmn-map-add', () => { lines.splice(lines.filter(l => l.mode === 'key').length, 0, line('key', { bl: null, c1: null, c2: null })); redraw(); });
        map.addEventListener('dbmn-map-leftover', e => { lines.push(line('strict', { [e.detail.source]: e.detail.column })); redraw(); });
        map.addEventListener('dbmn-map-fn', e => { if (window.DbmnToast) window.DbmnToast.info(`ƒ on ${find(e.detail.line).cells[e.detail.source].column}: the screen opens Functions on a column`); });
        redraw();
    }

    /* ── Dialogs: functions on a column (DbmnFunctions), over a made-up column ── */
    async function openFunctionsDemo() {
        // A made-up column: C1's codes, written with leading zeros and spaces that BL's are not
        const before = [' 000412', '000413 ', '000414', '  000415', '000416'];
        const base = ['412', '413', '414', '415', '417'];
        const fns = {
            trim: v => v.trim(),
            upper: v => v.toUpperCase(),
            ltrimZeros: v => v.replace(/^0+/, ''),
            first: (v, p) => v.slice(0, p.n),
            replace: (v, p) => v.split(p.from || '').join(p.to || '')
        };
        const applied = await window.DbmnFunctions.open({
            column: 'C1.sku',
            functions: [
                { id: 'trim', label: 'Trim spaces', sql: ['TRIM(', 'x', ')'] },
                { id: 'upper', label: 'Upper case', sql: ['UPPER(', 'x', ')'] },
                { id: 'ltrimZeros', label: 'Drop leading zeros', sql: ['LTRIM(', 'x', ", '0')"] },
                { id: 'first', label: 'First characters', sql: ['SUBSTR(', 'x', ', 1, ', { key: 'n', number: true, label: 'How many characters' }, ')'] },
                { id: 'replace', label: 'Replace text', sql: ['REPLACE(', 'x', ", '", { key: 'from', label: 'Text to replace' }, "', '", { key: 'to', label: 'Replace it with' }, "')"] },
                { id: 'translate', label: 'Translate values', sql: ['TRANSLATE(', 'x', ', ', { key: 'table', label: 'Lookup table', kind: 'lookup', options: LOOKUP_OPTIONS }, ')'] }
            ],
            defaults: { n: 4, from: '-', to: '' },
            asLabel: 'Compares as',
            baseLabel: 'BL',
            sample: applied => new Promise(done => setTimeout(() => {
                // Translate values ticked: the whole table, the row with this record's value lit
                const lookup = applied.find(x => x.id === 'translate');
                const table = lookup && LOOKUP_ROWS[lookup.params.table];
                if (table) { done({ table: { columns: LOOKUP_OPTIONS.find(t => t.id === lookup.params.table).columns, rows: table }, value: lookup.params.table === 'uom' ? 'CS' : 'MEL' }); return; }
                const after = before.map(v => applied.reduce((value, a) => (fns[a.id] ? fns[a.id](value, a.params) : value), v));
                done({ rows: before.map((v, i) => ({ before: v, after: after[i], base: base[i] })), agree: after.filter((v, i) => v === base[i]).length / base.length });
            }, 120)),
            onOpenLookup: id => window.DbmnToast && window.DbmnToast.info(`Would open the lookup table "${id}" in Reporting`)
        });
        $('dsFunctionsSaid').textContent = applied ? `Applied: ${applied.map(a => a.id).join(', ') || 'none'}` : 'Cancelled';
    }

    /* Made-up lookup tables for the Functions demo: several columns, a value looked up in one, becoming another's */
    const LOOKUP_OPTIONS = [
        { id: 'uom', name: 'Units of measure', count: 4, columns: [{ id: 'erp', name: 'ERP unit' }, { id: 'wms', name: 'WMS unit' }, { id: 'fin', name: 'Finance unit' }] },
        { id: 'sites', name: 'Site codes', count: 3, columns: [{ id: 'code', name: 'code' }, { id: 'site', name: 'site' }] }
    ];
    const LOOKUP_ROWS = {
        uom: [{ erp: 'EA', wms: 'EACH', fin: 'UNIT' }, { erp: 'CS', wms: 'CASE', fin: 'BOX12' }, { erp: 'PL', wms: 'PALLET', fin: 'PLT' }, { erp: 'KG', wms: 'KILO', fin: 'KG' }],
        sites: [{ code: 'SYD', site: 'Sydney DC' }, { code: 'MEL', site: 'Melbourne DC' }, { code: 'BNE', site: 'Brisbane DC' }]
    };

    /* ── Which rows a join keeps: the five pictures, and the menu Query's Join opens from its button ── */
    const JOIN_KINDS = [
        ['compare', 'Compare', 'Match the views on the key and compare their values'],
        ['inner', 'Join', 'Only rows Stock and Counts both have'],
        ['left', 'Left join', 'All of Stock; Counts where it matches'],
        ['right', 'Right join', 'All of Counts; Stock where it matches'],
        ['outer', 'Outer join', 'Every row of both, matched where they can be']
    ];
    let joinKind = 'left';
    function drawJoinButton() {
        const kind = JOIN_KINDS.find(k => k[0] === joinKind);
        const caret = el('span', 'ds-join-caret', '\u25BE');
        $('dsJoinBtn').replaceChildren(window.RelationGlyph.join(joinKind), caret);
        $('dsJoinBtn').setAttribute('aria-label', `How Counts joins Stock: ${kind[1]}`);
        $('dsJoinBtn').title = `${kind[1]}: ${kind[2]}`;
    }
    /** The kinds, from the button: the menu under it, each kind's picture, name and what it keeps. */
    function openJoinMenu() {
        const items = JOIN_KINDS.map(([id, label, detail]) => ({ id, label, detail, glyph: window.RelationGlyph.join(id), checked: id === joinKind }));
        window.DbmnContextMenu.show($('dsJoinBtn'), items, id => { joinKind = id; drawJoinButton(); });
    }
    function drawJoins() {
        if (!window.RelationGlyph || !window.RelationGlyph.join) return;
        $('dsJoins').replaceChildren(...JOIN_KINDS.map(([id, label]) => {
            const item = el('span', 'ds-join');
            item.append(window.RelationGlyph.join(id), el('span', 'ds-join-name', label));
            return item;
        }));
        drawJoinButton();
    }

    /* ── Lanes: the mock-up's cases on the one grid (made up: a stock check over four runs, and with Counts and a file) ── */
    const lanesUi = { mode: 'head' };
    const div = (cls, text, title) => { const d = el('div', cls, text); if (title || text) d.title = title || text; return d; };
    const cell = (run, value, more) => {
        const b = el('button', `dbmn-cell dbmn-run-${run}${more && more.cls ? ' ' + more.cls : ''}`);
        b.type = 'button';
        b.title = (more && more.title) || value;
        b.append(el('span', 'dbmn-cell-value', value));
        if (more && more.fx) { const f = el('span', 'dbmn-cell-fx ds-lane-fx' + (more.fx === 'quiet' ? ' is-quiet' : ''), 'ƒ'); b.append(f); }
        return b;
    };
    const lane = (view, runs, cells, extra) => {
        const l = el('div', `dbmn-lane dbmn-view-${view} dbmn-runs-${runs}${extra ? ' ' + extra : ''}`);
        l.append(...cells);
        return l;
    };
    const row = (gutter, lanes, end, nameCls) => {
        const r = el('div', 'dbmn-lanes-row');
        r.append(div('dbmn-lanes-gutter' + (nameCls ? ' is-name' : ''), gutter), ...lanes, div('dbmn-lanes-end', end || ''));
        return r;
    };
    const RUNS = [['BL', 'PROD · 20 Nov 09:12'], ['C1', 'PROD · 21 Nov 09:10'], ['C2', 'UAT · 21 Nov 09:30'], ['C3', 'UAT · 21 Nov 14:02']];
    /** The slots: one heading over a view's runs (with a chip each), or a slot per run. */
    function slotLane(view, name, runs) {
        if (runs.length > 1 && lanesUi.mode === 'head') {
            return lane(view, runs.length, [div('dbmn-lane-head ds-lane-slot', name), ...runs.map(([id, when], i) => {
                const chip = div(`dbmn-lane-run dbmn-run-${i} ds-lane-chip`, '', `${id} · ${when}`);
                chip.append(el('b', '', id), document.createTextNode(' ' + when));
                return chip;
            })]);
        }
        return lane(view, runs.length, runs.map(([id, when], i) => {
            const slot = div(`dbmn-lane-run dbmn-run-${i} ds-lane-slot`, '', `${id} · ${name} · ${when}`);
            slot.append(el('b', '', runs.length > 1 ? `${id} ` : ''), document.createTextNode(name));
            return slot;
        }));
    }
    function drawLanes() {
        if (!window.DbmnLanes) return;
        $('dsLanesHead').setAttribute('aria-pressed', String(lanesUi.mode === 'head'));
        $('dsLanesSlots').setAttribute('aria-pressed', String(lanesUi.mode === 'slots'));
        // Four runs of one view
        const one = $('dsLanes');
        window.DbmnLanes.apply(one, [{ runs: 4 }]);
        one.replaceChildren(
            row('Stock check', [slotLane(0, 'inventory · GET /inventory', RUNS)], '+ Add', true),
            row('Key', [lane(0, 4, [cell(0, 'gtin', { fx: 'quiet' }), cell(1, 'gtin, the same'), cell(2, 'gtin, the same'), cell(3, 'gtin, the same')], 'dbmn-cells')], '+ AND  ×'),
            row('available', [lane(0, 4, [cell(0, '48', { fx: true }), cell(1, '48'), cell(2, '46', { cls: 'is-diff', title: '46: not the same as BL\'s 48' }), cell(3, '48')], 'dbmn-cells')], '×'),
            row('location', [lane(0, 4, [cell(0, 'DC-WEST-01'), cell(1, 'DC-WEST-01'), cell(2, '', { cls: 'is-blank', title: 'Blank' }), cell(3, 'DC-WEST-02', { cls: 'is-diff' })], 'dbmn-cells')], '×'),
            row('', [lane(0, 4, [cell(0, 'Add a column', { cls: 'is-empty' }), cell(1, '', { cls: 'is-add', title: 'Add a column here' }), cell(2, '', { cls: 'is-add', title: 'Add a column here' }), cell(3, '', { cls: 'is-add', title: 'Add a column here' })], 'dbmn-cells')], ''),
            (() => { const r = el('div', 'dbmn-lanes-row'); r.append(div('dbmn-lanes-gutter', 'After this join'), div('dbmn-lanes-span ds-lane-says', '4 of 4 in the compare · C1 1,198 · C2 1,199 · C3 1,150 one to one'), div('dbmn-lanes-end', '')); return r; })()
        );
        // Runs, another endpoint and a file
        const mixed = $('dsLanesMixed');
        window.DbmnLanes.apply(mixed, [{ runs: 2 }, { runs: 1 }, { runs: 1 }]);
        mixed.replaceChildren(
            row('Stock and counts', [slotLane(0, 'inventory · GET /inventory', RUNS.slice(0, 2)), slotLane(1, 'counts · GET /cycle-counts', [['', 'UAT · 21 Nov']]), slotLane(2, 'Prices.csv', [['', 'file']])], '+ Add', true),
            row('Key', [lane(0, 2, [cell(0, 'gtin', { fx: 'quiet' }), cell(1, 'gtin, the same')], 'dbmn-cells'), lane(1, 1, [cell(0, 'item_code', { fx: 'quiet' })], 'dbmn-cells'), lane(2, 1, [cell(0, 'Not compared', { cls: 'is-empty' })], 'dbmn-cells')], '+ AND  ×'),
            row('counted', [lane(0, 2, [cell(0, '', { cls: 'is-blank' }), cell(1, '', { cls: 'is-blank' })], 'dbmn-cells'), lane(1, 1, [cell(0, '47', { cls: 'is-picked' })], 'dbmn-cells'), lane(2, 1, [cell(0, '', { cls: 'is-dim' })], 'dbmn-cells')], '×'),
            row('margin', [lane(0, 2, [cell(0, 'price − cost', { cls: 'is-calc', fx: true }), cell(1, '', { cls: 'is-blank' })], 'dbmn-cells'), lane(1, 1, []), lane(2, 1, [])], '×')
        );
    }

    /* ── Figures from the first records: a join counted on a sample, then on all (after Results) ── */
    let sampleMode = 'sample';
    function drawSampled() {
        const box = $('dsLanesSampled');
        if (!window.DbmnLanes || !box) return;
        ['sample', 'all', 'warn'].forEach(m => $({ sample: 'dsLanesSample', all: 'dsLanesAll', warn: 'dsLanesWarn' }[m]).setAttribute('aria-pressed', String(m === sampleMode)));
        const sampled = sampleMode !== 'all';
        // (sample, all): BL, C1, C2, C3 of inventory; counts, a view of 640 records has no sample
        const figures = sampleMode === 'warn'
            ? [[1000, 1000], [12, 3104], [998, 418200], [997, 418100]]
            : [[1000, 418720], [990, 412904], [998, 418200], [997, 418100]];
        const counts = [640, 640];
        window.DbmnLanes.apply(box, [{ runs: 4 }, { runs: 1 }]);
        const fig = (run, [part, all], of) => {
            const d = div(`dbmn-lane-run dbmn-run-${run}${sampled ? ' is-sample' : ''}`, (sampled ? part : all).toLocaleString());
            d.title = sampled ? `${part.toLocaleString()} of the first 1,000 records${of ? ' ' + of : ''}` : `${all.toLocaleString()} records`;
            return d;
        };
        const whole = n => { const d = div('dbmn-lane-run dbmn-run-0', n.toLocaleString()); d.title = `${n.toLocaleString()} records: all of them`; return d; };
        const gutter = div(`dbmn-lanes-gutter${sampled ? ' is-sample' : ''}`, sampled ? 'In the first 1,000 records' : 'All 418,720 records');
        if (sampled) gutter.title = 'Counted on the first 1,000 records, so the Join step stays quick. Results counts them all';
        const found = el('div', 'dbmn-lanes-row');
        found.append(gutter, lane(0, 4, figures.map((f, i) => fig(i, f, i ? 'found in BL' : ''))), lane(1, 1, [whole(counts[0])]), div('dbmn-lanes-end', ''));
        const status = document.createElement('dbmn-status');
        status.setAttribute('inline', '');
        status.setAttribute('tone', sampleMode === 'warn' ? 'warn' : 'ok');
        status.textContent = sampleMode === 'warn'
            ? 'Only 12 of the first 1,000 keys of inventory are in C1: check the key.'
            : sampled
                ? 'In the first 1,000 records of inventory: 990 found in every run, none repeated. Looks like a safe compare. The full counts come with Results.'
                : '✓ 412,904 of 418,720 records are in every run, none repeated.';
        const says = el('div', 'dbmn-lanes-row');
        const span = el('div', 'dbmn-lanes-span');
        span.append(status);
        says.append(div('dbmn-lanes-gutter', ''), span, div('dbmn-lanes-end', ''));
        box.replaceChildren(row('Stock and counts', [slotLane(0, 'inventory · GET /inventory', RUNS), slotLane(1, 'counts · GET /cycle-counts', [['', 'UAT · 21 Nov']])], '', true), found, says);
    }

    /* ── A working line in a page: its states ── */
    const WORKING = {
        running: { phase: 'Comparing the records', count: '420,000 records', value: '29', note: 'About 40 s left', stop: '' },
        unknown: { phase: 'Comparing the records', busy: '', since: String(Date.now() - 7000), stop: '' },
        large: { phase: 'A large compare: 4 views, 420,000 records', note: 'About 40 s', tone: 'warn', busy: '', stop: '' },
        refused: { phase: 'Too large to compare here: 4 views of 2.1 million records would need more memory than this window has. Leave a view out, or search to fewer records.', tone: 'error' },
        stopped: { phase: 'Stopped', count: '120,000 of 420,000 records compared', again: 'Compare again' }
    };
    function workingLine(state) {
        const line = $('dsWorkingLine');
        const want = WORKING[state] || WORKING.running;
        ['phase', 'count', 'value', 'note', 'tone', 'busy', 'since', 'stop', 'again'].forEach(a => {
            if (a in want) line.setAttribute(a, a === 'since' && state === 'unknown' ? String(Date.now() - 7000) : want[a]);
            else line.removeAttribute(a);
        });
        document.querySelectorAll('#dsWorkingLineStates button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.arg === state)));
    }
    $('dsWorkingLine').addEventListener('dbmn-progress-stop', () => workingLine('stopped'));
    $('dsWorkingLine').addEventListener('dbmn-progress-again', () => workingLine('running'));

    window.DbmnActions.register({
        'ds:workingLine': workingLine,
        'ds:lanesSample': mode => { sampleMode = mode; drawSampled(); },
        'ds:lanes': mode => { lanesUi.mode = mode === 'slots' ? 'slots' : 'head'; drawLanes(); },
        'ds:log': () => $('dsLog').append(logLines(5, Date.now())),
        'ds:back': () => go(current - 1),
        'ds:next': () => { if (current < STEPS.length) go(current + 1); },
        'ds:run': run,
        'ds:theme': () => { const button = hubThemeButton(); if (button) button.click(); },
        'ds:functions': openFunctionsDemo,
        'ds:confirm': () => {
            window.DbmnModal.confirm({ title: 'Delete the query?', body: 'Only the report is deleted: the data in History stays.', confirmLabel: 'Delete', confirmVariant: 'danger' })
                .then(yes => window.DbmnToast.info(yes ? 'You chose Delete' : 'Nothing was deleted'));
        },
        'ds:alert': () => {
            window.DbmnModal.alert({ title: 'The file was not read', body: 'It has no heading row. Add one and pick the file again.' });
        },
        'ds:choice': () => {
            window.DbmnModal.show({
                title: 'Add a view',
                fields: [
                    { id: 'result', type: 'select', label: 'Result', options: [{ value: 'a', label: 'Get orders · today 09:39', group: 'This week' }, { value: 'b', label: 'Get items · 12 Nov', group: 'Older' }] },
                    { id: 'note', type: 'textarea', label: 'Note', placeholder: 'Optional' }
                ],
                actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'add', label: 'Add', variant: 'primary' }]
            }).then(result => { if (result.actionId === 'add') window.DbmnToast.success('View added'); });
        },
        'ds:form': () => {
            window.DbmnModal.show({
                title: 'Name the query',
                fields: [{ id: 'name', type: 'text', label: 'Name', value: 'Open orders by item', required: true }],
                actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'save', label: 'Save', variant: 'primary' }]
            }).then(result => { if (result.actionId === 'save') window.DbmnToast.success(`Saved as ${result.fields.name}`); });
        },
        'ds:toast': level => {
            const says = { info: 'Copied 12 rows', success: 'Saved', warn: 'Some rows were skipped', error: 'Could not reach the server' };
            window.DbmnToast.show(level, says[level] || 'Hello');
        },
        'ds:joinMenu': openJoinMenu,
        'ds:menu': (arg, event) => {
            window.DbmnContextMenu.show(event, [
                { id: 'rename', label: 'Rename', icon: 'pencil' },
                { id: 'copy', label: 'Duplicate', icon: 'copy' },
                { separator: true },
                { id: 'delete', label: 'Delete', icon: 'trash-2', danger: true }
            ], id => window.DbmnToast.info(`You chose ${id}`));
        },
        // (what the menu is about first, read only, then its actions: a Query slot's click)
        'ds:summaryMenu': (arg, event) => {
            const read = ['Read', '13 Nov, 09:18 · 9 days ago'];
            read.tone = 'warn';
            window.DbmnContextMenu.show(event.target.closest('button') || event, [
                { summary: { title: 'BL · inventory', lines: [['Request', 'GET /inventory'], ['View', 'LowStock'], ['Result', 'DBMN Local'], read, ['Rows', '105,010']] } },
                { separator: true },
                { id: 'refresh', label: 'Read again', icon: 'refresh-cw' },
                { id: 'remove', label: 'Remove', icon: 'trash-2', danger: true }
            ], id => window.DbmnToast.info(`You chose ${id}`));
        },
    });

    drawJoins();
    $('dsSteps').steps = STEPS.map(step => ({ label: step.label }));
    $('dsSteps').addEventListener('dbmn-step', event => go(event.detail.step));
    drawWizard();
    drawWorking();
    // (a screen's controller would check the change against the environment's limit; here it is taken as asked)
    $('dsProgress').addEventListener('dbmn-progress-change', event => {
        if (event.detail.id === 'threads') threads = event.detail.value;
        else if (event.detail.id === 'stopOnError') stopOnError = event.detail.value;
        else return;
        $('dsProgress').stats = $('dsProgress').stats.map(item => (item.id === event.detail.id ? Object.assign({}, item, { value: event.detail.value }) : item));
    });
    $('dsProgress').stats = [{ id: 'threads', label: 'Threads', value: 8, options: [1, 2, 4, 8, 16], max: 8, overTitle: 'This environment allows up to 8' }, { id: 'stopOnError', label: 'Stop on next error', value: false }, { label: 'Rows per request', value: '100' }, { label: 'Started', value: '09:15:02' }, { label: 'Taken', value: '13s' }, { label: 'Left', value: 'Under a minute' }, { label: 'Speed', value: '7 a second' }, { label: 'Succeeded', value: '88' }, { label: 'Failed', value: '3' }];
    drawColours();
    drawInventory();
    drawMoving();
    drawIcons();
    $('dsName').addEventListener('dbmn-name-change', event => { $('dsNameNote').textContent = `Asked to be called ${event.detail.name}`; });
    drawTable();
    drawNested();
    drawMap();
    drawLanes();
    drawSampled();
    drawEdit();
    drawSpecial();
    drawToggles();
    drawLookup();
    drawPaged();
    drawLog();
    if (window.Icons) window.Icons.injectIcons(document.body);
    $('dsIconFind').addEventListener('input', findIcons);

    // The theme button is the Hub's own picker. VS Code has none: its theme is VS Code's
    if (!hubThemeButton()) {
        $('dsThemeBtn').hidden = true;
        $('dsThemeNote').textContent = 'Here the theme is the host\'s own: change VS Code\'s colour theme and this page follows.';
    } else {
        $('dsThemeNote').textContent = 'The same picker as the palette button at the top right.';
    }
    // The Hub keeps this page's colours in step with the theme: the values shown follow
    new MutationObserver(drawColours).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    new MutationObserver(drawColours).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();

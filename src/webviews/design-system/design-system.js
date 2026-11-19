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
        working.steps = ['Source', 'Map', 'Validate', 'Review', 'Execute'].map(label => ({ label }));
        working.render([
            { status: 'done' }, { status: 'done' }, { status: 'current', checking: true },
            { status: 'blocked', waitsFor: 'Validate' }, { status: 'blocked', waitsFor: 'Review' }
        ], 3);
    }

    /* ── Progress: a run to watch ── */
    let runTimer = 0;
    let threads = 8;
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

    /* ── Colours: the theme's, with what each is for ── */
    const COLOURS = [
        ['--vscode-editor-background', 'The page'],
        ['--vscode-foreground', 'Text'],
        ['--vscode-descriptionForeground', 'Quieter text, hints'],
        ['--vscode-panel-border', 'Lines and outlines'],
        ['--vscode-input-background', 'Fields, raised panels'],
        ['--vscode-input-border', 'A field\'s outline'],
        ['--vscode-button-background', 'The primary button'],
        ['--vscode-button-foreground', 'Its text'],
        ['--vscode-button-secondaryBackground', 'A secondary button'],
        ['--vscode-textLink-foreground', 'Links, the current step'],
        ['--vscode-focusBorder', 'Keyboard focus'],
        ['--vscode-progressBar-background', 'Progress'],
        ['--vscode-testing-iconPassed', 'Done, success'],
        ['--vscode-editorWarning-foreground', 'Needs a look'],
        ['--vscode-errorForeground', 'Failed, cannot be undone'],
        ['--vscode-editorWidget-background', 'Menus and pop-ups'],
        ['--vscode-list-hoverBackground', 'A row under the pointer']
    ];
    function drawColours() {
        const root = getComputedStyle(document.documentElement);
        $('dsSwatches').replaceChildren(...COLOURS.map(([name, use]) => {
            const row = el('div', 'ds-swatch');
            const colour = el('span', 'ds-swatch-colour');
            colour.style.setProperty('--swatch', `var(${name})`);
            const text = el('span', 'ds-swatch-text');
            const value = root.getPropertyValue(name).trim();
            const label = el('span', 'ds-swatch-name', name);
            label.title = value ? `${name}: ${value}` : `${name} (this theme leaves it to the fallback)`;
            text.append(label, el('span', 'ds-swatch-use', use + (value ? ` · ${value}` : '')));
            row.append(colour, text);
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
        ['<dbmn-footer>', 'A screen\'s footer: actions left, progress right', C, 'Query', 'shared/dbmn-footer.js'],
        ['<dbmn-actions>', 'The footer\'s buttons, the main one last', C, 'Query', 'shared/dbmn-footer.js'],
        ['<dbmn-steps>', 'A wizard\'s steps in one line, and the summary they fold into', C, 'Query', 'shared/dbmn-footer.js'],
        ['<dbmn-progress>', 'The system\'s progress: the box is the bar', C, 'No screen yet', 'shared/dbmn-footer.js'],
        ['<dbmn-status>', 'A few words of status (Saved, Not saved yet)', C, 'No screen yet', 'shared/dbmn-footer.js'],
        ['DbmnModal', 'Dialogs: a question, a form, an alert', M, 'Every screen', 'shared/dbmn-modal.js'],
        ['DbmnToast', 'Messages in the corner', M, 'Every screen', 'shared/dbmn-toast.js'],
        ['DbmnContextMenu', 'A right-click menu', M, 'Hub lists, tables', 'shared/dbmn-context-menu.js'],
        ['Icons', 'The one list of icons, and icons by job', M, 'Every screen', 'shared/icons.js'],
        ['DbmnActions', 'Named actions for markup (data-click)', M, 'Every screen', 'shared/dbmn-actions.js'],
        ['HelpMode', 'Help mode: click a control to read about it', M, 'Every screen', 'shared/help-mode.js'],
        ['DbmnClipboard', 'Copy to the clipboard, in every host', M, 'Every screen', 'shared/dbmn-clipboard.js'],
        ['ColumnHead', 'A table heading: sort, remove, resize, its menu', M, 'Query, Compare, Console', 'shared/column-head.js'],
        ['ColumnDrag', 'Drag a column to another place', M, 'Query, Compare, Console', 'shared/column-drag.js'],
        ['VirtualWindow', 'Draw only the rows in view', M, 'Query, Compare, Console', 'shared/virtual-window.js'],
        ['CellDetail', 'A cell\'s whole value, opened from the cell', M, 'Query, Compare, Console', 'shared/cell-detail.js'],
        ['SearchMatcher', 'A table\'s search: words, -not, a,b, @column=value, the coloured box', M, 'Console, Compare, <dbmn-table>', 'shared/search-matcher.js'],
        ['SearchWords', 'The Hub lists\' search: words and signs (#tag, @env, !error)', M, 'Hub lists', 'shared/search-words.js'],
        ['ThemePicker', 'Choosing a theme', M, 'Hub', 'shared/theme-picker.js'],
        ['SystemPicker', 'Choosing a System', M, 'Endpoint, Environment', 'shared/system-picker.js'],
        ['Buttons', '.btn, .btn-primary, .btn-secondary, .btn-danger', S, 'Every screen', 'shared/buttons.css'],
        ['Tabs in a screen', 'A screen\'s own tabs (Environment, Console)', S, 'Environment, Console', 'shared/tabs.css'],
        ['StepBar', 'The older step bar: names over circles', R, 'Compare, Run Batch', 'shared/step-bar.js'],
        ['.progress-display', 'The older two-line progress panel', R, 'Console, Compare, Run Batch', 'shared/core.css'],
        ['<dbmn-table>', 'A table of rows the page holds: search, sort, move, resize, windowed rows', C, 'Design system', 'shared/dbmn-table.js'],
        ['<dbmn-table> for paged rows', 'The same table over rows the host pages in (Query, Compare, Console)', P, '', ''],
        ['Nested rows', 'A row that opens onto rows of its own', P, 'Console has its own today', ''],
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
        ['Compare', 'Footer and steps', MOVE, 'Its own footer: name, the older step bar, arrows between steps', 'Swap in dbmn-footer and dbmn-steps; the name moves to its tab'],
        ['Run Batch', 'Footer and steps', MOVE, 'Its own footer: the older step bar, arrows between steps', 'Swap in dbmn-footer and dbmn-steps; a summary on Review is still to decide'],
        ['Console', 'Footer and progress', MOVE, 'Its own buttons and the older two-line progress panel', 'Swap in dbmn-footer and dbmn-progress; where the timing line goes is still to decide'],
        ['Edit Endpoint', 'Footer and status', MOVE, 'Its own footer markup, no status box', 'Swap in dbmn-footer and dbmn-status'],
        ['Edit Environment', 'Footer and status', MOVE, 'Its own footer markup and footer notification', 'Swap in dbmn-footer and dbmn-status'],
        ['Design system', 'Table', ON, 'dbmn-table', ''],
        ['Query', 'Table', WAIT, 'Wires the shared table pieces itself; rows come from the host a page at a time', 'dbmn-table learns to page; Query moves first'],
        ['Compare', 'Table', WAIT, 'Wires the shared table pieces itself; coloured columns and difference marks', 'After Query: paging, then its colours and marks'],
        ['Console', 'Table', WAIT, 'Its own table: nested rows, grouped headings, Views', 'Last: needs paging, nested rows and grouped headings in dbmn-table'],
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
                status,
                notes: status === 'On hold' ? { reason: 'Awaiting stock', expected: '2026-11-24', contact: 'purchasing', history: ['raised', 'chased', 'confirmed'] } : ''
            });
        }
        const table = $('dsOrders');
        table.columns = [
            { id: 'order_no', name: 'order_no' }, { id: 'line', name: 'line', numbers: true }, { id: 'customer', name: 'customer' },
            { id: 'item', name: 'item' }, { id: 'description', name: 'description' }, { id: 'qty', name: 'qty', numbers: true },
            { id: 'status', name: 'status' }, { id: 'notes', name: 'notes' }
        ];
        table.rows = rows;
    }

    window.DbmnActions.register({
        'ds:back': () => go(current - 1),
        'ds:next': () => { if (current < STEPS.length) go(current + 1); },
        'ds:run': run,
        'ds:theme': () => { const button = hubThemeButton(); if (button) button.click(); },
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
        'ds:menu': (arg, event) => {
            window.DbmnContextMenu.show(event, [
                { id: 'rename', label: 'Rename', icon: 'pencil' },
                { id: 'copy', label: 'Duplicate', icon: 'copy' },
                { separator: true },
                { id: 'delete', label: 'Delete', icon: 'trash-2', danger: true }
            ], id => window.DbmnToast.info(`You chose ${id}`));
        }
    });

    $('dsSteps').steps = STEPS.map(step => ({ label: step.label }));
    $('dsSteps').addEventListener('dbmn-step', event => go(event.detail.step));
    drawWizard();
    drawWorking();
    // (a screen's controller would check the change against the environment's limit; here it is taken as asked)
    $('dsProgress').addEventListener('dbmn-progress-change', event => {
        if (event.detail.id !== 'threads') return;
        threads = event.detail.value;
        $('dsProgress').stats = $('dsProgress').stats.map(item => (item.id === 'threads' ? Object.assign({}, item, { value: threads }) : item));
    });
    $('dsProgress').stats = [{ id: 'threads', label: 'Threads', value: 8, options: [1, 2, 4, 8, 16], max: 8, overTitle: 'This environment allows up to 8' }, { label: 'Rows per request', value: '100' }, { label: 'Started', value: '09:15:02' }, { label: 'Taken', value: '13s' }, { label: 'Left', value: 'Under a minute' }, { label: 'Speed', value: '7 a second' }, { label: 'Succeeded', value: '88' }, { label: 'Failed', value: '3' }];
    drawColours();
    drawInventory();
    drawMoving();
    drawIcons();
    drawTable();
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

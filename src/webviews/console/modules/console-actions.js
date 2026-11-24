// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's footer Actions menu (B20; James's agreed footer: "Back, then Actions (Chain, Export, Copy…), then the
 * status"): what you can do with the rows the tab shows, in one menu under the footer's Actions button
 * (DbmnContextMenu, the same as Query's Actions). The controls it stands for stay in the page, unseen (the toolbar's
 * Copy, Export, Chain and database buttons): each item presses its control, so every copy and export is the code it
 * always was. Shown only where those controls were (the data tabs); each item only while its control is offered.
 * Browser: window.ConsoleActions.
 */
(function () {
    'use strict';
    const $ = id => document.getElementById(id);

    /** The items, read from the controls as they are now: [{ id, label, icon, press() }, { separator }]. */
    function items() {
        // (the size limits, worked out as the old drop-downs did on opening: a choice over its limit is shown off, with why)
        const manager = window.dynamicReportManager;
        try { if (manager) { manager.updateCopyDropdownLimits(); manager.updateExportDropdownLimits(); } } catch { /* no table yet */ }
        const out = [];
        const group = list => { const shown = list.filter(Boolean); if (shown.length) { if (out.length) out.push({ separator: true }); out.push(...shown); } };
        const option = (menu, format, excel) => {
            const el = document.querySelector(`#${menu} .export-option[data-format="${format}"]${excel ? '[data-excel-safe="true"]' : ':not([data-excel-safe="true"])'}`);
            return el || null;
        };
        const copy = $('copy-btn');
        if (copy && !copy.disabled) {
            group([
                ['html', false, 'Copy', 'copy'], ['tsv', true, 'Copy for Excel', 'copy'], ['csv', false, 'Copy as CSV', 'copy'],
                ['csv', true, 'Copy as CSV (Excel)', 'copy'], ['markdown', false, 'Copy as Markdown', 'copy']
            ].map(([format, excel, label, icon]) => { const el = option('copy-dropdown', format, excel); return el && { id: `copy-${format}${excel ? '-x' : ''}`, label, icon, disabled: el.disabled, ...(el.disabled && el.title ? { detail: el.title } : {}), press: () => el.click() }; }));
        }
        const exp = $('export-btn');
        if (exp && !exp.disabled) {
            group([['csv', false, 'Export CSV'], ['csv', true, 'Export CSV (Excel)'], ['excel', false, 'Export Excel']]
                .map(([format, excel, label]) => { const el = option('export-dropdown', format, excel); return el && { id: `export-${format}${excel ? '-x' : ''}`, label, icon: 'download', disabled: el.disabled, ...(el.disabled && el.title ? { detail: el.title } : {}), press: () => el.click() }; }));
        }
        const chain = $('chain-btn');
        const compare = $('compare-btn');
        group([
            chain && !chain.classList.contains('hidden') && { id: 'chain', label: 'Chain: these rows to another API', icon: 'link', disabled: chain.disabled, press: () => chain.click() },
            compare && !compare.classList.contains('hidden') && { id: 'query', label: 'Query or compare…', icon: 'database', disabled: compare.disabled, press: anchor => window.ConsoleCompare && window.ConsoleCompare.openFrom ? window.ConsoleCompare.openFrom(anchor) : compare.click() }
        ]);
        return out;
    }

    function open(button) {
        const list = items();
        if (!list.length || !window.DbmnContextMenu) return;
        window.DbmnContextMenu.show(button, list.map(({ press, ...item }) => item), id => {
            const chosen = list.find(i => i.id === id);
            // (after this menu has closed: a choice may open a menu of its own)
            if (chosen && chosen.press) setTimeout(() => chosen.press(button), 0);
        });
    }

    /** Shown where the toolbar's controls were: the data tabs. */
    function follow() {
        const button = $('console-actions-btn');
        const toolbar = $('report-toolbar');
        if (!button || !toolbar) return;
        button.classList.toggle('hidden', toolbar.style.display === 'none' || !document.querySelector('#copy-btn, #export-btn'));
    }

    function wire() {
        const button = $('console-actions-btn');
        if (!button || button._wired) return;
        button._wired = true;
        button.addEventListener('click', () => open(button));
        const toolbar = $('report-toolbar');
        if (toolbar) new MutationObserver(follow).observe(toolbar, { attributes: true, attributeFilter: ['style', 'class'] });
        follow();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();

    window.ConsoleActions = { items, open };
})();

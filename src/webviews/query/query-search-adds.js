// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A search that names a view's column not in the report adds it to the report, and it stays there
 * (James, 2026-11-23: "@qty adds it as a compare column. @c1.qty adds as report column", "a. Stay.",
 * "e. just run"). Results' search box (query-page.js) asks this which columns a search adds, then
 * sets the report's columns as the Columns step would; the query runs again with them.
 *
 * Pure: no page, no host. Loaded by the page (window.QuerySearchAdds) and by the core tests
 * (module.exports).
 */
(function () {
    const lower = s => String(s == null ? '' : s).toLowerCase();

    /**
     * The report columns the search's column terms add, in the order named; [] when none.
     *
     * @param {string[]} names    the terms' column names as typed (search-matcher columnTerms' `name`)
     * @param {{view: string, column: string, group?: string}[]} report   the report's columns now
     * @param {{id: string, alias: string, columns: string[]}[]} views    every view, in slot order: its
     *                            alias as the search knows it (its run, BL, C1…, or its name), its columns
     * @param {string[]} compareViews   the compare's views (none when the query isn't a compare)
     *
     * `@C1.qty` (a view's alias, then its column): that view's column alone, shown, not compared.
     * `@qty` (a name alone): in a compare, compared across the compare's views that have it (one group);
     * else the first view that has it, shown. Nothing for a column the report has, a name no view has,
     * or a term still being typed (only a whole column name adds).
     */
    function columnsToAdd(names, report, views, compareViews) {
        const out = [];
        const has = (view, column) => report.some(c => c.view === view && lower(c.column) === lower(column))
            || out.some(c => c.view === view && lower(c.column) === lower(column));
        const columnOf = (view, name) => view.columns.find(c => lower(c) === lower(name));
        // The longest alias first, so "Ship.address.city" is Ship's "address.city"
        const byAlias = views.slice().sort((a, b) => b.alias.length - a.alias.length);
        (names || []).forEach(raw => {
            const name = String(raw || '');
            if (!name) return;
            // A view's column by its alias: @C1.qty
            const view = byAlias.find(v => v.alias && lower(name).startsWith(lower(v.alias) + '.') && columnOf(v, name.slice(v.alias.length + 1)));
            if (view) {
                const column = columnOf(view, name.slice(view.alias.length + 1));
                if (!has(view.id, column)) out.push({ view: view.id, column });
                return;
            }
            // A name alone: nothing when the report has a column of that name (the search reaches it already)
            if (report.some(c => lower(c.column) === lower(name))) return;
            const holders = views.filter(v => columnOf(v, name));
            if (!holders.length) return;
            const compared = holders.filter(v => (compareViews || []).includes(v.id));
            if (compared.length) {
                compared.forEach(v => { const column = columnOf(v, name); if (!has(v.id, column)) out.push({ view: v.id, column, group: column }); });
                return;
            }
            const first = holders[0];
            const column = columnOf(first, name);
            if (!has(first.id, column)) out.push({ view: first.id, column });
        });
        return out;
    }

    /**
     * The search once columns leave the report (× on a heading, or unticked on Columns): the terms naming them go
     * with them (search-matcher's withoutColumns), but a term another column still answers to stays. With its term
     * gone, a removed column isn't added straight back (columnsToAdd has nothing to add for it): James, 2026-11-23,
     * "just keep the Delete key".
     *
     * @param {string} search
     * @param {{id: string, name: string, aliases?: string[]}[]} removed     the columns that left, as the search names them
     * @param {{id: string, name: string, aliases?: string[]}[]} remaining   the report's columns still there
     * @param {Function} withoutColumns   SearchMatcher.withoutColumns
     */
    function searchAfterRemoval(search, removed, remaining, withoutColumns) {
        return removed && removed.length && search ? withoutColumns(search, removed, remaining) : search;
    }

    const api = { columnsToAdd, searchAfterRemoval };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.QuerySearchAdds = api;
})();

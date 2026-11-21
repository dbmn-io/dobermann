// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-table>: a table of rows, with everything a DBMN table does. The rows are the page's own
 * (`rows`), or stay with the screen and are asked for as they scroll into view (`source`). Made
 * from the shared pieces the Query, Compare and Console tables are made from:
 *
 *   the search box     search-matcher.js: words, "exact", -not, a,b either, @column=value
 *   a heading          column-head.js: the icon sorts (one way, the other, then as given),
 *                      x removes, the right edge resizes, a double-click fits, a right-click
 *                      lists it all; column-drag.js: the name drags the column to another place
 *   the rows           virtual-window.js: only the rows in view are drawn, however many there are
 *   a long value       cell-detail.js: a click opens it in full (a long one, or one cut off by its column)
 *
 *   <dbmn-table id="orders" label="Orders" searchable removable></dbmn-table>
 *
 *   orders.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'qty', name: 'qty', numbers: true },
 *                     { id: 'state', name: 'State', render: (value, row) => chipFor(value) }];
 *   orders.rows = [{ order_no: 'SO-10412', qty: 24, state: 'Open' }, …];
 *   orders.addEventListener('dbmn-table-shown', e => …e.detail.shown, e.detail.total…);
 *
 * Attributes: `editable` (a cell at a time, as a spreadsheet: below), `searchable` (the search box and the count), `removable` (x on a heading),
 * `locked` (columns can be neither moved nor removed), `label` (what the table holds, for a
 * screen reader), `placeholder` (the search box's).
 *
 * A column: { id, name, numbers, type, className (on its heading and its cells: a colour the screen
 * owns), render(value, row), pinned, group, head(th) }.
 *   pinned: true            it stays where it is (a key, a status): never moved or removed, nothing moves past it;
 *                           and it keeps its measured width when a narrow table stretches to fill its box
 *   width: 160              its starting width in px (the screen measured what it needs: a status of
 *                           several tags), never stretched; the user's resize still wins
 *   wrap: true              its cells wrap onto a second line rather than widening it (a status of DIFF and Missing)
 *   group: { id, name, head(th) }   consecutive columns with one group share a heading over theirs (a field,
 *                           and BL, C1, C2 under it): the group moves and is removed as one, and its
 *                           right edge sizes its columns evenly; each column under it sorts and resizes on its own
 *   head(th)                adds what the screen wants to the column's heading (a count, a filter)
 *   sortable: false         no sort for it (a status the screen filters instead)
 *   removable: false        it stays (no x, no Remove): the screen's own column (the Console's Reason)
 *   within: ['location']    the objects it sits in, outermost first: it moves only among the columns
 *                           of its own object (or past an object beside it, which moves aside as one);
 *                           let go outside them, it stays, and the table tells dbmn-table-outside { id }
 *   cell(td, value, row)    after the cell is drawn: the screen marks it (a value that differs, its tint);
 *                           a long value it marks .cell-expandable with data-full (and data-title)
 *                           opens in full on a click, as the table's own do
 *
 * Rows the screen acts on:
 *   orders.rowClass = row => 'is-flagged';       a class on a row's <tr>
 *   orders.emptyText = ({ searched }) => 'No rows match the filters.';   what an empty table says (else its own words)
 *   orders.redrawHeads();             the headings drawn again (their head(th) hooks run again: a count
 *                                     changed), with the order, widths and sort as they are
 *   orders.addEventListener('dbmn-table-row', e => open(e.detail.row));        a click on a row
 *   orders.addEventListener('dbmn-table-row-menu', e => …e.detail.row, e.detail.event…);   a right-click on a row
 *       (not a click that opens a long value, a list of records or anything with its own action;
 *       a right-click is the screen's to show a menu for: the browser's own is kept from it) `type` ('text', 'number', 'yesno', 'date', 'nested') is what the
 * search box says the column is and which operators it offers; left out, the table looks at the
 * values (a date is ISO 8601 text). No type is ever shown in a heading. `numbers` says the column sorts as numbers (its sort icon is 0 to
 * 1, where text's is A to Z); left out, the table looks at the values: a column of numbers or of
 * true and false sorts as numbers. A value that is a number sits right.
 *
 * ── Editing: the `editable` attribute (rows the page holds) ──
 *   Typing mode, as a data-entry grid: every cell is drawn as a box, and a click puts the caret in
 *   it where it was clicked. Enter keeps the value and goes down, Tab across (on to the next row at
 *   the end of one), Up and Down a row, each already open for typing; a click elsewhere keeps it.
 *   Esc gives it up and leaves the cell held: the arrow keys, Tab, Home, End and Page Up/Down move
 *   the hold, typing or Enter opens it again, Delete empties it. A yes/no cell turns over on a
 *   click, Space or Enter. A block copied from a spreadsheet pastes
 *   from the held cell (tab between cells, a line a row); Ctrl+C copies the cell. Ctrl+Z undoes,
 *   Ctrl+Y (or Ctrl+Shift+Z) does again; a paste is one step.
 *   { id, name, editable: false }        a column that is only read
 *   { id, editor: { type: 'date' | 'time' | 'datetime-local' | 'number', value: v => 'yyyy-mm-dd' | null, step } }
 *                                        the browser's own box for it (value: the cell's value as that box
 *                                        takes it; null when it can't, and the box is plain text)
 *   { id, editor: { type: 'checkbox' } }  yes/no: Enter or a double-click turns it over
 *   orders.onCellKey = (event, held) => true   the screen sees each key first (held: { index, id, row,
 *                                        editing?, value? }); true when it took it (Ctrl+D, Tab adding a row)
 *   orders.held; orders.select(index, id); orders.write([{ index | row, id, value }], kind); orders.edit()
 *   dbmn-table-undo { redo }    before Ctrl+Z / Ctrl+Y: preventDefault() and the screen undoes (its history)
 *   dbmn-table-paste { text, index, id }   before a paste: preventDefault() and the screen reads it
 *   orders.addEventListener('dbmn-table-edit', e => …e.detail.kind ('edit' | 'paste' | 'undo' | 'redo'),
 *       e.detail.changes [{ row, id, index, value, old }], e.detail.left (pasted cells with nowhere to go)…);
 *   A listener may change a change's `value`, or refuse them all with preventDefault(); otherwise
 *   the table writes them into the rows and draws them. A number stays a number when it reads as one.
 *
 * ── Picking rows: `selectable` (a tick box per row) or `selectable="single"` (one at a time) ──
 *   A click on a row picks it (again: not, unless single); Shift-click picks every row from the last
 *   one clicked; the heading's box picks every row shown (the search's), or none.
 *   orders.selected: the rows picked (in the order given); orders.selected = [rows] picks them.
 *   dbmn-table-select { selected } after each change. dbmn-table-row-open { row, index } on a
 *   double-click (a picker's Add; any table that is not editable).
 *
 * ── A table people keep (a lookup table): with `editable` ──
 *   `add-row`       a line under the rows adds an empty row, its first cell open for typing
 *                   (dbmn-table-add-row { row } first: cancelable, and detail.row may be filled)
 *   `row-delete`    the row's number first; on hover a bin deletes the row
 *                   (dbmn-table-delete-row { row, index } first: cancelable)
 *                   Ctrl+Z puts a deleted row back and takes an added one away. After any of
 *                   these: dbmn-table-rows { kind: 'add' | 'delete', row, index, rows }
 *   `edit-columns`  a column's heading menu: Rename column…, Add a column after, Delete column
 *                   (dbmn-table-columns { kind: 'rename' | 'add' | 'delete', id, name, old?, after? }
 *                   first: cancelable; on add the screen may set detail.id). Delete takes the
 *                   column's values from every row. Needs DbmnModal (the name, the confirm).
 *   { id, key: true }   a key: a key on its heading; a value in two rows, or none, is amber with
 *                   the reason on hover. orders.keyProblems: [{ row, id, value, kind: 'duplicate' | 'missing' }]
 *
 * ── A live list: following the newest rows ──
 *   <dbmn-table follow="top">        the newest rows are at the top (follow="bottom": at the bottom)
 *   While the newest row is in view, rows given later keep it in view. Scrolled away from it, the
 *   rows on screen stay where they are and the new ones are counted; back at that end, it follows
 *   again. Only for a live feed (Logs): a table without `follow` never moves by itself.
 *   orders.following                  // true while it follows; set it to start or stop
 *   orders.setRows(rows, { older: true })   // rows added at the far end (a log's earlier lines): the view stays put
 *   orders.addEventListener('dbmn-table-follow', e => …e.detail.following, e.detail.unseen…);
 *
 * ── Rows inside a row ──
 *   A value that is a list of records (an order's lines) shows as "3 records" with a chevron, and
 *   opens INSIDE its cell: a small table with its own headings, which sort and can be removed.
 *   Two such columns in one row each open in their own cell. The first 100 show. What is open
 *   stays open through a search or a sort (it goes by the row, not by where the row sits).
 *   orders.rowKey = row => row.order_no;      // what makes a row the same row; needed with `source`
 *   { id: 'lines', name: 'lines', nested: { count: row => row.lineCount, rows: row => fetchLines(row) } }
 *                                             // records that are fetched when the cell is opened
 *   nested: { controls: (row, value) => button }   // the screen's own buttons beside "3 records"
 *                                             // (the Console's "Set as Row"); a click on one is the screen's
 *
 * ── Rows that stay with the screen ──
 *   orders.source = { total: 5310, page: (start, count, { search, sort }) => rows | Promise };
 *       Only the pages in view are asked for; a row not yet in is an empty row of the right
 *       height. `page` may answer { rows, total } when only the answer knows how many there are,
 *       and { rows, total, of } to say how many there are before the search ("12 of 105,010 rows").
 *       The table neither searches nor sorts these: it says what was asked and asks again.
 *   orders.reload();                  // the rows changed (a search, Distinct): ask again, from the top
 *   orders.reload({ keep: true });    // the same, staying where it is (a live refresh)
 *   orders.addEventListener('dbmn-table-search', e => …e.detail.text, e.detail.reads…);   then it asks again itself
 *       (`reads`: the search in words, "Reading this as: placed (date) after 12 Nov 2026", for a
 *       screen to show under its own box; the table shows it under its own)
 *   orders.addEventListener('dbmn-table-layout', e => …e.detail.change, e.detail.layout…);
 *       change: 'sorted' | 'moved' | 'removed' | 'resized', with { id, to, width } as fits;
 *       layout: { order: [ids], hidden: [ids], widths: { id: px } (the ones the user set), sort,
 *               recordHidden: ['lines.qty'] (columns removed from a column's records),
 *               recordsWide: ['lines'] (columns whose records open full width, under their row) }.
 *       A column removed from a column's records is told with { records: column id, key }.
 *       A sort's icon is a clock until the new rows land. Both events are told for `rows` too.
 *   orders.layout = saved;            // after `columns`: the order, widths, hidden columns and sort kept
 *   orders.searchWith(input, mirror); // the screen's own search box, with the @column suggestions
 *   orders.searchFields = [{ id: 'body', name: 'body', get: row => row.request.body }];
 *                                     // fields the search reaches that are not columns: @@word finds a word
 *                                     // in them (a plain word looks only in the columns shown), @body names
 *                                     // them, @ suggests them (with every column, shown or not)
 *   orders.totals = { qty: '12,410' } // a row under the rows, from the screen; null takes it away
 *   orders.busy = true;               // something is looking: the search box's glass is the spinner
 *                                     // (with `source` it turns by itself while rows are asked for)
 *   orders.shown                      // with `rows`: the rows the search shows, in the order shown
 *
 * It draws in the page (no shadow root) and holds no business logic: it shows the rows it is
 * given. What is searched, sorted, moved or resized is the table's own view of them, and the
 * rows given are never changed.
 *
 * Needs icons.js, search-matcher.js, column-head.js, column-drag.js, virtual-window.js and
 * dbmn-context-menu.js; cell-detail.js (with value-formatter.js and dbmn-modal.js) for long
 * values. Styles: dbmn-table.css over tables.css, console.css (the search box), column-head.css
 * and column-drag.css.
 */
(function () {
    'use strict';

    if (!window.customElements || customElements.get('dbmn-table')) return;

    const ROW_H = 22;
    /** A value longer than this (or of more than one line) opens in full on a click; shorter ones widen with their column. */
    const LONG = 100;
    /** Rows asked for at a time, and how many pages are kept before the furthest are let go. */
    const PAGE = 200;
    const ROW_GUTTER = '__row';   // (`row-delete`: the row number column the table draws itself)
    const ROW_PICK = '__pick';    // (`selectable`: the tick-box column the table draws itself)
    /** The table's own columns, not the screen's: never in `columns`, a layout or a new row. */
    const own = id => id === ROW_GUTTER || id === ROW_PICK;
    const KEEP_PAGES = 60;
    /** Typing is never held up: over this many rows a search waits for a pause in the typing, then runs a little at a time and stops at the next key. */
    const SEARCH_AT_ONCE = 3000;
    const SEARCH_PAUSE = 120;
    const SEARCH_SLICE_MS = 8;
    /** Records shown when a cell's list of them is opened. */
    const NEST_MAX = 100;
    /** As wide as a column grows by itself to show its opened records. */
    const NEST_WIDE = 560;
    const isRecord = v => !!v && typeof v === 'object' && !Array.isArray(v);

    function make(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }
    const count = n => Number(n || 0).toLocaleString();
    /** A cell that opens in full shows so on hover: the maximise icon at its right edge (console.css). */
    function expandIcon(td) {
        if (!window.Icons || !window.Icons.icon || td.querySelector(':scope > .cell-expand-icon')) return;
        const icon = make('span', 'cell-expand-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = window.Icons.icon('maximize-2');
        td.append(icon);
    }
    /** Worth opening in full though short: JSON, BASE64, ZPL (cell-detail.js). */
    const structured = text => !!(window.CellDetail && window.CellDetail.worthOpening && text && window.CellDetail.worthOpening(text));
    function textOf(value) {
        if (value === null || value === undefined) return '';
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }

    class DbmnTable extends HTMLElement {
        constructor() {
            super();
            this._all = [];         // every column given
            this._columns = [];     // the ones shown, in the order shown
            this._rows = [];
            this._view = [];        // the rows shown (searched, sorted): indexes into _rows
            this._sort = null;      // { id, dir }
            this._widths = {};      // by column id, once sized or set
            this._rendered = { start: -1, end: -1 };
            this._rowH = ROW_H;
            this._lastTop = 0;
            this._built = false;
            this._set = {};         // widths the user set (the rest are measured)
            this._source = null;    // rows that stay with the screen
            this._pages = new Map();
            this._asked = new Set();
            this._gen = 0;          // answers to an earlier asking are dropped
            this._fresh = false;    // asked again; the first page is not in yet
            this._total = 0;
            this._totals = null;
            this._open = new Map();     // rows with a list of records open: row key → Map(column id → its state)
            this._subHidden = {};       // record columns the user removed, by column id
            this._wide = new Set();     // columns whose records open full width, under their row
            this.rowKey = null;         // row => what makes it the same row (else the row object itself)
            this._following = true;     // (with `follow`) the newest row is kept in view
            this._unseen = 0;           // rows that came while it was not
        }

        connectedCallback() {
            if (!this._built) this._build();
            if (window.ResizeObserver && !this._seen) {
                // Sized when first seen (a table behind another tab has no width to measure), and its window follows its height
                this._seen = new ResizeObserver(() => { const fresh = !this._sized; if (fresh) this._size(); this._render(fresh); });
                this._seen.observe(this._scroll);
            }
            this._refresh();
        }

        disconnectedCallback() {
            if (this._seen) { this._seen.disconnect(); this._seen = null; }
        }

        set columns(list) {
            this._all = Array.isArray(list) ? list.filter(c => c && !own(c.id)) : [];
            // (`row-delete`: the row's number first, a bin on it to delete the row)
            if (this.hasAttribute('row-delete')) this._all.unshift(this._gutterColumn());
            // (`selectable`: a tick box first of all, to pick rows)
            if (this.hasAttribute('selectable')) this._all.unshift(this._pickColumn());
            this._keyCounts = null;
            this._columns = this._all.slice();
            this._sort = null;
            this._widths = {};
            this._set = {};
            this._sized = false;
            this._refresh();
        }
        get columns() { return this._columns.filter(c => !own(c.id)); }

        set rows(list) {
            this._before(Array.isArray(list) ? list.length - this._rows.length : 0);
            this._rows = Array.isArray(list) ? list : [];
            this._keyCounts = null;
            if (this._picked && this._picked.size) { const now = new Set(this._rows); this._picked.forEach(r => { if (!now.has(r)) this._picked.delete(r); }); }
            this._source = null;
            this._kinds = null;
            this._types = null;
            this._sized = this._sized && Object.keys(this._widths).length > 0;
            // Sized before it had any rows (they came later): sized again now there is something to measure
            if (this._sizedEmpty && this._rows.length) this._unsize();
            this._refresh();
        }
        get rows() { return this._rows; }
        /** Rows given again; `older`: the new ones are older, at the far end from the newest (a log's
         *  earlier lines, asked for by scrolling to them): the view stays exactly where it is. */
        setRows(list, opts) {
            this._far = !!(opts && opts.older);
            try { this.rows = list; } finally { this._far = false; }
        }

        /** The rows the search shows, in the order shown (rows the page holds). */
        get shown() { return this._source ? [] : this._view.map(i => this._rows[i]); }

        /** Rows that stay with the screen: { total, page(start, count, { search, sort }) }. Asked for from the top. */
        set source(source) {
            this._source = source && typeof source.page === 'function' ? source : null;
            this._rows = [];
            this._view = [];
            if (this._source) this._again(false);
            else this._refresh();
        }
        get source() { return this._source; }

        /** The screen's rows changed: ask again. From the top, or `keep` the place (a live refresh). `total` when it is known. */
        reload(opts) {
            if (!this._source) return;
            const more = opts && typeof opts.total === 'number' ? opts.total - this._total : 0;
            if (opts && typeof opts.total === 'number') this._source.total = opts.total;
            if (opts && opts.keep) this._before(more);
            this._again(!!(opts && opts.keep));
        }

        /** Something is looking (a search the screen runs): the search box's glass turns into the steps' spinner. */
        get busy() { return !!this._busy; }
        set busy(on) { this._busy = !!on; this._glass(); }
        _glass() {
            const glass = this._tools && this._tools.querySelector('.dbmn-table-glass');
            if (!glass) return;
            const on = this._busy || (!!this._source && this._fresh);
            if (glass.classList.contains('is-busy') === on) return;
            glass.classList.toggle('is-busy', on);
            this.toggleAttribute('aria-busy', on);
            if (window.Icons) window.Icons.setIcon(glass, on ? 'loader' : 'search');
        }

        redrawHeads() { if (this._built) this._heads(); }

        /** A row of totals under the rows, by column id, from the screen. */
        set totals(map) {
            this._totals = map && typeof map === 'object' ? map : null;
            if (this._built) this._feet();
        }
        get totals() { return this._totals; }

        /** What a screen saves of the table: the order, the hidden columns, the widths the user set, the sort. */
        get layout() {
            const shown = this._columns.map(c => c.id).filter(id => !own(id));
            const widths = {};
            Object.keys(this._set).forEach(id => { if (this._widths[id]) widths[id] = this._widths[id]; });
            // (the columns removed from a column's records, as `<column>.<key>`)
            const recordHidden = [];
            Object.keys(this._subHidden).forEach(id => Object.keys(this._subHidden[id]).forEach(key => recordHidden.push(`${id}.${key}`)));
            return { order: shown, hidden: this._all.map(c => c.id).filter(id => !own(id) && !shown.includes(id)), widths, sort: this._sort ? { id: this._sort.id, dir: this._sort.dir } : null, recordHidden, recordsWide: [...this._wide] };
        }
        set layout(saved) {
            const l = saved || {};
            const hidden = Array.isArray(l.hidden) ? l.hidden : [];
            const order = Array.isArray(l.order) ? l.order : [];
            const place = id => { const at = order.indexOf(id); return at < 0 ? order.length : at; };
            // (a column the saved layout does not know keeps its place after the ones it does)
            this._columns = this._all.filter(c => !hidden.includes(c.id)).map((c, i) => ({ c, i })).sort((a, b) => place(a.c.id) - place(b.c.id) || a.i - b.i).map(x => x.c);
            if (!this._columns.length) this._columns = this._all.slice();
            Object.keys(l.widths || {}).forEach(id => {
                const w = Number(l.widths[id]);
                if (w > 0 && this._all.some(c => c.id === id)) { this._widths[id] = Math.round(w); this._set[id] = true; }
            });
            this._sort = l.sort && l.sort.id && this._all.some(c => c.id === l.sort.id) ? { id: l.sort.id, dir: l.sort.dir === 'desc' ? 'desc' : 'asc' } : null;
            // Columns whose records open full width
            if (Array.isArray(l.recordsWide)) this._wide = new Set(l.recordsWide.filter(id => this._all.some(c => c.id === id)));
            // Columns removed from a column's records: `<column>.<key>`, by the longest column id it starts with
            if (Array.isArray(l.recordHidden)) {
                this._subHidden = {};
                const ids = this._all.map(c => c.id).sort((a, b) => b.length - a.length);
                l.recordHidden.forEach(path => {
                    const id = ids.find(c => String(path).startsWith(`${c}.`));
                    if (id) (this._subHidden[id] = this._subHidden[id] || {})[String(path).slice(id.length + 1)] = true;
                });
            }
            this._refresh();
            this._recolour();
        }

        /** What the search box holds (the table's own, or the screen's); set it to search from script. */
        set search(text) { const input = this._box(); if (input) { input.value = text || ''; this._searched(); } }
        get search() { const input = this._box(); return input ? input.value : ''; }

        /** The screen's own search box searches this table, with the @column suggestions. `mirror`: its coloured copy, when it has one. */
        searchWith(input, mirror) {
            if (!input || this._outer === input) return;
            this._outer = input;
            this._outerMirror = mirror || null;
            input.addEventListener('input', () => this._searched());
            this._suggest(input);
        }
        /** The search box in use: the screen's, else the table's own when it shows one. */
        _box() { return this._outer || (this.hasAttribute('searchable') ? this._input : null); }
        _suggest(input) {
            const matcher = window.SearchMatcher;
            if (!matcher || !matcher.attachColumnSuggest) return;
            matcher.attachColumnSuggest({
                input,
                types: (heading, path) => this._typeOf(heading, path),
                // (every column searched, shown or not, and the screen's hidden fields: `@` suggests them all)
                headings: () => this._searchColumns().map(c => c.name),
                hidden: () => this._unseenNames(),
                // `@column.` lists the keys inside that column's nested data (of the rows in hand)
                keys: (heading, path) => matcher.nestedKeysFor(this._source ? this._inHand() : this._rows, this._all.map(c => ({ id: c.id, name: c.name || c.id })), heading, path, (row, id) => row[id])
            });
        }
        /** What kind of column a heading names (or a key inside it), for the search box: the screen's word, else what its values are. */
        _typeOf(heading, path) {
            const matcher = window.SearchMatcher;
            const low = String(heading).toLowerCase();
            const column = this._all.find(c => !own(c.id) && String(c.name || c.id).toLowerCase() === low)
                || (this._fields || []).find(f => String(f.name || f.id).toLowerCase() === low);
            if (!column || !matcher || !matcher.typeOfValues) return '';
            const inside = path && path.length;
            if (!inside && column.type) return column.type;
            if (!inside && column.numbers) return 'number';
            const key = `${column.id}.${(path || []).join('.')}`;
            if (!this._types) this._types = {};
            if (this._types[key] === undefined) {
                const rows = (this._source ? this._inHand() : this._rows).slice(0, 200);
                const read = this._readField();
                let values = rows.map(row => (row ? read(row, column.id) : null));
                // (a key inside nested data: the values under it, whichever record they are in)
                (path || []).forEach(part => {
                    const want = part.toLowerCase();
                    const next = [];
                    const dig = v => {
                        if (Array.isArray(v)) v.forEach(dig);
                        else if (v && typeof v === 'object') Object.keys(v).forEach(k => { if (k.toLowerCase() === want) next.push(v[k]); });
                    };
                    values.forEach(dig);
                    values = next;
                });
                if (!rows.length) return '';
                this._types[key] = matcher.typeOfValues(values);
            }
            return this._types[key];
        }
        /** The search in words, under the box: "Reading this as: placed (date) after 12 Nov 2026". */
        _reading(text, columns) {
            const matcher = window.SearchMatcher;
            const cols = columns || this._searchColumns();
            return matcher && matcher.describeSearch ? matcher.describeSearch(text, cols.map(c => c.name), (heading, path) => this._typeOf(heading, path), undefined, cols.filter(c => c.hidden).map(c => c.name)) : '';
        }
        /** The box coloured: what it names, told apart as shown, not shown, or no column (one look at the columns per key). */
        _colour(mirror, text, columns) {
            if (!window.SearchMatcher || !mirror) return;
            window.SearchMatcher.renderHighlight(mirror, text, columns.map(c => c.name), columns.filter(c => c.hidden).map(c => c.name));
        }
        _inHand() {
            const rows = [];
            this._pages.forEach(page => { if (rows.length < 2000) rows.push(...page); });
            return rows;
        }

        _build() {
            this._tools = make('div', 'dbmn-table-tools');
            const container = make('div', 'search-container');
            const wrapper = make('div', 'search-input-wrapper');
            const glass = make('span', 'search-icon-inset dbmn-table-glass');
            glass.setAttribute('aria-hidden', 'true');
            glass.dataset.icon = 'search';
            this._mirror = make('div', 'search-input-mirror');
            this._mirror.setAttribute('aria-hidden', 'true');
            this._input = make('input', 'search-input');
            this._input.type = 'text';
            this._input.spellcheck = false;
            this._input.autocomplete = 'off';
            this._input.placeholder = this.getAttribute('placeholder') || 'Search rows, or @column=value';
            this._input.setAttribute('aria-label', `Search ${this.getAttribute('label') || 'the rows'}`);
            wrapper.append(glass, this._mirror, this._input);
            container.append(wrapper);
            this._count = make('span', 'search-results dbmn-table-count');
            this._count.setAttribute('role', 'status');
            this._tools.append(container, this._count);
            // What the search is read as, in words, under the box (only while it asks something of a column)
            this._reads = make('div', 'form-hint dbmn-table-reads');
            this._reads.setAttribute('role', 'status');
            this._reads.hidden = true;

            this._scroll = make('div', 'table-container dbmn-table-scroll');
            this._table = make('table', 'data-table dbmn-table-grid');
            if (this.hasAttribute('label')) this._table.setAttribute('aria-label', this.getAttribute('label'));
            this._cols = make('colgroup');
            this._head = make('thead');
            this._above = make('tbody', 'dbmn-table-spacer');
            this._body = make('tbody', 'dbmn-table-body');
            this._below = make('tbody', 'dbmn-table-spacer');
            this._above.setAttribute('aria-hidden', 'true');
            this._below.setAttribute('aria-hidden', 'true');
            this._foot = make('tfoot', 'dbmn-table-foot');
            this._table.append(this._cols, this._head, this._above, this._body, this._below, this._foot);
            this._scroll.append(this._table);
            // (`add-row`: a line under the rows that adds one, ready to type in)
            this._addLine = make('button', 'dbmn-table-add-row');
            this._addLine.type = 'button';
            this._addLine.hidden = true;
            this._addLine.append(make('span', 'dbmn-table-add-icon'), make('span', '', 'Add row'));
            if (window.Icons) window.Icons.setIcon(this._addLine.firstChild, 'plus');
            this._addLine.addEventListener('click', () => this._addRow());
            this.replaceChildren(this._tools, this._reads, this._scroll, this._addLine);
            if (window.Icons) window.Icons.injectIcons(this._tools);

            const matcher = window.SearchMatcher;
            this._input.addEventListener('input', () => this._searched());
            if (matcher && matcher.followScroll) matcher.followScroll(this._input, this._mirror);
            this._suggest(this._input);

            this._scroll.addEventListener('scroll', () => { this._render(false); this._scrolledBy(); }, { passive: true });
            this._head.addEventListener('click', event => {
                const th = event.target.closest('th');
                if (!th) return;
                if (event.target.closest('.col-hide-btn')) {
                    if (th.dataset.group !== undefined && th.dataset.col === undefined) this._removeUnit(this._unitOf(th));
                    else this._remove(this._indexOf(th));
                    return;
                }
                const column = this._columns[this._indexOf(th)];
                if (column && event.target.closest('.col-sort-btn')) {
                    const dir = this._sort && this._sort.id === column.id ? this._sort.dir : '';
                    // One way, the other, then as the rows were given
                    this._sortBy(column, dir === '' ? 'asc' : dir === 'asc' ? 'desc' : null);
                }
            });
            this._head.addEventListener('contextmenu', event => {
                const th = event.target.closest('th');
                if (th) this._menu(event, th);
            });
            this._body.addEventListener('click', event => {
                if (this._nestClick(event)) return;
                // `selectable`: a click on a row (or its box) picks it
                if (this._pickClick(event)) return;
                // Editable: the press on the cell (mousedown) has opened it for typing already
                if (this._editClick(event)) return;
                const td = event.target.closest('td.cell-expandable');
                if (!td) { this._rowEvent('dbmn-table-row', event); return; }
                if (!window.CellDetail || String(window.getSelection())) return;
                const column = this._columns[td.cellIndex];
                // (a screen's cell may name itself better than its column: "SO-1: qty · BL")
                window.CellDetail.open(td.dataset.full || td.textContent, { title: td.dataset.title || (column ? column.name || column.id : undefined) });
            });

            // (a value only cut off by its column's width is not a link: the column widens to show it,
            // and the pointer on it shows it whole; only a long, many-line or structured value opens)

            // A right-click on a row is the screen's (its record, its menu), when it listens for it
            this._body.addEventListener('contextmenu', event => this._rowEvent('dbmn-table-row-menu', event));
            // A double-click on a row: the screen's Open (a picker's Add)
            this._body.addEventListener('dblclick', event => {
                if (this._editable()) return;
                // (a double-click also selects a word: it is an Open, not a selection)
                if (window.getSelection) window.getSelection().removeAllRanges();
                this._rowEvent('dbmn-table-row-open', event);
            });

            const head = window.ColumnHead;
            if (head) {
                // A column's right edge sizes it; a group's sizes its columns, evenly
                const own = th => th.dataset.col !== undefined;
                head.attachResize(this._head, {
                    canResize: th => !!this._sized && (own(th) || th.dataset.group !== undefined),
                    widthOf: th => th.getBoundingClientRect().width,
                    setWidth: (th, width) => (own(th) ? this._setWidth(this._indexOf(th), width) : this._setGroupWidth(th, width)),
                    done: (th, width) => {
                        if (own(th)) this._tell('resized', { id: th.dataset.col, width });
                        else this._groupColumns(th).forEach(c => this._tell('resized', { id: c.id, width: this._widths[c.id] }));
                    },
                    fit: th => (own(th) ? this._fit(this._indexOf(th)) : this._groupColumns(th).forEach(c => this._fit(this._columns.indexOf(c))))
                });
            }
            if (window.ColumnDrag) {
                this._drag = window.ColumnDrag.attach({
                    table: this._table,
                    scroller: this._scroll,
                    canDrag: (th, event) => !!event.target.closest('.column-name.is-movable') && !this._fresh,
                    // Grouped or pinned columns: the places are the groups and the single columns, and a
                    // pinned one never moves (nor anything past it); the table draws itself again on a move
                    units: th => (this._leveled() ? this._levelUnits(th) : this._grouped() ? this._dragUnits() : this._plainUnits(th)),
                    fixed: th => th.dataset.pinned === 'true',
                    onMove: (from, to) => (this._leveled() ? this._movedLevel(from, to) : this._grouped() ? this._movedUnit(this._freeAt(from), this._freeAt(to)) : this._moved(from, to)),
                    // (let go well outside its own: the screen says where it can go)
                    onOutside: () => { if (this._held) this.dispatchEvent(new CustomEvent('dbmn-table-outside', { bubbles: true, detail: { id: this._held.id } })); },
                    // (a press that moved nothing is a click or a right-click: nothing is drawn again, so a menu just opened stays)
                    onEnd: () => {
                        if (!this._dragged) return;
                        const id = this._dragged;
                        this._dragged = null;
                        this._heads();
                        this._render(true);
                        this._tell('moved', { id, to: this._columns.findIndex(c => c.id === id) });
                    }
                });
            }
            this._built = true;
            if (this.hasAttribute('editable')) this._editInit();
        }

        /** Everything again: the columns or the rows changed. */
        _refresh() {
            if (!this._built || !this.isConnected) return;
            this._tools.hidden = !this.hasAttribute('searchable');
            if (this._addLine) this._addLine.hidden = !(this.hasAttribute('add-row') && this._editable());
            this._heads();
            // Many rows given while the box holds a search (a live list): searched a little at a
            // time, as when typing. The rows on screen stay, where they are, until it is done
            if (!this._source && this._rows.length > SEARCH_AT_ONCE && this._terms()) {
                this._stale = true;
                if (!this._sized) this._size();
                this._searchInSlices(true);
                return;
            }
            this._apply();
            if (!this._sized) this._size();
            // (set before it was on the page: the first page is asked for now)
            if (this._source && this._fresh) this._ask(0);
            this._render(true);
            if (!this._source) this._after();
        }

        /* ── A live list: following the newest rows ── */

        _edge() { const at = this.getAttribute('follow'); return at === null ? '' : at === 'bottom' ? 'bottom' : 'top'; }
        get following() { return !!this._edge() && this._following; }
        set following(on) {
            this._following = !!on;
            if (this._following) { this._unseen = 0; this._toEdge(); }
            this._tellFollow();
        }
        _tellFollow() {
            this.dispatchEvent(new CustomEvent('dbmn-table-follow', { bubbles: true, detail: { following: this.following, unseen: this._unseen } }));
        }
        /** Moves the view without it counting as the user scrolling. */
        _hold(move) {
            this._holding = true;
            move();
            requestAnimationFrame(() => { this._holding = false; });
        }
        _toEdge() {
            if (!this._built) return;
            const s = this._scroll;
            this._hold(() => { s.scrollTop = this._edge() === 'bottom' ? s.scrollHeight : 0; });
            this._render(false);
        }
        /** New rows are about to be shown (`more` of them): note where the view is, to keep it there or follow. */
        _before(more) {
            if (!this._edge() || !this._built) { this._pending = null; return; }
            const s = this._scroll;
            // (scrolled away since the last rows, its scroll event not yet heard: it has stopped following)
            if (this._following && !this._atEdge()) this._following = false;
            this._pending = { more: Math.max(0, more), top: s.scrollTop, fromBottom: s.scrollHeight - s.scrollTop, far: !!this._far };
        }
        /** The new rows are drawn: at the newest while following, else exactly where it was, the new ones counted. */
        _after() {
            const was = this._pending;
            this._pending = null;
            if (!was || !this._edge()) return;
            const s = this._scroll;
            // Older rows, at the far end: nothing on screen moves, and nothing new to count
            if (was.far) { this._hold(() => { s.scrollTop = was.top; }); this._render(false); return; }
            if (this._following) this._toEdge();
            else {
                this._unseen += was.more;
                // New rows at the top push the rest down: the view goes down with them
                this._hold(() => { s.scrollTop = this._edge() === 'top' ? s.scrollHeight - was.fromBottom : was.top; });
                this._render(false);
            }
            this._tellFollow();
        }
        _atEdge() {
            const s = this._scroll;
            return this._edge() === 'bottom' ? s.scrollHeight - s.scrollTop - s.clientHeight < 30 : s.scrollTop <= 30;
        }
        /** The user scrolled: away from the newest stops following, back to it starts again. */
        _scrolledBy() {
            if (this._holding || !this._edge()) return;
            const at = this._atEdge();
            if (at === this._following) return;
            this._following = at;
            if (at) this._unseen = 0;
            this._tellFollow();
        }

        /* ── Rows that stay with the screen ── */

        /** Ask again: what is in hand is let go, and the first page asked for. The rows drawn stay until it lands. */
        _again(keep) {
            this._gen += 1;
            this._pages.clear();
            this._asked.clear();
            // (where an open row now sits is not known until its page is in: it closes)
            this._open.clear();
            this._fresh = true;
            this._glass();
            this._keep = keep;
            if (typeof this._source.total === 'number') this._total = this._source.total;
            if (this._built && this.isConnected) { this._ask(0); if (!this._head.firstChild) this._refresh(); }
        }
        _ask(page) {
            if (this._asked.has(page) || this._pages.has(page)) return;
            this._asked.add(page);
            const gen = this._gen;
            let answer;
            try { answer = this._source.page(page * PAGE, PAGE, { search: this.search.trim(), sort: this._sort ? { id: this._sort.id, dir: this._sort.dir } : null }); }
            catch (error) { answer = Promise.reject(error); }
            Promise.resolve(answer).then(got => {
                if (gen !== this._gen) return;   // asked again since: this answer is of rows no longer wanted
                this._asked.delete(page);
                this._pages.set(page, Array.isArray(got) ? got : (got && Array.isArray(got.rows) ? got.rows : []));
                if (got && typeof got.total === 'number') this._total = got.total;
                if (got && !Array.isArray(got)) this._of = typeof got.of === 'number' ? got.of : null;
                this._landed(page);
            }, () => { if (gen === this._gen) this._asked.delete(page); });
        }
        _landed(page) {
            if (this._fresh) {
                if (page !== 0) return;
                this._fresh = false;
                this._glass();
                this._sorting = false;
                this._kinds = null;
                this._types = null;
                this._heads();   // (a sort's clock is its arrow again)
                this._apply();
                if (!this._sized || this._sizedEmpty) { this._unsize(); this._size(); }
                const kept = this._keep;
                if (!this._keep) this._scroll.scrollTop = 0;
                this._keep = false;
                this._rendered = { start: -1, end: -1 };
                this._render(true);
                if (kept) this._after();
                return;
            }
            this._rendered = { start: -1, end: -1 };
            this._render(true);
        }
        /** Row `i` of the rows shown; undefined while its page is on its way. */
        _rowAt(i) {
            if (!this._source) return this._rows[this._view[i]];
            const page = Math.floor(i / PAGE);
            const got = this._pages.get(page);
            if (!got) { this._ask(page); return undefined; }
            return got[i - page * PAGE];
        }
        _length() { return this._source ? this._total : this._view.length; }

        /** Whether a column sorts as numbers (0 to 1) or as text (A to Z): what the screen said, else what its values are. */
        _numbers(column) {
            if (!column) return false;
            if (column.numbers !== undefined) return !!column.numbers;
            if (!this._kinds) this._kinds = {};
            if (this._kinds[column.id] === undefined) {
                const rows = this._source ? (this._pages.get(0) || []) : this._rows;
                let seen = 0, numbers = 0;
                for (let i = 0; i < rows.length && seen < 200; i++) {
                    const value = rows[i] ? rows[i][column.id] : null;
                    if (value === null || value === undefined || value === '') continue;
                    seen += 1;
                    if (typeof value === 'number' || typeof value === 'boolean') numbers += 1;
                }
                if (!rows.length) return false;   // (nothing to look at yet: asked again when there is)
                this._kinds[column.id] = seen > 0 && numbers === seen;
            }
            return this._kinds[column.id];
        }

        /** Tell the screen what changed about the columns, with the layout as it now stands. */
        _tell(change, more) {
            this._recolour();
            this.dispatchEvent(new CustomEvent('dbmn-table-layout', { bubbles: true, detail: Object.assign({ change, layout: this.layout }, more || {}) }));
        }
        /** Measured widths are measured again (the ones the user set stay). */
        _unsize() {
            Object.keys(this._widths).forEach(id => { if (!this._set[id]) delete this._widths[id]; });
            this._sized = false;
            this._sizedEmpty = false;
        }

        /* ── Units: a group of columns, or a column on its own ── */

        _grouped() { return this._columns.some(c => c.group || c.pinned); }

        /* ── Levels: a column moves only among its own (`within`: the objects it sits in) ── */

        _leveled() { return this._columns.some(c => Array.isArray(c.within) && c.within.length); }
        /**
         * The places a column can take: the columns beside it in the same object, each one, or a
         * run of them that sit in an object inside it (moved past as one). Its heading first.
         */
        _levelUnits(th) {
            const i = this._indexOf(th);
            const column = this._columns[i];
            if (!column) return [];
            const path = column.within || [];
            // (a pinned column is no place to move to, and nothing moves past it)
            const inside = c => !c.pinned && path.every((p, k) => (c.within || [])[k] === p);
            let a = i, b = i;
            while (a > 0 && inside(this._columns[a - 1])) a--;
            while (b < this._columns.length - 1 && inside(this._columns[b + 1])) b++;
            const places = [];
            for (let k = a; k <= b; k++) {
                const key = (this._columns[k].within || [])[path.length];
                const last = places[places.length - 1];
                if (key !== undefined && last && last.key === key) last.at.push(k);
                else places.push({ key, at: [k] });
            }
            const rows = Array.from(this._body.rows).filter(r => r.cells.length === this._columns.length);
            const units = places.map(place => {
                const heads = place.at.map(k => this._head.querySelector(`th[data-col="${CSS.escape(this._columns[k].id)}"]`));
                // (its headings move with it too, the first one included: all of an object's columns slide as one)
                const cells = heads.filter(Boolean);
                place.at.forEach(k => rows.forEach(r => cells.push(r.cells[k])));
                // (as wide as all its columns: the drag measures its places by them)
                const first = heads[0], last = heads[heads.length - 1];
                const left = first ? first.offsetLeft : 0;
                const width = last ? last.offsetLeft + last.offsetWidth - left : 0;
                return { head: first, cells, ids: place.at.map(k => this._columns[k].id), left, width };
            }).filter(u => u.head);
            this._held = { id: column.id, units };
            return units;
        }
        /** A place among its own taken: its columns go before (or after) the ones there. */
        _movedLevel(from, to) {
            const units = this._held ? this._held.units : [];
            const moving = units[from], target = units[to];
            if (!moving || !target || from === to) return;
            const gone = new Set(moving.ids);
            const rest = this._columns.filter(c => !gone.has(c.id));
            const block = this._columns.filter(c => gone.has(c.id));
            const anchor = to > from ? target.ids[target.ids.length - 1] : target.ids[0];
            const at = rest.findIndex(c => c.id === anchor) + (to > from ? 1 : 0);
            rest.splice(at, 0, ...block);
            this._columns = rest;
            this._dragged = moving.ids[0];
        }
        /** The columns shown, as the places they move between: a group's columns together, others one by one. */
        _units() {
            const units = [];
            this._columns.forEach((column, index) => {
                const last = units[units.length - 1];
                if (column.group && last && last.group && last.group.id === column.group.id) last.columns.push({ column, index });
                else units.push({ group: column.group || null, pinned: !!column.pinned, columns: [{ column, index }] });
            });
            return units;
        }
        _indexOf(th) {
            const id = th && th.dataset.col;
            return id === undefined ? -1 : this._columns.findIndex(c => c.id === id);
        }
        _unitOf(th) {
            const id = th.dataset.group;
            return this._units().find(u => u.group && u.group.id === id);
        }
        /** A place among the units that move, as a place among all of them (pinned ones never move). */
        _freeAt(n) {
            const free = this._units().map((u, i) => (u.pinned ? -1 : i)).filter(i => i >= 0);
            return free[Math.max(0, Math.min(free.length - 1, n))];
        }
        /** Each unit that moves: its heading and every cell of its columns, the places a drag moves between (column-drag.js). */
        _dragUnits() {
            const rows = Array.from(this._body.rows).concat(Array.from(this._foot.rows));
            return this._units().filter(unit => !unit.pinned).map(unit => {
                const head = unit.group ? this._head.querySelector(`th[data-group="${CSS.escape(unit.group.id)}"]:not([data-col])`)
                    : this._head.querySelector(`th[data-col="${CSS.escape(unit.columns[0].column.id)}"]`);
                const cells = [];
                unit.columns.forEach(({ column, index }) => {
                    if (unit.group) { const sub = this._head.querySelector(`th[data-col="${CSS.escape(column.id)}"]`); if (sub) cells.push(sub); }
                    rows.forEach(r => { if (r.cells.length === this._columns.length && r.cells[index]) cells.push(r.cells[index]); });
                });
                return { head, cells };
            }).filter(u => u.head);
        }
        /** No groups: every heading of the row pressed is a place, its cells moved as the drag goes (column-drag.js's own way). */
        _plainUnits(th) {
            const ths = Array.from(th.parentElement.cells);
            const all = Array.from(this._table.rows).filter(r => r.cells.length === ths.length);
            return ths.map((head, i) => ({ head, index: i, cells: all.map(r => r.cells[i]) }));
        }
        _movedUnit(from, to) {
            const units = this._units();
            const moving = units[from];
            if (!moving || moving.pinned) return;
            units.splice(to, 0, units.splice(from, 1)[0]);
            this._columns = units.flatMap(u => u.columns.map(x => x.column));
            const id = moving.group ? moving.group.id : moving.columns[0].column.id;
            this._heads();
            this._rendered = { start: -1, end: -1 };
            this._render(true);
            this._tell('moved', { id, to });
        }
        _removeUnit(unit) {
            if (!unit || unit.pinned || this.hasAttribute('locked')) return;
            const gone = new Set(unit.columns.map(x => x.column.id));
            if (gone.size >= this._columns.length) return;
            this._columns = this._columns.filter(c => !gone.has(c.id));
            const sorted = this._sort && gone.has(this._sort.id);
            if (sorted) { this._sort = null; if (!this._source) this._apply(); }
            this._heads();
            this._render(true);
            this._tell('removed', { id: unit.group ? unit.group.id : unit.columns[0].column.id, ids: [...gone] });
            if (sorted && this._source) this._again(true);
        }

        _heads() {
            const head = window.ColumnHead;
            const units = this._units();
            const two = units.some(u => u.group);
            const movable = units.filter(u => !u.pinned).length > 1 && !this.hasAttribute('locked');
            const removable = this.hasAttribute('removable') && !this.hasAttribute('locked');
            const top = make('tr');
            const sub = make('tr');
            // One column's heading: its name, its sort, and its edge; `own`: its name moves it
            const columnHead = (column, own) => {
                const name = column.name || column.id;
                const th = make('th', 'sortable-header' + (column.className ? ` ${column.className}` : ''));
                th.dataset.col = column.id;
                if (column.pinned) th.dataset.pinned = 'true';
                const content = make('div', 'flex align-center column-header-content');
                const actions = make('span', 'header-actions');
                const dir = this._sort && this._sort.id === column.id ? this._sort.dir : '';
                th.classList.toggle('sort-asc', dir === 'asc');
                th.classList.toggle('sort-desc', dir === 'desc');
                if (head) {
                    if (column.sortable !== false) actions.append(head.sortButton({ label: name, numbers: this._numbers(column), dir }));
                    if (own && movable && removable && !column.pinned && column.removable !== false) actions.append(head.hideButton({ label: name }));
                }
                const moves = own && movable && !column.pinned;
                const label = make('span', 'column-name' + (moves ? ' is-movable' : ''), name);
                label.title = (moves ? 'Hold and drag to move this column. ' : '') + `@${name}= searches it`;
                // The key: its values one per row
                if (column.key) {
                    th.classList.add('is-key');
                    const key = make('span', 'dbmn-key-mark');
                    if (window.Icons) window.Icons.setIcon(key, 'key-round');
                    label.prepend(key);
                    label.title += '. The key: each value in one row only';
                }
                content.append(label, actions);
                th.append(content);
                if (head) th.append(head.edge());
                if (typeof column.head === 'function') column.head(th);
                return th;
            };
            units.forEach(unit => {
                if (!unit.group) {
                    const th = columnHead(unit.columns[0].column, true);
                    if (two) th.rowSpan = 2;
                    top.append(th);
                    return;
                }
                // A group: its name over its columns; the group moves and is removed as one
                const g = unit.group;
                const th = make('th', 'dbmn-table-group' + (g.className ? ` ${g.className}` : ''));
                th.colSpan = unit.columns.length;
                th.dataset.group = g.id;
                const content = make('div', 'flex align-center column-header-content');
                const actions = make('span', 'header-actions');
                if (head && movable && removable) actions.append(head.hideButton({ label: g.name || g.id }));
                const label = make('span', 'column-name' + (movable ? ' is-movable' : ''), g.name || g.id);
                label.title = movable ? 'Hold and drag to move these columns' : '';
                content.append(label, actions);
                th.append(content);
                if (head) th.append(head.edge());
                if (typeof g.head === 'function') g.head(th);
                top.append(th);
                unit.columns.forEach(({ column }) => {
                    const s = columnHead(column, false);
                    s.dataset.group = g.id;
                    s.classList.add('dbmn-table-sub');
                    sub.append(s);
                });
            });
            this._head.replaceChildren(...(two ? [top, sub] : [top]));
            if (window.Icons) window.Icons.injectIcons(this._head);
            // The second row of headings sits under the first, both in view as the rows scroll
            if (two) requestAnimationFrame(() => { this._table.style.setProperty('--table-head-1', `${top.getBoundingClientRect().height}px`); });
            this._colgroup();
            this._feet();
        }

        /** The totals row, when the screen gave one: under the rows, and it stays in view. */
        _feet() {
            if (!this._totals) { this._foot.replaceChildren(); return; }
            const tr = make('tr');
            this._columns.forEach(column => {
                const value = this._totals[column.id];
                const td = make('td', (column.numbers || typeof value === 'number' ? 'text-right' : '') + (column.wrap ? ' dbmn-cell-wrap' : '') + (column.className ? ` ${column.className}` : ''), value === undefined || value === null ? '' : typeof value === 'number' ? count(value) : String(value));
                tr.append(td);
            });
            this._foot.replaceChildren(tr);
        }

        _colgroup() {
            if (!this._sized) { this._cols.replaceChildren(); return; }
            let sum = 0;
            this._cols.replaceChildren(...this._columns.map(column => {
                const col = make('col');
                const width = this._widths[column.id] || (window.ColumnHead ? window.ColumnHead.MIN_WIDTH : 40);
                col.style.width = `${width}px`;
                sum += width;
                return col;
            }));
            this._table.style.width = `${sum}px`;
        }

        /** Each column as wide as its heading and the first rows need, then held there: scrolling never shifts a column. A narrow table fills its window. */
        _size() {
            if (!this._columns.length || !this._scroll.clientWidth) return;
            this._table.classList.remove('is-sized');
            // Measured at the width its content asks for: not stretched to its box (stretched, the
            // rounded widths add up to a pixel or two more than the box and it scrolls sideways),
            // and not squeezed into it by one long value either
            this._table.style.width = 'max-content';
            this._cols.replaceChildren();
            this._above.replaceChildren();
            this._below.replaceChildren();
            const sample = this._source ? (this._pages.get(0) || []).slice(0, 40)
                : this._stale ? this._rows.slice(0, 40) : this._view.slice(0, 40).map(i => this._rows[i]);
            // (with no rows yet it is sized by its headings, and again when the first rows come)
            this._sizedEmpty = !sample.length;
            this._body.replaceChildren(...sample.map(row => this._row(row)));
            if (!this._head.firstChild) return;
            if (this._body.firstChild) this._rowH = this._body.firstChild.getBoundingClientRect().height || ROW_H;
            // Each column's own heading (under its group's, when it has one), in column order.
            // (in the table's own pixels: a dialog still zooming in draws it smaller for a moment, and
            // widths measured then would cut every value short; offsetWidth is never scaled)
            const drawn = this._table.getBoundingClientRect().width;
            const scale = drawn > 0 && this._table.offsetWidth > 0 ? drawn / this._table.offsetWidth : 1;
            let widths = this._columns.map(c => {
                if (Number(c.width) > 0) return Math.round(Number(c.width));
                const th = this._head.querySelector(`th[data-col="${CSS.escape(c.id)}"]`);
                return th ? Math.min(420, Math.ceil(th.getBoundingClientRect().width / scale)) : 80;
            });
            const sum = widths.reduce((a, b) => a + b, 0);
            const room = this._scroll.clientWidth;
            // A table narrower than its box fills it: the room goes to the data columns. A pinned
            // column (a status, a key, the row numbers) or one given its width keeps what it needs:
            // stretched in proportion, the widest (a status of many tags) would grow the most
            const stays = this._columns.map(c => !!c.pinned || Number(c.width) > 0);
            if (sum < room) {
                // The spare room goes first to a column whose values further down are wider than the
                // first rows it was measured on (they would be cut), up to what they need; what is
                // left, to every data column in proportion
                let spare = room - sum;
                const needs = this._needs(widths, stays);
                const short = needs.map((n, i) => (stays[i] ? 0 : Math.max(0, n - widths[i])));
                const lacking = short.reduce((a, b) => a + b, 0);
                if (lacking > 0) {
                    const give = Math.min(spare, lacking);
                    widths = widths.map((w, i) => w + Math.floor(short[i] * give / lacking));
                    spare = room - widths.reduce((a, b) => a + b, 0);
                }
                const grows = widths.reduce((a, w, i) => a + (stays[i] ? 0 : w), 0);
                if (spare > 0 && grows > 0) widths = widths.map((w, i) => (stays[i] ? w : Math.floor(w * (grows + spare) / grows)));
                else if (spare > 0 && !grows) widths = widths.map(w => Math.floor(w * room / (room - spare)));
            }
            this._columns.forEach((column, i) => { if (!this._widths[column.id]) this._widths[column.id] = widths[i]; });
            this._sized = true;
            this._table.classList.add('is-sized');
            this._colgroup();
            this._rendered = { start: -1, end: -1 };
        }

        /**
         * What each data column's values need, across the rows the table holds (not only the first
         * ones it was measured on): its widest value's text in the cells' own font, and the cell's
         * padding; at most 420 as a measured width is. A column the screen draws itself (render)
         * keeps its measured width.
         */
        _needs(widths, stays) {
            const rows = this._source ? [].concat(...this._pages.values()) : this._rows;
            if (!rows.length || typeof document === 'undefined') return widths.slice();
            const step = Math.max(1, Math.ceil(rows.length / 3000));
            const canvas = this._measure || (this._measure = document.createElement('canvas'));
            const pen = canvas.getContext && canvas.getContext('2d');
            if (!pen) return widths.slice();
            return this._columns.map((column, i) => {
                if (stays[i] || column.render || column.nested) return widths[i];
                // The three longest texts (the widest is nearly always among them)
                const longest = [];
                for (let r = 0; r < rows.length; r += step) {
                    const value = rows[r] ? rows[r][column.id] : null;
                    if (value === null || value === undefined || typeof value === 'object') continue;
                    const text = typeof value === 'number' ? count(value) : String(value);
                    if (longest.length < 3 || text.length > longest[longest.length - 1].length) {
                        longest.push(text);
                        longest.sort((a, b) => b.length - a.length);
                        if (longest.length > 3) longest.pop();
                    }
                }
                if (!longest.length) return widths[i];
                const td = this._body.querySelector(`td:nth-child(${i + 1})`);
                const style = td ? getComputedStyle(td) : null;
                pen.font = style ? style.font : '13px sans-serif';
                const pad = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) + 2 : 20;
                const text = Math.max(...longest.map(t => pen.measureText(t).width));
                return Math.min(420, Math.max(widths[i], Math.ceil(text + pad)));
            });
        }

        _setWidth(i, width) {
            const column = this._columns[i];
            if (!column) return 0;
            const w = Math.max(window.ColumnHead.MIN_WIDTH, Math.round(width));
            this._widths[column.id] = w;
            this._set[column.id] = true;
            this._colgroup();
            return w;
        }

        _groupColumns(th) { return this._columns.filter(c => c.group && c.group.id === th.dataset.group); }
        /** A group as wide as asked: its columns share the width evenly. */
        _setGroupWidth(th, width) {
            const columns = this._groupColumns(th);
            if (!columns.length) return 0;
            const each = Math.max(window.ColumnHead.MIN_WIDTH, Math.round(width / columns.length));
            columns.forEach(c => { this._widths[c.id] = each; this._set[c.id] = true; });
            this._colgroup();
            return each * columns.length;
        }

        /** As wide as its name and the values on screen need. */
        _fit(i) {
            const th = this._columns[i] && this._head.querySelector(`th[data-col="${CSS.escape(this._columns[i].id)}"]`);
            if (!th) return;
            const name = th.querySelector('.column-name');
            const actions = th.querySelector('.header-actions');
            const wide = window.ColumnHead.textWidth;
            let need = wide(name, name.textContent) + actions.offsetWidth + 22;
            Array.from(this._body.rows).forEach(r => { if (!r._main && r.cells[i]) need = Math.max(need, wide(r.cells[i], r.cells[i].textContent) + 20); });
            const width = this._setWidth(i, Math.min(window.ColumnHead.MAX_FIT, need));
            this._tell('resized', { id: this._columns[i].id, width });
        }

        _row(row) {
            // (a row whose page is on its way: empty, and as tall as any other)
            const tr = make('tr', row ? '' : 'dbmn-table-waiting');
            if (row && typeof this.rowClass === 'function') {
                const extra = this.rowClass(row);
                if (extra) tr.className = String(extra);
            }
            if (row && this._picked && this._picked.has(row)) tr.classList.add('is-picked');
            this._columns.forEach(column => {
                const value = row ? row[column.id] : null;
                const td = make('td', (column.numbers || typeof value === 'number' ? 'text-right' : '') + (column.wrap ? ' dbmn-cell-wrap' : '') + (column.className ? ` ${column.className}` : ''));
                if (!row) { td.textContent = '\u00a0'; tr.append(td); return; }
                // Editable: a cell that takes no typing is drawn plain; a yes/no one turns over on a click
                if (this._editable() && !this._canEdit(column, row)) td.classList.add('dbmn-cell-readonly');
                else if (this._editable() && column.editor && column.editor.type === 'checkbox') td.classList.add('dbmn-cell-box');
                if (this._nestCount(column, value, row) > 0) {
                    td.classList.add('has-nested');
                    td.dataset.col = column.id;
                    td.append(this._nest(column, value, row));
                    tr.append(td);
                    return;
                }
                const drawn = column.render ? column.render(value, row) : undefined;
                if (drawn instanceof Node) td.append(drawn);
                else {
                    const text = drawn === undefined ? textOf(value) : String(drawn);
                    td.textContent = text;
                    // (a value cut short by its column's width is whole on hover)
                    if (text.length > 20) td.title = text;
                    if (text.length > LONG || text.includes('\n') || (value && typeof value === 'object') || structured(text)) {
                        td.classList.add('cell-expandable');
                        td.title = 'Click to see it all';
                        td.dataset.full = typeof value === 'object' && value ? JSON.stringify(value) : text;
                    }
                }
                if (typeof column.cell === 'function') column.cell(td, value, row);
                if (column.key) this._markKey(td, column, value);
                if (td.classList.contains('cell-expandable')) expandIcon(td);
                tr.append(td);
            });
            if (row && this._open.size && this._wide.size) this._wideRows(tr, row);
            return tr;
        }

        /** The rows shown: the search's, in the sort's order. */
        _apply() {
            if (this._source) {
                // The screen's rows: it searched and sorted them, and knows how many there are
                this._view = [];
                this._rendered = { start: -1, end: -1 };
                const all = this._total;
                // (`of`: how many there are before the search, when the screen says)
                const of = typeof this._of === 'number' && this._of !== all ? this._of : null;
                const text = of !== null ? `${count(all)} of ${count(of)} rows` : `${count(all)} row${all === 1 ? '' : 's'}`;
                if (this._count.textContent !== text) this._count.textContent = text;
                this.dispatchEvent(new CustomEvent('dbmn-table-shown', { bubbles: true, detail: { shown: all, total: all, text } }));
                return;
            }
            this._run = (this._run || 0) + 1;   // (a search still running in slices is of rows or words no longer wanted)
            this._stale = false;
            const terms = this._terms();
            let view = this._rows.map((_, i) => i);
            if (terms) view = view.filter(i => terms.matches(this._rows[i]));
            this._show(view);
        }
        /** What the search box asks, ready to try on a row; null when it asks nothing. */
        _terms() {
            const matcher = window.SearchMatcher;
            const text = this.search.trim();
            if (!text || !matcher) return null;
            const terms = matcher.parseSearchExpression(text);
            const columns = this._searchColumns();
            const read = this._readField();
            return { matches: row => matcher.matchesRow(terms, row, columns, read) };
        }
        /** What a search reaches: every column (shown or not, the table's own left out) and the screen's hidden fields. */
        _searchColumns() {
            // (`hidden`: not shown. A plain word skips it; `@@word` and `@name` reach it)
            const shown = new Set(this._columns.map(c => c.id));
            const columns = this._all.filter(c => !own(c.id)).map(c => ({ id: c.id, name: c.name || c.id, hidden: !shown.has(c.id) }));
            const fields = (this._fields || []).filter(f => !columns.some(c => c.id === f.id)).map(f => ({ id: f.id, name: f.name || f.id, hidden: true }));
            return columns.concat(fields);
        }
        /** The names of what is searched but not shown: columns removed from view, and the screen's hidden fields. */
        _unseenNames() {
            return this._searchColumns().filter(c => c.hidden).map(c => c.name);
        }
        /** A row's value for a column or a hidden field (a field may say how to read it). */
        _readField() {
            const byId = new Map((this._fields || []).filter(f => typeof f.get === 'function').map(f => [f.id, f.get]));
            return (row, id) => (byId.has(id) ? byId.get(id)(row) : row ? row[id] : undefined);
        }
        /**
         * Fields the search reaches that are not columns (an endpoint's body, a run's headers):
         * [{ id, name, get?(row) }]. `@@word` finds a word in them (a plain word looks only in the
         * columns shown), `@name` names them, `@` suggests them.
         */
        set searchFields(list) {
            this._fields = Array.isArray(list) ? list.filter(f => f && f.id) : [];
            this._types = null;
            if (this._built && this.search.trim()) this._searched();
        }
        get searchFields() { return (this._fields || []).slice(); }
        /** The rows the search found, put in the sort's order and counted. */
        _show(view) {
            if (this._sort) {
                const { id, dir } = this._sort;
                const numbers = this._numbers(this._all.find(c => c.id === id));
                const sign = dir === 'desc' ? -1 : 1;
                view.sort((a, b) => {
                    const x = this._rows[a][id], y = this._rows[b][id];
                    const order = numbers ? (Number(x) || 0) - (Number(y) || 0)
                        : textOf(x).localeCompare(textOf(y), undefined, { numeric: true, sensitivity: 'base' });
                    return order ? sign * order : a - b;
                });
            }
            this._view = view;
            this._places = null;
            this._openAt = null;
            this._rendered = { start: -1, end: -1 };
            const total = this._rows.length;
            const says = view.length === total ? `${count(total)} row${total === 1 ? '' : 's'}` : `${count(view.length)} of ${count(total)} rows`;
            if (this._count.textContent !== says) this._count.textContent = says;
            this.dispatchEvent(new CustomEvent('dbmn-table-shown', { bubbles: true, detail: { shown: view.length, total, text: says } }));
        }
        /**
         * The search over many rows, without holding up the typing: a few milliseconds of rows at
         * a time, giving way to the keyboard between, and dropped the moment another key comes
         * (_searched and _apply move `_run` on). The rows on screen stay until it is done.
         */
        _searchInSlices(keep) {
            const run = this._run = (this._run || 0) + 1;
            const terms = this._terms();
            const rows = this._rows;
            const view = [];
            let i = 0;
            const slice = () => {
                if (run !== this._run || rows !== this._rows) return;
                const until = performance.now() + SEARCH_SLICE_MS;
                while (i < rows.length && performance.now() < until) {
                    const end = Math.min(rows.length, i + 250);
                    for (; i < end; i++) if (!terms || terms.matches(rows[i])) view.push(i);
                }
                if (i < rows.length) { setTimeout(slice, 0); return; }
                this._stale = false;
                this._show(view);
                if (!keep) this._scroll.scrollTop = 0;
                this._render(true);
                if (keep) this._after();
            };
            slice();
        }

        /**
         * A column removed or shown again: searched again (a plain word looks only in the columns
         * shown), so the box's colours and the line under it follow too. Other changes (a width, a
         * sort) leave the search as it is.
         */
        _recolour() {
            const input = this._box();
            const shownNow = this._columns.map(c => c.id).join('\u0001');
            const changed = this._shownBefore !== undefined && this._shownBefore !== shownNow;
            this._shownBefore = shownNow;
            if (!input || !input.value.trim()) return;
            if (changed) { this._searched(); return; }
            const columns = this._searchColumns();
            this._colour(input === this._input ? this._mirror : this._outerMirror, input.value, columns);
            if (input === this._input) { const reads = this._reading(input.value, columns); this._reads.textContent = reads; this._reads.hidden = !reads; }
        }
        _searched() {
            const input = this._box();
            const mirror = input === this._input ? this._mirror : this._outerMirror;
            const text = input ? input.value : '';
            // (a column named that the table does not have shows red in the box; one not shown, purple)
            const columns = this._searchColumns();
            this._colour(mirror, text, columns);
            const reads = this._reading(text, columns);
            if (input === this._input) { this._reads.textContent = reads; this._reads.hidden = !reads; }
            this.dispatchEvent(new CustomEvent('dbmn-table-search', { bubbles: true, detail: { text: text.trim(), reads } }));
            if (this._source) {
                // The screen's rows: asked for again a moment after the last key, from the top
                clearTimeout(this._searchTimer);
                this._searchTimer = setTimeout(() => { if (this._source) this._again(false); }, 250);
                return;
            }
            clearTimeout(this._searchTimer);
            if (this._rows.length > SEARCH_AT_ONCE) {
                // Many rows: the key shows at once (the box is coloured above), and the rows are
                // searched after a pause in the typing; a search already running stops here
                this._run = (this._run || 0) + 1;
                this._searchTimer = setTimeout(() => this._searchInSlices(), SEARCH_PAUSE);
                return;
            }
            this._apply();
            this._scroll.scrollTop = 0;
            this._render(true);
        }

        _sortBy(column, dir) {
            if (this._source) {
                if (this._fresh) return;   // one asking at a time
                // The click is answered at once: the icon is a clock until the rows land
                const at = this._columns.indexOf(column);
                const th = at >= 0 && this._head.firstChild ? this._head.firstChild.cells[at] : null;
                if (th && window.ColumnHead) window.ColumnHead.wait(th.querySelector('.col-sort-btn'), dir || 'asc');
                this._sort = dir ? { id: column.id, dir } : null;
                this._tell('sorted', { id: column.id });
                this._again(false);
                return;
            }
            this._sort = dir ? { id: column.id, dir } : null;
            this._heads();
            this._apply();
            // (a sort is read from its first row, as a search is)
            this._scroll.scrollTop = 0;
            this._render(true);
            this._tell('sorted', { id: column.id });
        }

        _moved(from, to) {
            if (!this._dragged) this._dragged = this._columns[from].id;
            const columns = this._columns.slice();
            columns.splice(to, 0, columns.splice(from, 1)[0]);
            this._columns = columns;
        }

        _moveTo(from, to) {
            if (from === to) return;
            this._moved(from, to);
            const id = this._dragged;
            this._dragged = null;
            this._heads();
            this._render(true);
            this._tell('moved', { id, to });
        }

        _remove(i) {
            if (this._columns.length < 2 || this.hasAttribute('locked')) return;
            const gone = this._columns[i];
            if (!gone || gone.removable === false) return;
            this._columns = this._columns.filter((_, at) => at !== i);
            const sorted = this._sort && this._sort.id === gone.id;
            if (sorted) { this._sort = null; if (!this._source) this._apply(); }
            this._heads();
            this._render(true);
            this._tell('removed', { id: gone.id });
            // (the screen's rows were in that column's order: asked for again as given)
            if (sorted && this._source) this._again(true);
        }

        _menu(event, th) {
            if (!window.DbmnContextMenu || !window.ColumnHead) return;
            const locked = this.hasAttribute('locked');
            const units = this._units();
            const movable = units.filter(u => !u.pinned).length > 1 && !locked;
            // A group's heading: it moves and goes as one
            if (th.dataset.group !== undefined && th.dataset.col === undefined) {
                const at = units.findIndex(u => u.group && u.group.id === th.dataset.group);
                const unit = units[at];
                const firstFree = units.findIndex(u => !u.pinned);
                window.ColumnHead.menu(event, {
                    first: at === firstFree, last: at === units.length - 1,
                    move: movable ? where => this._movedUnit(at, where === 'start' ? firstFree : units.length - 1) : null,
                    remove: movable && this.hasAttribute('removable') ? () => this._removeUnit(unit) : null
                });
                return;
            }
            const i = this._indexOf(th);
            const column = this._columns[i];
            if (!column) return;
            const last = this._columns.length - 1;
            const sorted = this._sort && this._sort.id === column.id;
            // Under a group, or pinned: it sorts and fits; moving and removing are its group's
            const own = !column.group && !column.pinned;
            if (this._leveled() && own) {
                const units = this._levelUnits(th);
                const at = units.findIndex(u => u.ids[0] === column.id);
                const movable_ = units.length > 1 && !locked;
                window.ColumnHead.menu(event, {
                    numbers: this._numbers(column),
                    dir: sorted ? this._sort.dir : '',
                    sorted: !!this._sort,
                    first: at === 0, last: at === units.length - 1,
                    sort: column.sortable === false ? null : dir => this._sortBy(column, dir),
                    move: !movable_ ? null : where => {
                        this._movedLevel(at, where === 'start' ? 0 : units.length - 1);
                        const id = this._dragged;
                        this._dragged = null;
                        this._heads();
                        this._render(true);
                        this._tell('moved', { id, to: this._columns.findIndex(c => c.id === id) });
                    },
                    fit: () => this._fit(i),
                    extra: this._columnEdits(column),
                    remove: last === 0 || !this.hasAttribute('removable') || locked || column.removable === false ? null : () => this._remove(i)
                });
                return;
            }
            const grouped = this._grouped();
            const unitAt = grouped ? units.findIndex(u => u.columns.some(x => x.column.id === column.id)) : i;
            const firstFree = grouped ? units.findIndex(u => !u.pinned) : 0;
            window.ColumnHead.menu(event, {
                numbers: this._numbers(column),
                dir: sorted ? this._sort.dir : '',
                sorted: !!this._sort,
                first: unitAt === firstFree, last: grouped ? unitAt === units.length - 1 : i === last,
                sort: column.sortable === false ? null : dir => this._sortBy(column, dir),
                move: !own || !movable ? null : where => (grouped ? this._movedUnit(unitAt, where === 'start' ? firstFree : units.length - 1) : this._moveTo(i, where === 'start' ? 0 : last)),
                fit: () => this._fit(i),
                extra: this._columnEdits(column),
                remove: !own || last === 0 || !this.hasAttribute('removable') || locked || column.removable === false ? null : () => this._remove(i)
            });
        }

        _spacer(body, height) {
            if (!height) return body.replaceChildren();
            const td = make('td');
            td.colSpan = this._columns.length;
            td.style.height = `${height}px`;
            const tr = make('tr');
            tr.append(td);
            body.replaceChildren(tr);
        }

        /** Draw the rows in view (and a little past them). `force`: even when the ones drawn still cover it. */
        _render(force) {
            if (!this._built || (this._drag && this._drag.isDragging())) return;
            // Asked again and the first page not in yet: the rows drawn stay as they are until it lands
            if (this._source && this._fresh && this._body.firstChild) return;
            // The rows changed and are still being searched: the same
            if (this._stale) return;
            const total = this._length();
            if (!total) {
                this._above.replaceChildren();
                this._below.replaceChildren();
                const searched = !!(this._source ? this.search.trim() : this._rows.length);
                // The screen may say it better (its own filters: "No rows match the filters.")
                const said = typeof this.emptyText === 'function' ? this.emptyText({ searched }) : '';
                const td = make('td', 'dbmn-table-none', this._source && this._fresh ? '' : said || (searched ? 'No rows match the search.' : 'No rows.'));
                td.colSpan = Math.max(1, this._columns.length);
                const tr = make('tr');
                tr.append(td);
                this._body.replaceChildren(tr);
                this._rendered = { start: -1, end: -1 };
                this._editing = null;
                return;
            }
            const box = this._scroll;
            // (records full width are as wide as the window the rows scroll in: they stay in it as the table scrolls sideways)
            if (box.clientWidth) this._table.style.setProperty('--table-nest-room', `${box.clientWidth}px`);
            const open = this._openList();
            if (open.length) { this._renderTall(force, total, open); return; }
            const at = { scrollTop: box.scrollTop, viewportHeight: box.clientHeight || 400, rowHeight: this._rowH, totalRows: total };
            const win = window.VirtualWindow;
            if (!force && !win.needsRender(Object.assign({ rendered: this._rendered, marginPx: 150 }, at))) return;
            const direction = Math.sign(box.scrollTop - this._lastTop);
            this._lastTop = box.scrollTop;
            const seen = win.computeWindow(Object.assign({ overscanAhead: 700, overscanBehind: 350, direction }, at));
            // (an even start keeps the rows' stripes where they were)
            const start = seen.start - (seen.start % 2);
            const rows = [];
            for (let i = start; i < seen.end; i++) rows.push(...this._drawn(this._row(this._rowAt(i))));
            this._body.replaceChildren(...rows);
            if (window.Icons) window.Icons.injectIcons(this._body);
            const pad = win.paddings({ start, end: seen.end, totalRows: total, rowHeight: at.rowHeight });
            this._spacer(this._above, pad.top);
            this._spacer(this._below, pad.bottom);
            this._rendered = { start, end: seen.end };
            if (this._active) this._markActive();
            // Pages far from here are let go: scrolled back to, they are asked for again
            if (this._pages.size > KEEP_PAGES) {
                const here = Math.floor(start / PAGE);
                Array.from(this._pages.keys()).sort((a, b) => Math.abs(b - here) - Math.abs(a - here)).slice(0, this._pages.size - (KEEP_PAGES - 20)).forEach(k => this._pages.delete(k));
            }
        }
    }

    /* ── Rows inside a row: a list of records, opened in its cell ── */
    Object.assign(DbmnTable.prototype, {
        _keyOf(row) { return this.rowKey ? this.rowKey(row) : row; },
        /** How many records the cell holds; 0 when it is not a list of records. */
        _nestCount(column, value, row) {
            if (column.nested && typeof column.nested.count === 'function') return Number(column.nested.count(row)) || 0;
            if (!Array.isArray(value) || !value.length) return 0;
            for (let i = 0; i < Math.min(5, value.length); i++) if (!isRecord(value[i])) return 0;
            return value.length;
        },
        _stateOf(row, id) {
            const cells = this._open.get(this._keyOf(row));
            return cells ? cells.get(id) : undefined;
        },
        /** "3 records" with its chevron and, when open, the records under it: all inside the cell. */
        _nest(column, value, row) {
            const count_ = this._nestCount(column, value, row);
            const state = this._stateOf(row, column.id);
            const wrap = make('div', 'expandable-array dbmn-nest');
            const toggle = make('button', 'expand-toggle dbmn-nest-toggle');
            toggle.type = 'button';
            toggle.setAttribute('aria-expanded', state ? 'true' : 'false');
            const chevron = make('span', 'expand-icon');
            chevron.dataset.icon = state ? 'chevron-down' : 'chevron-right';
            toggle.append(chevron, document.createTextNode(`${count(count_)} record${count_ === 1 ? '' : 's'}`));
            // The screen's own controls beside it (the Console's "Set as Row"): their clicks are the screen's
            const extra = column.nested && typeof column.nested.controls === 'function' ? column.nested.controls(row, value) : null;
            const controls = (Array.isArray(extra) ? extra : extra ? [extra] : []).filter(n => n instanceof Node);
            // Full width, under the row, or in this cell: for every row's records of this column (kept with the layout)
            const wide = this._wide.has(column.id);
            const span = make('button', 'dbmn-nest-span icon');
            span.type = 'button';
            span.dataset.icon = wide ? 'fold-horizontal' : 'unfold-horizontal';
            span.title = wide ? 'Show the records in their cell' : 'Show the records full width, under the row';
            span.setAttribute('aria-label', span.title);
            span.setAttribute('aria-pressed', String(wide));
            const line = make('div', 'array-controls dbmn-nest-controls');
            line.append(toggle, ...controls, span);
            wrap.append(line);
            if (state && !wide) wrap.append(this._nestBody(column, value, row, state));
            return wrap;
        },
        _nestBody(column, value, row, state) {
            const box = make('div', 'array-content dbmn-nest-content');
            if (state.rows === undefined) {
                // Its records come with the row, or are fetched now it is opened
                const got = column.nested && typeof column.nested.rows === 'function' ? column.nested.rows(row) : value;
                if (got && typeof got.then === 'function') {
                    state.rows = null;
                    got.then(rows => { state.rows = Array.isArray(rows) ? rows : []; this._render(true); }, () => { state.rows = []; state.failed = true; this._render(true); });
                } else state.rows = Array.isArray(got) ? got : [];
            }
            if (state.rows === null) { box.append(make('span', 'dbmn-nest-note', 'Fetching the records…')); return box; }
            if (state.failed) { box.append(make('span', 'dbmn-nest-note', 'The records could not be fetched.')); return box; }
            const hidden = this._subHidden[column.id] || {};
            const keys = [];
            state.rows.slice(0, 20).forEach(r => { if (isRecord(r)) Object.keys(r).forEach(k => { if (!keys.includes(k) && !hidden[k]) keys.push(k); }); });
            let rows = state.rows.map((r, i) => ({ r, i }));
            if (state.sort && keys.includes(state.sort.id)) {
                const { id, dir } = state.sort;
                const sign = dir === 'desc' ? -1 : 1;
                const numbers = rows.every(x => x.r[id] === null || x.r[id] === undefined || typeof x.r[id] === 'number' || typeof x.r[id] === 'boolean');
                rows.sort((a, b) => {
                    const x = a.r[id], y = b.r[id];
                    const order = numbers ? (Number(x) || 0) - (Number(y) || 0) : textOf(x).localeCompare(textOf(y), undefined, { numeric: true, sensitivity: 'base' });
                    return order ? sign * order : a.i - b.i;
                });
                state.numbers = numbers;
            }
            const table = make('table', 'data-table nested-data-table dbmn-nest-table');
            table.setAttribute('aria-label', `${column.name || column.id}: its records`);
            const head = make('tr');
            const many = keys.length > 1;
            keys.forEach(key => {
                const th = make('th');
                th.dataset.sub = key;
                const content = make('div', 'flex align-center column-header-content');
                const actions = make('span', 'header-actions');
                const dir = state.sort && state.sort.id === key ? state.sort.dir : '';
                const sample = state.rows.find(r => isRecord(r) && r[key] !== null && r[key] !== undefined);
                const numbers = !!sample && (typeof sample[key] === 'number' || typeof sample[key] === 'boolean');
                if (window.ColumnHead) {
                    actions.append(window.ColumnHead.sortButton({ label: key, numbers, dir }));
                    if (many) actions.append(window.ColumnHead.hideButton({ label: key }));
                }
                content.append(make('span', 'column-name', key), actions);
                th.append(content);
                head.append(th);
            });
            const thead = make('thead');
            thead.append(head);
            const tbody = make('tbody');
            rows.slice(0, NEST_MAX).forEach(({ r }) => {
                const tr = make('tr');
                keys.forEach(key => {
                    const v = isRecord(r) ? r[key] : undefined;
                    const text = textOf(v);
                    const td = make('td', typeof v === 'number' ? 'text-right' : '', text);
                    if (text.length > 20) td.title = text;
                    if (text.length > LONG || text.includes('\n') || (v && typeof v === 'object')) {
                        td.classList.add('cell-expandable');
                        td.title = 'Click to see it all';
                        td.dataset.full = v && typeof v === 'object' ? JSON.stringify(v) : text;
                        td.dataset.name = key;
                        expandIcon(td);
                    }
                    tr.append(td);
                });
                tbody.append(tr);
            });
            table.append(thead, tbody);
            box.append(table);
            if (state.rows.length > NEST_MAX) box.append(make('span', 'dbmn-nest-note', `The first ${NEST_MAX} of ${count(state.rows.length)} records`));
            return box;
        },
        /** A click inside a cell's records: open or close them, sort them, remove one of their columns, see a long value. True when it was one. */
        /** A row drawn, and the rows of its records drawn full width under it. */
        _drawn(tr) { return tr._under ? [tr, ...tr._under] : [tr]; },
        /** Where a drawn row is among the rows (a row of records full width counts as its row's). */
        _mainIndex(tr) {
            const main = tr._main || tr;
            let i = 0;
            for (const r of this._body.rows) {
                if (r === main) return i;
                if (!r._main) i++;
            }
            return -1;
        },
        /** The row drawn at a place among the rows. */
        _mainAt(i) {
            let n = 0;
            for (const r of this._body.rows) {
                if (r._main) continue;
                if (n === i) return r;
                n++;
            }
            return null;
        },
        /** A row's open records of a full-width column: a row of their own under it, across the table. */
        _wideRows(tr, row) {
            const under = [];
            this._columns.forEach(column => {
                if (!this._wide.has(column.id)) return;
                const state = this._stateOf(row, column.id);
                const value = row[column.id];
                const n = this._nestCount(column, value, row);
                if (!state || !n) return;
                const below = make('tr', 'dbmn-nest-wide-row');
                const td = make('td', 'has-nested dbmn-nest-wide');
                td.colSpan = this._columns.length;
                td.dataset.col = column.id;
                const box = make('div', 'dbmn-nest-wide-box');
                box.append(make('div', 'dbmn-nest-wide-name', `${column.name || column.id} · ${count(n)} record${n === 1 ? '' : 's'}`), this._nestBody(column, value, row, state));
                td.append(box);
                below.append(td);
                below._main = tr;
                under.push(below);
            });
            if (under.length) tr._under = under;
        },
        _nestClick(event) {
            const td = event.target.closest('td.has-nested');
            if (!td || !this._body.contains(td)) return false;
            const tr = td.parentElement._main || td.parentElement;
            const index = this._rendered.start + this._mainIndex(tr);
            const row = this._rowAt(index);
            const column = this._all.find(c => c.id === td.dataset.col);
            if (!row || !column) return true;
            const key = this._keyOf(row);
            if (event.target.closest('.dbmn-nest-toggle')) {
                let cells = this._open.get(key);
                if (cells && cells.has(column.id)) {
                    cells.delete(column.id);
                    if (!cells.size) this._open.delete(key);
                } else {
                    if (!cells) { cells = new Map(); this._open.set(key, cells); }
                    cells.set(column.id, { at: index, extra: 0 });
                }
                this._openAt = null;
                this._render(true);
                // (the same chevron takes the keyboard again: the cell was drawn anew)
                let again = this._mainAt(index - this._rendered.start);
                // Opened: its column grows to show the records whole (to a limit, and never a width the user set)
                const inner = again && again.querySelector(`td[data-col="${window.CSS && CSS.escape ? CSS.escape(column.id) : column.id}"] .dbmn-nest-table`);
                if (inner && this._sized && !this._set[column.id]) {
                    const need = Math.min(NEST_WIDE, Math.ceil(inner.getBoundingClientRect().width) + 18);
                    if (need > (this._widths[column.id] || 0)) {
                        this._widths[column.id] = need;
                        this._colgroup();
                        this._render(true);
                        again = this._mainAt(index - this._rendered.start);
                    }
                }
                const button = again && again.querySelector(`td[data-col="${window.CSS && CSS.escape ? CSS.escape(column.id) : column.id}"] .dbmn-nest-toggle`);
                if (button) button.focus({ preventScroll: true });
                return true;
            }
            // Full width or in the cell: every row's records of this column, kept with the layout
            if (event.target.closest('.dbmn-nest-span')) {
                const wide = !this._wide.has(column.id);
                if (wide) this._wide.add(column.id); else this._wide.delete(column.id);
                this._render(true);
                this._tell('records-wide', { id: column.id, wide });
                const again = this._mainAt(index - this._rendered.start);
                const button = again && again.querySelector(`td[data-col="${window.CSS && CSS.escape ? CSS.escape(column.id) : column.id}"] .dbmn-nest-span`);
                if (button) button.focus({ preventScroll: true });
                return true;
            }
            const state = this._stateOf(row, column.id);
            const th = event.target.closest('th[data-sub]');
            if (th && state) {
                const sub = th.dataset.sub;
                if (event.target.closest('.col-sort-btn')) {
                    const dir = state.sort && state.sort.id === sub ? state.sort.dir : '';
                    state.sort = dir === '' ? { id: sub, dir: 'asc' } : dir === 'asc' ? { id: sub, dir: 'desc' } : null;
                    this._render(true);
                } else if (event.target.closest('.col-hide-btn')) {
                    // Gone from every row's records of this column, as a column of the table would be
                    (this._subHidden[column.id] = this._subHidden[column.id] || {})[sub] = true;
                    this._render(true);
                    this._tell('removed', { id: `${column.id}.${sub}`, records: column.id, key: sub });
                }
                return true;
            }
            const cell = event.target.closest('td.cell-expandable');
            if (cell && cell !== td && window.CellDetail && !String(window.getSelection())) {
                window.CellDetail.open(cell.dataset.full || cell.textContent, { title: `${column.name || column.id} · ${cell.dataset.name || ''}` });
            }
            return true;
        },
        /** A click (or right-click) on a row, not on anything with its own action: told with the row. */
        _rowEvent(type, event) {
            const tr = event.target.closest('tr');
            if (!tr || !this._body.contains(tr) || tr.classList.contains('dbmn-table-waiting')) return;
            if (event.target.closest('button, a, input, select, td.has-nested') || String(window.getSelection())) return;
            const index = this._rendered.start + this._mainIndex(tr);
            const row = this._rowAt(index);
            if (!row) return;
            if (type === 'dbmn-table-row-menu') event.preventDefault();
            // (`event`: the click itself, for a menu at the pointer)
            this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: { row, index, event } }));
        },

        /** The rows shown that have records open, in order, each with how much taller it is: [{ index, state… }]. */
        _openList() {
            if (!this._open.size) return [];
            let where = null;
            if (!this._source) {
                // Where each open row sits now (a search or a sort moved it, or took it out of view)
                if (!this._openAt) {
                    this._openAt = new Map();
                    for (let i = 0; i < this._view.length; i++) {
                        const key = this._keyOf(this._rows[this._view[i]]);
                        if (this._open.has(key)) this._openAt.set(key, i);
                    }
                }
                where = this._openAt;
            }
            const list = [];
            this._open.forEach((cells, key) => {
                const first = cells.values().next().value;
                const index = where ? where.get(key) : first.at;
                if (index === undefined) return;
                let extra = 0;
                cells.forEach(state => { extra = Math.max(extra, state.extra || 0); });
                list.push({ index, extra, cells });
            });
            return list.sort((a, b) => a.index - b.index);
        },
        /** The rows in view when some are taller than the rest (their records are open). */
        _renderTall(force, total, open) {
            const box = this._scroll;
            const h = this._rowH;
            const win = this._tall(open, total, h);
            const top = box.scrollTop, tall = box.clientHeight || 400;
            const need = { start: win.indexAt(Math.max(0, top - 150)), end: Math.min(total, win.indexAt(top + tall + 150) + 1) };
            if (!force && this._rendered.start <= need.start && this._rendered.end >= need.end) return;
            this._lastTop = top;
            let start = win.indexAt(Math.max(0, top - 350));
            start -= start % 2;
            const end = Math.min(total, win.indexAt(top + tall + 700) + 1);
            const rows = [], mains = [];
            for (let i = start; i < end; i++) { const tr = this._row(this._rowAt(i)); mains.push(tr); rows.push(...this._drawn(tr)); }
            this._body.replaceChildren(...rows);
            if (window.Icons) window.Icons.injectIcons(this._body);
            this._rendered = { start, end };
            if (this._active) this._markActive();
            // How tall each open row turned out (with its records' own row, full width): the rows under it are placed by that
            open.forEach(o => {
                const tr = o.index >= start && o.index < end ? mains[o.index - start] : null;
                if (!tr) return;
                const under = (tr._under || []).reduce((sum, u) => sum + u.getBoundingClientRect().height, 0);
                const extra = Math.max(0, tr.getBoundingClientRect().height + under - h);
                o.extra = extra;
                o.cells.forEach(state => { state.extra = extra; });
            });
            const placed = this._tall(open, total, h);
            this._spacer(this._above, placed.topOf(start));
            this._spacer(this._below, Math.max(0, placed.height - placed.topOf(end)));
        },
        /** Where rows sit when the open ones are taller: the top of a row, and the row at a height. */
        _tall(open, total, h) {
            const height = total * h + open.reduce((sum, o) => sum + o.extra, 0);
            return {
                height,
                topOf(i) {
                    let top = i * h;
                    for (const o of open) { if (o.index < i) top += o.extra; else break; }
                    return top;
                },
                indexAt(y) {
                    let shift = 0;
                    for (const o of open) {
                        const top = o.index * h + shift;
                        if (y < top) break;
                        if (y < top + h + o.extra) return o.index;
                        shift += o.extra;
                    }
                    return Math.max(0, Math.min(total - 1, Math.floor((y - shift) / h)));
                }
            };
        }
    });


    /* ── Editing (the `editable` attribute): a cell at a time, as a spreadsheet ── */
    Object.assign(DbmnTable.prototype, {
        _editable() { return this.hasAttribute('editable') && !this._source; },
        /** Hold a cell (and bring it into view), as a click does. */
        select(index, id) { this._select(index, id); },
        /** Give cells values, as typing does: told first (dbmn-table-edit), kept, drawn. */
        write(changes, kind) { this._writeCells(changes || [], kind || 'edit'); },
        /** Edit the held cell now, as Enter does. */
        edit() { this._editStart(); },
        /** What a column takes: not one marked editable: false, nor a cell that holds a list of records. */
        _canEdit(column, row) {
            return !!column && column.editable !== false && !(row && this._nestCount(column, row[column.id], row) > 0);
        },
        /** The keys, paste and copy come to a hidden box while the table has hold of them (a page gets the clipboard only in a box). */
        _editInit() {
            if (this._keys) return;
            const keys = make('textarea', 'dbmn-table-keys');
            keys.setAttribute('aria-hidden', 'true');
            keys.tabIndex = -1;
            keys.addEventListener('keydown', event => this._editKey(event));
            keys.addEventListener('paste', event => this._editPaste(event));
            keys.addEventListener('copy', event => this._editCopy(event));
            keys.addEventListener('blur', () => this.classList.remove('is-editing-grid'));
            keys.addEventListener('focus', () => this.classList.add('is-editing-grid'));
            this.append(keys);
            this._keys = keys;
            this._undo = [];
            this._redo = [];
            this._body.addEventListener('mousedown', event => this._editPress(event));
        },
        /**
         * Typing mode: a press on a cell opens it for typing, the caret where it was pressed (the
         * open box keeps its focus: the press is not let take it). A yes/no cell turns over instead.
         */
        _editPress(event) {
            if (!this._editable() || event.button !== 0) return;
            if (event.target.closest('button, a, select, textarea, td.has-nested, .dbmn-cell-input')) return;
            const at = this._cellAt(event.target);
            if (!at) return;
            event.preventDefault();
            const column = this._columns.find(c => c.id === at.id);
            if (column && column.editor && column.editor.type === 'checkbox') {
                this._select(at.index, at.id, { hold: true });
                this._editStart(undefined, {});
                return;
            }
            this._select(at.index, at.id, { caret: this._caretAt(event) });
        },
        /** Where in the cell's text a press landed (the caret goes there), or 'end'. */
        _caretAt(event) {
            const td = event.target.closest('td');
            let node = null, offset = 0;
            if (document.caretPositionFromPoint) {
                const p = document.caretPositionFromPoint(event.clientX, event.clientY);
                if (p) { node = p.offsetNode; offset = p.offset; }
            } else if (document.caretRangeFromPoint) {
                const r = document.caretRangeFromPoint(event.clientX, event.clientY);
                if (r) { node = r.startContainer; offset = r.startOffset; }
            }
            if (!td || !node || node.nodeType !== 3 || !td.contains(node)) return 'end';
            const walk = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
            let before = 0;
            for (let n = walk.nextNode(); n && n !== node; n = walk.nextNode()) before += n.nodeValue.length;
            return before + offset;
        },
        /** The place among the rows shown of a row the page holds (-1: not shown). */
        _indexOfRow(row) {
            return this._source ? -1 : this._view.findIndex(i => this._rows[i] === row);
        },
        /**
         * The open box after the rows are drawn again (a scroll, a check that redraws the marks): it
         * moves into its cell's new drawing with what was typed and the caret. Scrolled out of view,
         * what was typed is kept.
         */
        _keepEditing() {
            const e = this._editing;
            if (e.td.isConnected && e.td.contains(e.input)) return;
            const index = this._indexOfRow(e.row);
            const col = this._columns.findIndex(c => c.id === e.id);
            const tr = index >= 0 ? this._mainAt(index - this._rendered.start) : null;
            const td = tr && col >= 0 ? tr.cells[col] : null;
            if (!td) { e.finish(true, null, true); return; }
            this._active = { index, id: e.id };
            let sel = null;
            try { sel = [e.input.selectionStart, e.input.selectionEnd]; } catch (error) { sel = null; }
            this._openBox(td, e.input, e.text);
            e.td = td;
            e.input.focus({ preventScroll: true });
            try { if (sel && sel[0] !== null) e.input.setSelectionRange(sel[0], sel[1]); } catch (error) { /* (a date box has no caret) */ }
        },
        /**
         * The box laid over its cell: the cell keeps its text, hidden, so it is the size it was, and
         * the box's text starts where the cell's did. Opening a cell moves nothing.
         */
        _openBox(td, input, text) {
            const style = window.getComputedStyle(td);
            const ghost = make('span', 'dbmn-cell-ghost', text || '\u00a0');
            const edge = 2;   // (the box's border)
            input.style.paddingLeft = `${Math.max(0, parseFloat(style.paddingLeft) - edge)}px`;
            input.style.paddingRight = `${Math.max(0, parseFloat(style.paddingRight) - edge)}px`;
            input.style.textAlign = style.textAlign;
            td.classList.add('dbmn-cell-editing');
            td.replaceChildren(ghost, input);
        },
        /** Ctrl+Z / Ctrl+Y: the screen's history when it has one (dbmn-table-undo), else the table's. */
        _undoKey(redo) {
            const asked = new CustomEvent('dbmn-table-undo', { bubbles: true, cancelable: true, detail: { redo } });
            if (!this.dispatchEvent(asked)) return;
            if (redo) this._redoLast(); else this._undoLast();
        },
        /** Tab: the next cell that takes typing, on to the next row's first at the end of one. */
        _tab(dir) {
            const a = this._active;
            if (!a) return;
            const cols = this._columns;
            let index = a.index;
            let c = cols.findIndex(col => col.id === a.id);
            const length = this._length();
            for (let guard = 0; guard < cols.length * 2 + 2; guard++) {
                c += dir;
                if (c >= cols.length) { if (index >= length - 1) { c = cols.length - 1; break; } index += 1; c = 0; }
                if (c < 0) { if (index <= 0) { c = 0; break; } index -= 1; c = cols.length - 1; }
                if (this._canEdit(cols[c], this._rowAt(index))) break;
            }
            this._select(index, cols[c].id);
        },
        /** Where a cell is: the row's place among the rows shown, and its column. */
        _cellAt(target) {
            const td = target && target.closest && target.closest('td');
            if (!td || !this._body.contains(td) || td.parentElement._main || td.parentElement.classList.contains('dbmn-table-waiting')) return null;
            const column = this._columns[td.cellIndex];
            const index = this._rendered.start + this._mainIndex(td.parentElement);
            return column && index >= 0 ? { index, id: column.id } : null;
        },
        /** A click on a cell: the press before it has opened it (_editPress); nothing more to do. */
        _editClick(event) {
            if (!this._editable()) return false;
            if (event.target.closest('.dbmn-cell-input')) return true;
            if (event.target.closest('button, a, input, select, textarea, td.has-nested')) return false;
            return !!this._cellAt(event.target);
        },
        /**
         * Hold a cell; in an editable table it opens for typing straight away (the caret at `how.caret`,
         * a number or 'end'; arriving by a key, its text selected, so typing replaces it). `how.hold`:
         * held only. A cell that takes no typing (editable: false, a yes/no, a list of records) is held.
         */
        _select(index, id, how) {
            const length = this._length();
            if (!length || !this._columns.length) return;
            index = Math.max(0, Math.min(length - 1, index));
            if (!this._columns.some(c => c.id === id)) id = this._columns[0].id;
            if (this._editing) {
                if (this._editing.id === id && this._indexOfRow(this._editing.row) === index) return;
                this._editing.finish(true, null, true);
            }
            this._active = { index, id };
            this._editInit();
            this._intoView();
            this._markActive();
            this._keys.focus({ preventScroll: true });
            if (this._editable() && !(how && how.hold)) this._editStart(undefined, Object.assign({ auto: true }, how));
        },
        /** The held cell drawn as held (it moves with the drawing as the rows scroll). */
        _markActive() {
            if (!this._built) return;
            if (this._editing) this._keepEditing();
            this._body.querySelectorAll('td.dbmn-cell-active').forEach(td => td.classList.remove('dbmn-cell-active'));
            const a = this._active;
            if (!a || this._editing) return;
            const tr = this._mainAt(a.index - this._rendered.start);
            const at = this._columns.findIndex(c => c.id === a.id);
            const td = tr && at >= 0 ? tr.cells[at] : null;
            if (td) td.classList.add('dbmn-cell-active');
        },
        /** The held cell in view: the rows scroll to it, and the columns sideways. */
        _intoView() {
            const a = this._active;
            if (!a) return;
            const s = this._scroll;
            const head = this._head.getBoundingClientRect().height;
            const top = a.index * this._rowH, bottom = top + this._rowH;
            if (top < s.scrollTop) s.scrollTop = top;
            else if (bottom + head > s.scrollTop + s.clientHeight) s.scrollTop = bottom + head - s.clientHeight;
            this._render(false);
            const tr = this._mainAt(a.index - this._rendered.start);
            const td = tr && tr.cells[this._columns.findIndex(c => c.id === a.id)];
            if (td && td.scrollIntoView) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        },
        _move(rows, cols) {
            const a = this._active;
            if (!a) return;
            const at = this._columns.findIndex(c => c.id === a.id);
            const col = this._columns[Math.max(0, Math.min(this._columns.length - 1, at + cols))];
            this._select(a.index + rows, col ? col.id : a.id);
        },
        _editKey(event) {
            const a = this._active;
            if (!a) return;
            // The screen first (its own keys: Ctrl+D, a Tab that adds a row): true means it took the key
            if (typeof this.onCellKey === 'function' && this.onCellKey(event, this.held) === true) { event.preventDefault(); return; }
            const mod = event.ctrlKey || event.metaKey;
            const page = Math.max(1, Math.floor(this._scroll.clientHeight / this._rowH) - 1);
            const k = event.key;
            const undo = mod && (k === 'z' || k === 'Z') && !event.shiftKey;
            const redo = mod && ((k === 'y' || k === 'Y') || ((k === 'z' || k === 'Z') && event.shiftKey));
            if (undo || redo) {
                event.preventDefault();
                this._undoKey(redo);
                return;
            }
            if (mod) return;   // (copy and paste come as their own events)
            const moves = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1], PageDown: [page, 0], PageUp: [-page, 0] };
            if (moves[k]) { event.preventDefault(); this._move(...moves[k]); return; }
            if (k === 'Tab') { event.preventDefault(); this._tab(event.shiftKey ? -1 : 1); return; }
            if (k === 'Home') { event.preventDefault(); this._select(a.index, this._columns[0].id); return; }
            if (k === 'End') { event.preventDefault(); this._select(a.index, this._columns[this._columns.length - 1].id); return; }
            if (k === 'Enter' || k === 'F2') { event.preventDefault(); this._editStart(); return; }
            if (k === 'Escape') { this._active = null; this._markActive(); this._keys.blur(); return; }
            if (k === 'Delete' || k === 'Backspace') { event.preventDefault(); this._writeCells([{ index: a.index, id: a.id, value: '' }], 'edit'); return; }
            // A key that types: the cell is edited, starting from it
            if (k.length === 1 && !event.altKey) { event.preventDefault(); this._editStart(k); }
        },
        /**
         * The held cell becomes a box to type in: Enter keeps it and goes down, Tab across, Up and
         * Down a row, Esc gives it up (the cell stays held). `how`: { auto } it opened by being held
         * (a yes/no is not turned over by that), { caret } where the caret goes.
         */
        _editStart(typed, how) {
            const a = this._active;
            if (!a || this._editing) return;
            const row = this._rowAt(a.index);
            const column = this._columns.find(c => c.id === a.id);
            if (!row || !this._canEdit(column, row)) return;
            const tr = this._mainAt(a.index - this._rendered.start);
            const td = tr && tr.cells[this._columns.indexOf(column)];
            if (!td) return;
            const old = row[column.id];
            const editor = column.editor || {};
            // A yes/no cell: Enter or a double-click turns it over, no box
            if (editor.type === 'checkbox') {
                if (how && how.auto) return;
                const on = /^(true|yes|y|1)$/i.test(textOf(old).trim());
                this._writeCells([{ index: a.index, id: column.id, value: on ? 'false' : 'true' }], 'edit');
                return;
            }
            const input = make('input', 'dbmn-cell-input');
            input.type = 'text';
            input.value = typed !== undefined ? typed : textOf(old);
            // A date, a time, a number: the box the browser has for it, when the value reads as one
            if (editor.type && typed === undefined) {
                const shown = typeof editor.value === 'function' ? editor.value(old) : textOf(old);
                if (shown !== null && shown !== undefined) {
                    try { input.type = editor.type; } catch (error) { input.type = 'text'; }
                    if (editor.type !== 'number') input.value = shown;
                    if (editor.step) input.step = String(editor.step);
                }
            }
            if (editor.type === 'number') input.inputMode = 'decimal';
            input.setAttribute('aria-label', `${column.name || column.id}, row ${a.index + 1}`);
            this._openBox(td, input, textOf(old));
            input.focus();
            const end = input.value.length;
            try {
                if (typed !== undefined) input.setSelectionRange(end, end);
                else if (how && how.caret !== undefined) {
                    const at = how.caret === 'end' ? end : Math.max(0, Math.min(end, how.caret));
                    input.setSelectionRange(at, at);
                } else input.select();
            } catch (error) { /* (a date box has no caret) */ }
            const start = input.value;
            let done = false;
            // `quiet`: the screen has moved things itself (a key it took): no focus taken back
            const finish = (keep, then, quiet) => {
                if (done) return;
                done = true;
                this._editing = null;
                const index = this._indexOfRow(row);
                if (keep && input.value !== textOf(old) && index >= 0) this._writeCells([{ index, row, id: column.id, value: input.value }], 'edit');
                else this._render(true);
                if (then) then();
                this._markActive();
                if (!quiet && !this._editing) this._keys.focus({ preventScroll: true });
            };
            this._editing = { input, td, row, id: column.id, finish, text: textOf(old) };
            const text = input.type === 'text';
            input.addEventListener('keydown', event => {
                // The screen's keys while typing too (Tab at the end of a row adds one)
                if (typeof this.onCellKey === 'function' && this.onCellKey(event, Object.assign({ editing: true, value: input.value }, this.held)) === true) {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(true, null, true);
                    return;
                }
                const k = event.key;
                const mod = event.ctrlKey || event.metaKey;
                // Ctrl+Z with nothing typed here: the table's (or the screen's) last change, and the box opens again
                if (mod && !event.altKey && /^[zZyY]$/.test(k) && input.value === start) {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(false);   // (held while it is undone: the keys stay in the table)
                    this._undoKey(k === 'y' || k === 'Y' || event.shiftKey);
                    const back = this._active;
                    if (back) this._select(back.index, back.id);
                    return;
                }
                const page = Math.max(1, Math.floor(this._scroll.clientHeight / this._rowH) - 1);
                const rows = { Enter: event.shiftKey ? -1 : 1, PageDown: page, PageUp: -page };
                if (text && !event.altKey && !mod) { rows.ArrowDown = 1; rows.ArrowUp = -1; }
                if (rows[k] !== undefined) { event.preventDefault(); finish(true, () => this._move(rows[k], 0)); }
                else if (k === 'Tab') { event.preventDefault(); finish(true, () => this._tab(event.shiftKey ? -1 : 1)); }
                else if (k === 'Escape') { event.preventDefault(); finish(false); }
                event.stopPropagation();
            });
            // A block from a spreadsheet pasted into the box: pasted across and down, as on a held cell
            input.addEventListener('paste', event => {
                const pasted = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
                if (!/[\t\n]/.test(pasted.replace(/[\r\n]+$/, ''))) return;
                event.preventDefault();
                finish(false);
                this._pasteBlock(pasted);
                const back = this._active;
                if (back) this._select(back.index, back.id);
            });
            // A click elsewhere keeps what was typed. Not the box being moved as the rows are drawn
            // again: the browser blurs it on the way, and _keepEditing has it back in focus by now
            input.addEventListener('blur', () => queueMicrotask(() => {
                if (!done && input.isConnected && document.activeElement !== input) finish(true);
            }));
        },
        /** Many cells pasted from a spreadsheet: tab between cells, a line a row, from the held cell. */
        _editPaste(event) {
            const a = this._active;
            if (!a || this._editing) return;
            const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
            if (!text) return;
            event.preventDefault();
            this._pasteBlock(text);
        },
        _pasteBlock(text) {
            const a = this._active;
            if (!a) return;
            // A screen that reads pasted data its own way (commas, pipes, rows to add) takes it here
            const asked = new CustomEvent('dbmn-table-paste', { bubbles: true, cancelable: true, detail: { text, index: a.index, id: a.id } });
            if (!this.dispatchEvent(asked)) return;
            const lines = text.replace(/\r\n?/g, '\n').split('\n');
            if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
            const at = this._columns.findIndex(c => c.id === a.id);
            const changes = [];
            let left = 0;
            lines.forEach((line, r) => {
                line.split('\t').forEach((value, c) => {
                    const column = this._columns[at + c];
                    const index = a.index + r;
                    if (!column || index >= this._length()) { left += 1; return; }
                    changes.push({ index, id: column.id, value });
                });
            });
            this._writeCells(changes, 'paste', left);
        },
        _editCopy(event) {
            const a = this._active;
            if (!a || !event.clipboardData) return;
            const row = this._rowAt(a.index);
            event.preventDefault();
            event.clipboardData.setData('text/plain', row ? textOf(row[a.id]) : '');
        },
        /**
         * Values given to cells: told first (the screen may change a value, or refuse them all), then
         * kept in the rows and drawn. A number stays a number when what was typed reads as one.
         */
        _writeCells(changes, kind, left) {
            const told = changes.map(ch => {
                // (undo and redo go by the row itself: a sort since has moved it)
                const row = ch.row || this._rowAt(ch.index);
                const column = this._columns.find(c => c.id === ch.id);
                if (!row || !this._canEdit(column, row)) return null;
                const old = row[ch.id];
                let value = ch.value;
                if (typeof value === 'string' && typeof old === 'number' && value.trim() !== '' && isFinite(Number(value))) value = Number(value);
                return { row, id: ch.id, index: ch.index, value, old };
            }).filter(Boolean);
            if (!told.length) return;
            const event = new CustomEvent('dbmn-table-edit', { bubbles: true, cancelable: true, detail: { kind, changes: told, left: left || 0 } });
            if (!this.dispatchEvent(event)) { this._render(true); this._markActive(); return; }
            told.forEach(ch => { ch.row[ch.id] = ch.value; });
            this._keyCounts = null;
            if (kind !== 'undo' && kind !== 'redo') { this._undo.push(told); this._redo = []; }
            this._kinds = null;
            this._render(true);
            this._markActive();
        },
        _undoLast() {
            const last = this._undo.pop();
            if (!last) return;
            this._redo.push(last);
            if (last.rows) { this._rowsAgain(last, true); return; }
            this._writeCells(last.map(ch => ({ row: ch.row, index: ch.index, id: ch.id, value: ch.old })), 'undo');
        },
        _redoLast() {
            const last = this._redo.pop();
            if (!last) return;
            this._undo.push(last);
            if (last.rows) { this._rowsAgain(last, false); return; }
            this._writeCells(last.map(ch => ({ row: ch.row, index: ch.index, id: ch.id, value: ch.value })), 'redo');
        }
    });

    /* ── Picking rows (`selectable`): a tick box per row; `selectable="single"`, one row at a time ── */
    Object.assign(DbmnTable.prototype, {
        _single() { return this.getAttribute('selectable') === 'single'; },
        _pickedSet() {
            if (!this._picked) this._picked = new Set();
            return this._picked;
        },
        /** The tick-box column: a box per row, and in its heading one for every row shown (not with `single`). */
        _pickColumn() {
            return {
                id: ROW_PICK, name: '', pinned: true, sortable: false, removable: false, editable: false,
                className: 'dbmn-pick-cell',
                render: (value, row) => {
                    const box = make('input', 'dbmn-pick-box');
                    box.type = this._single() ? 'radio' : 'checkbox';
                    box.tabIndex = -1;
                    box.checked = this._pickedSet().has(row);
                    const at = this._placeOf(row);
                    box.setAttribute('aria-label', `Pick row ${at + 1}`);
                    return box;
                },
                head: th => {
                    th.classList.add('dbmn-pick-cell');
                    // (the column has no name of its own to show)
                    const name = th.querySelector('.column-name');
                    if (name) name.textContent = '';
                    if (this._single()) return;
                    const all = make('input', 'dbmn-pick-all');
                    all.type = 'checkbox';
                    all.setAttribute('aria-label', 'Pick every row shown');
                    const shown = this._view.map(i => this._rows[i]);
                    const n = shown.filter(r => this._pickedSet().has(r)).length;
                    all.checked = n > 0 && n === shown.length;
                    all.indeterminate = n > 0 && n < shown.length;
                    all.addEventListener('click', event => {
                        event.stopPropagation();
                        // (the rows shown now: a search still looking when the heading was drawn has since finished)
                        const now = this._view.map(i => this._rows[i]);
                        const picked = now.filter(r => this._pickedSet().has(r)).length;
                        const on = !(picked > 0 && picked === now.length);
                        now.forEach(r => { if (on) this._pickedSet().add(r); else this._pickedSet().delete(r); });
                        this._pickedChanged();
                    });
                    if (name) name.after(all); else th.prepend(all);
                }
            };
        },
        /** A click on a row (or its box): picked; with `single`, only it. Shift: every row from the last one clicked. */
        _pickClick(event) {
            if (!this.hasAttribute('selectable')) return false;
            if (event.target.closest('button, a, select, textarea, td.has-nested') || (event.target.closest('input') && !event.target.closest('.dbmn-pick-box'))) return false;
            // (text being selected is not a pick; but Shift-click picks a run, whatever text it selected on the way)
            if (event.shiftKey && window.getSelection) window.getSelection().removeAllRanges();
            else if (String(window.getSelection()) && !event.target.closest('.dbmn-pick-box')) return false;
            const tr = event.target.closest('tr');
            if (!tr || !this._body.contains(tr) || tr._main) return false;
            const index = this._rendered.start + this._mainIndex(tr);
            const row = this._rowAt(index);
            if (!row) return false;
            const set = this._pickedSet();
            if (this._single()) {
                set.clear();
                set.add(row);
            } else if (event.shiftKey && this._pickFrom !== undefined) {
                const [a, b] = [Math.min(this._pickFrom, index), Math.max(this._pickFrom, index)];
                for (let i = a; i <= b; i++) { const r = this._rowAt(i); if (r) set.add(r); }
            } else if (set.has(row)) set.delete(row);
            else set.add(row);
            this._pickFrom = index;
            this._pickedChanged();
            // (the row's own click still reaches the screen: dbmn-table-row)
            this._rowEvent('dbmn-table-row', event);
            return true;
        },
        /**
         * The rows drawn show what is picked, changed in place: drawn again, a double-click's second
         * click would land on a new row and never be a double-click (an Open).
         */
        _pickedChanged() {
            const set = this._pickedSet();
            Array.from(this._body.children).forEach(tr => {
                if (tr._main || tr.classList.contains('dbmn-table-waiting')) return;
                const row = this._rowAt(this._rendered.start + this._mainIndex(tr));
                if (!row) return;
                const on = set.has(row);
                tr.classList.toggle('is-picked', on);
                const box = tr.querySelector('input.dbmn-pick-box');
                if (box) box.checked = on;
            });
            this._heads();
            this.dispatchEvent(new CustomEvent('dbmn-table-select', { bubbles: true, detail: { selected: this.selected } }));
        }
    });

    /** The rows picked (`selectable`), in the order the rows were given; set it to pick them. */
    Object.defineProperty(DbmnTable.prototype, 'selected', {
        get() {
            const set = this._pickedSet();
            return this._rows.filter(r => set.has(r));
        },
        set(rows) {
            const set = this._pickedSet();
            set.clear();
            (Array.isArray(rows) ? rows : []).forEach(r => set.add(r));
            if (this._single() && set.size > 1) { const first = set.values().next().value; set.clear(); set.add(first); }
            if (this._built) { this._render(true); this._heads(); }
        }
    });

    /* ── A table people keep (a lookup table): rows added and deleted, columns added, renamed and
          deleted, a key whose values are one per row ── */
    Object.assign(DbmnTable.prototype, {
        /** The row number column (`row-delete`): the row's place, and on hover a bin that deletes it. */
        _gutterColumn() {
            return {
                id: ROW_GUTTER, name: '#', pinned: true, sortable: false, removable: false, editable: false,
                className: 'dbmn-row-gutter',
                render: (value, row) => {
                    const place = this._placeOf(row);
                    const wrap = make('span', 'dbmn-row-cell');
                    const bin = make('button', 'dbmn-row-delete');
                    bin.type = 'button';
                    bin.title = 'Delete row (Ctrl+Z to undo)';
                    bin.setAttribute('aria-label', `Delete row ${place + 1}`);
                    if (window.Icons) window.Icons.setIcon(bin, 'trash-2');
                    // On the press, not the click: a cell open for typing closes on the press and the
                    // rows are drawn again, so the click would land on a bin no longer there
                    bin.addEventListener('mousedown', event => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        this._deleteRow(row);
                    });
                    // (the keyboard's Enter or Space on the bin: a click with no press before it)
                    bin.addEventListener('click', event => { event.stopPropagation(); if (event.detail === 0) this._deleteRow(row); });
                    wrap.append(make('span', 'dbmn-row-num', String(place + 1)), bin);
                    return wrap;
                }
            };
        },
        /** A row's place among the rows shown (-1: not shown). */
        _placeOf(row) {
            if (!this._places) {
                this._places = new Map();
                this._view.forEach((i, at) => this._places.set(this._rows[i], at));
            }
            const at = this._places.get(row);
            return at === undefined ? -1 : at;
        },
        /** Rows added or deleted (and put back): the screen hears dbmn-table-rows { kind, row, index, rows }. */
        _rowsChanged(kind, row, index) {
            this._keyCounts = null;
            this._refresh();
            this.dispatchEvent(new CustomEvent('dbmn-table-rows', { bubbles: true, detail: { kind, row, index, rows: this._rows } }));
        },
        /** `add-row`: an empty row at the end, its first cell open for typing. dbmn-table-add-row first (cancelable; detail.row may be filled). */
        _addRow() {
            if (!this._editable()) return;
            this._editInit();
            const row = {};
            this._columns.forEach(c => { if (!own(c.id)) row[c.id] = ''; });
            const asked = new CustomEvent('dbmn-table-add-row', { bubbles: true, cancelable: true, detail: { row } });
            if (!this.dispatchEvent(asked)) return;
            const added = asked.detail.row || row;
            this._rows.push(added);
            this._undo.push({ rows: 'add', row: added, at: this._rows.length - 1 });
            this._redo = [];
            this._rowsChanged('add', added, this._rows.length - 1);
            const first = this._columns.find(c => this._canEdit(c, added));
            const at = this._placeOf(added);
            if (first && at >= 0) this._select(at, first.id);
        },
        /** `row-delete`: the row goes (Ctrl+Z puts it back). dbmn-table-delete-row first (cancelable). */
        _deleteRow(row) {
            const index = this._rows.indexOf(row);
            if (index < 0) return;
            this._editInit();
            if (this._editing) this._editing.finish(true, null, true);
            const asked = new CustomEvent('dbmn-table-delete-row', { bubbles: true, cancelable: true, detail: { row, index } });
            if (!this.dispatchEvent(asked)) return;
            this._rows.splice(index, 1);
            this._undo.push({ rows: 'delete', row, at: index });
            this._redo = [];
            this._rowsChanged('delete', row, index);
        },
        /** Undo (back) or redo of a row added or deleted. */
        _rowsAgain(entry, back) {
            const remove = (entry.rows === 'add') === back;
            if (remove) {
                const at = this._rows.indexOf(entry.row);
                if (at >= 0) this._rows.splice(at, 1);
                this._rowsChanged('delete', entry.row, at);
            } else {
                this._rows.splice(Math.min(entry.at, this._rows.length), 0, entry.row);
                this._rowsChanged('add', entry.row, entry.at);
            }
        },

        /** `edit-columns`: a column's heading menu renames it, adds one after it, or deletes it. */
        _columnEdits(column) {
            if (!this._editable() || !this.hasAttribute('edit-columns') || own(column.id) || column.editable === false || !window.DbmnModal) return [];
            const data = this._all.filter(c => !own(c.id));
            const items = [
                { id: 'rename', label: 'Rename column…', icon: 'pencil', run: () => this._renameColumn(column) },
                { id: 'add', label: 'Add a column after', icon: 'plus', run: () => this._addColumn(column) }
            ];
            if (data.length > 1) items.push({ id: 'delete', label: 'Delete column', icon: 'trash-2', danger: true, run: () => this._deleteColumn(column) });
            return items;
        },
        /** A column's name, asked for: one no other column has. Resolves to the name, or null. */
        async _askName(title, value, action, mine) {
            const result = await window.DbmnModal.show({
                title,
                fields: [{ id: 'name', type: 'text', label: 'Name', value: value || '', required: true }],
                actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'ok', label: action, variant: 'primary' }]
            });
            if (!result || result.actionId !== 'ok') return null;
            const name = String((result.fields && result.fields.name) || '').trim();
            if (!name) return null;
            if (this._all.some(c => c !== mine && !own(c.id) && String(c.name || c.id).toLowerCase() === name.toLowerCase())) {
                await window.DbmnModal.alert({ title: 'That name is taken', body: `There is already a column named ${name}.` });
                return null;
            }
            return name;
        },
        /** Columns changed: dbmn-table-columns { kind, id, name, … } first (cancelable; the screen may change detail.id). */
        _columnsAsk(detail) {
            const asked = new CustomEvent('dbmn-table-columns', { bubbles: true, cancelable: true, detail });
            return this.dispatchEvent(asked) ? asked.detail : null;
        },
        async _renameColumn(column) {
            const name = await this._askName(`Rename ${column.name || column.id}`, column.name || column.id, 'Rename', column);
            if (!name || name === column.name) return;
            if (!this._columnsAsk({ kind: 'rename', id: column.id, name, old: column.name })) return;
            column.name = name;
            this._refresh();
        },
        async _addColumn(after) {
            const name = await this._askName('Add a column', '', 'Add', null);
            if (!name) return;
            // Its id: the name, made unique (the screen may give its own)
            let id = name;
            for (let n = 2; this._all.some(c => c.id === id); n++) id = `${name} ${n}`;
            const told = this._columnsAsk({ kind: 'add', id, name, after: after.id });
            if (!told) return;
            const column = { id: told.id, name };
            this._all.splice(this._all.indexOf(after) + 1, 0, column);
            this._columns.splice(this._columns.indexOf(after) + 1, 0, column);
            this._rows.forEach(row => { if (!(column.id in row)) row[column.id] = ''; });
            this._sized = false;
            this._refresh();
            const first = this._view.length ? 0 : -1;
            if (first >= 0) this._select(first, column.id);
        },
        async _deleteColumn(column) {
            const name = column.name || column.id;
            const yes = await window.DbmnModal.confirm({ title: `Delete the column ${name}?`, body: 'Its values go from every row.', confirmLabel: 'Delete', confirmVariant: 'danger' });
            if (!yes || !this._columnsAsk({ kind: 'delete', id: column.id, name })) return;
            if (this._editing) this._editing.finish(false, null, true);
            this._all = this._all.filter(c => c !== column);
            this._columns = this._columns.filter(c => c !== column);
            this._rows.forEach(row => { delete row[column.id]; });
            if (this._active && this._active.id === column.id) this._active = null;
            // (its edits can no longer be undone)
            this._undo = (this._undo || []).filter(entry => entry.rows || !entry.some(ch => ch.id === column.id));
            this._redo = [];
            this._sized = false;
            this._keyCounts = null;
            this._refresh();
        },

        /** How many rows hold a key column's value (over every row, not only those shown). */
        _keyCount(id, value) {
            if (!this._keyCounts) this._keyCounts = new Map();
            let counts = this._keyCounts.get(id);
            if (!counts) {
                counts = new Map();
                this._rows.forEach(row => {
                    const v = textOf(row[id]).trim();
                    if (v) counts.set(v, (counts.get(v) || 0) + 1);
                });
                this._keyCounts.set(id, counts);
            }
            return counts.get(textOf(value).trim()) || 0;
        },
        /** A key column's cell: amber when its value is in another row too, or when it has none. */
        _markKey(td, column, value) {
            const text = textOf(value).trim();
            const name = column.name || column.id;
            if (!text) {
                td.classList.add('dbmn-cell-key-missing');
                td.title = `${name} is the key: it needs a value`;
                return;
            }
            const n = this._keyCount(column.id, value);
            if (n > 1) {
                td.classList.add('dbmn-cell-key-duplicate');
                td.title = `${name} ${text} is in ${n} rows: a key is in one row only`;
            }
        }
    });

    /** What stops a table with a key from being kept: [{ row, id, value, kind: 'duplicate' | 'missing' }]. */
    Object.defineProperty(DbmnTable.prototype, 'keyProblems', {
        get() {
            const out = [];
            this._columns.filter(c => c.key).forEach(column => {
                this._rows.forEach(row => {
                    const text = textOf(row[column.id]).trim();
                    if (!text) out.push({ row, id: column.id, value: '', kind: 'missing' });
                    else if (this._keyCount(column.id, text) > 1) out.push({ row, id: column.id, value: text, kind: 'duplicate' });
                });
            });
            return out;
        }
    });

    /** The held cell: { index (among the rows shown), id, row }, or null. */
    Object.defineProperty(DbmnTable.prototype, 'held', {
        get() {
            const a = this._active;
            if (!a) return null;
            return { index: a.index, id: a.id, row: this._rowAt(a.index) };
        }
    });

    customElements.define('dbmn-table', DbmnTable);
})();

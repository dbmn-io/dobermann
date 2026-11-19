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
 *   a long value       cell-detail.js: a click opens it in full
 *
 *   <dbmn-table id="orders" label="Orders" searchable removable></dbmn-table>
 *
 *   orders.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'qty', name: 'qty', numbers: true },
 *                     { id: 'state', name: 'State', render: (value, row) => chipFor(value) }];
 *   orders.rows = [{ order_no: 'SO-10412', qty: 24, state: 'Open' }, …];
 *   orders.addEventListener('dbmn-table-shown', e => …e.detail.shown, e.detail.total…);
 *
 * Attributes: `searchable` (the search box and the count), `removable` (x on a heading),
 * `locked` (columns can be neither moved nor removed), `label` (what the table holds, for a
 * screen reader), `placeholder` (the search box's).
 *
 * A column: { id, name, numbers, type, className (on its heading and its cells: a colour the screen
 * owns), render(value, row) }. `type` ('text', 'number', 'yesno', 'date', 'nested') is what the
 * search box says the column is and which operators it offers; left out, the table looks at the
 * values (a date is ISO 8601 text). No type is ever shown in a heading. `numbers` says the column sorts as numbers (its sort icon is 0 to
 * 1, where text's is A to Z); left out, the table looks at the values: a column of numbers or of
 * true and false sorts as numbers. A value that is a number sits right.
 *
 * ── Rows inside a row ──
 *   A value that is a list of records (an order's lines) shows as "3 records" with a chevron, and
 *   opens INSIDE its cell: a small table with its own headings, which sort and can be removed.
 *   Two such columns in one row each open in their own cell. The first 100 show. What is open
 *   stays open through a search or a sort (it goes by the row, not by where the row sits).
 *   orders.rowKey = row => row.order_no;      // what makes a row the same row; needed with `source`
 *   { id: 'lines', name: 'lines', nested: { count: row => row.lineCount, rows: row => fetchLines(row) } }
 *                                             // records that are fetched when the cell is opened
 *
 * ── Rows that stay with the screen ──
 *   orders.source = { total: 5310, page: (start, count, { search, sort }) => rows | Promise };
 *       Only the pages in view are asked for; a row not yet in is an empty row of the right
 *       height. `page` may answer { rows, total } when only the answer knows how many there are.
 *       The table neither searches nor sorts these: it says what was asked and asks again.
 *   orders.reload();                  // the rows changed (a search, Distinct): ask again, from the top
 *   orders.reload({ keep: true });    // the same, staying where it is (a live refresh)
 *   orders.addEventListener('dbmn-table-search', e => …e.detail.text, e.detail.reads…);   then it asks again itself
 *       (`reads`: the search in words, "Reading this as: placed (date) after 12 Nov 2026", for a
 *       screen to show under its own box; the table shows it under its own)
 *   orders.addEventListener('dbmn-table-layout', e => …e.detail.change, e.detail.layout…);
 *       change: 'sorted' | 'moved' | 'removed' | 'resized', with { id, to, width } as fits;
 *       layout: { order: [ids], hidden: [ids], widths: { id: px } (the ones the user set), sort }.
 *       A sort's icon is a clock until the new rows land. Both events are told for `rows` too.
 *   orders.layout = saved;            // after `columns`: the order, widths, hidden columns and sort kept
 *   orders.searchWith(input, mirror); // the screen's own search box, with the @column suggestions
 *   orders.totals = { qty: '12,410' } // a row under the rows, from the screen; null takes it away
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
    const LONG = 60;
    /** Rows asked for at a time, and how many pages are kept before the furthest are let go. */
    const PAGE = 200;
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
            this.rowKey = null;         // row => what makes it the same row (else the row object itself)
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
            this._all = Array.isArray(list) ? list.slice() : [];
            this._columns = this._all.slice();
            this._sort = null;
            this._widths = {};
            this._set = {};
            this._sized = false;
            this._refresh();
        }
        get columns() { return this._columns.slice(); }

        set rows(list) {
            this._rows = Array.isArray(list) ? list : [];
            this._source = null;
            this._kinds = null;
            this._types = null;
            this._sized = this._sized && Object.keys(this._widths).length > 0;
            // Sized before it had any rows (they came later): sized again now there is something to measure
            if (this._sizedEmpty && this._rows.length) this._unsize();
            this._refresh();
        }
        get rows() { return this._rows; }

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
            if (opts && typeof opts.total === 'number') this._source.total = opts.total;
            this._again(!!(opts && opts.keep));
        }

        /** A row of totals under the rows, by column id, from the screen. */
        set totals(map) {
            this._totals = map && typeof map === 'object' ? map : null;
            if (this._built) this._feet();
        }
        get totals() { return this._totals; }

        /** What a screen saves of the table: the order, the hidden columns, the widths the user set, the sort. */
        get layout() {
            const shown = this._columns.map(c => c.id);
            const widths = {};
            Object.keys(this._set).forEach(id => { if (this._widths[id]) widths[id] = this._widths[id]; });
            return { order: shown, hidden: this._all.map(c => c.id).filter(id => !shown.includes(id)), widths, sort: this._sort ? { id: this._sort.id, dir: this._sort.dir } : null };
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
            this._refresh();
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
                headings: () => this._columns.map(c => c.name || c.id),
                // `@column.` lists the keys inside that column's nested data (of the rows in hand)
                keys: (heading, path) => matcher.nestedKeysFor(this._source ? this._inHand() : this._rows, this._all.map(c => ({ id: c.id, name: c.name || c.id })), heading, path, (row, id) => row[id])
            });
        }
        /** What kind of column a heading names (or a key inside it), for the search box: the screen's word, else what its values are. */
        _typeOf(heading, path) {
            const matcher = window.SearchMatcher;
            const low = String(heading).toLowerCase();
            const column = this._all.find(c => String(c.name || c.id).toLowerCase() === low);
            if (!column || !matcher || !matcher.typeOfValues) return '';
            const inside = path && path.length;
            if (!inside && column.type) return column.type;
            if (!inside && column.numbers) return 'number';
            const key = `${column.id}.${(path || []).join('.')}`;
            if (!this._types) this._types = {};
            if (this._types[key] === undefined) {
                const rows = (this._source ? this._inHand() : this._rows).slice(0, 200);
                let values = rows.map(row => (row ? row[column.id] : null));
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
        _reading(text) {
            const matcher = window.SearchMatcher;
            return matcher && matcher.describeSearch ? matcher.describeSearch(text, this._all.map(c => c.name || c.id), (heading, path) => this._typeOf(heading, path)) : '';
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
            this.replaceChildren(this._tools, this._reads, this._scroll);
            if (window.Icons) window.Icons.injectIcons(this._tools);

            const matcher = window.SearchMatcher;
            this._input.addEventListener('input', () => this._searched());
            if (matcher && matcher.followScroll) matcher.followScroll(this._input, this._mirror);
            this._suggest(this._input);

            this._scroll.addEventListener('scroll', () => this._render(false), { passive: true });
            this._head.addEventListener('click', event => {
                const th = event.target.closest('th');
                if (!th) return;
                const column = this._columns[th.cellIndex];
                if (event.target.closest('.col-sort-btn')) {
                    const dir = this._sort && this._sort.id === column.id ? this._sort.dir : '';
                    // One way, the other, then as the rows were given
                    this._sortBy(column, dir === '' ? 'asc' : dir === 'asc' ? 'desc' : null);
                } else if (event.target.closest('.col-hide-btn')) this._remove(th.cellIndex);
            });
            this._head.addEventListener('contextmenu', event => {
                const th = event.target.closest('th');
                if (th) this._menu(event, th.cellIndex);
            });
            this._body.addEventListener('click', event => {
                if (this._nestClick(event)) return;
                const td = event.target.closest('td.cell-expandable');
                if (!td || !window.CellDetail || String(window.getSelection())) return;
                const column = this._columns[td.cellIndex];
                window.CellDetail.open(td.dataset.full || td.textContent, { title: column ? column.name || column.id : undefined });
            });

            const head = window.ColumnHead;
            if (head) {
                head.attachResize(this._head, {
                    canResize: () => !!this._sized,
                    widthOf: th => th.getBoundingClientRect().width,
                    setWidth: (th, width) => this._setWidth(th.cellIndex, width),
                    done: (th, width) => this._tell('resized', { id: this._columns[th.cellIndex].id, width }),
                    fit: th => this._fit(th.cellIndex)
                });
            }
            if (window.ColumnDrag) {
                this._drag = window.ColumnDrag.attach({
                    table: this._table,
                    scroller: this._scroll,
                    canDrag: (th, event) => !!event.target.closest('.column-name.is-movable') && !this._fresh,
                    onMove: (from, to) => this._moved(from, to),
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
        }

        /** Everything again: the columns or the rows changed. */
        _refresh() {
            if (!this._built || !this.isConnected) return;
            this._tools.hidden = !this.hasAttribute('searchable');
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
                this._landed(page);
            }, () => { if (gen === this._gen) this._asked.delete(page); });
        }
        _landed(page) {
            if (this._fresh) {
                if (page !== 0) return;
                this._fresh = false;
                this._sorting = false;
                this._kinds = null;
                this._types = null;
                this._heads();   // (a sort's clock is its arrow again)
                this._apply();
                if (!this._sized || this._sizedEmpty) { this._unsize(); this._size(); }
                if (!this._keep) this._scroll.scrollTop = 0;
                this._keep = false;
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
            this.dispatchEvent(new CustomEvent('dbmn-table-layout', { bubbles: true, detail: Object.assign({ change, layout: this.layout }, more || {}) }));
        }
        /** Measured widths are measured again (the ones the user set stay). */
        _unsize() {
            Object.keys(this._widths).forEach(id => { if (!this._set[id]) delete this._widths[id]; });
            this._sized = false;
            this._sizedEmpty = false;
        }

        _heads() {
            const head = window.ColumnHead;
            const many = this._columns.length > 1 && !this.hasAttribute('locked');
            const tr = make('tr');
            this._columns.forEach(column => {
                const name = column.name || column.id;
                const th = make('th', 'sortable-header' + (column.className ? ` ${column.className}` : ''));
                const content = make('div', 'flex align-center column-header-content');
                const actions = make('span', 'header-actions');
                const dir = this._sort && this._sort.id === column.id ? this._sort.dir : '';
                th.classList.toggle('sort-asc', dir === 'asc');
                th.classList.toggle('sort-desc', dir === 'desc');
                if (head) {
                    actions.append(head.sortButton({ label: name, numbers: this._numbers(column), dir }));
                    if (many && this.hasAttribute('removable')) actions.append(head.hideButton({ label: name }));
                }
                const label = make('span', 'column-name' + (many ? ' is-movable' : ''), name);
                label.title = (many ? 'Hold and drag to move this column. ' : '') + `@${name}= searches it`;
                content.append(label, actions);
                th.append(content);
                if (head) th.append(head.edge());
                tr.append(th);
            });
            this._head.replaceChildren(tr);
            if (window.Icons) window.Icons.injectIcons(tr);
            this._colgroup();
            this._feet();
        }

        /** The totals row, when the screen gave one: under the rows, and it stays in view. */
        _feet() {
            if (!this._totals) { this._foot.replaceChildren(); return; }
            const tr = make('tr');
            this._columns.forEach(column => {
                const value = this._totals[column.id];
                const td = make('td', (column.numbers || typeof value === 'number' ? 'text-right' : '') + (column.className ? ` ${column.className}` : ''), value === undefined || value === null ? '' : typeof value === 'number' ? count(value) : String(value));
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
            const head = this._head.firstChild;
            if (!head) return;
            if (this._body.firstChild) this._rowH = this._body.firstChild.getBoundingClientRect().height || ROW_H;
            let widths = Array.from(head.cells).map(th => Math.min(420, Math.ceil(th.getBoundingClientRect().width)));
            const sum = widths.reduce((a, b) => a + b, 0);
            const room = this._scroll.clientWidth;
            // A table narrower than its box fills it
            if (sum < room) widths = widths.map(w => Math.floor(w * room / sum));
            this._columns.forEach((column, i) => { if (!this._widths[column.id]) this._widths[column.id] = widths[i]; });
            this._sized = true;
            this._table.classList.add('is-sized');
            this._colgroup();
            this._rendered = { start: -1, end: -1 };
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

        /** As wide as its name and the values on screen need. */
        _fit(i) {
            const th = this._head.firstChild.cells[i];
            const name = th.querySelector('.column-name');
            const actions = th.querySelector('.header-actions');
            const wide = window.ColumnHead.textWidth;
            let need = wide(name, name.textContent) + actions.offsetWidth + 22;
            Array.from(this._body.rows).forEach(r => { if (r.cells[i]) need = Math.max(need, wide(r.cells[i], r.cells[i].textContent) + 20); });
            const width = this._setWidth(i, Math.min(window.ColumnHead.MAX_FIT, need));
            this._tell('resized', { id: this._columns[i].id, width });
        }

        _row(row) {
            // (a row whose page is on its way: empty, and as tall as any other)
            const tr = make('tr', row ? '' : 'dbmn-table-waiting');
            this._columns.forEach(column => {
                const value = row ? row[column.id] : null;
                const td = make('td', (column.numbers || typeof value === 'number' ? 'text-right' : '') + (column.className ? ` ${column.className}` : ''));
                if (!row) { td.textContent = '\u00a0'; tr.append(td); return; }
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
                    if (text.length > LONG || (value && typeof value === 'object')) {
                        td.classList.add('cell-expandable');
                        td.title = 'Click to see it all';
                        td.dataset.full = typeof value === 'object' && value ? JSON.stringify(value) : text;
                    }
                }
                tr.append(td);
            });
            return tr;
        }

        /** The rows shown: the search's, in the sort's order. */
        _apply() {
            if (this._source) {
                // The screen's rows: it searched and sorted them, and knows how many there are
                this._view = [];
                this._rendered = { start: -1, end: -1 };
                const all = this._total;
                const text = `${count(all)} row${all === 1 ? '' : 's'}`;
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
            const columns = this._all.map(c => ({ id: c.id, name: c.name || c.id }));
            return { matches: row => matcher.matchesRow(terms, row, columns, (r, id) => r[id]) };
        }
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
            };
            slice();
        }

        _searched() {
            const input = this._box();
            const mirror = input === this._input ? this._mirror : this._outerMirror;
            const text = input ? input.value : '';
            if (window.SearchMatcher && mirror) window.SearchMatcher.renderHighlight(mirror, text);
            const reads = this._reading(text);
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
            this._columns = this._columns.filter((_, at) => at !== i);
            const sorted = this._sort && this._sort.id === gone.id;
            if (sorted) { this._sort = null; if (!this._source) this._apply(); }
            this._heads();
            this._render(true);
            this._tell('removed', { id: gone.id });
            // (the screen's rows were in that column's order: asked for again as given)
            if (sorted && this._source) this._again(true);
        }

        _menu(event, i) {
            if (!window.DbmnContextMenu || !window.ColumnHead) return;
            const column = this._columns[i];
            const last = this._columns.length - 1;
            const sorted = this._sort && this._sort.id === column.id;
            window.ColumnHead.menu(event, {
                numbers: this._numbers(column),
                dir: sorted ? this._sort.dir : '',
                sorted: !!this._sort,
                first: i === 0, last: i === last,
                sort: dir => this._sortBy(column, dir),
                move: last === 0 || this.hasAttribute('locked') ? null : where => this._moveTo(i, where === 'start' ? 0 : last),
                fit: () => this._fit(i),
                remove: last === 0 || !this.hasAttribute('removable') || this.hasAttribute('locked') ? null : () => this._remove(i)
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
                const td = make('td', 'dbmn-table-none', this._source && this._fresh ? '' : (this._source ? this.search.trim() : this._rows.length) ? 'No rows match the search.' : 'No rows.');
                td.colSpan = Math.max(1, this._columns.length);
                const tr = make('tr');
                tr.append(td);
                this._body.replaceChildren(tr);
                this._rendered = { start: -1, end: -1 };
                return;
            }
            const box = this._scroll;
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
            for (let i = start; i < seen.end; i++) rows.push(this._row(this._rowAt(i)));
            this._body.replaceChildren(...rows);
            if (window.Icons) window.Icons.injectIcons(this._body);
            const pad = win.paddings({ start, end: seen.end, totalRows: total, rowHeight: at.rowHeight });
            this._spacer(this._above, pad.top);
            this._spacer(this._below, pad.bottom);
            this._rendered = { start, end: seen.end };
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
            wrap.append(toggle);
            if (state) wrap.append(this._nestBody(column, value, row, state));
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
                    if (text.length > LONG || (v && typeof v === 'object')) {
                        td.classList.add('cell-expandable');
                        td.title = 'Click to see it all';
                        td.dataset.full = v && typeof v === 'object' ? JSON.stringify(v) : text;
                        td.dataset.name = key;
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
        _nestClick(event) {
            const td = event.target.closest('td.has-nested');
            if (!td || !this._body.contains(td)) return false;
            const tr = td.parentElement;
            const index = this._rendered.start + Array.prototype.indexOf.call(this._body.rows, tr);
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
                let again = this._body.rows[index - this._rendered.start];
                // Opened: its column grows to show the records whole (to a limit, and never a width the user set)
                const inner = again && again.querySelector(`td[data-col="${window.CSS && CSS.escape ? CSS.escape(column.id) : column.id}"] .dbmn-nest-table`);
                if (inner && this._sized && !this._set[column.id]) {
                    const need = Math.min(NEST_WIDE, Math.ceil(inner.getBoundingClientRect().width) + 18);
                    if (need > (this._widths[column.id] || 0)) {
                        this._widths[column.id] = need;
                        this._colgroup();
                        this._render(true);
                        again = this._body.rows[index - this._rendered.start];
                    }
                }
                const button = again && again.querySelector(`td[data-col="${window.CSS && CSS.escape ? CSS.escape(column.id) : column.id}"] .dbmn-nest-toggle`);
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
                    this._tell('removed', { id: `${column.id}.${sub}` });
                }
                return true;
            }
            const cell = event.target.closest('td.cell-expandable');
            if (cell && cell !== td && window.CellDetail && !String(window.getSelection())) {
                window.CellDetail.open(cell.dataset.full || cell.textContent, { title: `${column.name || column.id} · ${cell.dataset.name || ''}` });
            }
            return true;
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
            const rows = [];
            for (let i = start; i < end; i++) rows.push(this._row(this._rowAt(i)));
            this._body.replaceChildren(...rows);
            if (window.Icons) window.Icons.injectIcons(this._body);
            this._rendered = { start, end };
            // How tall each open row turned out: the rows under it are placed by that
            open.forEach(o => {
                const tr = o.index >= start && o.index < end ? this._body.rows[o.index - start] : null;
                if (!tr) return;
                const extra = Math.max(0, tr.getBoundingClientRect().height - h);
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

    customElements.define('dbmn-table', DbmnTable);
})();

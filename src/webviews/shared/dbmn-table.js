// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-table>: a table of rows the page already holds, with everything a DBMN table does,
 * made from the shared pieces the Query, Compare and Console tables are made from:
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
 * `label` (what the table holds, for a screen reader), `placeholder` (the search box's).
 *
 * It draws in the page (no shadow root) and holds no business logic: it shows the rows it is
 * given. What is searched, sorted, moved or resized is the table's own view of them, and the
 * rows given are never changed. A table whose rows stay with the host (Query's and the
 * Console's page them in) still wires the shared pieces itself.
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
            this._sized = false;
            this._refresh();
        }
        get columns() { return this._columns.slice(); }

        set rows(list) {
            this._rows = Array.isArray(list) ? list : [];
            this._sized = this._sized && Object.keys(this._widths).length > 0;
            this._refresh();
        }
        get rows() { return this._rows; }

        /** What the search box holds; set it to search from script. */
        set search(text) { if (this._input) { this._input.value = text || ''; this._searched(); } }
        get search() { return this._input ? this._input.value : ''; }

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
            this._table.append(this._cols, this._head, this._above, this._body, this._below);
            this._scroll.append(this._table);
            this.replaceChildren(this._tools, this._scroll);
            if (window.Icons) window.Icons.injectIcons(this._tools);

            const matcher = window.SearchMatcher;
            this._input.addEventListener('input', () => this._searched());
            if (matcher && matcher.followScroll) matcher.followScroll(this._input, this._mirror);
            if (matcher && matcher.attachColumnSuggest) {
                matcher.attachColumnSuggest({
                    input: this._input,
                    headings: () => this._columns.map(c => c.name || c.id),
                    // `@column.` lists the keys inside that column's nested data
                    keys: (heading, path) => matcher.nestedKeysFor(this._rows, this._all.map(c => ({ id: c.id, name: c.name || c.id })), heading, path, (row, id) => row[id])
                });
            }

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
                    fit: th => this._fit(th.cellIndex)
                });
            }
            if (window.ColumnDrag) {
                this._drag = window.ColumnDrag.attach({
                    table: this._table,
                    scroller: this._scroll,
                    canDrag: (th, event) => !!event.target.closest('.column-name.is-movable'),
                    onMove: (from, to) => this._moved(from, to),
                    // (a press that moved nothing is a click or a right-click: nothing is drawn again, so a menu just opened stays)
                    onEnd: () => { if (!this._dragged) return; this._dragged = false; this._heads(); this._render(true); }
                });
            }
            this._built = true;
        }

        /** Everything again: the columns or the rows changed. */
        _refresh() {
            if (!this._built || !this.isConnected) return;
            this._tools.hidden = !this.hasAttribute('searchable');
            this._heads();
            this._apply();
            if (!this._sized) this._size();
            this._render(true);
        }

        _heads() {
            const head = window.ColumnHead;
            const many = this._columns.length > 1;
            const tr = make('tr');
            this._columns.forEach(column => {
                const name = column.name || column.id;
                const th = make('th', 'sortable-header');
                const content = make('div', 'flex align-center column-header-content');
                const actions = make('span', 'header-actions');
                const dir = this._sort && this._sort.id === column.id ? this._sort.dir : '';
                th.classList.toggle('sort-asc', dir === 'asc');
                th.classList.toggle('sort-desc', dir === 'desc');
                if (head) {
                    actions.append(head.sortButton({ label: name, numbers: !!column.numbers, dir }));
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
            // Measured at the width its content asks for, not stretched to its box: stretched, the
            // rounded widths add up to a pixel or two more than the box and it scrolls sideways
            this._table.style.width = 'auto';
            this._cols.replaceChildren();
            this._above.replaceChildren();
            this._below.replaceChildren();
            this._body.replaceChildren(...this._view.slice(0, 40).map(i => this._row(this._rows[i])));
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
            this._setWidth(i, Math.min(window.ColumnHead.MAX_FIT, need));
        }

        _row(row) {
            const tr = make('tr');
            this._columns.forEach(column => {
                const value = row ? row[column.id] : null;
                const td = make('td', column.numbers ? 'text-right' : '');
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
            const matcher = window.SearchMatcher;
            const text = this.hasAttribute('searchable') && this._input ? this._input.value.trim() : '';
            let view = this._rows.map((_, i) => i);
            if (text && matcher) {
                const terms = matcher.parseSearchExpression(text);
                const columns = this._all.map(c => ({ id: c.id, name: c.name || c.id }));
                view = view.filter(i => matcher.matchesRow(terms, this._rows[i], columns, (row, id) => row[id]));
            }
            if (this._sort) {
                const { id, dir } = this._sort;
                const column = this._all.find(c => c.id === id) || {};
                const sign = dir === 'desc' ? -1 : 1;
                view.sort((a, b) => {
                    const x = this._rows[a][id], y = this._rows[b][id];
                    const order = column.numbers ? (Number(x) || 0) - (Number(y) || 0)
                        : textOf(x).localeCompare(textOf(y), undefined, { numeric: true, sensitivity: 'base' });
                    return order ? sign * order : a - b;
                });
            }
            this._view = view;
            this._rendered = { start: -1, end: -1 };
            const total = this._rows.length;
            const says = view.length === total ? `${count(total)} row${total === 1 ? '' : 's'}` : `${count(view.length)} of ${count(total)} rows`;
            if (this._count.textContent !== says) this._count.textContent = says;
            this.dispatchEvent(new CustomEvent('dbmn-table-shown', { bubbles: true, detail: { shown: view.length, total, text: says } }));
        }

        _searched() {
            if (window.SearchMatcher) window.SearchMatcher.renderHighlight(this._mirror, this._input.value);
            this._apply();
            this._scroll.scrollTop = 0;
            this._render(true);
        }

        _sortBy(column, dir) {
            this._sort = dir ? { id: column.id, dir } : null;
            this._heads();
            this._apply();
            this._render(true);
        }

        _moved(from, to) {
            this._dragged = true;
            const columns = this._columns.slice();
            columns.splice(to, 0, columns.splice(from, 1)[0]);
            this._columns = columns;
        }

        _moveTo(from, to) {
            if (from === to) return;
            this._moved(from, to);
            this._dragged = false;
            this._heads();
            this._render(true);
        }

        _remove(i) {
            if (this._columns.length < 2) return;
            const gone = this._columns[i];
            this._columns = this._columns.filter((_, at) => at !== i);
            if (this._sort && this._sort.id === gone.id) { this._sort = null; this._apply(); }
            this._heads();
            this._render(true);
        }

        _menu(event, i) {
            if (!window.DbmnContextMenu || !window.ColumnHead) return;
            const column = this._columns[i];
            const last = this._columns.length - 1;
            const sorted = this._sort && this._sort.id === column.id;
            window.ColumnHead.menu(event, {
                numbers: !!column.numbers,
                dir: sorted ? this._sort.dir : '',
                sorted: !!this._sort,
                first: i === 0, last: i === last,
                sort: dir => this._sortBy(column, dir),
                move: last === 0 ? null : where => this._moveTo(i, where === 'start' ? 0 : last),
                fit: () => this._fit(i),
                remove: last === 0 || !this.hasAttribute('removable') ? null : () => this._remove(i)
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
            const total = this._view.length;
            if (!total) {
                this._above.replaceChildren();
                this._below.replaceChildren();
                const td = make('td', 'dbmn-table-none', this._rows.length ? 'No rows match the search.' : 'No rows.');
                td.colSpan = Math.max(1, this._columns.length);
                const tr = make('tr');
                tr.append(td);
                this._body.replaceChildren(tr);
                this._rendered = { start: -1, end: -1 };
                return;
            }
            const box = this._scroll;
            const at = { scrollTop: box.scrollTop, viewportHeight: box.clientHeight || 400, rowHeight: this._rowH, totalRows: total };
            const win = window.VirtualWindow;
            if (!force && !win.needsRender(Object.assign({ rendered: this._rendered, marginPx: 150 }, at))) return;
            const direction = Math.sign(box.scrollTop - this._lastTop);
            this._lastTop = box.scrollTop;
            const seen = win.computeWindow(Object.assign({ overscanAhead: 700, overscanBehind: 350, direction }, at));
            // (an even start keeps the rows' stripes where they were)
            const start = seen.start - (seen.start % 2);
            const rows = [];
            for (let i = start; i < seen.end; i++) rows.push(this._row(this._rows[this._view[i]]));
            this._body.replaceChildren(...rows);
            if (window.Icons) window.Icons.injectIcons(this._body);
            const pad = win.paddings({ start, end: seen.end, totalRows: total, rowHeight: at.rowHeight });
            this._spacer(this._above, pad.top);
            this._spacer(this._below, pad.bottom);
            this._rendered = { start, end: seen.end };
        }
    }

    customElements.define('dbmn-table', DbmnTable);
})();

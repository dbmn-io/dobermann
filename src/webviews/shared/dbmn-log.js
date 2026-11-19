// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-log>: log lines as a table, the newest at the top and kept in view (the design system:
 * src/webviews/design-system). The Logs screen uses it; the Console's request log will too, so a
 * line looks the same wherever it shows.
 *
 * It is a <dbmn-table> with the log's columns: Time, Level, Source, Environment, Run, Message.
 * So it searches as every table does, with the same words and `@column` terms:
 * `@level=error`, `@source=sign-in`, `@environment=Test`, `@run=<a run's name or id>`.
 *
 *   <dbmn-log id="log" label="Logs"></dbmn-log>
 *
 *   log.lines = [{ key, time, level, source, message, environment?, run?: { id, name }, detail?, open? }, …];
 *   log.append(newLines);            // new lines, at the top; in view while following
 *   log.older(olderLines);           // older lines, at the bottom: nothing on screen moves
 *   log.following = false;           // stop keeping the newest line in view (scrolling down does too)
 *   log.search = '@level=error';     // what the search box holds
 *   log.text();                      // the lines shown, as text: what Copy copies
 *   log.busy = true;                 // a search is looking: the search box's glass turns into the spinner
 *   log.addEventListener('dbmn-log-shown', e => …e.detail.shown, total, following, unseen…);
 *   log.addEventListener('dbmn-log-end', …);     // scrolled down to the oldest line: time for older ones
 *   log.addEventListener('dbmn-log-open', e => …e.detail.open…);   // a line's `open` clicked
 *
 * Lines are kept in time order whatever order they come in; a line given twice (same `key`)
 * shows once. `time` is milliseconds since 1970; it shows (and is searched) as the computer's own
 * time, 2026-11-19 14:03:22.120. A line with `detail` (a stack, the data it was written with)
 * opens it in full when its message is clicked; one with `open` asks the screen to open it (a
 * request, from its run). Secrets were taken out when each line was written.
 *
 * It draws in the page (no shadow root) and holds no business logic. Needs dbmn-table.js and what
 * it needs, dbmn-level.js and cell-detail.js. Styles: shared/dbmn-log.css over dbmn-table.css.
 */
(function () {
    'use strict';

    if (!window.customElements || customElements.get('dbmn-log')) return;

    /** Within this many pixels of the bottom (or the top) counts as there. */
    const NEAR = 30;

    const pad = (n, w) => String(n).padStart(w || 2, '0');
    /** The computer's own time, as ISO 8601 writes it: what shows is what is searched. */
    function localTime(ms) {
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) return '';
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    }
    const runName = run => (run && (run.name || run.id)) || '';

    const COLUMNS = [
        { id: 'time', name: 'Time' },
        { id: 'level', name: 'Level', render: value => window.DbmnLevel ? window.DbmnLevel.make(value) : value },
        { id: 'source', name: 'Source' },
        { id: 'environment', name: 'Environment' },
        // Searched by its name or its id (@run= looks inside), shown by its name
        { id: 'run', name: 'Run', render: value => runName(value) },
        { id: 'message', name: 'Message', render: (value, row) => message(value, row) }
    ];

    function message(value, row) {
        const span = document.createElement('span');
        span.className = 'dbmn-log-message';
        span.textContent = value || '';
        span.title = value && value.length > 20 ? value : '';
        if (row.open || row.detail || (value && value.length > 120)) {
            span.classList.add('has-detail');
            span.dataset.key = row.key;
            span.title = row.open ? 'Click to see the request' : 'Click to see it all';
        }
        return span;
    }

    function rowOf(line) {
        return {
            key: String(line.key || `a${line.seq}`),
            at: line.time,
            time: localTime(line.time),
            level: line.level,
            source: line.source,
            environment: line.environment || '',
            run: line.run ? { name: line.run.name, id: line.run.id } : undefined,
            message: line.message,
            detail: line.detail,
            open: line.open
        };
    }
    /** Newest first: by time, then key. */
    const newest = (a, b) => b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);

    /** One line as text, then its detail indented under it. */
    function textOf(row) {
        const where = [row.environment, runName(row.run)].filter(Boolean).join(' · ');
        const head = `${row.time}  ${String(row.level || '').toUpperCase().padEnd(5)}  ${row.source}${where ? `  [${where}]` : ''}  ${row.message}`;
        return row.detail ? `${head}\n${String(row.detail).replace(/^/gm, '    ')}` : head;
    }

    class DbmnLog extends HTMLElement {
        constructor() {
            super();
            this._rows = [];        // newest first
            this._keys = new Set();
            this._following = true;
            this._unseen = 0;
            this._built = false;
        }

        connectedCallback() {
            if (this._built) return;
            this._built = true;
            const table = document.createElement('dbmn-table');
            table.setAttribute('searchable', '');
            table.setAttribute('removable', '');
            table.setAttribute('label', this.getAttribute('label') || 'Log lines');
            table.setAttribute('placeholder', this.getAttribute('placeholder') || 'Search the lines, or @level=error, @source=sign-in, @run=…');
            this._table = table;
            this.replaceChildren(table);
            table.columns = COLUMNS;
            table.rows = this._rows;
            this._scroll = table.querySelector('.dbmn-table-scroll');
            if (this._scroll) this._scroll.addEventListener('scroll', () => { this._scrolled(); this._end(); }, { passive: true });
            table.addEventListener('dbmn-table-shown', event => {
                event.stopPropagation();
                this._shown = event.detail;
                this._tell();
            });
            table.addEventListener('click', event => {
                const span = event.target.closest('.dbmn-log-message.has-detail');
                if (!span || String(window.getSelection()) || !window.CellDetail) return;
                const row = this._rows.find(r => r.key === span.dataset.key);
                if (!row) return;
                if (row.open) this.dispatchEvent(new CustomEvent('dbmn-log-open', { bubbles: true, detail: { open: row.open, key: row.key } }));
                else window.CellDetail.open(row.detail ? `${row.message}\n\n${row.detail}` : row.message, { title: `${row.time}  ${row.source}` });
            });
        }

        set lines(list) {
            this._rows = [];
            this._keys = new Set();
            this._add(list);
            this._unseen = 0;
            this._asked = false;
            this._fill();
            this._toTop();
            this._tell();
        }

        /** New lines, at the top. Scrolled down to older ones, the lines on screen stay where they are. */
        append(list) {
            const s = this._scroll;
            const fromBottom = s ? s.scrollHeight - s.scrollTop : 0;
            const added = this._add(list);
            if (!added) return;
            // Scrolled down since (its scroll event not yet heard): stay there
            if (this._following && s && s.scrollTop > NEAR) this._following = false;
            if (!this._following) this._unseen += added;
            this._fill();
            if (this._following) this._toTop();
            else if (s) this._hold(() => { s.scrollTop = s.scrollHeight - fromBottom; });
            this._tell();
        }

        /** Older lines, at the bottom (scrolling down asked for them): nothing on screen moves. */
        older(list) {
            const added = this._add(list);
            this._asked = false;
            if (!added) return;
            const s = this._scroll;
            const top = s ? s.scrollTop : 0;
            this._fill();
            if (s) this._hold(() => { s.scrollTop = top; });
            this._tell();
        }

        /** Put lines in their place by time, newest first; a line already here is not added again. How many were added. */
        _add(list) {
            if (!Array.isArray(list) || !list.length) return 0;
            const fresh = [];
            for (const line of list) {
                const row = rowOf(line);
                if (this._keys.has(row.key)) continue;
                this._keys.add(row.key);
                fresh.push(row);
            }
            if (!fresh.length) return 0;
            fresh.sort(newest);
            const first = this._rows[0];
            const last = this._rows[this._rows.length - 1];
            // Newer than all (live lines) go first, older than all (scrolled back) go last; otherwise everything is put in order
            if (!first || newest(fresh[fresh.length - 1], first) < 0) this._rows.unshift(...fresh);
            else if (newest(fresh[0], last) > 0) this._rows.push(...fresh);
            else { this._rows.push(...fresh); this._rows.sort(newest); }
            return fresh.length;
        }

        /** Scrolled down to the oldest line here: say so once, until older lines come. */
        _end() {
            const s = this._scroll;
            if (this._pinning || this._asked || !s) return;
            if (s.scrollHeight - s.scrollTop - s.clientHeight > NEAR * 3) return;
            this._asked = true;
            this.dispatchEvent(new CustomEvent('dbmn-log-end', { bubbles: true }));
        }

        /** Ask for older lines again (the screen got none, or a search started over). */
        askAgain() {
            this._asked = false;
        }

        get following() { return this._following; }
        set following(on) {
            this._following = !!on;
            if (this._following) { this._unseen = 0; this._toTop(); }
            this._tell();
        }

        /** A search is looking (the screen's, through every line kept): the glass in the search box spins. */
        get busy() { return !!this._busy; }
        set busy(on) {
            this._busy = !!on;
            const glass = this.querySelector('.dbmn-table-glass');
            if (!glass || !window.Icons) return;
            glass.classList.toggle('is-busy', this._busy);
            window.Icons.setIcon(glass, this._busy ? 'loader' : 'search');
        }

        get search() { return this._table ? this._table.search : ''; }
        set search(text) {
            if (this._table) this._table.search = text || '';
        }

        /** The lines the search shows, as they show (newest first unless sorted), as text. */
        text() {
            const rows = this._table && Array.isArray(this._table.shown) ? this._table.shown : this._rows;
            return rows.map(textOf).join('\n');
        }

        /** Give the table the rows (it sizes its columns from the first it gets). */
        _fill() {
            if (this._table) this._table.rows = this._rows;
        }

        /** Move the view without it counting as the user scrolling. */
        _hold(move) {
            this._pinning = true;
            move();
            requestAnimationFrame(() => { this._pinning = false; });
        }

        /** The newest line in view. */
        _toTop() {
            if (!this._scroll) return;
            this._hold(() => { this._scroll.scrollTop = 0; });
        }

        _scrolled() {
            if (this._pinning) return;
            const atTop = this._scroll.scrollTop <= NEAR;
            if (atTop === this._following) return;
            // Scrolled down: the lines stay where they are. Back at the top: following again
            this._following = atTop;
            if (atTop) this._unseen = 0;
            this._tell();
        }

        _tell() {
            const shown = this._shown || { shown: this._rows.length, total: this._rows.length };
            this.dispatchEvent(new CustomEvent('dbmn-log-shown', {
                bubbles: true,
                detail: { shown: shown.shown, total: shown.total, following: this._following, unseen: this._unseen }
            }));
        }
    }

    customElements.define('dbmn-log', DbmnLog);
    window.DbmnLog = DbmnLog;
})();

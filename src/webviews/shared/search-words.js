// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * SearchWords — the word rule of the Hub's search (#444), shared by Endpoints, History
 * and the catalogue service (core).
 *
 * James, 2026-11-12: "I need to be able to go search for post space endpoint name or anything
 * that is in that endpoint... I can't do multiple searches." Plain words match anywhere in a
 * row, in any order, and every word must match. `"two words"` is one phrase; `-word` leaves
 * out rows with it.
 *
 *   SearchWords.parseWords('post "bulk inventory" -paused')
 *     → { include: ['post', 'bulk inventory'], exclude: ['paused'] }
 *   SearchWords.matches(parsed, haystack, extra?)   // extra(word): found elsewhere (History's bodies)
 *   SearchWords.highlight(text, parsed)             // HTML, the words in <mark class="search-hit">
 *   SearchWords.parseQuery(query) / buildQuery(parts)   // `@ get #tag !error ~ 7d` (see below)
 *   SearchWords.attach({ input, candidates, onText })   // the box, with suggestions
 *
 * James, 2026-11-12: the query is just text in the box ("I can just delete things from the search
 * text box"); the screens' query builder (the old filter dialog) writes it there.
 */
(function () {
    'use strict';

    /** Split the typed text into words: `"a phrase"` stays one, `-word` is left out. */
    function parseWords(text) {
        const include = [];
        const exclude = [];
        const re = /(-?)"([^"]*)"?|(\S+)/g;
        let m;
        while ((m = re.exec(String(text || ''))) !== null) {
            let word;
            let negated = false;
            if (m[2] !== undefined) {
                word = m[2];
                negated = m[1] === '-';
            } else {
                word = m[3];
                if (word.length > 1 && word.charAt(0) === '-') {
                    negated = true;
                    word = word.slice(1);
                }
            }
            word = word.trim().toLowerCase();
            // a lone `-` is a word being started, not one to find
            if (!word || word === '-') continue;
            (negated ? exclude : include).push(word);
        }
        return { include, exclude };
    }

    /** Does a row pass? `haystack` is its searchable text (any case). */
    function matches(parsed, haystack, extra) {
        const hay = String(haystack || '').toLowerCase();
        for (const w of parsed.include) {
            if (hay.indexOf(w) === -1 && !(extra && extra(w))) return false;
        }
        for (const w of parsed.exclude) {
            if (hay.indexOf(w) !== -1) return false;
        }
        return true;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** `text` as HTML, the searched-for words in <mark>. */
    function highlight(text, parsed) {
        const raw = String(text == null ? '' : text);
        const words = parsed && parsed.include ? parsed.include.filter(Boolean) : [];
        if (!raw || words.length === 0) return escapeHtml(raw);
        const lower = raw.toLowerCase();
        const marks = new Array(raw.length).fill(false);
        words.forEach(w => {
            let at = lower.indexOf(w);
            while (at !== -1) {
                for (let i = at; i < at + w.length; i++) marks[i] = true;
                at = lower.indexOf(w, at + w.length);
            }
        });
        let out = '';
        let open = false;
        for (let i = 0; i < raw.length; i++) {
            if (marks[i] && !open) { out += '<mark class="search-hit">'; open = true; }
            if (!marks[i] && open) { out += '</mark>'; open = false; }
            out += escapeHtml(raw.charAt(i));
        }
        if (open) out += '</mark>';
        return out;
    }

    // ─── The query: the tables' search (search-matcher.js), on the Hub's lists ──────
    //
    // James, 2026-11-21: one search for the Hub and every table ("once you learn searching in
    // table, you know how to search in the hub"). A list's rows are records of fields, some shown
    // and some not; SearchMatcher reads the box and decides:
    //
    //   words                       in what the list shows, in any order ("a phrase", -word)
    //   @@word                      in every field, shown or not (an endpoint's body, a run's bodies)
    //   @tag=inventory|items        a field's value: either of them; @tag twice, both
    //   @system=current  @env=prod  the current System / environment, or one by name
    //   @status=error  @method=get  @ran>7d  @ran=2026-11-01..2026-11-12
    //
    // The old signs (#tag, @dbmn, !error, ~prod, a bare 7d) went: the box is the tables' box.

    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    /** The fields the filter dialogs write, and the part of the query each fills. */
    const FIELDS = { tags: 'tag', systems: 'system', envs: 'env', statuses: 'status', methods: 'method', dates: 'ran' };
    const PART_OF = { tag: 'tags', system: 'systems', env: 'envs', environment: 'envs', status: 'statuses', method: 'methods', ran: 'dates' };
    const SINCE = /^(\d+)([hdw])$/i;
    const BETWEEN = /^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/;
    const matcher = () => (typeof window !== 'undefined' && window.SearchMatcher) || (typeof require === 'function' ? require('./search-matcher.js') : null);

    /** A value as typed: quoted when it has a space. */
    function formatValue(v) {
        const s = String(v == null ? '' : v);
        return /[\s,|]/.test(s) ? '"' + s.replace(/"/g, '') + '"' : s;
    }

    function emptyQuery() {
        return { methods: [], tags: [], tagGroups: [], systems: [], statuses: [], envs: [], dates: [], words: '', text: '' };
    }

    /**
     * The query's parts, for the filter dialogs to start from: each field's values ('' is the
     * current System / environment), and `text`, everything else as typed (words, @@words, other
     * fields), which a dialog keeps. `words`: the plain words alone (what the list marks).
     *   parseQuery('@system=current @tag=inv|items bulk') →
     *     { systems: [''], tags: ['inv', 'items'], tagGroups: [['inv', 'items']], ..., text: 'bulk', words: 'bulk' }
     */
    function parseQuery(query) {
        const q = emptyQuery();
        const rest = [];
        const words = [];
        const re = /@@(?:"[^"]*"?|\S*)|@("[^"]*"|[^\s=!~<>",|]+)(=|>=|<=|>|<)("[^"]*"?|[^\s",]*)|"[^"]*"?|\S+/g;
        let m;
        while ((m = re.exec(String(query || ''))) !== null) {
            const token = m[0];
            const field = m[1] ? m[1].replace(/^"|"$/g, '').toLowerCase() : '';
            const part = PART_OF[field];
            if (part) {
                const raw = String(m[3] || '');
                const values = raw.charAt(0) === '"' ? [raw.replace(/^"|"$/g, '')] : raw.split('|').filter(Boolean);
                if (part === 'dates') {
                    const v = values[0] || '';
                    if (m[2] === '>' && SINCE.test(v)) { q.dates.push(v.toLowerCase()); continue; }
                    if (m[2] === '=' && BETWEEN.test(v)) { q.dates.push(v); continue; }
                    rest.push(token);
                    continue;
                }
                if (m[2] !== '=') { rest.push(token); continue; }
                const read = values.map(v => ((part === 'systems' || part === 'envs') && v.toLowerCase() === 'current' ? '' : v));
                if (part === 'methods') read.forEach(v => q.methods.push(v.toUpperCase()));
                else if (part === 'tags') { q.tagGroups.push(read); read.forEach(v => q.tags.push(v)); }
                else read.forEach(v => q[part].push(v));
                continue;
            }
            rest.push(token);
            if (token.indexOf('@') !== 0) words.push(token);
        }
        q.text = rest.join(' ');
        q.words = words.join(' ');
        return q;
    }

    /** The query for these parts, always in one order: `@system @env @status @method @tag @ran words`. */
    function buildQuery(q) {
        const out = [];
        const field = (name, values, current) => {
            const list = (values || []).map(v => (current && v === '' ? 'current' : formatValue(v))).filter(Boolean);
            if (list.length) out.push('@' + name + '=' + list.join('|'));
        };
        field('system', q.systems, true);
        field('env', q.envs, true);
        field('status', q.statuses);
        field('method', (q.methods || []).map(x => String(x).toLowerCase()));
        if (q.tagGroups && q.tagGroups.length) q.tagGroups.forEach(g => field('tag', g));
        else field('tag', q.tags);
        (q.dates || []).forEach(d => out.push(SINCE.test(d) ? '@ran>' + d : '@ran=' + d));
        if (String(q.text || '').trim()) out.push(String(q.text).trim());
        return out.join(' ');
    }

    /** Milliseconds a `24h` / `7d` / `2w` date means; null for anything else. */
    function sinceMs(date) {
        const m = SINCE.exec(String(date || ''));
        if (!m) return null;
        return Number(m[1]) * ({ h: 3600e3, d: 86400e3, w: 7 * 86400e3 })[m[2].toLowerCase()];
    }

    /** `{ from, to }` (YYYY-MM-DD, either may be '') of a `2026-11-01..2026-11-12` date; null otherwise. */
    function between(date) {
        const m = BETWEEN.exec(String(date || ''));
        return m ? { from: m[1] || '', to: m[2] || '' } : null;
    }

    /**
     * A row test for the box's query, over a list's fields: [{ id, name?, hidden?, get(row) }].
     * `current`: { system, env } names the current ones are (`@system=current`). Read once per
     * query; `test(row)` is then cheap. An empty query passes every row.
     */
    function rowTest(query, fields, current) {
        const sm = matcher();
        const text = String(query || '').trim();
        if (!text || !sm) return () => true;
        const terms = sm.parseSearchExpression(text);
        const now = current || {};
        // `current` in a System's or environment's value: the current one's name
        (terms.clauses || []).forEach(c => (c.columnTerms || []).forEach(t => {
            const field = PART_OF[String(t.column).toLowerCase()];
            if (field !== 'systems' && field !== 'envs') return;
            const name = field === 'systems' ? now.system : now.env;
            t.values = t.values.map(v => (typeof v === 'string' && v.toLowerCase() === 'current' ? (name || '\u0000none') : v));
        }));
        const columns = fields.map(f => ({ id: f.id, name: f.name || f.id, hidden: !!f.hidden }));
        const byId = new Map(fields.map(f => [f.id, f.get]));
        const read = (row, id) => { const get = byId.get(id); return get ? get(row) : undefined; };
        return row => sm.matchesRow(terms, row, columns, read);
    }

    /** The words of `@@word`s (and `@@"a phrase"`), for a host that searches bodies itself. */
    function deepWords(query) {
        const out = [];
        const re = /(^|\s)-?@@("([^"]*)"?|(\S+))/g;
        let m;
        while ((m = re.exec(String(query || ''))) !== null) {
            const w = (m[3] !== undefined ? m[3] : m[4] || '').trim().toLowerCase();
            if (w) out.push(w);
        }
        return out;
    }

    /**
     * The key to the box, for Build a search (a <dl>, coloured as the box colours it).
     * `history` adds History's own fields: status, environment, when it ran.
     */
    function legendHtml(history) {
        const rows = [
            ['words', 'in what the list shows, in any order'],
            ['"two words"  -word', 'together / without it'],
            ['@@word', 'anywhere, the body too'],
            ['@method=get|post', 'either of them; @ lists the fields'],
            ['@tag=inventory', 'a tag'],
            ['@system=current', 'the current System, or one by name']
        ];
        if (history) rows.push(['@status=error', 'a status'], ['@env=current', 'the current environment, or one by name'], ['@ran>7d', 'since then']);
        const sm = matcher();
        const paint = text => {
            if (!sm || !sm.tokenizeForDisplay) return escapeHtml(text);
            return sm.tokenizeForDisplay(text).map(seg => '<span class="search-tok search-tok-' + seg.kind + '">' + escapeHtml(seg.text) + '</span>').join('');
        };
        return '<dl class="dbmn-filter-legend" data-help="hub#search">' + rows.map(r =>
            '<dt>' + paint(r[0]) + '</dt><dd>' + escapeHtml(r[1]) + '</dd>').join('') + '</dl>';
    }

    /**
     * The search box: the tables' box on a Hub list. The query is the text in it; nothing else
     * holds filter state. It is coloured as a table's (a field the list doesn't show, purple),
     * and `@` lists the list's fields, shown then not, then each field's values with counts.
     *
     *   SearchWords.attach({ input, fields: () => ({ headings, hidden }), values: heading => [{ value, count }], onText })
     *     → { setText(query) }   // the filter dialogs and "Show history" write the box
     */
    function attach(opts) {
        const input = opts && opts.input;
        if (!input) return { refresh() {}, setText() {} };
        const sm = matcher();
        const box = input.parentElement;
        // The query in colour, behind the box's (transparent) text
        const mirror = document.createElement('div');
        mirror.className = 'search-box-mirror';
        mirror.setAttribute('aria-hidden', 'true');
        box.insertBefore(mirror, input);
        box.classList.add('has-mirror');
        const fields = () => (opts.fields ? opts.fields() : { headings: [], hidden: [] });

        // A long query wraps: the box grows to fit it (a textarea, one line to start)
        const fit = () => {
            const f = fields();
            if (sm && sm.renderHighlight) sm.renderHighlight(mirror, input.value, f.headings, f.hidden);
            else mirror.textContent = input.value;
            // (a last line break holds the height of a trailing empty line)
            mirror.appendChild(document.createTextNode('\n'));
            if (input.tagName !== 'TEXTAREA') return;
            // Empty: the natural one line (the placeholder must not make it taller)
            input.style.height = '';
            if (input.value) {
                // scrollHeight leaves out the border: short by it, the text would scroll up
                // inside the box and part from its coloured copy (James, 2026-11-12)
                const borders = input.offsetHeight - input.clientHeight;
                input.style.height = (input.scrollHeight + borders) + 'px';
            }
            input.scrollTop = 0;
        };
        const changed = () => { fit(); if (opts.onText) opts.onText(input.value); };
        // (whether the `@` list was open as a key came, before its own handling closes it: Esc
        // then closes the list only, and a second Esc clears the box)
        let listOpen = false;
        input.addEventListener('keydown', () => { listOpen = !!box.querySelector('.column-suggest:not([hidden])'); }, true);
        // `@`: the list's fields, then a field's values (the tables' list, shared)
        if (sm && sm.attachColumnSuggest) {
            sm.attachColumnSuggest({
                input,
                headings: () => fields().headings,
                hidden: () => fields().hidden,
                values: opts.values
            });
        }

        input.addEventListener('input', () => {
            // One line of query: a pasted line break is a space
            if (/[\r\n]/.test(input.value)) {
                const at = input.selectionStart;
                input.value = input.value.replace(/\r?\n/g, ' ');
                input.setSelectionRange(at, at);
            }
            changed();
        });
        input.addEventListener('keydown', (e) => {
            const open = listOpen;
            if (e.key === 'Enter' && !open) {
                e.preventDefault();
            } else if (e.key === 'Escape' && !open && input.value) {
                // Esc clears the box; with nothing to do it is the Hub's (it closes the list panel)
                e.preventDefault();
                e.stopPropagation();
                input.value = '';
                changed();
            }
        });
        // and again when the list panel is resized
        if (typeof ResizeObserver === 'function') new ResizeObserver(() => fit()).observe(box);
        fit();
        return {
            refresh() { fit(); },
            setText(text) {
                input.value = text || '';
                fit();
            }
        };
    }

    const api = { attach, parseWords, matches, highlight, parseQuery, buildQuery, formatValue, rowTest, deepWords, sinceMs, between, legendHtml, METHODS, FIELDS };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        window.SearchWords = api;
    }
})();

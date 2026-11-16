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

    // ─── The query: short signs, then the plain words ───────────────────
    //
    // James, 2026-11-12: "even just single characters... it doesn't have to read too well, but
    // it's gonna be intuitive". The same rule for Endpoints and History:
    //
    //   get post put patch delete   the method (a bare word; "get" in quotes is the word)
    //   #inventory  #"puppy school" a tag
    //   @  /  @dbmn                 the current System / that System
    //   !error                      a status (History)
    //   ~  /  ~prod                 the current environment / that one (History)
    //   24h  7d  2w                 since then (History); 2026-11-01..2026-11-12 between
    //   anything else               words, in any order; "a phrase"; -word leaves out

    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    /** The signs, and the part of the query each one fills. */
    const SIGNS = { '#': 'tags', '@': 'systems', '!': 'statuses', '~': 'envs' };
    const SIGN_OF = { tags: '#', systems: '@', statuses: '!', envs: '~' };
    const SINCE = /^(\d+)([hdw])$/i;
    const BETWEEN = /^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/;

    /** A value as typed: quoted when it has a space. */
    function formatValue(v) {
        const s = String(v == null ? '' : v);
        return /\s/.test(s) ? '"' + s.replace(/"/g, '') + '"' : s;
    }

    function emptyQuery() {
        return { methods: [], tags: [], systems: [], statuses: [], envs: [], dates: [], text: '' };
    }

    /**
     * The query's parts. `systems` / `envs` hold '' for the current one.
     *   parseQuery('@ get #"puppy school" bulk') →
     *     { systems: [''], methods: ['GET'], tags: ['puppy school'], ..., text: 'bulk' }
     */
    function parseQuery(query) {
        const q = emptyQuery();
        const rest = [];
        const re = /([#@!~])"([^"]*)"?|"[^"]*"?|\S+/g;
        let m;
        while ((m = re.exec(String(query || ''))) !== null) {
            const token = m[0];
            if (m[1]) {
                const v = m[2].trim();
                if (v || m[1] === '@' || m[1] === '~') q[SIGNS[m[1]]].push(v);
                continue;
            }
            const sign = token.charAt(0);
            if (SIGNS[sign]) {
                const v = token.slice(1);
                if (v || sign === '@' || sign === '~') { q[SIGNS[sign]].push(v); continue; }
                continue; // `#` or `!` alone: being typed
            }
            if (METHODS.indexOf(token.toUpperCase()) !== -1) { q.methods.push(token.toUpperCase()); continue; }
            if (SINCE.test(token) || BETWEEN.test(token)) { q.dates.push(token.toLowerCase()); continue; }
            rest.push(token);
        }
        q.text = rest.join(' ');
        return q;
    }

    /** The query for these parts, always in one order: `@ ~ !error get #tag 7d words`. */
    function buildQuery(q) {
        const out = [];
        const signed = (kind) => (q[kind] || []).forEach(v => out.push(SIGN_OF[kind] + (v ? formatValue(v) : '')));
        signed('systems');
        signed('envs');
        signed('statuses');
        (q.methods || []).forEach(m => out.push(String(m).toLowerCase()));
        signed('tags');
        (q.dates || []).forEach(d => out.push(d));
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

    /** Lower case, `-` `_` `.` `/` read as spaces: `bulk up` finds `bulk-upload`. */
    function norm(s) {
        return String(s || '').toLowerCase().replace(/[\s\-_./]+/g, ' ').trim();
    }

    /** The token at the end of what is typed: `{ start, sign?, partial }`, or null after a space. */
    function currentToken(typed) {
        const text = String(typed || '');
        const quoted = /(^|\s)([#@!~])"([^"]*)$/.exec(text);
        if (quoted) return { start: quoted.index + quoted[1].length, sign: quoted[2], partial: quoted[3] };
        if (/\s$/.test(text) || !text) return null;
        const m = /(^|\s)(\S+)$/.exec(text);
        const token = m[2];
        const start = m.index + m[1].length;
        if (SIGNS[token.charAt(0)]) return { start, sign: token.charAt(0), partial: token.slice(1) };
        return { start, partial: token.replace(/^-/, '') };
    }

    /** How a suggestion is written into the box. */
    function written(c) {
        return c.sign === 'method' ? String(c.value).toLowerCase() : c.sign + (c.value ? formatValue(c.value) : '');
    }

    /**
     * What to suggest for the token being typed. `candidates` are [{ sign, value, label?, count? }]
     * where sign is '#', '@', '!', '~' or 'method', and value '' is "the current one". `#` lists
     * the tags, `#inv` those with "inv"; a plain word lists every kind whose value holds it, so
     * `db` offers `@dbmn` and `#dbmn`. Several words can be one name (`bulk up` → `#bulk-upload`).
     */
    function suggestionsFor(typed, candidates) {
        const tok = currentToken(typed);
        if (!tok) return [];
        const have = parseQuery(typed);
        const already = new Set();
        Object.keys(SIGN_OF).forEach(kind => have[kind].forEach(v => already.add(SIGN_OF[kind] + norm(v))));
        have.methods.forEach(m => already.add('method' + norm(m)));
        // The longest tail of words that finds something decides what picking replaces
        const tails = [];
        if (tok.sign) {
            tails.push({ needle: norm(tok.partial), start: tok.start });
        } else {
            const text = String(typed);
            const starts = [];
            const re = /\S+/g;
            let m;
            while ((m = re.exec(text)) !== null) starts.push(m.index);
            for (let n = Math.min(3, starts.length); n >= 1; n--) {
                const from = n === 1 ? tok.start : starts[starts.length - n];
                const piece = n === 1 ? tok.partial : text.slice(from);
                if (n > 1 && /(^|\s)[#@!~]/.test(piece)) continue;
                tails.push({ needle: norm(piece), start: from });
            }
        }
        const out = [];
        const seen = new Set();
        tails.forEach((t, ti) => {
            if (out.length) return;
            if (!tok.sign && !t.needle) return;
            (candidates || []).forEach(c => {
                if (tok.sign && c.sign !== tok.sign) return;
                const v = norm(c.value);
                const id = c.sign + v;
                if (seen.has(id) || (already.has(id) && !(tok.sign && v === norm(tok.partial) && !v))) return;
                const hay = norm(c.value + ' ' + (c.label || ''));
                const at = t.needle ? hay.indexOf(t.needle) : 0;
                if (at === -1) return;
                if (!tok.sign && t.needle.length < 2 && at !== 0) return;
                seen.add(id);
                out.push({ c, start: t.start, rank: ti * 2 + (at === 0 ? 0 : 1) + (c.value === '' ? -1 : 0) });
            });
        });
        out.sort((a, b) => a.rank - b.rank || (b.c.count || 0) - (a.c.count || 0) || String(a.c.value).localeCompare(String(b.c.value)));
        return out.slice(0, 8).map(x => ({ sign: x.c.sign, value: x.c.value, label: x.c.label, count: x.c.count, start: x.start, text: written(x.c) }));
    }

    /**
     * The key to the signs, for Build a search (a <dl>, coloured as the box colours them).
     * `history` adds History's own: `!status`, `~environment`, dates.
     */
    function legendHtml(history) {
        const rows = [
            ['words', 'in any order, anywhere in the row'],
            ['"two words"  -word', 'together / without it'],
            ['get post', 'the method; two of a kind is either'],
            ['#tag', 'a tag'],
            ['@  @dbmn', 'the current System / that one']
        ];
        if (history) rows.push(['!error', 'a status'], ['~  ~prod', 'the current environment / that one'], ['24h 7d 2w', 'since then']);
        return '<dl class="dbmn-filter-legend" data-help="hub#search">' + rows.map(r =>
            '<dt>' + colourize(r[0]).replace(/\n$/, '') + '</dt><dd>' + escapeHtml(r[1]) + '</dd>').join('') + '</dl>';
    }

    /**
     * The query as HTML, each part in its kind's colour (the box's mirror): methods, `#tag`,
     * `@System`, `!status`, `~environment`, dates, `-word`. The text itself is unchanged, spaces
     * included, so the mirror lines up with the box letter for letter.
     */
    function colourize(query) {
        const text = String(query || '');
        const re = /\s+|[#@!~]"[^"]*"?|"[^"]*"?|\S+/g;
        let out = '';
        let m;
        while ((m = re.exec(text)) !== null) {
            const t = m[0];
            let cls = '';
            if (/^\s/.test(t)) { out += escapeHtml(t); continue; }
            const sign = t.charAt(0);
            if (sign === '#') cls = 'tag';
            else if (sign === '@') cls = 'system';
            else if (sign === '!' && t.length > 1) cls = 'status';
            else if (sign === '~') cls = 'env';
            else if (METHODS.indexOf(t.toUpperCase()) !== -1) cls = 'method method-' + t.toUpperCase();
            else if (SINCE.test(t) || BETWEEN.test(t)) cls = 'date';
            else if (sign === '-' && t.length > 1) cls = 'not';
            out += cls ? '<span class="search-tok search-tok-' + cls + '">' + escapeHtml(t) + '</span>' : escapeHtml(t);
        }
        // a last line break holds the height of a trailing empty line
        return out + '\n';
    }

    /**
     * The search box. The query is the text in it; nothing else holds filter state. Suggestions
     * list under it as you type; picking one writes `key:value ` where the word was.
     *
     *   SearchWords.attach({ input, candidates: () => [{ sign, value, label?, count? }], onText })
     *     → { setText(query) }   // the query builder and "Show history" write the box
     */
    function attach(opts) {
        const input = opts && opts.input;
        if (!input) return { refresh() {}, setText() {} };
        const box = input.parentElement;
        // The query in colour, behind the box's (transparent) text
        const mirror = document.createElement('div');
        mirror.className = 'search-box-mirror';
        mirror.setAttribute('aria-hidden', 'true');
        box.insertBefore(mirror, input);
        box.classList.add('has-mirror');
        const list = document.createElement('div');
        list.className = 'search-suggest';
        list.setAttribute('role', 'listbox');
        list.hidden = true;
        box.appendChild(list);
        input.setAttribute('aria-autocomplete', 'list');
        let shown = [];
        let active = 0;

        // A long query wraps: the box grows to fit it (a textarea, one line to start)
        const fit = () => {
            mirror.innerHTML = colourize(input.value);
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
        function close() { list.hidden = true; shown = []; }
        function render() {
            shown = input.selectionEnd === input.value.length
                ? suggestionsFor(input.value, opts.candidates ? opts.candidates() : []) : [];
            if (!shown.length) { close(); return; }
            if (active >= shown.length) active = 0;
            const words = parseWords(norm((currentToken(input.value) || {}).partial || ''));
            list.innerHTML = shown.map((sg, i) =>
                '<div class="search-suggest-option' + (i === active ? ' is-active' : '') + '" role="option" data-index="' + i + '">' +
                    '<span class="search-suggest-text">' + highlight(sg.text, words) + '</span>' +
                    (sg.label ? '<span class="search-suggest-label">' + escapeHtml(sg.label) + '</span>' : '') +
                    (sg.count != null ? '<span class="search-suggest-count">' + sg.count + '</span>' : '') +
                '</div>').join('');
            list.hidden = false;
        }
        function pick(i) {
            const s = shown[i];
            if (!s) return;
            input.value = input.value.slice(0, s.start) + s.text + ' ';
            input.setSelectionRange(input.value.length, input.value.length);
            close();
            changed();
            input.focus();
        }

        input.addEventListener('input', () => {
            // One line of query: a pasted line break is a space
            if (/[\r\n]/.test(input.value)) {
                const at = input.selectionStart;
                input.value = input.value.replace(/\r?\n/g, ' ');
                input.setSelectionRange(at, at);
            }
            active = 0; render(); changed();
        });
        input.addEventListener('keydown', (e) => {
            if (!list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
                render();
            } else if (!list.hidden && (e.key === 'Enter' || e.key === 'Tab')) {
                e.preventDefault();
                pick(active);
            } else if (e.key === 'Enter') {
                e.preventDefault();
            } else if (e.key === 'Escape' && (!list.hidden || input.value)) {
                // Esc closes the list, then clears the box; with nothing to do it is the Hub's
                // (it closes the list panel)
                e.preventDefault();
                e.stopPropagation();
                if (!list.hidden) close();
                else { input.value = ''; changed(); }
            }
        });
        list.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const opt = e.target instanceof Element ? e.target.closest('.search-suggest-option') : null;
            if (opt) pick(Number(opt.getAttribute('data-index')));
        });
        input.addEventListener('blur', () => setTimeout(close, 120));
        // and again when the list panel is resized
        if (typeof ResizeObserver === 'function') new ResizeObserver(() => fit()).observe(box);
        fit();
        return {
            refresh() {},
            setText(text) {
                input.value = text || '';
                close();
                fit();
            }
        };
    }

    const api = { attach, parseWords, matches, highlight, parseQuery, buildQuery, formatValue, suggestionsFor, sinceMs, between, colourize, legendHtml, METHODS };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        window.SearchWords = api;
    }
})();

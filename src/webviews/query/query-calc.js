// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's calculation builder: a calculated column's name and formula, in the shared dialog.
 *
 * The formula is spreadsheet style (IF, ROUND, CONCAT…, nested anywhere) over columns written
 * with @ and their path (@quantityOnHand, @Counts."Qty Counted", @C1.quantityOnHand): the host
 * reads it (src/services/query/formula.ts), says what is wrong in words, and runs it on the first
 * rows. Here, only what typing needs: the formula coloured (each column in its view's colour, the
 * bracket beside the caret lit with its pair), suggestions after @ and for function names (arrows
 * and Enter pick, Esc closes), the usage of the function the caret is in, quick starts, the
 * functions and columns to insert, the columns it uses (whole paths: what is saved), the first
 * rows, and the SQL it runs as.
 *
 * ctx: { el, post, colour(viewId), state(), onCheck(handler) }
 */
(function () {
    'use strict';

    const PART = /^(?:"(?:[^"]|"")*"?|[A-Za-z0-9_]*)/;
    /** The pieces of a formula, each with where it starts (as the host reads them). */
    function tokens(src) {
        const out = [];
        let i = 0;
        while (i < src.length) {
            const rest = src.slice(i);
            let m;
            let t;
            if ((m = /^\s+/.exec(rest))) t = { t: 'ws', s: m[0] };
            else if (rest[0] === '@') {
                let j = 1;
                const parts = [];
                for (;;) {
                    const pm = PART.exec(rest.slice(j));
                    const raw = pm ? pm[0] : '';
                    parts.push(raw.startsWith('"') ? raw.replace(/^"|"$/g, '').replace(/""/g, '"') : raw);
                    j += raw.length;
                    if (rest[j] === '.') { j++; continue; }
                    break;
                }
                t = { t: 'ref', s: rest.slice(0, j), parts };
            } else if (rest[0] === '"' || rest[0] === "'") {
                const q = rest[0];
                let j = 1;
                while (j < rest.length) { if (rest[j] === q) { if (rest[j + 1] === q) { j += 2; continue; } j++; break; } j++; }
                t = { t: 'str', s: rest.slice(0, j) };
            } else if ((m = /^\d+(\.\d+)?/.exec(rest))) t = { t: 'num', s: m[0] };
            else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) t = { t: 'word', s: m[0], u: m[0].toUpperCase() };
            else if ((m = /^(<>|!=|>=|<=|[=<>+\-*/(),])/.exec(rest))) t = { t: 'op', s: m[0] };
            else t = { t: 'bad', s: rest[0] };
            t.at = i;
            out.push(t);
            i += t.s.length;
        }
        return out;
    }
    /** The columns a typed path finds (the host's rule: its parts in order, the last the column's own; case never decides). */
    function resolve(parts, columns) {
        const want = parts.flatMap(p => p.split('.')).map(p => p.toLowerCase());
        if (!want.length || !want[want.length - 1]) return [];
        return columns.filter(c => {
            const path = c.path.map(p => p.toLowerCase());
            if (path[path.length - 1] !== want[want.length - 1]) return false;
            let i = 0;
            for (const part of path.slice(0, -1)) if (i < want.length - 1 && part === want[i]) i++;
            return i === want.length - 1;
        });
    }

    function open(ctx, calc) {
        const { el } = ctx;
        const state = ctx.state();
        const columns = state.formulaColumns || [];
        const fns = state.formulaFunctions || [];
        const fn = new Map(fns.map(f => [f.name, f]));
        const shortOf = key => (columns.find(c => c.key === key) || {}).short;
        const viewOf = key => (columns.find(c => c.key === key) || {}).view;

        const body = el('div', 'query-calc');
        const left = el('div', 'query-calc-left');
        const lib = el('div', 'query-calc-lib');
        body.append(left, lib);

        const field = (label, node) => { const f = el('div', 'dbmn-modal-field'); const l = el('label', 'query-calc-label', label); f.append(l, node); return f; };
        const name = el('input', 'dbmn-modal-input query-calc-name');
        name.type = 'text';
        name.placeholder = 'e.g. variance';
        name.value = calc ? calc.name : '';
        name.spellcheck = false;
        name.autocomplete = 'off';
        name.setAttribute('aria-label', 'Its heading in Results');

        const wrap = el('div', 'query-calc-edwrap');
        const paint = el('pre', 'query-calc-paint');
        paint.setAttribute('aria-hidden', 'true');
        const ed = el('textarea', 'query-calc-ed');
        ed.rows = 3;
        ed.spellcheck = false;
        ed.placeholder = 'Type @ for a column, or the start of a function';
        ed.setAttribute('aria-label', 'Calculation');
        // A calculation from before the builder is SQL: shown as it is, to rewrite
        ed.value = calc ? (calc.formula !== undefined ? (calc.expr || calc.formula) : calc.expr) : '';
        const ac = el('div', 'query-calc-ac');
        ac.setAttribute('role', 'listbox');
        ac.hidden = true;
        wrap.append(paint, ed, ac);
        const hint = el('div', 'query-calc-hint');
        const quick = el('div', 'query-calc-quick');
        const uses = el('div', 'query-calc-uses');
        const preview = el('table', 'data-table query-calc-prev');
        const said = el('div', 'query-calc-said');
        const sqlBox = el('pre', 'query-calc-sql');
        const sqlFold = el('details', 'query-calc-sqlfold');
        sqlFold.append(el('summary', '', 'The SQL it runs as'), sqlBox);
        left.append(field('Name', name), field('Calculation', wrap), hint, quick,
            field('Columns it uses', uses), field('On the first records', preview), said, sqlFold);

        // Quick starts, from the columns there are
        const numeric = columns.filter(c => /^-?\d+(\.\d+)?$/.test(c.sample));
        const texts = columns.filter(c => c.sample && !/^-?\d+(\.\d+)?$/.test(c.sample));
        const q = [];
        if (numeric.length > 1) {
            const [a, b] = numeric;
            q.push(['Difference', `${a.short} - ${b.short}`], ['% change', `ROUND((${b.short} - ${a.short}) / ${a.short} * 100, 1)`], ['How far apart', `ABS(${a.short} - IFBLANK(${b.short}, 0))`],
                ['Flag', `IF(${a.short} = ${b.short}, "Same", "Different")`]);
        }
        if (texts.length > 1) q.push(['Join text', `CONCAT(${texts[0].short}, " · ", ${texts[1].short})`]);
        quick.append(el('span', 'form-hint', q.length ? 'Quick start' : ''));
        q.forEach(([label, ex]) => {
            const b = el('button', 'btn btn-secondary query-calc-chip', label);
            b.type = 'button';
            b.addEventListener('click', () => { ed.value = ex; if (!name.value) name.value = label.toLowerCase().replace(/[^a-z]+/g, ''); refresh(); ed.focus(); });
            quick.appendChild(b);
        });

        // The functions and columns, to insert
        const find = el('input', 'dbmn-modal-input');
        find.type = 'search';
        find.placeholder = 'Find a function or column';
        find.setAttribute('aria-label', 'Find a function or column');
        const list = el('div', 'query-calc-list');
        lib.append(find, list);
        function drawLib() {
            const s = find.value.toLowerCase();
            list.replaceChildren();
            let group = '';
            fns.filter(f => !s || f.usage.toLowerCase().includes(s) || f.says.toLowerCase().includes(s)).forEach(f => {
                if (f.group !== group) { group = f.group; list.appendChild(el('div', 'query-calc-group', group)); }
                const b = el('button', 'query-calc-fn');
                b.type = 'button';
                b.title = `Insert ${f.name}()`;
                b.append(el('code', '', f.usage), el('span', '', f.says), el('small', 'font-mono', f.example));
                b.addEventListener('click', () => insert(`${f.name}()`, undefined, 1));
                list.appendChild(b);
            });
            list.appendChild(el('div', 'query-calc-group', 'Columns'));
            columns.filter(c => !s || c.full.toLowerCase().includes(s)).forEach(c => {
                const b = el('button', 'query-calc-col');
                b.type = 'button';
                b.append(chip(c.short, c.view), el('small', 'font-mono', c.sample));
                b.addEventListener('click', () => insert(c.short));
                list.appendChild(b);
            });
        }
        function chip(text, view) {
            return el('span', `query-calc-ref ${view ? ctx.colour(view) : 'is-unknown'}`, text);
        }

        let items = [];
        let sel = 0;
        let seq = 0;
        let ok = false;
        let timer = 0;
        function insert(text, from, back) {
            const at = from !== undefined ? from : ed.selectionStart;
            const end = ed.selectionEnd;
            ed.value = ed.value.slice(0, at) + text + ed.value.slice(end);
            ed.focus();
            ed.selectionStart = ed.selectionEnd = at + text.length - (back || 0);
            refresh();
        }
        function refresh() {
            const src = ed.value;
            const caret = ed.selectionStart;
            const toks = tokens(src);
            // The bracket beside the caret, and its pair
            const pair = new Set();
            const stack = [];
            const partner = {};
            toks.forEach((t, i) => { if (t.t === 'op' && t.s === '(') stack.push(i); else if (t.t === 'op' && t.s === ')' && stack.length) { const o = stack.pop(); partner[o] = i; partner[i] = o; } });
            toks.forEach((t, i) => { if (t.t === 'op' && (t.s === '(' || t.s === ')') && (t.at === caret - 1 || t.at === caret) && partner[i] !== undefined) { pair.add(i); pair.add(partner[i]); } });
            paint.replaceChildren(...toks.map((t, i) => {
                if (t.t === 'ref') { const found = resolve(t.parts, columns); return el('span', `query-calc-ref ${found.length === 1 ? ctx.colour(found[0].view) : 'is-unknown'}`, t.s); }
                if (t.t === 'word') return el('span', fn.has(t.u) ? 'query-calc-tok-fn' : '', t.s);
                if (t.t === 'str') return el('span', 'query-calc-tok-str', t.s);
                if (t.t === 'num') return el('span', 'query-calc-tok-num', t.s);
                if (t.t === 'op' && pair.has(i)) return el('span', 'query-calc-tok-pair', t.s);
                return document.createTextNode(t.s);
            }), document.createTextNode('\n'));
            paint.scrollTop = ed.scrollTop;
            // The function the caret is in, at any depth: its usage, the part it is on in bold
            const before = src.slice(0, caret);
            let depth = 0;
            let argN = 0;
            let fname = null;
            let inStr = false;
            for (let k = before.length - 1; k >= 0; k--) {
                const ch = before[k];
                if (ch === '"') inStr = !inStr;
                if (inStr) continue;
                if (ch === ')') depth++;
                else if (ch === '(') { if (depth === 0) { const m = /([A-Za-z]+)\s*$/.exec(before.slice(0, k)); fname = m && m[1].toUpperCase(); break; } depth--; } else if (ch === ',' && depth === 0) argN++;
            }
            const f = fname && fn.get(fname);
            hint.replaceChildren();
            if (f) {
                const m = /^(\w+)\((.*)\)$/.exec(f.usage);
                const args = m ? m[2].split(', ') : [];
                const code = el('code');
                code.append(`${m ? m[1] : f.name}(`);
                args.forEach((a, i) => { if (i) code.append(', '); code.append(i === Math.min(argN, args.length - 1) ? el('b', '', a) : a); });
                code.append(')');
                hint.append(code, el('span', '', `  ${f.says}`));
            }
            // Suggestions: after @ the columns its parts find; else the functions its letters start
            const refM = /@((?:"[^"]*"?|[A-Za-z0-9_]*)(?:\.(?:"[^"]*"?|[A-Za-z0-9_]*))*)$/.exec(before);
            const fnM = !refM && /(?:^|[^A-Za-z@."])([A-Za-z]+)$/.exec(before);
            items = [];
            if (refM) {
                const typed = refM[1].split('.').map(x => x.replace(/"/g, '').toLowerCase());
                const lastBit = typed.pop();
                columns.filter(c => {
                    const p = c.path.map(x => x.toLowerCase());
                    let i = 0;
                    for (const part of p.slice(0, -1)) if (i < typed.length && part === typed[i]) i++;
                    return i === typed.length && p[p.length - 1].includes(lastBit);
                }).slice(0, 30).forEach(c => {
                    const b = el('button', 'query-calc-item');
                    b.type = 'button';
                    b.setAttribute('role', 'option');
                    b.append(chip(c.short, c.view), el('span', 'query-calc-path', c.path.join(' › ')), el('span', 'query-calc-val font-mono', c.sample));
                    items.push({ node: b, go: () => insert(c.short, caret - refM[0].length) });
                });
            } else if (fnM) {
                fns.filter(x => x.name.startsWith(fnM[1].toUpperCase())).forEach(x => {
                    const b = el('button', 'query-calc-item');
                    b.type = 'button';
                    b.setAttribute('role', 'option');
                    b.append(el('code', '', x.usage), el('span', 'query-calc-path', x.says));
                    items.push({ node: b, go: () => insert(`${x.name}()`, caret - fnM[1].length, 1) });
                });
            }
            sel = Math.min(sel, Math.max(items.length - 1, 0));
            ac.replaceChildren(...items.map((it, i) => {
                it.node.classList.toggle('is-sel', i === sel);
                it.node.addEventListener('mousedown', e => { e.preventDefault(); it.go(); });
                return it.node;
            }));
            ac.hidden = !items.length || document.activeElement !== ed;
            // The host reads it and runs it on the first rows, a moment after typing stops
            clearTimeout(timer);
            timer = setTimeout(check, 150);
        }
        function check() {
            const src = ed.value;
            if (!src.trim()) {
                ok = false;
                uses.replaceChildren(el('span', 'form-hint', 'Each column it uses, in its view’s colour, with the whole path that is saved.'));
                preview.replaceChildren();
                sqlBox.textContent = '';
                said.className = 'query-calc-said is-idle';
                said.textContent = 'Type a calculation, pick a quick start, or click a function or column on the right.';
                setAdd();
                return;
            }
            ctx.post({ type: 'query.calcCheck', formula: src, seq: ++seq });
        }
        ctx.onCheck(m => {
            if (m.seq !== seq) return;
            const refTyping = /@[^\s(),]*$/.test(ed.value.slice(0, ed.selectionStart)) && ed.selectionStart === ed.value.length;
            ok = !!m.ok;
            uses.replaceChildren();
            if (m.ok) {
                (m.used || []).forEach(key => {
                    const c = columns.find(x => x.key === key);
                    if (!c) return;
                    uses.appendChild(el('div', 'query-calc-use', ''));
                    uses.lastChild.append(chip(c.short, c.view), el('span', 'query-calc-path', c.full), el('span', 'query-calc-val font-mono', c.sample));
                });
                const head = el('tr');
                head.append(el('th', '', m.label || 'Row'), ...(m.compare ? [el('th', '', `${name.value || 'Result'} 1`), el('th', '', `${name.value || 'Result'} 2`)] : [el('th', '', name.value || 'Result')]));
                preview.replaceChildren(head, ...(m.rows || []).map(r => { const tr = el('tr'); r.forEach(v => tr.appendChild(el('td', 'font-mono', v === null || v === undefined ? '(blank)' : String(v)))); return tr; }));
                sqlBox.textContent = m.sql || '';
                said.className = 'query-calc-said is-ok';
                said.textContent = m.compare ? '✓ A compared column: its sides side by side, the differences marked' : '✓ Works on every record shown';
            } else {
                preview.replaceChildren();
                sqlBox.textContent = '';
                said.className = 'query-calc-said' + (refTyping ? ' is-idle' : ' is-bad');
                said.textContent = refTyping ? 'Pick a column from the list, or keep typing its name.' : `✗ ${m.error}`;
                // Two columns of that name: the list to pick from, as the error says
                if (!refTyping && m.choices && m.choices.length) {
                    m.choices.forEach(full => {
                        const c = columns.find(x => x.full === full);
                        if (!c) return;
                        const b = el('button', 'btn btn-secondary query-calc-chip');
                        b.type = 'button';
                        b.append(chip(c.short, c.view));
                        b.addEventListener('click', () => {
                            const at = m.at >= 0 ? m.at : ed.value.lastIndexOf('@');
                            const t = tokens(ed.value.slice(at))[0];
                            ed.value = ed.value.slice(0, at) + c.short + ed.value.slice(at + (t ? t.s.length : 0));
                            refresh();
                        });
                        said.append(' ', b);
                    });
                }
            }
            setAdd();
        });
        function setAdd() {
            const add = document.querySelector('.dbmn-modal [data-action-id="add"]');
            if (add) add.disabled = !ok || !name.value.trim();
        }

        ed.addEventListener('input', () => { sel = 0; refresh(); });
        ed.addEventListener('click', refresh);
        ed.addEventListener('keyup', e => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) refresh(); });
        ed.addEventListener('keydown', e => {
            if (ac.hidden || !items.length) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; refresh(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + items.length - 1) % items.length; refresh(); }
            else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); items[sel].go(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ac.hidden = true; }
        });
        ed.addEventListener('scroll', () => { paint.scrollTop = ed.scrollTop; });
        ed.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ed) ac.hidden = true; }, 120));
        name.addEventListener('input', setAdd);
        find.addEventListener('input', drawLib);
        drawLib();

        setTimeout(() => { refresh(); ed.focus(); setAdd(); }, 0);
        return window.DbmnModal.show({
            title: calc ? 'Calculated column' : 'Add a calculated column', body, size: 'lg',
            actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'add', label: calc ? 'Save' : 'Add', variant: 'primary' }]
        }).then(answer => {
            ctx.onCheck(null);
            if (answer.actionId !== 'add' || !ok) return null;
            return { name: name.value.trim(), formula: ed.value, was: calc ? calc.name : undefined };
        });
    }

    window.QueryCalc = { open, tokens, resolve };
})();

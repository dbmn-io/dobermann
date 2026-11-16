// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Batch Explainer
 *
 * Run Batch Step 4 → ⓘ on API calls → "How your rows become API requests" (GitHub Issue #308).
 * Renders a batch plan (src/data-loading/batch-plan.ts) for the curious: the template with
 * every variable coloured by what it does, how the rows group into requests, and the shape of
 * what is sent. Every template shape the generator supports has its own section 2.
 *
 * Pure: plan in, HTML string out (everything from the plan escaped). No DOM, no VS Code API.
 * Browser: window.BatchExplainer. Node: module.exports (tests, standalone renders).
 *
 * Used by: shared/data-transformer.js (Step 4 ⓘ, opened in a DbmnModal).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) { module.exports = api; }
    if (root && typeof root === 'object') { root.BatchExplainer = api; }
}(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    const esc = (text) => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const code = (text) => `<code>${esc(text)}</code>`;
    const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : (many || one + 's')}`;
    const arrayName = (path) => (path === '$root' ? 'the top-level array' : code(path));

    const ROLES = {
        request:     { label: 'Starts a new request', css: 'role-request' },
        group:       { label: 'Starts a new entry',   css: 'role-group' },
        item:        { label: 'Once per row',         css: 'role-item' },
        'first-row': { label: "From each request's first row", css: 'role-first' },
        row:         { label: 'Filled from the row',  css: 'role-row' },
        url:         { label: 'In the URL',           css: 'role-url' },
        generated:   { label: 'Generated',            css: 'role-generated' },
        environment: { label: 'From the environment', css: 'role-env' }
    };

    const SHAPES = {
        single:         { tag: 'One request per row', lead: (p) => `Each row becomes its own request.` },
        flat:           { tag: 'Rows packed into an array', lead: (p) => `Rows go into ${arrayName(p.arrayPath)}, up to ${p.reps.value.toLocaleString()} per request.` },
        grouped:        { tag: 'Grouped by the header', lead: (p) => `${joinNames(p.levels[0].keyedBy)} ${p.levels[0].keyedBy.length > 1 ? 'together decide' : 'decides'} the request. Every row with the same ${p.levels[0].keyedBy.length > 1 ? 'combination' : 'value'} goes into one request, as an entry in ${arrayName(p.arrayPath)}.` },
        'nested-2':     { tag: 'Two levels', lead: (p) => nestedLead(p) },
        'nested-3':     { tag: 'Three levels', lead: (p) => nestedLead(p) },
        'query-repeat': { tag: 'Values packed into the URL', lead: (p) => `Rows are packed into one query parameter, as many per URL as fit.` },
        'query-each':   { tag: 'One URL per row', lead: (p) => `There is no body: each row fills the URL and becomes its own request.` }
    };

    function joinNames(names) {
        const list = (names || []).map(code);
        return list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
    }

    function nestedLead(p) {
        const [request, ...levels] = p.levels;
        const parts = [];
        if (request.keyedBy.length) parts.push(`${joinNames(request.keyedBy)} ${request.keyedBy.length > 1 ? 'decide' : 'decides'} the request.`);
        levels.forEach((level, i) => {
            const isLast = i === levels.length - 1;
            if (isLast) parts.push(`Each row is an entry in ${code(level.name)}.`);
            else if (level.keyedBy.length) parts.push(`Each ${level.keyedBy.length > 1 ? 'combination of ' : ''}${joinNames(level.keyedBy)} starts a new entry in ${code(level.name)}.`);
            else parts.push(`${code(level.name)} is a wrapper with nothing of its own to group on.`);
        });
        parts.push(`Up to ${p.reps.value.toLocaleString()} ${code(levels[0].name)} entries go in each request.`);
        return parts.join(' ');
    }

    /** The template, escaped, with each {{variable}} wrapped in a role-coloured mark. */
    function highlightTemplate(template, variables) {
        const roleByName = {};
        (variables || []).forEach(v => { roleByName[v.name] = v.role; });
        const out = [];
        let last = 0;
        const re = /\{\{([^{}]*)\}\}/g;
        let m;
        while ((m = re.exec(template)) !== null) {
            out.push(esc(template.slice(last, m.index)));
            const content = m[1].trim();
            let name;
            if (!content || content.startsWith(':')) {
                const before = template.slice(0, m.index).match(/"([^"]+)"\s*:\s*"?\s*$/);   // shorthand: named by its key
                name = before ? before[1] : '';
            } else {
                const prefix = content.split(':')[0].trim().toUpperCase();
                name = prefix === 'A8' || prefix === 'ENV' ? content : content.split(/[:|]/)[0].trim();
            }
            const role = roleByName[name] || (/^A8:/i.test(content) ? 'generated' : /^ENV:/i.test(content) ? 'environment' : 'row');
            out.push(`<mark class="bx-var ${ROLES[role].css}" title="${esc(ROLES[role].label)}">${esc(m[0])}</mark>`);
            last = m.index + m[0].length;
        }
        out.push(esc(template.slice(last)));
        return out.join('').replace(/(\/\/[^\n]*)/g, '<span class="bx-comment">$1</span>');
    }

    function legend(plan) {
        const rows = plan.variables.map(v => {
            const role = ROLES[v.role];
            let what = role.label;
            if (v.role === 'group' && v.level) what = `Starts a new entry in ${code(v.level)}`;
            if (v.role === 'item' && v.level) what = `Once per row, in ${arrayName(v.level)}`;
            if (v.role === 'url' && plan.shape === 'query-repeat') what = 'One value per row, joined into the URL';
            if (v.note) what = esc(v.note.charAt(0).toUpperCase() + v.note.slice(1)).replace(/`([^`]+)`/g, '<code>$1</code>');
            const from = v.column ? `column ${code(v.column)}` : v.role === 'generated' ? 'Dobermann' : v.role === 'environment' ? 'environment' : '<span class="bx-missing">not mapped</span>';
            return `<tr><td><mark class="bx-var ${role.css}">${esc(v.name)}</mark></td><td>${what}</td><td class="bx-from">${from}</td></tr>`;
        }).join('');
        return `<table class="bx-legend"><thead><tr><th>Variable</th><th>What it does</th><th>Comes from</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    /** GitHub Issue #148: the rows were re-ordered to keep each request's rows together. */
    function sortNote(sortedBy) {
        if (!sortedBy || sortedBy.length === 0) return '';
        return `<p class="bx-lead">Your rows weren't in this order, so Dobermann sorted them by ${sortedBy.map(code).join(' → ')} to keep each request's rows together. Your file is unchanged.</p>`;
    }

    function groupsSection(plan, sortedBy) {
        const t = plan.totals;
        if ((plan.shape === 'grouped' || plan.shape === 'nested-2' || plan.shape === 'nested-3') && plan.groups) {
            const g = plan.groups;
            const head = g.columns.map(c => `<th>${esc(c)}</th>`).join('');
            const body = g.rows.map(r => `<tr>${r.values.map(v => `<td>${esc(v)}</td>`).join('')}<td>${r.rowCount.toLocaleString()}</td><td>→</td><td><span class="bx-req">#${r.request}</span></td></tr>`).join('');
            const more = g.more > 0 ? `<p class="bx-more">… and ${plural(g.more, 'more group')}</p>` : '';
            return `<p class="bx-lead">${SHAPES[plan.shape].lead(plan)}</p>${sortNote(sortedBy)}
                <table class="csv-table"><thead><tr>${head}<th>Rows</th><th></th><th>Request</th></tr></thead><tbody>${body}</tbody></table>${more}`;
        }
        if (plan.shape === 'flat') {
            const perRequest = plan.reps.value;
            const chunks = [];
            for (let i = 0; i < Math.min(t.requests, 5); i++) {
                const start = i * perRequest + 1;
                const end = Math.min(t.rows, (i + 1) * perRequest);
                chunks.push(`<div class="bx-chunk"><span class="bx-chunk-rows">rows ${start.toLocaleString()}–${end.toLocaleString()}</span><span class="bx-arrow">→</span><span class="bx-req">#${i + 1}</span></div>`);
            }
            if (t.requests > 5) chunks.push(`<div class="bx-chunk bx-more">… ${plural(t.requests - 5, 'more request')}</div>`);
            return `<p class="bx-lead">${SHAPES.flat.lead(plan)}</p><div class="bx-chunks">${chunks.join('')}</div>`;
        }
        if (plan.shape === 'single') {
            const shown = plan.requests.map(r => `<div class="bx-chunk"><span class="bx-chunk-rows">row ${r.rowRange.start.toLocaleString()}</span><span class="bx-arrow">→</span><span class="bx-req">#${r.index}</span></div>`);
            if (t.requests > plan.requests.length) shown.push(`<div class="bx-chunk bx-more">… ${plural(t.requests - plan.requests.length, 'more request')}</div>`);
            return `<p class="bx-lead">${SHAPES.single.lead(plan)}</p><div class="bx-chunks">${shown.join('')}</div>`;
        }
        // URL shapes: the first URLs, with how many rows each carries.
        const urls = plan.requests.map(r => `<div class="bx-url"><span class="bx-req">#${r.index}</span><span class="bx-method">${esc(r.method)}</span><code class="bx-url-text" title="${esc(readable(r.url))}">${esc(readable(r.url))}</code>${plan.shape === 'query-repeat' ? `<span class="bx-url-rows">${plural(r.rowCount, 'row')}</span>` : ''}</div>`).join('');
        const more = t.requests > plan.requests.length ? `<div class="bx-url bx-more">… ${plural(t.requests - plan.requests.length, 'more request')}</div>` : '';
        return `<p class="bx-lead">${SHAPES[plan.shape].lead(plan)}</p><div class="bx-urls">${urls}${more}</div>`;
    }

    /** What one request looks like, as an outline: Request → lines (one per row). */
    function structure(plan) {
        const t = plan.totals;
        const node = (label, detail, depth) => `<div class="bx-node bx-depth-${Math.min(depth, 3)}"><span class="bx-node-label">${label}</span><span class="bx-node-detail">${detail}</span></div>`;
        let requestDetail;
        if (plan.shape === 'single' || plan.shape === 'query-each') requestDetail = 'one per row';
        else if (plan.shape === 'query-repeat') requestDetail = 'as many values per URL as fit';
        else if (plan.levels[0].keyedBy.length) requestDetail = `one per ${joinNames(plan.levels[0].keyedBy)}${plan.levels[0].keyedBy.length > 1 ? ' combination' : ''}`;
        else if (plan.shape === 'flat') requestDetail = `up to ${plural(plan.reps.value, 'row')} each`;
        else requestDetail = `up to ${plan.reps.value.toLocaleString()} ${code(plan.levels[1].name)} each`;
        const lines = [node(`${plural(t.requests, 'API request')}`, requestDetail, 0)];
        plan.levels.slice(1).forEach((level, i, rest) => {
            const isLast = i === rest.length - 1;
            const detail = isLast ? 'one entry per row'
                : level.keyedBy.length ? `one per ${joinNames(level.keyedBy)}${i === 0 && plan.reps.applies ? `, up to ${plan.reps.value.toLocaleString()} per request` : ''}` : 'a wrapper';
            lines.push(node(code(level.name === '$root' ? '[ ]' : level.name), detail, i + 1));
        });
        return `<div class="bx-tree">${lines.join('')}</div>`;
    }

    /** A URL as a person reads it: `?query=ItemId=A or ItemId=B`, not `%3D…%20or%20`. */
    function readable(url) {
        try { return decodeURIComponent(url); } catch { return url; }
    }

    /**
     * @param {Object} plan
     * @param {{ sortedBy?: string[] }} [context] what the page knows that the plan doesn't:
     *        the columns Run Batch sorted the rows by, if it had to.
     */
    function render(plan, context) {
        const sortedBy = (context && context.sortedBy) || [];
        const t = plan.totals;
        const shape = SHAPES[plan.shape];
        const notes = [...(plan.notes || [])];
        if (plan.shape === 'query-repeat' && /\[[^\]]*\]/.test(plan.urlTemplate || '')) {
            const joiner = (plan.urlTemplate.match(/\[([^\]]*)\]/) || [])[1];
            notes.unshift(`The \`[${joiner}]\` after the value says "repeat this for each row, joined with \`${joiner.trim() || joiner}\`".`);
        }
        if (plan.shape === 'grouped' || plan.shape === 'nested-2' || plan.shape === 'nested-3') {
            notes.push('A header value that changes on every row gives one request per row — keep per-row values in the array.');
        }
        const notesHtml = notes.length ? `<ul class="bx-notes">${notes.map(n => `<li>${esc(n).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('')}</ul>` : '';
        const where = plan.hasBody ? 'The template' : 'The URL template';
        const templateText = `${plan.method} ${plan.urlTemplate || ''}` + (plan.hasBody ? `\n\n${plan.template}` : '');
        return `<div class="batch-explainer">
            <div class="table-stats">
                <div class="stat-item"><span class="stat-label">Rows</span><span>${t.rows.toLocaleString()}</span></div>
                <div class="stat-item"><span class="stat-label">API requests</span><span>${t.requests.toLocaleString()}</span></div>
                <div class="stat-item"><span class="stat-label">How</span><span>${esc(shape.tag)}</span></div>
            </div>

            <section class="bx-section">
                <h3><span class="bx-step">1</span>${where}</h3>
                <pre class="bx-template">${highlightTemplate(templateText, plan.variables)}</pre>
                ${legend(plan)}
            </section>

            <section class="bx-section">
                <h3><span class="bx-step">2</span>How your rows become requests</h3>
                ${groupsSection(plan, sortedBy)}
            </section>

            <section class="bx-section">
                <h3><span class="bx-step">3</span>What each request holds</h3>
                ${structure(plan)}
                ${notesHtml}
            </section>
        </div>`;
    }

    return { render, highlightTemplate, ROLES };
}));

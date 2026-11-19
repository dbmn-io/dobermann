// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The step bar across the top of a stepped screen: Run Batch (Source, Map, Validate, Review,
 * Execute) and Compare (Pick, Match, Compare, Results, #298). One component, one look
 * (data-transformer.css, .batch-stepper): the screen says what each step is, the bar draws it.
 *
 * The current step is tinted, filled and underlined, with one highlight that slides from step
 * to step. A done step shows a tick; a step that needs the user shows "!"; a later step the user
 * can't reach yet is dimmed ("Waits for Map"). The bar never decides a step itself.
 *
 *   const bar = StepBar.create(nav, [{ label, help }], { onStep: n => … });
 *   bar.render(states, current, heading);
 *
 * The bar is the screen's only navigation: the next step is offered as `available` once the
 * current one is done, and clicking it goes on (no Next button to move the steps about).
 *
 * Each state: { status, summary, issue, checking, title, progress }. progress (0-100, optional): how far
 * the step's own work has got (Run Batch reading a file, #435), a fill behind the step, as a Console
 * tab fills in the Hub. status is one of current, done,
 * needs, available, blocked, pending, locked, skipped. Clickable: done, needs, available.
 */
(function () {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ICONS = {
        check: ['M20 6 9 17l-5-5'],
        // Between two steps (Lucide's arrow-big-left, arrow-big-right, octagon-x, minus): the shape says
        // whether the way is open, so it does not rest on colour
        left: ['M18 15h-6v4l-7-7 7-7v4h6v6z'],
        right: ['M6 9h6V5l7 7-7 7v-4H6V9z'],
        stop: ['M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688A2 2 0 0 1 15.312 22H8.688a2 2 0 0 1-1.414-.586z', 'm15 9-6 6', 'm9 9 6 6'],
        none: ['M5 12h14'],
        link: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7']
    };
    const CLICKABLE = ['done', 'needs', 'available'];

    function icon(name) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '12');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        // (the icons between steps are drawn larger: their line is as thick as a circle's, 2px)
        svg.setAttribute('stroke-width', name === 'check' ? '3' : name === 'link' ? '2.5' : '1.6');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('class', `batch-step-icon is-${name}`);
        ICONS[name].forEach(d => {
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', d);
            svg.appendChild(path);
        });
        return svg;
    }

    function span(className, text) {
        const el = document.createElement('span');
        el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    /**
     * The bar's elements, built once and updated in place from then on, so a step change can
     * animate (#397): rebuilding on every change made each hand-off a hard cut.
     */
    function build(nav, steps, onStep) {
        const info = span('batch-stepper-current');
        const row = span('batch-stepper-row');
        // One highlight for the current step, behind the buttons; it slides from step to step
        const indicator = span('batch-step-indicator');
        indicator.setAttribute('aria-hidden', 'true');
        row.appendChild(indicator);
        const buttons = [];
        const lines = [];
        steps.forEach((step, i) => {
            const n = i + 1;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('data-step', String(n));
            if (step.help) btn.setAttribute('data-help', step.help);
            // One listener for the life of the bar; whether a click counts is read at click time
            btn.addEventListener('click', () => { if (!btn.disabled) onStep(n); });
            const circle = span('batch-step-circle');
            const text = span('batch-step-text');
            text.appendChild(span('batch-step-label', step.label));
            text.appendChild(span('batch-step-summary'));
            const fill = span('batch-step-fill');
            fill.setAttribute('aria-hidden', 'true');
            btn.appendChild(fill);
            btn.appendChild(circle);
            btn.appendChild(text);
            row.appendChild(btn);
            buttons.push(btn);
            if (n < steps.length) {
                // Between two steps: an arrow back to the step before, an arrow on to the step after,
                // or a sign that the way on is shut. Where it leads is set at each render (data-to)
                const line = document.createElement('button');
                line.type = 'button';
                line.className = 'batch-step-line';
                line.disabled = true;
                line.addEventListener('click', () => { if (!line.disabled && line.dataset.to) onStep(Number(line.dataset.to)); });
                row.appendChild(line);
                lines.push(line);
            }
        });
        nav.replaceChildren(info, row);
        return { nav, info, row, indicator, buttons, lines, placed: false };
    }

    /**
     * Change the sign between two steps. Once the bar is on show the old one leaves as the new one
     * arrives, the way the user just went: stepping on, the forward arrow carries on to the right
     * and the back arrow comes in from the left; stepping back, the other way round. Any other
     * change (the way on opening or shutting) fades.
     */
    function swapLineIcon(line, kind, animate) {
        const was = line.dataset.kind;
        line.dataset.kind = kind;
        const next = icon(kind);
        if (!animate || !was) { line.replaceChildren(next); return; }
        const move = kind === 'left' ? 'on' : was === 'left' ? 'back' : 'fade';
        // (a change that lands mid-move: only the newest sign leaves)
        Array.from(line.children).slice(0, -1).forEach(el => el.remove());
        const old = line.lastElementChild;
        if (old) {
            old.setAttribute('class', `batch-step-icon is-leaving is-${move}`);
            const gone = () => old.remove();
            old.addEventListener('animationend', gone);
            setTimeout(gone, 400);
        }
        next.classList.add('is-entering', `is-${move}`);
        next.addEventListener('animationend', () => next.classList.remove('is-entering', `is-${move}`));
        line.appendChild(next);
    }

    /** Move the highlight under the current step: instantly the first time, sliding after that. */
    function placeIndicator(bar, current) {
        const btn = bar.buttons[current - 1];
        if (!btn || !btn.offsetWidth) return;
        bar.indicator.style.setProperty('--x', `${btn.offsetLeft}px`);
        bar.indicator.style.setProperty('--w', `${btn.offsetWidth}px`);
        if (!bar.placed) {
            bar.placed = true;
            // Shown in place before transitions are allowed, so opening the page slides nothing
            requestAnimationFrame(() => bar.row.classList.add('is-ready'));
        }
    }

    function create(nav, steps, options) {
        const onStep = (options && options.onStep) || function () {};
        let built = null;
        /** Status per step at the last render, to tell a step that has just been ticked off. */
        let lastStatus = [];
        let lastCurrent = 1;

        function render(states, current, heading) {
            if (!built || built.nav !== nav || !nav.contains(built.row)) { built = build(nav, steps, onStep); lastStatus = []; }
            const bar = built;
            lastCurrent = current;
            steps.forEach((step, i) => {
                const n = i + 1;
                const st = states[i];
                const btn = bar.buttons[i];
                const summary = st.summary || '';
                const clickable = CLICKABLE.includes(st.status);
                // Ticked off since the last render: the tick pops in (CSS, .just-done)
                const justDone = (st.status === 'done' || st.status === 'skipped') && lastStatus[i] && !['done', 'skipped'].includes(lastStatus[i]);

                const hasProgress = typeof st.progress === 'number';
                if (hasProgress) {
                    btn.style.setProperty('--step-progress', `${Math.max(0, Math.min(100, st.progress))}%`);
                    // An estimate moves there over its time; a measured value in a moment
                    btn.style.setProperty('--step-progress-time', `${st.progressSeconds || 0.3}s`);
                } else {
                    btn.style.removeProperty('--step-progress');
                    btn.style.removeProperty('--step-progress-time');
                }
                btn.className = `batch-step is-${st.status}` + (st.checking ? ' is-checking' : '') + (st.issue ? ` has-${st.issue}` : '') + (hasProgress ? ' has-progress' : '')
                    + (justDone || btn.classList.contains('just-done') && ['done', 'skipped'].includes(st.status) ? ' just-done' : '');
                if (justDone) setTimeout(() => btn.classList.remove('just-done'), 700);
                btn.disabled = !clickable;
                if (st.status === 'current') btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
                btn.setAttribute('aria-label', `Step ${n} of ${steps.length}, ${step.label}${summary ? ', ' + summary : ''}`
                    + (clickable || st.status === 'current' ? '' : ', not available yet'));
                btn.title = st.title !== undefined ? st.title
                    : st.status === 'blocked' ? `${st.waitsFor} needs you first`
                    : st.status === 'pending' ? 'Not reached yet'
                    : clickable ? `${n < current ? 'Back to' : 'Go to'} ${step.label}` : '';
                // Each step has a fixed share of the bar, so a long summary is cut short: the whole of it on hover
                if (summary && st.status !== 'blocked') btn.title = btn.title ? `${btn.title}: ${summary}` : summary;

                const circle = btn.querySelector('.batch-step-circle');
                const showIssue = st.issue && !st.checking;
                const glyph = st.status === 'done' || st.status === 'skipped' ? 'check' : st.status === 'locked' ? 'link' : showIssue ? '!' : String(n);
                if (circle.dataset.glyph !== glyph) {
                    circle.dataset.glyph = glyph;
                    circle.replaceChildren(glyph === 'check' || glyph === 'link' ? icon(glyph) : span('batch-step-num', glyph));
                }
                const summaryEl = btn.querySelector('.batch-step-summary');
                if (summaryEl.textContent !== summary) summaryEl.textContent = summary;

                if (n < steps.length) {
                    const next = states[i + 1];
                    const done = ['done', 'skipped', 'current', 'locked'].includes(st.status) && !st.issue
                        && ['done', 'skipped', 'current'].includes(next.status);
                    bar.lines[i].classList.toggle('is-done', done);
                    // Left of the current step: back to the step before. Right of it: on to the step
                    // after when that is open; shut (octagon) where the way stops; a dash beyond that
                    const line = bar.lines[i];
                    const nextOpen = CLICKABLE.includes(next.status);
                    const kind = n < current ? (clickable ? 'left' : 'none')
                        : nextOpen ? 'right'
                        : (n === current || clickable) ? 'stop' : 'none';
                    if (line.dataset.kind !== kind) {
                        swapLineIcon(line, kind, bar.row.classList.contains('is-ready'));
                    }
                    const to = kind === 'left' ? n : kind === 'right' ? n + 1 : 0;
                    line.dataset.to = to ? String(to) : '';
                    line.disabled = !to;
                    line.classList.toggle('is-open', !!to);
                    // (the one straight before the current step: what a Back button was)
                    line.classList.toggle('is-back', kind === 'left' && n === current - 1);
                    const says = kind === 'left' ? `Back to ${step.label}` : kind === 'right' ? `Go to ${steps[i + 1].label}`
                        : kind === 'stop' ? (next.waitsFor ? `${steps[i + 1].label} waits for ${next.waitsFor}` : `${steps[i + 1].label} is not open yet`) : '';
                    line.title = says;
                    if (to) { line.setAttribute('aria-label', says); line.removeAttribute('aria-hidden'); } else line.setAttribute('aria-hidden', 'true');
                }
            });
            lastStatus = states.map(st => st.status);
            // Narrow panels show this heading over the step names and circles
            bar.info.textContent = heading || '';
            placeIndicator(bar, current);
        }

        // The highlight follows the current step when the panel is resized
        window.addEventListener('resize', () => { if (built) placeIndicator(built, lastCurrent); });
        // #435: in Run Batch's footer the bar's width changes with the buttons beside it ("Import
        // Data" becoming "Next"), not only with the window
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(() => { if (built) placeIndicator(built, lastCurrent); }).observe(nav);
        }

        return { render };
    }

    window.StepBar = { create };
})();

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The footer every main screen wears, as custom elements (the design system: see the Design
 * system tab of a development build, src/webviews/design-system).
 *
 *   <dbmn-footer>
 *       <dbmn-actions>
 *           <button class="btn btn-secondary" data-click="query:back">Back</button>
 *           <button class="btn btn-primary" data-click="query:next">Next: Columns</button>
 *       </dbmn-actions>
 *       <dbmn-steps id="steps" label="Query steps"></dbmn-steps>
 *   </dbmn-footer>
 *
 * Left, what the user can do: standard buttons, the main one last. Right, how far along, in one
 * box of one height: <dbmn-steps> when the tasks are the user's, <dbmn-progress> when they are
 * the system's, <dbmn-status> for a few words. One of them at a time, never two.
 *
 * The elements draw in the page itself (no shadow root): the shared sheets, the theme's colours,
 * help mode and DbmnActions reach inside as they reach any element. They hold no business
 * logic: a screen sets what to show and hears what was clicked.
 *
 * Needs shared/icons.js (loaded first) and shared/dbmn-footer.css.
 *
 * ── <dbmn-steps> ──
 *   el.steps = [{ label: 'Views', help: 'reports#views' }, …];   // once
 *   el.render(states, current);     // states[i]: { status, issue, checking, title, waitsFor }
 *                                   // status: current, done, needs, available, blocked, pending, locked, skipped
 *   el.addEventListener('dbmn-step', e => goTo(e.detail.step));   // 1-based; only steps that are open
 *   el.summary = ['3 views', '19 columns', '412 of 5,310 rows'];  // what is on screen
 *   el.folded = true;               // the wizard is done: the steps slide away behind the summary
 *                                   // button, which opens the list of steps
 *
 * The current step's highlight slides from step to step, and folding is shown, not cut: the user
 * sees where the steps went. Neither moves for someone who asked for less motion.
 *
 * ── <dbmn-progress phase="Sending" count="7 of 10" value="70" tone="ok|warn|error" busy> ──
 * ── <dbmn-status tone="ok|warn|error">Saved</dbmn-status> ──
 */
(function () {
    'use strict';

    if (!window.customElements || customElements.get('dbmn-footer')) return;

    const CLICKABLE = ['done', 'needs', 'available'];
    const DONE = ['done', 'skipped'];

    const icon = name => (window.Icons && window.Icons.icon(name)) || '';

    function make(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    /** What a step's mark shows: a tick once done, a turning loader while it works, "!" when it needs the user, else its number. */
    function markFor(st, n) {
        if (st.checking) return { key: 'loader', html: icon('loader') };
        if (DONE.includes(st.status)) return { key: 'check', html: icon('check') };
        if (st.issue) return { key: '!', text: '!' };
        return { key: String(n), text: String(n) };
    }

    function setMark(el, mark) {
        if (el.dataset.mark === mark.key) return;
        el.dataset.mark = mark.key;
        if (mark.html) el.innerHTML = mark.html; else el.textContent = mark.text;
    }

    class DbmnFooter extends HTMLElement {
        connectedCallback() {
            // The window's bottom edge, as every screen's footer is (core.css); `inline` leaves it where it is put
            if (!this.hasAttribute('inline')) this.classList.add('webview-footer');
            if (!this.hasAttribute('role')) this.setAttribute('role', 'contentinfo');
        }
    }

    class DbmnActions extends HTMLElement {
        connectedCallback() {
            if (!this.hasAttribute('role')) this.setAttribute('role', 'group');
            if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Actions');
        }
    }

    class DbmnStatus extends HTMLElement {
        connectedCallback() {
            if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
        }
    }

    class DbmnProgress extends HTMLElement {
        static get observedAttributes() { return ['phase', 'count', 'value']; }

        connectedCallback() {
            if (!this._fill) {
                this._fill = make('span', 'dbmn-progress-fill');
                this._fill.setAttribute('aria-hidden', 'true');
                this._phase = make('span', 'dbmn-progress-phase');
                this._count = make('span', 'dbmn-progress-count');
                this.replaceChildren(this._fill, this._phase, this._count);
            }
            this.setAttribute('role', 'progressbar');
            this.setAttribute('aria-valuemin', '0');
            this.setAttribute('aria-valuemax', '100');
            this._draw();
        }

        attributeChangedCallback() { this._draw(); }

        _draw() {
            if (!this._fill) return;
            const phase = this.getAttribute('phase') || '';
            const count = this.getAttribute('count') || '';
            const value = Math.max(0, Math.min(100, Number(this.getAttribute('value')) || 0));
            this._phase.textContent = phase;
            this._count.textContent = count;
            this.style.setProperty('--progress', `${value}%`);
            this.setAttribute('aria-valuenow', String(Math.round(value)));
            this.setAttribute('aria-valuetext', [phase, count].filter(Boolean).join(', '));
        }
    }

    class DbmnSteps extends HTMLElement {
        constructor() {
            super();
            this._steps = [];
            this._states = [];
            this._current = 1;
            this._summary = [];
            this._built = false;
            this._onOutside = e => { if (!this.contains(e.target)) this._close(); };
            this._onKey = e => { if (e.key === 'Escape' && this._list) { this._close(); this._summaryBtn.focus(); } };
        }

        connectedCallback() {
            this.setAttribute('role', 'navigation');
            if (this.hasAttribute('label')) this.setAttribute('aria-label', this.getAttribute('label'));
            if (typeof ResizeObserver === 'function' && !this._sizes) {
                // The names give way before the buttons beside them do
                this._sizes = new ResizeObserver(() => this._fit());
                const footer = this.closest('dbmn-footer');
                this._sizes.observe(footer || this);
            }
            this._draw();
        }

        disconnectedCallback() {
            this._close();
            clearTimeout(this._foldTimer);
            if (this._sizes) { this._sizes.disconnect(); this._sizes = null; }
        }

        set steps(list) {
            this._steps = Array.isArray(list) ? list : [];
            this._built = false;
            this._draw();
        }
        get steps() { return this._steps; }

        set summary(parts) {
            this._summary = Array.isArray(parts) ? parts.filter(Boolean) : parts ? [String(parts)] : [];
            this._draw();
        }
        get summary() { return this._summary; }

        set folded(on) { this.toggleAttribute('folded', !!on); this._draw(); }
        get folded() { return this.hasAttribute('folded'); }

        /** Show the steps as they stand. The element never decides a step itself. */
        render(states, current) {
            this._states = Array.isArray(states) ? states : [];
            this._current = current || 1;
            this._draw();
        }

        _build() {
            this._row = make('span', 'dbmn-steps-row');
            // One highlight behind the current step: it slides to the next (placed by _place)
            this._indicator = make('span', 'dbmn-steps-indicator');
            this._indicator.setAttribute('aria-hidden', 'true');
            this._buttons = this._steps.map((step, i) => {
                const btn = make('button', 'dbmn-step');
                btn.type = 'button';
                btn.dataset.step = String(i + 1);
                if (step.help) btn.setAttribute('data-help', step.help);
                btn.append(make('span', 'dbmn-step-mark'), make('span', 'dbmn-step-label', step.label));
                btn.addEventListener('click', () => { if (!btn.disabled) this._go(i + 1); });
                if (i) {
                    const gap = make('span', 'dbmn-step-gap');
                    gap.setAttribute('aria-hidden', 'true');
                    gap.innerHTML = icon('chevron-right');
                    this._row.append(gap);
                }
                this._row.append(btn);
                return btn;
            });
            this._of = make('span', 'dbmn-steps-of');
            this._row.append(this._of);

            this._summaryBtn = make('button', 'dbmn-steps-summary');
            this._summaryBtn.type = 'button';
            this._summaryBtn.setAttribute('aria-haspopup', 'true');
            this._summaryBtn.setAttribute('aria-expanded', 'false');
            this._summaryBtn.title = 'The steps behind what is shown: click to go back to one';
            this._summaryBtn.addEventListener('click', () => (this._list ? this._close() : this._open()));
            this.replaceChildren(this._indicator, this._row, this._summaryBtn);
            this._built = true;
        }

        _draw() {
            if (!this.isConnected || !this._steps.length) return;
            if (!this._built) this._build();
            const folded = this.folded;

            this._steps.forEach((step, i) => {
                const n = i + 1;
                const st = this._states[i] || { status: n === this._current ? 'current' : 'pending' };
                const btn = this._buttons[i];
                const open = CLICKABLE.includes(st.status);
                btn.className = `dbmn-step is-${st.status}` + (st.checking ? ' is-checking' : '') + (st.issue ? ` has-${st.issue}` : '');
                btn.disabled = !open;
                if (st.status === 'current') btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
                setMark(btn.firstChild, markFor(st, n));
                const says = st.summary ? `: ${st.summary}` : '';
                btn.title = st.title !== undefined ? st.title
                    : st.status === 'blocked' ? `${st.waitsFor || 'An earlier step'} needs you first`
                    : st.status === 'pending' ? 'Not reached yet'
                    : open ? `${n < this._current ? 'Back to' : 'Go to'} ${step.label}${says}`
                    : st.checking ? `${step.label}: working` : `${step.label}${says}`;
                btn.setAttribute('aria-label', `Step ${n} of ${this._steps.length}, ${step.label}` + (st.checking ? ', working' : '')
                    + (open || st.status === 'current' ? '' : ', not available yet'));
            });
            this._of.textContent = `${this._current} of ${this._steps.length}`;

            if (folded) {
                const parts = this._summary.length ? this._summary : [(this._steps[this._current - 1] || {}).label || ''];
                // Something is still being worked out behind what is shown: the tick turns into the loader
                const working = !!(this._states[this._current - 1] || {}).checking;
                const mark = make('span', 'dbmn-step-mark' + (working ? ' is-working' : ''));
                mark.innerHTML = icon(working ? 'loader' : 'check');
                const kids = [mark];
                parts.forEach((part, i) => {
                    if (i) { const dot = make('span', 'dbmn-steps-dot', '·'); dot.setAttribute('aria-hidden', 'true'); kids.push(dot); }
                    kids.push(make('span', 'dbmn-steps-part', part));
                });
                const chevron = make('span', 'dbmn-steps-chevron');
                chevron.setAttribute('aria-hidden', 'true');
                chevron.innerHTML = icon(this._list ? 'chevron-down' : 'chevron-up');
                kids.push(chevron);
                this._summaryBtn.replaceChildren(...kids);
                if (this._list) this._fillList();
            }
            if (folded !== this._isFolded) this._setFolded(folded);
            this._fit();
            this._place();
        }

        /** The highlight goes behind the current step: put there the first time, sliding after that. */
        _place() {
            if (!this._built || this._isFolded) return;
            const btn = this._buttons[this._current - 1];
            if (!btn || !btn.offsetWidth) return;
            // (measured to the part of a pixel: whole pixels leave it a pixel off its step at some widths)
            const box = btn.getBoundingClientRect();
            const mine = this.getBoundingClientRect();
            this._indicator.style.setProperty('--x', `${box.left - mine.left - this.clientLeft}px`);
            this._indicator.style.setProperty('--w', `${box.width}px`);
            if (!this._ready) {
                // In place before anything may move, so opening the screen slides nothing
                requestAnimationFrame(() => { this._ready = true; this.classList.add('is-ready'); });
            }
        }

        /**
         * Steps to summary, or back. Folding is shown: the steps slide one behind the next to the
         * right, then the summary takes their place, so the user sees where they went and what
         * brings them back.
         */
        _setFolded(folded) {
            const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const moving = !!this._ready && !still && this.offsetWidth > 0;
            this._isFolded = folded;
            clearTimeout(this._foldTimer);
            this.classList.remove('is-folding', 'is-folding-go', 'just-folded', 'is-unfolding');
            this.style.removeProperty('width');
            if (this._buttons) this._buttons.forEach(btn => ['--fold-x', '--fold-wait', '--fold-time', '--fold-z'].forEach(name => btn.style.removeProperty(name)));
            if (!folded) {
                this._close();
                this._row.hidden = false;
                this._summaryBtn.hidden = true;
                if (moving) {
                    this.classList.add('is-unfolding');
                    // (the steps are still on their way in: the highlight is put behind its step once they are home)
                    this._foldTimer = setTimeout(() => { this.classList.remove('is-unfolding'); this._place(); }, 260);
                }
                return;
            }
            if (!moving) {
                this._row.hidden = true;
                this._summaryBtn.hidden = false;
                return;
            }
            // A cascade: each step slides behind the one after it, like cards, until they are all
            // behind the last; then the summary takes their place. Step i sets off as step i-1
            // reaches it and they travel on together (the same speed all the way), so it reads as
            // one after another, not all at once.
            const STAGE = 150;
            const shown = this._buttons.filter(btn => btn.offsetWidth > 0);
            const last = shown[shown.length - 1];
            const end = last ? last.getBoundingClientRect().left : 0;
            this.style.width = `${this.offsetWidth}px`;
            this.classList.add('is-folding');
            shown.forEach((btn, i) => {
                btn.style.setProperty('--fold-x', `${end - btn.getBoundingClientRect().left}px`);
                btn.style.setProperty('--fold-wait', `${i * STAGE}ms`);
                btn.style.setProperty('--fold-time', `${(shown.length - 1 - i) * STAGE}ms`);
                btn.style.setProperty('--fold-z', String(i + 1));
            });
            void this.offsetWidth;   // (where they start is drawn before they move)
            this.classList.add('is-folding-go');
            this._foldTimer = setTimeout(() => {
                this._row.hidden = true;
                this._summaryBtn.hidden = false;
                this.classList.remove('is-folding', 'is-folding-go');
                this.style.removeProperty('width');
                this._buttons.forEach(btn => ['--fold-x', '--fold-wait', '--fold-time', '--fold-z'].forEach(name => btn.style.removeProperty(name)));
                // The summary grows out of where they went, and its arrow lifts once: they are behind it
                this.classList.add('just-folded');
                this._foldTimer = setTimeout(() => this.classList.remove('just-folded'), 900);
            }, Math.max(0, shown.length - 1) * STAGE + 80);
        }

        /** Too narrow for every step's name beside the buttons: show the current one and "2 of 4". */
        _fit() {
            if (!this._built || this._isFolded) { this.classList.remove('is-tight'); return; }
            this.classList.remove('is-tight');
            const footer = this.closest('dbmn-footer');
            if (!footer) return;
            const actions = footer.querySelector('dbmn-actions');
            const room = footer.clientWidth - (actions ? actions.offsetWidth : 0) - 44;
            if (room > 0 && this.offsetWidth > room) this.classList.add('is-tight');
            this._place();
        }

        _go(n) {
            this._close();
            this.dispatchEvent(new CustomEvent('dbmn-step', { bubbles: true, detail: { step: n } }));
        }

        _fillList() {
            const items = this._steps.map((step, i) => {
                const n = i + 1;
                const st = this._states[i] || {};
                const item = make('button', 'dbmn-steps-item' + (st.status === 'current' ? ' is-current' : ''));
                item.type = 'button';
                item.dataset.step = String(n);
                item.setAttribute('role', 'menuitem');
                const mark = make('span', 'dbmn-step-mark');
                setMark(mark, st.status === 'current' ? { key: String(n), text: String(n) } : markFor(st, n));
                item.append(mark, make('span', 'dbmn-steps-item-name', step.label));
                const open = CLICKABLE.includes(st.status);
                item.disabled = !open && st.status !== 'current';
                item.addEventListener('click', () => { if (open) this._go(n); else this._close(); });
                return item;
            });
            this._list.replaceChildren(...items);
        }

        _open() {
            this._list = make('div', 'dbmn-steps-list');
            this._list.setAttribute('role', 'menu');
            this._list.setAttribute('aria-label', this.getAttribute('label') || 'Steps');
            this._fillList();
            this.append(this._list);
            this._summaryBtn.setAttribute('aria-expanded', 'true');
            document.addEventListener('mousedown', this._onOutside, true);
            document.addEventListener('keydown', this._onKey, true);
            this._draw();
        }

        _close() {
            if (!this._list) return;
            this._list.remove();
            this._list = null;
            document.removeEventListener('mousedown', this._onOutside, true);
            document.removeEventListener('keydown', this._onKey, true);
            if (this._summaryBtn) {
                this._summaryBtn.setAttribute('aria-expanded', 'false');
                if (this._isFolded && this.isConnected) this._draw();
            }
        }
    }

    customElements.define('dbmn-footer', DbmnFooter);
    customElements.define('dbmn-actions', DbmnActions);
    customElements.define('dbmn-status', DbmnStatus);
    customElements.define('dbmn-progress', DbmnProgress);
    customElements.define('dbmn-steps', DbmnSteps);
})();

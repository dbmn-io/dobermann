// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-run-heading>: a run's one line at the top of its screen (design system; James, 2026-11-24, the Console and
 * Run Batch mock, #464): the environment as a link, the run's name renamed in place (<dbmn-name>, as on Query),
 * ⓘ for the run's details, and the run's tabs with their counts. It replaces the Console's heading band and its
 * Settings tab; Run Batch wears the same line, its tabs appearing as the run takes shape (Input, then Requests).
 *
 *   <dbmn-run-heading id="heading"></dbmn-run-heading>
 *   heading.environment = { name: 'DBMN Local' };          // the link's words; a click: dbmn-run-heading-environment
 *   heading.name = 'Inventory-Errors 20 Nov 20:14';        // the name; heading.unnamed = true for a default one
 *   heading.tabs = [{ id: 'input', label: 'Input', count: 1000 },
 *                   { id: 'requests', label: 'Requests', count: 5 },
 *                   { id: 'success', label: 'Completed', count: 4, tone: 'ok' },
 *                   { id: 'errors', label: 'Error', count: 1, tone: 'error' }];
 *   heading.active = 'requests';
 *   heading.marks = [node];          // the screen's own marks after ⓘ, as it made them (none by default)
 *   { id: 'input', label: 'Input', count: 1000, issues: 3 }   // issues: an amber count to fix; a click on it:
 *                                                            // dbmn-run-heading-issues { id } (the tab itself still switches)
 *   heading.setIssues('input', 2);
 *   heading.setCount('errors', 2);  heading.setHidden('errors', false);   // as the run goes; heading.has('errors')
 *
 *   dbmn-run-heading-tab   { id }   a tab was picked (the screen sets `active` when it has moved)
 *   dbmn-run-heading-info  {}       ⓘ (the screen opens the run's details)
 *   dbmn-run-heading-environment {} the environment's link
 *   dbmn-name-change       { name } bubbles up from the name, as <dbmn-name> sends it
 *
 * Colour only where it means something: a tab's count is tinted only with a `tone` ('ok' green, 'error' red); the
 * others are neutral, the tabs and the line plain (the state is on the Hub's tab and in the footer's box). A count
 * that changes pulses once. A tab's `count` left out shows no count; `hidden: true` keeps the tab unseen.
 * Draws in the page (no shadow root); no business logic. Needs dbmn-name.js and icons.js; styles in tabs.css.
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.customElements || customElements.get('dbmn-run-heading')) return;

    // (the count as it is: the Console's tabs, lessons and specs read "1200", not "1,200")
    const count = n => String(n);
    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    class DbmnRunHeading extends HTMLElement {
        constructor() {
            super();
            this._environment = null;
            this._name = '';
            this._unnamed = false;
            this._tabs = [];
            this._active = null;
            this._counts = new Map();   // (each tab's last count, to pulse one that changed)
            this._built = false;
        }
        set environment(e) { this._environment = e || null; this._drawEnvironment(); }
        get environment() { return this._environment; }
        set name(v) { this._name = v || ''; if (this._nameEl) this._nameEl.value = this._name; }
        get name() { return this._name; }
        set unnamed(v) { this._unnamed = !!v; if (this._nameEl) this._nameEl.unnamed = this._unnamed; }
        get unnamed() { return this._unnamed; }
        set tabs(list) { this._tabs = Array.isArray(list) ? list : []; this._drawTabs(); }
        get tabs() { return this._tabs; }
        /** The screen's own marks after ⓘ (the Console's "Runs in DBMN for VS Code"): nodes it made, put in as they are. */
        set marks(nodes) { this._marks = Array.isArray(nodes) ? nodes.filter(Boolean) : []; if (this._marksEl) this._marksEl.replaceChildren(...this._marks); }
        set active(id) { this._active = id; this._drawTabs(); }
        get active() { return this._active; }
        /** One tab's count, or whether it shows, changed as the run goes (the rest kept): the screen never edits the buttons. */
        setCount(id, n) { this._patch(id, { count: n }); }
        setHidden(id, hidden) { this._patch(id, { hidden: !!hidden }); }
        setIssues(id, n) { this._patch(id, { issues: Number(n) || 0 }); }
        has(id) { return this._tabs.some(t => t && t.id === id && !t.hidden); }
        _patch(id, change) {
            let changed = false;
            this._tabs = this._tabs.map(t => {
                if (!t || t.id !== id) return t;
                if (Object.keys(change).every(k => t[k] === change[k])) return t;
                changed = true;
                return { ...t, ...change };
            });
            if (changed) this._drawTabs();
        }

        connectedCallback() {
            if (this._built) return;
            this._built = true;
            this.setAttribute('role', 'banner');
            const title = make('div', 'dbmn-run-title');
            this._envEl = make('button', 'dbmn-run-env');
            this._envEl.type = 'button';
            this._envEl.addEventListener('click', () => this.dispatchEvent(new CustomEvent('dbmn-run-heading-environment', { bubbles: true })));
            const colon = make('span', 'dbmn-run-sep', ':');
            colon.setAttribute('aria-hidden', 'true');
            this._nameEl = document.createElement('dbmn-name');
            this._nameEl.setAttribute('label', 'Run name');
            this._nameEl.setAttribute('max', '80');
            this._nameEl.value = this._name;
            this._nameEl.unnamed = this._unnamed;
            const info = make('button', 'dbmn-run-info icon');
            info.type = 'button';
            info.dataset.icon = 'info';
            if (window.Icons) window.Icons.setIcon(info, 'info');
            info.title = 'This run: where it went, how it ran';
            info.setAttribute('aria-label', info.title);
            info.addEventListener('click', () => this.dispatchEvent(new CustomEvent('dbmn-run-heading-info', { bubbles: true })));
            this._marksEl = make('span', 'dbmn-run-marks');
            this._marksEl.replaceChildren(...(this._marks || []));
            title.append(this._envEl, colon, this._nameEl, info, this._marksEl);
            this._tabsEl = make('div', 'dbmn-run-tabs');
            this._tabsEl.setAttribute('role', 'tablist');
            this.append(title, this._tabsEl);
            this._drawEnvironment();
            this._drawTabs();
        }

        _drawEnvironment() {
            if (!this._envEl) return;
            const e = this._environment;
            this._envEl.hidden = !e;
            this._envEl.textContent = e ? e.name : '';
            this._envEl.title = e ? `Open the environment ${e.name}` : '';
            const sep = this.querySelector('.dbmn-run-sep');
            if (sep) sep.hidden = !e;
        }

        _drawTabs() {
            if (!this._tabsEl) return;
            const tabs = this._tabs.filter(Boolean);
            // (the same tabs as drawn: each kept and brought up to date, so a click never lands on a button being
            //  replaced while the counts go live; other tabs: drawn again. A hidden tab is kept, unseen, with its count)
            const have = [...this._tabsEl.children];
            if (have.length !== tabs.length || have.some((b, i) => b.dataset.tab !== tabs[i].id)) {
                this._tabsEl.replaceChildren(...tabs.map(t => this._tabButton(t)));
            }
            [...this._tabsEl.children].forEach((b, i) => this._fillTab(b, tabs[i]));
        }
        _tabButton(t) {
            const b = make('button', 'tab-item dbmn-run-tab');
            b.type = 'button';
            b.dataset.tab = t.id;
            b.setAttribute('role', 'tab');
            b.append(make('span', 'dbmn-run-tab-label'));
            b.addEventListener('click', event => {
                if (event.target.closest('.dbmn-run-issues')) return;
                this.dispatchEvent(new CustomEvent('dbmn-run-heading-tab', { bubbles: true, detail: { id: t.id } }));
            });
            return b;
        }
        _fillTab(b, t) {
            const on = t.id === this._active;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', String(on));
            b.hidden = !!t.hidden;
            b.querySelector('.dbmn-run-tab-label').textContent = t.label;
            let badge = b.querySelector('.dbmn-run-count');
            if (t.count === undefined || t.count === null) { if (badge) badge.remove(); }
            else {
                if (!badge) {
                    badge = make('span', 'tab-count dbmn-run-count');
                    badge.dataset.tab = t.id;   // (as every tab strip's count: .tab-count[data-tab])
                    b.querySelector('.dbmn-run-tab-label').after(badge);
                }
                badge.className = 'tab-count dbmn-run-count' + (t.tone ? ` is-${t.tone}` : '');
                const text = count(t.count);
                if (badge.textContent !== text) badge.textContent = text;
                const was = this._counts.get(t.id);
                if (was !== undefined && was !== t.count) {
                    badge.classList.add('is-changed');
                    setTimeout(() => badge.classList.remove('is-changed'), 400);
                }
                this._counts.set(t.id, t.count);
            }
            // (issues: an amber count of what needs fixing, the Input tab's invalid rows; a click on it says so)
            let issues = b.querySelector('.dbmn-run-issues');
            if (!(t.issues > 0)) { if (issues) issues.remove(); }
            else {
                if (!issues) {
                    issues = make('span', 'dbmn-run-issues');
                    issues.setAttribute('role', 'button');
                    issues.tabIndex = 0;
                    const ask = event => { event.stopPropagation(); this.dispatchEvent(new CustomEvent('dbmn-run-heading-issues', { bubbles: true, detail: { id: t.id } })); };
                    issues.addEventListener('click', ask);
                    issues.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ask(event); } });
                    b.append(issues);
                }
                issues.textContent = count(t.issues);
                issues.title = t.issuesTitle || `${count(t.issues)} to fix: show them`;
                issues.setAttribute('aria-label', issues.title);
            }
        }
    }
    customElements.define('dbmn-run-heading', DbmnRunHeading);
})();
